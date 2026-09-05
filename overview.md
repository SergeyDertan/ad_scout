# AdScout — Design Document

A local AI agent that does outreach to website admins (asking whether they'll publish
an ad/article and at what price), monitors replies, and extracts structured results.
Runs on-demand on a MacBook Pro M1 Max (32GB), with a small local web UI.

---

## 0. Decisions locked (2026-06-19)

These supersede any older phrasing below; the rest of the doc has been updated to match.

| # | Decision | Choice |
|---|---|---|
| Daily cap | Per-account outbound limit | **40/day per account** (all outbound: initial + follow-up). Inbound replies never count. Warmup ramp climbs to 40. |
| Secrets | Where credentials live | **`.env` (gitignored)**, referenced by `credentialRef` = env-var name. Keychain later, one-adapter swap. |
| Compliance | Legal footer / unsubscribe | **Deferred.** Low-volume 1:1 B2B inquiry. Only safeguard kept: a **persistent suppression list** (opt-outs/bounces survive CSV re-imports). Revisit if volume grows or EU targets dominate. |
| Concurrency | Parallel passes | **None.** Single instance, sequential manual/scheduled passes. No in-process write mutex needed; reserve-before-send + idempotency still guard crash/restart. |
| Storage | DB | **PouchDB** (schemaless JSON docs) behind the `Store` port. Live UI updates emitted from the **Store layer** (app-level events → SSE), not the DB's native feed, so it's backend-agnostic. ⚠️ PouchDB's Node `leveldb` adapter is flagged deprecated — pin versions. |
| LLM | Provider / model | **Ollama deferred — not installed yet.** LLM sits behind `LlmProvider` with a **stub adapter** so the pipeline runs end-to-end now. Real `OllamaProvider` + model added later. Candidate model tag: **`gemma4:26b-mlx`** (MLX build, good for M1 Max) — confirm at install. |
| Drafting | How emails are written | **Deterministic template** (no LLM for the body). Optional single LLM-generated personalization line from `Target.notes` is a *later* enhancement behind the same port. |
| Follow-ups | No-reply "bump" | **Designed now, built later.** Separate cadence (`afterDays`, `maxFollowUps`); follow-ups draw from the same 40/day account cap and are prioritized ahead of new initials. |
| Selector | Account → target assignment | Round-robin across `active` accounts; skip any at its daily limit; a failed send retries on the **same** account up to N times before the target returns to `pending`. |
| Pacing | Send distribution | **Jittered drip within a daily send window** (configurable hours/timezone), not a burst. Manual "Run now" still respects `remainingToday` + pacing. |

---

## 1. Goal & scope

- Take a list of target websites (URL + contact email) under a **campaign** (what's being advertised).
- For each target, generate a **personalized** outreach email and send it from one of several sending accounts.
- Watch the inbox; when a reply arrives, **match it** to the original outreach, **extract** structured fields (can they post? price? placement?), and store both the raw reply and the parsed result.
- Send **follow-ups** when a target doesn't reply within the campaign's cadence.
- Be safe to start manually multiple times a day without double-sending or exceeding per-account limits.

**Personalization is for relevance, not spam evasion.** Deliverability is governed mostly by sender
reputation, authentication (SPF/DKIM/DMARC), volume ramp, and recipient engagement — not by how
"unique" each email looks. Keep volume low, lists clean, and accounts warmed.

---

## 2. Core principles

1. **Swap seams via ports/adapters.** Email provider, storage, and LLM each sit behind an interface. Only one wiring file knows the concrete implementation.
2. **Pure domain core.** Warmup ramp, limit checks, health rules, and reply-matching are pure functions with no I/O — fully unit-testable without Gmail/Ollama/DB.
3. **Events, not counters.** Every send and reply is an append-only log row. All statistics are *derived by query*, so a mid-run restart can't corrupt a counter.
4. **Safe by construction, not by luck.** Single-instance lock + reserve-before-send + idempotency keys make "started 3× a day" a non-event. (No mutex needed — passes are sequential.)
5. **Lean on the server's thread id.** Never reconstruct threading from `Re:`/`References` headers. Use Gmail's native thread id (normalized by imapflow), with an exact `fromAddress` fallback only for orphans.
6. **Ask == extract.** The campaign's inquiry fields drive *both* the email questions and the reply-extraction schema — one source of truth.

---

## 3. Tech stack

| Concern | Choice | Notes |
|---|---|---|
| Language/runtime | TypeScript on Node 26+, run via `tsx` | No Python. ESM. |
| Local LLM | **Ollama** + `ollama` npm | **Deferred — not installed yet.** Behind `LlmProvider`; a stub adapter runs until it's enabled. OpenAI-compatible endpoint also available. |
| Model | **`gemma4:26b-mlx`** *(candidate, unverified)* | MLX-optimized build for Apple Silicon; fits 32GB. Confirm the exact tag at install. Thinking OFF + JSON mode for extraction (temp ~0.1). Drafting does **not** use the LLM. |
| Email (start) | `nodemailer` (SMTP) + `imapflow` (IMAP) | Personal Gmail via **app password** (requires 2FA). Generic over IMAP/SMTP providers. |
| Email (later) | `googleapis` (Gmail API, OAuth) | Required if moving to Workspace — app passwords don't work there anymore. |
| Storage | **PouchDB** (`pouchdb` + `pouchdb-find`) | Schemaless JSON docs (`_id`/`_rev`); TS types are app-level conventions. Mango queries for derived stats. ⚠️ Node `leveldb` adapter deprecated → pin versions. |
| Storage (later) | **SQLite** (`better-sqlite3`) | Alternative if PouchDB-on-Node bit-rots; same `Store` port. |
| Live UI feed | **SSE from the Store layer** | The agent is the sole writer, so the `Store` wrapper emits change events itself — no dependence on the DB's native changes feed. |
| Web UI | **Vite + React + TS**, served by the agent | Talks to a local API (`Fastify`/`Hono`) on the same process. |
| Scheduling | `node-cron` in-process | Drip scheduler within the daily send window. Wrap in `caffeinate -i`; Mac must be awake. `launchd` one-shot optional later. |
| Locking | `proper-lockfile` | Single-instance guard. |

> **Avoid gun.js** here — it's a distributed/eventually-consistent graph DB, the wrong tool for a single local stats-aggregating agent.

> Runtime deps (`pouchdb`, `nodemailer`, `imapflow`, `fastify`, `ollama`, …) are added **per adapter** as those layers are built, to keep early installs fast and native-build-free. The domain core and ports need none.

---

## 4. Email provider abstraction

A handful of methods cover the job. Reply-matching does **not** live in the provider — it uses
fields the provider surfaces in a normalized way.

```ts
interface EmailProvider {
  send(msg: OutgoingEmail): Promise<SendResult>;
  fetchReplies(account: Account, since?: Date): Promise<IncomingEmail[]>; // INBOX + Spam; never SENT
  fetchThread(account: Account, threadId: string): Promise<IncomingEmail[]>; // deals only; ours included
  resolveThreadId(account: Account, rfcMessageId: string): Promise<string | undefined>; // exact self-lookup in All Mail
  supportsThreadId: boolean; // Gmail (X-GM-THRID) / RFC 8474 OBJECTID THREADID → true
}
```

`fetchReplies` excludes our own sent mail so a pitch can never be read back as a publisher's
price. `fetchThread` is the one exception, and it is deliberately narrow: called only for threads
already under an **open deal**, by id, so a person answering from the Gmail app still appears in
the negotiation's timeline. See `pipeline/deal-thread-sync.ts`.

```ts
interface OutgoingEmail {
  to: string;
  subject: string;
  body: string;
  rfcMessageId: string;       // we set our own Message-Id for exact self-lookup
}

interface SendResult {
  rfcMessageId: string;
  threadId?: string;          // usually resolved post-send (SMTP returns none)
}

interface IncomingEmail {
  emailId: string;            // X-GM-MSGID / OBJECTID EMAILID — stable dedupe key
  threadId?: string;          // primary match key
  rfcMessageId: string;
  fromAddress: string;
  subject: string;
  receivedAt: ISO;
  text: string;
}
```

**First implementation:** `SmtpImapProvider` (nodemailer + imapflow) — works for personal Gmail and
any IMAP/SMTP host. `GmailApiProvider` (OAuth) comes later only for Workspace.

### Thread matching (the hard-won lesson)

- Gmail exposes a native **thread id** via the IMAP `X-GM-THRID` attribute (decimal; same value as the
  hex id in the web UI / Gmail API). The newer cross-provider standard is **OBJECTID (RFC 8474)** with
  `EMAILID` + `THREADID`.
- **imapflow normalizes both** into `message.threadId` and `message.emailId` — read them via
  `client.fetch(range, { threadId: true, envelope: true })`. You can also `client.search({ threadId })`.
- **Do not parse headers to guess threads.** It breaks on localized `Re:`, rewritten subjects, and
  stripped `References` — i.e. the messiest senders. The server already computed threading correctly.
- **Match order:** `threadId` first → exact `fromAddress` against recently-contacted-awaiting targets
  (mops up orphans Gmail itself couldn't thread) → else `unmatched`.
  - ⚠️ Real-world gap: a reply may arrive from a *different* address than the one we emailed
    (role inbox → personal reply). `threadId` covers most of these; the `fromAddress` fallback is best-effort.
- The only legitimate `Message-Id` use is the **exact self-lookup**: SMTP send returns no thread id, so
  we set our own `rfcMessageId`, then look up our just-sent copy in `[Gmail]/All Mail` to read its
  `threadId`. That's an exact self-match, not fuzzy reply matching.
- **Dedupe** inbound on `emailId`.

---

## 5. Warmup, limits & health

- **Volume ramp = the per-account daily limit, made to climb with account age:**
  ```
  currentLimit(account) =
    min(dailyLimitOverride ?? warmupRamp(ageDays), maxDailyLimit)
  // base 5, +5 every 3 days, cap 40  →  5 · 10 · 15 · 20 · 25 · 30 · 35 · 40
  ```
- **40/day is the per-account ceiling** (`maxDailyLimit`), covering **all outbound** (initial + follow-up).
  Inbound replies are free. A warmed mailbox at 40/day is well under the ~200/day practical throttle
  point and the ~500 personal-Gmail hard cap.
- **Pacing:** the day's quota is **dripped across a configurable send window** (e.g. 09:00–18:00 local)
  with randomized gaps — never bursted. Manual "Run now" still obeys `remainingToday` and spacing.
- **Engagement warmup** (a small pool of self-controlled mailboxes that reply / mark "not spam") is
  optional and higher-effort — add only if deliverability proves poor.
- **Bounce hygiene is the cheapest big win:** detect `mailer-daemon` failures (parse the DSN for the
  failed recipient), flag and **suppress** bad addresses, never re-send to them.
- **Health auto-pause:** bounce rate over window > threshold, or an auth/security send error
  (SMTP `535`, suspicious-activity rejection) → set account `paused`/`cooldown` + `lastError`.

---

## 6. Data model

Storage is **PouchDB**: every record is a JSON doc with `_id`, `_rev`, and a `type` discriminator
(`"campaign" | "account" | "target" | "outreach" | "reply" | "suppression"`). The TS interfaces below
are **conventions enforced in app code**, not a DB schema. `id` mirrors the part of `_id` after the
type prefix (e.g. `target:abc` → `id: "abc"`).

Key separations: **Campaign** (what you pitch) vs **Target** (who you contact); and
**Outreach** (append-only send *attempt* log) vs **Target** (canonical status).

```ts
type ID = string;
type ISO = string; // timestamp
```

### Campaign — the ad context + the single source of truth for questions

```ts
interface Campaign {
  id: ID;
  name: string;
  advertised: { url: string; description: string }; // casinoslists.com, "rapidly growing online casino platform"
  topic: string;             // "casino"
  format: string;            // "article" | "sponsored post" — a guest post, whatever it is called
  inquiryFields: InquiryField[];   // questions asked == fields extracted
  referenceEmail?: string;   // a real outreach email → template/tone anchor
  subjectTemplate?: string;
  priceExpectation?: string;
  followUp?: FollowUpPolicy;  // no-reply bump cadence
  createdAt: ISO;
}

interface FollowUpPolicy {
  afterDays: number;         // days of no-reply before a bump is due
  maxFollowUps: number;      // hard stop (e.g. 2)
  templates?: string[];      // optional per-step body overrides
}

interface InquiryField {
  key: string;               // 'price' | 'categories' | 'section' | 'linkType' …
  question: string;          // how it's phrased in the email
  type: 'price' | 'text' | 'list' | 'enum' | 'boolean';
  enumValues?: string[];
  required?: boolean;
}
```

### Account — a sending mailbox (carries its own sender identity)

```ts
interface Account {
  id: ID;
  email: string;
  providerType: 'smtp-imap' | 'gmail-api';
  credentialRef: string;     // .env var name — NOT the secret itself
  senderName: string;        // "Vlad"
  signature?: string;
  status: 'warming' | 'active' | 'paused' | 'cooldown';
  createdAt: ISO;            // drives the warmup ramp
  maxDailyLimit: number;     // default 40
  dailyLimitOverride?: number;
  lastError?: string;
  lastErrorAt?: ISO;
  pollCursor?: { mailbox: string; lastUid?: number; lastPolledAt?: ISO };
}
```

### Target — canonical per-site status

```ts
type TargetStatus =
  | 'pending' | 'reserved' | 'contacted'
  | 'replied' | 'bounced' | 'needs_review' | 'excluded';

interface Target {
  id: ID;
  campaignId: ID;
  websiteUrl: string;
  contactEmail: string;
  contactName?: string;      // greeting personalization; falls back to domain
  notes?: string;            // per-site hook (used by the optional LLM personalization line later)
  status: TargetStatus;
  assignedAccountId?: ID;
  lastOutreachAt?: ISO;      // drives follow-up cadence
  followUpCount: number;     // how many bumps already sent (0 = only initial)
  result?: OutreachResult;   // rolled-up outcome (latest meaningful reply)
  createdAt: ISO;
}
```

### Outreach — append-only send attempt

```ts
type SendStatus = 'reserved' | 'sent' | 'failed' | 'needs_review';
type OutreachKind = 'initial' | 'followup';

interface Outreach {
  id: ID;
  targetId: ID;
  accountId: ID;
  kind: OutreachKind;        // initial vs bump
  sequenceNo: number;        // 0 = initial, 1.. = follow-ups
  status: SendStatus;
  rfcMessageId: string;      // we set this → exact self-lookup
  threadId?: string;         // resolved post-send from All Mail
  subject: string;
  body: string;
  reservedAt: ISO;           // the 24h limit counts from here
  sentAt?: ISO;
  threadResolvedAt?: ISO;
  attempts: number;          // same-account retry counter
  error?: string;
}
```

### Reply — inbound (many per target possible)

```ts
interface Reply {
  id: ID;
  emailId: string;           // X-GM-MSGID / EMAILID — unique dedupe key
  threadId?: string;         // primary match key
  rfcMessageId: string;
  fromAddress: string;
  targetId?: ID;             // null when unmatched
  matchMethod: 'threadId' | 'fromAddress' | 'unmatched';
  receivedAt: ISO;
  text: string;
  parsed?: OutreachResult;
  extractionStatus: 'pending' | 'done' | 'failed';
}
```

### Suppression — persistent do-not-contact list

```ts
interface Suppression {
  id: ID;                    // = normalized email
  email: string;
  reason: 'opt_out' | 'bounce' | 'manual';
  at: ISO;
  note?: string;
}
```

> Imports and the send-pass **always** check `Suppression` first, so an opted-out or bounced address can
> never be re-contacted even after a CSV re-import. Bounces also flip the `Target` to `bounced`.

### OutreachResult — universal meta-fields + campaign-defined dynamic fields

```ts
interface OutreachResult {
  canPost: 'yes' | 'no' | 'maybe';    // universal
  optOut: boolean;                     // universal — "stop emailing me"
  conditions?: string;
  notes?: string;
  fields: Record<string, FieldValue>;  // keyed by InquiryField.key
}

type FieldValue =
  | { type: 'price';   amount?: number; currency?: string; raw: string }
  | { type: 'text';    value: string }
  | { type: 'list';    values: string[] }
  | { type: 'enum';    value: string }
  | { type: 'boolean'; value: boolean };
```

---

## 7. Derived statistics (never stored as counters)

```
sentInLast24h(account) = count Outreach
    where accountId = account
      and reservedAt > now − 24h
      and status ∈ {reserved, sent}        // reserved counts → cap holds in-flight
                                           // counts BOTH initial and followup

currentLimit(account)  = min(dailyLimitOverride ?? warmupRamp(ageDays), maxDailyLimit=40)
remainingToday(account)= currentLimit − sentInLast24h
followUpsDue(campaign) = Targets where status = contacted
                           and now − lastOutreachAt ≥ followUp.afterDays
                           and followUpCount < followUp.maxFollowUps
                           and no reply yet
replyRate              = repliedTargets / contactedTargets
bounceRate(window)     → feeds the health rule
```

---

## 8. Flow

### Startup
1. Acquire single-instance lock (refuse / focus existing if held).
2. **Reconcile:**
   - `Outreach{reserved}` past a grace period → exact-lookup `rfcMessageId` in All Mail.
     Found → `sent` + capture `threadId`. Not found → `needs_review` (never auto-resend).
   - `Outreach{sent}` missing `threadId` → retry the exact All-Mail lookup (a crash between send and
     thread-resolve must not weaken later reply matching).
3. Start server + scheduler.

### Send-pass  (sequential — no mutex; reserve-before-send guards restarts)
1. Per `active` account: compute `remainingToday`; skip if ≤ 0 or outside the send window.
2. Build the work queue, **follow-ups first**: `followUpsDue` targets, then `pending` targets — up to
   `remainingToday`. Assign accounts round-robin; skip accounts at their limit.
3. *Per target (idempotency):* verify no successful/in-flight `Outreach` exists for this (target, kind) →
   `reserveSend()` creates `Outreach{reserved}` with a fresh `rfcMessageId`; target → `reserved`
   (initial) or stays `contacted` (follow-up). **Slot consumed here.**
4. Drafter builds the body (deterministic template) → `provider.send()`. Respect the jittered
   inter-send gap so the window's quota is dripped, not bursted.
5. Success → `confirmSend` (`sent`; initial → target `contacted`, set `lastOutreachAt`; follow-up →
   `followUpCount++`) → resolve `threadId` via exact All-Mail lookup.
   Failure → `failSend` (`failed`, `attempts++`); retry on the **same** account up to N, else target →
   `pending` (or `failed` after N total tries).

### Poll-pass  (independent cadence)
1. Per account, fetch new messages since cursor with `{ threadId, emailId, envelope, headers }`.
2. Per message: dedupe on `emailId` → **detect bounce** (parse DSN → failed recipient → `Suppression{bounce}`
   + target `bounced`) → **match** (`threadId` → `fromAddress` → `unmatched`).
3. Store `Reply{pending}` → extractor (LLM via `LlmProvider`; JSON schema from `inquiryFields`, low temp;
   **stub adapter for now**) → write `parsed` → roll up onto `Target` (`replied`, or `excluded`
   + `Suppression{opt_out}` if `optOut`).
4. Advance cursor.

### Health (after each pass)
- Bounce-rate spike or auth/security send error → `paused`/`cooldown` + `lastError`.

---

## 9. State machines

**Target:** `pending → reserved → contacted → replied`
branches: `reserved → needs_review` (stuck) · `contacted → bounced` · `* → excluded` (opt-out)
Follow-ups do **not** change `Target.status` — they add `Outreach` rows and bump `followUpCount`;
the target stays `contacted` until a reply, bounce, or opt-out.

**Outreach (append-only):** `reserved → sent` (then threadId enriched) · `reserved → failed` ·
`reserved → needs_review`

> `Target.status` is the single source of truth for "what to do next with this site."
> `Outreach` and `Reply` are immutable logs. That division is what makes restarts and partial
> failures safe to reason about.

---

## 10. Project structure

```
adscout/                         # = this repo root
├── package.json                 # ESM; devDeps now, runtime deps added per adapter
├── tsconfig.json
├── .env / .env.example          # secrets (gitignored) referenced by credentialRef
├── data/                        # gitignored
│   ├── pouch/                   # PouchDB (leveldb) directory
│   ├── agent.lock               # single-instance lock
│   └── targets.csv
├── prompts/
│   └── extract-reply.md         # drafting is template-based; only extraction is LLM-driven
├── scripts/
│   ├── add-account.ts
│   ├── import-targets.ts        # checks Suppression
│   └── stats.ts
├── launchd/
│   └── com.adscout.agent.plist  # optional
│
├── web/                         # Vite + React UI (SSE-driven)
│   └── src/{main.tsx, api.ts, pages/, components/}
│
└── src/
    ├── index.ts                 # lock → reconcile → server → scheduler
    ├── config.ts                # send window, follow-up defaults, daily cap, paths
    ├── server/
    │   ├── app.ts               # Fastify/Hono + serve web/dist + SSE change stream
    │   └── routes/{accounts,targets,responses,run,status}.ts
    ├── domain/                  # PURE, no I/O  ← built first
    │   ├── types.ts
    │   ├── warmup.ts            # ageDays → dailyLimit
    │   ├── limits.ts            # remainingToday / canSend
    │   ├── health.ts            # auto-pause rules
    │   └── reply-matching.ts    # threadId → fromAddress → unmatched (+ bounce detect)
    ├── ports/
    │   ├── email-provider.ts
    │   ├── store.ts             # reserveSend/confirmSend/failSend, sentInLast24h, findStuckSends, replyExists, suppression, change events
    │   └── llm-provider.ts
    ├── adapters/
    │   ├── email/{smtp-imap,gmail-api}.provider.ts
    │   ├── store/pouchdb.store.ts
    │   └── llm/{stub,ollama}.provider.ts   # stub now, ollama later
    ├── pipeline/
    │   ├── send-pass.ts         # reserve-before-send + drip + follow-up priority + resolve threadId
    │   ├── poll-pass.ts         # dedupe by emailId
    │   ├── reconcile.ts
    │   └── (bounce handled inside poll-pass)
    ├── services/
    │   ├── drafter.ts           # inquiryFields → email body (template)
    │   ├── extractor.ts         # inquiryFields → JSON schema → parsed result (LLM)
    │   └── account-selector.ts  # round-robin, skip at-limit, same-account retry
    └── lib/
        ├── lock.ts
        ├── logger.ts
        └── factory.ts           # the only place that knows concrete adapters
```

---

## 11. Web UI

- **Vite + React + TS**, served by the agent process; open `localhost`.
- **Live updates via SSE** from the Store's change events (the agent is the sole writer), instead of
  polling — the RTDB-style feel without coupling to the DB.
- Local API mirrors the `Store` port:
    - `GET /api/accounts` · `PATCH /api/accounts/:id` · `POST /api/accounts/:id/pause|resume`
    - `GET /api/targets?status=` · `GET /api/responses` · `GET /api/suppressions`
    - `POST /api/run/send|poll` · `GET /api/status` · `GET /api/stream` (SSE)
- Views: **Accounts** (stats + editable limit + pause), **Responses** (reply + parsed result, plus an
  **unmatched** queue), **Targets** queue (incl. `needs_review`), **Run** panel with live log tail.

---

## 12. Worked example

Source email (real outreach, the campaign's `referenceEmail`):

> *Interest in publishing a post about the casino on your website*
> Hello, egamersworld.com — My name is Vlad and I manage a rapidly growing online casino platform,
> casinoslists.com. I'm writing to inquire about publishing an article about a casino on your site.
> Could you confirm: Costs of publishing? Popular categories? Section where it may appear?

Maps to:

- **Account:** `senderName: "Vlad"`
- **Campaign:** `advertised: { url: "casinoslists.com", description: "rapidly growing online casino platform" }`, `topic: "casino"`, `format: "article"`, `referenceEmail:` *(the email above, used as the template/tone anchor)*, `followUp: { afterDays: 4, maxFollowUps: 2 }`
- **inquiryFields:**
    - `{ key: 'price',      question: 'Cost of publishing an article?',  type: 'price' }`
    - `{ key: 'categories', question: 'Popular categories?',             type: 'list'  }`
    - `{ key: 'section',    question: 'Section where it may appear?',     type: 'text'  }`
- **Target:** `websiteUrl: "egamersworld.com"`

**Single-source-of-truth payoff:** the drafter renders the email from
`senderName + advertised + format/topic + inquiryFields (+ greeting)` via a deterministic template, and
the extractor builds its JSON schema from the *same* `inquiryFields`. Add a field later — e.g.
`{ key: 'linkType', question: 'Do-follow or no-follow links?', type: 'enum', enumValues: ['dofollow','nofollow'] }`
— and it appears in both the email and the parsed result with no code change.

---

## 13. Resolved decisions

See §0 for the table. Notes on the originally-open items:

- `format`/`topic` stay **free strings** (`referenceEmail` carries tone). Revisit as enums only if needed.
- Passes run on a **scheduled drip within the send window**, plus a manual "Run now" — both respect
  `remainingToday` and pacing.
- Scheduling: **in-process `node-cron`**; `launchd` one-shot is an optional later resilience upgrade.
- Optional engagement-warmup seed pool: **deferred** — add only if deliverability is poor.

Still open / to confirm at the relevant milestone:
- Exact Ollama model tag (`gemma4:26b-mlx` candidate).
- Send-window hours/timezone and follow-up defaults (set in `config.ts`).
- Whether the optional LLM personalization line is worth adding once Ollama is in.

---

## 14. Build order

1. **Foundation (now):** scaffold + pure `domain/` (types, warmup, limits, health, reply-matching) with
   unit tests + the three `ports/` interfaces. No external services needed.
2. **Store:** `pouchdb.store.ts` implementing the `Store` port + change events; `add-account` /
   `import-targets` scripts.
3. **Drafter + stub LLM:** template drafter; `stub` `LlmProvider` returning deterministic parsed results.
4. **Pipeline:** `reconcile`, `send-pass` (drip + follow-up priority), `poll-pass` (dedupe + bounce +
   match + extract) wired through ports — runnable end-to-end with the stub LLM and a fake/email sandbox.
5. **Email adapter:** `SmtpImapProvider` (nodemailer + imapflow), threadId/emailId normalization,
   exact self-lookup. Live Gmail test with one app-password account.
6. **Server + UI:** Fastify/Hono + SSE; React views.
7. **Real LLM:** `OllamaProvider` + confirm model; swap out the stub.
