# Server, auth and operations

Read this when: adding or changing an API route, touching auth or roles, the
remote extraction hub, boot/shutdown, env config, deploys, or one-off scripts.

## Boot (`src/serve.ts`)

1. `applyTimezone()`, before any clock read (the window and quota are local-time).
2. `loadConfig()` (`src/config.ts`) from `.env` via dotenv. Shell env wins.
3. File logging: daily JSONL in `logs/`; `LOG_DIR=off` disables it.
4. `acquireLock(data/agent.lock)`. A second process exits. A stale pid is reclaimed.
5. `buildAgent(config)` (`src/lib/factory.ts`): the one place concrete
   store/email/LLM adapters are chosen.
6. If `SEED=demo`: `assertSeedSafe`, then seed.
7. `runReconcile`.
8. `createApiServer` (:`PORT`, default 8787), the hourly `BackupService`, and
   `DripScheduler` (send loop = send pass, poll loop = fetch pass).
9. The remote hub on :`REMOTE_PORT` (8788), unless `REMOTE_HUB=off`. If
   `REMOTE_TOKEN` is unset it logs an error and stays off.
10. All of it shares one `Mutex` (`passLock`). Shutdown on SIGTERM/SIGINT stops
    the loops, closes the store and releases the lock.

`BIND_HOST=127.0.0.1` on the VPS (nginx and the SSH tunnel come in over
loopback). Unset means all interfaces, which is right for a laptop.

## HTTP API (`src/server/app.ts`)

- Plain `node:http`, no framework. Dispatch is one long `if` chain on
  `method` + `seg` (the path split on `/`) under `seg[0] === 'api'`. The header
  comment lists the routes; keep it current.
- Responses go through `sendJson(res, status, body)`; errors are `{ error }`.
  Input validation throws `PageInputError` → 400.
- Writes run inside `deps.writeLock.run(...)` (the shared `passLock`).
- Route groups:

| group | routes |
|---|---|
| auth, status | `auth`, `status`, `stream` (SSE) |
| accounts | `accounts` (+ PATCH, DELETE, `pause`, `resume`, `rollback-cursor`), `oauth/start`, `oauth/callback` |
| targets, batches | `targets` (legacy list), `targets/page`, `targets/:id/thread`, `batches`, `preview` (renders the outreach template) |
| replies | `replies/:id` (GET, PATCH hand edit, DELETE), `replies/:id/debug`, `responses` (legacy), `responses/page` |
| domains, prices | `domains`, `domains/page`, `domains/:domain`, `niches`, `prompts`, `prompts/:hash` |
| lists | `suppressions`, `ignore`, `exclusions` |
| deals | `deals`, `deals/:id` (+ PATCH, DELETE), `deals/:id/threads`, `deals/:id/placements`, `deals/:id/messages`, `placements/:id` |
| passes | `POST run/send`, `run/poll`, `run/fetch` |

- Anything outside `/api` is static `web/dist`, with `index.html` for unknown
  paths.

## Auth and roles (`src/server/auth.ts`)

- Off unless `ADMIN_EMAILS` or `MANAGER_EMAILS` is set; then
  `FIREBASE_PROJECT_ID` is required. Local runs leave these unset and stay open.
- Every `/api` request needs `Authorization: Bearer <Firebase ID token>` with a
  verified email on an allowlist. Verification uses Google's public certs, so no
  service-account key is needed.
- There is no loopback exemption, on purpose: behind nginx every request comes
  from 127.0.0.1.
- Two roles:
  - `admin`: everything.
  - `manager`: `mayAccess` is default-deny. It allows every GET, `POST preview`,
    and writes under `deals`/`placements`. `oauth/*` is denied outright.
- A new write route is admin-only until you add it to `mayAccess` on purpose.
- `/api/auth` is the public health check that `just release` and `just restart`
  curl. `/api/status` answering 401 from outside means auth is on (correct).

## Remote extraction hub (`src/server/remote-hub.ts`)

- It exists because extraction needs a logged-in `claude` subscription the VPS
  cannot hold. Workers (`pnpm remote:worker` on a desktop) dial in with
  `REMOTE_TOKEN` and never listen.
- Protocol:
  - `POST /work/claim` returns an `ExtractInput`
  - the worker runs `extractReplyCore`
  - `POST /work/:id/result` → `persistExtraction` under the lock
- Leases re-queue anything a worker doesn't report back. After
  `REMOTE_MAX_FAILED` (10 in serve) failed replies the hub stops handing out
  work until a restart. It says so loudly in the log.
- `pnpm remote:hub` is a standalone hub for bulk re-extracts; stop `serve` first
  (single writer). See `docs/REMOTE-EXTRACTION.md` and
  `docs/REMOTE-QUICKSTART.md`.
- Not an adversarial boundary. Never expose it without `REMOTE_TOKEN`, and never
  publish the dashboard port in its place.

## Config (`src/config.ts`, `.env.example`)

- **Providers:**
  - `LLM_PROVIDER` (dummy | ollama | openai | claude | claude-code | antigravity)
    with per-provider model vars
  - `CLAUDE_CODE_MODEL`: use an exact id, it is provenance
  - `EMAIL_PROVIDER` (unset/dummy = no real mail)
  - `STORE` (memory | pouchdb), `POUCH_DIR`, `DATA_DIR`
- **Pitch:** `ADVERTISED_URL`, `ADVERTISED_DESCRIPTION`, `PITCH_TOPIC`,
  `PITCH_FORMAT`, `SUBJECT_TEMPLATE` (English only). A batch can override site and
  language.
- **Sending:** `SEND_WINDOW_START_HOUR`/`END_HOUR`/`PACE_END_HOUR`,
  `FOLLOW_UPS_ENABLED` (false), `FOLLOW_UP_AFTER_DAYS`, `FOLLOW_UP_MAX`,
  `RECONCILE_GRACE_MS`, `POLL_INTERVAL_MS` (5 min), `TZ`.
- **Gmail OAuth:** `GOOGLE_CLIENT_ID`/`SECRET` or `client_secret.json`. SMTP
  accounts use `<credentialRef>_USER`/`_PASS`; secrets never live on documents.
- **Server:** `PORT`, `BIND_HOST`, `WEB_DIR`, `LOG_DIR`, `LOG_RETENTION_DAYS`,
  `ADMIN_EMAILS`, `MANAGER_EMAILS`, `FIREBASE_PROJECT_ID`.
- **Hub:** `REMOTE_TOKEN`, `REMOTE_PORT`, `REMOTE_HUB`, `REMOTE_MAX_FAILED`,
  `REMOTE_HUB_URL` (worker side).
- **Backups:** `BACKUP`, `BACKUP_DIR`, `BACKUP_KEEP_DAYS`, `BACKUP_INTERVAL_MS`,
  `BACKUP_BUCKET`.

## Deploy and operations

- **Flow:**
  1. Push to `main`.
  2. GitHub Actions (`.github/workflows/deploy.yml`) runs typecheck,
     web:typecheck, test and web:build.
  3. The deploy job SSHes in and runs `deploy/deploy.sh`, which repeats the gate
     on the box and rolls back if the new revision doesn't answer.
- **`just` recipes:**
  - `just release`: gate locally, push, watch the run, curl
    `https://<host>/api/auth`
  - `just redeploy`: same revision
  - `just restart`: after editing `.env` on the box
  - `just deploy-ssh`: when Actions is down
  - `just status` / `logs` / `boot-log` / `backups` / `fetch-backup`
- **Box:** `/opt/adscout`, systemd unit `deploy/adscout.service`:
  - `TZ=Europe/Kyiv`
  - `PrivateTmp`
  - `ProtectSystem=strict`, with `ReadWritePaths` `data`, `logs`, `backups`,
    which must exist before start
  - nginx (Hestia) in front, with the hub mounted at `/hub`
- Long procedures: `docs/VPS-DEPLOY.md`, `docs/RELEASE-SETUP.md`.

## Scripts (`src/scripts/`)

- One-off maintenance, audit and backfill tools, each registered in
  `package.json` and run with `tsx`.
- They open the configured store directly, so on real data they need
  `STORE=pouchdb` and the server stopped.
- Pattern: see `store.md` → Recipes.
- `sample-extract.ts`, `compare-providers.ts` and `e2e-research-extract.ts` call
  real LLMs and are not part of `pnpm test`.

## Never

- Send real email from anywhere but the VPS. Locally, `EMAIL_PROVIDER` stays
  unset, even with `STORE=pouchdb` on a copy of the live data (`data/pouch-prod`).
- Run dev or a script against the live store by accident. Check `STORE` /
  `POUCH_DIR` first; locally prefer `just dev-seed`.
- Start `SEED=demo` with a real store or transport. It is fatal, by design.
- Run `git clean -x` in the app dir or the repo: `data/`, `backups/` and `.env`
  are gitignored and would be deleted.
- Expose port 8788 without `REMOTE_TOKEN`, or bind a public host to all
  interfaces.
- Run `just release`, `redeploy`, `restart` or `deploy-ssh` unless asked. They
  ship to production.
- Add a write route without the write lock and a conscious `mayAccess` decision.

## Add an API route

1. Add an `if (method === … && seg[1] === …)` block in the `/api` section of
   `app.ts`, and a line in the header comment.
2. Validate input and throw `PageInputError` (400) on bad values. Do writes
   inside `deps.writeLock.run`.
3. Decide manager access in `mayAccess` (`auth.ts`); cover it in `auth.test.ts`.
4. Add a test in `src/server/app.test.ts` (deal routes: `deals-api.test.ts`).
5. Web: a typed call in `web/src/api.ts` and types in `web/src/types.ts`.
