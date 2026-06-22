// Reconcile-pass (overview.md §8). Runs at startup so a crash mid-send can't
// double-send or lose threading:
//  - `reserved` past a grace period → exact All-Mail lookup; found → sent +
//    threadId, not found → needs_review (NEVER auto-resend).
//  - `sent` missing threadId → retry the exact lookup.

import type { Outreach } from '../domain/types';
import type { Clock } from '../lib/clock';
import { logger } from '../lib/logger';
import type { EmailProvider } from '../ports/email-provider';
import type { Store } from '../ports/store';
import type { Config } from '../config';

export interface ReconcileDeps {
  store: Store;
  email: EmailProvider;
  clock: Clock;
  config: Config;
}

export interface ReconcileReport {
  recoveredSent: number;
  needsReview: number;
  threadIdsResolved: number;
}

export async function runReconcile(deps: ReconcileDeps): Promise<ReconcileReport> {
  const { store, email, clock, config } = deps;
  const now = clock.now();
  const report: ReconcileReport = { recoveredSent: 0, needsReview: 0, threadIdsResolved: 0 };

  const accounts = new Map((await store.listAccounts()).map((a) => [a.id, a] as const));
  const outreaches = await store.listOutreaches();

  for (const o of outreaches) {
    const account = accounts.get(o.accountId);
    if (!account) continue;

    if (o.status === 'reserved') {
      const ageMs = now.getTime() - new Date(o.reservedAt).getTime();
      if (ageMs < config.reconcileGraceMs) continue;
      const threadId = await safeResolve(email, account, o);
      if (threadId !== undefined) {
        await store.putOutreach({
          ...o,
          status: 'sent',
          sentAt: now.toISOString(),
          ...(threadId ? { threadId, threadResolvedAt: now.toISOString() } : {}),
        });
        report.recoveredSent++;
      } else {
        await store.putOutreach({ ...o, status: 'needs_review' });
        const target = await store.getTarget(o.targetId);
        if (target && target.status === 'reserved') {
          await store.putTarget({ ...target, status: 'needs_review' });
        }
        report.needsReview++;
      }
    } else if (o.status === 'sent' && !o.threadId) {
      const threadId = await safeResolve(email, account, o);
      if (threadId) {
        await store.putOutreach({ ...o, threadId, threadResolvedAt: now.toISOString() });
        report.threadIdsResolved++;
      }
    }
  }

  return report;
}

/** undefined = lookup failed/not found; '' is never returned. */
async function safeResolve(
  email: EmailProvider,
  account: Parameters<EmailProvider['resolveThreadId']>[0],
  o: Outreach,
): Promise<string | undefined> {
  try {
    return await email.resolveThreadId(account, o.rfcMessageId);
  } catch (err) {
    logger.warn('resolveThreadId failed during reconcile', {
      outreach: o.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}
