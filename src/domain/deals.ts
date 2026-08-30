// Deal rules (pure). A deal is a human-operated negotiation about publishing
// posts; while it is open, the pipeline stores its messages and touches nothing
// else. Everything here is a decision ABOUT that state — no I/O, no clock.

import { OPEN_DEAL_STATUSES, type Deal, type DealStatus, type Placement } from './types';

/**
 * Is this deal still being worked by a human? The single source of truth for
 * whether a thread is held: a ThreadLink says which deal a thread belongs to,
 * this says whether that deal still suspends the pipeline.
 *
 * Absent deal ⇒ not open. A ThreadLink can outlive its deal (the deal was
 * deleted, the store is mid-migration), and the safe reading of a dangling link
 * is "no hold" — extracting a reply we could have skipped is recoverable, while
 * silently holding a thread nobody can see is not.
 */
export function isDealOpen(deal: Deal | undefined): boolean {
  return deal != null && OPEN_DEAL_STATUSES.includes(deal.status);
}

/** Terminal statuses — the deal is over, whichever way it went. */
export function isDealClosed(deal: Deal): boolean {
  return !isDealOpen(deal);
}

/**
 * The domains a deal covers: exactly its placements' domains, de-duplicated and
 * sorted. Deliberately derived rather than stored — a `deal.domains` field and
 * the placements would be two lists of the same thing, free to drift apart.
 */
export function dealDomains(placements: Placement[]): string[] {
  return [...new Set(placements.map((p) => p.domain))].sort();
}

/** Whether a placement has been paid for. The UI's checkbox; the timestamp
 *  itself answers "for how long has this been outstanding". */
export function isPaid(p: Placement): boolean {
  return p.paidAt != null;
}

/** Whether the post is live. `liveAt` is the fact; `publishedUrl` is the
 *  evidence, and may arrive later (or never, for a placement we can't link). */
export function isPublished(p: Placement): boolean {
  return p.liveAt != null || p.publishedUrl != null;
}

/**
 * Is every placement both paid and live? The condition for a deal being finished
 * — used to prompt the human, never to move the status on its own. A deal ends
 * when a person says it ended.
 */
export function isFulfilled(placements: Placement[]): boolean {
  return placements.length > 0 && placements.every((p) => isPaid(p) && isPublished(p));
}

/**
 * Which status transitions are allowed. Forward through the two working stages,
 * either terminal from either stage, and reopening a terminal deal back to
 * whichever stage it needs — a "done" deal whose post quietly disappears has to
 * be able to become live work again.
 */
const TRANSITIONS: Record<DealStatus, DealStatus[]> = {
  negotiation: ['fulfilment', 'done', 'closed'],
  fulfilment: ['negotiation', 'done', 'closed'],
  done: ['negotiation', 'fulfilment', 'closed'],
  closed: ['negotiation', 'fulfilment', 'done'],
};

export function canTransition(from: DealStatus, to: DealStatus): boolean {
  return from === to || (TRANSITIONS[from]?.includes(to) ?? false);
}
