// Audit the send side: internal consistency of Outreach/Target records
// (duplicate sends, stuck reservations, missing threadIds, lost target-status
// updates), then a live Gmail spot-check (via resolveThreadId) on anything
// that looks suspicious. Read-only against the mailbox; does not write.
//
//     pnpm verify:sends

import 'dotenv/config';
import { loadConfig } from '../config';
import { buildStore } from '../lib/factory';
import { GmailApiProvider } from '../adapters/email/gmail-api.provider';
import type { Account, Outreach } from '../domain/types';

function outreachTime(o: Outreach): number {
  return new Date(o.sentAt ?? o.reservedAt).getTime();
}

async function main() {
  const config = loadConfig();
  const store = buildStore(config);

  const accounts = await store.listAccounts();
  const accountById = new Map(accounts.map((a) => [a.id, a]));
  const outreaches = await store.listOutreaches();
  const targets = await store.listTargets();
  const targetById = new Map(targets.map((t) => [t.id, t]));

  const statusCounts: Record<string, number> = {};
  for (const o of outreaches) statusCounts[o.status] = (statusCounts[o.status] ?? 0) + 1;
  console.log('outreach status counts (all accounts):', statusCounts);

  // 1. Duplicate reservations/sends for the same (target, kind, sequenceNo) slot.
  const bySlot = new Map<string, Outreach[]>();
  for (const o of outreaches) {
    const key = `${o.targetId}:${o.kind}:${o.sequenceNo}`;
    const list = bySlot.get(key) ?? [];
    list.push(o);
    bySlot.set(key, list);
  }
  const duplicates = [...bySlot.entries()].filter(
    ([, list]) => list.filter((o) => o.status === 'reserved' || o.status === 'sent').length > 1,
  );
  console.log(`\nduplicate reservations/sends (same target+kind+sequenceNo, >1 active): ${duplicates.length}`);
  for (const [key, list] of duplicates.slice(0, 20)) {
    console.log(`  ${key}:`, list.map((o) => ({ id: o.id, status: o.status, sentAt: o.sentAt })));
  }

  // 2. 'reserved' outreaches stuck past the reconcile grace window (should have
  //    been resolved to sent/needs_review at last server startup).
  const now = Date.now();
  const stuckReserved = outreaches.filter(
    (o) => o.status === 'reserved' && now - new Date(o.reservedAt).getTime() > config.reconcileGraceMs,
  );
  console.log(`\nstuck in 'reserved' past grace window (${config.reconcileGraceMs}ms): ${stuckReserved.length}`);
  for (const o of stuckReserved.slice(0, 20)) {
    console.log(`  - ${o.id} target=${o.targetId} reservedAt=${o.reservedAt}`);
  }

  // 3. 'sent' outreaches still missing a threadId (reconcile should retry these).
  const sentNoThread = outreaches.filter((o) => o.status === 'sent' && !o.threadId);
  console.log(`\n'sent' outreaches missing threadId: ${sentNoThread.length}`);
  for (const o of sentNoThread.slice(0, 20)) {
    console.log(`  - ${o.id} target=${o.targetId} sentAt=${o.sentAt} account=${accountById.get(o.accountId)?.email}`);
  }

  // 4. Target-status consistency: an 'initial' send marked 'sent' should have
  //    moved its target off 'pending'/'reserved' — a mismatch here is exactly
  //    the class of lost-update bug fixed earlier today (pre-fix casualties).
  const initialSentMismatch = outreaches.filter((o) => {
    if (o.kind !== 'initial' || o.status !== 'sent') return false;
    const t = targetById.get(o.targetId);
    return t && (t.status === 'pending' || t.status === 'reserved');
  });
  console.log(`\ninitial sends marked 'sent' but target still pending/reserved: ${initialSentMismatch.length}`);
  for (const o of initialSentMismatch.slice(0, 20)) {
    const t = targetById.get(o.targetId);
    console.log(`  - outreach=${o.id} target=${o.targetId} targetStatus=${t?.status} sentAt=${o.sentAt}`);
  }

  // 5. Follow-up count consistency: followUpCount should equal the number of
  //    'sent' followup outreaches recorded for that target.
  const followupSentByTarget = new Map<string, number>();
  for (const o of outreaches) {
    if (o.kind === 'followup' && o.status === 'sent') {
      followupSentByTarget.set(o.targetId, (followupSentByTarget.get(o.targetId) ?? 0) + 1);
    }
  }
  const followupMismatch = [...followupSentByTarget.entries()].filter(([targetId, count]) => {
    const t = targetById.get(targetId);
    return t && t.followUpCount !== count;
  });
  console.log(`\nfollowUpCount mismatches (target.followUpCount != sent followups): ${followupMismatch.length}`);
  for (const [targetId, count] of followupMismatch.slice(0, 20)) {
    const t = targetById.get(targetId);
    console.log(`  - target=${targetId} followUpCount=${t?.followUpCount} actualSentFollowups=${count}`);
  }

  // Live spot-check: for anything suspicious above (bounded set), confirm
  // against Gmail directly via the exact Message-Id search we already use in
  // reconcile.ts.
  const suspicious = [...new Set([...sentNoThread, ...initialSentMismatch].map((o) => o.id))]
    .map((id) => outreaches.find((o) => o.id === id)!)
    .slice(0, 15);
  if (suspicious.length > 0) {
    const { clientId, clientSecret } = config.googleOAuth;
    if (clientId && clientSecret) {
      const gmail = new GmailApiProvider(store, clientId, clientSecret);
      console.log(`\nlive Gmail spot-check on ${suspicious.length} suspicious outreach(es):`);
      for (const o of suspicious) {
        const account = accountById.get(o.accountId);
        if (!account) continue;
        try {
          const threadId = await gmail.resolveThreadId(account as Account, o.rfcMessageId);
          console.log(`  - ${o.id} rfcMessageId=${o.rfcMessageId} -> ${threadId ? `found, threadId=${threadId}` : 'NOT FOUND in Sent/All Mail'}`);
        } catch (err) {
          console.log(`  - ${o.id} lookup FAILED:`, err instanceof Error ? err.message : String(err));
        }
      }
    }
  }

  await store.close?.();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
