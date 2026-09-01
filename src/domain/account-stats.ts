// Pure, derived LIFETIME per-account statistics for the UI. No I/O.
//
// The sibling of account-state.ts: that one answers "what is this mailbox doing
// right now" (today's quota, drip rate), this one answers "what has this mailbox
// achieved" (how much it sent, how much of it bounced, how many wrote back).
// Both derive everything from the append-only Outreach log + the target/reply
// records, so neither can drift from a stored counter.
//
// --- Attribution -------------------------------------------------------------
//
// Two different questions, two different keys, and conflating them is the easy
// mistake here:
//
//   * "How much mail did this mailbox send?" — counted from the Outreach log by
//     `accountId`. Follow-ups are round-robined independently of the initial
//     (see pipeline/send-pass.ts), and deal messages are logged as 'manual', so
//     this counts every message the mailbox actually put on the wire.
//
//   * "How did this mailbox's outreach land?" — counted over the TARGETS it
//     owns, i.e. `assignedAccountId`, which the send pass stamps when it reserves
//     the INITIAL send. Owning a target is exclusive, so the per-account funnels
//     partition the contacted targets and sum back to the global one.
//
// The consequence worth knowing: a follow-up sent by mailbox B to a target owned
// by mailbox A adds to B's `messagesSent` but lands in A's funnel. That is the
// honest reading — A opened the conversation and A's reputation carries it.

import { bounceRate } from './health';
import { engagementOf, outcomesOf, type Engagement, type Outcomes } from './engagement';
import type { Account, ID, ISO, Outreach, Target } from './types';

export interface AccountStats {
  // --- Volume: what this mailbox put on the wire (Outreach log, by accountId) ---
  /** Messages successfully sent, all kinds. The deliverability-relevant number. */
  messagesSent: number;
  /** Of those: opening messages, follow-ups, and hand-written deal messages. */
  initials: number;
  followUps: number;
  manual: number;
  /** Sends that errored out. Not part of `messagesSent` — nothing was delivered. */
  failed: number;
  /** Slots held by an in-flight reservation (drafted, not yet on the wire). */
  reserved: number;
  /** When this mailbox last sent anything; absent if it never has. */
  lastSentAt?: ISO;

  // --- Reach: the targets this mailbox owns (by assignedAccountId) ---
  /** Targets whose opening message came from this mailbox and has gone out. */
  targetsContacted: number;
  /** Full funnel over the owned targets. `queued` here is the account's own
   *  backlog — targets it reserved but hasn't sent (or that failed and reverted). */
  engagement: Engagement;
  /** Commercial outcomes over the owned targets that carry a result. */
  outcomes: Outcomes;

  // --- Rates (0..1; 0 when the denominator is empty) ---
  /** bounced / targetsContacted — the deliverability signal, same math as
   *  domain/health.ts, so it is directly comparable to the cooldown threshold. */
  bounceRate: number;
  /** replied / delivered, where delivered = targetsContacted - bounced. A bounced
   *  address never got the chance to answer, so leaving it in the denominator
   *  would quietly punish the mailbox twice for one bad address. */
  replyRate: number;
}

export function accountStats(
  account: Account,
  outreaches: readonly Outreach[],
  targets: readonly Target[],
  repliedTargetIds: ReadonlySet<ID>,
): AccountStats {
  let messagesSent = 0;
  let initials = 0;
  let followUps = 0;
  let manual = 0;
  let failed = 0;
  let reserved = 0;
  let lastSentAt: ISO | undefined;

  for (const o of outreaches) {
    if (o.accountId !== account.id) continue;
    if (o.status === 'failed') {
      failed++;
      continue;
    }
    if (o.status === 'reserved') {
      reserved++;
      continue;
    }
    if (o.status !== 'sent') continue; // 'needs_review' — never left the building
    messagesSent++;
    if (o.kind === 'initial') initials++;
    else if (o.kind === 'followup') followUps++;
    else manual++;
    // Rows written before sentAt existed fall back to their reservation time.
    const at = o.sentAt ?? o.reservedAt;
    if (at && (lastSentAt === undefined || at > lastSentAt)) lastSentAt = at;
  }

  const owned = targets.filter((t) => t.assignedAccountId === account.id);
  const engagement = engagementOf(owned, repliedTargetIds);
  const outcomes = outcomesOf(owned);

  // Everything this mailbox opened that actually went out. Derived by subtraction
  // rather than counted separately so it can never disagree with the funnel.
  const targetsContacted = owned.length - engagement.queued;
  const delivered = targetsContacted - engagement.bounced;

  return {
    messagesSent,
    initials,
    followUps,
    manual,
    failed,
    reserved,
    ...(lastSentAt ? { lastSentAt } : {}),
    targetsContacted,
    engagement,
    outcomes,
    bounceRate: bounceRate(targetsContacted, engagement.bounced),
    replyRate: delivered > 0 ? engagement.replied / delivered : 0,
  };
}
