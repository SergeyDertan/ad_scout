# Outreach pipeline

Read this when: changing sending, reply ingest, extraction, deals, limits/warmup,
the scheduler, or the email/LLM adapters.

## Shape

```
serve.ts
  DripScheduler  send loop → runSendPass({ maxPerAccount: 1 })
                 poll loop → runFetchPass            (ingest only, NO extraction)
  POST /api/run/send | poll | fetch                  (manual "Run now")
  remote hub     pending replies → worker's `claude` → persistExtraction

every pass, dashboard write, hub result and backup → one Mutex (passLock)

send   targets → draft (template) → reserve Outreach → send → sent | failed
fetch  mailbox → dedupe → ignore → bounce → deal hold? → match → store Reply
poll   = fetch + extractPendingReplies → roll up target → append PriceRecords
```

The scheduler never extracts. In production, extraction happens through the
remote hub (started by `serve` when `REMOTE_TOKEN` is set) or a manual poll run.

## Status lifecycles

- **Target** (`TargetStatus`)
  - pending → reserved → contacted → replied | excluded | bounced
  - a failed initial send goes back to pending
  - reconcile turns a stuck `reserved` into `needs_review`
  - a holding/auto reply leaves the target `contacted`
- **Outreach**: reserved → sent | failed | needs_review. `kind` is `initial`,
  `followup` or `manual` (manual = a deal message).
- **Reply.extractionStatus**: pending → done | failed. `skipped` means held by an
  open deal, an empty body, or a target that was already answered.
- **Deal**: negotiation ⇄ fulfilment → done | closed (`canTransition`,
  `domain/deals.ts`). "Open" means negotiation or fulfilment.
- **Account**: `active` | `paused` | `cooldown`. Only `active` sends.

## Send pass (`pipeline/send-pass.ts`)

1. Capacity per active account is `remainingToday`: a warmup ramp by account age
   (`domain/warmup.ts`: 5/day, +5 every 3 days, cap 40 or `maxDailyLimit` /
   `dailyLimitOverride`), minus today's count from the Outreach log
   (`domain/limits.ts`).
2. Targets are skipped when the email is suppressed or the website domain is
   excluded.
3. Follow-ups only when `FOLLOW_UPS_ENABLED=true` (default off); they go ahead of
   initials.
4. Work is assigned round-robin across accounts with capacity
   (`services/account-selector.ts`).
5. Each item:
   - idempotency check on (target, kind, sequenceNo)
   - `draftEmail` (`services/drafter.ts`): a deterministic template in en/es/pt,
     no LLM
   - write the `reserved` Outreach (an initial also sets the target to
     `reserved` + `assignedAccountId`)
   - send, outside any lock
   - `sent` + threadId (resolved by exact self-lookup if the provider returns
     none) → target `contacted`
   - on error: Outreach `failed`, and the target goes back to `pending`
6. The pitch comes from `resolveProfile(batch, config.pitch)` (`domain/pitch.ts`):
   a batch may override language and advertised site.
7. Nothing is ever auto-resent. `runReconcile` (at boot) looks up each `reserved`
   older than `RECONCILE_GRACE_MS` in the mailbox. Found → `sent`; not found →
   `needs_review`.

## Ingest (fetch pass and the first half of the poll pass)

- `fetchReplies` reads INBOX + Spam and never Sent, so our own pitch cannot reach
  the extractor.
- Order of checks:
  1. dedupe on `emailId`
  2. ignore list
  3. bounce → suppression + target `bounced`
  4. deal hold
  5. match: threadId → exact fromAddress among awaiting targets → unmatched
     (`domain/reply-matching.ts`)

  Re:/References headers are never parsed.
- The Reply doc is built only by `buildInboundReply` (`pipeline/inbound-reply.ts`).
  Fetch and poll each used to have their own copy; the fetch copy silently
  dropped attachments. Keep it single.
- An unmatched reply is still `pending`: price history is keyed by domain, so a
  quote from an unknown mailbox still has somewhere to land.
- Every message seen is marked read and carries exactly one `AS/*` Gmail label for
  the decision reached (`domain/labels.ts`).
- Poll cursors (`pipeline/cursor.ts`): Gmail advances `historyId` inside
  `fetchReplies`. So a pass commits (`advanceCursor`) only after finishing an
  account; otherwise it calls `rewindCursor`, and dedupe absorbs the re-fetch.
  Skipping this loses mail for good.

## Extraction

- Queue: `extractPendingReplies` (`pipeline/poll-pass.ts`) takes `pending` and
  `failed` replies that are not deal-held. The hold is re-checked here because a
  thread can join a deal after ingest.
- Two halves:
  - `extractReplyCore` (`pipeline/extract-core.ts`): slow, JSON in / JSON out, no
    writes. It is the same code on a remote worker.
  - `persistExtraction`: fast, does every write, under the lock.

  Never reimplement the first half on the worker side.
- Division of labour in `services/extractor.ts`:
  - The LLM does NLP only: niches, willingness, verbatim prices.
  - `domain/extraction.ts` parses prices and reconciles niches (`assembleResult`).
  - Guest posts only: link-insertion and banner prices are dropped.
- Pitch style: `broad` by default; `casino` only for batches in
  `CASINO_PITCH_BATCH_IDS`. It decides what a niche-less price means.
- Provenance: `promptHash` is sha256 of `buildSystem(style)`, first 12 hex chars,
  so any change to the system prompt moves the hash. That is intended: re-extract
  runs become comparable. The per-reply prompt (niche list, reply, research
  addendum) is not hashed.
- Research (reading links and files) only happens on providers with
  `supportsResearch` (claude-code, antigravity):
  - Google Docs/Sheets/Slides/Drive and PDF links are downloaded by us
    (`services/linked-docs.ts`) and passed as attachments, because WebFetch only
    sees the JS shell of those pages.
  - Other rate pages → WebFetch.
  - Anything unreadable → a `review` entry for a human.
- claude-code provider (`adapters/llm/claude-code.provider.ts`):
  - runs `claude -p` with `--json-schema`
  - no tools unless researching
  - `ANTHROPIC_API_KEY` is stripped, to stay on subscription billing
  - the model must be an exact id, because it is recorded as provenance
  - runs from a private temp cwd (`neutral-cwd.ts`), so no CLAUDE.md or
    `.claude/` from this repo reaches extraction prompts. Keep it that way.
- Failures:
  - a usage/session limit → `UsageLimitError` (`lib/errors.ts`) stops the run
    for a later resume
  - 3 attempts per reply
  - a consecutive-failure backstop
  - the hub aborts after `REMOTE_MAX_FAILED` failed replies, until restart
- Roll-up (`rollUp` and its callers):
  - opt-out → target excluded + suppression
  - blanket decline → excluded + DomainExclusion
  - holding / auto_reply → target stays contacted
  - substantive → replied + result snapshot
  - a non-substantive reply never clobbers a known result
- PriceRecords are appended per domain by `attributeOffers`: the sender's domain,
  or a site the owner named; at most `MAX_DOMAINS_PER_REPLY` (10). A positive
  record lifts a `declined` exclusion. `isSpam` puts the sender on the ignore
  list and writes no prices. Newly seen niches are persisted with `putNiche`.

## Deals (human-run)

- While a deal is open, messages on its threads are stored (`dealId`, `skipped`)
  and nothing else happens: no extraction, roll-up, price, exclusion, suppression
  or ignore write. All three entry points check it via `heldDeal` /
  `openDealThreadIds` (`pipeline/deal-hold.ts`); a new entry point must too.
- `pipeline/deal-ops.ts`:
  - `openDeal`: idempotent per thread
  - `attachThreads`
  - `addDomains`: creates placements
  - `setDealStatus`
  - `updatePlacement`
- `sendDealMessage` (`pipeline/deal-send.ts`):
  - the same reserve → send → record discipline, with kind `manual`
  - counted in `sentToday`, but never blocked by the quota
  - builds In-Reply-To/References
  - links the thread before anything can poll it
  - attachments only from a Gmail-API mailbox
- `syncDealThreads` (`pipeline/deal-thread-sync.ts`) adopts messages a person
  sent from Gmail on open-deal threads:
  - reads threads by id, never with a mailbox query
  - only messages from the account's own address
  - idempotent on `rfcMessageId`, with a 2-minute sentAt tolerance
- A placement's `agreedPrice` never becomes a PriceRecord.

## Time, window, quota

- Everything is local clock (`getHours`/`setHours`): the send window
  (`SEND_WINDOW_START_HOUR`/`END_HOUR`, 9–18, pacing aims at end−1) and the daily
  quota reset.
- A server must have `TZ` set. `serve.ts` warns when it isn't; the VPS unit pins
  `Europe/Kyiv`. A UTC box sends at the wrong hours without any error.
- The drip (`scheduler/window.ts`, `scheduler/scheduler.ts`) spreads the remaining
  quota across the window with jittered gaps.
- `LivenessMonitor` pauses both loops while the mail host is unreachable or the
  laptop has slept.
- Health rules (`domain/health.ts`, `evaluateHealth`) exist but nothing calls
  them outside tests. Pausing an unhealthy account is manual.

## Email adapters

- `buildAgent` (`lib/factory.ts`):
  - unset or dummy `EMAIL_PROVIDER` → `DummyEmailProvider`
  - otherwise, with a Google OAuth client configured → `RoutingEmailProvider`,
    which picks `gmail-api` (REST + tokens on `Account.oauthTokens`) or
    `smtp-imap` (app password; creds from `<credentialRef>_USER` / `_PASS`) per
    `Account.providerType`
  - without an OAuth client → `SmtpImapProvider` for every account, whatever its
    `providerType`
- Gmail replaces a self-set Message-Id. Identify sent mail by `emailId`, not
  `rfcMessageId`.
- `MAX_ATTACHMENT_BYTES` is 5 MB inbound; outgoing attachments are capped at
  3.5 MB total.

## How to change…

- **Email copy:** `services/drafter.ts`, all three languages.
- **Extraction rules:**
  - `buildSystem` in `services/extractor.ts` (moves `promptHash`)
  - schema and parsing in `domain/extraction.ts`
  - update `extractor.test.ts` / `extraction.test.ts`
  - re-extraction scripts live in `src/scripts/reextract-*.ts`
- **Limits/warmup:** `domain/limits.ts`, `domain/warmup.ts`. `account-state.ts`
  mirrors the math for the UI; keep them in step.
- **New LLM provider:** implement `LlmProvider` (`ports/llm-provider.ts`), add it
  to `LlmProviderKind` + `loadConfig` (`src/config.ts`) and to `buildLlm`
  (`lib/factory.ts`). A CLI-based provider should start from `neutralCwd()`.

## Tests

- Pure domain modules have sibling `*.test.ts` files.
- `pipeline/pipeline.test.ts` runs full send → fetch/poll → extract cycles with:
  - `MemoryStore` (plus one `PouchDbStore` in a temp dir)
  - `DummyEmailProvider` or a hand-built `EmailProvider`
  - `DummyLlmProvider` or a stub `LlmProvider`
  - `fixedClock`
  - `loadConfig({})` for defaults
- Deals: `deal-hold.test.ts`, `deal-send.test.ts`, `deal-thread-sync.test.ts`,
  `server/deals-api.test.ts`.
