# Remote extraction — borrowing a second machine's Claude subscription

Extraction runs on the Claude Code CLI against your **subscription** usage, not
per-token API billing (`src/adapters/llm/claude-code.provider.ts`). One machine's
usage window is therefore the ceiling on a large re-extract. A second logged-in
machine roughly doubles the throughput.

Only the *work* travels. The database never leaves the host.

> Just want the commands? → **[REMOTE-QUICKSTART.md](REMOTE-QUICKSTART.md)**

```
HOST (has the data)                         WORKER (has a Claude subscription)
───────────────────                         ──────────────────────────────────
pnpm remote:hub                             pnpm remote:worker
  │                                           │
  │  POST /work/claim ────── ngrok ─────────▶ │  claims one reply
  │    { input: ExtractInput }                │  extractReplyCore(…)  ← shared code
  │                                           │    runs `claude -p …`
  │  POST /work/:id/result ◀───────────────── │  { extracted: ExtractedReply }
  │    persistExtraction(…)  ← shared code    │
  ▼                                           ▼
 rollup + price history + provenance         no database, no mailbox
```

The split is the one `poll-pass` already makes internally: **extract** (slow,
writes nothing) then **persist** (fast, every write). The worker runs the first
half; the hub runs the second. Both halves are the same source files a local run
uses, so a remotely extracted reply is indistinguishable from a local one — same
prompt, same prompt hash, same rollup, same `PriceRecord`s, same provenance.

---

## Run it

### 1. On the host (where `data/` lives)

Stop `pnpm serve` first — see [Locking](#locking). The hub replaces it: it serves
the same dashboard on the same port.

```bash
STORE=pouchdb REMOTE_TOKEN=<pick-a-secret> pnpm remote:hub
```

```
  dashboard: http://localhost:8787  — watch replies land here as workers finish them

AdScout remote hub on http://localhost:8788  ·  store=pouchdb  ·  412 reply(ies) pending

  1. publish it:   ngrok http 8788   (this port ONLY — never the dashboard)
```

In a second terminal, publish the **worker** port:

```bash
ngrok http 8788
```

### 2. On the other machine

Clone the repo, `pnpm install`, and make sure `claude` is on PATH and logged in
(`claude login` — an API key would switch it to per-token billing, which is the
thing we are avoiding).

```bash
REMOTE_HUB_URL=https://xxxx.ngrok-free.app \
REMOTE_TOKEN=<the same secret> \
CLAUDE_CODE_MODEL=claude-sonnet-5 pnpm remote:worker
```

It checks the URL and token immediately, then starts claiming:

```
AdScout remote worker "mac-mini" → https://xxxx.ngrok-free.app
  provider=claude-code  model=claude-sonnet-5  concurrency=1
  hub has 412 reply(ies) pending

[22:30:06] ▶ techbriefdaily.com — extracting (attempt 1/3)…
[22:30:36]   … still on techbriefdaily.com (30s)
[22:30:32] ✓ techbriefdaily.com — 4 offer(s) in 26s · stored · 4 offer(s)
```

and the hub shows the other side of every line:

```
[22:30:06] claim  techbriefdaily.com → mac-mini (claude-sonnet-5) attempt 1 · 411 pending
[22:30:32] ok     techbriefdaily.com ← mac-mini · 4 offer(s) in 26s
[22:31:06] · 411 pending · 1 in flight (greenhomeblog.net 34s) · 1 done, 0 spam, 0 failed
```

A single extraction can be minutes of silence (a linked price sheet, several
model turns), so the worker prints a `… still on` tick every 30s and the hub
prints a status line every 60s. If the terminal is quiet, nothing is happening.

---

## Watching progress in the dashboard

The hub serves the normal UI at `http://localhost:8787`, including the `/api/stream`
SSE change feed the front-end already subscribes to. So a remote run looks like
any other run in the browser — no polling, no refresh:

- **Responses** — each reply flips from pending to extracted as its worker
  finishes, with the offers, prices and niches it found.
- **Targets** — status moves to `replied`.
- **Domains** — new `PriceRecord`s appear in the price history.
- **Status** — `pendingExtraction` counts down.

Run `pnpm build` once if `web/dist` does not exist yet, exactly as for `pnpm serve`.

Two things live only in the hub's terminal, because they are about the *workers*
rather than the data: which machine holds which reply right now, and the
usage-limit pauses. `GET /status` on the hub port returns the same as JSON.

### Flags

| Hub (`pnpm remote:hub`) | |
|---|---|
| `--port N` | worker-facing port, the one to publish (default 8788, or `REMOTE_PORT`) |
| `--ui-port N` | dashboard port (default 8787, or `PORT`) |
| `--no-ui` | don't serve the dashboard (headless run) |
| `--attempts N` | tries per reply before it is marked `failed` (default 3) |
| `--max-failed N` | failed replies tolerated before the hub stops handing out work (default 1, matching local) |
| `--lease-ms MS` | how long a claimed reply is held before re-offering (default 20 min) |
| `--wait-ms MS` | how long an idle claim is held open (default 20s) |
| `--until-empty` | exit once every reply is extracted — for unattended runs |

| Worker (`pnpm remote:worker`) | |
|---|---|
| `--concurrency N` | replies in the model at once (default 1) |
| `--id NAME` | how this worker appears in the hub's log (default: hostname) |
| `--once` | take one reply, report it, exit — a good first test |

Hub exit codes match `reextract:stored` (`0` done, `3` some left `failed`,
`1` fatal), so `scripts/reextract-loop.sh`-style wrappers work unchanged.

---

## What is guaranteed

**Nothing is lost.** A reply stays `pending` in the database until a result is
actually stored. The hub leases each reply to one worker; if the worker crashes,
is Ctrl-C'd, or loses the tunnel, the lease expires and the reply is re-offered.
A late result from an expired lease is rejected, so a reply can never be
persisted twice (and its price history can never double-count).

**A usage limit costs nothing.** When a worker's window closes, the reply goes
straight back to the queue without burning an attempt — exactly as a local run
leaves it pending. The worker parks every lane until the reset time and resumes
on its own; another machine can pick the reply up meanwhile.

**Failures are bounded.** Any other error is retried up to `--attempts`. When a
reply burns every attempt the hub **stops handing out work entirely** — the same
backstop `extractPendingReplies` applies locally, and for the same reason: a reply
that failed every try, spread over separate claims, is not a transient failure,
and the rest of the queue would meet it too. That is exactly how an unrecognized
usage limit once burned hundreds of good replies. Workers are told and exit;
untouched replies are left `pending`, so re-running resumes cleanly. Raise
`--max-failed` if you would rather one broken worker not halt a multi-machine run.

**Provenance is real.** The model id recorded on every stored price is the one
the *worker* actually ran, and the prompt is archived under its hash by the hub.
Run the same `CLAUDE_CODE_MODEL` on every machine unless you deliberately want a
mixed-model run — a full model id, never the `sonnet` alias, which moves.

**Gmail labels are applied**, identically to a local extraction:

| Result | Label |
|---|---|
| extracted (by intent) | `AS/Answered`, `AS/Declined`, `AS/Question`, `AS/AutoReply`, `AS/Holding` |
| opt-out (overrides intent) | `AS/Unsubscribe` |
| AI-detected spam | `AS/Ignored` |
| failed every attempt | `AS/Replied` (provisional, as before) |
| usage-limit pause | *unchanged* — the reply was not processed |

Labeling happens **on the host**, through the host's own email provider — the
worker has no mailbox access and never sees a credential. It is best-effort
exactly as it is locally: a Gmail failure is logged and does not fail the
extraction. Two prerequisites, both the same as a local run: `EMAIL_PROVIDER`
must not be `dummy`, and the account must be an OAuth-connected `gmail-api`
account (`SmtpImapProvider.applyLabel` is a no-op, so IMAP accounts are never
labelled, remote or local).

---

## Locking

The hub takes the same process lock `pnpm serve` does, because it is a **writer**.
PouchDB is single-process, and its `put()` reads a doc's `_rev` and writes it
back — two writers racing the same document (a shared target, a niche both just
learned, the one prompt-snapshot doc) means a rejected write and a lost result.

So: **stop `pnpm serve` before starting the hub.** It will refuse to start
otherwise, naming the pid holding the lock. Nothing is lost by doing so — the hub
serves the same dashboard and API, and a manual "Run now" still works, serialized
against incoming remote results by the same lock. What the hub does *not* run is
the drip scheduler, so no outreach is sent while it is up.

Within the hub, every store write runs behind a single mutex for the same reason.
The model calls are what happens in parallel — out on the workers — while the
writes stay one at a time. This mirrors how `extractPendingReplies` already works
locally with `--concurrency`.

---

## Security

`ngrok http 8788` publishes to the internet. Two things follow:

- **Only the worker port goes through the tunnel, never the dashboard.** The API
  server (`src/server/app.ts`) has no authentication at all — it can delete
  targets, read account data, and handle OAuth callbacks. The hub runs it on a
  *separate port* (8787) precisely so the tunnel can't reach it. `ngrok http 8788`,
  never 8787.
- **`REMOTE_TOKEN` is mandatory.** Every hub endpoint except an empty liveness
  ping requires `Authorization: Bearer <token>`, compared in constant time. The
  hub generates a token if you did not set one and refuses to run without one.

The trust boundary is "another machine of yours holding the token". Results are
size-capped and structurally validated — a worker on an old commit, or a
truncated body, is rejected rather than half-written — but this is a version-skew
guard, not an adversarial one. Take the tunnel down when the run is finished.

---

## Files

| | |
|---|---|
| `src/pipeline/extract-core.ts` | the shared seam: `ExtractInput` → `ExtractedReply`, no Store, no Config |
| `src/server/remote-hub.ts` | queue, leases, auth, and the persist half |
| `src/scripts/remote-hub.ts` | host CLI (`pnpm remote:hub`) |
| `src/scripts/remote-worker.ts` | worker CLI (`pnpm remote:worker`) |
| `src/server/remote-hub.test.ts` | lease/retry/usage-limit/validation behaviour |
