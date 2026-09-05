// Sending a message a PERSON wrote, inside a deal.
//
// Structurally this is send-pass's reserve → send → record discipline with three
// differences, each of them deliberate:
//
//   1. The quota is COUNTED but never ENFORCED. A manual outreach lands in the
//      same append-only log, so `sentToday` sees every mail the mailbox actually
//      sent (deliverability is physical — a deal message costs exactly what a
//      cold one does). But a spent drip quota must never stop you answering a
//      publisher who is waiting on you, so nothing here consults `canSend`.
//   2. It threads. In-Reply-To/References are built from the conversation so
//      far, so the message arrives as a reply rather than as a fresh email.
//   3. Sending holds the thread. The resulting threadId is linked to the deal
//      before anything else can poll it, which is what stops the extractor from
//      touching the publisher's answer.

import { normalizeEmail } from '../domain/reply-matching';
import type { Deal, ID, Outreach, Reply } from '../domain/types';
import type { Clock } from '../lib/clock';
import { describeError } from '../lib/errors';
import { newId, newMessageId } from '../lib/ids';
import { logger } from '../lib/logger';
import type { EmailProvider } from '../ports/email-provider';
import type { Store } from '../ports/store';

export interface DealSendDeps {
  store: Store;
  email: EmailProvider;
  clock: Clock;
}

export interface DealSendInput {
  dealId: ID;
  /**
   * The subject line. Omit it for the normal case — a reply into an existing
   * conversation — and the thread's own subject is used, prefixed `Re:`. It is
   * only required for the first message on a deal that has no thread yet, since
   * an email cannot be sent without one.
   */
  subject?: string;
  body: string;
  /**
   * Which conversation to continue. Omit to reply on the deal's most recent
   * thread, or when the deal has none yet — then this opens a new one.
   */
  threadId?: string;
}

export interface DealSendResult {
  outreach: Outreach;
  /** The thread the message landed in — new deals learn theirs from this. */
  threadId?: string;
}

/** One message in a thread, outbound or inbound, reduced to what a reply needs:
 *  the id to chain onto, and the subject to answer under. Either can be missing —
 *  a stored message predating a field simply drops out of that calculation. */
interface ThreadMessage {
  at: string;
  rfcMessageId?: string;
  subject?: string;
}

/**
 * The RFC 5322 threading headers for the next message on `threadId`.
 *
 * `In-Reply-To` is the newest message in the thread; `References` is the chain
 * that came before it, oldest first, per RFC 5322 §3.6.4. Both are built from
 * what we have stored rather than parsed out of a header we received — the same
 * principle as reply-matching, where the provider's own ids are trusted over
 * anything reconstructed from `Re:` prefixes.
 *
 * A thread we have no record of yields nothing, and the message opens a new one.
 */
export function threadingHeaders(messages: ThreadMessage[]): {
  inReplyTo?: string;
  references?: string[];
} {
  const chain = messages
    .filter((m): m is ThreadMessage & { rfcMessageId: string } => Boolean(m.rfcMessageId))
    .sort((a, b) => a.at.localeCompare(b.at));
  if (chain.length === 0) return {};
  const parent = chain[chain.length - 1]!;
  return {
    inReplyTo: parent.rfcMessageId,
    references: chain.map((m) => m.rfcMessageId),
  };
}

/**
 * The subject to answer a thread under: the newest message's, prefixed `Re:`.
 *
 * A person negotiating should never have to retype this, and letting them edit
 * it is worse than pointless — the RFC headers keep the message threaded either
 * way, but Gmail groups the conversation it SHOWS the publisher by subject too,
 * so a changed line splits the thread on their side for no gain. Undefined only
 * when the thread has no subject to inherit, which means a brand-new one.
 */
export function replySubject(messages: ThreadMessage[]): string | undefined {
  const newest = [...messages]
    .filter((m) => m.subject?.trim())
    .sort((a, b) => b.at.localeCompare(a.at))[0];
  const subject = newest?.subject?.trim();
  if (!subject) return undefined;
  return /^re:/i.test(subject) ? subject : `Re: ${subject}`;
}

/** No subject given, and no thread to inherit one from — a client-input error,
 *  not a send failure, so the API can answer 400 rather than 502. */
export class MissingSubjectError extends Error {}

/** Everything we have sent or received on one thread — the header chain, and the
 *  subject to reply under. Messages missing an id still count for the subject. */
async function threadHistory(store: Store, threadId: string): Promise<ThreadMessage[]> {
  const out: ThreadMessage[] = [];
  for (const o of await store.listOutreaches()) {
    if (o.threadId === threadId) {
      out.push({
        at: o.sentAt ?? o.reservedAt,
        ...(o.rfcMessageId ? { rfcMessageId: o.rfcMessageId } : {}),
        subject: o.subject,
      });
    }
  }
  for (const r of await store.listReplies()) {
    if (r.threadId === threadId) {
      out.push({
        at: r.receivedAt,
        ...(r.rfcMessageId ? { rfcMessageId: r.rfcMessageId } : {}),
        ...(r.subject ? { subject: r.subject } : {}),
      });
    }
  }
  return out;
}

/**
 * Which of the deal's threads to reply into, when the caller didn't name one.
 *
 * A thread the publisher has ANSWERED beats one that is merely more recent. The
 * same webmaster is often pitched twice from different mailboxes: an old thread
 * where they sent a rate card, and a newer cold pitch they ignored. "Most recent
 * activity" picks the one they ignored — which is exactly the conversation they
 * have no context for. Rank by their last reply, and only fall back to raw
 * activity for a thread nobody has answered yet.
 */
async function newestThread(store: Store, dealId: ID): Promise<string | undefined> {
  const links = await store.listThreadLinks({ dealId });
  if (links.length <= 1) return links[0]?.threadId;

  const lastInbound = new Map<string, string>();
  const lastAny = new Map<string, string>();
  const note = (map: Map<string, string>, threadId: string | undefined, at: string): void => {
    if (!threadId) return;
    const prev = map.get(threadId);
    if (!prev || at > prev) map.set(threadId, at);
  };
  for (const o of await store.listOutreaches()) note(lastAny, o.threadId, o.sentAt ?? o.reservedAt);
  for (const r of await store.listReplies()) {
    note(lastAny, r.threadId, r.receivedAt);
    note(lastInbound, r.threadId, r.receivedAt);
  }

  return links
    .map((l) => l.threadId)
    .sort((a, b) => {
      const answered = Number(lastInbound.has(b)) - Number(lastInbound.has(a));
      if (answered !== 0) return answered;
      const key = lastInbound.has(a) && lastInbound.has(b) ? lastInbound : lastAny;
      return (key.get(b) ?? '').localeCompare(key.get(a) ?? '');
    })[0];
}

/**
 * Send one manual message inside a deal. Reserves the Outreach BEFORE the network
 * call (so a crash mid-send leaves a visible reservation rather than a silent
 * gap), then records the outcome and makes sure the thread is held.
 */
export async function sendDealMessage(
  deps: DealSendDeps,
  input: DealSendInput,
): Promise<DealSendResult> {
  const { store, email, clock } = deps;

  const deal = await store.getDeal(input.dealId);
  if (!deal) throw new Error(`deal not found: ${input.dealId}`);
  const account = await store.getAccount(deal.accountId);
  if (!account) throw new Error(`deal ${deal.id} references a missing account: ${deal.accountId}`);

  const threadId = input.threadId ?? (await newestThread(store, deal.id));
  const history = threadId ? await threadHistory(store, threadId) : [];
  const headers = threadingHeaders(history);

  // Given only for the first message on a deal with no conversation yet; every
  // reply inherits the thread's own line.
  const subject = input.subject?.trim() || replySubject(history);
  if (!subject) {
    throw new MissingSubjectError(
      'this deal has no thread to reply into — a subject is required for the first message',
    );
  }

  const now = clock.now();
  const rfcMessageId = newMessageId();
  const outreach: Outreach = {
    id: newId('outreach'),
    ...(await targetForDeal(store, deal)),
    dealId: deal.id,
    accountId: account.id,
    kind: 'manual',
    // Manual messages are not a sequence — they are a conversation. 0 keeps the
    // field honest without implying a position the send pass could act on.
    sequenceNo: 0,
    status: 'reserved',
    rfcMessageId,
    ...(threadId ? { threadId } : {}),
    subject,
    body: input.body,
    reservedAt: now.toISOString(),
    attempts: 0,
  };
  await store.putOutreach(outreach);

  try {
    const result = await email.send({
      to: deal.counterpartyEmail,
      subject,
      body: input.body,
      rfcMessageId,
      account,
      ...headers,
      ...(threadId ? { threadId } : {}),
    });

    let landedIn = result.threadId ?? threadId;
    if (!landedIn) {
      landedIn = await email.resolveThreadId(account, rfcMessageId).catch(() => undefined);
    }

    const sent: Outreach = {
      ...outreach,
      status: 'sent',
      sentAt: now.toISOString(),
      ...(landedIn ? { threadId: landedIn, threadResolvedAt: now.toISOString() } : {}),
    };
    await store.putOutreach(sent);

    // Hold the thread. Doing this AFTER the send is safe — the publisher cannot
    // have replied yet — and doing it at all is what protects their answer.
    if (landedIn) {
      await store.putThreadLink({ id: landedIn, threadId: landedIn, dealId: deal.id });
    }

    return { outreach: sent, ...(landedIn ? { threadId: landedIn } : {}) };
  } catch (err) {
    const detail = describeError(err);
    logger.warn('deal message send failed', {
      deal: deal.id,
      account: account.id,
      to: deal.counterpartyEmail,
      ...detail,
    });
    const failed: Outreach = {
      ...outreach,
      status: 'failed',
      attempts: outreach.attempts + 1,
      error: detail.error,
    };
    await store.putOutreach(failed);
    throw err;
  }
}

/**
 * The target this deal's messages belong to, when there is one. Looked up by the
 * counterparty's address so the deal's outreach appears on the target's existing
 * timeline; a deal on a domain we never had a target for simply carries none.
 */
async function targetForDeal(store: Store, deal: Deal): Promise<{ targetId?: ID }> {
  const email = normalizeEmail(deal.counterpartyEmail);
  const match = (await store.listTargets()).find((t) => normalizeEmail(t.contactEmail) === email);
  return match ? { targetId: match.id } : {};
}

/** Every message on a deal's threads, oldest first — the timeline the UI renders. */
export async function dealTimeline(
  store: Store,
  dealId: ID,
): Promise<Array<{ kind: 'sent'; at: string; outreach: Outreach } | { kind: 'received'; at: string; reply: Reply }>> {
  const threadIds = new Set((await store.listThreadLinks({ dealId })).map((l) => l.threadId));
  const items: Array<
    { kind: 'sent'; at: string; outreach: Outreach } | { kind: 'received'; at: string; reply: Reply }
  > = [];

  for (const o of await store.listOutreaches()) {
    // Either explicitly ours, or on one of the deal's threads — the latter picks
    // up the original cold outreach that started the conversation.
    if (o.dealId === dealId || (o.threadId && threadIds.has(o.threadId))) {
      items.push({ kind: 'sent', at: o.sentAt ?? o.reservedAt, outreach: o });
    }
  }
  for (const r of await store.listReplies()) {
    if (r.dealId === dealId || (r.threadId && threadIds.has(r.threadId))) {
      items.push({ kind: 'received', at: r.receivedAt, reply: r });
    }
  }
  return items.sort((a, b) => a.at.localeCompare(b.at));
}
