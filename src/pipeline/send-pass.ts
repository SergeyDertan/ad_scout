// Send-pass (overview.md §8). Sequential (no mutex — passes don't overlap).
// reserve-before-send + idempotency keep "started 3x a day" safe. Follow-ups
// (no-reply bumps) are prioritized ahead of new initial sends and draw from the
// same per-account daily cap.

import { remainingToday } from '../domain/limits';
import type {
  Account,
  Campaign,
  Outreach,
  OutreachKind,
  Target,
} from '../domain/types';
import type { Clock } from '../lib/clock';
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
}

interface WorkItem {
  target: Target;
  campaign: Campaign;
  kind: OutreachKind;
  sequenceNo: number;
}

function isFollowUpDue(target: Target, campaign: Campaign, now: Date): boolean {
  const policy = campaign.followUp;
  if (!policy) return false;
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
  const campaigns = await store.listCampaigns();
  const campaignById = new Map(campaigns.map((c) => [c.id, c] as const));

  // Build the work queue: follow-ups due first, then pending targets.
  const followUps: WorkItem[] = [];
  const initials: WorkItem[] = [];
  for (const t of await store.listTargets()) {
    const campaign = campaignById.get(t.campaignId);
    if (!campaign) continue;
    if (await store.isSuppressed(t.contactEmail)) continue;
    if (config.followUpsEnabled && isFollowUpDue(t, campaign, now)) {
      followUps.push({ target: t, campaign, kind: 'followup', sequenceNo: t.followUpCount + 1 });
    } else if (t.status === 'pending') {
      initials.push({ target: t, campaign, kind: 'initial', sequenceNo: 0 });
    }
  }
  const queue = [...followUps, ...initials];
  if (queue.length === 0) return report;

  const assignments = assignRoundRobin(queue, caps);

  for (const { item, accountId } of assignments) {
    const account = accountById.get(accountId);
    if (!account) continue;
    await sendOne(deps, item, account, now, report);
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
  const { target, campaign, kind, sequenceNo } = item;

  // Idempotency: never double-send the same (target, kind, seq).
  const existing = await store.listOutreaches({ targetId: target.id });
  if (alreadyInFlight(existing, kind, sequenceNo)) {
    report.skipped++;
    return;
  }

  // Draft locally (no network), then reserve (consume the slot), then send.
  const { subject, body } = draftEmail(campaign, account, target);
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
    const message = err instanceof Error ? err.message : String(err);
    logger.warn('send failed', { target: target.id, error: message });
    await store.putOutreach({
      ...outreach,
      status: 'failed',
      attempts: outreach.attempts + 1,
      error: message,
    });
    // Initial sends revert the target to 'pending' for retry on a later pass.
    if (kind === 'initial') {
      await store.updateTarget(target.id, (t) => ({ ...t, status: 'pending' }));
    }
    report.failed++;
  }
}
