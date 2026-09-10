# Web console (`web/`)

Read this when: changing any screen, the browser API client, live updates,
sign-in, or exports.

## Shape

- Separate workspace package `adscout-web`: React 19, Chakra UI v3, Vite 8,
  TypeScript. It is built to `web/dist` and served statically by the API server
  (`WEB_DIR`, default `./web/dist`). The server returns `index.html` for unknown
  paths, so client URLs survive a refresh.
- Dev:
  - `just dev` (= `pnpm dev:all`) runs the API on :8787 and Vite on :5173. Vite
    proxies `/api` (REST and SSE); `API_TARGET` overrides the proxy target.
  - `just dev-seed` is the same on a throwaway seeded store.
- `pnpm web:typecheck` is separate from the root typecheck. `just check` and CI
  run both; CI also runs `pnpm web:build`.
- Dependencies worth knowing: `react-window` (virtualized lists), `xlsx`
  (exports), `firebase` (sign-in).

## Files

- `main.tsx`: `Provider` (Chakra system from `theme.ts`, `ConfirmProvider`,
  `Toaster`) → `AuthGate` → `App`.
- `App.tsx`: the tab rail (`TABS`, grouped Overview / Outreach / Replies /
  Negotiation / Settings).
  - Every view is `lazy()`-imported and wrapped in `LazyTabContent`.
  - `adminOnly` hides a tab from managers. The server enforces access anyway; this
    only hides controls that could never work.
- `hooks/useRoute.ts`: a tiny History-API router, `/<tab>/<id>` (e.g.
  `/deals/<id>`).
- `hooks/useStream.ts`: the SSE feed read via `fetch` + a stream reader. Not
  `EventSource`, which can't send the `Authorization` header; a token in the
  query string would leak into logs. Reconnects with jittered backoff.
- `hooks/useResource.ts`:
  - `useResource` for small unpaged lists
  - `usePagedResource` keeps one server page
  - both abort superseded requests, ignore stale responses, and reload when
    `tick` changes
- `api.ts`: every server call, typed, through `req<T>()` (JSON + auth headers).
  `apiBase.ts`: `API_ORIGIN` (`VITE_API_ORIGIN`; empty means same origin) and
  `setTokenProvider` (a Firebase ID-token provider, asked on each call because
  tokens expire hourly).
- `types.ts`: a hand-kept mirror of the server types, only the fields the UI
  uses. No codegen: change both sides together.
- `AuthGate.tsx`, `session.ts`, `role.ts`, `firebase.ts`: Firebase Google sign-in
  and the role (`useRole` / `useIsManager`).
- `components/`: one file per view (Overview, Targets, Batches, Run, Responses,
  Domains, Deals, Accounts, Labels, Suppressions, Ignore), plus dialogs, forms and
  primitives (`Panel`, `Confirm`, `Toaster`, `Empty`, `StatusBadge`, `TierBadge`,
  `StatCards`, `icons`). `DealsView.tsx` is the largest: a messenger-style deal
  thread with placements.
- `export/`: client-side exports (xlsx, html, a standalone template). The domains
  export is page-scoped until server-side exports exist (read plan, Step 7).
- Pure helpers with tests: `niche-answer.ts`, `quoted-text.ts`, `attachments.ts`.

## Live updates

- The server emits `{ type, action, id }` per store write.
- `App.onChange` refreshes `/api/status`, then bumps a per-type tick: `batch`,
  `account`, `target`, `reply`, `suppression`, `deal`. `placement` and
  `threadlink` map to `deal`.
- Any OTHER type (outreach, pricerecord, niche, ignore, domainexclusion, prompt)
  bumps every tick, so all mounted views refetch. Add a tick before a new view
  starts reacting to a busy type.
- Each view receives the sum of the ticks it depends on (e.g. Domains:
  `reply + target`). Too few and it goes stale; too many and it refetches
  constantly.
- Refreshing only the active query (read plan, Step 6) is not done yet.

## Paginated lists (Targets, Responses, Domains)

- Server side: `GET /api/{targets,responses,domains}/page` return
  `PageEnvelope<Row, Facets>`. The contract is in `store.md` → Reads.
- The client keeps one page. The cursor is stored with the `filterKey` it belongs
  to and dropped when filters change (see `pageCursor` in `ResponsesView.tsx`).
- Search goes through `useDeferredValue`. The server caps filter choice lists
  (100 recent batches, 500 niches, plus the currently selected one).
- Still unpaged: the Batches screen and the Overview batch selector
  (`/api/batches`), a known follow-up in `docs/SCALABLE-READS-PLAN.md`.

## Recipes

**Add a view.**
1. Create `components/XView.tsx` exporting `XView({ tick })`.
2. Add a `lazy()` import, a `TABS` entry (`adminOnly` if managers must not see
   it) and a `LazyTabContent` block in `App.tsx`.
3. Pass the right ticks.

**Call a new route.** Add a typed function to `api.ts` using `req<T>()`, add or
extend its types in `types.ts`, and build the server side (`server.md` → add an
API route).

**Add a paginated list.**
- Server: a read model + `paginateSorted` + validation with `PageInputError`.
- Client: a query builder in `api.ts`, and `usePagedResource` with a fetcher
  memoized on filters and cursor. Reset the cursor when filters change.

## Gotchas

- Visited lazy tabs stay mounted, to keep their filters. Inactive ones must be
  `display: none`; `LazyTabContent` does that. Never render `Tabs.Content`
  directly (the panel-stacking bug, e8a971a).
- Chakra UI is v3 (namespaced components like `Tabs.Root`, `Tabs.Content`).
  v2 examples do not apply.
- Vite 8 / rolldown only accepts the function form of `manualChunks`.
- There is no DOM test setup. Web tests are pure `node:test` files under
  `web/src/**/*.test.ts`, run by the root `pnpm test` and type-checked by the
  root `tsconfig.json`. `LazyTabContent.test.ts` uses `renderToStaticMarkup`.
