# AdScout — Usage Guide

How to operate AdScout: mailboxes, importing targets, sending, reading replies and
running deals. For how the code works, see [`CLAUDE.md`](../CLAUDE.md) and
[`docs/claude/`](./claude). For the production box, see
[VPS-DEPLOY.md](./VPS-DEPLOY.md).

---

## 1. What it does

1. **Sends** a short, templated email in English, Spanish or Portuguese to each
   target site, asking for its guest-post rates (standard and grey niches). It
   sends from several Gmail mailboxes, paced across a daily send window.
2. **Reads** the replies, matches each one to the site it answers, and has Claude
   extract the prices into a per-domain price history.
3. **Hands over to a person** for the negotiation that follows. While a deal is
   open, the system stores that conversation and touches nothing else in it.

---

## 2. Where it runs

> **The deployed server is the VPS, and it is the only instance that sends
> email.** A local run — even against a copy of the live data — must keep
> `EMAIL_PROVIDER` unset, or it would email real publishers from the real
> mailboxes, behind the VPS's back.

- **Production** runs on the VPS, at the console URL. Sign in with Google:
  - `ADMIN_EMAILS` accounts can do everything.
  - `MANAGER_EMAILS` accounts can read everything and run deals, but can't import
    targets, touch mailboxes or start send passes.
- **Local** runs on your laptop:
  - `just dev-seed` gives a throwaway console with demo data. It can't persist
    anything or send mail. This is the safe way to try things.
  - `just dev` uses whatever `.env` configures. Keep the laptop on
    `STORE=memory` with `EMAIL_PROVIDER` unset; the real data lives on the VPS.
  - Open http://localhost:5173.

---

## 3. The console

| Screen | Purpose |
|---|---|
| **Overview** | The state of the operation: the funnel and outcomes, optionally for one batch. |
| **Targets** | Every site in the queue. Filter by status or batch, search, add one, or import many. |
| **Batches** | Each import: its language, advertised site, size and status breakdown, and a preview of its email. |
| **Run** | Start a pass now: **Send pass**, **Poll pass** (fetch + extract), **Fetch responses** (fetch only). Admin only. |
| **Responses** | Every inbound reply: match method, extraction result, review flags. **Edit extraction** / **Debug extraction** / **Start a deal on this thread**. |
| **Domains** | The price sheet per domain (current price per niche and duration), its history, and specials. |
| **Deals** | Human-run negotiations: the thread, placements, payment and publishing. |
| **Accounts** | Sending mailboxes: status, today's count and rate, results, limits, Gmail connection. |
| **Labels** | Legend for the `AS/…` labels the system applies in Gmail. |
| **Suppressions** | Emails that must never be contacted (opt-outs, bounces, manual). |
| **Ignore** | Inbound senders dropped without processing (spam, notifications). |

The live indicator in the header shows the update feed: **Live** means screens
refresh by themselves.

---

## 4. Mailboxes (Accounts)

**Add one:** email, sender name, max daily limit (default 40) and an optional
signature. The credential ref is derived from the address (`outreach@gmail.com`
→ `GMAIL_OUTREACH`) unless you type one.

**New accounts start `paused`.** Only `active` accounts send. Activate an account
when it is connected and ready.

**Connect it to Gmail**, one of two ways:
- **Gmail API (OAuth), preferred.** Needs the server's Google OAuth client
  (`client_secret.json`, or `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`). Use the
  account's OAuth / connect action and finish Google's consent screen. Only these
  accounts get `AS/…` labels in Gmail and can send attachments in deals.
- **App password (SMTP/IMAP).** Turn on 2-Step Verification, create an app
  password, and put it in `.env` under the account's credential ref:
  `GMAIL_OUTREACH_USER=…` and `GMAIL_OUTREACH_PASS=…`. Without a Google OAuth
  client configured, every mailbox uses this path.

Real mail also needs `EMAIL_PROVIDER` set (unset or `dummy` = nothing is really
sent or read).

**Daily limit.** The limit is
`min(daily limit override ?? warmup ramp, max daily limit)`.
- The ramp starts at 5/day and adds 5 every 3 days, up to 40.
- Counts come from the send log and reset at **local midnight**.
- Deal messages are counted, but never blocked by the limit.

**Statuses:**
- `active`: sends and is polled.
- `paused`: neither sends nor is polled.
- `cooldown`: a health state.

The health rules (pause on auth errors, cooldown on a high bounce rate) exist but
are **not applied automatically**. Watch bounces in Suppressions and the
account's last error, and pause by hand.

---

## 5. Targets and batches

**Import** (Targets screen) creates a **batch** and asks for:
- **Batch name**, which labels the import.
- **Email language:** English, Spanish or Portuguese (Portugal). It sets the
  subject and message for the whole batch.
- **Advertised site / description** (optional). It overrides the global default
  for this batch's emails.
- **Rows:** paste `website, email, name` per line (tab-, comma- or
  double-space-separated), or upload an Excel/CSV file. Columns are found by
  header (`website`/`url`/`domain`/`site`, `email`, `contact name`); without
  headers they are taken by position.

**Add target** adds a single site: website, contact email, optional contact name
and notes. Notes are added as a line in that site's email.

Each target starts **`pending`**. At send time, suppressed emails and excluded
domains are skipped automatically.

---

## 6. Sending

- While the server runs, the scheduler **drips** sends inside the send window
  (`SEND_WINDOW_START_HOUR`–`SEND_WINDOW_END_HOUR`, default 09–18, **local time**;
  the server must have `TZ` set). It spreads each account's remaining quota
  across the window with random gaps.
- **Run → Send pass** sends everything allowed right now. It still respects
  limits, suppressions and exclusions.
- A send is reserved before it goes out. A crash mid-send is resolved at the next
  boot (found in the mailbox → sent; not found → `needs_review`) and never
  re-sent automatically.
- Follow-ups (no-reply bumps) are **off** (`FOLLOW_UPS_ENABLED=false`).

**Target statuses:**
- `pending`: queued
- `reserved`: mid-send
- `contacted`: sent
- `replied`: substantive answer
- `excluded`: opted out or declined
- `bounced`
- `needs_review`: a send couldn't be confirmed after a crash

---

## 7. Replies and prices

- Mailboxes are checked every 5 minutes (`POLL_INTERVAL_MS`). Replies are stored,
  matched (Gmail thread first, then sender address) and labelled.
- **Extraction** needs a logged-in `claude` CLI. In production that is the
  **remote worker** on your Mac ([REMOTE-QUICKSTART.md](./REMOTE-QUICKSTART.md)).
  Replies wait as pending until a worker is running. **Run → Poll pass**
  extracts only where `claude` is available.
- What the extraction does:
  - It records guest-post prices only (link insertions and banners are ignored),
    per niche and per duration.
  - It reads linked Google Sheets/Docs/PDFs and attachments.
  - Anything it couldn't read is flagged for review.
- Opt-outs are suppressed, blanket declines exclude the domain, and spam senders
  go to the ignore list.
- If a price looks wrong, open the reply: **Debug extraction** shows what the
  model saw and why it decided. **Edit extraction** corrects it; the edit is
  marked as human-made.
- **Domains** shows the current price sheet per domain, built from the whole
  history: the newest quote per niche and duration wins, and specials are shown
  alongside the standing price.

---

## 8. Deals

Open a deal with **Start a deal on this thread** from a reply, or with **Start a
deal** on the Deals screen.

**While a deal is open** (`negotiation` or `fulfilment`), messages on its threads
are stored and shown, but never extracted or turned into prices, exclusions or
suppressions. Closing the deal (`done` or `closed`) lifts that.

**Write replies from the deal view.** They go out threaded from the deal's
mailbox. Replies you send from the Gmail app are picked up into the timeline
too.

**Placements** are one per domain in the deal:
- the content (text or a link)
- the agreed price, which is never added to the price history (it is a one-off
  figure, not the site's rate)
- the payment method
- paid, live and indexed, each recorded as a date

---

## 9. Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| Nothing sends | No `active` account, outside the send window, quota used up, or `EMAIL_PROVIDER` unset. |
| Account won't send or receive | Not connected (OAuth not finished, or `<REF>_USER` / `_PASS` missing), or it is `paused`. |
| Replies stay pending | No remote worker running, or it stopped after repeated failures (see REMOTE-QUICKSTART). |
| A reply shows review flags | A linked sheet wasn't public, or an attachment type can't be read. Open it and edit the extraction by hand. |
| Sends at odd hours | The server's time zone is wrong. Set `TZ` (the VPS pins `Europe/Kyiv`). |
| Live indicator stuck on Reconnecting | The API isn't reachable (locally: is `just dev` running?). |
| Blank page locally with `pnpm serve` | `web/dist` isn't built. Run `pnpm build`. |
| `agent already running (pid …)` | Another server or hub holds `data/agent.lock`. Stop it; a stale lock from a dead process is reclaimed automatically. |
| Data gone after restart (local) | `STORE=memory`. That is the intended local default. |
