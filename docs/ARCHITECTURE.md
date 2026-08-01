# AdScout — Architecture & Code Guide

How the codebase is organized, the logic in each layer, and the reasoning behind
the structure. For how to *run* the app, see [`USAGE.md`](./USAGE.md). For the
original design document (with worked examples and decision log), see
[`../overview.md`](../overview.md) — section numbers like “§8” below refer to it.

---

## 1. Design principles

AdScout is built around a few deliberate choices that explain almost every file:

1. **Ports & adapters (hexagonal).** All I/O — email, LLM, storage — sits behind
   a small interface (a *port*). Concrete *adapters* implement each port. The
   pipeline depends only on ports, so providers are swappable and the core is
   testable without any network.
2. **Pure domain core.** The hard logic (warmup ramps, limit math, reply
   matching, bounce detection, extraction parsing, health rules, drip pacing)
   lives in `src/domain/` and `src/scheduler/window.ts` as **pure functions** —
   no I/O, no timers, no randomness — so it's exhaustively unit-tested.
3. **Lazy adapters / zero required dependencies.** Real adapters (`nodemailer`,
   `imapflow`, `pouchdb`, `@anthropic-ai/sdk`) are loaded with **dynamic
   `import()` inside methods**, so the project builds, type-checks, and runs its
   whole test suite with *no external packages installed*. You install a package
   only to activate that one adapter.
4. **Append-only log + derived statistics.** Send attempts are an append-only
   `Outreach` log. Daily counts, quotas, and health are **derived** from it on
   demand — never stored as mutable counters — so a crash or restart can't
   corrupt them (§7).
5. **Restart safety by construction.** Reserve-before-send + idempotency keys +
   a startup reconcile pass mean “started three times today” and “crashed
   mid-send” can't double-send or lose threading (§8).
6. **Determinism via seams.** Time (`Clock`), timers (`Timers`), and randomness
   (`random()`) are injected, so scheduling and pipeline logic are tested with
   fixed inputs.

---

## 2. Repository layout

```
.
├── pnpm-workspace.yaml     # pnpm workspace root (packages: root + web)
├── pnpm-lock.yaml          # single lockfile for the whole workspace
├── package.json            # server package (name: adscout) — runs via tsx, no build
├── tsconfig.json           # includes src + scripts
├── overview.md             # design document
├── docs/                   # ← you are here (USAGE.md, ARCHITECTURE.md, VIEWER.md)
├── firebase.json           # shared read-only viewer: hosting + rules (docs/VIEWER.md)
├── storage.rules           #   who may READ the published snapshot (the allowlist)
├── firestore.rules         #   each viewer's own niche settings, private per account
├── web/                    # SEPARATE front-end package (name: adscout-web)
│   ├── package.json        #   Vite + React + Chakra UI, own deps & build
│   └── src/                #   built to web/dist, served by the server
└── src/
    ├── config.ts           # env → typed Config (the only place env is read)
    ├── index.ts            # `demo` entry: full in-memory cycle
    ├── serve.ts            # real boot: lock → reconcile → HTTP/SSE → scheduler
    ├── domain/             # PURE core: types + business logic (+ unit tests)
    ├── ports/              # interfaces: EmailProvider, LlmProvider, Store
    ├── adapters/           # concrete impls of the ports
    │   ├── email/          #   dummy · smtp-imap
    │   ├── llm/            #   dummy · ollama · openai · claude
    │   └── store/          #   memory · pouchdb
    ├── services/           # pure orchestration helpers (drafter, extractor, …)
    ├── pipeline/           # the passes: reconcile · send · poll · quota
    ├── scheduler/          # drip scheduler (impure) + window math (pure)
    ├── server/             # node:http JSON API + SSE + static serving
    └── lib/                # factory, lock, ids, clock, logger
```

A dependency rule holds top to bottom: **`domain` depends on nothing**;
`services`/`pipeline` depend on `domain` + `ports`; `adapters` implement
`ports`; `lib/factory` is the *only* place that names concrete adapters;
`server`/`serve`/`index` wire it all together.

---

## 3. The domain core (`src/domain/`)

Pure, dependency-free, and the most heavily tested code in the project.

### `types.ts`
The shared vocabulary: `Campaign`, `Account`, `Target`, `Outreach`, `Reply`,
`Suppression`, `OutreachResult`, and the enums (`AccountStatus`, `TargetStatus`,
`SendStatus`, `MatchMethod`, …). These are app-level conventions; the
schemaless store does not enforce them.

### `warmup.ts`
`warmupRamp(ageDays)` — a new account's daily allowance climbs with age:
`base 5, +5 every 3 days, cap 40` (`DEFAULT_WARMUP`). `ageDays(createdAt, now)`
is the whole-days helper.

### `limits.ts`
Limit math derived from the `Outreach` log:
- `sentInLast24h` — counts `reserved` + `sent` in the rolling 24h window (a
  held reservation still occupies the cap).
- `currentLimit` = `min(dailyLimitOverride ?? warmupRamp(age), maxDailyLimit)`.
- `remainingToday` = `currentLimit − sentInLast24h` (≥ 0).
- `canSend` = account is `active` **and** `remainingToday > 0`.

### `reply-matching.ts`
- `matchReply(incoming, sentOutreaches, awaiting)` resolves an inbound message to
  a target in priority order: **native `threadId`** → **exact `fromAddress`** (of
  targets we're awaiting) → **`unmatched`**. We never parse `Re:`/`References` —
  the mail server already computed threading (§4, “the hard-won lesson”).
- `detectBounce(from, text)` — heuristic DSN detection (mailer-daemon/postmaster
  senders or delivery-failure phrasing) that also recovers the failed recipient
  from common DSN markers.
- `normalizeEmail` — trim + lowercase (used everywhere addresses are compared or
  keyed).

### `extraction.ts`
The split that keeps the fragile part testable:
- `buildExtractionSchema(inquiryFields)` — builds a strict JSON Schema asking the
  LLM for `canPost`, `optOut`, `conditions`, `notes`, and a **verbatim `raw`**
  answer per field.
- `parseFieldValue(field, raw)` — deterministic typing of each raw string into a
  `FieldValue` (`price` with amount+currency, `list`, `enum`, `boolean`, `text`).
- `assembleResult(fields, raw)` — combines them into an `OutreachResult`,
  tolerant of missing answers. **The LLM does NLP only; this code does the
  parsing**, so prices/lists/enums are unit-tested rather than model-dependent.

### `health.ts`
`evaluateHealth(input)` → `none | pause | cooldown`: auth/security error ⇒ pause
immediately; bounce rate over `bounceRateThreshold` (default 10%) with at least
`minSamples` (default 10) ⇒ cooldown. **Implemented and unit-tested, but not yet
invoked by the pipeline** (a planned wiring step).

---

## 4. Ports (`src/ports/`)

Three small interfaces define every external boundary.

### `EmailProvider`
```
send(OutgoingEmail): SendResult            // we set our own rfcMessageId
fetchReplies(account, since?): IncomingEmail[]
resolveThreadId(account, rfcMessageId): string | undefined   // exact self-lookup
readonly supportsThreadId: boolean
```
Crucially, the provider surfaces `threadId` and a stable `emailId` in a
normalized way; reply-matching lives in the domain, not here. `send` returns no
thread id for SMTP, so the pipeline resolves it afterward via `resolveThreadId`
(an exact lookup of our self-set Message-Id in *All Mail*).

### `LlmProvider`
```
generateJson(LlmJsonRequest): unknown   // returns an object conforming to schema
generateText(LlmTextRequest): string
```
Used for reply extraction (`generateJson` with the extraction schema). Drafting
does not use it.

### `Store`
A thin, schemaless CRUD layer over the entities, plus a **change feed**:
`subscribe(listener)` emits `{ type, action, id }` on every write/delete. The
agent is the sole writer, so emitting from the store wrapper makes the live feed
backend-agnostic. Includes `deleteAccount` / `deleteTarget` for the UI.

---

## 5. Adapters (`src/adapters/`)

Each adapter implements one port. Real ones lazy-load their package.

| Port | Adapter | Notes |
|---|---|---|
| Email | `dummy` | No network; deterministic thread ids; `injectReply()` for tests/demo. |
| Email | `smtp-imap` | **Real Gmail (app password) + any IMAP/SMTP.** nodemailer (send) + imapflow (read). Reads Gmail's `X-GM-THRID` → `threadId` and `emailId`. Credentials from `<credentialRef>_USER/_PASS` (+ optional host/port overrides). |
| LLM | `dummy` | Synthesizes a schema-valid object from the JSON Schema itself — the whole pipeline runs offline. |
| LLM | `ollama` | `fetch` → `POST {baseUrl}/api/chat` with native `format` (schema) structured output. No dependency. |
| LLM | `openai` | `fetch` → `POST {baseUrl}/v1/chat/completions` with `response_format: json_schema` (strict). Bearer auth. No dependency. |
| LLM | `claude` | Official `@anthropic-ai/sdk` (lazy), structured JSON via `output_config.format`. |
| Store | `memory` | `Map`-backed, `structuredClone` on read/write; default for tests/demo. |
| Store | `pouchdb` | On-disk PouchDB (lazy); docs keyed `"<type>:<id>"`. Same change-event semantics. |

> **Credential handling:** `Account.credentialRef` is the **name** of the env var
> holding the secret; the secret is never persisted on the entity. The
> `smtp-imap` adapter resolves `${ref}_USER` / `${ref}_PASS` at send/poll time.

---

## 6. Services (`src/services/`)

Pure orchestration helpers between the domain and the pipeline.

- **`drafter.ts`** — `draftEmail(campaign, account, target)` renders the subject
  and body deterministically from the sender identity, advertised product,
  topic/format, the campaign's inquiry questions, an optional per-target note,
  and a signature. No LLM, fully testable.
- **`extractor.ts`** — `Extractor.extract(campaign, replyText)` builds the
  extraction schema + prompt, calls `llm.generateJson`, and hands the raw result
  to `assembleResult`. The only place the LLM is invoked.
- **`account-selector.ts`** — `assignRoundRobin(items, capacities)` distributes
  work items across accounts that still have quota, skipping exhausted ones.
  Leftover items are dropped and picked up next pass.
- **`read-models.ts`** — the denormalized payloads the UI reads (domain rows,
  domain detail, response rows, one extraction explained). Assembled here rather
  than in the HTTP handlers because there are two readers: the local console
  over HTTP, and the published snapshot. A join written twice drifts.
- **`snapshot.ts`** — builds the flat JSON file set the shared viewer reads, off
  the read models. Deliberately strips OUR niche-sensitivity calls: the viewer's
  owner classifies niches himself. See docs/VIEWER.md.
- **`publisher.ts`** — uploads that snapshot to Cloud Storage, one-way, diffing
  against the remote hash index so only changed files move. Driven by the store's
  change feed and debounced; a failure logs and never touches the pipeline.

---

## 7. The pipeline (`src/pipeline/`)

Three passes plus a quota helper. All take their dependencies (store, providers,
clock, config) explicitly — no globals — so each is unit-testable with dummies
and a fixed clock.

### `send-pass.ts` — `runSendPass(deps, opts?)`
Sequential; no mutex (passes don't overlap). Steps:
1. Take **active** accounts; compute each one's remaining quota (optionally
   capped to `maxPerAccount`, which the drip scheduler sets to **1**).
2. Build the work queue: **follow-ups due first** (target is `contacted`, under
   the policy's `maxFollowUps`, and `afterDays` elapsed), then **pending**
   initial sends. Suppressed contacts are skipped.
3. `assignRoundRobin` across accounts with capacity.
4. For each assignment, `sendOne`:
   - **Idempotency guard** — skip if a `reserved`/`sent` outreach already exists
     for this `(target, kind, sequenceNo)`.
   - Draft locally → write a `reserved` `Outreach` (consumes the slot) → (initial
     sends move the target to `reserved`).
   - **Network send** (outside any lock). On success: mark `sent`, resolve and
     store `threadId`, advance the target (`contacted` for initial; bump
     `followUpCount` for follow-ups). On failure: mark the outreach `failed` and
     revert an initial target to `pending` for a later retry.

Returns a `{ reserved, sent, failed, skipped }` report.

### `poll-pass.ts` — `runPollPass(deps)`
1. Precompute matching refs once: sent outreaches that carry a `threadId`, and
   targets we're `awaiting` (`contacted`/`reserved`).
2. For each non-`paused` account, `fetchReplies(account, since=lastPolledAt)`,
   then advance that account's poll cursor.
3. Per message: **dedupe** on `emailId` → **bounce?** (suppress the failed
   recipient + mark its target `bounced`) → **match** (threadId → fromAddress →
   unmatched) → store the `Reply`.
4. If matched, **extract** via the LLM and roll up onto the target: `optOut` ⇒
   target `excluded` + suppression; otherwise target `replied` with the parsed
   `OutreachResult`. Extraction failures are recorded, not fatal.

Returns `{ fetched, deduped, bounced, matched, unmatched, extracted, extractionFailed }`.

### `reconcile.ts` — `runReconcile(deps)`
Runs at startup. For each in-flight outreach:
- `reserved` older than `reconcileGraceMs` → exact All-Mail lookup. Found ⇒
  `sent` (+ recovered thread id); not found ⇒ `needs_review` (and the target if
  still `reserved`). **Never auto-resends.**
- `sent` without a `threadId` → retry the lookup and backfill it.

### `quota.ts` — `totalRemainingToday(store, config, now)`
Sum of `remainingToday` across active accounts. The scheduler uses it to pace
the drip.

---

## 8. The scheduler (`src/scheduler/`)

### `window.ts` (pure)
Send-window + drip math, all pure and tested:
- `isWithinSendWindow`, `msUntilWindowClose`, `nextWindowOpen`.
- `dripBaseDelayMs(remaining, msLeft)` — spread remaining quota across the window
  (clamped to `[minMs, maxMs]`).
- `applyJitter(base, frac, rnd)` — ±fraction jitter from an injected random.
- `planSendTick(now, remaining, window, cfg, rnd)` → a `SendPlan`:
  `send` (with a jittered delay), `idle_window_closed` (sleep until open), or
  `idle_no_quota`.

### `scheduler.ts` (impure, but seam-driven)
`DripScheduler` runs two self-rescheduling loops on injectable `Timers`:
- **send loop** — each tick computes a plan from `planSendTick`; if `send`, runs
  one drip send (`runSend` capped to 1/account) then reschedules after the
  plan's delay.
- **poll loop** — fixed cadence (default 60s), independent of the send loop.

`Clock`, `Timers`, and `random()` are all injected, so the loops are tested
deterministically. `realTimers` `unref()`s its handles so they don't keep the
process alive.

---

## 9. Server (`src/server/app.ts`)

A dependency-free `node:http` server with three responsibilities:

1. **JSON API** mirroring the Store port — status, campaigns (list/create),
   accounts (list/create/patch/pause/resume/delete), targets
   (list/create/delete), responses (replies enriched with target website +
   parsed result), suppressions, and manual `run/send` · `run/poll`. Input is
   validated (e.g. required fields, known `campaignId`); new accounts get a
   derived `credentialRef` and `gmail-api`/`warming` defaults; ids and timestamps
   come from `newId` and the injected `clock`.
2. **SSE change feed** at `/api/stream` — subscribes to the store's change events
   and streams them to the browser (with a heartbeat). The subscription is
   registered *before* the `: connected` line so no event is missed.
3. **Static serving** of the built front-end (`web/dist`), with path-traversal
   protection.

The server is constructed with explicit deps (`ServerDeps`) — store, config,
clock, `runSend`/`runPoll` callbacks, `webDir`, provider names — which is what
makes `app.test.ts` able to spin it up against a memory store and a fixture web
dir.

---

## 10. Front-end (`web/`)

A **separate module** (own `package.json`, dependency tree, and build) so the UI
and server evolve independently.

- **Stack:** Vite + React 19 + **Chakra UI v3** (light theme via `createSystem`
  in `src/theme.ts` — an indigo `brand` palette on a gray canvas with white
  panels).
- **`src/api.ts`** — typed client over the JSON API (relative `/api`).
- **`src/api.snapshot.ts` + `src/viewer/`** — the SECOND build of this same UI:
  the shared read-only viewer, which reads a published snapshot from Firebase
  instead of a server. `VITE_TARGET=viewer` makes a resolver plugin swap
  `api.ts` for `api.snapshot.ts`, so the views, the modals and the export
  pipeline are shared code rather than a second implementation; components take
  a `readOnly` prop that hides everything that writes. See docs/VIEWER.md.
- **`src/hooks/useStream.ts`** — subscribes to `/api/stream`; debounced
  `onChange` drives a `tick` counter that re-fetches the active view; reports
  `connecting`/`live`/`reconnecting`.
- **`src/App.tsx`** — header (brand mark + provider chips + live pill), a
  `StatCards` overview strip, and the five tabs (with count badges).
- **`src/components/`** — one component per view (`AccountsView`, `TargetsView`,
  `ResponsesView`, `SuppressionsView`, `RunView`), the add-forms
  (`AddAccountForm`, `AddTargetForm`), and shared UX primitives: `Toaster`
  (action feedback), `Confirm` (`useConfirm` styled dialog replacing
  `window.confirm`), `Panel`/`Empty`/`StatCards`, a local `icons` set (inline
  SVG, no dependency), and a `StatusBadge` palette map.
- **`src/types.ts`** — a deliberately small client mirror of the server domain
  types (only the fields the UI reads/writes).

**Dev vs prod:** in dev, `pnpm web:dev` runs Vite on `:5173` and proxies
`/api` (REST + SSE) to the server on `:8787`. For deployment, `vite build`
emits `web/dist`, which `serve.ts` serves from one origin.

---

## 11. Configuration & wiring

- **`config.ts`** is the single place environment variables are read, producing
  a typed `Config` (providers, store, dirs, send window, grace period, and the
  warmup/health defaults). Everything else receives `Config`, not `process.env`.
- **`lib/factory.ts`** is the only module that imports concrete adapters.
  `buildStore` / `buildEmail` / `buildLlm` switch on `Config`, and `buildAgent`
  assembles `{ store, email, llm, extractor }`. Swapping a provider is a one-line
  change here driven by config.
- **`lib/`** also holds the `Clock` seam, the PID-file `lock`, id/Message-Id
  generators (`ids.ts`), and a minimal structured `logger`.

### Boot sequence (`serve.ts`)
```
loadConfig → acquireLock → buildAgent → runReconcile
           → createApiServer(... runSend/runPoll ...) → listen
           → DripScheduler.start()      (SIGINT/SIGTERM → stop, close, release lock)
```
`index.ts` is the alternate entry: it seeds data and runs one reconcile → send →
(injected reply) → poll cycle in-memory for the `demo`.

---

## 12. Concurrency, idempotency & failure model

- **One writer, no overlap.** A single process (guarded by the lock) runs passes
  sequentially, so there's no in-process locking to reason about.
- **Reserve-before-send.** The `reserved` outreach is written *before* the
  network call; the idempotency guard keys on `(target, kind, sequenceNo)`, so
  repeated passes/restarts can't duplicate a send.
- **Thread id resolved post-send.** SMTP can't return it, so it's looked up by
  our self-set Message-Id — the same mechanism reconcile uses to recover from
  crashes.
- **Derived, not stored.** Counts/quota/health are recomputed from the log, so
  no counter can drift.
- **Graceful network failure.** Send failures revert initial targets to
  `pending`; `fetchReplies`/`resolveThreadId` failures are logged and skipped,
  never crashing a pass.

---

## 13. Testing strategy

- **Unit tests** blanket the pure domain (warmup, limits, health, reply-matching,
  extraction) and the window math — exact inputs, exact outputs.
- **Pipeline tests** (`pipeline.test.ts`) run full send→poll→extract cycles on
  the memory store + dummy providers with a fixed clock.
- **Scheduler tests** drive the loops with injected timers/random to assert the
  plan and rescheduling without real time passing.
- **Server tests** (`app.test.ts`) start the real `node:http` server against a
  memory store and a static **fixture** dir (kept independent of the real `web/`
  module), covering every route, SSE delivery, and path-traversal protection.
- **Provider credential wiring** is unit-tested for the Gmail app-password path
  (`smtp-imap.provider.test.ts`), with zero external packages.

Run `pnpm test` (≈60 tests) — it passes with **no external packages installed**,
which is the whole point of the lazy-adapter boundary.

---

## 14. Extending the system

- **Add an email/LLM/store provider:** implement the port in `src/adapters/...`
  (lazy-load any package), add a case in `lib/factory.ts`, and a value in the
  corresponding `config.ts` enum. Nothing else changes.
- **Use several mailboxes today:** already supported — add multiple `active`
  accounts; the single provider resolves per-account credentials by
  `credentialRef`, and the send pass round-robins across them.
- **Mix transport *types* per account:** add a routing `EmailProvider` that
  dispatches by `account.providerType` (every port method already receives the
  account) and return it from `buildEmail`. `supportsThreadId` would need to
  become account-aware.
- **Add an API endpoint:** extend `server/app.ts` (mirror the Store port) and the
  client in `web/src/api.ts`.
- **Auto-apply health:** call `evaluateHealth` after each pass with windowed
  sent/bounced counts derived from the log, and persist the resulting status.

---

## 15. Where to look first

| You want to… | Start in |
|---|---|
| Understand an entity or status | `src/domain/types.ts` |
| Change how emails are written | `src/services/drafter.ts` |
| Change how replies are parsed | `src/domain/extraction.ts` + `src/services/extractor.ts` |
| Change sending limits / warmup | `src/domain/warmup.ts` + `limits.ts` |
| Change pacing / send window | `src/scheduler/window.ts` |
| Add/modify an API route | `src/server/app.ts` |
| Swap or add a provider | `src/lib/factory.ts` + `src/adapters/…` |
| Trace the running app | `src/serve.ts` → reconcile → server → scheduler |
| See the UI data flow | `web/src/App.tsx` + `api.ts` + `hooks/useStream.ts` |
