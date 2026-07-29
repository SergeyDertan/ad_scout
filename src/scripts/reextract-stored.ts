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
//   --limit N       extract at most N replies this run (pace against the usage
//                   window; resume with another run — state is per-reply).
//   --sleep MS      sleep MS between replies (gentler pacing).
//
// Cost note: re-extraction makes one LLM call per matched reply (some fetch
// linked pricing pages → slower, multi-turn). Mind provider usage on large DBs.

import 'dotenv/config';
import { loadConfig } from '../config';
import { buildAgent } from '../lib/factory';
import { extractPendingReplies } from '../pipeline/poll-pass';
import { systemClock } from '../lib/clock';
import { enableFileLogging, logger } from '../lib/logger';
import { describeError } from '../lib/errors';
import type { Reply, Target } from '../domain/types';

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const clearOnly = process.argv.includes('--clear-only');
  const extractOnly = process.argv.includes('--extract-only');
  const limit = numArg('--limit');
  const sleepMs = numArg('--sleep');
  const config = loadConfig();

  // A full re-extraction is a long unattended run — tee every line (and the full
  // detail of each failure) to logs/adscout-<date>.log so a closed terminal or a
  // crash doesn't erase the record. LOG_DIR=off opts out.
  const logDir = process.env.LOG_DIR === 'off' ? null : enableFileLogging();

  const { store, email, extractor, llm } = buildAgent(config);
  if (logDir) logger.info(`logging to ${logDir}/adscout-<date>.log`);

  const replies = await store.listReplies();
  const targets = await store.listTargets();
  const niches = await store.listNiches();
  // Derived per-domain history is re-created by re-extraction — wipe it first so a
  // re-run doesn't double-write. Keep ignore + manual exclusions (curated data).
  const priceRecords = await store.listPriceRecords();
  const declinedExclusions = (await store.listDomainExclusions()).filter((e) => e.reason === 'declined');

  const repliesToClear = replies.filter((r) => r.parsed !== undefined || r.review !== undefined || r.extractionStatus !== 'pending');
  const targetsToClear = targets.filter((t) => t.result !== undefined || t.status === 'replied' || t.status === 'excluded');
  const matched = replies.filter((r) => r.targetId).length;
  const stillPending = replies.filter((r) => r.targetId && r.extractionStatus !== 'done').length;

  logger.info(`store=${config.store}  llm=${llm.name}`);
  if (extractOnly) {
    logger.info(`${dryRun ? '[dry-run] ' : ''}--extract-only: re-extracting ${stillPending} pending/failed matched repl(y/ies) with ${llm.name} (no wipe, no fetch)…`);
  } else {
    logger.info(
      `${dryRun ? '[dry-run] ' : ''}clearing: ${repliesToClear.length} reply extraction(s), ` +
        `${targetsToClear.length} target result(s), ${niches.length} dynamic niche(s), ` +
        `${priceRecords.length} price record(s), ${declinedExclusions.length} declined exclusion(s). ` +
        `Keeping ${replies.length} raw repl(y/ies) + all outreaches + ignore/manual exclusions.`,
    );
    if (!dryRun && !clearOnly) logger.info(`then re-extracting ${matched} matched repl(y/ies) with ${llm.name} (no fetch)…`);
  }

  if (dryRun) {
    await store.close?.();
    return;
  }

  // --- Phase 1: wipe AI-derived state (skipped by --extract-only) ----------
  if (!extractOnly) {
    for (const n of niches) await store.deleteNiche(n.key);
    for (const p of priceRecords) await store.deletePriceRecord(p.id);
    for (const e of declinedExclusions) await store.deleteDomainExclusion(e.domain);

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

    logger.info(`cleared: ${repliesToClear.length} reply(ies) → pending, ${targetsToClear.length} target(s) reset, ${niches.length} niche(s) deleted.`);

    if (clearOnly) {
      logger.info('--clear-only: skipping re-extraction.');
      await store.close?.();
      return;
    }
  }

  // --- Phase 2: re-extract in place, no fetch -----------------------------
  const { extracted, failed, ignored, stoppedByLimit, resetAt } = await extractPendingReplies(
    { store, email, extractor, clock: systemClock, config },
    { log: (m) => logger.info(m), ...(limit != null ? { limit } : {}), ...(sleepMs != null ? { sleepMs } : {}) },
  );
  if (stoppedByLimit) {
    logger.info(
      `\nSTOPPED at the Claude usage limit — ${extracted} extracted, ${failed} failed, ${ignored} ignored this run.` +
        (resetAt ? ` Limit resets ${resetAt.toLocaleString()}.` : '') +
        `\nRe-run the same command to resume (already-done replies are skipped).`,
    );
    process.exitCode = 2; // distinct code so a wrapping loop can detect the pause
  } else {
    logger.info(`\nre-extraction complete: ${extracted} extracted, ${failed} failed, ${ignored} ignored (spam).`);
  }

  await store.close?.();
}

/** Read a numeric CLI flag value, e.g. `--limit 50`. Undefined when absent. */
function numArg(flag: string): number | undefined {
  const i = process.argv.indexOf(flag);
  if (i === -1 || i + 1 >= process.argv.length) return undefined;
  const n = Number(process.argv[i + 1]);
  return Number.isFinite(n) ? n : undefined;
}

main().catch((err) => {
  // Fatal: capture the full chain + stack in the log file before dying, otherwise
  // an overnight crash leaves nothing behind but a closed terminal.
  logger.error('reextract:stored aborted', { ...describeError(err) });
  process.exit(1);
});
