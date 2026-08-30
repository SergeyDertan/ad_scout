// The hold check, shared by every path that ingests or extracts a message.
//
// It lives here rather than inside one pass because there are THREE entry points
// into the inbox — the poll pass (fetch + extract), the fetch pass (what the drip
// scheduler actually runs), and extractPendingReplies (the retry/bulk queue) —
// and a hold that only one of them honours is not a hold. See domain/types.ts
// `Deal` for what being held means.

import { isDealOpen } from '../domain/deals';
import type { Deal } from '../domain/types';
import type { Store } from '../ports/store';

/**
 * The open deal this thread belongs to, if any. Two point reads, no scan:
 * ThreadLink is keyed by threadId, and the deal's STATUS (not the link's
 * existence) decides.
 *
 * That split is deliberate. Links survive a deal closing, so a finished deal
 * keeps the record of which threads it used, while a later message on one of
 * those threads — a fresh rate card, a price update months on — is extracted
 * normally again. Closing the deal is the only thing that lifts a hold; there is
 * no timer, by design.
 */
export async function heldDeal(store: Store, threadId?: string): Promise<Deal | undefined> {
  if (!threadId) return undefined;
  const link = await store.getThreadLink(threadId);
  if (!link) return undefined;
  const deal = await store.getDeal(link.dealId);
  return isDealOpen(deal) ? deal : undefined;
}

/**
 * Every threadId currently under an open deal. Two list reads, done once per
 * run — for the bulk paths, which need the whole set anyway. The per-message
 * paths use `heldDeal` instead.
 */
export async function openDealThreadIds(store: Store): Promise<Set<string>> {
  const openIds = new Set((await store.listDeals()).filter(isDealOpen).map((d) => d.id));
  const links = await store.listThreadLinks();
  return new Set(links.filter((l) => openIds.has(l.dealId)).map((l) => l.threadId));
}
