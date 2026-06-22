// Pure limit math. All statistics are DERIVED from the append-only Outreach log
// (overview.md §7) — never stored as counters, so a restart can't corrupt them.

import type { Account, Outreach } from './types';
import { ageDays, warmupRamp, type WarmupConfig, DEFAULT_WARMUP } from './warmup';

const DAY_MS = 86_400_000;

/**
 * Outbound sends (initial + follow-up) reserved within the last 24h for an account.
 * `reserved` counts too, so an in-flight reservation still holds the cap.
 */
export function sentInLast24h(outreaches: Outreach[], accountId: string, now: Date): number {
  const cutoff = now.getTime() - DAY_MS;
  let n = 0;
  for (const o of outreaches) {
    if (o.accountId !== accountId) continue;
    if (o.status !== 'reserved' && o.status !== 'sent') continue;
    if (new Date(o.reservedAt).getTime() > cutoff) n++;
  }
  return n;
}

/** The current daily cap: warmup ramp (or override), clamped to maxDailyLimit. */
export function currentLimit(
  account: Account,
  now: Date,
  cfg: WarmupConfig = DEFAULT_WARMUP,
): number {
  const ramp = account.dailyLimitOverride ?? warmupRamp(ageDays(account.createdAt, now), cfg);
  return Math.min(ramp, account.maxDailyLimit);
}

/** How many more sends this account may make right now. */
export function remainingToday(
  account: Account,
  outreaches: Outreach[],
  now: Date,
  cfg: WarmupConfig = DEFAULT_WARMUP,
): number {
  return Math.max(0, currentLimit(account, now, cfg) - sentInLast24h(outreaches, account.id, now));
}

export function canSend(
  account: Account,
  outreaches: Outreach[],
  now: Date,
  cfg: WarmupConfig = DEFAULT_WARMUP,
): boolean {
  return account.status === 'active' && remainingToday(account, outreaches, now, cfg) > 0;
}
