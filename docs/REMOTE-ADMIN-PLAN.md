# Remote deal admin — findings and plan

Giving a second person **write** access to deals — read the negotiation, see every
email on the thread, answer, and record the link/price/paid — from wherever they
are, without handing over the mailboxes.

> Status: **partly implemented** — items 7.1–7.7 are built; see §7 for what is
> done and what is left. The migration runbook that came out of this is
> [VPS-DEPLOY.md](./VPS-DEPLOY.md). This document remains the survey and the
> decisions taken, so the next session starts from the conclusion rather than
> re-deriving it.

The read-only sibling already exists — see [VIEWER.md](./VIEWER.md), which shares
*prices* one-way. This is the opposite problem: few people, full write access,
on one part of the app.

---

## 1. What the remote admin has to be able to do

Read the deal list · open one deal and read its whole message timeline · reply
into the thread · add and update placements (published URL, agreed price, paid,
live) · move the deal's status. **Deal creation deliberately stays local** — it
is the one operation that starts from the operator's own inbox.

---

## 2. What the code already gives us

Three findings that shaped every option below.

### 2.1 The deals API is already complete

Nothing to build on the server. The endpoints exist and are exactly the set the
remote admin needs:

| Need | Endpoint |
|---|---|
| The deal list, with derived domain/paid/live counts | `GET /api/deals` |
| One deal: placements, domains, thread ids, **full timeline** | `GET /api/deals/:id` |
| Status / note | `PATCH /api/deals/:id` |
| Placements | `POST /api/deals/:id/placements` · `PATCH`/`DELETE /api/placements/:id` |
| Answer (threaded, holds the thread) | `POST /api/deals/:id/messages` |
| Mailbox list | `GET /api/accounts` |
| Live updates | `GET /api/stream` (SSE) |

Eight endpoints plus SSE. `POST /api/deals` (creation) is a separate route, so
scoping it out costs nothing.

### 2.2 The front end already swaps its data layer

`web/vite.config.ts` builds two targets from one tree; `VITE_TARGET=viewer`
resolver-swaps `api.ts` → `api.snapshot.ts`. A third target is an established
pattern here, not a new idea. And `web/src/api.ts:29` has exactly **one**
`fetch('/api' + path)` — pointing the whole app at a remote origin is a handful
of lines, not a refactor.

### 2.3 CORS is already open

`sendJson` (`app.ts:119`), both SSE handlers and the OPTIONS branch all send
`Access-Control-Allow-Origin: *`. A Firebase-hosted app can call the API
cross-origin today with no server change.

---

## 3. The blocker

**`src/server/app.ts` has no authentication of any kind.** The only
authenticated surfaces in the repo are `remote-hub.ts` (bearer token,
constant-time compare) and the Firebase viewer (Auth + allowlist rules).

So `ngrok http 8787` as it stands publishes, to anyone who finds the URL: send
mail from the Gmail accounts, delete accounts, trigger send passes, read every
reply. `REMOTE-EXTRACTION.md` already carries the instinct — *"this port ONLY —
never the dashboard"*.

Second, structural: **sending must stay local.** Credentials live in `.env`
behind `credentialRef`, and `sendDealMessage` threads via stored RFC message-ids
and holds the thread in the local store. Every write has to reach the machine
that holds the data. This is also why the existing snapshot path cannot be
extended to carry it — it is one-way by construction.

---

## 4. Options considered

| | Reach | Auth | Code | Survives host offline |
|---|---|---|---|---|
| A. Tunnel the whole API + hosted SPA | whole app | must add | small | no |
| B. Cloudflare Tunnel + Access | whole app | edge SSO, no app code | ~none | no |
| C. Scoped deals API + hosted SPA | deals only | Firebase ID token | small | no |
| D. Firestore mirror + command outbox | deals only | Firebase Auth + rules | large | **yes** |

**D was ruled out on a direct answer to "how often will the host be asleep when
the remote admin needs to reply?" — *"they can wait, there's no urge."*** Its
only unique property is offline queueing, and it costs the most code by far. It
also runs into Firestore's 1 MiB document limit: the deal timeline carries full
`Reply` objects **including base64 attachments**, which is merely a large
response over HTTP but a hard wall in Firestore.

**B was superseded** once the host moves to a VPS (§6) — its value was a stable
hostname and edge identity for a machine behind NAT, and neither problem exists
on a VPS with a real domain.

---

## 5. Decision: Firebase Auth (Google) on the API

Verify a Google ID token on every API request, against an **email allowlist**.

Nearly free here, because the pieces exist:

- **`firebase-admin` is already a direct dependency**, already initialized with a
  service-account cert (`services/publisher.ts:156`). `getAuth(app).verifyIdToken()`
  reuses the same credential — no new dep, no new secret.
- **The client half exists**: `web/src/viewer/firebase.ts` already does Google
  sign-in and `onAuthStateChanged` for the viewer build. The admin build imports
  it and adds one call, `user.getIdToken()`.
- **The predicate exists**: `firestore.rules`'s `allowed()` is
  `auth != null && email_verified && email.lower() in viewers()`. The server-side
  check is the same three conditions in TypeScript — one rule, two runtimes.

### Allowlist now, custom claims later (or never)

| | Allowlist (`ADMIN_EMAILS`) | Custom claims |
|---|---|---|
| Grant | edit `.env`, restart | user must sign in first, then run `setCustomUserClaims` |
| Takes effect | immediately | on token refresh — **up to 1 h** unless the client forces `getIdToken(true)` |
| Roles | one | `admin` vs `dealsOnly` etc. |
| Rules files | still hardcode emails | rules read `request.auth.token.admin` — single source of truth |

Claims buy one real thing: `storage.rules` and `firestore.rules` could stop
hardcoding emails. Until a second role is needed, the cheaper answer to that is
keeping the list in one file and templating the rules at deploy time.

### Three things that will bite

1. **SSE breaks under bearer auth.** `web/src/hooks/useStream.ts:11` uses the
   native `EventSource`, which cannot set headers — live updates would silently
   stop. Do **not** use a query-param token (it lands in proxy and tunnel logs).
   The fix already exists in the codebase: `api.ts:172 runPass()` does `fetch`
   plus manual SSE frame parsing over `res.body.getReader()`. Convert `useStream`
   to that, plus a reconnect loop.
2. **Preflight rejects the header.** `app.ts:266` sends
   `Access-Control-Allow-Headers: Content-Type` only. One word to add. Stay on
   bearer rather than cookies: `Allow-Origin: *` is incompatible with
   credentialed requests, so cookies would force echoing a specific origin.
3. **Don't lock out the local console.** `app.ts` serves the operator UI too.
   Unconditional auth means localhost needs Google sign-in and `pnpm web:dev`'s
   proxy breaks. Gate it the way `publishEnabled()` gates publishing — required
   only when `ADMIN_EMAILS` is configured — and/or exempt loopback.

Smaller notes: call `getIdToken()` per request rather than caching at sign-in
(tokens last 1 h; the SDK refreshes transparently), and use `verifyIdToken(token)`
**without** `checkRevoked: true`, which costs a network round-trip per request.

### Authentication is not authorization

A signed-in admin still reaches `DELETE /api/accounts/:id` and
`POST /api/run/send`. Scoping the remote admin to deals needs a second, separate
decision: a per-route allowlist (`requireAdmin` vs a deals-only route list), or
the separate-port approach of option C. Trivial once verification exists, but
worth deciding deliberately rather than discovering later.

---

## 6. Decision: move the host to a VPS

With auth on the API and no urgency requirement, a permanently-reachable host
beats tunnelling a laptop. It removes ngrok, URL churn and "is the Mac awake"
in one move.

### What moves without complaint

Store (PouchDB + `leveldown`; `leveldown` is already in `onlyBuiltDependencies`,
so it builds on Linux), both email transports, the snapshot publisher, the lock,
Node 26 / pnpm 11. **The OAuth flow is already reverse-proxy aware** —
`oauthRedirectUri()` (`app.ts:149`) builds the callback from the `Host` header
and honours `x-forwarded-proto`, so behind TLS it emits the right
`https://<domain>/api/oauth/callback`. Add that URI to the Google OAuth client.

### The one real blocker, and its answer

The LLM provider is a CLI bound to a logged-in desktop subscription:
`adapters/llm/claude-code.provider.ts` shells out to `claude` in print mode and
deliberately strips `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` from the child env
so it cannot silently fall back to per-token billing. `antigravity.provider.ts`
is the Google-side twin.

**Answer: swap the roles of the machinery that already exists.** The hub/worker
protocol is **pull-based** — the worker calls `POST /work/claim` (long-poll),
`/heartbeat`, `/result`, `/error`, and never listens on anything. ngrok appears
in `REMOTE-EXTRACTION.md` only because today the *hub* is the NAT'd side. On a
VPS the hub is already publicly reachable, the Mac dials out, and **ngrok
disappears from the picture entirely**.

The worker needs nothing but the model — `scripts/remote-worker.ts` imports only
`loadConfig`, `buildLlm`, `extractReplyCore`, `Extractor`. No store, no mailbox,
no data. The Mac keeps the subscription and holds nothing.

### `remote:hub` is NOT a drop-in for `pnpm serve`

Diffed against `serve.ts`:

| | `serve.ts` | `remote:hub` |
|---|---|---|
| Dashboard + SSE | yes | yes (`--ui-port`) |
| Manual Run now | yes | yes, under the shared write lock |
| Gmail OAuth routes | yes | yes |
| `runReconcile` at boot | **yes** | **no** |
| **DripScheduler** (autonomous paced sending) | **yes** | **no** |
| **SnapshotPublisher** | **yes** | **no** |
| Extraction work queue | no | yes |

Run `remote:hub` as the VPS server and **nothing sends on its own**. They are
mutually exclusive today only because both are writers and the store is
single-process.

**The fix is small.** `createRemoteHub(deps, opts)` already accepts a
`writeLock: Mutex` (`server/remote-hub.ts:98`), and `serve.ts` already has
exactly that mutex as `passLock`. The two designs agree on the concurrency model
completely — nobody wired them together because the hub was conceived as an
*alternative* to serving, for a batch re-extract, not a companion to a
long-running server. Mount the hub's worker server inside `serve.ts` behind a
config flag, sharing `passLock`.

Two hub defaults that are right for a campaign and wrong for a server:
`--max-failed` defaults to **1** (the hub stops handing out work after a single
failed reply), and `--until-empty` exits when the queue drains. Also set
`REMOTE_TOKEN` in `.env` so it stays stable across restarts.

---

## 7. Work items, in order

1. ~~**`serve.ts` + hub integration**~~ — **done.** The hub is mounted in
   `serve.ts` sharing `passLock`, on by default (`REMOTE_HUB=off` disables). It
   needs `REMOTE_TOKEN`; unlike the CLI it will not invent one, since a token
   that changed every restart would lock the worker out silently.
   `REMOTE_MAX_FAILED` defaults to 10 rather than the CLI's 1 — see §9.
2. ~~**`data:dump` / `data:load` scripts**~~ — **done**, and exercised against
   the real store: 7,878 docs round-tripped byte-identical. `data:load` verifies
   against the dump manifest and exits non-zero on a mismatch.
3. ~~**VPS migration**~~ — **written up** in [VPS-DEPLOY.md](./VPS-DEPLOY.md),
   with `deploy/adscout.service` and `deploy/Caddyfile`. Not yet executed.
4. ~~**ID-token verification**~~ — **done**: `src/server/auth.ts`, gated on
   `ADMIN_EMAILS`. Verification needs only a project id, so it does **not**
   require `firebase-service-account.json`. No loopback exemption, deliberately:
   behind a reverse proxy every request arrives from 127.0.0.1, so that
   convenience would disable auth for the whole internet.
5. ~~**`Access-Control-Allow-Headers`**~~ — **done.**
6. ~~**`useStream` → fetch-based SSE**~~ — **done**, with a jittered-backoff
   reconnect loop replacing EventSource's built-in one.
7. ~~**`api.ts`: configurable base URL + token injection**~~ — **done**, as
   `web/src/apiBase.ts` (`VITE_API_ORIGIN` + a token *provider*, not a cached
   token, since ID tokens expire hourly).
8. ~~**Route scoping**~~ — **done**, as two roles rather than a deals-only port.
   `ADMIN_EMAILS` is the operator; `MANAGER_EMAILS` is viewer + deal manager —
   reads everything and runs the negotiation, but cannot import, touch mailboxes
   or start a send pass. `mayAccess()` is default-deny for managers so a route
   added later is not silently reachable. The console hides what a manager
   cannot use, but that is cosmetic — the server is the boundary.
9. ~~**`VITE_TARGET=admin` build**~~ — **superseded, and not needed.** The
   public `GET /api/auth` tells the front end whether sign-in is required, so
   ONE build serves both the open laptop console and the gated VPS. Firebase is
   loaded by dynamic import only when it is, which costs the local bundle 2.7 KB
   instead of 140 KB. No second hosting target, no third Vite target.

---

## 8. Migration notes

### What travels in `data/pouch`

Everything in the store, including two that might be expected to break and do
not: **`Account.oauthTokens.refreshToken`** (bound to the OAuth client, not the
machine — `gmail-api` accounts stay connected) and **`Account.pollCursor`**
(IMAP `lastUid` / Gmail `historyId` are mailbox-scoped, so polling resumes where
it stopped rather than re-ingesting months of mail). Attachments travel too —
they are base64 inside the `Reply` doc, so there is no separate blob store.

### What is not in `data/` and must be copied separately

Per `.gitignore`: **`.env`** (the important one — accounts reference credentials
by env var *name* via `credentialRef`, so without it every account appears in the
UI, looks healthy, and cannot send), `firebase-service-account.json`,
`client_secret.json`, `web/.env.local`. Rebuild `web/dist` on the host.

**Do not copy `data/agent.lock`.** It is PID-based with a liveness check
(`lib/lock.ts:29`); a stale Mac PID colliding with a live Linux PID gives
`agent already running (pid N)` with nothing actually running.

### Prefer dump/load over zipping LevelDB

Two hazards, only one about architecture: copying the directory **while the
process runs** captures the write-ahead log mid-write; and arm64 → x86-64 is fine
in practice (same endianness, same pinned `leveldown`) but LevelDB offers no
formal cross-platform guarantee — and the failure surfaces after live mailboxes
are already pointed at the new box.

Every doc type in the `Store` port has both a `list*` and a `put*`/`add*`, so a
dump-to-JSON / load-from-JSON pair is ~60 lines, format-agnostic, and
**verifiable** — compare per-type doc counts before cutting over. Two
asymmetries to handle: `putPromptSnapshot` returns void, and suppressions use
`addSuppression`.

### Two gotchas with real consequences

- **`TZ` on the VPS.** The send window and the daily quota reset are entirely
  local-clock — `scheduler/window.ts:36` (`getHours()`), `domain/limits.ts:19`
  (`setHours(0,0,0,0)`), `domain/account-state.ts:51`. A box defaulting to UTC
  silently shifts sending hours and the quota boundary. One line in the systemd
  unit; weeks of wrong-hour sending if missed.
- **The Gmail sending IP changes.** Accounts warmed on a residential IP move to a
  datacenter IP and geography at once. Expect sign-in challenges, and understand
  this touches deliverability — the thing the warmup ramp exists to protect.
  Move **one** account first and watch its per-account bounce rate (Accounts tab
  → Results) before migrating the rest. `gmail-api` over OAuth travels better
  here than an app password over SMTP. This is the only step that cannot be
  undone by editing a config file.

---

## 9. Open questions

- **Route scoping shape** — per-route allowlist inside `app.ts`, or a separate
  deals-only port as `remote-hub.ts` does it? (Item 7.8.)
- **One list or three?** The admin allowlist would be a third copy of the emails
  already in `storage.rules` and `firestore.rules`. Template at deploy, or accept
  the drift, or go to custom claims.
- **VPS provider, region and TZ** — region should follow the target market's
  business hours, since the send window is local-clock.
