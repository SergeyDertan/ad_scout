# Scalable console reads — migration tracker

The console must remain bounded when the store grows to hundreds of thousands
of replies and around a million domains/targets. A virtualized list is not a
data boundary: the browser must never download or retain an entire collection.

This file is the durable hand-off for the migration. Update the status and the
verification notes in the same commit as each step.

## Target architecture

- List endpoints return an envelope: `{ items, page: { limit, nextCursor,
  previousCursor, total }, facets }`.
- Cursors are opaque and based on a stable `(sort value, id)` pair. Offset
  pagination is not used because writes between pages would skip/duplicate rows.
- Search, filters, sorting, counts, and facets run on the server.
- List DTOs contain only fields rendered in the table. Bodies and attachment
  content are point reads from detail endpoints.
- The client retains one page and a short cursor history, not an ever-growing
  infinite-scroll array.
- SSE invalidates only the active query or refreshes one visible row.
- The storage implementation must answer each page from an index; a full scan
  followed by slicing is transitional and is not considered scale-ready.
- Full exports are generated/streamed by the server and never assemble the
  complete dataset in browser memory.

## Decisions

- Default page size: 50; hard maximum: 100.
- Default ordering: newest replies/targets first; domain alphabetic unless the
  user selects another server-supported sort.
- Keep legacy unpaged endpoints temporarily for scripts/tests while each UI is
  migrated. Remove them only after every consumer uses the paged contract.
- Storage choice is deferred until the bounded client contract is in place.
  PostgreSQL is the preferred million-row destination; indexed materialized
  PouchDB read documents are acceptable only as an explicitly measured bridge.

## Progress

- [x] Baseline measurements recorded in `docs/PERFORMANCE-PLAN.md`.
- [x] Fingerprinted static assets cached immutably; HTML revalidates.
- [x] Tab implementations code-split and loaded on first visit.
- [x] Superseded list requests aborted and stale responses ignored.
- [x] Step 1 — shared cursor/envelope types, validation, and tests.
- [x] Step 2 — Responses: server filtering/paging, slim rows, direct detail read,
      bounded client page, and export behavior made explicit.
- [x] Step 3 — Targets: server filtering/paging/counts and bounded client page.
- [x] Step 4 — Domains: server filtering/sorting/paging and bounded client page.
- [ ] Step 5 — replace transitional scans with indexed/materialized reads.
- [ ] Step 6 — type-aware SSE invalidation for the active query only.
- [ ] Step 7 — server-side streaming/background exports.
- [ ] Step 8 — remove legacy unpaged list APIs and remeasure production p50/p95.

## Current caveats

- Until Step 5, paged endpoints may still scan in server memory. That protects
  the browser immediately but does not meet the final server latency target.
- Exact totals can become expensive at very large scale. The first contract
  includes them for current UI parity; Step 5 may maintain them incrementally.
- Any page migrated before Step 7 can still be refetched by the existing broad
  SSE tick wiring, though each response is bounded.

## Verification log

### 2026-09-09 — Steps 1–2

- Responses UI retains one 50-row page and sends search, batch, niche, answer,
  and state filters to `GET /api/responses/page`.
- Cursor carries the ordered `(receivedAt, id)` boundary plus its query scope;
  a cursor cannot be reused after filters change.
- Response list rows omit `text`, attachments, message IDs, subject, and
  extraction provenance. `GET /api/replies/:id` is now a direct store read.
- On the provided 1,835-reply backup, a 50-row envelope is 24,959 bytes versus
  10.31 MiB for the legacy full response feed. Transitional server build time
  is still 536 ms because it scans the store; Step 5 owns that remaining cost.
- Root/web typechecks, the production web build, and the full 436-test suite
  passed.

### 2026-09-09 — Step 3

- Targets UI retains one 50-row page and sends status, batch, unbatched, and
  search filters to `GET /api/targets/page`.
- Target list rows omit notes, account assignment, and the rich extraction
  result; the table receives only `canPost` from that result.
- Status totals and batch counts are computed on the server. Target and
  Responses filters now receive at most 100 recent batch choices (plus an older
  currently selected batch), eliminating their unbounded `/api/batches` reads.
- Root/web typechecks, the production web build, and the full 437-test suite
  passed.

### 2026-09-09 — Step 4

- Domains UI retains one 50-row page. Domain search, state, sensitivity tier,
  niche answer/inference, and all table sorting now run through
  `GET /api/domains/page`.
- Opaque cursors include the complete filter and sort scope. The endpoint caps
  taxonomy filter choices at 500 while preserving an older selected niche.
- Domain detail/history remains a point read. Until Step 7, the existing export
  is explicitly labeled “Export page” and cannot grow with the full dataset.
- Root/web typechecks, focused API tests, the production web build, and the full
  437-test suite passed.

## Acceptance targets

- No list response contains more than 100 rows.
- No reply list response contains raw body text or attachment base64 content.
- Page navigation remains stable while new rows arrive.
- A detail click performs one point lookup.
- Browser memory stays roughly flat while paging through results.
- Warm indexed list endpoint p95 is below 100 ms on the production host.
