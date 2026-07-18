// Fetch-only pass: pull inbound email, dedupe, detect bounces, match to
// targets, and store replies with extractionStatus='pending'. No AI extraction.
// Run poll-pass afterward (or separately) to extract posting terms.

import {
  detectBounce,
  matchReply,
  normalizeEmail,
  type AwaitingTargetRef,
  type SentOutreachRef,
} from '../domain/reply-matching';
import { LABELS, type OutcomeLabel } from '../domain/labels';
import type { Account, Reply, Suppression } from '../domain/types';
import type { Clock } from '../lib/clock';
import { describeError } from '../lib/errors';
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
  /** Matched replies stored 'skipped' because the body was empty. */
  skipped: number;
  /** Inbound dropped pre-storage because the sender is on the ignore list. */
  ignored: number;
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
    ignored: 0,
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
        email: account.email,
        ...describeError(err),
      });
      continue;
    }
    report.fetched += messages.length;

    for (const msg of messages) {
      await handleMessage(deps, account, msg, sentRefs, awaiting, report);
    }

    // Merge (don't overwrite): the gmail-api provider may have written a fresh
    // historyId into pollCursor during fetchReplies — preserve it.
    await store.updateAccount(account.id, (current) => ({
      ...current,
      pollCursor: {
        ...current.pollCursor,
        mailbox: 'INBOX',
        lastPolledAt: clock.now().toISOString(),
      },
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

/** Mark a fetched message read — "the system saw it". Never throws: a mailbox
 *  mutation failure (e.g. an account still on the old readonly scope) must not
 *  fail the pass. */
async function markRead(deps: FetchDeps, account: Account, emailId: string): Promise<void> {
  try {
    await deps.email.markRead(account, emailId);
  } catch (err) {
    logger.warn('markRead failed', { account: account.id, emailId, ...describeError(err) });
  }
}

/** Apply a decision label to a message (best-effort, same non-fatal contract).
 *  This pass does no extraction, so a matched reply gets the provisional
 *  AS/Replied; a later poll's extractPendingReplies swaps in the outcome. */
async function applyLabel(
  deps: FetchDeps,
  account: Account,
  emailId: string,
  label: OutcomeLabel,
): Promise<void> {
  try {
    await deps.email.applyLabel(account, emailId, label);
  } catch (err) {
    logger.warn('applyLabel failed', { account: account.id, emailId, label, ...describeError(err) });
  }
}

async function handleMessage(
  deps: FetchDeps,
  account: Account,
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

  // The system has now fetched and seen this message — mark it read regardless of
  // what we decide about it below. The label records the decision.
  await markRead(deps, account, msg.emailId);

  // Ignore list (D6): drop spam / automated senders before any work or storage.
  if (await store.isIgnored(msg.fromAddress)) {
    await applyLabel(deps, account, msg.emailId, LABELS.ignored);
    report.ignored++;
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
    await applyLabel(deps, account, msg.emailId, LABELS.bounced);
    report.bounced++;
    return;
  }

  const match = matchReply(
    { ...(msg.threadId ? { threadId: msg.threadId } : {}), fromAddress: msg.fromAddress },
    sentRefs,
    awaiting,
  );

  // Every matched, non-empty reply enters the extraction queue as 'pending' — a
  // later substantive reply must still be extracted so it appends a PriceRecord
  // (PRICE-HISTORY-PLAN.md §5.2 Requirement 2). Empty bodies are stored 'skipped'.
  const target = match.targetId ? await store.getTarget(match.targetId) : undefined;
  const isEmpty = !msg.text?.trim();

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
    extractionStatus: match.targetId && !isEmpty ? 'pending' : 'skipped',
  };

  await store.putReply(reply);

  if (!match.targetId) {
    await applyLabel(deps, account, msg.emailId, LABELS.unmatched);
    report.unmatched++;
    return;
  }
  report.matched++;
  // Matched to a target. This pass doesn't extract, so apply the provisional
  // AS/Replied — a later poll's extractPendingReplies refines it to the outcome.
  await applyLabel(deps, account, msg.emailId, LABELS.matched);
  if (isEmpty) {
    report.skipped++;
  } else if (target) {
    await store.updateTarget(target.id, (t) =>
      t.status === 'bounced' || t.status === 'excluded' ? t : { ...t, status: 'replied' },
    );
  }
}
