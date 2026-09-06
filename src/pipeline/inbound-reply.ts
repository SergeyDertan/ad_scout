// The one place an inbound message becomes a stored Reply.
//
// It exists because there were two. The fetch pass and the poll pass each had a
// hand-copied `handleMessage` with its own Reply literal, on the theory that the
// only difference between the passes is AI extraction. Nothing enforced that,
// and the copies drifted: fetch-pass silently dropped `subject` and
// `attachments`, so every reply the drip scheduler ingested — which is nearly
// all of them — lost its files. A Reply doc is written once and never
// re-fetched, so a publisher's invoice PDF was gone the moment it arrived, with
// no second copy anywhere to restore from.
//
// The passes still legitimately differ AFTER this point (labels, target status,
// whether the extractor runs). What they must never differ on is which parts of
// the message survive being stored, so that part is here and called twice.

import type { MatchResult } from '../domain/reply-matching';
import type { Account, Deal, Reply } from '../domain/types';
import { newId } from '../lib/ids';
import type { IncomingEmail } from '../ports/email-provider';

/**
 * Build the Reply document for an inbound message. Pure: no store, no clock, no
 * provider — everything it records is already in the arguments.
 *
 * `extractionStatus` is decided here rather than by the caller, because it is a
 * property of the message and its thread, not of the pass doing the reading:
 *
 *   - held by an open deal ⇒ 'skipped'. It must never enter the extraction queue
 *     (extractPendingReplies takes 'pending'/'failed' only), whatever its body.
 *   - empty body ⇒ 'skipped'. Nothing to extract; stored for the record.
 *   - otherwise 'pending', on CONTENT rather than on whether we could name a
 *     target: an unmatched reply can still be a real quote about a real site,
 *     and price history is keyed by domain, so it has somewhere to land
 *     (PRICE-HISTORY-PLAN.md §5.2 Requirement 2).
 */
export function buildInboundReply(input: {
  account: Account;
  msg: IncomingEmail;
  match: MatchResult;
  /** The open deal holding this thread, when one does. */
  deal?: Deal;
}): Reply {
  const { account, msg, match, deal } = input;
  const isEmpty = !msg.text?.trim();

  return {
    id: newId('reply'),
    emailId: msg.emailId,
    ...(msg.threadId ? { threadId: msg.threadId } : {}),
    rfcMessageId: msg.rfcMessageId,
    fromAddress: msg.fromAddress,
    // Which of our mailboxes this landed in. The polling account IS the answer —
    // it was simply never recorded, leaving every stored reply with an empty
    // accountId and the responses feed re-deriving it from the outreach thread.
    accountId: account.id,
    ...(msg.subject ? { subject: msg.subject } : {}),
    ...(match.targetId ? { targetId: match.targetId } : {}),
    matchMethod: match.method,
    receivedAt: msg.receivedAt,
    text: msg.text,
    // The publisher's rate card and their invoice both arrive this way.
    ...(msg.attachments?.length ? { attachments: msg.attachments } : {}),
    extractionStatus: deal || isEmpty ? 'skipped' : 'pending',
    ...(deal ? { dealId: deal.id } : {}),
  };
}
