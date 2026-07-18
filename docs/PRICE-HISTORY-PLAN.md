# Per-Domain Price History — Implementation Plan

> Status: **IMPLEMENTED (all 7 phases).** This document is the source of truth for
> the feature. It survives session boundaries — anyone (human or agent) can resume
> from here without re-deriving the design. Update it as decisions change.
>
> ## Build notes / decisions taken during implementation
> - **`deletePriceRecord(id)` added to the Store** (port + both adapters). Not in
>   §6, but the migration/reset scripts must wipe history before a re-scan.
>   Normal operation never deletes — records stay append-only.
> - **`website` also lives on `PostOffer`** (not only `RawOffer`, cf. §3.4) so the
>   ingest phase can group offers by domain; it's implied by a record's `domain`
>   afterward but kept for provenance. The extraction cell key is
>   `website|postType|niche|special` so a named-site price, an own-site price, and
>   a promo never merge.
> - **Requirement 2 (append after resolved):** the `isTargetResolved` extraction
>   *skip* was removed. Every matched, non-empty, non-ignored reply is extracted;
>   `rollUp` guards `target.result` from being clobbered by non-substantive chatter
>   (`isSubstantive` = has offers or intent 'answer'). `skipped` now means empty
>   body. The ignore check runs in BOTH fetch-pass and poll-pass.
> - **Decline → target 'excluded'** (was 'replied'): a blanket `intent:'decline'`
>   sets the target excluded and writes a `reason:'declined'` DomainExclusion.
> - **Reversal (D10)** auto-lifts only `reason:'declined'` exclusions; `'manual'`
>   ones require explicit removal via the API (respects deliberate user intent).
> - **Empty "can post, no price" record** (offers:[]) is written only for a
>   substantive `canPost:'yes'` reply with no priced cells and exactly one sender
>   domain — otherwise nothing is recorded for offerless replies.
> - **API:** `GET /api/domains`, `GET /api/domains/:domain` (sheet+history),
>   `GET/POST/DELETE /api/ignore`, `GET/POST/DELETE /api/exclusions`. UI adds
>   **Domains** and **Ignore** tabs; the price sheet lives in `domain/price-sheet.ts`.
> - **Migration:** `pnpm reset:for-reingest` (step 1), reuse `runFetchPass` (step 2),
>   `pnpm reextract:stored --limit N [--sleep MS]` (step 3, resumable). Both
>   `reset:extractions` and `reextract:stored` also purge pricerecords + declined
>   exclusions so a re-run doesn't double-write.

## 1. Goal

Today the system is **target-centric**: a `target` = (`websiteUrl` + `contactEmail`),
and the outcome is a single snapshot at `target.result` (`src/domain/types.ts`). Once
`target.result != null`, later replies are **skipped** (`isTargetResolved`,
`src/domain/reply-matching.ts:38`) — so pricing that arrives later is thrown away.

We are adding a **domain-centric, append-only price history** decoupled from the
target/thread lifecycle:

1. Every resolved can/cannot-post outcome is saved as a **price record per domain**
   (price, or just "can post" when no price given), with date, source email, and
   message id for reference.
2. A **new inbound message updates the domain's price**, regardless of thread id,
   as long as the sender or the message body ties it to a domain.
3. A single reply can carry prices for **several websites the owner also owns**
   (e.g. `help@cas.com` quotes `cas.com`, `casik.com`, `casik.ua`). We record a
   price for each named site **without** associating the email with those extra sites.

Plus: time-limited **special offers**, an inbound **ignore list** (spam / automated
senders), **domain-level exclusion** on a blanket decline, and a **resumable
migration** that re-scans the mailbox without blowing the Claude Code usage window.

## 2. Locked design decisions

These were settled over discussion. Do not re-litigate without a reason.

| # | Decision |
|---|---|
| D1 | **One new append-only collection `pricerecord`.** The domain list and the "current price sheet" are **derived at read time**, not stored. No mutable domain registry (would drift; violates the codebase's derive-don't-store ethos, cf. batch counts `types.ts:99`). |
| D2 | **`PriceRecord` is event-shaped** — it stores only the cells a single message actually mentioned. Carry-forward / staleness is computed in the derived view, never stored. |
| D3 | **Domain key = full host, subdomains preserved.** `normalizeDomain`: lowercase → strip scheme → strip leading `www.` → drop path/query/port → keep the rest verbatim. So `casik.com` ≠ `casik.ua` ≠ `ultra.casik.biz`. No public-suffix list. |
| D4 | **Two attribution mechanisms.** (M1) *Untagged* offers → the **sender's** associated domain, via an `email → domain` map built from **all** targets. (M2) Offers the owner **tags with a site** → that site's domain. Domain "existence" is irrelevant — a record is written whether or not the domain is already known. |
| D5 | **Special offers are fields on `PostOffer`** (`isSpecial`, `specialUntil`), same collection. A special does **not** overwrite the standing price cell — both coexist; the derived view surfaces the promo separately. |
| D6 | **Inbound ignore lists** (new `ignore` collection), checked at the top of message handling — replaces any regex prefilter. `kind: 'email' | 'domain'` (domain = the *sender address* domain, e.g. `facebook.com`), each with a `reason` and the triggering `emailId`. Seed common domains (`google.com`, `facebook.com`, `instagram.com`, …) as a code constant merged with user/AI-added docs. |
| D7 | **AI-detected spam auto-grows the ignore list.** Extractor returns `isSpam` (wholly unrelated to posting/ads, e.g. "10% off pool cleaners"). On `isSpam` → add an `ignore` entry for the sender (with reason + emailId) and stop; do not keep it as a normal reply or write price records. |
| D8 | **Domain-level exclusion** (new `domainexclusion` collection) is distinct from email opt-out (`suppression`). `intent:'decline'` (a blanket "we won't post anything") → exclude the **domain**. A per-cell `canPost:'no'` (e.g. "no casino") is just a price cell, **not** an exclusion. |
| D9 | **Exclusion enforcement:** skip excluded domains at **send** (`send-pass.ts`) and **import** (`POST /api/targets` — this is the domain-dedup hook from the first discussion). |
| D10 | **Decline reversal is automatic.** A later **positive** record for an excluded domain (any `canPost:'yes'` / a price) **lifts** the exclusion and records the price. Manual removal is also supported for `reason:'manual'` entries. |
| D11 | **Multi-domain sender + untagged offer → review.** If the sender maps to 2+ domains and the offer names no site, do **not** guess — push a reason onto `reply.review[]` (`types.ts:167`) and skip attribution. |
| D12 | **`target.result` is kept unchanged** as the thread/target snapshot the existing UI uses. Price history lives in `pricerecord`, not `target.result`. |
| D13 | **Migration = delete + re-scan, in 3 decoupled steps**, with AI extraction fully separated from fetching and **resumable** across usage windows (see §8). |

## 3. Data model

### 3.1 New: `PriceRecord` (append-only)

```ts
// src/domain/types.ts — new DocType 'pricerecord'
export interface PriceRecord {
  id: ID;                          // newId('pricerecord')
  domain: string;                  // normalizeDomain(...) — the index key
  offers: PostOffer[];             // ONLY the cells this message said; [] = "can post, no price"
  optOut?: boolean;                // rare; opt-out is email-level, kept for completeness
  observedAt: ISO;                 // the "date"
  sourceEmail: string;             // normalized from-address
  sourceMessageId: string;         // reply.rfcMessageId
  replyId?: ID;                    // provenance → Reply
  targetId?: ID;                   // set when domain == the contacted target's site
  attribution: 'sender' | 'named'; // M1 vs M2 (D4)
}
```

### 3.2 New: `IgnoreEntry`

```ts
// new DocType 'ignore'
export interface IgnoreEntry {
  id: ID;                 // `${kind}:${value}` (normalized) — natural key
  kind: 'email' | 'domain';
  value: string;          // normalized email, or bare sender-address domain
  reason: string;         // AI reason (spam) or human note
  emailId?: string;       // the message that triggered it — for manual review (D7)
  at: ISO;
}
```

### 3.3 New: `DomainExclusion`

```ts
// new DocType 'domainexclusion' — keyed by normalized domain for O(1) checks
export interface DomainExclusion {
  id: ID;                 // = normalized domain
  domain: string;
  reason: 'declined' | 'manual';
  sourceReplyId?: ID;     // provenance
  at: ISO;
}
```

### 3.4 Extend: `PostOffer` (D5)

```ts
export interface PostOffer {
  // ...existing...
  isSpecial?: boolean;    // time-limited promo price
  specialUntil?: ISO;     // optional deadline the owner gave
}
```

### 3.5 Extend: extraction schema (`src/domain/extraction.ts`)

- `RawOffer`: add optional `website?: string` (M2) and `isSpecial?`, `specialUntil?` (D5).
- `RawExtraction`: add `isSpam: boolean` (D7).
- Update `OFFER_SCHEMA` and `buildExtractionSchema()` accordingly (they list every
  field under `required` — keep that contract; structured-output requires all keys
  present, so add the new keys to both `properties` and `required`, using `""`/`false`
  defaults where the model has nothing to say).
- `reconcileOffers` / `assembleResult`: carry `website`, `isSpecial`, `specialUntil`
  through to `PostOffer`. Grouping by domain happens in the **caller** (poll-pass),
  not here — keep this module pure and domain-agnostic.

### 3.6 `DocType` union (`src/ports/store.ts:16`)

Add `'pricerecord' | 'ignore' | 'domainexclusion'`.

## 4. Derived views (no storage)

### 4.1 Domain price sheet (the "current prices" view)

For a domain, fold its `PriceRecord`s: for each `(postType × niche)` cell, take the
**most recent record that mentioned that cell**. Each cell in the result carries its
own `asOf` (the record's `observedAt`) + `sourceMessageId`/`replyId`. Cells whose
newest mention is older than the domain's newest record are **flagged stale**
("carried over from an earlier message"). Specials (`isSpecial`) form a parallel
layer: they annotate but do not replace the standing cell, and an expired
`specialUntil` drops out of the "active" view.

Worked example (matches the agreed scenario):
- 01.02 record A → `{regular: 500, sensitive: 600}`
- 04.04 record B → `{regular: 550}`
- Sheet on 05.04 → `regular = 550 (B, 04.04)`, `sensitive = 600 (A, 01.02, stale)`.

Absence of a cell in a later message = "no change" (carry forward). An explicit
`canPost:'no'` for a cell **is** a new mention and overrides.

### 4.2 Known-domains list

`distinct(domain)` over `PriceRecord` ∪ `Target(normalizeDomain(websiteUrl))`. No
registry doc.

## 5. Attribution & ingest logic (the substantive change)

All of this lives in the **extraction/roll-up phase** (AI phase), i.e. `poll-pass.ts`
`extractPendingReplies` / `rollUp`, plus the fetch phase for the non-AI ignore check.

### 5.1 Fetch phase (no AI) — `src/pipeline/fetch-pass.ts`

At the top of `handleMessage` (after the emailId dedupe, alongside bounce detection),
add the **ignore-list check**: if `fromAddress` is on `ignore` (email match) or its
address-domain is on `ignore` (domain match) or the seed domain constant → mark read,
label (optional new `ignored` label), bump `report.ignored`, **return without storing**.

### 5.2 Extraction phase (AI) — `src/pipeline/poll-pass.ts`

Per reply, after `extractor.extract(...)` returns `{ result, discovered, review, isSpam }`:

1. **Spam (D7):** if `isSpam` → `store.putIgnore({ kind:'email', value: normalizeEmail(from), reason, emailId })`, set the reply aside (status e.g. `skipped` or delete), **do not** write price records. Done.
2. **Build the `email → domain[]` map** once per pass from all targets.
3. **Split offers by domain:**
   - Offers with `website` set → domain = `normalizeDomain(website)`, `attribution:'named'`.
   - Offers with no `website`:
     - sender maps to exactly **one** domain → that domain, `attribution:'sender'`.
     - sender maps to **2+** domains → **review** (D11): push a reason onto
       `reply.review[]`, do not attribute these offers.
     - sender maps to **0** domains and no `website` → nothing to attribute (record
       nothing for these offers).
4. **Write a `PriceRecord` per domain group** (`observedAt`, `sourceEmail`,
   `sourceMessageId`, `replyId`, `targetId` when the domain == target's site).
5. **Decline → domain exclusion (D8):** if `intent === 'decline'` (blanket) for the
   target's domain → `store.putDomainExclusion({ domain, reason:'declined', sourceReplyId })`
   and set the target `excluded` (mirror the opt-out branch at `poll-pass.ts:220`).
6. **Reversal (D10):** for any domain in this reply producing a **positive** record
   (some `canPost:'yes'` or a price), if a `domainexclusion` exists → delete it.
7. **`target.result`:** keep updating it as today for the target's own domain (the
   thread snapshot, D12). History is preserved in `pricerecord` regardless.

**Requirement 2 (append even after resolved):** during normal operation, stop the
hard skip on resolved targets *for price-history purposes*. Concretely: still avoid
re-spending AI on non-substantive chatter, but a substantive later reply must produce
a new `PriceRecord`. Simplest rule: extract when the reply is not ignored/ empty; keep
`target.result` as the latest substantive result; always append the record. (During
**migration** this is moot — step 1 wipes all results, so every reply is unresolved
and gets extracted once.)

### 5.3 Enforcement points

- **Send** — `src/pipeline/send-pass.ts:97`: in the target loop, also `continue` when
  `await store.isDomainExcluded(normalizeDomain(t.websiteUrl))` (alongside the existing
  `isSuppressed(t.contactEmail)`).
- **Import** — `src/server/app.ts:388` (`POST /api/targets`): if the incoming
  `websiteUrl` normalizes to an excluded domain → skip/reject (don't create the target).
  This is the domain-dedup hook (D9). Bulk import already tolerates per-row failures
  (`web/src/components/BulkImportForm.tsx:158`).

## 6. Store port + adapters

`src/ports/store.ts` — add to the `Store` interface:

```ts
// price records (append-only per-domain history)
putPriceRecord(r: PriceRecord): Promise<PriceRecord>;
listPriceRecords(filter?: { domain?: string }): Promise<PriceRecord[]>;

// ignore list (inbound skip)
putIgnore(e: IgnoreEntry): Promise<IgnoreEntry>;
listIgnore(): Promise<IgnoreEntry[]>;
isIgnored(email: string): Promise<boolean>;   // checks email + address-domain + seed constant
deleteIgnore(id: string): Promise<void>;

// domain exclusion (outbound do-not-contact by website domain)
putDomainExclusion(d: DomainExclusion): Promise<DomainExclusion>;
isDomainExcluded(domain: string): Promise<boolean>;
listDomainExclusions(): Promise<DomainExclusion[]>;
deleteDomainExclusion(domain: string): Promise<void>;
```

- `src/adapters/store/memory.store.ts` — add three `Map`s
  (`priceRecords` keyed by id, `ignores` keyed by `${kind}:${value}`,
  `domainExclusions` keyed by domain) + the methods + `emit(...)` calls, mirroring the
  existing pattern (`memory.store.ts:28-47`).
- `src/adapters/store/pouchdb.store.ts` — add the methods; the `type:id` key scheme
  (`pouchdb.store.ts:55`) handles the new doc types for free. `listPriceRecords({domain})`
  can list-all-and-filter (small volumes) or use an allDocs range.

## 7. File-by-file change list (phased, each phase ends green)

Run `pnpm typecheck` + `pnpm test` (see `package.json`) at each phase boundary.

### Phase 1 — foundation (no behavior change)
- `src/domain/domain.ts` **(new)** — `normalizeDomain(urlOrHost): string` (D3) + unit test `domain.test.ts`.
- `src/domain/types.ts` — add `PriceRecord`, `IgnoreEntry`, `DomainExclusion`; extend `PostOffer` (D5).
- `src/ports/store.ts` — extend `DocType`; add the methods (§6).
- `src/adapters/store/memory.store.ts` — implement.
- `src/adapters/store/pouchdb.store.ts` — implement.
- `src/domain/ignore-seed.ts` **(new)** — constant seed list of sender domains.
- **Green:** typecheck; existing tests still pass.

### Phase 2 — extraction schema + prompt
- `src/domain/extraction.ts` — add `website`, `isSpecial`, `specialUntil` to `RawOffer`
  and carry into `PostOffer`; add `isSpam` to `RawExtraction`/schema; update `OFFER_SCHEMA`
  + `buildExtractionSchema()` (keep every key in `required`).
- `src/services/extractor.ts` — surface `isSpam` in `ExtractionOutcome`; extend the
  SYSTEM prompt: (a) tag `website` only when the owner explicitly prices a *different*
  site they own, else leave blank (defaults to the contacted site); (b) `isSpecial`
  /`specialUntil` for time-limited promos; (c) `isSpam` definition (wholly unrelated to
  posting/ads).
- `src/domain/extraction.test.ts`, `src/services/extractor.test.ts` — update/extend.
- **Green:** extractor tests.

### Phase 3 — ingest logic
- `src/domain/reply-matching.ts` — add `emailToDomains(targets)` helper (pure); relax
  the "resolved skip" story per §5.2 (Requirement 2).
- `src/pipeline/fetch-pass.ts` — ignore-list drop (§5.1); `report.ignored`.
- `src/pipeline/poll-pass.ts` — spam handling, attribution split, price-record writes,
  decline→exclusion, reversal, review (§5.2); `report.ignored`/counters.
- `src/domain/labels.ts` — (optional) add an `ignored` label + color.
- `src/pipeline/pipeline.test.ts` — cover: named-site records, sender-attribution,
  multi-domain review, spam auto-ignore, decline exclusion, reversal.
- **Green:** pipeline tests.

### Phase 4 — enforcement
- `src/pipeline/send-pass.ts` — domain-exclusion skip (§5.3).
- `src/server/app.ts` — import domain-exclusion skip in `POST /api/targets` (§5.3).
- `src/server/app.test.ts` — cover import skip.
- **Green:** app + send tests.

### Phase 5 — migration (see §8)
- `src/scripts/reset-for-reingest.ts` **(new)** — step 1 (reset) orchestrator.
- Extend fetch/extract scripts: reuse `runFetchPass` for step 2; add `--limit`/`--sleep`
  to the extract driver (`extractPendingReplies` `opts`) for step 3.
- `src/scripts/reset-extractions.ts` — teach it to also purge `pricerecord` +
  `reason:'declined'` `domainexclusion` (so a re-run doesn't double-write), while
  **keeping** `ignore` and `reason:'manual'` exclusions.
- **Green:** `--dry-run` reports sane counts.

### Phase 6 — API (derived views)
- `src/server/app.ts` — `GET /api/domains` (known-domains + latest summary),
  `GET /api/domains/:domain` (full price sheet + history, §4.1), and ignore/exclusion
  CRUD endpoints (list/add/delete).
- `src/server/app.test.ts` — cover the derived sheet + carry-forward/staleness.
- **Green:** app tests.

### Phase 7 — UI (separable; candidate for a subagent/new session once API is frozen)
- `web/src/` — a domain price-history view, ignore-list + domain-exclusion management,
  special-offer badges. Additive.

## 8. Migration — delete + re-scan, resumable

**Context:** `LLM_PROVIDER=claude-code` (`.env`) — extraction shells out to the local
`claude` CLI and bills against the Claude Code usage window. So AI must be decoupled
from fetching and be resumable. The codebase already supports this: `fetch-pass.ts`
ingests with **no AI**; `extractPendingReplies` (`poll-pass.ts:137`) extracts
separately and is checkpointed per-reply via `extractionStatus`.

### Step 1 — reset (no AI, instant) — `reset-for-reingest.ts`
- Delete all `reply` docs, all `pricerecord`, and `reason:'declined'` `domainexclusion`.
- Clear `target.result`; roll `replied`/`excluded` → `contacted` (mirror
  `reset-extractions.ts` logic).
- For each account: set `pollCursor.lastPolledAt = min(outreach.sentAt)` across all
  outreaches; clear `historyId` and `lastUid`.
- **Keep:** `ignore`, `reason:'manual'` `domainexclusion`, `suppression`
  (`addSuppression` is idempotent, so re-scan safely re-adds).
- Offer `--dry-run`.

> ⚠️ **gmail-api caveat:** verify in `src/adapters/email/gmail-api.provider.ts` that
> clearing `historyId` + setting `lastPolledAt` actually forces the **date-based**
> backfill path (the provider owns `historyId`; `poll-pass.ts:96` only merges cursor
> fields). If not, add an explicit "backfill since" entrypoint.

### Step 2 — fetch-only ingest (no AI, one shot) — reuse `runFetchPass`
- Pull every message since the earliest send; store all as `extractionStatus:'pending'`.
- Network-bound, not AI-bound — safe to run start-to-finish in one window.
- After this, the count of `pending` replies **is** the extraction workload — you can
  size step 3 before spending a single AI call.

### Step 3 — extraction (AI, paced) — `extractPendingReplies` with `--limit`
- Process pending replies in batches (`--limit N`, optional `--sleep`).
- State is per-reply (`extractionStatus`), so each run resumes exactly where the last
  stopped — window reset / crash / Ctrl-C safe, idempotent, no re-fetch.
- All the new logic (spam, attribution, named-domain records, decline exclusion) runs
  here, inside the resumable phase.
- Sizing: `claude-code` runs sequentially, `CLAUDE_CODE_TIMEOUT_MS=120000`; estimate
  ~N × (10–30s) and choose `--limit` to fit the window.

**Do NOT** bundle the three steps into one script that extracts inline — that
reintroduces the window problem.

## 9. Testing checklist

- `normalizeDomain`: scheme/www/path/port stripping; subdomains preserved; `casik.com` ≠ `casik.ua`.
- Derived price sheet: latest-per-cell; carry-forward + staleness flag; expired specials drop from active.
- Attribution: named-site (M2) vs sender (M1); 0-domain sender; 2+-domain sender → review (D11).
- Spam → ignore entry (with emailId) + no price records (D7); subsequent message dropped pre-AI.
- Decline → domain exclusion + target excluded (D8); per-cell `no` does NOT exclude.
- Reversal: positive record lifts exclusion (D10).
- Enforcement: excluded domain skipped at send and at import (D9).
- Migration: reset keeps curated data; re-run doesn't double-write; extract is resumable.

## 10. Open items (non-blocking; decide during build)

- **Untagged offer, sender→multi-domain:** currently → review (D11). Confirm we never
  want auto-write-to-all.
- **Re-sending to a re-included domain (D10):** we lift the exclusion and record the
  price, but do we also resume *active outreach*? Default: no (we already have their
  price). Revisit if desired.
- **`ignored` mailbox label:** nice-to-have; skip if it complicates the Gmail label set.
