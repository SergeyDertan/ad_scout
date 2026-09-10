# Remote extraction — quickstart

Extraction needs a logged-in `claude` CLI (a Claude subscription), and the VPS
doesn't have one. So the VPS runs the **hub** inside `pnpm serve`. A **worker** on
your Mac claims unextracted replies, reads them with its own `claude`, and sends
the results back. Copy-paste in order.

Background and guarantees: [REMOTE-EXTRACTION.md](REMOTE-EXTRACTION.md).

---

## A. Worker → VPS (the normal case)

The hub is already running on the VPS whenever `REMOTE_TOKEN` is set in the VPS
`.env`. Nothing needs starting there. `just boot-log` shows a `remote extraction
hub on :8788` line, or `hub NOT started` if the token is missing.

**1. Install once, on the Mac:**

```bash
git clone https://github.com/SergeyDertan/ad_scout.git
cd ad_scout
pnpm install        # Node >= 26, pnpm >= 11
claude login        # subscription login — do NOT set ANTHROPIC_API_KEY
```

No `.env`, no database and no Gmail setup are needed on this machine.

**2. Connect.** Recommended: an SSH tunnel. The hub stays on the box's loopback
and the token never crosses the public internet.

```bash
# terminal 1 — keep it open (autossh -M 0 -N … for unattended runs)
ssh -N -L 8788:127.0.0.1:8788 <user>@adscout.dva-lymona.biz.ua

# terminal 2
REMOTE_HUB_URL=http://127.0.0.1:8788 \
REMOTE_TOKEN=<REMOTE_TOKEN from the VPS .env> \
CLAUDE_CODE_MODEL=claude-sonnet-5 \
pnpm remote:worker
```

No tunnel? nginx also proxies the hub at `/hub` on the main domain:
`REMOTE_HUB_URL=https://adscout.dva-lymona.biz.ua/hub`. Use `https://`: an
`http://` URL gets redirected, and a redirected POST fails.

It checks the URL and token right away, then starts working:

```
AdScout remote worker "mac-mini" → http://127.0.0.1:8788
  provider=claude-code  model=claude-sonnet-5  concurrency=1
  hub has 412 reply(ies) pending

[22:30:06] ▶ techbriefdaily.com — extracting (attempt 1/3)…
[22:30:32] ✓ techbriefdaily.com — 4 offer(s) in 26s · stored · 4 offer(s)
```

Try one reply first with `--once`. Speed up later with `--concurrency 3`.

**Watching:** the dashboard updates live (replies flip to extracted, prices
appear). `just logs` shows `remote claim` / `remote extracted` lines.

---

## B. A local hub (bulk re-extract on a copy of the data)

For a one-off run against a store on your own machine, for example
`data/pouch-prod` from `scripts/fetch-prod-db.sh`:

```bash
# stop `pnpm serve` first — the hub takes the same single-writer lock
STORE=pouchdb POUCH_DIR=./data/pouch-prod REMOTE_TOKEN=<any long secret> pnpm remote:hub
```

It serves the dashboard on :8787 and the worker port on :8788. Run a worker on
the same machine against `http://127.0.0.1:8788`. For another machine, publish
**8788 only** (`ngrok http 8788`), never 8787. Flags are listed in
REMOTE-EXTRACTION.md.

---

## Stopping

Press Ctrl-C on either side, any time. A reply is marked done only once its
result is stored, so anything in flight stays pending and is picked up next time.

## If something is wrong

| Symptom | Cause |
|---|---|
| Worker: `REMOTE_TOKEN does not match the hub` | Tokens differ. Copy the one from the hub's `.env`. |
| Worker: `cannot reach the hub` | Tunnel down, wrong URL, `http://` against `/hub`, or a restarted ngrok (new URL). |
| Worker: `WARNING: the dummy provider…` | `LLM_PROVIDER=dummy` in the worker's environment. Unset it or set `claude-code`. |
| Hub log: `LIMIT … usage window` | Normal. The reply was re-queued and nothing was lost; the worker sleeps until the reset. |
| Hub log: `STOPPED handing out work` / `ABORT` | Replies failed every attempt, so the hub stopped rather than burn the queue: 10 in `serve` (`REMOTE_MAX_FAILED`), 1 for a local hub. Check the log, fix the cause, restart (`just restart` on the VPS). |
| Local hub: `agent already running (pid …)` | `pnpm serve` is still running on that machine. Stop it. |
