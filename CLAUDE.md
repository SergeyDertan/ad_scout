# AdScout

A cold-outreach agent. It emails website owners asking for guest-post rates,
reads their replies, extracts prices with an LLM into a per-domain price history,
and supports human-run deals. The TypeScript server is in `src/`; the React
console is in `web/`.

**The deployed server is the VPS** (`/opt/adscout`), deployed from `main` by CI.
A laptop is for development only: a local store is a copy or a demo, and a local
run must never send real email.

## Commands

```bash
just check        # typecheck + web:typecheck + test — what CI runs; run before any commit
just dev-seed     # API :8787 + Vite :5173 on a throwaway seeded store — the safe local run
just dev          # same, on whatever .env configures
pnpm test         # node:test via tsx; single file: node --import tsx --test path/to/x.test.ts
pnpm web:build    # web → web/dist (served by the API server)
```

`just release` / `redeploy` / `restart` / `deploy-ssh` ship to production. So
does a plain `git push` to `main` (CI deploys it). Never do any of them unless
asked.

## Where things live

| area | path |
|---|---|
| domain rules (pure, no I/O) | `src/domain/` |
| ports (interfaces) | `src/ports/` (store, email, llm) |
| adapters | `src/adapters/{store,email,llm}/` |
| wiring (the only place that picks adapters) | `src/lib/factory.ts` |
| passes: send, fetch, poll, reconcile, deals | `src/pipeline/` |
| drip scheduler, send window | `src/scheduler/` |
| drafting, extraction, read models, backup | `src/services/` |
| HTTP API + SSE, auth, remote hub | `src/server/` |
| boot | `src/serve.ts` · env: `src/config.ts`, `.env.example` |
| one-off maintenance scripts | `src/scripts/` |
| console | `web/src/` (views in `components/`, client in `api.ts`, types in `types.ts`) |

## Read before you touch

Short, verified notes. Read the one that matches the task instead of
re-deriving it from code:

- Persisted data, doc types, reads/pagination, 409s, backfills, dumps →
  `docs/claude/store.md`
- Sending, ingest, extraction, deals, limits, time zone, adapters →
  `docs/claude/pipeline.md`
- API routes, auth/roles, remote hub, boot, env, deploy, scripts →
  `docs/claude/server.md`
- Screens, live updates, paginated lists, web gotchas → `docs/claude/web.md`

Guides for people (also useful to you):
- `docs/USAGE.md`: operating the console
- `docs/VPS-DEPLOY.md`, `docs/RELEASE-SETUP.md`: the box and deploys
- `docs/REMOTE-QUICKSTART.md`, `docs/REMOTE-EXTRACTION.md`: the extraction worker

Active tracker: `docs/SCALABLE-READS-PLAN.md`.

Design records: historical and not maintained, kept because code comments cite
their sections: `overview.md`, `docs/PRICE-HISTORY-PLAN.md`,
`docs/REMOTE-ADMIN-PLAN.md`, `docs/PERFORMANCE-PLAN.md`. Where they disagree
with the notes above, the notes win.

## Rules that are easy to break

- **Local never sends real mail.** The VPS is the only instance that sends.
  - On a laptop keep `EMAIL_PROVIDER` unset (dummy), whatever store you use.
  - That includes `data/pouch-prod`: it is a copy of live data, so its targets
    and mailboxes are real.
  - A local send would email real publishers from the real accounts, invisible
    to the VPS's quota and records.
  - `just dev-seed` enforces this; `just dev` and scripts do not.
- **Which store.** `STORE` unset = memory. Real data only with `STORE=pouchdb`.
  PouchDB is single-writer: stop `pnpm serve` before a script opens the store.
  Shell env beats `.env`.
- **One write lock.** Every store writer in the server goes through `passLock`
  (routes use `deps.writeLock.run`). Use `updateAccount` / `updateTarget` when a
  write depends on the current doc. `MemoryStore` never 409s; PouchDB does.
- **Derived, not stored.** Quota, stats, funnels and price sheets are computed
  from append-only logs (Outreach, PriceRecord). Don't add counters.
- **Deal hold.** Messages on an open deal's threads are stored and nothing else.
  Every ingest/extraction path must check `heldDeal` / `openDealThreadIds`.
- **Extraction provenance.** Editing `buildSystem` in `services/extractor.ts`
  moves `promptHash` on purpose. Keep model ids exact (no `sonnet` alias).
- **Extraction runs from a private temp dir** (`adapters/llm/neutral-cwd.ts`), so
  this CLAUDE.md never reaches publisher-reply prompts. Don't point it back at
  the repo.
- **Local time.** The send window and quota reset use the process clock; servers
  need `TZ`.
- **Types are mirrored by hand**: `src/domain/types.ts` ↔ `web/src/types.ts`.
- **New doc type** → also `DOC_TYPES` in `src/services/dump.ts`, or backups
  silently drop it.
- **New write route** → admin-only until you add it to `mayAccess`
  (`src/server/auth.ts`).

## Code conventions

- Hexagonal: domain code is pure (no I/O, no `Date.now()`); time comes from an
  injected `Clock` (`fixedClock` in tests).
- Comments explain WHY: the incident, the trade-off, the trap. Match that density
  in files that already have it. File headers say what a module is for.
- Tests: `node:test` + `node:assert/strict`, a sibling `*.test.ts` file,
  `MemoryStore` plus dummy or hand-built providers. No network in `pnpm test`.
- ESM, TypeScript strict, `tsx` at runtime; Node ≥ 26, pnpm ≥ 11.
- Runtime dependencies are few and chosen deliberately (plain `node:http`, lazy
  imports for heavy SDKs). Ask before adding one.
- Commit subjects: one plain-English sentence in the imperative saying what
  changed for the user ("Paginate the targets feed"). No type prefixes.

## Keeping these notes true

Update the note in the same change as the code:

| you changed | update |
|---|---|
| `src/adapters/store/`, `src/ports/store.ts`, `src/domain/types.ts`, `src/services/{read-models,pagination,dump,backup}.ts` | `docs/claude/store.md` |
| `src/pipeline/`, `src/scheduler/`, `src/domain/`, `src/services/{drafter,extractor,linked-docs,account-selector}.ts`, `src/adapters/{email,llm}/`, `src/ports/{email,llm}-provider.ts` | `docs/claude/pipeline.md` |
| `src/server/`, `src/serve.ts`, `src/config.ts`, `src/lib/`, `deploy/`, `.github/`, `justfile`, `.env.example`, `package.json` | `docs/claude/server.md` |
| `web/` | `docs/claude/web.md` |
| a new area, command or rule listed in this file | `CLAUDE.md` |
| what an operator sees or sets up | `docs/USAGE.md`, `README.md` |

When is an update needed? Only when the change alters something the note says,
or should say: a flow, rule, route, command, env var, doc type or gotcha. Pure
refactors and test-only changes need none.

A Stop hook (`.claude/hooks/doc-sync.mjs`, same map) checks this at the end of a
turn and asks once per change set. Answer it either by updating the note or by
saying in one line why none is needed.

A wrong note is worse than none: if a note disagrees with the code, fix the note.
