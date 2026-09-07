// Adopting messages a PERSON sent from their own mail client.
//
// Every other read path in this system is the inbox: fetchReplies pulls INBOX
// (+ Spam) and explicitly drops SENT, because our own pitch must never reach the
// price extractor. That is right, and this does not change it.
//
// It leaves one hole, and only one place where the hole matters. A deal is a
// conversation a human is running; if they answer the publisher from the Gmail
// app rather than from the Deals view, their message exists only in Sent, so the
// negotiation renders as the publisher talking to themselves. This pass closes
// that hole and nothing else:
//
//   - It reads THREADS, by id, and only threads already under an OPEN deal.
//     Never a mailbox query, so no widening can leak our own mail into polling.
//   - It records only messages from the account's own address. Inbound stays the
//     property of the poll/fetch pass, which owns labelling, mark-read and the
//     hold — none of which should have a second implementation.
//   - It is idempotent on rfcMessageId, so AdScout's own sends (whose Message-Id
//     we generated) are recognised and never duplicated.
//
// The adopted message is an ordinary sent Outreach, which is what it is: it went
// out of that mailbox and cost the same deliverability as any other. `sentToday`
// keys on reservedAt, set here to when the message was actually sent — so a
// backfill of last week's mail cannot eat today's quota.

import { isDealOpen } from '../domain/deals';
import { normalizeEmail } from '../domain/reply-matching';
import type { Outreach } from '../domain/types';
import { describeError } from '../lib/errors';
import { newId } from '../lib/ids';
import { logger } from '../lib/logger';
import type { EmailProvider } from '../ports/email-provider';
import type { Store } from '../ports/store';

export interface DealThreadSyncDeps {
  store: Store;
  email: EmailProvider;
}

export interface DealThreadSyncOpts {
  /** Abort signal — checked before each thread. */
  signal?: AbortSignal;
}

export interface DealThreadSyncReport {
  /** Conversations read. */
  threads: number;
  /** Messages recorded that the polling path could never have seen. */
  dealMessages: number;
}

/**
 * How far apart our record of a send and the mailbox's copy of it may sit and
 * still be the same message. `sentAt` is stamped when we call the provider; the
 * mailbox stamps when the provider accepted. Observed against production: 40 ms
 * and 2.8 s. Two minutes is far more room than that needs, and still far less
 * than the gap between a message and a genuine re-send of the same text.
 */
const SAME_MESSAGE_WINDOW_MS = 2 * 60_000;

/** Bodies survive a MIME round-trip with their whitespace rearranged — soft line
 *  breaks, CRLF, a trailing newline. Compare what the words are, not how the
 *  transfer encoding laid them out. */
function normalizeBody(body: string): string {
  return body.replace(/\s+/g, ' ').trim();
}

/**
 * Is this thread message one WE sent, seen from the other side?
 *
 * The last line of defence, and the only one that can speak for the outreaches
 * written before `emailId` existed — rows whose stored Message-Id Gmail replaced
 * and therefore matches nothing in the mailbox. Same thread, same words, sent
 * within a couple of minutes of each other: that is not a coincidence, it is the
 * message.
 *
 * Being wrong here is cheap and asymmetric, which is why the test can afford to
 * be this blunt. A false positive skips adopting a message that genuinely was
 * hand-sent — it stays visible in Gmail, and the timeline is missing a line. A
 * false negative is the bug we are fixing: the operator's own message, printed
 * to them twice.
 */
function isOneOfOurSends(
  sent: Array<{ body: string; at: number }> | undefined,
  text: string,
  receivedAt: string,
): boolean {
  if (!sent?.length) return false;
  const body = normalizeBody(text);
  if (!body) return false;
  const at = new Date(receivedAt).getTime();
  return sent.some(
    (s) => s.body === body && Math.abs(s.at - at) <= SAME_MESSAGE_WINDOW_MS,
  );
}

export async function syncDealThreads(
  deps: DealThreadSyncDeps,
  opts: DealThreadSyncOpts = {},
): Promise<DealThreadSyncReport> {
  const { store, email } = deps;
  const report: DealThreadSyncReport = { threads: 0, dealMessages: 0 };

  const deals = (await store.listDeals()).filter(isDealOpen);
  // Nothing open ⇒ nothing to read. Worth the early return: everything below is
  // a full-collection scan, and most passes run with no deal in flight at all.
  if (deals.length === 0) return report;

  // Everything we already hold, so our own sends are recognised rather than
  // adopted a second time. Grown as we go, which also dedupes a message that
  // somehow appears on two of a deal's threads.
  //
  // THREE KEYS, BECAUSE ONE IS NOT ENOUGH — and the missing two are this pass's
  // original bug. It matched on rfcMessageId alone, which is a value we generate
  // and Gmail then REPLACES on send. So every message AdScout itself sent came
  // back through fetchThread wearing an id we had never stored, failed the test,
  // and was adopted as a second copy of itself. In the Deals view that is the
  // same message twice.
  //
  //   emailId      the provider's own id, recorded at send since this fix. Exact,
  //                and the one that actually settles it going forward.
  //   rfcMessageId still correct for SMTP (which does not rewrite), for a message
  //                genuinely hand-sent from Gmail and adopted earlier, and for a
  //                second pass over anything already adopted.
  //   thread+body  the fallback that covers HISTORY. Some 5.4k outreaches predate
  //                emailId and carry a Message-Id Gmail discarded, so neither key
  //                above can recognise them; without this, opening a deal on an
  //                old thread duplicates every message we ever sent on it.
  const outreaches = await store.listOutreaches();
  const knownEmailIds = new Set(outreaches.map((o) => o.emailId).filter(Boolean));
  const knownMessageIds = new Set(outreaches.map((o) => o.rfcMessageId).filter(Boolean));

  // Per thread, what we sent and when — the body/time index behind the fallback.
  const sentOnThread = new Map<string, Array<{ body: string; at: number }>>();
  const noteSend = (threadId: string | undefined, body: string, at: string): void => {
    if (!threadId) return;
    const list = sentOnThread.get(threadId) ?? [];
    list.push({ body: normalizeBody(body), at: new Date(at).getTime() });
    sentOnThread.set(threadId, list);
  };
  for (const o of outreaches) noteSend(o.threadId, o.body, o.sentAt ?? o.reservedAt);
  // Mirrors targetForDeal in deal-send.ts — resolved once here rather than per
  // deal, because that helper lists every target on each call.
  const targetByEmail = new Map(
    (await store.listTargets()).map((t) => [normalizeEmail(t.contactEmail), t.id]),
  );

  for (const deal of deals) {
    if (opts.signal?.aborted) break;
    const account = await store.getAccount(deal.accountId);
    // A paused mailbox is one we have been told to leave alone.
    if (!account || account.status === 'paused') continue;
    const ours = normalizeEmail(account.email);
    const targetId = targetByEmail.get(normalizeEmail(deal.counterpartyEmail));

    for (const link of await store.listThreadLinks({ dealId: deal.id })) {
      if (opts.signal?.aborted) break;

      let messages;
      try {
        messages = await email.fetchThread(account, link.threadId);
      } catch (err) {
        // Best-effort by design: a thread we could not read this time is read on
        // the next pass. Failing the whole pass over it would take the inbox
        // down with it, and the inbox is the part that must not stop.
        logger.warn('could not read a deal thread', {
          deal: deal.id,
          account: account.id,
          threadId: link.threadId,
          ...describeError(err),
        });
        continue;
      }
      report.threads++;

      for (const msg of messages) {
        // Not ours ⇒ the poll/fetch pass owns it, hold and labels included.
        if (normalizeEmail(msg.fromAddress) !== ours) continue;
        if (!msg.rfcMessageId) continue;
        if (msg.emailId && knownEmailIds.has(msg.emailId)) continue;
        if (knownMessageIds.has(msg.rfcMessageId)) continue;
        if (isOneOfOurSends(sentOnThread.get(link.threadId), msg.text, msg.receivedAt)) continue;

        const outreach: Outreach = {
          id: newId('outreach'),
          ...(targetId ? { targetId } : {}),
          dealId: deal.id,
          accountId: account.id,
          // Written by a person — which is what 'manual' means. That it was
          // typed in Gmail rather than in the Deals view changes nothing about
          // the message.
          kind: 'manual',
          sequenceNo: 0,
          status: 'sent',
          rfcMessageId: msg.rfcMessageId,
          // Read out of the mailbox, so this one IS the provider's own id — no
          // rewriting stands between it and the message it names.
          emailId: msg.emailId,
          threadId: link.threadId,
          subject: msg.subject,
          body: msg.text,
          reservedAt: msg.receivedAt,
          sentAt: msg.receivedAt,
          attempts: 1,
        };
        await store.putOutreach(outreach);
        knownEmailIds.add(msg.emailId);
        knownMessageIds.add(msg.rfcMessageId);
        noteSend(link.threadId, msg.text, msg.receivedAt);
        report.dealMessages++;
        logger.info('adopted a hand-sent deal message', {
          deal: deal.id,
          account: account.id,
          threadId: link.threadId,
          sentAt: msg.receivedAt,
        });
      }
    }
  }

  return report;
}
