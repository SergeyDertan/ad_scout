// Pure engagement/outcome funnel math. No I/O.
//
// One implementation, two callers: the global rollup on GET /api/status and the
// per-account rollup on GET /api/accounts (domain/account-stats.ts). They used
// to be one inline block in the HTTP handler; a second copy keyed by account
// would have been free to drift from the first, and two funnels that disagree
// about what "replied" means are worse than one funnel nobody trusts.

import type { ID, Target } from './types';

/**
 * Every target lands in exactly ONE bucket, so the nine base counts partition
 * the input set. `replied` is a SUBTOTAL over the reply buckets, not a tenth
 * bucket — don't add it into a sum.
 */
export interface Engagement {
  queued: number; // pending + reserved (not yet emailed)
  contacted: number; // emailed, no reply back yet (truly silent)
  acknowledged: number; // replied, but only a holding/auto message — no info yet
  answered: number; // replied with a substantive answer
  declined: number; // replied to decline
  other: number; // replied, other/question intent
  optedOut: number; // replied to opt out (→ excluded + suppressed)
  excluded: number; // excluded without a reply (manual suppression)
  bounced: number;
  replied: number; // subtotal: acknowledged + answered + declined + other + optedOut
}

/** Of the targets that replied, which gave us usable commercial information. */
export interface Outcomes {
  informative: number; // replied with a price and/or a posting yes/no
  priced: number; // quoted at least one price
  postingYes: number; // will post for ≥1 niche
  postingNo: number; // declined to post
}

/**
 * Bucket targets into the engagement funnel.
 *
 * `byStatus` alone can't tell a silent 'contacted' target from one that sent a
 * holding/auto reply — both leave the target 'contacted' — so the caller passes
 * in the set of target ids that have at least one stored Reply. The same set
 * separates an opt-out ('excluded' WITH a reply) from a manual suppression
 * ('excluded' with none).
 */
export function engagementOf(
  targets: readonly Target[],
  repliedTargetIds: ReadonlySet<ID>,
): Engagement {
  const e: Engagement = {
    queued: 0,
    contacted: 0,
    acknowledged: 0,
    answered: 0,
    declined: 0,
    other: 0,
    optedOut: 0,
    excluded: 0,
    bounced: 0,
    replied: 0,
  };
  for (const t of targets) {
    const hasReply = repliedTargetIds.has(t.id);
    switch (t.status) {
      case 'pending':
      case 'reserved':
        e.queued++;
        break;
      case 'bounced':
        e.bounced++;
        break;
      case 'excluded':
        hasReply ? e.optedOut++ : e.excluded++;
        break;
      case 'replied': {
        const intent = t.result?.intent ?? 'answer';
        if (intent === 'decline') e.declined++;
        else if (intent === 'answer') e.answered++;
        else e.other++;
        break;
      }
      default: // 'contacted', 'needs_review'
        hasReply ? e.acknowledged++ : e.contacted++;
    }
  }
  e.replied = e.acknowledged + e.answered + e.declined + e.other + e.optedOut;
  return e;
}

/** Commercial outcomes over whichever targets carry an extracted result. */
export function outcomesOf(targets: readonly Target[]): Outcomes {
  const o: Outcomes = { informative: 0, priced: 0, postingYes: 0, postingNo: 0 };
  for (const t of targets) {
    const r = t.result;
    if (!r) continue;
    const offers = r.offers ?? [];
    const hasPrice = offers.some((x) => x.price?.amount != null);
    if (hasPrice) o.priced++;
    if (hasPrice || offers.length > 0) o.informative++;
    if (r.canPost === 'yes' || offers.some((x) => x.canPost === 'yes')) o.postingYes++;
    else if (offers.length > 0 && offers.every((x) => x.canPost === 'no')) o.postingNo++;
  }
  return o;
}
