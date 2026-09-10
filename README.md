# AdScout

A cold-outreach agent. It:
- emails website owners asking for their guest-post rates
- reads the replies and extracts the prices with Claude into a per-domain price
  history
- gives a person a console to run the negotiations that follow

**The deployed server is the VPS.** It is the only instance that sends email. A
laptop is for development and for the extraction worker, and a local run must
never send real email: keep `EMAIL_PROVIDER` unset locally, even against a copy
of the live data.

## Documentation

| read | for |
|---|---|
| [docs/USAGE.md](./docs/USAGE.md) | operating the console: accounts, imports, sending, replies, deals |
| [docs/REMOTE-QUICKSTART.md](./docs/REMOTE-QUICKSTART.md) | running the extraction worker on a machine with a Claude subscription (background: [REMOTE-EXTRACTION.md](./docs/REMOTE-EXTRACTION.md)) |
| [docs/VPS-DEPLOY.md](./docs/VPS-DEPLOY.md) | the production box: systemd, nginx/TLS, secrets, the data migration |
| [docs/RELEASE-SETUP.md](./docs/RELEASE-SETUP.md) | one-time setup for `just release`, and what to do when a deploy fails |
| [CLAUDE.md](./CLAUDE.md) + [docs/claude/](./docs/claude) | how the code works: storage, pipeline, server, web. Written for Claude Code, readable by anyone. |

Also:
- **Active tracker:** [docs/SCALABLE-READS-PLAN.md](./docs/SCALABLE-READS-PLAN.md).
- **Design records** (historical, not maintained):
  [overview.md](./overview.md),
  [PRICE-HISTORY-PLAN](./docs/PRICE-HISTORY-PLAN.md),
  [REMOTE-ADMIN-PLAN](./docs/REMOTE-ADMIN-PLAN.md),
  [PERFORMANCE-PLAN](./docs/PERFORMANCE-PLAN.md).

## Quick start

Needs Node 26 and pnpm 11 (`.tool-versions`). `just` on its own lists every
recipe.

```bash
just install     # pnpm install, whole workspace
just dev-seed    # API :8787 + Vite :5173 on a throwaway seeded store — can't persist or send
just dev         # the same, on whatever .env configures
just check       # typecheck + web:typecheck + test — what CI runs
just release     # gate, push, watch the deploy, verify the live site (setup: RELEASE-SETUP.md)
```

Open http://localhost:5173 in dev. `pnpm build && pnpm serve` serves the built
console from the API itself on http://localhost:8787.

## Layout

A pnpm workspace:
- The root package `adscout` is the server (`src/`), run from TypeScript with
  `tsx`.
- `web/` is the console (`adscout-web`: React + Chakra UI). It is built to
  `web/dist` and served by the server.
- `pnpm test` runs the server tests and the web logic tests with `node:test`.

## Configuration

Copy `.env.example` to `.env`. The defaults are safe: an in-memory store, dummy
email and a dummy LLM, so nothing persists and nothing is sent.
- Real data needs `STORE=pouchdb`.
- Real mail needs `EMAIL_PROVIDER` plus a connected Gmail account. Set it on the
  VPS only.
- Extraction uses `LLM_PROVIDER=claude-code` with a logged-in `claude` CLI.

Every variable is listed in `.env.example` and, grouped by purpose, in
[docs/claude/server.md](./docs/claude/server.md) (section "Config").
