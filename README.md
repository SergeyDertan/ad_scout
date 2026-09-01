# AdScout

Local AI outreach agent.

## Documentation

- [**docs/CHEATSHEET.md**](./docs/CHEATSHEET.md) — terse quick reference
  (commands, env, gotchas) for when you already know the project.
- [**docs/USAGE.md**](./docs/USAGE.md) — install, configure providers, manage
  Gmail accounts, queue targets, and operate the outreach loop.
- [**docs/ARCHITECTURE.md**](./docs/ARCHITECTURE.md) — code structure, the logic
  in each layer, data model, and key flows.
- [**docs/REMOTE-ADMIN-PLAN.md**](./docs/REMOTE-ADMIN-PLAN.md) — giving a
  second person write access to deals: the code survey, the options weighed,
  and the agreed shape (Firebase auth + a VPS host). Design, not yet built.
- [`overview.md`](./overview.md) — the original design document.

## Quick start

This is a **pnpm workspace** (`pnpm-workspace.yaml`): the root is the server
package `adscout`; the front-end is the `adscout-web` package under `web/`. One
`pnpm install` at the root installs both.

```bash
pnpm install           # installs the whole workspace (server + web)
pnpm typecheck         # tsc --noEmit
pnpm test              # node --test via tsx  (60 tests)
pnpm demo              # end-to-end pipeline demo (dummy adapters, in-memory)
pnpm build             # build the web/ front-end into web/dist
pnpm serve             # boot the HTTP/SSE server + drip scheduler, open localhost:8787
```

`demo` seeds a campaign + account + targets, runs a send-pass, simulates a
reply, runs a poll-pass, and prints the extracted result — all in-memory.

`serve` does lock → reconcile → HTTP server (default port `8787`, set `PORT`) →
drip scheduler. It serves the built dashboard from `web/dist` — run
`pnpm build` once first (or `WEB_DIR=...` to point elsewhere).

### Front-end (separate module)

The UI is its own Vite + React + **Chakra UI** module under [`web/`](./web),
independent of the server (own `package.json`, build, dependency tree). Its deps
install with the workspace `pnpm install`.

```bash
pnpm web:build         # production build → web/dist (served by `pnpm serve`)
pnpm web:dev           # Vite dev server on :5173, proxies /api → :8787 (run `pnpm dev` too)
```

For local development run the API (`pnpm dev`) and the Vite dev server
(`pnpm web:dev`) side by side, then open `http://localhost:5173` — edits hot-reload
and `/api` (REST + SSE) is proxied to the backend. For a single-port deploy,
`pnpm build` then `pnpm serve` and open `http://localhost:8787`.

## Architecture (ports & adapters)

- **Pure domain core** (`src/domain/`) — warmup, limits, health, reply-matching,
  extraction parsing. No I/O, fully unit-tested.
- **Ports** (`src/ports/`) — `EmailProvider`, `Store`, `LlmProvider`.
- **Adapters** (`src/adapters/`):
  - LLM: `dummy` (default, deterministic) · `ollama` · `openai` (both via `fetch`) ·
    `claude` (official `@anthropic-ai/sdk`, lazy-loaded).
  - Email: `dummy` (default) · `smtp-imap` (nodemailer + imapflow, lazy-loaded).
  - Store: `memory` (default) · `pouchdb` (lazy-loaded).
- **Pipeline** (`src/pipeline/`) — `reconcile`, `send-pass`, `poll-pass`.
- **Server** (`src/server/app.ts`) — `node:http` API mirroring the Store port +
  SSE change feed (`GET /api/stream`); serves the built dashboard from `web/dist`.
  CRUD for accounts (create / pause / resume / patch / delete), targets
  (create / delete / filter), and campaigns (list / create).
- **Scheduler** (`src/scheduler/`) — in-process drip: spreads each account's
  daily quota across the send window with jittered gaps; independent poll loop.
  Timers + randomness are injected so the loops are deterministically tested.
- **Web UI** (`web/`) — separate **Vite + React + Chakra UI** module. Tabs:
  Accounts (add/manage Gmail accounts, daily-limit override, pause/resume/delete),
  Targets (add to queue / filter / remove), Responses, Suppressions, Run — all
  with live SSE updates.
- **Factory** (`src/lib/factory.ts`) — the only place that knows concrete adapters.

The real provider/store/email code is fully written; the lazy `import()` boundary
means the project builds and tests with **zero external packages installed**. To
activate a real one, install its package and flip the env var.

## Switching providers

Copy `.env.example` → `.env` and set:

| Var | Values | To activate, also run |
|---|---|---|
| `LLM_PROVIDER` | `dummy` (default) · `ollama` · `openai` · `claude` | `pnpm add @anthropic-ai/sdk` (claude only) |
| `EMAIL_PROVIDER` | `dummy` (default) · `smtp-imap` | `pnpm add nodemailer imapflow` |
| `STORE` | `memory` (default) · `pouchdb` | `pnpm add pouchdb` |

Account credentials live in `.env` and are referenced by `Account.credentialRef`
(the env var **name**, never the secret).

## What's not built yet

CLI scripts (`add-account`, `import-targets`) and a real persistence smoke test
against PouchDB. (Accounts and targets are now managed from the web UI, which
adds them via the JSON API.)
