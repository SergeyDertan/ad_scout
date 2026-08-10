# Remote extraction — quickstart

Run extraction on a second machine's Claude subscription. Copy-paste in order.
Background and guarantees: [REMOTE-EXTRACTION.md](REMOTE-EXTRACTION.md).

---

## A. This machine (the one with the database)

**1. Stop the server.** The hub replaces it — same dashboard, same port. Two
writers on one PouchDB corrupts it, so the hub refuses to start otherwise.

```bash
# Ctrl-C whatever is running `pnpm serve`
```

**2. Pick a token once** and put it in `.env` (any random string):

```bash
REMOTE_TOKEN=choose-a-long-random-string
```

**3. Start the hub:**

```bash
pnpm remote:hub
```

```
  dashboard: http://localhost:8787  — watch replies land here as workers finish them

AdScout remote hub on http://localhost:8788  ·  store=pouchdb  ·  412 reply(ies) pending

  1. publish it:   ngrok http 8788   (this port ONLY — never the dashboard)
```

**4. In a second terminal, publish port 8788:**

```bash
ngrok http 8788
```

ngrok prints a public URL. Copy it:

```
Forwarding  https://abc123.ngrok-free.app -> http://localhost:8788
            ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^ this
```

> ⚠️ **8788, never 8787.** The dashboard has no password. Tunnel only the hub port.

---

## B. The other machine (the one that does the work)

**1. Install once:**

```bash
git clone https://github.com/SergeyDertan/ad_scout.git
cd ad_scout
pnpm install                 # needs Node >= 26 and pnpm >= 11
claude login                 # subscription login — do NOT set ANTHROPIC_API_KEY
```

No `.env`, no database, no Gmail setup needed here.

**2. Run the worker** with the URL from step A.4 and the token from A.2:

```bash
REMOTE_HUB_URL=https://abc123.ngrok-free.app \
REMOTE_TOKEN=choose-a-long-random-string \
CLAUDE_CODE_MODEL=claude-sonnet-5 \
pnpm remote:worker
```

It checks the URL and token immediately, then starts working:

```
AdScout remote worker "mac-mini" → https://abc123.ngrok-free.app
  provider=claude-code  model=claude-sonnet-5  concurrency=1
  hub has 412 reply(ies) pending

[22:30:06] ▶ techbriefdaily.com — extracting (attempt 1/3)…
[22:30:32] ✓ techbriefdaily.com — 4 offer(s) in 26s · stored · 4 offer(s)
```

**Test it with one reply first:** add `--once`. Speed it up later with
`--concurrency 3`.

---

## Watching it

- **Browser** → `http://localhost:8787` on the host. Replies flip to extracted,
  prices appear, live. (Run `pnpm build` once if the page is blank.)
- **Hub terminal** → one line per claim/result, plus a status line every 60s.
- **Worker terminal** → one line per reply, plus a `… still on <site>` tick every
  30s during long extractions.

## Stopping

Ctrl-C either side, any time. A reply is only ever marked done once its result is
stored, so anything in flight simply stays pending and gets picked up next run.
Take the ngrok tunnel down when you're finished.

## If something is wrong

| Symptom | Cause |
|---|---|
| `agent already running (pid …)` | `pnpm serve` is still up on the host — stop it. |
| Worker: `REMOTE_TOKEN does not match the hub` | Tokens differ. The hub prints the one it is using at startup. |
| Worker: `cannot reach the hub` | Wrong URL, or ngrok was restarted (its URL changes each run). |
| Worker: `WARNING: the dummy provider…` | `LLM_PROVIDER` is set to `dummy` in the environment — set `claude-code`. |
| Hub log: `LIMIT … usage window` | Normal. The reply was re-queued, nothing lost; the worker sleeps until reset. |
| Hub log: `ABORT … failed every attempt`, worker exits | A reply failed every try, so the hub stopped rather than spend the queue on a non-transient fault. Check the log, fix it, re-run. |
