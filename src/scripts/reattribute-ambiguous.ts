// One-time repair for replies that predate the "matched target wins" attribution
// rule. Before it, an owner who ran several of our targets from ONE mailbox made
// every untagged price ambiguous (D11): the price was dropped and the reply was
// flagged "associated with N sites". The result was backwards — the site we
// actually contacted got no prices, while sites the owner happened to name did.
//
// This re-runs attributeOffers with the target's own domain, writes the
// PriceRecord that should have been written, and clears the stale review reason.
// Offers already attributed (tagged with a `website`) are left alone: their
// records exist, and re-writing them would double-count the history.
//
//     pnpm reattribute:ambiguous          # dry run — prints, writes nothing
//     pnpm reattribute:ambiguous --apply  # persist

import 'dotenv/config';
import { loadConfig } from '../config';
import { buildStore } from '../lib/factory';
import { normalizeDomain } from '../domain/domain';
import { attributeOffers, normalizeEmail } from '../domain/reply-matching';
import { newId } from '../lib/ids';
import { systemClock } from '../lib/clock';
import type { PriceRecord } from '../domain/types';

/** The review reason the old D11 branch wrote. */
const AMBIGUOUS = /associated with \d+ sites/;

async function main() {
  const apply = process.argv.includes('--apply');
  const config = loadConfig();
  const store = buildStore(config);

  const replies = await store.listReplies();
  const existing = await store.listPriceRecords();
  const flagged = replies.filter((r) => r.review?.some((x) => AMBIGUOUS.test(x)));

  console.log(`${apply ? 'APPLY' : 'DRY RUN'} — ${flagged.length} flagged reply(ies)\n`);

  for (const reply of flagged) {
    const target = reply.targetId ? await store.getTarget(reply.targetId) : undefined;
    if (!target) {
      console.log(`  ${reply.id}: no target — skipped (nothing to attribute to)`);
      continue;
    }
    const own = normalizeDomain(target.websiteUrl);
    if (!own) {
      console.log(`  ${reply.id}: target has no parseable domain — skipped`);
      continue;
    }

    // Only the previously-dropped untagged offers. Tagged ones already have records.
    const untagged = (reply.parsed?.offers ?? []).filter((o) => !o.website?.trim());
    const { groups } = attributeOffers(untagged, [], own);

    console.log(`  ${reply.id}  ${reply.fromAddress}`);
    console.log(`    contacted site : ${own}`);
    console.log(`    untagged offers: ${untagged.length}`);

    for (const group of groups) {
      // Guard against a re-run: one record per (reply, domain).
      const dupe = existing.find((r) => r.replyId === reply.id && r.domain === group.domain);
      if (dupe) {
        console.log(`    -> ${group.domain}: record already exists (${dupe.id}) — skipped`);
        continue;
      }
      const record: PriceRecord = {
        id: newId('pricerecord'),
        domain: group.domain,
        offers: group.offers,
        observedAt: reply.receivedAt ?? systemClock.now().toISOString(),
        sourceEmail: normalizeEmail(reply.fromAddress),
        sourceMessageId: reply.rfcMessageId,
        replyId: reply.id,
        ...(group.domain === own ? { targetId: target.id } : {}),
        attribution: group.attribution,
        ...(reply.parsed?.optOut ? { optOut: true } : {}),
      };
      const cells = group.offers.map((o) => `${o.postType}/${o.category}=${o.price?.raw ?? '—'}`);
      console.log(`    -> ${group.domain}: write record, ${group.offers.length} cell(s) [${cells.join(', ')}]`);
      if (apply) await store.putPriceRecord(record);
    }

    const kept = (reply.review ?? []).filter((x) => !AMBIGUOUS.test(x));
    console.log(`    review: ${reply.review?.length ?? 0} -> ${kept.length} reason(s)`);
    if (apply) {
      reply.review = kept.length ? kept : undefined;
      await store.putReply(reply);
    }
  }

  if (!apply) console.log('\nnothing written — re-run with --apply');
  await store.close?.();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
