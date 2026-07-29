// One-off correction: criticalhit.net's rate card lists DigitalJournal.com at
// $450 for a regular post, and its TERMS say grey niches are "$390 on all sites,
// and $980 on [9 named sites]". DigitalJournal is absent from the $980 list, so
// the extractor faithfully recorded $390 — below the site's own regular rate.
//
// That is almost certainly an omission on their side, not a discount: Cuny.edu
// is the same $450 regular and IS on the $980 tier, MSN.com ($500) likewise, and
// DigitalJournal is the only one of 21 sites whose sensitive/regular ratio falls
// under 1.0 (every other site is 2.0x–13.1x). We therefore do not know their
// grey rate, so the honest record is "can post, price unknown" until they confirm.
//
// Clears the price on that ONE cell in both places it lives — the reply's parsed
// offers AND the derived-from PriceRecord — leaving canPost intact.
//
//     pnpm correct:dj-sensitive          # dry run
//     pnpm correct:dj-sensitive --apply

import 'dotenv/config';
import { loadConfig } from '../config';
import { buildStore } from '../lib/factory';

const REPLY_ID = 'reply_473e0621-b21c-4848-8d53-c7c080dab2e3';
const SITE = 'digitaljournal.com';

/** The one cell to blank: DigitalJournal's sensitive guest post. */
function isTarget(o: { website?: string; sensitive: boolean }): boolean {
  return (o.website ?? '').toLowerCase() === SITE && o.sensitive;
}

async function main() {
  const apply = process.argv.includes('--apply');
  const store = buildStore(loadConfig());
  console.log(`${apply ? 'APPLY' : 'DRY RUN'}\n`);

  // 1. The reply's parsed offers (Responses view + edit form).
  const reply = (await store.listReplies()).find((r) => r.id === REPLY_ID);
  if (!reply) throw new Error(`reply ${REPLY_ID} not found`);
  let hits = 0;
  for (const o of reply.parsed?.offers ?? []) {
    if (!isTarget(o)) continue;
    hits++;
    console.log(`reply ${reply.id}`);
    console.log(`  ${o.website} ${o.category}: ${o.price?.raw ?? '—'} -> (unknown), canPost=${o.canPost}`);
    delete (o as { price?: unknown }).price;
  }
  if (apply && hits) await store.putReply(reply);

  // 2. The PriceRecord the Domains view derives its sheet from. Same observation,
  //    same correction — the extraction misread an ambiguous email, the publisher
  //    did not change their price, so this is a fix rather than a new observation.
  const records = (await store.listPriceRecords()).filter(
    (r) => r.domain === SITE && r.replyId === REPLY_ID,
  );
  for (const rec of records) {
    let touched = false;
    for (const o of rec.offers) {
      if (!isTarget(o)) continue;
      console.log(`pricerecord ${rec.id}`);
      console.log(`  ${o.category}: ${o.price?.raw ?? '—'} -> (unknown), canPost=${o.canPost}`);
      delete (o as { price?: unknown }).price;
      touched = true;
    }
    if (apply && touched) await store.putPriceRecord(rec);
  }

  console.log(`\n${hits} reply cell(s), ${records.length} price record(s)`);
  if (!apply) console.log('nothing written — re-run with --apply');
  await store.close?.();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
