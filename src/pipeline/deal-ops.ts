// Deal lifecycle: opening one, attaching threads to it, moving its status, and
// editing its placements. The pure rules live in domain/deals.ts; this is the
// store-touching half the API routes call.

import { canTransition, isDealOpen } from '../domain/deals';
import { normalizeDomain } from '../domain/domain';
import { normalizeEmail } from '../domain/reply-matching';
import type { Deal, DealStatus, ID, Placement } from '../domain/types';
import type { Clock } from '../lib/clock';
import { newId } from '../lib/ids';
import type { Store } from '../ports/store';

export interface OpenDealInput {
  counterpartyEmail: string;
  accountId: ID;
  origin?: Deal['origin'];
  /** Threads to hold immediately (the conversation already under way). */
  threadIds?: string[];
  /** Domains to start with — each becomes a draft Placement. */
  domains?: string[];
  note?: string;
}

/**
 * Open a deal and hold its threads.
 *
 * Idempotent on (counterpartyEmail, thread): if one of `threadIds` is already
 * held by an OPEN deal, that deal is returned and extended rather than a second
 * one created. Two open deals on one thread would each claim the same
 * conversation, and whichever the reverse index happened to point at would
 * decide where a reply landed.
 */
export async function openDeal(
  store: Store,
  clock: Clock,
  input: OpenDealInput,
): Promise<Deal> {
  const counterpartyEmail = normalizeEmail(input.counterpartyEmail);
  // No threads named ⇒ adopt the conversation we already have with this address.
  // This is the whole point of the common case: you are writing to a publisher
  // who already sent you prices, so the deal must continue THAT thread rather
  // than opening a second one they'd have to reconcile by hand.
  const threadIds = input.threadIds?.length
    ? input.threadIds
    : await discoverThreads(store, counterpartyEmail, input.accountId);

  for (const threadId of threadIds) {
    const link = await store.getThreadLink(threadId);
    if (!link) continue;
    const existing = await store.getDeal(link.dealId);
    if (isDealOpen(existing)) {
      await attachThreads(store, existing!.id, threadIds);
      await addDomains(store, existing!.id, input.domains ?? []);
      return existing!;
    }
  }

  const deal: Deal = {
    id: newId('deal'),
    counterpartyEmail,
    accountId: input.accountId,
    status: 'negotiation',
    origin: input.origin ?? 'manual',
    openedAt: clock.now().toISOString(),
    ...(input.note ? { note: input.note } : {}),
  };
  await store.putDeal(deal);
  await attachThreads(store, deal.id, threadIds);
  await addDomains(store, deal.id, input.domains ?? []);
  return deal;
}

/**
 * Threads we have already exchanged messages on with this address, RESTRICTED to
 * the mailbox the deal will send from.
 *
 * The account filter is not a nicety. A provider threadId is per-mailbox — Gmail
 * will not graft a message onto a thread that lives in a different account — so
 * adopting a thread we only ever touched from another mailbox would produce a
 * send that either fails or silently starts a fresh thread the publisher sees as
 * unrelated. The same publisher genuinely does get pitched from two accounts, so
 * this is a real case, not a theoretical one.
 *
 * Both directions are consulted: outreach we sent to a target at that address,
 * and replies received FROM it — a publisher often answers from a different
 * mailbox than the one we wrote to, and that reply's thread is the live
 * conversation even though no target points at it.
 */
async function discoverThreads(
  store: Store,
  counterpartyEmail: string,
  accountId: ID,
): Promise<string[]> {
  const threads = new Set<string>();

  const targetIds = new Set(
    (await store.listTargets())
      .filter((t) => normalizeEmail(t.contactEmail) === counterpartyEmail)
      .map((t) => t.id),
  );

  // Every thread this mailbox has sent on — both the ownership test for our own
  // outreach and the fallback for replies stored before Reply.accountId existed.
  const ownThreads = new Set<string>();
  for (const o of await store.listOutreaches()) {
    if (o.accountId === accountId && o.threadId) ownThreads.add(o.threadId);
  }
  for (const o of await store.listOutreaches()) {
    if (o.accountId !== accountId) continue;
    if (o.threadId && o.targetId && targetIds.has(o.targetId)) threads.add(o.threadId);
  }
  for (const r of await store.listReplies()) {
    if (!r.threadId || normalizeEmail(r.fromAddress) !== counterpartyEmail) continue;
    // Older replies carry no accountId; fall back to whether this mailbox owns
    // the thread, rather than discarding a real conversation over a missing field.
    const mine = r.accountId ? r.accountId === accountId : ownThreads.has(r.threadId);
    if (mine) threads.add(r.threadId);
  }
  return [...threads];
}

/** Point each thread at this deal. Re-pointing a thread already linked elsewhere
 *  is allowed — the newest claim wins, which is what moving a conversation
 *  between deals means. */
export async function attachThreads(
  store: Store,
  dealId: ID,
  threadIds: string[],
): Promise<void> {
  for (const threadId of threadIds) {
    await store.putThreadLink({ id: threadId, threadId, dealId });
  }
}

/** Create a draft placement per domain, skipping any the deal already covers. */
export async function addDomains(
  store: Store,
  dealId: ID,
  domains: string[],
): Promise<Placement[]> {
  const existing = new Set((await store.listPlacements({ dealId })).map((p) => p.domain));
  const added: Placement[] = [];
  for (const raw of domains) {
    const domain = normalizeDomain(raw);
    if (!domain || existing.has(domain)) continue;
    existing.add(domain);
    added.push(await store.putPlacement({ id: newId('placement'), dealId, domain }));
  }
  return added;
}

export class DealTransitionError extends Error {}

/**
 * Move a deal's status. Closing does NOT delete the thread links: a finished
 * deal keeps the record of which conversations it used, and the hold is decided
 * by the status alone (see `isDealOpen`), so leaving the links costs nothing and
 * makes reopening work.
 */
export async function setDealStatus(
  store: Store,
  clock: Clock,
  dealId: ID,
  status: DealStatus,
  closedReason?: string,
): Promise<Deal> {
  const deal = await store.getDeal(dealId);
  if (!deal) throw new Error(`deal not found: ${dealId}`);
  if (!canTransition(deal.status, status)) {
    throw new DealTransitionError(`cannot move a deal from ${deal.status} to ${status}`);
  }

  const terminal = status === 'done' || status === 'closed';
  const { closedAt: _prevAt, closedReason: _prevReason, ...rest } = deal;
  const next: Deal = {
    ...rest,
    status,
    // Reopening clears the closing record rather than leaving a stale reason on
    // a live deal.
    ...(terminal ? { closedAt: clock.now().toISOString() } : {}),
    ...(terminal && closedReason ? { closedReason } : {}),
  };
  await store.putDeal(next);
  return next;
}

/** Apply a partial edit to a placement. `id`/`dealId` are not editable — moving
 *  a post between deals is a delete plus an add, not a field change. */
export async function updatePlacement(
  store: Store,
  placementId: ID,
  patch: Partial<Omit<Placement, 'id' | 'dealId'>>,
): Promise<Placement> {
  const current = await store.getPlacement(placementId);
  if (!current) throw new Error(`placement not found: ${placementId}`);
  const next: Placement = { ...current, ...patch, id: current.id, dealId: current.dealId };
  return store.putPlacement(next);
}
