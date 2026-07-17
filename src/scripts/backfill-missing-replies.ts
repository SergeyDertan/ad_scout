// One-time repair: verify-replies.ts found real inbox messages that never got
// a Reply record (pre-fix write-conflict casualties). Rather than re-implement
// matching/bounce/extraction by hand, this temporarily rolls each account's
// pollCursor back to before its first sent outreach and runs the REAL
// runPollPass once — it re-fetches the whole window, dedupes everything
// already stored (a no-op for the ~550 already-ingested replies), and only
// does real work (match, store, extract) for what was actually missing.
// pollCursor is advanced back to "now" at the end of runPollPass, same as a
// normal poll cycle.
//
//     pnpm backfill:replies

import 'dotenv/config';
import { loadConfig } from '../config';
import { buildAgent } from '../lib/factory';
import { systemClock } from '../lib/clock';
import { runPollPass } from '../pipeline/poll-pass';

async function main() {
  const config = loadConfig();
  const { store, email, extractor } = buildAgent(config);

  const accounts = await store.listAccounts();
  const outreaches = await store.listOutreaches();

  for (const account of accounts) {
    const sent = outreaches
      .filter((o) => o.accountId === account.id && (o.sentAt || o.reservedAt))
      .sort((a, b) => (a.sentAt ?? a.reservedAt) < (b.sentAt ?? b.reservedAt) ? -1 : 1);
    const first = sent[0];
    if (!first) continue;
    const since = new Date(new Date(first.sentAt ?? first.reservedAt).getTime() - 60 * 60_000); // 1h buffer

    console.log(`rolling back ${account.email} pollCursor to ${since.toISOString()} (was ${account.pollCursor?.lastPolledAt})`);
    await store.updateAccount(account.id, (a) => ({
      ...a,
      pollCursor: { mailbox: 'INBOX', lastPolledAt: since.toISOString() },
    }));
  }

  console.log('\nrunning full poll pass (this will take a while — real Gmail fetch + extraction)...\n');
  const report = await runPollPass({ store, email, extractor, clock: systemClock, config });
  console.log('\npoll report:', report);

  await store.close?.();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
