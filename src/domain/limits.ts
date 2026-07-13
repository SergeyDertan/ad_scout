// Pure limit math. All statistics are DERIVED from the append-only Outreach log
// (overview.md §7) — never stored as counters, so a restart can't corrupt them.

import type { Account, Outreach } from './types';
import { ageDays, warmupRamp, type WarmupConfig, DEFAULT_WARMUP } from './warmup';

/**
 * Outbound sends (initial + follow-up) reserved so far *today* for an account,
 * where "today" is the local calendar day (resets at local midnight). `reserved`
 * counts too, so an in-flight reservation still holds the cap.
 *
 * Calendar-day (not rolling-24h): every account starts each day with a fresh
 * quota, so a late-running day can't shadow the next morning. The trade-off is
 * that sends can bunch across a midnight boundary (end of one day + start of the
 * next), which rolling-24h would have spread out.
 */
export function sentToday(outreaches: Outreach[], accountId: string, now: Date): number {
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const cutoff = midnight.getTime();
  let n = 0;
  for (const o of outreaches) {
    if (o.accountId !== accountId) continue;
    if (o.status !== 'reserved' && o.status !== 'sent') continue;
    if (new Date(o.reservedAt).getTime() >= cutoff) n++;
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
  return Math.max(0, currentLimit(account, now, cfg) - sentToday(outreaches, account.id, now));
}

export function canSend(
  account: Account,
  outreaches: Outreach[],
  now: Date,
  cfg: WarmupConfig = DEFAULT_WARMUP,
): boolean {
  return account.status === 'active' && remainingToday(account, outreaches, now, cfg) > 0;
}
