# Console latency — findings and plan

Why the operator console takes a few seconds to show most screens, what was
measured, and the ranked fix list.

> Status: **partly done; kept as a record, not maintained.** Measured 2026-09-07
> against the live VPS store (95.216.149.252, `/opt/adscout`). Line numbers below
> are from that date. Read performance is now tracked in
> [SCALABLE-READS-PLAN.md](./SCALABLE-READS-PLAN.md). Of the fixes in §4:
> - **Done:** fix 2 (the responses list is paged and slim) and fix 4 (static
>   assets cached immutably).
> - **Not done:** fix 1 (read cache in `PouchDbStore`) and fix 5 (index price
>   records by domain in `buildDomainRows`).
> - **Decided the other way:** fix 3. Visited tabs deliberately stay mounted
>   (hidden) to keep their filters, so the refetch fan-out in §3.4 still
>   applies.

---

## 1. How this was measured

Not inferred from the code — measured. The live PouchDB store was copied to a
scratch directory on the VPS (`cp -r /opt/adscout/data/pouch /tmp/...`, so the
running service kept its LevelDB lock), and the **real** handler code was timed
against that copy with `tsx`: `PouchDbStore` plus the actual `read-models.ts`
and `domain/*` functions each route calls. Payload sizes are
`Buffer.byteLength(JSON.stringify(...))` of what the route would send.

Reproduce it with a throwaway script that imports `PouchDbStore` pointed at a
copy of the store; do not point it at `data/pouch` while the service is up.

Browser-side numbers are **missing**: the profile used had no session, and
signing in was out of scope. Everything below is server-side plus one
`curl` RTT measurement.

## 2. What the numbers are

Store at time of measurement: **14,862 docs / 19 MB on disk.**

| type | docs | JSON |
|---|---|---|
| outreach | 5,384 | 6.25 MB |
| target | 5,257 | 5.92 MB |
| reply | 2,070 | 12.02 MB |
| pricerecord | 1,848 | 3.72 MB |
| everything else | 303 | 0.15 MB |

Cost of listing one collection once, LevelDB cache warm:

| collection | rows | ms |
|---|---|---|
| outreach | 5,384 | 555 |
| target | 5,257 | 493 |
| reply | 2,070 | 278 |
| pricerecord | 1,848 | 176 |

Per endpoint — server-side build time and the payload it would send:

| endpoint | build | payload |
|---|---|---|
| `GET /api/responses` | 912 ms | **12.2 MB** |
| `GET /api/accounts` | 899 ms | 8 KB |
| `GET /api/domains` | 612 ms | 1.2 MB |
| `GET /api/status` | 537 ms | 1 KB |
| `GET /api/targets` | 287 ms | **5.3 MB** |
| `GET /api/batches` | 273 ms | 3 KB |
| `GET /api/suppressions` | 21 ms | 8 KB |
| `GET /api/deals` | 1 ms | 1 KB |

Network RTT to the box is ~230 ms (three `curl` runs against `/`, TTFB 227–407 ms).

So one Responses load is ~230 ms RTT + ~900 ms build + `JSON.stringify` of
12 MB + nginx gzip of 12 MB + transfer. That is the few seconds.

## 3. The causes, in the order they cost

### 3.1 There is no cache anywhere in the read path

`PouchDbStore.listByType` (`src/adapters/store/pouchdb.store.ts:130`) runs
`allDocs({ include_docs: true })` over a key range and deserializes the whole
collection **on every call**. Nothing is memoized. Every filter is a JS
`.filter()` applied *after* the full scan — `listTargets`, `listOutreaches`,
`listPlacements`, `listPriceRecords`, and `getReplyByEmailId` all load
everything first.

The route handlers then call several of those per request.
`GET /api/accounts` (`src/server/app.ts:431`) lists accounts + outreaches +
targets + replies: four full scans, ~1.5 M rows of JSON parsing, for an 8 KB
answer.

This is the single dominant cost and it is not a storage problem — the whole
dataset is ~28 MB of JSON.

### 3.2 The payloads are huge

`GET /api/responses` ships all 2,070 replies with full bodies: 12.2 MB.
`GET /api/targets` ships all 5,257 targets: 5.3 MB. No pagination, no field
projection. The UI virtualizes the *rendering* (react-window in
`ResponsesView.tsx:432` and `DomainsView.tsx:776`) but still downloads
everything to do it.

### 3.3 One single-threaded process does all of it

The server, the drip scheduler and the extraction hub share one Node process.
Those 500–900 ms are CPU-bound JSON parsing that blocks the event loop, so
concurrent requests do not overlap — they queue behind each other.

### 3.4 Refetch fan-out on every store change

`web/src/App.tsx:436` passes `lazyMount` to `Tabs.Root` **without**
`unmountOnExit`. Every view visited since page load stays mounted and keeps its
`useResource` subscription live.

The tick wiring means one `reply` write bumps `ticks.reply`, which refires
Overview + Responses (12 MB) + Domains + Deals + Ignore, plus `refreshStatus()`
— five heavy calls, roughly 3 s of serialized server work, for one changed
document. `PouchDbStore.emit` fires per `put`, so a poll pass writing replies in
a burst outruns the 150 ms debounce in `useStream.ts` and the console sits in a
permanent loading state for the length of the pass.

### 3.5 `buildDomainRows` is quadratic

`src/services/read-models.ts:85` calls `buildPriceSheet(domain, records, now)`
once per known domain, and `buildPriceSheet` opens with
`records.filter(r => r.domain === domain)` over the whole array
(`src/domain/price-sheet.ts:77`). Known domains are price-record domains ∪
target domains, so that is ~4,500 × 1,848.

Smaller than the I/O today, but it grows with the *product* of two collections
that both grow.

### 3.6 Static assets carry no cache headers

`serveStatic` (`src/server/app.ts:1200`) sends `Content-Type` and nothing else —
no `Cache-Control`, no `ETag`, no `Last-Modified` — and re-reads the file from
disk on every request. Vite emits content-hashed filenames, so every one of them
could be `immutable`. Instead each hard reload re-downloads ~1.1 MB of JS
(~230 KB gzipped, ~0.5 s).

nginx compression itself is fine: `gzip_proxied any`, level 6, and
`application/json` is in `gzip_types`, so API responses do go over the wire
compressed.

### 3.7 The box is small and was busy

2 vCPU, 7.7 GB RAM with 6.6 GB used, load average 2.40/1.46/1.20 at the time of
measurement. `hidepid` blocked attributing that load to a process, so treat this
as context rather than a conclusion — but there is no CPU headroom to absorb
§3.1.

## 4. The fixes, ranked by leverage

1. **In-memory read cache in `PouchDbStore`, invalidated on write.** ~28 MB of
   JSON fits in RAM with room to spare. `listByType` caches per type;
   `put` / `update` / `delete` drop that type's entry. This turns 500–900 ms
   into ~0 ms and fixes every endpoint at once — roughly 30 lines in one file,
   and the only change that touches the actual bottleneck. Note the store is
   already documented as sole-writer (`pouchdb.store.ts` header), which is what
   makes a naive invalidation correct here.
2. **Trim `GET /api/responses`.** Drop raw email bodies from the list payload;
   the UI already has `GET /api/replies/:id` for the detail modal. 12.2 MB → a
   few hundred KB.
3. **Add `unmountOnExit` to `Tabs.Root`** so only the visible view refetches.
   Costs the "view keeps its filters once visited" behaviour that `lazyMount`
   was chosen for — worth checking whether the filter state should be lifted
   before doing this.
4. **Cache headers in `serveStatic`**: `public, max-age=31536000, immutable` for
   `/assets/*` (hashed names), `no-cache` for `index.html`.
5. **Index price records by domain once** in `buildDomainRows` instead of
   re-filtering per domain.

1–4 are independent of each other. 1 is the one that moves the needle; 2 and 4
shrink the wire; 3 stops the multiplication.

## 5. Not the problem

Ruled out during the survey, so nobody re-checks them:

- **nginx compression** — on, correctly configured for proxied JSON (§3.6).
- **Auth** — `verifyIdToken` caches Google's public certs in-process, and
  `checkRevoked` is deliberately off (`src/server/auth.ts:118`). No per-request
  round trip.
- **Render cost** — the two big lists are virtualized already.
- **TLS / DNS / connection setup** — ~230 ms RTT total, flat across runs.
