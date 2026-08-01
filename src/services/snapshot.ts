// Snapshot builder — turns the local store into the flat set of JSON files a
// read-only viewer downloads from Firebase Storage.
//
// The viewer has no server: it fetches these files and does all filtering,
// sorting and exporting in the browser. So the shape here is exactly the shape
// the existing UI already consumes (src/services/read-models.ts), split into
// files that match how the UI reads them:
//
//   manifest.json      format + when it was built + counts (the viewer's entry point)
//   files.json         path → hash for every file; the publisher's change detector
//   niches.json        the niche taxonomy, WITHOUT our sensitivity calls (see below)
//   batches.json       for the Responses batch filter
//   domains.json       one row per known domain, with its folded price cells
//   domain/<d>.json    that domain's full sheet + raw observation history
//   reply/<id>.json    one email: body, attachments, parsed result, provenance
//
// Bodies are the bulk of the data and are read one at a time, so they live in
// per-reply files; the two index files stay small enough to load up front.
//
// SENSITIVITY IS DELIBERATELY STRIPPED. Locally, `sensitive` is baked into every
// offer at extraction time from our own niche registry. The viewer's owner
// classifies niches himself — his call, not ours — and anything he has not
// classified must read as "unknown niche" no matter what our registry says. So
// every `sensitive` flag is forced to false on the way out and the viewer
// re-derives it from his own list. Leaving the flag in would silently seed his
// filters with our answers, which is exactly what he asked not to happen.

import { createHash } from 'node:crypto';
import { allNiches } from '../domain/niches';
import type { Niche, PostOffer, PriceRecord, Reply } from '../domain/types';
import type { Clock } from '../lib/clock';
import type { Store } from '../ports/store';
import {
  buildBatchRows,
  buildDomainDetail,
  buildDomainRows,
  buildReplyDebug,
  buildResponseRows,
  type DomainCellRow,
} from './read-models';

/** Current snapshot layout. Bumped when the file set or shape changes in a way
 *  an already-deployed viewer could not read; the viewer refuses a mismatch
 *  rather than rendering half-understood data. */
export const SNAPSHOT_FORMAT = 1;

export interface SnapshotFile {
  /** Path within the snapshot prefix, e.g. 'domains.json' or 'reply/abc.json'. */
  path: string;
  /** Serialized JSON body. */
  body: string;
  /** sha256 of `body` — the change detector AND the viewer's cache key. */
  hash: string;
}

/** The viewer's entry point. Deliberately tiny — it is fetched uncached on every
 *  page load, so the 2600-entry hash table lives in files.json instead. */
export interface SnapshotManifest {
  format: number;
  builtAt: string;
  counts: { domains: number; replies: number; niches: number };
}

export interface Snapshot {
  manifest: SnapshotManifest;
  /** path → hash, for every data file. The publisher's change detector. */
  fileHashes: Record<string, string>;
  /** Every data file. manifest.json and files.json are written by the publisher. */
  files: SnapshotFile[];
}

function sha256(body: string): string {
  return createHash('sha256').update(body).digest('hex').slice(0, 16);
}

function file(path: string, value: unknown): SnapshotFile {
  const body = JSON.stringify(value);
  return { path, body, hash: sha256(body) };
}

/**
 * A key (a domain, a reply id) → a safe object name.
 *
 * NOT percent-encoding. The keys are mostly tidy, but not always — a botched
 * extraction has left at least one "domain" reading `foo.com and bar.com`, and
 * percent-encoding it produces an object name the browser SDK re-encodes on the
 * way back out ('%' → '%25'), so the viewer would ask for a file that doesn't
 * exist. Restricting the charset instead keeps names addressable everywhere.
 *
 * A key that needed rewriting gets a hash of the ORIGINAL appended, so two
 * different keys can never collapse onto the same file.
 *
 * Mirrored verbatim in web/src/viewer/paths.ts — change both together.
 */
export function snapshotSlug(key: string): string {
  const safe = key
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return safe === key ? key : `${safe || 'x'}-${fnv1a(key)}`;
}

/** FNV-1a, 32-bit. A disambiguator, not a checksum — it only has to be stable
 *  and identical in both languages, which rules out anything async (the browser
 *  has no synchronous sha256). */
function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export function replyPath(id: string): string {
  return `reply/${snapshotSlug(id)}.json`;
}

export function domainPath(domain: string): string {
  return `domain/${snapshotSlug(domain)}.json`;
}

/** Force `sensitive: false` on an offer — see the file header. */
function stripOffer(o: PostOffer): PostOffer {
  return { ...o, sensitive: false };
}

function stripCell<T extends DomainCellRow>(c: T): T {
  return { ...c, sensitive: false };
}

/** The niche taxonomy as the viewer sees it: keys and labels (so a niche has a
 *  human name to classify), but never our sensitivity call. */
function stripNiche(n: Niche): Niche {
  return { ...n, sensitive: false };
}

function stripRecord(r: PriceRecord): PriceRecord {
  return { ...r, offers: r.offers.map(stripOffer) };
}

function stripReply<T extends Reply>(r: T): T {
  return r.parsed?.offers
    ? { ...r, parsed: { ...r.parsed, offers: r.parsed.offers.map(stripOffer) } }
    : r;
}

/**
 * Build the whole snapshot from the store.
 *
 * Deliberately builds everything every time rather than tracking what changed:
 * the dataset is small (hundreds of replies), and a full rebuild is the only
 * version that cannot go stale in a way nobody notices. The publisher diffs by
 * hash afterwards, so a full rebuild still uploads only what actually moved.
 */
export async function buildSnapshot(store: Store, clock: Clock): Promise<Snapshot> {
  const now = clock.now();
  const files: SnapshotFile[] = [];

  const niches = allNiches(await store.listNiches()).map(stripNiche);
  files.push(file('niches.json', niches));
  files.push(file('batches.json', await buildBatchRows(store)));

  const domains = (await buildDomainRows(store, now)).map((d) => ({
    ...d,
    cells: d.cells.map(stripCell),
  }));
  files.push(file('domains.json', domains));
  for (const d of domains) {
    const detail = await buildDomainDetail(store, d.domain, now);
    files.push(
      file(domainPath(d.domain), {
        ...detail,
        sheet: {
          ...detail.sheet,
          cells: detail.sheet.cells.map(stripCell),
          specials: detail.sheet.specials.map(stripCell),
        },
        history: detail.history.map(stripRecord),
      }),
    );
  }

  // The list rows carry everything the table, the filters and the XLSX/HTML
  // export need — but NOT the body or attachments, which is most of the bytes
  // and is only ever read one reply at a time.
  const rows = await buildResponseRows(store);
  files.push(
    file(
      'responses.json',
      rows.map((r) => {
        const { text: _text, attachments: _attachments, ...rest } = stripReply(r);
        return rest;
      }),
    ),
  );

  // One file per email: the body, its attachments, and the full provenance
  // payload (which mailbox, which prompt, which model, which price records).
  for (const row of rows) {
    const debug = await buildReplyDebug(store, row);
    files.push(
      file(replyPath(row.id), {
        ...debug,
        // The list row, not the bare Reply: the detail view wants website /
        // batch / our-inbox too, and re-joining them client-side would mean
        // shipping the targets table just for that.
        reply: stripReply(row),
        priceRecords: debug.priceRecords.map(stripRecord),
      }),
    );
  }

  const manifest: SnapshotManifest = {
    format: SNAPSHOT_FORMAT,
    builtAt: now.toISOString(),
    counts: { domains: domains.length, replies: rows.length, niches: niches.length },
  };

  return { manifest, fileHashes: Object.fromEntries(files.map((f) => [f.path, f.hash])), files };
}
