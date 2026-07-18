// Migration step 1 of 3 (PRICE-HISTORY-PLAN.md §8) — reset for a full re-scan.
// No AI, no network: instant and safe to re-run. Wipes the derived/append-only
// state that a re-scan will rebuild, and rewinds each account's poll cursor to
// the earliest send so a fetch-only pass re-pulls every reply.
//
//     STORE=pouchdb pnpm reset:for-reingest [--dry-run]
//
// Deletes:  all `reply` docs, all `pricerecord`, and reason:'declined' domain
//           exclusions. Clears target.result and rolls replied/excluded →
//           contacted. Rewinds pollCursor.lastPolledAt to min(outreach.sentAt)
//           per account and clears historyId + lastUid (forces the date-based
//           backfill path in the gmail-api provider).
// Keeps:    `ignore`, reason:'manual' domain exclusions, `suppression`
//           (addSuppression is idempotent, so a re-scan re-adds bounces/opt-outs).
//
// After this: run step 2 (fetch-only ingest) then step 3 (paced extraction,
// `pnpm reextract:stored --limit N`).

import 'dotenv/config';
import { loadConfig } from '../config';
import { buildStore } from '../lib/factory';
import type { Target } from '../domain/types';

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const config = loadConfig();
  const store = buildStore(config);

  const replies = await store.listReplies();
  const priceRecords = await store.listPriceRecords();
  const exclusions = await store.listDomainExclusions();
  const declined = exclusions.filter((e) => e.reason === 'declined');
  const targets = await store.listTargets();
  const targetsToReset = targets.filter(
    (t) => t.result !== undefined || t.status === 'replied' || t.status === 'excluded',
  );
  const accounts = await store.listAccounts();
  const outreaches = await store.listOutreaches();

  // Earliest send per account → the rewind point for its poll cursor.
  const earliestByAccount = new Map<string, string>();
  for (const o of outreaches) {
    if (!o.sentAt) continue;
    const prev = earliestByAccount.get(o.accountId);
    if (!prev || o.sentAt < prev) earliestByAccount.set(o.accountId, o.sentAt);
  }

  console.log(`store=${config.store}`);
  console.log(
    `${dryRun ? '[dry-run] ' : ''}deleting ${replies.length} reply(ies), ${priceRecords.length} price record(s), ` +
      `${declined.length} declined exclusion(s); resetting ${targetsToReset.length} target(s); ` +
      `rewinding ${earliestByAccount.size} account cursor(s).`,
  );
  console.log(
    `keeping ${exclusions.length - declined.length} manual exclusion(s), all ignore entries, all suppressions.`,
  );

  if (dryRun) {
    await store.close?.();
    return;
  }

  for (const r of replies) await store.deleteReply(r.id);
  for (const p of priceRecords) await store.deletePriceRecord(p.id);
  for (const e of declined) await store.deleteDomainExclusion(e.domain);

  for (const t of targetsToReset) {
    await store.updateTarget(t.id, (current) => {
      const { result: _drop, ...rest } = current;
      const next = rest as Target;
      if (next.status === 'replied' || next.status === 'excluded') next.status = 'contacted';
      return next;
    });
  }

  for (const account of accounts) {
    const earliest = earliestByAccount.get(account.id);
    if (!earliest) continue; // no sends → nothing to re-pull
    await store.updateAccount(account.id, (current) => {
      const cursor = { ...current.pollCursor };
      delete cursor.historyId;
      delete cursor.lastUid;
      return {
        ...current,
        pollCursor: { ...cursor, mailbox: cursor.mailbox ?? 'INBOX', lastPolledAt: earliest },
      };
    });
  }

  console.log(
    `done — deleted ${replies.length} reply(ies) + ${priceRecords.length} price record(s), ` +
      `reset ${targetsToReset.length} target(s), rewound ${earliestByAccount.size} cursor(s).`,
  );
  console.log('Next: step 2 fetch-only ingest, then step 3 `pnpm reextract:stored --limit N`.');

  await store.close?.();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
