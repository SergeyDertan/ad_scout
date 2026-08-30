// Wipe every AI analysis outcome so replies get re-processed under the current
// prompt / result shape. Clears reply.parsed (→ extractionStatus 'pending') and
// target.result, and rolls 'replied' targets back to 'contacted'. The next poll
// pass (retryFailedExtractions) then re-extracts each pending reply afresh.
//
// Use this after changing the extraction prompt or the OutreachResult shape.
//
//     pnpm reset:extractions [--dry-run] [--include-excluded]
//
// By default 'excluded' (opt-out) targets are left untouched — re-analysing them
// would NOT remove the suppression entry, so it's safer to skip them. Pass
// --include-excluded to also clear their result and reset them to 'contacted'.

import 'dotenv/config';
import { loadConfig } from '../config';
import { buildStore } from '../lib/factory';
import type { Reply, Target } from '../domain/types';

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const includeExcluded = process.argv.includes('--include-excluded');
  const config = loadConfig();
  const store = buildStore(config);

  const replies = await store.listReplies();
  const targets = await store.listTargets();
  // Derived per-domain history is re-created by re-extraction — purge it so a
  // re-run doesn't double-write. Keep ignore + manual exclusions (curated data).
  const priceRecords = await store.listPriceRecords();
  const declinedExclusions = (await store.listDomainExclusions()).filter((e) => e.reason === 'declined');

  // The `dealId` guard is belt-and-braces: a held reply is 'skipped' with no
  // `parsed`, so it already falls outside this filter. Stated explicitly anyway,
  // because this script and reextract-stored.ts look interchangeable and are not
  // — that one's filter DOES reach 'skipped' replies (see the note there), and a
  // reader comparing the two should not have to work out which is which.
  const processedReplies = replies.filter(
    (r) =>
      r.dealId === undefined &&
      (r.parsed !== undefined ||
        r.extractionStatus === 'done' ||
        r.extractionStatus === 'failed'),
  );
  const analysedTargets = targets.filter(
    (t) => t.result !== undefined && (includeExcluded || t.status !== 'excluded'),
  );
  const skippedExcluded = targets.filter(
    (t) => t.result !== undefined && !includeExcluded && t.status === 'excluded',
  ).length;

  console.log(
    `${dryRun ? '[dry-run] ' : ''}resetting ${processedReplies.length} reply analysis result(s), ` +
      `${analysedTargets.length} target result(s), ${priceRecords.length} price record(s), ` +
      `${declinedExclusions.length} declined exclusion(s)` +
      (skippedExcluded ? ` (skipping ${skippedExcluded} excluded/opt-out target(s))` : ''),
  );

  if (dryRun) {
    await store.close?.();
    return;
  }

  for (const p of priceRecords) await store.deletePriceRecord(p.id);
  for (const e of declinedExclusions) await store.deleteDomainExclusion(e.domain);

  let replyCount = 0;
  for (const r of processedReplies) {
    const { parsed: _drop, ...rest } = r;
    const next: Reply = { ...rest, extractionStatus: 'pending' };
    await store.putReply(next);
    replyCount++;
  }

  let targetCount = 0;
  for (const t of analysedTargets) {
    await store.updateTarget(t.id, (current) => {
      const { result: _drop, ...rest } = current;
      const next = rest as Target;
      // A target set to 'replied'/'excluded' purely by extraction goes back to
      // 'contacted' so the pipeline cleanly re-derives its status on re-analysis.
      if (next.status === 'replied' || next.status === 'excluded') next.status = 'contacted';
      return next;
    });
    targetCount++;
  }

  console.log(`done — cleared ${replyCount} reply result(s) and ${targetCount} target result(s).`);
  console.log('Run a poll pass (pnpm serve → poll, or the scheduler) to re-extract them.');

  await store.close?.();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
