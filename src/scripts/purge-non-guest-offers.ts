// One-time migration: drop every stored offer that is NOT a guest post.
//
// We used to price three products per niche (guest_post / link_insertion /
// banner) and the cell key carried that product axis. We only ever buy guest
// posts, so the axis is gone: a cell is now identified by its niche alone. That
// makes the leftovers actively harmful — with `postType` no longer part of the
// key, a stored link-insertion offer collapses into the SAME cell as the
// guest-post offer for that niche, and buildPriceSheet keeps the last writer at
// equal observedAt. A $99 link insertion would silently become the domain's
// regular guest-post rate in the Domains view and in every export.
//
// So this strips them from all three places offers are stored:
//   - PriceRecord.offers  (the Domains view / price sheet)
//   - Reply.parsed.offers (the Responses view + the edit form)
//   - Target.result.offers (the target's cached summary)
// A PriceRecord left with zero offers is DELETED (it no longer records a price;
// keeping it would only skew recordCount and lastObservedAt). A Reply/Target is
// kept with an empty offer list — the message itself is still real history.
//
// Legacy rows without a `postType` at all predate the axis and ARE guest posts,
// so they are left alone.
//
// Dry-run by default (prints the plan + samples). Pass --apply to write.
// TAKE A BACKUP FIRST — this is destructive:
//
//     tar czf data-backup-pre-posttype-purge-$(date +%Y%m%d-%H%M%S).tgz data
//     STORE=pouchdb pnpm purge:non-guest-offers
//     STORE=pouchdb pnpm purge:non-guest-offers --apply

import 'dotenv/config';
import { loadConfig } from '../config';
import { buildStore } from '../lib/factory';

/** The offer shape as STORED — `postType` is gone from PostOffer, so read it off
 *  a loose record rather than the current type. */
type StoredOffer = { postType?: string; category?: string; price?: { raw?: string } };

const DEFAULT_POST_TYPE = 'guest_post';

/** An offer for a product we don't buy. Absent postType = legacy guest post. */
function isNonGuest(o: StoredOffer): boolean {
  const pt = (o.postType ?? '').trim();
  return pt !== '' && pt !== DEFAULT_POST_TYPE;
}

const label = (o: StoredOffer) => `${o.postType}/${o.category}=${o.price?.raw ?? '—'}`;

async function main() {
  const apply = process.argv.includes('--apply');
  const store = buildStore(loadConfig());
  console.log(`${apply ? 'APPLY' : 'DRY RUN'} — purging non-guest-post offers\n`);

  // 1. PriceRecords — the ones that actually corrupt the folded price sheet.
  const records = await store.listPriceRecords();
  let recTouched = 0;
  let recDeleted = 0;
  let offersDropped = 0;
  const samples: string[] = [];
  for (const rec of records) {
    const keep = (rec.offers ?? []).filter((o) => !isNonGuest(o as StoredOffer));
    const dropped = (rec.offers ?? []).length - keep.length;
    if (dropped === 0) continue;
    recTouched++;
    offersDropped += dropped;
    if (samples.length < 15) {
      const gone = (rec.offers ?? []).filter((o) => isNonGuest(o as StoredOffer)).map((o) => label(o as StoredOffer));
      samples.push(`  ${rec.domain.padEnd(28)} drop [${gone.join(', ')}]  keep ${keep.length}`);
    }
    if (keep.length === 0) {
      recDeleted++;
      if (apply) await store.deletePriceRecord(rec.id);
    } else if (apply) {
      await store.putPriceRecord({ ...rec, offers: keep });
    }
  }

  // 2. Replies — what the Responses view and the edit form read.
  const replies = await store.listReplies();
  let replyTouched = 0;
  let replyOffersDropped = 0;
  for (const reply of replies) {
    const offers = reply.parsed?.offers;
    if (!offers?.length) continue;
    const keep = offers.filter((o) => !isNonGuest(o as StoredOffer));
    if (keep.length === offers.length) continue;
    replyTouched++;
    replyOffersDropped += offers.length - keep.length;
    if (apply) {
      reply.parsed = { ...reply.parsed!, offers: keep };
      await store.putReply(reply);
    }
  }

  // 3. Targets — the cached result summary shown on the target row.
  const targets = await store.listTargets();
  let targetTouched = 0;
  let targetOffersDropped = 0;
  for (const t of targets) {
    const offers = t.result?.offers;
    if (!offers?.length) continue;
    const keep = offers.filter((o) => !isNonGuest(o as StoredOffer));
    if (keep.length === offers.length) continue;
    targetTouched++;
    targetOffersDropped += offers.length - keep.length;
    if (apply) {
      await store.updateTarget(t.id, (cur) => ({ ...cur, result: { ...cur.result!, offers: keep } }));
    }
  }

  console.log(`price records : ${records.length} scanned, ${recTouched} affected, ${offersDropped} offers dropped, ${recDeleted} records deleted (empty)`);
  console.log(`replies       : ${replies.length} scanned, ${replyTouched} affected, ${replyOffersDropped} offers dropped`);
  console.log(`targets       : ${targets.length} scanned, ${targetTouched} affected, ${targetOffersDropped} offers dropped`);
  if (samples.length) console.log(`\nsample price records:\n${samples.join('\n')}`);

  const total = offersDropped + replyOffersDropped + targetOffersDropped;
  if (total === 0) console.log('\nNothing to purge.');
  else if (!apply) console.log(`\nDRY RUN — re-run with --apply to drop the ${total} offer(s). Back up ./data first.`);
  else console.log(`\nDropped ${total} offer(s).`);

  await store.close?.();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
