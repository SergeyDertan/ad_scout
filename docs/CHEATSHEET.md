# AdScout — Cheat Sheet

Terse reference. Full version: [`USAGE.md`](./USAGE.md) · internals:
[`ARCHITECTURE.md`](./ARCHITECTURE.md).

## Run

```bash
pnpm install            # whole workspace (server + web)
pnpm build              # web → web/dist  (do this before serve)
pnpm serve              # :8787  (lock → reconcile → HTTP/SSE → drip scheduler)
pnpm demo               # one in-memory cycle, no UI/services
pnpm typecheck && pnpm test   # 60 tests, zero external deps
```

Dev (two terminals): `pnpm dev` (API :8787, watch) + `pnpm web:dev` (Vite :5173,
proxies `/api`). Overrides: `PORT`, `WEB_DIR`.

## Providers (`.env`, default = all dummy/in-memory)

| Var | Values | Activate |
|---|---|---|
| `LLM_PROVIDER` | dummy · ollama · openai · claude | claude → `pnpm add @anthropic-ai/sdk` |
| `EMAIL_PROVIDER` | dummy · smtp-imap | `pnpm add nodemailer imapflow` |
| `STORE` | memory · pouchdb | `pnpm add pouchdb` |

Other env: `OLLAMA_BASE_URL/MODEL`, `OPENAI_API_KEY/MODEL`,
`ANTHROPIC_API_KEY/CLAUDE_MODEL`, `SEND_WINDOW_START_HOUR/END_HOUR` (9–18),
`POUCH_DIR`, `RECONCILE_GRACE_MS` (15m).

Gmail = `smtp-imap` + app password. Creds by credentialRef:
`<REF>_USER` / `<REF>_PASS` (UI derives `GMAIL_<LOCALPART>`). Optional `<REF>_HOST`
/ `_SMTP_PORT` / `_IMAP_PORT` (default Gmail 465/993).

## Gotchas

- **Only `active` accounts send.** New accounts start `warming` → click
  **Activate** (one click; maps to `/resume`).
- **`Account.providerType` is cosmetic** — transport is global via `EMAIL_PROVIDER`
  (no OAuth `gmail-api` adapter; Gmail goes through `smtp-imap`).
- **Build before serve** — `serve` serves `web/dist`; stale/missing = blank UI.
- **Scheduler sends only inside the window + with quota.** Warmup ramp =
  5/day +5 every 3d, cap 40 (or `dailyLimitOverride`). Counts derived from the
  append-only log (restart-safe; reserve-before-send = no dupes).
- **Health rules (`evaluateHealth`) exist but aren't auto-wired** — bounces show
  in Suppressions; pause/limit manually.
- LLM is used **only for reply extraction**; drafting is template-based.

## Flow

`pending → reserved → contacted` → (`replied` | `excluded`/opt-out |
`bounced` | `needs_review`). Follow-ups while `contacted`. Reply match order:
threadId → fromAddress → unmatched.

## API (same origin; SSE `/api/stream`)

```
GET  /api/status                              GET/POST /api/campaigns
GET/POST /api/accounts                        PATCH /api/accounts/:id
POST /api/accounts/:id/pause|resume           DELETE /api/accounts/:id
GET/POST /api/targets?status=                 DELETE /api/targets/:id
GET  /api/responses | /api/suppressions       POST /api/run/send | /run/poll
```

## Change what, where

drafting `services/drafter.ts` · extraction `domain/extraction.ts` +
`services/extractor.ts` · limits/warmup `domain/limits.ts` + `warmup.ts` ·
pacing `scheduler/window.ts` · routes `server/app.ts` · provider wiring
`lib/factory.ts` + `adapters/…`.
