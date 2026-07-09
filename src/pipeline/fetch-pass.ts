// Fetch-only pass: pull inbound email, dedupe, detect bounces, match to
// targets, and store replies with extractionStatus='pending'. No AI extraction.
// Run poll-pass afterward (or separately) to extract posting terms.

import {
  detectBounce,
  isTargetResolved,
  matchReply,
  normalizeEmail,
  type AwaitingTargetRef,
  type SentOutreachRef,
} from '../domain/reply-matching';
import type { Reply, Suppression } from '../domain/types';
import type { Clock } from '../lib/clock';
import { newId } from '../lib/ids';
import { logger } from '../lib/logger';
import type { EmailProvider, IncomingEmail } from '../ports/email-provider';
import type { Store } from '../ports/store';

export interface FetchDeps {
  store: Store;
  email: EmailProvider;
  clock: Clock;
}

export interface FetchReport {
  fetched: number;
  deduped: number;
  bounced: number;
  matched: number;
  unmatched: number;
  /** Matched replies stored 'skipped' because the target was already answered. */
  skipped: number;
}

export async function runFetchPass(deps: FetchDeps): Promise<FetchReport> {
  const { store, email, clock } = deps;
  const report: FetchReport = {
    fetched: 0,
    deduped: 0,
    bounced: 0,
    matched: 0,
    unmatched: 0,
    skipped: 0,
  };

  const sentRefs: SentOutreachRef[] = (await store.listOutreaches())
    .filter((o) => o.threadId)
    .map((o) => ({ targetId: o.targetId, threadId: o.threadId }));
  const awaiting: AwaitingTargetRef[] = (await store.listTargets())
    .filter((t) => t.status === 'contacted' || t.status === 'reserved')
    .map((t) => ({ targetId: t.id, contactEmail: t.contactEmail }));

  for (const account of await store.listAccounts()) {
    if (account.status === 'paused') continue;
    const since = account.pollCursor?.lastPolledAt
      ? new Date(account.pollCursor.lastPolledAt)
      : undefined;

    let messages: IncomingEmail[];
    try {
      messages = await email.fetchReplies(account, since);
    } catch (err) {
      logger.warn('fetchReplies failed', {
        account: account.id,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    report.fetched += messages.length;

    for (const msg of messages) {
      await handleMessage(deps, msg, sentRefs, awaiting, report);
    }

    await store.updateAccount(account.id, (current) => ({
      ...current,
      pollCursor: { mailbox: 'INBOX', lastPolledAt: clock.now().toISOString() },
    }));
  }

  return report;
}

async function suppress(
  store: Store,
  emailAddr: string,
  reason: Suppression['reason'],
  clock: Clock,
): Promise<void> {
  const norm = normalizeEmail(emailAddr);
  await store.addSuppression({ id: norm, email: norm, reason, at: clock.now().toISOString() });
}

async function handleMessage(
  deps: FetchDeps,
  msg: IncomingEmail,
  sentRefs: SentOutreachRef[],
  awaiting: AwaitingTargetRef[],
  report: FetchReport,
): Promise<void> {
  const { store, clock } = deps;

  if (await store.getReplyByEmailId(msg.emailId)) {
    report.deduped++;
    return;
  }

  const bounce = detectBounce(msg.fromAddress, msg.text);
  if (bounce.isBounce) {
    const failed = bounce.failedRecipient;
    if (failed) {
      await suppress(store, failed, 'bounce', clock);
      const target = (await store.listTargets()).find(
        (t) => normalizeEmail(t.contactEmail) === failed,
      );
      if (target) await store.updateTarget(target.id, (t) => ({ ...t, status: 'bounced' }));
    }
    report.bounced++;
    return;
  }

  const match = matchReply(
    { ...(msg.threadId ? { threadId: msg.threadId } : {}), fromAddress: msg.fromAddress },
    sentRefs,
    awaiting,
  );

  // A later reply on an already-answered target is saved for the record but must
  // never enter the extraction queue (store 'skipped', not 'pending').
  const target = match.targetId ? await store.getTarget(match.targetId) : undefined;
  const alreadyAnswered = isTargetResolved(target);

  const reply: Reply = {
    id: newId('reply'),
    emailId: msg.emailId,
    ...(msg.threadId ? { threadId: msg.threadId } : {}),
    rfcMessageId: msg.rfcMessageId,
    fromAddress: msg.fromAddress,
    ...(match.targetId ? { targetId: match.targetId } : {}),
    matchMethod: match.method,
    receivedAt: msg.receivedAt,
    text: msg.text,
    extractionStatus: alreadyAnswered ? 'skipped' : 'pending',
  };

  await store.putReply(reply);

  if (!match.targetId) {
    report.unmatched++;
    return;
  }
  report.matched++;
  if (alreadyAnswered) {
    // Leave the resolved target untouched — preserve its known result.
    report.skipped++;
  } else if (target) {
    await store.updateTarget(target.id, (t) =>
      t.status === 'bounced' || t.status === 'excluded' ? t : { ...t, status: 'replied' },
    );
  }
}
