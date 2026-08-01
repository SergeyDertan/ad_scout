// One-off re-derivation of every stored PlacementTerm from its verbatim `raw`,
// picking up the parseTerm fixes (domain/terms.ts):
//   - a hyphen between count and unit no longer swallows the count, so
//     "12-month publication" is 12 months rather than 1, and "two-year period"
//     is 24 rather than 12;
//   - a parenthesised numeral ("three (3) years") is read;
//   - Portuguese/Italian year words and the Romance/Slavic phrasings for
//     "indefinitely" now parse, instead of each getting its own other:* cell.
//
// No AI involved: `raw` is the publisher's own wording and is already stored, so
// this is a pure recompute. Idempotent — parseTerm is a function of `raw` alone,
// so re-running converges.
//
// HISTORY MERGE. A price-history cell is NOT stored; buildPriceSheet derives it
// at read time by folding PriceRecord.offers on `category|term.key`
// (domain/price-sheet.ts). So correcting `term` on the offers is the whole merge:
// records that used to fold into other:a-tempo-indeterminato now fold into perm,
// in observedAt order, alongside the prices that were always there. No cell ids
// to rewrite and no orphans left behind.
//
// Offers with no `term` at all predate the feature and are left alone — absent
// reads as "unstated", and inventing one would fabricate history.
//
// Back up ./data first (see the data-backup-*.tgz convention), then:
//     pnpm backfill:terms            # dry run — reports, writes nothing
//     pnpm backfill:terms --apply

import 'dotenv/config';
import { loadConfig } from '../config';
import { parseTerm } from '../domain/terms';
import type { PostOffer } from '../domain/types';
import { buildStore } from '../lib/factory';

/** key -> key transition tally, with the raw phrases that drove it. */
type Moves = Map<string, { n: number; raws: Set<string> }>;

function note(moves: Moves, from: string, to: string, raw: string): void {
  const k = `${from} -> ${to}`;
  const e = moves.get(k) ?? { n: 0, raws: new Set<string>() };
  e.n++;
  e.raws.add(raw);
  moves.set(k, e);
}

/** Re-derive each offer's term from its own `raw`. Returns how many changed. */
function reparseOffers(offers: PostOffer[], moves: Moves): number {
  let changed = 0;
  for (const o of offers) {
    // No term at all = written before terms existed. Absent means "unstated";
    // deriving one from an empty raw would invent a cell that never existed.
    if (!o.term) continue;
    const next = parseTerm(o.term.raw);
    if (next.key === o.term.key) continue;
    note(moves, o.term.key, next.key, o.term.raw);
    o.term = next;
    changed++;
  }
  return changed;
}

async function main() {
  const apply = process.argv.includes('--apply');
  const store = buildStore(loadConfig());
  console.log(`${apply ? 'APPLY' : 'DRY RUN'}\n`);

  const moves: Moves = new Map();
  let replyOffers = 0;
  let recordOffers = 0;

  const replies = await store.listReplies();
  let repliesWritten = 0;
  for (const reply of replies) {
    const n = reparseOffers(reply.parsed?.offers ?? [], moves);
    if (n) {
      replyOffers += n;
      repliesWritten++;
      if (apply) await store.putReply(reply);
    }
  }

  const records = await store.listPriceRecords();
  let recordsWritten = 0;
  for (const rec of records) {
    const n = reparseOffers(rec.offers, moves);
    if (n) {
      recordOffers += n;
      recordsWritten++;
      if (apply) await store.putPriceRecord(rec);
    }
  }

  if (moves.size) {
    console.log('Term transitions (old key -> new key):');
    for (const [k, e] of [...moves].sort((a, b) => b[1].n - a[1].n)) {
      const sample = [...e.raws].slice(0, 3).map((r) => JSON.stringify(r)).join(', ');
      console.log(`  ${String(e.n).padStart(5)}  ${k.padEnd(46)} ${sample}`);
    }
    console.log();
  } else {
    console.log('No term changed — already converged.\n');
  }

  console.log(`offers retermed — replies: ${replyOffers}, price records: ${recordOffers}`);
  console.log(`docs written    — ${repliesWritten}/${replies.length} replies, ${recordsWritten}/${records.length} price records`);
  if (!apply) console.log('\nnothing written — re-run with --apply');
  await store.close?.();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
