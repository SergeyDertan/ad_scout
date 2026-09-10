# Remote extraction — how it works

Extraction runs on the Claude Code CLI against a **subscription** login, not
per-token API billing (`src/adapters/llm/claude-code.provider.ts`). A server
can't hold that login, and one machine's usage window caps a large re-extract.
So the model work travels to machines that have `claude`; the database never
leaves the host.

> Just want the commands? → **[REMOTE-QUICKSTART.md](REMOTE-QUICKSTART.md)**

```
HOST (has the data)                              WORKER (has a Claude subscription)
───────────────────                              ──────────────────────────────────
VPS:   pnpm serve   (hub on :8788)               pnpm remote:worker
local: pnpm remote:hub                             │
  │                                                │
  │  POST /work/claim ── SSH tunnel · nginx /hub · ngrok ──▶ claims one reply
  │    { input: ExtractInput }                     │  extractReplyCore(…)  ← shared code
  │                                                │    runs `claude -p …`
  │  POST /work/:id/result ◀────────────────────── │  { extracted: ExtractedReply }
  │    persistExtraction(…)  ← shared code         │
  ▼                                                ▼
 rollup + price history + provenance              no database, no mailbox
```

The split is the one `poll-pass` makes internally: **extract** (slow, writes
nothing), then **persist** (fast, does every write). The worker runs the first
half and the hub runs the second. Both halves are the same source files a local
run uses, so a remotely extracted reply is indistinguishable from a local one:
same prompt, prompt hash, rollup, `PriceRecord`s and provenance.

---

## Where the hub runs

| | inside `pnpm serve` (the VPS) | `pnpm remote:hub` (standalone, local) |
|---|---|---|
| started | at boot, when `REMOTE_TOKEN` is set (`REMOTE_HUB=off` disables it). Without a token it logs `hub NOT started`. | by hand, with `pnpm serve` stopped (same single-writer lock) |
| token | required | generated and printed if unset |
| drip scheduler | keeps running | not running, so nothing is sent while it is up |
| failure backstop | `REMOTE_MAX_FAILED`, default 10 | `--max-failed`, default 1 |
| console | the normal one, behind sign-in | its own on :8787 (`--no-ui` to skip). Treat it as open: never publish 8787. |
| workers reach it by | an SSH tunnel to `127.0.0.1:8788`, or `https://<domain>/hub` through nginx | localhost, or `ngrok http 8788` for another machine |

Use the standalone hub for one-off bulk re-extracts against a local store, for
example `data/pouch-prod` from `scripts/fetch-prod-db.sh`.

---

## Watching progress

- **Worker terminal:** one line per reply, plus a `… still on <site>` tick every
  30s. A single extraction can be minutes of silence (a linked price sheet,
  several model turns).
- **Hub side:**
  - VPS: `just logs` shows `remote claim`, `remote extracted`, usage-limit and
    lease-expiry lines.
  - Standalone: prints a status line every 60s.
  - Either way, `GET /status` on the hub port returns the same as JSON.
- **Console:** updates live over SSE.
  - Responses flip from pending to extracted.
  - Targets move to `replied`.
  - Domains gain new price records.
  - The Status line's pending-extraction count goes down.

### Flags

| Standalone hub (`pnpm remote:hub`) | |
|---|---|
| `--port N` | worker-facing port (default 8788, or `REMOTE_PORT`) |
| `--ui-port N` | console port (default 8787, or `PORT`) |
| `--no-ui` | don't serve the console (headless run) |
| `--attempts N` | tries per reply before it is marked `failed` (default 3) |
| `--max-failed N` | failed replies tolerated before the hub stops handing out work (default 1) |
| `--lease-ms MS` | how long a claimed reply is held before it is offered again (default 20 min) |
| `--wait-ms MS` | how long an idle claim is held open (default 20s) |
| `--until-empty` | exit once every reply is extracted, for unattended runs |

Exit codes match `reextract:stored`: `0` done, `3` some left `failed`, `1` fatal.

| Worker (`pnpm remote:worker`) | |
|---|---|
| `--concurrency N` | replies in the model at once (default 1) |
| `--id NAME` | how this worker appears in the hub's log (default: hostname) |
| `--once` | take one reply, report it, exit (a good first test) |

---

## What is guaranteed

**Nothing is lost.** A reply stays `pending` in the database until a result is
actually stored. The hub leases each reply to one worker. If the worker crashes,
is Ctrl-C'd or loses its connection, the lease expires and the reply is offered
again. A late result from an expired lease is rejected, so a reply can never be
persisted twice and its price history can never double-count.

**A usage limit costs nothing.** When a worker's window closes, the reply goes
straight back to the queue without using up an attempt. The worker pauses until
the reset time and resumes on its own; another machine can take the reply
meanwhile.

**Failures are bounded.** Any other error is retried up to the attempt limit.
When replies use up every attempt, the hub **stops handing out work** (after 10
in `serve`, 1 standalone). A reply that failed every try is not a transient
failure, and the rest of the queue would likely hit it too: an unrecognized usage
limit once burned hundreds of good replies this way. Untouched replies stay
`pending`, so a restart resumes cleanly.

**Provenance is real.** The model id recorded on every stored price is the one
the *worker* actually ran, and the hub archives the prompt under its hash. Run
the same `CLAUDE_CODE_MODEL` on every machine unless you deliberately want a
mixed-model run. Use a full model id, never the `sonnet` alias, which moves to
each new model.

**Gmail labels are applied** exactly as in a local extraction:

| Result | Label |
|---|---|
| extracted (by intent) | `AS/Answered`, `AS/Declined`, `AS/Question`, `AS/AutoReply`, `AS/Holding` |
| opt-out (overrides intent) | `AS/Unsubscribe` |
| AI-detected spam | `AS/Ignored` |
| failed every attempt | `AS/Replied` (provisional) |
| usage-limit pause | *unchanged*: the reply was not processed |

Labelling happens **on the host**, through the host's own email provider. The
worker has no mailbox access and never sees a credential. As locally, it is
best-effort: a Gmail failure is logged and doesn't fail the extraction. It needs
a real `EMAIL_PROVIDER` and an OAuth-connected `gmail-api` account; IMAP accounts
are never labelled.

---

## Locking

Hub results are store writes. PouchDB is single-process, and its `put()` reads a
doc's `_rev` and writes it back. Two writers racing on the same document (a shared
target, a niche both just learned, the one prompt-snapshot doc) means a rejected
write and a lost result. So:

- **Inside `serve`**, every hub persist takes the same `passLock` as the send and
  fetch passes and the console's write routes.
- **Standalone**, the hub takes the process lock `pnpm serve` takes, so stop
  `serve` first. It refuses to start otherwise and names the pid holding the
  lock. It still serves the console and manual "Run now", serialized against
  incoming results by one mutex.

The model calls run in parallel, out on the workers. The writes stay one at a
time.

---

## Security

- **VPS:** both ports are bound to `127.0.0.1` (`BIND_HOST`). Workers come in over
  an SSH tunnel or through nginx at `/hub` over TLS. Never open 8788 in the
  firewall.
- **`REMOTE_TOKEN` is mandatory.** Every hub endpoint except an empty liveness
  ping requires `Authorization: Bearer <token>`, compared in constant time.
- **A standalone hub on a laptop:** tunnel only 8788 (`ngrok http 8788`), never
  the console on 8787. Take the tunnel down when the run is finished.
- **Trust boundary:** "another machine of yours holding the token". Results are
  size-capped and structurally validated, so a worker on an old commit or a
  truncated body is rejected rather than half-written. This is a guard against
  version skew, not against an attacker.

---

## Files

| | |
|---|---|
| `src/pipeline/extract-core.ts` | the shared seam: `ExtractInput` → `ExtractedReply`, no Store, no Config |
| `src/server/remote-hub.ts` | queue, leases, auth, and the persist half |
| `src/serve.ts` | starts the hub inside the server |
| `src/scripts/remote-hub.ts` | standalone hub CLI (`pnpm remote:hub`) |
| `src/scripts/remote-worker.ts` | worker CLI (`pnpm remote:worker`) |
| `src/server/remote-hub.test.ts` | lease, retry, usage-limit and validation behaviour |
