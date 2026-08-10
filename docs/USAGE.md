# AdScout — Usage Guide

A practical, end-to-end guide to running AdScout: installing it, configuring
providers, managing Gmail accounts, queueing targets, and operating the outreach
loop. Already know the project? Use the terse
[`CHEATSHEET.md`](./CHEATSHEET.md) instead. For how the code is organized and
why, see [`ARCHITECTURE.md`](./ARCHITECTURE.md). For the original design
rationale, see [`../overview.md`](../overview.md).

---

## 1. What AdScout does

AdScout is a local AI outreach agent. You give it:

- **Campaigns** — what you're advertising and the questions to ask each site.
- **Accounts** — the mailboxes (typically personal Gmail with an app password)
  it sends from, each with its own sender identity and daily limit.
- **Targets** — the websites/contacts to reach out to.

It then, on a paced schedule:

1. Drafts and sends an initial outreach email (and timed follow-ups).
2. Polls the inbox for replies, matching each reply back to its target.
3. Uses an LLM to extract a structured result from each reply (can they publish?
   price? categories? …) and rolls it up onto the target.
4. Honors opt-outs and bounces via a persistent do-not-contact list.

Everything runs on your machine. With the default settings it runs end-to-end
with **no external services** (in-memory store + stubbed email + stubbed LLM),
so you can try the whole flow before wiring real providers.

---

## 2. Prerequisites

- **Node.js ≥ 26** (see `.nvmrc` / `.tool-versions` → `26.3.1`). Check with
  `node -v`.
- **pnpm ≥ 10** (this repo is a pnpm workspace; pinned via `packageManager` and
  `.tool-versions` → `10.34.3`). Check with `pnpm --version`. If you use
  Corepack: `corepack enable`.
- Optional, only when you activate real providers:
  - Gmail sending/reading → `pnpm add nodemailer imapflow`
  - Local LLM → an Ollama install; cloud LLM → an OpenAI or Anthropic key
  - Persistence → `pnpm add pouchdb`

---

## 3. Install & run

The repo is a **pnpm workspace** with two packages:

- the **server** (root `package.json`, name `adscout`) — the API, pipeline, and
  scheduler, run directly from TypeScript via `tsx` (no build step);
- the **front-end** (`web/`, name `adscout-web`) — a Vite + React + Chakra UI
  app with its own dependencies and build.

A single `pnpm install` at the root installs both packages.

### Option A — quick taste (no UI, no external services)

```bash
pnpm install       # installs the workspace
pnpm demo          # seeds a campaign + account + targets, runs one full cycle
```

`demo` runs reconcile → send → (simulated reply) → poll → extract entirely
in-memory and prints the extracted result. Great for confirming the pipeline
works; extraction is stubbed unless you set a real `LLM_PROVIDER`.

### Option B — run the app with the dashboard

Build the front-end once, then start the server (it serves the built UI):

```bash
pnpm install       # installs the workspace (server + web)
pnpm build         # builds web/ → web/dist
pnpm serve         # boots the server on http://localhost:8787
```

Open **http://localhost:8787**.

### Option C — front-end development (hot reload)

Run the API and the Vite dev server side by side in two terminals:

```bash
pnpm dev           # terminal 1: API on :8787 (watch/restart on change)
pnpm web:dev       # terminal 2: Vite on :5173, proxies /api → :8787
```

Open **http://localhost:5173** — UI edits hot-reload; REST + SSE are proxied to
the backend.

### Useful scripts

| Script | What it does |
|---|---|
| `pnpm serve` | Boot the server (lock → reconcile → HTTP/SSE → scheduler). Serves `web/dist`. |
| `pnpm dev` | Same as serve but restarts on server source changes. |
| `pnpm demo` | One-shot in-memory pipeline demo. |
| `pnpm build` | Build the front-end into `web/dist`. |
| `pnpm web:dev` | Vite dev server (proxies `/api`). |
| `pnpm web:build` | Build the front-end only. |
| `pnpm remote:hub` | Serve unextracted replies to worker machines, plus the dashboard (stop `pnpm serve` first). |
| `pnpm remote:worker` | On a second machine: extract replies for a hub using that machine's Claude subscription. Setup: [REMOTE-QUICKSTART.md](REMOTE-QUICKSTART.md) · how it works: [REMOTE-EXTRACTION.md](REMOTE-EXTRACTION.md). |
| `pnpm typecheck` / `pnpm test` | Type-check / run the server test suite (60 tests). |

> **Port:** set `PORT` to change `8787`. **UI location:** set `WEB_DIR` to serve
> a different built directory.

---

## 4. The dashboard

The UI has five tabs, a live status line, and a connection indicator
(`live` / `reconnecting`) driven by a Server-Sent-Events feed — any change in
the system (a send, a reply, an edit) refreshes the relevant tab automatically.

| Tab | Purpose |
|---|---|
| **Accounts** | Add and manage sending mailboxes (Gmail). Pause/resume, daily-limit override, delete. |
| **Targets** | Add targets to the outreach queue, filter by status, remove. |
| **Responses** | Inbound replies, how each matched, and the extracted result. |
| **Suppressions** | The persistent do-not-contact list (opt-outs and bounces). |
| **Run** | Manually trigger a send pass or a poll pass and watch the JSON report. |

---

## 5. Campaigns (set this up first)

A **campaign** is the advertising context plus the *single source of truth for
the questions* asked of every site. A target must belong to a campaign, so you
need at least one before queueing targets.

A campaign carries:

- `name`
- `advertised` — `{ url, description }` of what you're promoting
- `topic` and `format` (e.g. `casino` / `article`)
- `inquiryFields` — the questions to ask (each has a `key`, `question`, and a
  `type`: `price` · `text` · `list` · `enum` · `boolean`). These drive **both**
  the drafted email body and the structured reply extraction.
- optional `followUp` policy — `{ afterDays, maxFollowUps }`

**Creating one:** the simplest path today is from the **Targets** tab. Open
*“+ Add target”*; if no campaign exists yet, click *“Create default campaign”*.
For a richer campaign (custom inquiry fields, follow-up policy), `POST
/api/campaigns` directly (see §10) — the inquiry fields are what make the drafted
emails and extraction useful, so it's worth defining them deliberately.

---

## 6. Managing Gmail accounts

### 6.1 Add an account (UI)

**Accounts → “+ Add Gmail account”** and fill in:

| Field | Notes |
|---|---|
| **Email** | The Gmail address you send from. |
| **Sender name** | Display name on outgoing mail (e.g. `Vlad`). |
| **Credential ref** | The **name** of the env var holding the secret (never the secret). Leave blank to auto-derive `GMAIL_<LOCALPART>` — e.g. `outreach@gmail.com` → `GMAIL_OUTREACH`. |
| **Max daily limit** | Hard ceiling on sends/day (default 40). |
| **Signature** | Optional sign-off appended to the body. |

The account is created with `providerType: gmail-api` (informational only — see
§7) and status **`warming`**.

### 6.2 Provide the app password (one-time, in `.env`)

Credentials live in `.env`, referenced by the account's **credential ref** — the
secret itself is never stored on the account record. For Gmail:

1. Enable 2-Step Verification on the Google account.
2. Create an **App Password** at <https://myaccount.google.com/apppasswords>.
3. In `.env`, for an account whose credential ref is `GMAIL_OUTREACH`:

   ```bash
   GMAIL_OUTREACH_USER=outreach@gmail.com
   GMAIL_OUTREACH_PASS=abcd efgh ijkl mnop   # the 16-char app password
   ```

4. Set `EMAIL_PROVIDER=smtp-imap` (see §8) and install the transport packages:
   `pnpm add nodemailer imapflow`.

Defaults target Gmail (`smtp.gmail.com:465`, `imap.gmail.com:993`). For a
non-Gmail host, override per account: `<REF>_HOST`, `<REF>_SMTP_HOST/_SMTP_PORT`,
`<REF>_IMAP_HOST/_IMAP_PORT`. (See [`../.env.example`](../.env.example).)

### 6.3 Activate the account so it sends ⚠️

**Only `active` accounts send.** A freshly added account is `warming` and will be
skipped by the send pass until you activate it. On the Accounts tab, any account
that isn't active shows a one-click **Activate** button (it becomes **Pause**
once active). Activating maps to `POST /api/accounts/:id/resume`.

> The *warmup ramp* (how many emails/day a young account may send) is separate
> from status — it's based on the account's age and rises automatically (see
> §6.4). Status is the on/off gate; the ramp is the volume limiter.

### 6.4 Daily limits & the warmup ramp

Each account's effective daily cap is:

```
min( dailyLimitOverride ?? warmupRamp(ageInDays), maxDailyLimit )
```

The default ramp starts at **5/day**, adds **+5 every 3 days**, capped at **40**
— so a new account eases in automatically. To override, type a number into the
**daily limit** field on the Accounts tab (blank = use the ramp). Sends are
counted from the append-only log over a rolling 24h window, so the limit is
robust across restarts.

### 6.5 Pause / resume / delete

- **Pause** → status `paused`; the account stops sending **and** stops being
  polled for replies.
- **Activate** → status `active` (shown for any non-active account: `warming`,
  `paused`, or `cooldown`).
- **Delete** → removes the account (sent/queued history in the log is kept).

---

## 7. `providerType` vs `EMAIL_PROVIDER` (important)

The active email transport is chosen **globally** by the `EMAIL_PROVIDER` env var
(`dummy` or `smtp-imap`) — not per account. The `Account.providerType` field
(`gmail-api` / `smtp-imap`) is currently **informational**; there is no OAuth
`gmail-api` adapter yet. Personal Gmail is handled by the **`smtp-imap`**
provider via an app password. So: to actually send through Gmail, set
`EMAIL_PROVIDER=smtp-imap` regardless of what an account's `providerType` says.

---

## 8. Choosing providers (`.env`)

Copy [`../.env.example`](../.env.example) → `.env` and set the three selectors.
The project builds and runs with **zero external packages**; to activate a real
provider, install its package(s) and flip the env var.

| Variable | Values | Activate with |
|---|---|---|
| `LLM_PROVIDER` | `dummy` (default) · `ollama` · `openai` · `claude` | `claude` → `pnpm add @anthropic-ai/sdk` |
| `EMAIL_PROVIDER` | `dummy` (default) · `smtp-imap` | `smtp-imap` → `pnpm add nodemailer imapflow` |
| `STORE` | `memory` (default) · `pouchdb` | `pouchdb` → `pnpm add pouchdb` |

### LLM (used for reply extraction only)

- **dummy** — deterministic, no network; returns schema-valid stub data.
- **ollama** — local server; set `OLLAMA_BASE_URL` (default
  `http://localhost:11434`) and `OLLAMA_MODEL`. Uses native structured outputs.
- **openai** — set `OPENAI_API_KEY` and `OPENAI_MODEL` (default `gpt-4o-mini`).
  Uses `json_schema` structured outputs.
- **claude** — set `ANTHROPIC_API_KEY` and `CLAUDE_MODEL` (default
  `claude-opus-4-8`).

> Drafting outgoing email is **template-based and does not use the LLM** — the
> LLM is only invoked to parse inbound replies.

### Email

- **dummy** — records sends, hands out deterministic thread ids, lets the
  pipeline run with no mailbox (used by `demo`/tests).
- **smtp-imap** — real send (nodemailer) + read (imapflow). Handles Gmail via app
  password; reads Gmail's native thread ids (`X-GM-THRID`) for reliable reply
  matching.

### Store

- **memory** — in-process; everything is lost on restart. Fine for trials.
- **pouchdb** — local on-disk persistence under `POUCH_DIR` (default
  `./data/pouch`).

### Sending window & pacing

```bash
SEND_WINDOW_START_HOUR=9    # inclusive, local time
SEND_WINDOW_END_HOUR=18     # exclusive
```

Within the window, the scheduler **drips** sends — it spreads each account's
remaining daily quota across the time left in the window, with randomized gaps
(30s floor, 20m ceiling, ±30% jitter) instead of bursting.

---

## 9. Adding targets & running outreach

### 9.1 Queue targets

**Targets → “+ Add target”**:

| Field | Notes |
|---|---|
| **Website** | The site you're pitching (e.g. `egamersworld.com`). |
| **Contact email** | Where the outreach is sent. |
| **Campaign** | Pick the campaign this target belongs to. |
| **Contact name** | Optional; used in the greeting. |
| **Notes** | Optional; injected as a short hook in the email. |

New targets start as **`pending`**. Filter the list by status, and **Remove** a
target to drop it from the queue.

### 9.2 Let the scheduler work — or run manually

- **Automatic:** while `serve` is running, the drip scheduler sends within the
  window and polls for replies on a fixed cadence (default every 60s). Nothing
  to do.
- **Manual:** the **Run** tab (or `POST /api/run/send` · `/api/run/poll`)
  triggers a full send pass or poll pass immediately. Manual passes still respect
  daily caps and the suppression list.

> Reminder: targets only get contacted if there's at least one **`active`**
> account with remaining quota, and (for the scheduler) the current time is
> inside the send window.

---

## 10. Status reference

### Target lifecycle

```
pending ──send──▶ reserved ──delivered──▶ contacted ──┐
   ▲                  │                                │ reply
   └── send failed ◀──┘                    ┌───────────┼───────────┬──────────────┐
                                           ▼           ▼           ▼              ▼
                                        replied     excluded     bounced     needs_review
                                                   (opt-out)
```

- **pending** — queued, not yet contacted.
- **reserved** — a send slot is held (briefly, mid-send).
- **contacted** — initial email sent; eligible for follow-ups.
- **replied** — a reply arrived and was extracted (see the result).
- **excluded** — the contact opted out (also added to suppressions).
- **bounced** — delivery failed (also added to suppressions).
- **needs_review** — a reserved send couldn't be confirmed at startup (never
  auto-resent; see §11).

### Account status

- **warming** — created but **not sending** yet; activate to start.
- **active** — sending (subject to limits & window).
- **paused** — not sending, not polled.
- **cooldown** — a health state (see §12).

### Responses tab

Each inbound reply shows the **match method** (`threadId` — reliable, native
Gmail threading; `fromAddress` — matched by sender; `unmatched` — couldn't be
tied to a target), the extraction status, and the parsed `can post` plus the
typed field values.

---

## 11. Reliability & operations

- **Single instance:** `serve` takes a PID lock file (`./data/agent.lock`). A
  second instance refuses to start; a stale lock (dead PID) is reclaimed.
- **Restart safety (reconcile):** on startup AdScout reconciles in-flight sends.
  A `reserved` outreach older than the grace period (`RECONCILE_GRACE_MS`,
  default 15m) is looked up in *All Mail* by its self-set Message-Id — if found
  it's marked `sent` (with the recovered thread id), if not it's flagged
  `needs_review`. **It never auto-resends**, so a crash mid-send can't double-send.
- **Idempotency:** every (target, kind, sequence) reserves before sending, so
  running a send pass repeatedly (or starting the app several times a day) won't
  send duplicates.
- **Derived counts:** daily usage is computed from the append-only outreach log,
  not stored counters — restarts can't corrupt it.
- **Persistence:** use `STORE=pouchdb` to keep data across restarts; with
  `memory` everything resets.

---

## 12. Account health (implemented, not yet automatic)

The health rules — auth/security send error → **pause**; bounce rate over 10%
(with ≥10 samples in the window) → **cooldown** — are implemented and unit-tested
in the domain core, but are **not yet auto-applied** by the running pipeline.
Today, watch the **Suppressions** tab (bounces accumulate there) and the account
`lastError`, and pause/limit accounts manually. (Wiring `evaluateHealth` into the
passes is a planned step.)

---

## 13. API quick reference

The UI is a thin client over this JSON API (same origin; SSE at `/api/stream`).

| Method & path | Purpose |
|---|---|
| `GET /api/status` | Counts + wired provider names. |
| `GET /api/campaigns` · `POST /api/campaigns` | List / create campaigns. |
| `GET /api/accounts` · `POST /api/accounts` | List / create accounts. |
| `PATCH /api/accounts/:id` | Update `dailyLimitOverride` / `maxDailyLimit` / `senderName` / `signature`. |
| `POST /api/accounts/:id/pause` · `/resume` | Pause / activate. |
| `DELETE /api/accounts/:id` | Remove an account. |
| `GET /api/targets?status=` · `POST /api/targets` | List (filterable) / queue targets. |
| `DELETE /api/targets/:id` | Remove a target. |
| `GET /api/responses` | Replies enriched with target website + parsed result. |
| `GET /api/suppressions` | Do-not-contact list. |
| `POST /api/run/send` · `/run/poll` | Trigger a pass now. |
| `GET /api/stream` | Server-Sent-Events change feed. |

Example — queue a target via curl:

```bash
curl -X POST http://localhost:8787/api/targets \
  -H 'Content-Type: application/json' \
  -d '{"websiteUrl":"egamersworld.com","contactEmail":"info@egamersworld.com"}'
```

---

## 14. Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| Dashboard loads but is empty / 404 at `/` | `web/dist` not built. Run `pnpm build`, then `pnpm serve`. |
| `live` indicator stuck on `reconnecting` | The API isn't reachable. In dev, ensure `pnpm dev` is running (the Vite proxy targets `:8787`). |
| Added an account but nothing sends | Account is `warming` — activate it (§6.3). Also check it's inside the send window and has quota. |
| `Missing GMAIL_…_USER / …_PASS` error on send | The app-password env vars for that account's credential ref aren't set (§6.2). |
| Sends fail with auth/“suspicious activity” | Use a Gmail **app password**, not the account password; ensure 2-Step Verification is on. |
| Replies never appear | `EMAIL_PROVIDER` must be `smtp-imap` (dummy can't read a real inbox); the account must not be `paused`. |
| Extraction shows stub data | `LLM_PROVIDER=dummy`. Set `ollama` / `openai` / `claude` for real parsing. |
| “agent already running (pid …)” | Another `serve` holds the lock. Stop it, or remove a stale `./data/agent.lock`. |
| Data gone after restart | You're on `STORE=memory`. Switch to `pouchdb`. |
