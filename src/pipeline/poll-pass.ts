// Poll-pass (overview.md §8). Dedupe inbound by emailId → detect bounce →
// match (threadId → fromAddress → unmatched) → store reply → extract → roll up
// onto the target. Opt-outs and bounces add to the persistent suppression list.

import {
  detectBounce,
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
import type { Extractor } from '../services/extractor';

export interface PollDeps {
  store: Store;
  email: EmailProvider;
  extractor: Extractor;
  clock: Clock;
}

export interface PollReport {
  fetched: number;
  deduped: number;
  bounced: number;
  matched: number;
  unmatched: number;
  extracted: number;
  extractionFailed: number;
}

export async function runPollPass(deps: PollDeps): Promise<PollReport> {
  const { store, email, extractor, clock } = deps;
  const report: PollReport = {
    fetched: 0,
    deduped: 0,
    bounced: 0,
    matched: 0,
    unmatched: 0,
    extracted: 0,
    extractionFailed: 0,
  };

  // Matching refs computed once for the pass.
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

    // Advance the cursor.
    await store.putAccount({
      ...account,
      pollCursor: { mailbox: 'INBOX', lastPolledAt: clock.now().toISOString() },
    });
  }

  return report;
}

async function suppress(
  store: Store,
  email: string,
  reason: Suppression['reason'],
  clock: Clock,
): Promise<void> {
  const norm = normalizeEmail(email);
  await store.addSuppression({ id: norm, email: norm, reason, at: clock.now().toISOString() });
}

async function handleMessage(
  deps: PollDeps,
  msg: IncomingEmail,
  sentRefs: SentOutreachRef[],
  awaiting: AwaitingTargetRef[],
  report: PollReport,
): Promise<void> {
  const { store, extractor, clock } = deps;

  // Dedupe on the stable emailId.
  if (await store.getReplyByEmailId(msg.emailId)) {
    report.deduped++;
    return;
  }

  // Bounce?
  const bounce = detectBounce(msg.fromAddress, msg.text);
  if (bounce.isBounce) {
    const failed = bounce.failedRecipient;
    if (failed) {
      await suppress(store, failed, 'bounce', clock);
      const target = (await store.listTargets()).find(
        (t) => normalizeEmail(t.contactEmail) === failed,
      );
      if (target) await store.putTarget({ ...target, status: 'bounced' });
    }
    report.bounced++;
    return;
  }

  // Match.
  const match = matchReply(
    { ...(msg.threadId ? { threadId: msg.threadId } : {}), fromAddress: msg.fromAddress },
    sentRefs,
    awaiting,
  );

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
    extractionStatus: 'pending',
  };

  if (!match.targetId) {
    report.unmatched++;
    await store.putReply(reply);
    return;
  }
  report.matched++;

  // Extract + roll up onto the target.
  const target = await store.getTarget(match.targetId);
  const campaign = target ? await store.getCampaign(target.campaignId) : undefined;
  if (target && campaign) {
    try {
      const parsed = await extractor.extract(campaign, msg.text);
      reply.parsed = parsed;
      reply.extractionStatus = 'done';
      report.extracted++;

      if (parsed.optOut) {
        await store.putTarget({ ...target, status: 'excluded', result: parsed });
        await suppress(store, target.contactEmail, 'opt_out', clock);
      } else {
        await store.putTarget({ ...target, status: 'replied', result: parsed });
      }
    } catch (err) {
      reply.extractionStatus = 'failed';
      report.extractionFailed++;
      logger.warn('extraction failed', {
        reply: reply.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  await store.putReply(reply);
}
