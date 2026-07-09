// Pure reply-matching + bounce detection (overview.md §4). No I/O.
// Match order: threadId  →  exact fromAddress (awaiting targets)  →  unmatched.
// We NEVER parse Re:/References headers — the server already computed threading.

import type { MatchMethod, Target } from './types';

export interface SentOutreachRef {
  targetId: string;
  threadId?: string;
}

export interface AwaitingTargetRef {
  targetId: string;
  contactEmail: string;
}

export interface IncomingRef {
  threadId?: string;
  fromAddress: string;
}

export interface MatchResult {
  targetId?: string;
  method: MatchMethod;
}

export function normalizeEmail(addr: string): string {
  return addr.trim().toLowerCase();
}

/**
 * True once we already have a substantive outcome for this target (a parsed
 * result — price/canPost, or an opt-out). Further inbound in the same thread is
 * saved for the record but NOT re-extracted, so the known result isn't clobbered
 * and we don't spend AI calls on later chatter. Keyed on `result` (not status)
 * because the fetch-only pass marks a target 'replied' BEFORE extraction runs.
 */
export function isTargetResolved(target: Pick<Target, 'result'> | undefined): boolean {
  return target?.result != null;
}

/**
 * Resolve an inbound message to a target.
 * @param incoming      the inbound message's threadId + fromAddress
 * @param sentOutreaches our sent outreaches that carry a resolved threadId
 * @param awaiting       targets we've contacted and are awaiting a reply from
 */
export function matchReply(
  incoming: IncomingRef,
  sentOutreaches: SentOutreachRef[],
  awaiting: AwaitingTargetRef[],
): MatchResult {
  // 1. Native thread id — the reliable path.
  if (incoming.threadId) {
    const hit = sentOutreaches.find((o) => o.threadId && o.threadId === incoming.threadId);
    if (hit) return { targetId: hit.targetId, method: 'threadId' };
  }
  // 2. Exact from-address against awaiting targets — mops up orphans Gmail
  //    itself couldn't thread. Best-effort: a reply from a different address
  //    than the one we emailed won't match here (only threadId saves those).
  const from = normalizeEmail(incoming.fromAddress);
  const byAddr = awaiting.find((t) => normalizeEmail(t.contactEmail) === from);
  if (byAddr) return { targetId: byAddr.targetId, method: 'fromAddress' };

  // 3. Give up — surfaced in the UI's unmatched queue.
  return { method: 'unmatched' };
}

export interface BounceResult {
  isBounce: boolean;
  failedRecipient?: string;
}

const BOUNCE_SENDERS = [/mailer-daemon@/i, /postmaster@/i];
// Common DSN markers for the failed-recipient address.
const RECIPIENT_PATTERNS = [
  /Final-Recipient:\s*rfc822;\s*([^\s<>]+@[^\s<>]+)/i,
  /Original-Recipient:\s*rfc822;\s*([^\s<>]+@[^\s<>]+)/i,
  /(?:to|recipient)\s*[:<]\s*([^\s<>]+@[^\s<>]+)/i,
];

/**
 * Detect a delivery-failure (bounce) message and recover the failed recipient
 * from the DSN body when possible. Header reconstruction stays out of scope —
 * this is intentionally a light heuristic over the from-address + DSN body.
 */
export function detectBounce(fromAddress: string, text: string): BounceResult {
  const from = normalizeEmail(fromAddress);
  const looksLikeBounce =
    BOUNCE_SENDERS.some((re) => re.test(from)) ||
    /delivery status notification|delivery has failed|undeliverable/i.test(text);
  if (!looksLikeBounce) return { isBounce: false };

  for (const re of RECIPIENT_PATTERNS) {
    const m = text.match(re);
    if (m && m[1]) return { isBounce: true, failedRecipient: normalizeEmail(m[1]) };
  }
  return { isBounce: true };
}
