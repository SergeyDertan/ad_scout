// Pure reply-matching + bounce detection (overview.md §4). No I/O.
// Match order: threadId  →  exact fromAddress (awaiting targets)  →  unmatched.
// We NEVER parse Re:/References headers — the server already computed threading.

import { normalizeDomain } from './domain';
import type { MatchMethod, PostOffer, Target } from './types';

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
 * result — price/canPost, or an opt-out).
 *
 * NOTE: with per-domain price history this NO LONGER gates extraction — a later
 * substantive reply must still be extracted so it appends a PriceRecord
 * (PRICE-HISTORY-PLAN.md §5.2 Requirement 2). `target.result` is preserved as the
 * latest substantive snapshot by rollUp's own guard, not by skipping the reply.
 * Kept for callers that want the "has an answer" predicate.
 */
export function isTargetResolved(target: Pick<Target, 'result'> | undefined): boolean {
  return target?.result != null;
}

/**
 * Build an `email → domain[]` map from all targets (D4/M1). A sender's untagged
 * offer is attributed to their associated domain; a sender associated with 2+
 * domains is ambiguous and pushed to review (D11). Keyed by normalized email,
 * values are normalized, de-duplicated domains.
 */
export function emailToDomains(
  targets: Pick<Target, 'contactEmail' | 'websiteUrl'>[],
): Map<string, string[]> {
  const sets = new Map<string, Set<string>>();
  for (const t of targets) {
    const email = normalizeEmail(t.contactEmail);
    const domain = normalizeDomain(t.websiteUrl);
    if (!email || !domain) continue;
    if (!sets.has(email)) sets.set(email, new Set());
    sets.get(email)!.add(domain);
  }
  return new Map([...sets].map(([email, ds]) => [email, [...ds]]));
}

/** One domain's slice of a reply's offers, with how it was attributed (D4). */
export interface DomainGroup {
  domain: string;
  offers: PostOffer[];
  attribution: 'sender' | 'named';
}

export interface AttributionResult {
  groups: DomainGroup[];
  /** D11 ambiguity reasons to push onto reply.review[]. */
  reviewReasons: string[];
}

/**
 * Split a reply's offers into per-domain groups (PRICE-HISTORY-PLAN.md §5.2):
 *  - offer tagged with a `website` → that site's domain, attribution 'named' (M2);
 *  - untagged offer + a matched target → THAT target's domain, 'sender' (M1);
 *  - untagged offer + sender→exactly 1 domain → that domain, 'sender' (M1);
 *  - untagged offer + sender→2+ domains → ambiguous, push a review reason, skip;
 *  - untagged offer + sender→0 domains → nothing to attribute.
 *
 * `ownDomain` is the domain of the target the reply was matched to. It takes
 * precedence because a matched reply is an answer to the mail we sent ABOUT that
 * site, so an untagged price is that site's price. Without it, an owner running
 * several of our targets from one mailbox made every untagged price ambiguous —
 * and the contacted site ended up with no prices at all while the sites they
 * happened to name got them.
 *
 * Pure — the caller owns persistence.
 */
export function attributeOffers(
  offers: PostOffer[],
  senderDomains: string[],
  ownDomain?: string,
): AttributionResult {
  const groups = new Map<string, DomainGroup>();
  const reviewReasons: string[] = [];
  let flaggedMulti = false;

  const add = (domain: string, attribution: 'sender' | 'named', offer: PostOffer) => {
    if (!domain) return;
    const g = groups.get(domain) ?? { domain, offers: [], attribution };
    g.offers.push(offer);
    groups.set(domain, g);
  };

  for (const offer of offers) {
    const website = offer.website?.trim();
    if (website) {
      add(normalizeDomain(website), 'named', offer);
      continue;
    }
    if (ownDomain) {
      add(ownDomain, 'sender', offer);
    } else if (senderDomains.length === 1) {
      add(senderDomains[0]!, 'sender', offer);
    } else if (senderDomains.length >= 2 && !flaggedMulti) {
      reviewReasons.push(
        `Untagged price(s) but the sender is associated with ${senderDomains.length} sites ` +
          `(${senderDomains.join(', ')}) — attribute the price manually.`,
      );
      flaggedMulti = true;
    }
    // 0 domains, no website → nothing to attribute.
  }

  return { groups: [...groups.values()], reviewReasons };
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
