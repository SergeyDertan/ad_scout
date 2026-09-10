# Storage

Read this when: adding or changing a persisted field or document type, writing a
backfill/maintenance script, changing what a list screen reads, or chasing a 409
or a lost write.

## Mental model

- One port, `Store` (`src/ports/store.ts`), two adapters:
  - `MemoryStore` — the default when `STORE` is unset. Tests, `pnpm demo`,
    `just dev-seed`. Gone when the process exits.
  - `PouchDbStore` — real data, `STORE=pouchdb`, LevelDB files in `POUCH_DIR`
    (default `./data/pouch`).
- Schemaless JSON. Pouch `_id` is `"<type>:<id>"`; `_id`, `_rev` and `type` are
  stripped on read, so domain code never sees them.
- `src/domain/types.ts` is a convention, not a schema. An optional field needs no
  migration: old docs just lack it, and readers must treat "absent" as the old
  meaning (see `Placement.indexedAt`).
- One process owns the store (`data/agent.lock`, `src/lib/lock.ts`). Because it is
  the only writer, the adapter itself emits a change event per write
  (`subscribe`), which is what `/api/stream` (SSE) forwards to the UI.
- Nothing countable is stored as a counter. Daily quota, stats, funnels, batch
  counts and the current price sheet are all derived at read time from the logs
  (Outreach, PriceRecord, targets), so a restart cannot corrupt them.

## Document types

Ids come from `newId(prefix)` → `<prefix>_<uuid>` (`src/lib/ids.ts`) unless a
natural key is listed.

| type | id | lifecycle |
|---|---|---|
| `account` | newId | Mutable. Written by routes AND passes (poll cursor, errors) → always `updateAccount`. |
| `target` | newId | Mutable, canonical per-site status + rolled-up `result`. `updateTarget`. |
| `batch` | newId | Written once per import/manual add. Carries language + advertised-site override. Counts derived. |
| `outreach` | newId | Append-only send log. One doc per attempt; its `status` moves reserved → sent/failed/needs_review. Never deleted. |
| `reply` | newId | Written once at ingest (only via `buildInboundReply`), then updated with `parsed`/`extraction`/`review`. Body and attachments are never re-fetched: lose them at ingest and they are gone. |
| `pricerecord` | newId | Append-only per-domain price observations. Only reset/migration scripts delete. |
| `niche` | `key` | Self-learning registry. Seed set is `DEFAULT_NICHES` in `domain/niches.ts`, merged in by `allNiches()`. |
| `prompt` | `hash` | Archived extraction system prompt. Content-addressed, first write wins. |
| `suppression` | normalized email | Email-level do-not-contact (opt-out, bounce, manual). Survives re-imports. |
| `ignore` | `${kind}:${value}` | Inbound senders dropped before any work (plus seed domains in `domain/ignore-seed.ts`). |
| `domainexclusion` | normalized domain | Outbound do-not-contact by website. A later positive price lifts a `declined` one. |
| `deal` | newId | Human-run negotiation. Holds no thread or domain list. |
| `placement` | newId | One post on one domain inside a deal. The domains of a deal ARE its placements. |
| `threadlink` | `threadId` | Reverse index thread → deal. Kept after the deal closes; the hold is decided by deal status. |

Old stores also hold `campaign:` docs. Nothing reads them and dumps drop them.

Both adapters normalize on write: suppression email, deal `counterpartyEmail`,
placement and exclusion `domain`. Compare with `normalizeEmail`
(`domain/reply-matching.ts`) and `normalizeDomain` (`domain/domain.ts`), never raw
strings. Subdomains are kept (`casik.com` ≠ `ultra.casik.com`).

## Reads

- Every `list*` is a full prefix scan (`allDocs` over `<type>:`) and then a JS
  filter. The filter arguments on `listTargets`/`listOutreaches`/… are not
  indexes. `getReplyByEmailId` scans every reply.
- Point reads are cheap: `get*`, `isSuppressed`, `isDomainExcluded`, `isIgnored`,
  `getThreadLink`. Keep per-message hot paths on these (that is why ThreadLink
  exists).
- Screen payloads are built in `src/services/read-models.ts` (target page, domain
  page and detail, response page, reply debug). Today they load whole collections
  and slice in memory. This is the transitional state tracked in
  `docs/SCALABLE-READS-PLAN.md`; indexed reads (Step 5) are not done yet.
- Pagination contract, `src/services/pagination.ts`:
  - envelope `{ items, page: { limit, total, nextCursor, previousCursor }, facets }`
  - limit default 50, max 100
  - the cursor is opaque base64url holding `(sort value, id)` plus a `scope` string
    built from the filters, so a cursor from another filter set is rejected
    (`PageInputError` → HTTP 400)
  - `paginateSorted` needs `compare` to match the order the rows were sorted in,
    with `id` as the tie-break
- List rows are slim: no reply bodies, no attachment base64. Detail is a point
  read (`GET /api/replies/:id`).

## Writes and concurrency

- `put*` reads the current `_rev` and then writes. Two writers on one doc means
  one gets a 409. `updateAccount`/`updateTarget` re-read and re-apply your
  `mutate` on conflict (up to 10 tries). Use them whenever the new value depends
  on the current doc.
- In the server every writer is serialized by ONE `Mutex` (`passLock` in
  `src/serve.ts`): the send/poll/fetch passes, "Run now", dashboard write routes
  (`deps.writeLock.run(...)` in `server/app.ts`), remote-hub persists, and the
  hourly backup. A new write path must go through it.
- `MemoryStore` never returns 409, so tests do not catch a race PouchDB would hit.
- Idempotency comes from natural keys and dedupe, not transactions:
  - replies dedupe on `emailId`
  - sends are reserved per (target, kind, sequenceNo) before they go out
  - deal-thread-sync dedupes on `rfcMessageId`
  - prompt snapshots are keyed by hash
- `Outreach.rfcMessageId` is not a handle on a Gmail-API send (Gmail replaces
  it); `Outreach.emailId` is. Old rows only have `rfcMessageId`.

## Provenance: why records carry copies

- `Reply.parsed` is overwritten by a re-extraction. So each `PriceRecord` carries
  its own `extraction` (provider, exact model, `promptHash`, `promptStyle`,
  `extractedAt`) and `aiExplanation`, and the history stays self-describing.
- `PromptSnapshot` stores the full system prompt under `promptHash`.
- A hand edit sets `editedByHuman`/`editedAt`; the AI fields stay as they were.
- `Placement.agreedPrice` is a negotiated one-off. It must never reach a
  PriceRecord or the price sheet.
- The current price sheet is folded from PriceRecords at read time by
  `buildPriceSheet` (`domain/price-sheet.ts`) on the cell key `category|term.key`:
  newest mention wins; specials annotate and never replace the standing price.

## Which store am I touching?

- Real data exists only with `STORE=pouchdb`. Since the VPS move, the laptop
  `.env` should stay on memory.
- Shell variables beat `.env` (dotenv does not override). `just dev-seed` relies
  on this.
- `SEED=demo` is fatal at boot unless `STORE=memory` and the email transport is
  dummy (`assertSeedSafe`, `src/lib/seed.ts`).
- PouchDB is single-writer. Any script that opens the store fails on the LevelDB
  lock while `pnpm serve` runs, so stop the server first. Never copy `data/pouch`
  by hand from a running process.
- Production copy for diagnosis: `scripts/fetch-prod-db.sh` (`--backup` for the
  newest consistent hourly dump) → `data/pouch-prod`; then run tools with
  `STORE=pouchdb POUCH_DIR=./data/pouch-prod`. It writes nothing on the VPS.
- Dumps and backups contain every mailbox's OAuth refresh token. Treat them as
  credentials.

## Dump, load, backup

- `DOC_TYPES` in `src/services/dump.ts` is the one table of every type (list +
  put), in load order (parents first). A new doc type missing from it is silently
  dropped by dumps, backups and migrations.
- `pnpm data:dump --out <dir>` writes NDJSON per type plus a manifest.
  `pnpm data:load --in <dir> [--force]` loads it and verifies counts. A count
  mismatch is real: some `put*` normalize or dedupe.
- Hourly backups run inside the server (`src/services/backup.ts`) under `passLock`,
  in the same dump format:
  - tar.gz files in `BACKUP_DIR`
  - keeps today's hourlies plus one per day for `BACKUP_KEEP_DAYS`
  - optional Cloud Storage mirror (`BACKUP_BUCKET`)
  - `BACKUP=off` disables them

## Recipes

**Add a field.** Add it as optional in `domain/types.ts` (and `web/src/types.ts`
if the UI uses it). Set it where the doc is created. Make readers handle "absent"
as the old meaning. If a list shows it, add it to the row type in
`read-models.ts`. Backfill only if old docs genuinely need a value.

**Add a doc type.**
1. Add it to the `DocType` union and add its methods to `Store`.
2. Implement both adapters.
3. Add it to `DOC_TYPES` in `services/dump.ts`.
4. Write tests on `MemoryStore`.
5. Map it to a UI tick if a screen should live-refresh (see `web.md`).

**Maintenance script.** Follow the pattern of `src/scripts/backfill-terms.ts`:
- a header comment saying why the script exists and what to back up first
- `import 'dotenv/config'`, then `loadConfig()` and `buildStore(config)`
- dry run by default, `--apply` to write
- idempotent, so a re-run converges
- register it in `package.json` scripts
- run it with the server stopped

## Tests

- Most store behaviour is exercised through `MemoryStore`.
  `src/pipeline/pipeline.test.ts` also opens a `PouchDbStore` in a temp dir.
- `src/services/pagination.test.ts` covers the cursor contract;
  `src/services/backup.test.ts` covers retention and naming.
