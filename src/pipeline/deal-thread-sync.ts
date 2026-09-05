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

  // Every Message-Id we already hold, so our own sends are recognised rather
  // than adopted a second time. Grown as we go, which also dedupes a message
  // that somehow appears on two of a deal's threads.
  const known = new Set(
    (await store.listOutreaches()).map((o) => o.rfcMessageId).filter(Boolean),
  );
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
        if (!msg.rfcMessageId || known.has(msg.rfcMessageId)) continue;

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
          threadId: link.threadId,
          subject: msg.subject,
          body: msg.text,
          reservedAt: msg.receivedAt,
          sentAt: msg.receivedAt,
          attempts: 1,
        };
        await store.putOutreach(outreach);
        known.add(msg.rfcMessageId);
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
