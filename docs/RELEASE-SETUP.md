# Setting up `just release`

One-time setup so that shipping a change is one command:

```bash
just release
```

which gates locally, pushes to `main`, watches the GitHub Actions run through the
deploy, and confirms the live site answers. If anything fails, the box rolls
itself back to the previous revision.

Migrating the app onto the VPS in the first place is a different document:
[VPS-DEPLOY.md](./VPS-DEPLOY.md). Do that first — this assumes the service is
already running there.

---

## What happens when you run it

```
just release
   │
   ├─ on main?  tree clean?  not behind origin?  anything to push?
   │
   ├─ typecheck · web:typecheck · test · web:build        ← locally, ~10 s
   │     fails here → nothing was pushed
   │
   ├─ git push origin main
   │
   ├─ GitHub Actions: check job (same gate, clean machine)
   │     │
   │     └─ deploy job → ssh → deploy/deploy.sh on the VPS
   │            fetch · install · typecheck · test · web:build
   │            systemctl restart · health-check /api/auth
   │            unhealthy → roll back to the previous revision
   │
   └─ curl https://<host>/api/auth        ← proves it from outside, through TLS
```

The gate runs three times on purpose: locally for speed, in CI on a clean
machine (catching "works on my laptop"), and on the VPS because its
`node_modules` and platform are different from both.

---

## 1. Your machine

```bash
brew install just gh          # macOS
gh auth login                 # needs `repo` and `workflow` scope
corepack enable               # pnpm, at the version package.json pins
```

Check `gh` can see the repo — you need **write**:

```bash
gh repo view SergeyDertan/ad_scout --json viewerPermission
# {"viewerPermission":"WRITE"}
```

The justfile assumes the host, user and install directory. Override per-shell if
they differ:

```bash
export ADSCOUT_HOST=adscout.dva-lymona.biz.ua
export ADSCOUT_USER=adscout
export ADSCOUT_DIR=/opt/adscout
```

## 2. A deploy key for CI

Generate a keypair **used only by CI**, with no passphrase (Actions cannot type
one). Do not reuse your personal SSH key: this one ends up in a GitHub secret,
and you want to be able to revoke it on its own.

```bash
ssh-keygen -t ed25519 -f ~/.ssh/adscout-deploy -N "" -C "github-actions-adscout"
```

Authorise the public half for the service user on the VPS:

```bash
ssh-copy-id -i ~/.ssh/adscout-deploy.pub adscout@adscout.dva-lymona.biz.ua
# or: cat ~/.ssh/adscout-deploy.pub | ssh adscout@host 'cat >> ~/.ssh/authorized_keys'
```

Confirm it works before involving CI — if this fails, CI will too, with a worse
error message:

```bash
ssh -i ~/.ssh/adscout-deploy -o IdentitiesOnly=yes adscout@adscout.dva-lymona.biz.ua 'whoami'
```

## 3. The VPS side

**Let the service user restart the service.** Two commands, not blanket sudo:

```bash
sudo tee /etc/sudoers.d/adscout >/dev/null <<'EOF'
adscout ALL=(root) NOPASSWD: /bin/systemctl restart adscout, /bin/systemctl is-active adscout
EOF
sudo visudo -c        # verify before you trust it
```

`just restart` and `just deploy-ssh` both depend on this rule, not only CI.

> Check the path — it is `/usr/bin/systemctl` on some distributions. `command -v
> systemctl` on the box, and match it exactly; sudoers matches the literal path.

**Make sure the script is executable** (git preserves the bit, but if the repo
was copied rather than cloned):

```bash
chmod +x /opt/adscout/deploy/deploy.sh
```

**And that `tar` exists** — the hourly backup shells out to it:

```bash
tar --version >/dev/null && echo ok
```

## 4. GitHub secrets

`Settings → Secrets and variables → Actions → New repository secret`:

| Secret | Value |
|---|---|
| `DEPLOY_HOST` | `adscout.dva-lymona.biz.ua` |
| `DEPLOY_USER` | `adscout` |
| `DEPLOY_SSH_KEY` | contents of `~/.ssh/adscout-deploy` (the **private** half, including the BEGIN/END lines) |
| `DEPLOY_KNOWN_HOSTS` | output of `ssh-keyscan -H adscout.dva-lymona.biz.ua` |

From the CLI, if you prefer:

```bash
gh secret set DEPLOY_HOST        --body "adscout.dva-lymona.biz.ua"
gh secret set DEPLOY_USER        --body "adscout"
gh secret set DEPLOY_SSH_KEY     < ~/.ssh/adscout-deploy
ssh-keyscan -H adscout.dva-lymona.biz.ua | gh secret set DEPLOY_KNOWN_HOSTS
```

**Why `DEPLOY_KNOWN_HOSTS` is pinned rather than scanned in the job:** running
`ssh-keyscan` inside the workflow would accept whatever host key answered that
day, which is not verification — it just silences the warning. Pinning it means a
changed key fails the deploy loudly, which is what you want.

Re-run `ssh-keyscan` and update the secret if you ever rebuild the box.

## 5. First release

```bash
just check      # green locally first
just release
```

The first run also creates the workflow on GitHub, so it may take a few extra
seconds to appear — `release` polls for up to two minutes before giving up, and
says plainly that the push succeeded even if the watch did not start.

---

## Day to day

| | |
|---|---|
| `just release` | ship what is on `main` |
| `just restart` | restart only — the right tool after editing `.env` on the box |
| `just redeploy` | rebuild and restart the same revision, through CI |
| `just deploy-ssh` | deploy straight over SSH, bypassing CI (Actions down) |
| `just ci` | watch the latest run |
| `just status` | is it up, are the ports bound to loopback, is the API gated |
| `just boot-log` | the lines that prove timezone / auth / hub / backups are right |
| `just logs` | follow the live log |
| `just backups` | what archives exist on the box |
| `just fetch-backup` | copy the newest archive here for a restore drill |

`just check`, `just build`, `just dev`, `just dump` are the local ones.

### After changing `.env` on the box

`.env` is read at boot, so a config change needs a restart — but there is no new
commit to release. Two tools, and the lighter one is usually right:

```bash
just restart      # restart the service, wait for it to answer.  ~5 s
just redeploy     # full cycle through CI: install, gate, build, restart.  ~2 min
```

`just restart` is what you want for an `.env` edit — nothing was rebuilt, so
there is nothing to rebuild. Reach for `redeploy` when you also want the box
re-verified from scratch, or when you are not sure what state it is in.

> A plain `git pull && systemctl restart` on the box is the thing to avoid:
> `web/dist` is gitignored and served from disk, so you would restart onto the
> previous front-end build. `deploy.sh` exists to make that impossible.
>
> Note that `deploy.sh` deliberately does **nothing** when the revision has not
> changed — `redeploy` sets `FORCE=1` to override that, which is the only reason
> it restarts at all.

---

## When it goes wrong

| Symptom | Cause | Fix |
|---|---|---|
| `release runs from main` | you are on a branch | merge or switch to `main` |
| `working tree is dirty` | uncommitted changes | commit or stash |
| `behind origin/main by N` | someone else pushed | `git pull --rebase` |
| `nothing to push` | already released | `just restart` for an `.env` change, `just redeploy` to rebuild |
| `already at <sha> — nothing to deploy` | no revision change | expected; use `just restart` or `just redeploy` |
| `no workflow run appeared` | `.github/workflows/` not on the remote yet, or Actions disabled | the push succeeded — check the Actions tab |
| deploy job: `DEPLOY_SSH_KEY is not set` | secret missing | §4 |
| deploy job: host key verification failed | `DEPLOY_KNOWN_HOSTS` stale | re-scan and update the secret |
| deploy job: `sudo: no tty present` | sudoers rule missing or path wrong | §3 — match `command -v systemctl` exactly |
| `working tree is dirty` **on the VPS** | someone edited files in place | `ssh` in, commit or `git checkout --` them |
| `ROLLING BACK` | the new revision never answered | `just logs` — the previous revision is running |
| `needs hands` | even the rollback would not start | the service is **down**; read the log, fix, `just deploy-ssh` |
| live-site curl fails but CI passed | nginx or TLS, not the app | the app answered on loopback; check Hestia's proxy template |

### Rolling back deliberately

```bash
git revert <bad-commit> && just release      # forward, preferred — keeps history honest
```

or pin the box to a known-good revision without touching `main`:

```bash
ssh adscout@host '/opt/adscout/deploy/deploy.sh <good-sha-or-tag>'
```

The second leaves the box on a revision `main` does not point at; the next
`just release` moves it forward again.

---

## Deliberate choices

**Push to `main` deploys to production.** The CI gate and the automatic rollback
are why that is reasonable, not a claim that it is risk-free — this machine sends
real email from real mailboxes. To approve each one instead, delete the `push:`
trigger from `.github/workflows/deploy.yml` and keep `workflow_dispatch`;
`just redeploy` then becomes the way you ship.

**Raw `ssh` in the workflow, not a marketplace action.** Deploying is the step
with the most authority in this pipeline, and it is six lines of `ssh`. A
third-party action there is supply-chain surface for no benefit.

**The deploy script lives in the repo, not in the workflow.** So `just
deploy-ssh` and CI run the identical procedure, and the box can be deployed by
hand when GitHub is unavailable.
