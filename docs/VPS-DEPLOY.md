# Migrating AdScout to the VPS

Complete, start to finish: stand the agent up on the VPS, move the live database
onto it, and cut over — without losing a reply, a price, or a warmed mailbox.

The design reasoning behind these choices is in
[REMOTE-ADMIN-PLAN.md](./REMOTE-ADMIN-PLAN.md). This document is the procedure.

> **Terminology.** **Source machine** = whichever machine runs AdScout today and
> holds `data/pouch`, `.env` and `client_secret.json`. **VPS** = the new host,
> `adscout.dva-lymona.biz.ua`, running HestiaCP. **Worker machine** = the desktop
> logged in to the `claude` CLI. Source and worker are usually the same Mac.
>
> **Two users on the VPS, and they are not the same account:**
>
> | | | |
> |---|---|---|
> | **`dvalymona`** | the **Hestia** user | owns the web domain, its nginx config and its Let's Encrypt certificate. It already owns the other domains on this box, so the domain is added under it (§7). |
> | **`adscout`** | the **service** user | login-less system account that owns `/opt/adscout` and runs the Node process (§2, §6). |
>
> Keeping them apart is deliberate. The CI deploy key lives in the service
> user's `authorized_keys`, and the hourly backups hold every mailbox's OAuth
> refresh token in the clear — neither belongs to the account that owns every
> other site on the box. Hestia also manages its own users' home directories
> (quotas, `v-rebuild-user` regenerating configs), and `/opt/adscout` sits
> outside all of that.

---

## What you end up with

```
BEFORE                              AFTER
──────                              ─────
Mac                                 VPS  (adscout.dva-lymona.biz.ua)
  database                            database
  sends + polls Gmail                 sends + polls Gmail
  dashboard on localhost:8787         dashboard behind Hestia nginx + TLS
  extraction: local `claude` CLI      extraction hub on :8788
  ngrok, when a worker was involved
                                    Mac
                                      `pnpm remote:worker` only
                                      holds the Claude subscription
                                      dials OUT — listens on nothing
```

Two things follow from that shape:

- **ngrok disappears.** It existed because the hub was on a NAT'd laptop. The VPS
  is reachable already, and the worker only ever makes outbound calls.
- **The Mac stops being a server.** It keeps the Claude subscription and nothing
  else. See [§11](#11-cutover) — leaving its scheduler running is the one mistake
  that duplicates outreach.

---

## Prerequisites

| | |
|---|---|
| VPS with HestiaCP, root/sudo | ✅ you have this |
| DNS `adscout.dva-lymona.biz.ua` → VPS IP | do this first; Let's Encrypt needs it. **Behind Cloudflare? see [§7b](#7b-if-the-domain-is-behind-cloudflare)** |
| `client_secret.json` (or `GOOGLE_CLIENT_ID`/`SECRET`) from the source machine | **see §1 — this is the one true blocker** |
| Firebase project for sign-in (`postwormhole`) | already exists |
| Node 26 + pnpm 11 on the VPS | §2 |

---

## 1. Inventory the source machine

Do this before touching the VPS. Everything here has to arrive on the new host,
and three of these are **not in git**.

```bash
cd <adscout checkout on the source machine>

ls -la .env client_secret.json          # both required to send mail
du -sh data/pouch                       # the database
ls firebase-service-account.json 2>/dev/null   # only if you publish viewer snapshots
grep -E '^(LLM_PROVIDER|EMAIL_PROVIDER|STORE|CLAUDE_CODE_MODEL)=' .env
```

**`client_secret.json` is the item to verify first.** All Gmail accounts here are
`gmail-api` over OAuth, and their refresh tokens live *inside the database*, so
they travel with the data — but a refresh token is bound to the **OAuth client
that issued it**:

| | Result |
|---|---|
| You move the **same** `client_secret.json` | every mailbox keeps working, nothing to re-authorize |
| You create a **new** OAuth client | every refresh token is dead, every mailbox must re-consent |

If the file is missing, download it again from Google Cloud Console → APIs &
Services → Credentials, choosing the **existing** client — not a new one.
(`GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` in `.env` work identically; see
`loadGoogleOAuth()` in `src/config.ts`.)

**Also check `EMAIL_PROVIDER` is set.** Unset or `dummy` means the app runs
happily and sends nothing. See §5 — it is a two-state flag, not a transport name.

---

## 2. Prepare the VPS

Hestia already manages nginx, TLS and the firewall. **Do not install Caddy or
hand-edit `/etc/nginx`** — Hestia owns ports 80/443 and will overwrite you.

```bash
# Node 26 (see .nvmrc). corepack reads package.json's "packageManager" field,
# so it installs the exact pnpm this repo pins — do not name a version here and
# risk it drifting from the lockfile.
corepack enable
node -v && pnpm -v

# The SERVICE user — not the Hestia user. dvalymona owns the domain (§7);
# this account owns /opt/adscout and runs the Node process.
#
# --shell IS REQUIRED. `adduser --system` defaults to /usr/sbin/nologin, and the
# CI deploy job SSHes in as this very user to run deploy/deploy.sh (§3b). With
# nologin the deploy fails at the ssh, not at anything it would name — set the
# shell now rather than debugging it later. It still has no password, so the
# only way in is the deploy key you put in its authorized_keys.
sudo adduser --system --group --home /opt/adscout --shell /bin/bash adscout
```

### The box needs to be able to clone a private repo

`git clone` in §3 is against a private repository, so give the box its own
**read-only deploy key** — separate from the CI key, which travels the other way.

```bash
sudo -u adscout -H ssh-keygen -t ed25519 -f /opt/adscout/.ssh/id_ed25519 -N "" -C "adscout-vps-readonly"
sudo -u adscout -H cat /opt/adscout/.ssh/id_ed25519.pub
```

Add that public key at **GitHub → the repo → Settings → Deploy keys**, leaving
"Allow write access" unchecked.

**You do not need to change the host's clock zone.** The app pins its own —
`TZ` in `.env` is authoritative and validated at boot (`src/lib/timezone.ts`),
so the send window is correct whatever the box is set to. On a shared box,
leave it alone: `timedatectl` would move the zone for dvalymona's other sites
and their logs too. The only cost is that `journalctl` timestamps will not match
the app's own, and the boot line names the zone it is actually using.

> ### ⚠️ Two locks on ports 8787 and 8788
>
> **1. `BIND_HOST=127.0.0.1`** — set in the systemd unit (§6) and `.env` (§5).
> Both servers then bind loopback only, so nothing outside the box can reach
> them at all. nginx proxies over loopback, and the SSH tunnel to the hub
> terminates there too, so nothing legitimate loses access.
>
> **2. The firewall.** In Hestia → **Firewall**, ensure there is no ALLOW rule
> for 8787 or 8788. Only 80/443 and SSH should be open.
>
> Either one is sufficient; both together mean a mistake in one is not an
> exposure. Without `BIND_HOST` the app binds *every* interface (Node's default),
> and the firewall becomes the only thing standing between the extraction hub and
> the internet.
>
> Check from your laptop after §6 — both must hang or refuse:
> ```bash
> curl --max-time 5 http://<origin-ip>:8787/api/auth
> curl --max-time 5 http://<origin-ip>:8788/
> ```
> Use the **origin IP**, not a CDN-proxied hostname: the proxy does not carry
> those ports, so it fails the same way whether or not they are exposed
> ([§7b](#7b-if-the-domain-is-behind-cloudflare)).

---

## 3. Deploy the code

```bash
sudo mkdir -p /opt/adscout && sudo chown adscout:adscout /opt/adscout
sudo -u adscout -H git clone <your repo> /opt/adscout

sudo -u adscout -H bash -c '
  cd /opt/adscout
  pnpm install
  pnpm web:build          # web/dist is gitignored — the server serves it from disk
  mkdir -p data logs backups   # ALL THREE — the unit's ReadWritePaths bind-mounts
                               # each one and refuses to start if any is missing
'
```

*(`git clone` into an existing directory works only if it is empty. If `adduser`
left skeleton files there, clone to `/tmp/adscout` and move the contents in.)*

---

## 3b. Automated deploys

Set this up **now**, before any data moves. Every later step — secrets, systemd,
nginx, the OAuth registration — is a code deploy away from being re-testable, and
you want that loop working while the store is still empty and mistakes are free.

`deploy/deploy.sh` runs on the box and does the whole cycle:

```bash
ssh adscout@<vps> '/opt/adscout/deploy/deploy.sh'
```

*(`<vps>` is the SSH address — the origin IP if the public hostname is proxied;
see [§7b](#7b-if-the-domain-is-behind-cloudflare).)*

fetch → `pnpm install --frozen-lockfile` → typecheck → **test** → `web:build` →
restart → health-check → **roll back if it does not answer**.

Three things it does that `git pull && systemctl restart` does not, each for a
reason specific to this app:

- **Builds before restarting.** `web/dist` is gitignored and served from disk, so
  a restart without a build serves the previous build — or nothing at all.
- **Gates on the suite.** A bad revision here does not break a website, it stops
  outreach and reply polling.
- **Rolls back on a failed health check.** It polls `/api/auth`, the one endpoint
  that answers without a token, and puts the previous revision back if the new
  one never responds. A deploy that leaves the mailer down is worse than no
  deploy.

It refuses to run on a dirty working tree — on a server that is usually a hotfix
somebody made in place and has not pushed.

It needs exactly two privileged actions, so grant those rather than blanket sudo:

```
# /etc/sudoers.d/adscout
adscout ALL=(root) NOPASSWD: /bin/systemctl restart adscout, \
                             /bin/systemctl is-active adscout
```

### Push-to-deploy

`.github/workflows/deploy.yml` runs the same gate in CI on every push and PR, and
on `main` it SSHes in and runs the script. Four repository secrets:

| Secret | Value |
|---|---|
| `DEPLOY_HOST` | the **SSH** address — the origin IP, or an unproxied record ([§7b](#7b-if-the-domain-is-behind-cloudflare)) |
| `DEPLOY_USER` | the service user owning `/opt/adscout` |
| `DEPLOY_SSH_KEY` | private key; public half in that user's `authorized_keys` |
| `DEPLOY_KNOWN_HOSTS` | output of `ssh-keyscan -H <host>` |

The host key is pinned as a secret on purpose: running `ssh-keyscan` inside the
job would trust whatever answers on the day, which is no verification at all.

`workflow_dispatch` is enabled too, for redeploying an unchanged revision — after
editing `.env` on the box, say.

> **This deploys real code to a machine that sends real email.** The CI gate and
> the auto-rollback are why that is reasonable, not an argument that it is
> risk-free. If you would rather approve each one, delete the `push:` trigger and
> keep `workflow_dispatch`.

---

## 4. Move the data

> ### Stand it up empty first
>
> Do **§5 through §10 with an empty store**, before coming back here. You get
> TLS, sign-in, the roles, the hub and the deploy loop all proven while the only
> thing at risk is nothing. Then the data migration is the single remaining
> variable rather than one of eight.
>
> Concretely: `.env` (§5) → systemd (§6) → nginx (§7) → Google/Firebase (§8) →
> verify (§10). Sign in, see an empty dashboard, deploy a trivial commit and
> watch it roll. **Then** return to this section.

**Do not copy `data/pouch` directly.** Two reasons, one of which is silent:
copying a live LevelDB captures its write-ahead log mid-write, and arm64 → x86-64
carries no formal compatibility guarantee. The dump/load pair is format-agnostic
and, more importantly, **verifiable**.

### 4a. Dump, on the source machine

Stop the server first — the store is single-process and the dump will otherwise
fail on the LevelDB lock:

```bash
# stop `pnpm serve` / the hub, then:
cd <adscout checkout>
pnpm data:dump --out ./data-dump
```

It prints a count per type and writes NDJSON files plus `manifest.json`.

### 4b. Transfer

```bash
scp -r ./data-dump adscout@<vps>:/opt/adscout/
```

### 4c. Load and verify, on the VPS

```bash
cd /opt/adscout
STORE=pouchdb pnpm data:load --in ./data-dump
```

`data:load` re-reads every type back through the Store port and prints
dumped / loaded / in-store side by side. It **exits non-zero on any mismatch**.

> **Do not continue until it prints `every type matches the manifest`.**

Two differences are expected and correct:

- **A legacy `campaign:` document does not travel.** The Store port has no
  campaign methods any more — the type is dead code and nothing reads it.
- **A malformed legacy suppression key may be rewritten**, e.g.
  `info@site.itv15` → `info@site.itv`. `addSuppression` normalizes the address on
  the way in. That is a repair, not a loss.

*(Rehearsed against the real 107 MB store: 7,878 documents round-tripped, every
type matching, every document byte-identical apart from that one key.)*

---

## 5. Secrets and `.env`

Copy by hand — none of these are in git:

```bash
scp .env               adscout@<vps>:/opt/adscout/
scp client_secret.json adscout@<vps>:/opt/adscout/
# only if you publish viewer snapshots:
scp firebase-service-account.json adscout@<vps>:/opt/adscout/
```

**Do not copy `data/agent.lock`.** It is PID-based with a liveness check
(`lib/lock.ts`); a stale Mac PID colliding with a live Linux PID produces
`agent already running (pid N)` with nothing actually running.

Then write `/opt/adscout/.env`. There is a filled-in template in the repo —
copy it rather than retyping this block:

```bash
sudo -u adscout -H cp /opt/adscout/deploy/env.vps.example /opt/adscout/.env
sudo -u adscout -H nano /opt/adscout/.env      # two PLACEHOLDERs to fill
sudo chmod 600 /opt/adscout/.env
```

What it sets, and why:

```ini
STORE=pouchdb
EMAIL_PROVIDER=smtp-imap        # see the note below — do NOT leave unset
LLM_PROVIDER=claude-code        # the hub hands this work to the Mac's worker
TZ=Europe/Kyiv

# --- extraction hub (the Mac's worker connects here) ---
REMOTE_TOKEN=<long random secret>     # openssl rand -base64 32
REMOTE_PORT=8788
REMOTE_HUB=on
REMOTE_MAX_FAILED=10

# --- who may use the API ---
ADMIN_EMAILS=you@gmail.com
MANAGER_EMAILS=                       # optional, see below
FIREBASE_PROJECT_ID=postwormhole
```

### `EMAIL_PROVIDER` does not name the transport

It is a two-state flag: unset or `dummy` means nothing is really sent; anything
else means real mail. Which transport an account uses is decided **per account**
by its `providerType`, by `RoutingEmailProvider` — and that router is only wired
up when the Google OAuth client is present (`buildAgent()` in `src/lib/factory.ts`).

So `gmail-api` accounts need **both** a non-dummy `EMAIL_PROVIDER` **and**
`client_secret.json`. Miss the first and the app runs, sending nothing. Miss the
second and it falls back to SMTP for accounts that have no SMTP password, and
every send fails.

### Who gets in, and what they can do

Setting **either** list turns authentication on. Both empty means **no
authentication at all** — right on a laptop's loopback, catastrophic here.

| | `ADMIN_EMAILS` | `MANAGER_EMAILS` |
|---|---|---|
| Read everything (targets, replies, domains, prices, threads) | ✅ | ✅ |
| Deals: open, answer, placements, status | ✅ | ✅ |
| Import targets / batches | ✅ | ❌ |
| Connect, pause, delete a mailbox | ✅ | ❌ |
| Start a send / poll / fetch pass | ✅ | ❌ |
| Edit or delete replies, ignore list, exclusions | ✅ | ❌ |

An address on both lists is an admin. The rule is `mayAccess()` in
`src/server/auth.ts`, and it is **default-deny for managers**. The console hides
what a manager cannot use, but that is cosmetic — the server is the boundary.

### Timezone

The send window (`scheduler/window.ts`) and the daily quota reset
(`domain/limits.ts`) use `getHours()` / `setHours()` — **local clock, no timezone
argument anywhere**. The host OS would otherwise decide when this app sends mail.

**The app pins it rather than inheriting it.** `TZ` in `.env` is authoritative,
whatever the box's own clock zone is, and it is validated at boot: an unknown
name or a value that did not take effect is a fatal error, and an *unset* TZ logs
a warning rather than quietly using the host's zone. The boot line states the
window in the terms it is actually evaluated in:

```
clock 15:52 Europe/Kiev (requested Europe/Kyiv) — send window 09:00-18:00 local
```

Read that line on the first boot. `Europe/Kiev` is not a mistake — Node's ICU
reports `Europe/Kyiv` under its older alias, which is why the check compares
offsets rather than names.

One trap it now catches: `TZ=` left **blank** in `.env`. Node takes the empty
string literally and resolves to `Etc/Unknown`, which is UTC in disguise — that
would have shifted the whole send window silently. Either give TZ a real zone or
remove the line.

---

## 6. Run it under systemd

```bash
sudo cp /opt/adscout/deploy/adscout.service /etc/systemd/system/
sudoedit /etc/systemd/system/adscout.service     # check User and WorkingDirectory
sudo systemctl daemon-reload
sudo systemctl enable --now adscout
journalctl -u adscout -f
```

A healthy boot logs, in order:

```
file logging enabled
API authentication ENABLED — a verified Google account on an allowlist is required { admins: 1, managers: 0 }
reconcile { ... }
AdScout server on http://localhost:8787 { bind: '127.0.0.1', ... }
remote extraction hub on :8788 — run `pnpm remote:worker` ... { bind: '127.0.0.1' }
```

Check the two `bind` values say `127.0.0.1` and not `all interfaces`.

If you see `API authentication is OFF`, stop — `ADMIN_EMAILS` did not load.
If you see `REMOTE extraction hub NOT started`, `REMOTE_TOKEN` is unset and
replies will be fetched but never extracted.

---

## 7. nginx and TLS, through Hestia

Add `adscout.dva-lymona.biz.ua` as a web domain in Hestia **under the
`dvalymona` user** — the one that already owns the other domains here — and
enable Let's Encrypt for it. Then install the proxy templates:

```bash
sudo cp /opt/adscout/deploy/hestia/adscout.tpl \
        /opt/adscout/deploy/hestia/adscout.stpl \
        /usr/local/hestia/data/templates/web/nginx/
sudo chmod 644 /usr/local/hestia/data/templates/web/nginx/adscout.*
```

In the panel, edit the domain and set its **Proxy Template** to `adscout`, then:

```bash
sudo v-rebuild-web-domain dvalymona adscout.dva-lymona.biz.ua
```

*(`v-rebuild-user dvalymona` rebuilds every domain for that user, if you
prefer the bigger hammer.)*

These differ from Hestia's stock proxy template in three ways, all deliberate:

- **No static-file shortcut.** Stock serves `js`/`css` from the domain docroot
  first. AdScout's assets are served by the Node process out of `web/dist`, so
  that shortcut would 404 the whole dashboard.
- **`proxy_buffering off`.** `/api/stream` is Server-Sent Events. Buffered, nginx
  holds the frames and the UI silently stops updating.
- **`client_max_body_size`.** A deal reply can carry an attachment; nginx's 1 MB
  default would 413 it.

> Only install `adscout-hub.tpl` / `.stpl` if you choose the **public hub**
> option in §9. The SSH-tunnel option needs no second domain and no second
> template.

---

## 7b. If the domain is behind Cloudflare

The rest of this document assumes DNS points straight at the box. With
Cloudflare's proxy on (the orange cloud) four things change. None is hard; two
fail in ways that look like something else entirely.

**1. SSH does not go through it.** The proxy carries ports 80 and 443 and
nothing else, so `ssh adscout.dva-lymona.biz.ua` times out while the site stays
up — indistinguishable from a dead box if you do not know to expect it. SSH to
the **origin IP**, or add an unproxied (grey cloud) record like
`ssh.dva-lymona.biz.ua`. That address, not the public hostname, is what
`ADSCOUT_SSH_HOST` and the `DEPLOY_HOST` secret must hold — see
[RELEASE-SETUP.md](./RELEASE-SETUP.md).

**2. Set SSL/TLS mode to Full (strict).** This is the one that actually bites.
On **Flexible**, Cloudflare speaks plain HTTP to the origin while Hestia
redirects HTTP→HTTPS, and the browser spins in a redirect loop. Full (strict)
after Hestia has issued the certificate; Full while you are still getting there.

**3. Let's Encrypt still works.** Cloudflare forwards
`/.well-known/acme-challenge/` to the origin, so Hestia issues normally — this
is *not* a reason to disable the proxy. If issuance does fail, grey-cloud the
record, issue, and turn the proxy back on. Visitors see Cloudflare's edge
certificate; yours secures the Cloudflare→origin hop, which is exactly what
Full (strict) verifies.

**4. Request bodies are capped at 100 MB on the free plan.** Below the hub
template's `client_max_body_size 128m`. This only matters for the **public hub**
(§9 option B) — the SSH tunnel in option A goes to the origin over port 22 and
never touches the edge. One more reason option A is the recommended one.

And one thing to watch rather than configure: `/api/stream` is SSE, and
Cloudflare normally passes it through. If the Live indicator sits on
*Reconnecting* after you have confirmed `proxy_buffering off` in the active
nginx config, the edge is the next suspect — test with the proxy briefly off
before rearranging nginx.


---

## 8. Google and Firebase console

Two one-time registrations. Both fail late and confusingly if skipped.

**1. OAuth redirect URI.** `oauthRedirectUri()` builds the callback from the
`Host` header and honours `X-Forwarded-Proto` — which the template sets — so it
emits exactly:

```
https://adscout.dva-lymona.biz.ua/api/oauth/callback
```

Add that to the OAuth client in Google Cloud Console → Credentials → your client
→ **Authorized redirect URIs**. Without it, connecting a mailbox fails at the
final step with `redirect_uri_mismatch`.

**2. Firebase authorized domain.** Firebase Console → Authentication → Settings →
**Authorized domains** → add `adscout.dva-lymona.biz.ua`. Without it, Google
sign-in is refused on the page and the console never loads past the gate.

**3. App Check, if you enforce it.** The front end registers a reCAPTCHA
Enterprise provider at startup (`web/src/viewer/firebase.ts`). Two console-side
pieces have to agree with it, and neither is optional once enforcement is on:

- Firebase Console → **App Check** → the web app → reCAPTCHA Enterprise, with
  the same site key the code holds.
- Google Cloud Console → Security → **reCAPTCHA Enterprise** → that key → add
  `adscout.dva-lymona.biz.ua` to its allowed domains. A key that does not list
  the domain silently fails attestation from it.

Enforcement is **per product and off by default**, so nothing breaks the day you
add this — turn it on for Authentication once you have watched real sign-ins
issue App Check tokens in the console's metrics.

**App Check does not protect `/api`.** It covers the Firebase surfaces —
Authentication, and Storage/Firestore while the viewer still uses them. This
project's own routes are gated by the ID-token allowlist in
`src/server/auth.ts`. Extending App Check to them would mean sending the token
as a header and verifying it with the Admin SDK, which is a separate decision.

---

## 9. The worker, on the Mac

The half that keeps the Claude subscription. Pick one of two ways to reach the
hub.

### Option A — SSH tunnel (recommended)

No second hostname, no certificate, no public hub endpoint, and `REMOTE_TOKEN`
never crosses the public internet.

```bash
# terminal 1 — keep the tunnel up (use autossh/launchd for unattended runs)
ssh -N -L 8788:127.0.0.1:8788 <user>@adscout.dva-lymona.biz.ua

# terminal 2
REMOTE_HUB_URL=http://127.0.0.1:8788 \
REMOTE_TOKEN=<the same secret as .env> \
CLAUDE_CODE_MODEL=claude-sonnet-5 \
pnpm remote:worker
```

For unattended use, `brew install autossh` and run
`autossh -M 0 -N -L 8788:127.0.0.1:8788 <user>@adscout.dva-lymona.biz.ua`.

### Option B — public hub hostname

Point `hub.adscout.dva-lymona.biz.ua` at the VPS, add it in Hestia with Let's
Encrypt, install `adscout-hub.tpl`/`.stpl`, set its Proxy Template to
`adscout-hub`, rebuild, then:

```bash
REMOTE_HUB_URL=https://hub.adscout.dva-lymona.biz.ua \
REMOTE_TOKEN=<the same secret> \
CLAUDE_CODE_MODEL=claude-sonnet-5 \
pnpm remote:worker
```

The hub templates set `client_max_body_size 128m` and 30-minute proxy timeouts —
the hub accepts result bodies up to 96 MB (attachments ride inline as base64),
`/work/claim` is a 20-second long-poll, and a lease lasts 20 minutes. nginx's
defaults would break all three.

Either way, the worker's own output tells you it connected, and the VPS logs
`remote claim` / `remote extracted` lines.

---

## 10. Verify

```bash
systemctl status adscout
journalctl -u adscout -n 50 --no-pager

# Public by design, so the sign-in page can load:
curl https://adscout.dva-lymona.biz.ua/api/auth        # {"required":true}

# Gated — 401 is the PASS here, 200 means auth is off:
curl -s -o /dev/null -w '%{http_code}\n' \
     https://adscout.dva-lymona.biz.ua/api/status       # 401

# The dashboard itself loads (sign-in screen):
curl -s -o /dev/null -w '%{http_code}\n' \
     https://adscout.dva-lymona.biz.ua/                 # 200

# Ports are NOT directly exposed — both should fail:
curl --max-time 5 http://adscout.dva-lymona.biz.ua:8787/api/auth
curl --max-time 5 http://adscout.dva-lymona.biz.ua:8788/
```

> **Behind Cloudflare these two curls prove nothing.** The proxy does not carry
> 8787 or 8788, so they fail identically whether the origin has those ports wide
> open to the internet or bound to loopback — a pass you have not earned. Run
> them against the **origin IP** instead:
>
> ```bash
> curl --max-time 5 http://<origin-ip>:8787/api/auth
> curl --max-time 5 http://<origin-ip>:8788/
> ```
>
> The `ss -ltnp` check below is authoritative either way, which is why it is
> here and not optional.

And on the VPS itself, confirm what the sockets are actually bound to — this is
the authoritative check, not the log line:

```bash
sudo ss -ltnp | grep -E '8787|8788'
# want:  127.0.0.1:8787   and   127.0.0.1:8788
# NOT:   0.0.0.0:8787 / *:8787
```

Then in a browser: sign in with an `ADMIN_EMAILS` account, confirm the dashboard
loads, and that the live indicator reads **Live** (that is the SSE feed — if it
sits on *Reconnecting*, see the troubleshooting table).

Finally, compare the numbers to the old machine: account count, target count,
and the Responses tab total should match what you dumped.

---

## 11. Cutover

### Move one mailbox first

This is the only step that cannot be undone by editing a config file. Your
accounts were warmed on a residential IP and will begin sending from a datacenter
IP in a different country at the same moment. Expect Google sign-in challenges,
and understand this touches deliverability — the thing the warmup ramp exists to
protect.

```bash
# on the VPS: pause everything, then re-activate ONE account in the dashboard
STORE=pouchdb pnpm accounts:pause
```

Watch that account's bounce rate in **Accounts → Results** for a few days before
activating the rest. `gmail-api` over OAuth travels better here than SMTP.

### Then stop the source machine — permanently

After the load, two machines hold a complete copy of the same store. If both run
the scheduler, **both will send to the same targets from the same mailboxes**.
The process lock only protects one machine from itself; it knows nothing about
the other.

- Stop `pnpm serve` on the Mac.
- Remove any login item, `launchd` job or cron entry that restarts it.
- Keep the checkout and the `data/` directory — that is your rollback (§12).

### Then make the mistake impossible rather than remembered

"Do not run `pnpm serve` here" is not a control — the laptop keeps a full copy of
the store precisely so rollback stays cheap, and one absent-minded `just dev` is
all it takes. Three layers, each one line, all independent:

| | | |
|---|---|---|
| 1 | **`STORE=memory` in the Mac's `.env`** | The store is then fresh at boot and gone at Ctrl-C. This is the one that matters: `STORE=pouchdb` is what makes a stray run dangerous. |
| 2 | **Move the copy aside** — `mv data/pouch data/pouch-frozen-$(date +%F)` | So even flipping `STORE` back finds nothing. Rollback is the `mv` back. |
| 3 | **Leave `EMAIL_PROVIDER` unset, keep `client_secret.json` off the Mac** | `buildAgent()` then hands out `DummyEmailProvider`, which can neither send nor poll whatever the store says. |

You would have to undo all three to cause damage.

### Testing locally, after all that

An empty in-memory store is safe and not much use, so:

```bash
just dev-seed      # SEED=demo STORE=memory EMAIL_PROVIDER= pnpm dev:all
```

One account and two targets in a store that evaporates on Ctrl-C, with a console
you can actually click through and a "Run now" that exercises the pipeline end
to end against the dummy transport.

It is safe by construction, not by convention — `SEED=demo` **refuses to boot**
with `STORE=pouchdb` ("fixtures must never be written to a real store") or with a
live `EMAIL_PROVIDER` ("the drip scheduler would send to them"). Both are fatal
at boot. And because `dotenv` never overrides what is already in the
environment, the recipe's settings win even while `.env` still says
`STORE=pouchdb`.

---

## 12. Rollback

Nothing is destroyed by this migration, so rollback is cheap for as long as you
keep the source machine's `data/` intact.

```bash
# On the VPS
sudo systemctl stop adscout

# On the Mac
pnpm serve
```

The only thing that does not roll back is Gmail's view of your sending IP. If you
have been sending from the VPS for days and revert, that is another IP change —
which is why §11 says move one account first.

Take a dump of the VPS before any risky change, so you can roll *forward* too:

```bash
sudo systemctl stop adscout
cd /opt/adscout && sudo -u adscout pnpm data:dump --out ./backup-$(date +%F)
sudo systemctl start adscout
```

---

## 13. Day-2 operations

> ### ⚠️ Never `git clean` in /opt/adscout
>
> The service user's home IS the checkout, so `git status` there always shows
> `.ssh/`, `.cache/` and `.local/` as untracked. They are meant to be there.
>
> `git clean -fdx` would delete **`data/` (the database), `backups/`, `.ssh/`
> (the CI deploy key) and `node_modules/`** in one go — `-x` removes ignored
> files, which is exactly where all the state lives. There is no undo, and the
> most recent hourly backup is inside `backups/`.
>
> `deploy.sh` never cleans: it uses `git fetch` and `git checkout --detach`, so
> untracked and ignored files survive every deploy. The danger is only a human
> reaching for it when a build looks stuck. Delete `node_modules` by name
> instead.

```bash
sudo systemctl restart adscout      # after an .env change
journalctl -u adscout -f            # live
ls /opt/adscout/logs/               # daily JSONL, pruned per LOG_RETENTION_DAYS

cd /opt/adscout && git pull && pnpm install && pnpm web:build
sudo systemctl restart adscout      # deploying new code
```

### Backups

The server takes one **every hour**, by itself. Nothing to schedule, and no
downtime: `pnpm data:dump` cannot run while the service is up (PouchDB is
single-writer), so the backup runs *inside* the server, holding the same
`passLock` the pipeline passes and the dashboard's write routes take. Nothing —
no send, poll, worker result or hand-edit — can land mid-snapshot. It costs about
1.7 s per hour and produces ~3.8 MB.

Each archive is exactly what `data:load` reads, and is verified before it counts:
the manifest is read back *out of* the finished `.tar.gz` and its document counts
compared to what was written. It is renamed into place last, so a crash leaves a
`.partial` nobody can mistake for a good backup.

Retention needs no second job — one rule does it:

| | |
|---|---|
| today | every hourly kept |
| any earlier day | only that day's newest survives |
| older than `BACKUP_KEEP_DAYS` (14) | deleted |

The "daily backup" is simply the survivor of each past day. Steady state is ~24 +
14 archives, about **140 MB**.

Set `BACKUP_BUCKET` (or leave it to fall back to `SNAPSHOT_BUCKET`) and every
archive is mirrored to Cloud Storage with the same rule applied there, so offsite
matches on-box. A mirror failure is logged, never fatal — the local copy already
succeeded, and losing the server over a Cloud Storage hiccup would be worse.

> **The archives contain every mailbox's OAuth refresh token in the clear.**
> `storage.rules` denies browser reads outside the `snapshot/` prefix, so only
> the Admin SDK's service account can read `backups/`. Treat that JSON — and any
> copy of these archives — as mailbox credentials.

### Restoring

Loads into a **new** directory and swaps, so a failed restore leaves the original
untouched:

```bash
sudo systemctl stop adscout
mkdir -p /tmp/restore && tar xzf backups/adscout-2026-09-03T14.tar.gz -C /tmp/restore
STORE=pouchdb POUCH_DIR=/opt/adscout/data/pouch-new pnpm data:load --in /tmp/restore
# ONLY if it printed "every type matches the manifest":
mv data/pouch data/pouch-old && mv data/pouch-new data/pouch
sudo systemctl start adscout
```

Do this once, deliberately, before you need it. A backup nobody has restored is
not a backup.

### One known limitation

If a reply fails every extraction attempt `REMOTE_MAX_FAILED` times (default 10),
the hub stops handing out work **for the lifetime of the process**. That backstop
exists because an unrecognized usage limit once burned hundreds of good replies.
On a long-running server it clears only on restart. The log line is
`remote hub STOPPED handing out work`; `systemctl restart adscout` resumes.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `/api/status` returns **200** instead of 401 | `ADMIN_EMAILS` did not load | check `.env`; the boot log says which mode it started in |
| Console: `auth/invalid-api-key` | a build from before the config was hardcoded, or a stale `web/dist` | `git pull && pnpm web:build`; the config lives in `web/src/viewer/firebase.ts` now, not in `web/.env.local` |
| Sign-in works, Firebase calls rejected | App Check enforced without the domain on the reCAPTCHA key | §8, step 3 |
| Sign-in popup: "unauthorized domain" | domain not in Firebase authorized domains | §8, step 2 |
| Connecting a mailbox → `redirect_uri_mismatch` | callback URI not registered | §8, step 1 — must be the `https://` form, exactly |
| Signed in, but "not authorized for this instance" | email absent from both lists, or unverified | add to `ADMIN_EMAILS`, restart; the address must be a verified Google account |
| Dashboard loads but assets 404 | stock Hestia proxy template is serving the docroot | set the Proxy Template to `adscout` and rebuild (§7) |
| Live indicator stuck on **Reconnecting** | nginx buffering SSE | confirm `proxy_buffering off` is in the active config (§7) |
| Nothing is ever extracted | hub not started, or no worker connected | boot log: `REMOTE_TOKEN` unset? Is `pnpm remote:worker` running on the Mac? |
| Worker: `413` on posting a result | `client_max_body_size` too small | hub template sets `128m` (§9 option B) |
| `agent already running (pid N)` but nothing is | stale `data/agent.lock` copied from the Mac | `rm /opt/adscout/data/agent.lock` |
| `status=203/EXEC`, "Failed to locate executable" | `ExecStart` points somewhere pnpm is not | `which pnpm`, then set that path in `/etc/systemd/system/adscout.service` and `daemon-reload` |
| `status=226/NAMESPACE`, "Failed to set up mount namespacing" | one of the unit's `ReadWritePaths` does not exist | `mkdir -p /opt/adscout/{data,logs,backups}`. The message names a missing `pnpm` too — ignore that, the namespace failed first |
| Mail sends succeed but nothing arrives | `EMAIL_PROVIDER` unset ⇒ dummy provider | §5 |
| Sending at the wrong hours | `TZ` not applied | §5; check `journalctl` timestamps and `timedatectl` |
| `deploy.sh`: "working tree is dirty" | someone edited files on the box | commit, stash or `git checkout --` them, then redeploy |
| `deploy.sh`: rolled back automatically | new revision never answered `/api/auth` | `journalctl -u adscout -n 80` — the previous revision is running |
| `deploy.sh`: "needs hands" | even the rollback would not come up | the service is DOWN; check the log, fix, redeploy manually |
| CI deploy job: host key mismatch | `DEPLOY_KNOWN_HOSTS` is stale | regenerate with `ssh-keyscan -H <host>` and update the secret |
| SSH to the hostname times out, but the site loads | Cloudflare proxy — 22 is not carried | §7b; use the origin IP or a grey-cloud record |
| Browser: `ERR_TOO_MANY_REDIRECTS` on the dashboard | Cloudflare SSL/TLS mode is **Flexible** | set it to Full (strict) — §7b |
| `ssh-keyscan` returns nothing for the host | scanned the proxy, not the origin | scan the address in `DEPLOY_HOST` |
| backups never appear | `tar` missing, or `BACKUP=off` | the boot log says which; `journalctl -u adscout \| grep -i backup` |
