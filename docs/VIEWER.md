# The shared read-only viewer

Giving a coworker the domains, the prices, and the emails behind them — without
giving them the mailboxes, the pipeline, or write access to anything.

---

## 1. What this is

The app is local: PouchDB on one machine, no hosting. A second person needs to
read the price data and the replies it came from, and nothing else. So instead
of hosting the app, we **publish a snapshot** of what they need and serve a
read-only build of the same UI on top of it.

```
your Mac (unchanged)                          Firebase
┌────────────────────────────┐                ┌──────────────────────────────┐
│ gmail polling, extraction  │                │ Hosting: viewer.html + JS    │
│ PouchDB (source of truth)  │                │  (public shell, NO data)     │
│                            │  publish       │                              │
│ SnapshotPublisher ─────────┼───────────────►│ Storage /snapshot/*.json     │
│  (change-driven, debounced)│   one-way      │  (allowlist-gated, read-only)│
└────────────────────────────┘                │                              │
                                              │ Firestore /viewers/{uid}     │
                                              │  (their niche settings)      │
                                              └──────────────────────────────┘
```

**One-way by construction.** The publisher uploads; nothing downloads back into
the pipeline. No credential, mailbox, outreach body or send capability is ever
part of a snapshot.

**Hosting is public — the data is not.** Firebase Hosting has no per-user auth,
so anyone with the URL loads the page. It contains no data. Every byte comes
from Cloud Storage, which requires a signed-in account on the allowlist in
`storage.rules`. That file is the only thing protecting the emails.

---

## 2. Sensitivity is the viewer's own call

Locally, `sensitive` is baked into every offer at extraction time from our niche
registry. The viewer's owner classifies niches **himself**, so:

- the publisher forces `sensitive: false` on every offer, cell, record and niche
  (`src/services/snapshot.ts`), shipping only the niche *key* and label;
- the viewer stamps his own answers back on as data is read
  (`web/src/viewer/classification.ts`);
- a niche he has **not** ruled on reads as **"unknown niche"** — never as
  regular. Anything new arriving in a future reply surfaces that way too, which
  is the point: it prompts him to classify it rather than joining the regular
  pile silently.

His answers live in Firestore at `viewers/{uid}`, private to his account, and
drive the tier filters, the badges, the XLSX/HTML export column tiers — and the
niche filter below.

### The niche filter answers a question, not a keyword

Publishers quote what they were asked about, so most domains never mention most
niches. Matching the key literally would hide a casino site from a VPN search
purely because nobody ever asked it about VPN. `web/src/niche-answer.ts`
resolves a filter to one of three outcomes:

| Outcome | When | Shown as |
|---|---|---|
| quoted | they named the niche | their `canPost` + their price |
| inferred | never mentioned, but they priced other niches **in the same tier** | `maybe`, at that range, marked `~` |
| excluded | they refused it — the niche itself, or a blanket "no grey niches" | not a result at all |

So with casino at $500 and no VPN quote, a VPN search returns the site at
"maybe $500"; a site that answered "vpn — no" drops out; a site quoting casino
$900 and CBD $850 reads "maybe 850–900 USD". Currencies are never averaged
together — "800 EUR / 850 USD". The same applies inside the regular tier, so a
site quoting regular/health/sport infers a range for a regular niche it never
priced.

**Inference needs a known tier.** An unclassified niche has no defensible peer
group — pooling everything would answer a casino query with a $40 regular price
— so it returns quoted answers only, and the view says so with a pointer to the
Niches tab. Classifying the niche switches inference on.

Two tests pin this down: `src/services/snapshot.test.ts` ("our sensitivity calls
never reach the snapshot") and `web/src/viewer/classification.test.ts`.

---

## 3. One-time setup

### 3.1 Firebase project

1. Create a project at <https://console.firebase.google.com>.
2. **Authentication** → enable the **Google** sign-in provider.
3. **Storage** → create the default bucket. Note its name
   (`your-project.firebasestorage.app`).
4. **Firestore** → create a database (production mode; the rules below replace
   the defaults).
5. **Project settings → Your apps → Web** → register an app, copy the config.
6. Link the repo to it (writes `.firebaserc`):

```sh
npm i -g firebase-tools    # once
firebase login
firebase use --add         # pick the project, alias it "default"
```

### 3.2 Allowlist

Edit `storage.rules` and put the real Google account addresses in `viewers()`:

```
function viewers() {
  return ['you@gmail.com', 'coworker@gmail.com'];
}
```

Deploy rules whenever that list changes:

```sh
firebase deploy --only storage,firestore:rules
```

### 3.3 Publisher credentials (server side)

**Project settings → Service accounts → Generate new private key**. Save it as
`firebase-service-account.json` in the repo root — it is gitignored, and it is a
real credential that can write the bucket. Then in `.env`:

```sh
SNAPSHOT_BUCKET=your-project.firebasestorage.app
SNAPSHOT_CREDENTIALS=./firebase-service-account.json
SNAPSHOT_PREFIX=snapshot
SNAPSHOT_DEBOUNCE_MS=60000
SNAPSHOT_PUBLISH=on
```

Leaving `SNAPSHOT_BUCKET` empty disables publishing entirely — that is the
normal state for a machine that only runs the pipeline.

### 3.4 Viewer build config (client side)

Copy `web/.env.example` to `web/.env.local` and fill in the web app config.
These values are **not secrets** (they identify the project; the rules do the
authorizing), but the service-account key must never appear here — anything
`VITE_`-prefixed is compiled into the public bundle.

---

## 4. Publishing

Automatic — the server publishes after every change:

```sh
pnpm serve      # SnapshotPublisher.attach() subscribes to the store change feed
```

It is driven by the **store's change feed**, not by any one pass, so a poll
cycle, an AI extraction and a hand-edit all trigger it. Writes are debounced
(default 60s of quiet), so a poll cycle that stores 40 replies publishes once at
the end. A publish failure logs and is dropped: the local store is the source of
truth and the next change re-triggers it.

Manual:

```sh
STORE=pouchdb pnpm publish:snapshot              # build + upload
STORE=pouchdb pnpm publish:snapshot --dry-run    # build only, report sizes
STORE=pouchdb pnpm publish:snapshot --out ./tmp  # write the files locally to inspect
```

### What gets uploaded

Only what changed. Every file is hashed; the publisher diffs against
`files.json` in the bucket and uploads the difference, gzipped. A typical poll
cycle moves a handful of files. A full re-extraction rewrites nearly everything
(~7 MB gzipped) — expected, just slower.

Ordering is deliberate: **data files → manifest.json → files.json → deletions**.
`manifest.json` is the visibility switch, so a crash halfway through leaves the
viewer on the previous, wholly consistent snapshot.

### Layout

| File | What |
|---|---|
| `manifest.json` | format, `builtAt`, counts — the viewer's entry point |
| `files.json` | path → hash; the publisher's change detector |
| `domains.json` | one row per known domain + its folded price cells |
| `domain/<slug>.json` | full price sheet + raw observation history |
| `responses.json` | reply rows **without** bodies (keeps the index small) |
| `reply/<slug>.json` | one email: body, attachments, parsed result, provenance, price records |
| `niches.json`, `batches.json` | taxonomy and batch names for the filters |

Object names use a restricted charset (`snapshotSlug`), not percent-encoding: a
botched extraction left a "domain" reading `foo.com and bar.com`, and a `%` in
an object name is re-encoded by the browser SDK, making the file unreachable.

---

## 5. Deploying the viewer

```sh
pnpm viewer:build     # web/dist-viewer  (VITE_TARGET=viewer)
pnpm viewer:deploy    # build + firebase deploy --only hosting,storage,firestore:rules
```

Local development against the real bucket:

```sh
pnpm viewer:dev       # http://localhost:5174/viewer.html
```

(Add `http://localhost` under Authentication → Settings → Authorized domains.)

### How one codebase serves both apps

`web/vite.config.ts` runs a resolver plugin for `VITE_TARGET=viewer` that swaps
`src/api.ts` (HTTP) for `src/api.snapshot.ts` (Cloud Storage). `DomainsView`,
`ResponsesView`, the detail modals and the whole export pipeline are the *same
code* in both builds — which is what keeps the viewer from drifting into a
second implementation. Components take a `readOnly` prop that hides everything
that writes.

Verify a viewer build never talks to a server:

```sh
grep -r "'/api'" web/dist-viewer/assets/   # must find nothing
```

### The viewer's own look

Shared *code*, separate *skin*. The viewer has its own Chakra system in
`web/src/viewer/theme.ts`, mounted by `web/src/viewer/Provider.tsx`; the operator
console keeps `web/src/theme.ts`. Neither entry loads the other, so the two can
diverge freely — and the viewer's fonts add nothing to the console's bundle.

The idea it is built on: **this is a price book, and in a price book colour is
data.** The chassis is achromatic — a white page, hairline rules, black buttons,
one pale grey for table heads and zebra rows — and every chromatic pixel means
something: green "they'll take it", amber sensitive, gold carried over, violet
special, red excluded. Type is IBM Plex Sans for prose, the same variable font at
80% width for column heads, and IBM Plex Mono for every figure, badge and stamp.

That skin reaches `DomainsView` / `ResponsesView` without either being forked,
because the theme overrides Chakra's colour *ramps* rather than any call site:
`colorPalette="green"` in shared code resolves to the viewer's green here and the
console's green there. Two consequences worth knowing:

- Restyling shared components from the viewer means adding a token or a recipe
  override in `viewer/theme.ts`, never a `viewer` branch inside the component.
- The viewer-only surfaces — the sign-in hero, the header and its as-of stamp,
  the niches panel — live under `web/src/viewer/` and share three house parts in
  `viewer/ui.tsx` (`Mono`, `Rule`, `Segmented`).

---

## 6. What the viewer can and cannot do

**Can:** browse domains and their price sheets with tier/niche filters; open the
full observation history; read every reply with attachments; see extraction
provenance (model, prompt, the AI's explanation); export XLSX / self-contained
HTML; classify niches for themselves.

**Cannot:** exclude a domain, edit or delete an extraction, see the send history
(outreach bodies are not published), reach any mailbox, or trigger any pass.
Those methods throw `not available in the read-only viewer`, and the UI that
would call them is hidden.

---

## 7. Checks worth running

```sh
pnpm test && pnpm typecheck && pnpm web:typecheck
STORE=pouchdb pnpm publish:snapshot --out /tmp/snap
grep -rl '"sensitive":true' /tmp/snap        # must find nothing
```

And once, by hand: open a Storage download URL in a signed-out browser and
confirm it is refused. The allowlist is the only thing standing between publisher
contact details and the open internet.
