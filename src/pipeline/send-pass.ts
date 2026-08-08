// Send-pass (overview.md §8). Sequential (no mutex — passes don't overlap).
// reserve-before-send + idempotency keep "started 3x a day" safe. Follow-ups
// (no-reply bumps) are prioritized ahead of new initial sends and draw from the
// same per-account daily cap.

import { normalizeDomain } from '../domain/domain';
import { remainingToday } from '../domain/limits';
import type {
  Account,
  Outreach,
  OutreachKind,
  PitchProfile,
  Target,
} from '../domain/types';
import { resolveProfile } from '../domain/pitch';
import type { Clock } from '../lib/clock';
import { describeError } from '../lib/errors';
import { newId, newMessageId } from '../lib/ids';
import { logger } from '../lib/logger';
import type { EmailProvider } from '../ports/email-provider';
import type { Store } from '../ports/store';
import { assignRoundRobin, type Capacity } from '../services/account-selector';
import { draftEmail } from '../services/drafter';
import type { Config } from '../config';

export interface SendDeps {
  store: Store;
  email: EmailProvider;
  clock: Clock;
  config: Config;
}

export interface SendReport {
  reserved: number;
  sent: number;
  failed: number;
  skipped: number;
}

export interface SendOpts {
  /** Cap sends per account this pass. Used by the drip scheduler (=1). */
  maxPerAccount?: number;
  /** Abort signal — checked before each send. */
  signal?: AbortSignal;
  /** Progress callback — called after each item is processed. */
  onProgress?: (current: number, total: number) => void;
}

interface WorkItem {
  target: Target;
  profile: PitchProfile;
  kind: OutreachKind;
  sequenceNo: number;
}

function isFollowUpDue(target: Target, config: Config, now: Date): boolean {
  const policy = config.followUp;
  if (target.status !== 'contacted') return false; // a reply/bounce/opt-out moves it off 'contacted'
  if (target.followUpCount >= policy.maxFollowUps) return false;
  if (!target.lastOutreachAt) return false;
  const ageDays = (now.getTime() - new Date(target.lastOutreachAt).getTime()) / 86_400_000;
  return ageDays >= policy.afterDays;
}

/** Does an outreach already exist for this (target, kind) that holds/used a slot? */
function alreadyInFlight(outreaches: Outreach[], kind: OutreachKind, seq: number): boolean {
  return outreaches.some(
    (o) =>
      o.kind === kind &&
      o.sequenceNo === seq &&
      (o.status === 'reserved' || o.status === 'sent'),
  );
}

export async function runSendPass(deps: SendDeps, opts: SendOpts = {}): Promise<SendReport> {
  const { store, email, clock, config } = deps;
  const now = clock.now();
  const report: SendReport = { reserved: 0, sent: 0, failed: 0, skipped: 0 };

  const accounts = (await store.listAccounts()).filter((a) => a.status === 'active');
  if (accounts.length === 0) return report;

  const cap = opts.maxPerAccount ?? Infinity;
  const allOutreaches = await store.listOutreaches();
  const caps: Capacity[] = accounts
    .map((a) => ({
      accountId: a.id,
      remaining: Math.min(remainingToday(a, allOutreaches, now, config.warmup), cap),
    }))
    .filter((c) => c.remaining > 0);
  if (caps.length === 0) return report;

  const accountById = new Map(accounts.map((a) => [a.id, a] as const));
  const batches = await store.listBatches();
  const batchById = new Map(batches.map((b) => [b.id, b] as const));

  // Build the work queue: follow-ups due first, then pending targets. The pitch
  // profile is the target's batch (advertised override) layered on global config.
  const followUps: WorkItem[] = [];
  const initials: WorkItem[] = [];
  for (const t of await store.listTargets()) {
    if (await store.isSuppressed(t.contactEmail)) continue;
    // Domain-level do-not-contact (D9): a blanket-declined / manually-excluded
    // website domain is skipped even if the email itself isn't suppressed.
    if (await store.isDomainExcluded(normalizeDomain(t.websiteUrl))) continue;
    const profile = resolveProfile(t.batchId ? batchById.get(t.batchId) : undefined, config.pitch);
    if (config.followUpsEnabled && isFollowUpDue(t, config, now)) {
      followUps.push({ target: t, profile, kind: 'followup', sequenceNo: t.followUpCount + 1 });
    } else if (t.status === 'pending') {
      initials.push({ target: t, profile, kind: 'initial', sequenceNo: 0 });
    }
  }
  const queue = [...followUps, ...initials];
  if (queue.length === 0) return report;

  const assignments = assignRoundRobin(queue, caps);

  let progress = 0;
  for (const { item, accountId } of assignments) {
    if (opts.signal?.aborted) break;
    const account = accountById.get(accountId);
    if (!account) continue;
    await sendOne(deps, item, account, now, report);
    opts.onProgress?.(++progress, assignments.length);
  }

  return report;
}

async function sendOne(
  deps: SendDeps,
  item: WorkItem,
  account: Account,
  now: Date,
  report: SendReport,
): Promise<void> {
  const { store, email } = deps;
  const { target, profile, kind, sequenceNo } = item;

  // Idempotency: never double-send the same (target, kind, seq).
  const existing = await store.listOutreaches({ targetId: target.id });
  if (alreadyInFlight(existing, kind, sequenceNo)) {
    report.skipped++;
    return;
  }

  // Draft locally (no network), then reserve (consume the slot), then send.
  const { subject, body } = draftEmail(profile, account, target);
  const rfcMessageId = newMessageId();
  const nowIso = now.toISOString();

  const outreach: Outreach = {
    id: newId('outreach'),
    targetId: target.id,
    accountId: account.id,
    kind,
    sequenceNo,
    status: 'reserved',
    rfcMessageId,
    subject,
    body,
    reservedAt: nowIso,
    attempts: 0,
  };
  await store.putOutreach(outreach);

  // Initial sends move the target to 'reserved'; follow-ups stay 'contacted'.
  if (kind === 'initial') {
    await store.updateTarget(target.id, (t) => ({
      ...t,
      status: 'reserved',
      assignedAccountId: account.id,
    }));
  }
  report.reserved++;

  // --- network call (outside any lock) ---
  try {
    const result = await email.send({
      to: target.contactEmail,
      subject,
      body,
      rfcMessageId,
      account,
    });

    // Resolve threadId via exact self-lookup (SMTP returns none on send).
    let threadId = result.threadId;
    if (!threadId) {
      threadId = await email.resolveThreadId(account, rfcMessageId).catch(() => undefined);
    }

    await store.putOutreach({
      ...outreach,
      status: 'sent',
      sentAt: now.toISOString(),
      ...(threadId ? { threadId, threadResolvedAt: now.toISOString() } : {}),
    });

    if (kind === 'initial') {
      await store.updateTarget(target.id, (t) => ({
        ...t,
        status: 'contacted',
        assignedAccountId: account.id,
        lastOutreachAt: now.toISOString(),
      }));
    } else {
      await store.updateTarget(target.id, (t) => ({
        ...t,
        followUpCount: t.followUpCount + 1,
        lastOutreachAt: now.toISOString(),
      }));
    }
    report.sent++;
  } catch (err) {
    const detail = describeError(err);
    logger.warn('send failed', {
      target: target.id,
      account: account.id,
      to: target.contactEmail,
      kind,
      ...detail,
    });
    await store.putOutreach({
      ...outreach,
      status: 'failed',
      attempts: outreach.attempts + 1,
      error: detail.error,
    });
    // Initial sends revert the target to 'pending' for retry on a later pass.
    if (kind === 'initial') {
      await store.updateTarget(target.id, (t) => ({ ...t, status: 'pending' }));
    }
    report.failed++;
  }
}
