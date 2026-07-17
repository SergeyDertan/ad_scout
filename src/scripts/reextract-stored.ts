// Wipe every AI-derived artifact — reply extractions (parsed + review), target
// result rollups, and the learned/dynamic niche registry — leaving ONLY the raw
// emails (outreaches + replies) and the targets/accounts/campaigns they belong
// to. Then re-extract every stored reply IN PLACE using the configured LLM
// provider, WITHOUT re-fetching the mailbox (unlike refetch:replies).
//
// This is `refetch:replies` minus the Gmail round-trip: the reply text/attachments
// already in the DB are re-run through the current extractor + prompt.
//
//     STORE=pouchdb LLM_PROVIDER=claude-code pnpm reextract:stored [--dry-run] [--clear-only]
//
//   --dry-run       report what would change; touch nothing.
//   --clear-only    wipe the AI artifacts but skip re-extraction (run it later).
//   --extract-only  skip the wipe; just extract replies still pending/failed.
//                   Use to RESUME after an interrupted run (already-done replies
//                   are skipped, so it's safe to re-run).
//
// Cost note: re-extraction makes one LLM call per matched reply (some fetch
// linked pricing pages → slower, multi-turn). Mind provider usage on large DBs.

import 'dotenv/config';
import { loadConfig } from '../config';
import { buildAgent } from '../lib/factory';
import { extractPendingReplies } from '../pipeline/poll-pass';
import { systemClock } from '../lib/clock';
import type { Reply, Target } from '../domain/types';

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const clearOnly = process.argv.includes('--clear-only');
  const extractOnly = process.argv.includes('--extract-only');
  const config = loadConfig();
  const { store, email, extractor, llm } = buildAgent(config);

  const replies = await store.listReplies();
  const targets = await store.listTargets();
  const niches = await store.listNiches();

  const repliesToClear = replies.filter((r) => r.parsed !== undefined || r.review !== undefined || r.extractionStatus !== 'pending');
  const targetsToClear = targets.filter((t) => t.result !== undefined || t.status === 'replied' || t.status === 'excluded');
  const matched = replies.filter((r) => r.targetId).length;
  const stillPending = replies.filter((r) => r.targetId && r.extractionStatus !== 'done').length;

  console.log(`store=${config.store}  llm=${llm.name}`);
  if (extractOnly) {
    console.log(`${dryRun ? '[dry-run] ' : ''}--extract-only: re-extracting ${stillPending} pending/failed matched repl(y/ies) with ${llm.name} (no wipe, no fetch)…`);
  } else {
    console.log(
      `${dryRun ? '[dry-run] ' : ''}clearing: ${repliesToClear.length} reply extraction(s), ` +
        `${targetsToClear.length} target result(s), ${niches.length} dynamic niche(s). ` +
        `Keeping ${replies.length} raw repl(y/ies) + all outreaches.`,
    );
    if (!dryRun && !clearOnly) console.log(`then re-extracting ${matched} matched repl(y/ies) with ${llm.name} (no fetch)…`);
  }

  if (dryRun) {
    await store.close?.();
    return;
  }

  // --- Phase 1: wipe AI-derived state (skipped by --extract-only) ----------
  if (!extractOnly) {
    for (const n of niches) await store.deleteNiche(n.key);

    for (const r of repliesToClear) {
      const { parsed: _p, review: _v, ...rest } = r;
      const next: Reply = { ...rest, extractionStatus: 'pending' };
      await store.putReply(next);
    }

    for (const t of targetsToClear) {
      await store.updateTarget(t.id, (current) => {
        const { result: _drop, ...rest } = current;
        const next = rest as Target;
        // Status set purely by extraction rolls back to 'contacted' so the pipeline
        // re-derives it cleanly on re-extraction (opt-out suppressions are left as-is).
        if (next.status === 'replied' || next.status === 'excluded') next.status = 'contacted';
        return next;
      });
    }

    console.log(`cleared: ${repliesToClear.length} reply(ies) → pending, ${targetsToClear.length} target(s) reset, ${niches.length} niche(s) deleted.`);

    if (clearOnly) {
      console.log('--clear-only: skipping re-extraction.');
      await store.close?.();
      return;
    }
  }

  // --- Phase 2: re-extract in place, no fetch -----------------------------
  const { extracted, failed } = await extractPendingReplies(
    { store, email, extractor, clock: systemClock, config },
    { log: (m) => console.log(m) },
  );
  console.log(`\nre-extraction complete: ${extracted} extracted, ${failed} failed.`);

  await store.close?.();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
