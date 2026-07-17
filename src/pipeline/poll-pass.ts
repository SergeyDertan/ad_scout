// Poll-pass (overview.md §8). Dedupe inbound by emailId → detect bounce →
// match (threadId → fromAddress → unmatched) → store reply → extract → roll up
// onto the target. Opt-outs and bounces add to the persistent suppression list.

import { LABELS, labelForResult, type OutcomeLabel } from '../domain/labels';
import {
  detectBounce,
  isTargetResolved,
  matchReply,
  normalizeEmail,
  type AwaitingTargetRef,
  type SentOutreachRef,
} from '../domain/reply-matching';
import {
  AWAITING_INTENTS,
  type Account,
  type Niche,
  type OutreachResult,
  type Reply,
  type Suppression,
  type Target,
} from '../domain/types';
import type { Clock } from '../lib/clock';
import { describeError } from '../lib/errors';
import { newId } from '../lib/ids';
import { logger } from '../lib/logger';
import type { EmailProvider, IncomingEmail } from '../ports/email-provider';
import type { Store } from '../ports/store';
import type { Extractor } from '../services/extractor';
import type { Config } from '../config';

export interface PollDeps {
  store: Store;
  email: EmailProvider;
  extractor: Extractor;
  clock: Clock;
  config: Config;
}

export interface PollReport {
  fetched: number;
  deduped: number;
  bounced: number;
  matched: number;
  unmatched: number;
  extracted: number;
  extractionFailed: number;
  /** Matched replies saved without extraction because the target was already answered. */
  skipped: number;
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
    skipped: 0,
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
        email: account.email,
        ...describeError(err),
      });
      continue;
    }
    report.fetched += messages.length;

    for (const msg of messages) {
      await handleMessage(deps, account, msg, sentRefs, awaiting, report);
    }

    // Advance the cursor. Merge (don't overwrite): the gmail-api provider may
    // have written a fresh historyId into pollCursor during fetchReplies.
    await store.updateAccount(account.id, (current) => ({
      ...current,
      pollCursor: {
        ...current.pollCursor,
        mailbox: 'INBOX',
        lastPolledAt: clock.now().toISOString(),
      },
    }));
  }

  await retryFailedExtractions(deps, report);

  return report;
}

/** Persist niches the extractor learned for the first time (idempotent by key). */
async function persistDiscovered(store: Store, discovered: Niche[], clock: Clock): Promise<void> {
  for (const n of discovered) {
    await store.putNiche({ ...n, createdAt: n.createdAt ?? clock.now().toISOString() });
  }
}

async function retryFailedExtractions(deps: PollDeps, report: PollReport): Promise<void> {
  const { extracted, failed } = await extractPendingReplies(deps);
  report.extracted += extracted;
  report.extractionFailed += failed;
}

export interface ExtractOptions {
  /** Progress sink (defaults to no-op). The re-extract script passes console.log. */
  log?: (msg: string) => void;
}

/**
 * Re-extract every reply whose extraction is `pending`/`failed` (and is matched
 * to a target), WITHOUT fetching the mailbox. Same extract → persist niches →
 * roll-up path a normal poll uses, so target status/result are re-derived
 * identically. Used by the poll pass's retry step and by the re-extract script.
 */
export async function extractPendingReplies(
  deps: PollDeps,
  opts: ExtractOptions = {},
): Promise<{ extracted: number; failed: number }> {
  const { store, extractor, clock, config } = deps;
  const log = opts.log ?? (() => {});
  const pending = (await store.listReplies()).filter(
    (r) => (r.extractionStatus === 'failed' || r.extractionStatus === 'pending') && r.targetId,
  );
  let extracted = 0;
  let failed = 0;
  let i = 0;
  for (const reply of pending) {
    i++;
    const target = await store.getTarget(reply.targetId!);
    if (!target) {
      log(`[${i}/${pending.length}] skip ${reply.fromAddress} — no target`);
      continue;
    }
    // The account that owns this reply's mailbox — needed to (re)label it. Absent
    // ⇒ labeling is skipped (best-effort), extraction still runs.
    const account = target.assignedAccountId
      ? await store.getAccount(target.assignedAccountId)
      : undefined;
    // Already answered — save the reply as-is, never invoke the AI on it.
    if (isTargetResolved(target)) {
      reply.extractionStatus = 'skipped';
      await store.putReply(reply);
      if (account) await applyLabel(deps, account, reply.emailId, LABELS.matched);
      log(`[${i}/${pending.length}] skip ${target.websiteUrl} — target already answered`);
      continue;
    }
    try {
      const knownNiches = await store.listNiches();
      const { result: parsed, discovered, review } = await extractor.extract(
        config.pitch,
        reply.text,
        knownNiches,
        reply.attachments ?? [],
      );
      await persistDiscovered(store, discovered, clock);
      await rollUp(store, target, reply, parsed, review, clock);
      extracted++;
      await store.putReply(reply);
      if (account) await applyLabel(deps, account, reply.emailId, labelForResult(parsed));
      const offers = parsed.offers?.length ?? 0;
      log(`[${i}/${pending.length}] ok   ${target.websiteUrl} — intent=${parsed.intent ?? 'answer'}, ${offers} offer(s)`);
    } catch (err) {
      reply.extractionStatus = 'failed';
      await store.putReply(reply);
      if (account) await applyLabel(deps, account, reply.emailId, LABELS.matched);
      failed++;
      log(`[${i}/${pending.length}] FAIL ${target.websiteUrl} — ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { extracted, failed };
}

/**
 * Set the reply's parsed result + review flags and roll the outcome up onto the
 * target. Opt-out excludes; a substantive answer marks the target 'replied'. But
 * a holding/auto reply is NOT a real answer — leave the target 'contacted' so
 * follow-ups keep chasing the actual response.
 *
 * `review` carries ONLY genuine "the system couldn't process this — a human must
 * act" reasons (unreadable file, unreachable link, no provider access). The
 * benign "no answer yet" state is NOT a review reason: it is fully captured in
 * `parsed.intent` (holding/auto_reply) and surfaced separately in the UI. Mixing
 * the two turned every routine autoresponder into a false "needs review".
 */
async function rollUp(
  store: Store,
  target: Target,
  reply: Reply,
  parsed: OutreachResult,
  review: string[],
  clock: Clock,
): Promise<void> {
  const awaiting = parsed.intent != null && AWAITING_INTENTS.includes(parsed.intent);
  reply.parsed = parsed;
  reply.review = review.length ? review : undefined;
  reply.extractionStatus = 'done';

  if (parsed.optOut) {
    await store.updateTarget(target.id, (t) => ({ ...t, status: 'excluded', result: parsed }));
    await suppress(store, target.contactEmail, 'opt_out', clock);
  } else if (awaiting) {
    // Leave the target 'contacted' — do not close it as answered; the real
    // reply (or a follow-up) is still expected.
  } else {
    await store.updateTarget(target.id, (t) => ({ ...t, status: 'replied', result: parsed }));
  }
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

/** Mark a fetched message read — "the system saw it". Never throws: a mailbox
 *  mutation failure (e.g. an account still on the old readonly scope) must not
 *  fail the pass. */
async function markRead(deps: PollDeps, account: Account, emailId: string): Promise<void> {
  try {
    await deps.email.markRead(account, emailId);
  } catch (err) {
    logger.warn('markRead failed', { account: account.id, emailId, ...describeError(err) });
  }
}

/** Apply a decision label to a message (best-effort, same non-fatal contract). */
async function applyLabel(
  deps: PollDeps,
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
  deps: PollDeps,
  account: Account,
  msg: IncomingEmail,
  sentRefs: SentOutreachRef[],
  awaiting: AwaitingTargetRef[],
  report: PollReport,
): Promise<void> {
  const { store, extractor, clock, config } = deps;

  // Dedupe on the stable emailId.
  if (await store.getReplyByEmailId(msg.emailId)) {
    report.deduped++;
    return;
  }

  // The system has now fetched and seen this message — mark it read regardless of
  // what we decide about it below. The label records the decision.
  await markRead(deps, account, msg.emailId);

  // Bounce?
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
    ...(msg.attachments?.length ? { attachments: msg.attachments } : {}),
    extractionStatus: 'pending',
  };

  if (!match.targetId) {
    await applyLabel(deps, account, msg.emailId, LABELS.unmatched);
    report.unmatched++;
    await store.putReply(reply);
    return;
  }
  report.matched++;

  // Extract + roll up onto the target.
  const target = await store.getTarget(match.targetId);
  if (isTargetResolved(target)) {
    // Already answered — save the later reply for the record, don't re-extract.
    reply.extractionStatus = 'skipped';
    await applyLabel(deps, account, msg.emailId, LABELS.matched);
    report.skipped++;
  } else if (target) {
    try {
      const knownNiches = await store.listNiches();
      const { result: parsed, discovered, review } = await extractor.extract(
        config.pitch,
        msg.text,
        knownNiches,
        msg.attachments ?? [],
      );
      await persistDiscovered(store, discovered, clock);
      await rollUp(store, target, reply, parsed, review, clock);
      await applyLabel(deps, account, msg.emailId, labelForResult(parsed));
      report.extracted++;
    } catch (err) {
      reply.extractionStatus = 'failed';
      // Couldn't classify it, but it IS a matched reply — label it as such.
      await applyLabel(deps, account, msg.emailId, LABELS.matched);
      report.extractionFailed++;
      logger.warn('extraction failed', {
        reply: reply.id,
        ...describeError(err),
      });
    }
  }

  await store.putReply(reply);
}
