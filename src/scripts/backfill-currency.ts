// One-off reparse of stored prices from their verbatim `price.raw`, fixing two
// things the widened parser now gets right on data extracted earlier:
//   1. currency / currencyRaw  — filled in where missing (never overwritten).
//   2. amount                  — repaired where the old parser mis-read it
//      (European "12.000" thousands separators; the price next to the currency
//      rather than a stray leading number like the "12" in "12 months … $2500";
//      12-month/6-month tier preference).
//
// Both are conservative:
//   - currency is fill-only (adds signal, never changes an existing value);
//   - amount is only touched when the raw itself carries a currency-tagged figure
//     (parsePrice(raw).currencyRaw is set). That gate excludes RELATIVE offers
//     (whose raw is a premium phrase like "+50%" / "grey niches doubled" with no
//     currency) so their computed amounts are never clobbered.
// Runs over both places an offer lives: each Reply's parsed offers AND every
// derived PriceRecord. Idempotent — safe to re-run.
//
// Back up ./data first (see the data-backup-*.tgz convention), then:
//     pnpm backfill:currency            # dry run — reports, writes nothing
//     pnpm backfill:currency --apply

import 'dotenv/config';
import { loadConfig } from '../config';
import { parsePrice } from '../domain/extraction';
import type { PostOffer, PriceValue } from '../domain/types';
import { buildStore } from '../lib/factory';

// Raw phrases that denote a RELATIVE / additive price (a delta on a base rate),
// whose stored amount was COMPUTED, not read from the phrase's own figure. We must
// never repair those from their own number ("€75 surcharge" is +75, not the price).
const RELATIVE_RAW = /surcharge|\bextra\b|\badditional\b|\bpremium\b|\+|%|\btimes\b|\bx\b|double|multipl/i;

interface Change { currency: boolean; amount: boolean; oldAmount?: number; newAmount?: number }

/** Reparse one price from its verbatim `raw`: fill missing currency/currencyRaw and
 *  repair a mis-read amount (only for currency-tagged figures — never relatives). */
function reparsePrice(price: PriceValue): Change | undefined {
  if (!price.raw?.trim()) return undefined;
  const parsed = parsePrice(price.raw);
  if (!parsed) return undefined;
  const change: Change = { currency: false, amount: false };

  if (!price.currency && parsed.currency) { price.currency = parsed.currency; change.currency = true; }
  if (!price.currencyRaw && parsed.currencyRaw) { price.currencyRaw = parsed.currencyRaw; change.currency = true; }

  // Amount repair, gated so only genuine absolute prices are touched: the raw must
  // carry a currency-tagged figure AND not be a relative/additive phrase (surcharge,
  // "+50%", "extra €50"), whose stored amount was computed from a base rate.
  if (
    parsed.currencyRaw &&
    parsed.amount != null &&
    price.amount != null &&
    parsed.amount !== price.amount &&
    !RELATIVE_RAW.test(price.raw)
  ) {
    change.amount = true;
    change.oldAmount = price.amount;
    change.newAmount = parsed.amount;
    price.amount = parsed.amount;
  }

  return change.currency || change.amount ? change : undefined;
}

interface Totals { curCells: number; amtCells: number }

/** Reparse every priced offer in a list; returns per-kind counts touched. */
function reparseOffers(offers: PostOffer[], curTally: Map<string, number>, amtSamples: string[], label: string): Totals {
  const t: Totals = { curCells: 0, amtCells: 0 };
  for (const o of offers) {
    if (!o.price) continue;
    const ch = reparsePrice(o.price);
    if (!ch) continue;
    if (ch.currency) {
      t.curCells++;
      const key = o.price.currencyRaw ?? o.price.currency ?? '(unknown)';
      curTally.set(key, (curTally.get(key) ?? 0) + 1);
    }
    if (ch.amount) {
      t.amtCells++;
      if (amtSamples.length < 40) {
        amtSamples.push(`  ${label} ${o.postType}/${o.category}: "${o.price.raw}"  ${ch.oldAmount} -> ${ch.newAmount}`);
      }
    }
  }
  return t;
}

async function main() {
  const apply = process.argv.includes('--apply');
  const store = buildStore(loadConfig());
  console.log(`${apply ? 'APPLY' : 'DRY RUN'}\n`);

  const curTally = new Map<string, number>();
  const amtSamples: string[] = [];
  const sum = { replyCur: 0, replyAmt: 0, recCur: 0, recAmt: 0 };

  const replies = await store.listReplies();
  let repliesWritten = 0;
  for (const reply of replies) {
    const t = reparseOffers(reply.parsed?.offers ?? [], curTally, amtSamples, `reply ${reply.id}`);
    if (t.curCells || t.amtCells) {
      sum.replyCur += t.curCells;
      sum.replyAmt += t.amtCells;
      repliesWritten++;
      if (apply) await store.putReply(reply);
    }
  }

  const records = await store.listPriceRecords();
  let recordsWritten = 0;
  for (const rec of records) {
    const t = reparseOffers(rec.offers, curTally, amtSamples, `record ${rec.id}`);
    if (t.curCells || t.amtCells) {
      sum.recCur += t.curCells;
      sum.recAmt += t.amtCells;
      recordsWritten++;
      if (apply) await store.putPriceRecord(rec);
    }
  }

  if (amtSamples.length) {
    console.log('Amount repairs (old -> new):');
    console.log(amtSamples.join('\n'));
    console.log();
  }
  if (curTally.size) {
    console.log('Currency tokens filled (by currency):');
    for (const [cur, n] of [...curTally.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${cur.padEnd(12)} ${n}`);
    }
    console.log();
  }
  console.log(`currency filled — replies: ${sum.replyCur}, records: ${sum.recCur}`);
  console.log(`amount repaired — replies: ${sum.replyAmt}, records: ${sum.recAmt}`);
  console.log(`docs written   — ${repliesWritten}/${replies.length} replies, ${recordsWritten}/${records.length} price records`);
  if (!apply) console.log('\nnothing written — re-run with --apply');
  await store.close?.();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
