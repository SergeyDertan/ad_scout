// Migration step 2 of 3 (PRICE-HISTORY-PLAN.md §8) — fetch-only ingest, NO AI.
// Pulls every message since each account's poll cursor and stores them as
// extractionStatus:'pending'. Network-bound, not AI-bound — safe to run
// start-to-finish in one go. Run after `reset:for-reingest`; then extract with
// `reextract:stored --limit N` (the AI, paced step).
//
//     STORE=pouchdb pnpm fetch:only
//
// Requires active accounts (paused accounts are skipped, same as a normal poll).

import 'dotenv/config';
import { loadConfig } from '../config';
import { buildAgent } from '../lib/factory';
import { runFetchPass } from '../pipeline/fetch-pass';
import { systemClock } from '../lib/clock';

async function main() {
  const config = loadConfig();
  const { store, email } = buildAgent(config);
  console.log(`store=${config.store}  fetch-only (no AI)…`);
  const report = await runFetchPass({ store, email, clock: systemClock });
  console.log('fetch complete:', JSON.stringify(report));
  const pending = (await store.listReplies()).filter((r) => r.extractionStatus === 'pending' && r.targetId).length;
  console.log(`\n${pending} matched repl(y/ies) are now pending extraction.`);
  console.log('Next: `pnpm reextract:stored --limit N` (AI, resumable) — size N to your usage window.');
  await store.close?.();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
