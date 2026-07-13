// Pure, derived per-account send state for the UI (overview.md §5/§7). No I/O.
// Everything is computed from the append-only Outreach log + config, so it can
// never drift from a stored counter. Mirrors the math the drip scheduler uses
// (scheduler/window.ts) so the "current rate" shown matches what actually runs.

import type { Account, Outreach } from './types';
import { currentLimit, sentToday } from './limits';
import { ageDays, type WarmupConfig, DEFAULT_WARMUP } from './warmup';
import {
  dripBaseDelayMs,
  isWithinSendWindow,
  msUntilPaceEnd,
  DEFAULT_DRIP,
  type DripConfig,
  type SendWindow,
} from '../scheduler/window';

export interface AccountSendState {
  /** Sends counted today (local calendar day) — the number the limiter uses. */
  sentToday: number;
  /** Effective daily cap right now (ramp/override, clamped to maxDailyLimit). */
  limit: number;
  /** How many more this account may send right now. */
  remaining: number;
  /** True while the account is still climbing the warmup ramp (no override,
   *  limit below maxDailyLimit). */
  warming: boolean;
  /** True when a manual dailyLimitOverride is in force (ramp ignored). */
  overridden: boolean;
  /** Warmup target the ramp is climbing toward. */
  rampTarget: number;
  /** Whole days of account age (drives the ramp). */
  ageDays: number;
  /** Is the send window open right now? */
  windowActive: boolean;
  /** Current drip pacing in ms between sends, or null when not sending
   *  (window closed or no quota). Matches the scheduler's own math. */
  gapMs: number | null;
  /** Same pacing expressed as sends/hour, or null when not sending. */
  perHour: number | null;
  /** Best-effort total sends the account will actually make today, given the
   *  time left in the window and the minimum inter-send gap. When this is below
   *  `limit` the window is too short to drain the quota (e.g. the machine slept
   *  through part of it). */
  projectedToday: number;
}

/** ms of send-window time still available today from `now` (0 once closed). */
function msWindowAvailableToday(now: Date, w: SendWindow): number {
  const open = new Date(now);
  open.setHours(w.startHour, 0, 0, 0);
  const close = new Date(now);
  close.setHours(w.endHour, 0, 0, 0);
  if (now.getTime() < open.getTime()) return Math.max(0, close.getTime() - open.getTime());
  if (now.getTime() < close.getTime()) return Math.max(0, close.getTime() - now.getTime());
  return 0;
}

export function accountSendState(
  account: Account,
  outreaches: Outreach[],
  now: Date,
  window: SendWindow,
  warmup: WarmupConfig = DEFAULT_WARMUP,
  drip: DripConfig = DEFAULT_DRIP,
): AccountSendState {
  const sent = sentToday(outreaches, account.id, now);
  const limit = currentLimit(account, now, warmup);
  const remaining = Math.max(0, limit - sent);
  const overridden = account.dailyLimitOverride != null;
  const warming = !overridden && limit < account.maxDailyLimit;

  const windowActive = isWithinSendWindow(now, window);
  let gapMs: number | null = null;
  let perHour: number | null = null;
  if (windowActive && remaining > 0) {
    gapMs = dripBaseDelayMs(remaining, msUntilPaceEnd(now, window), drip);
    perHour = gapMs > 0 ? Math.round((3_600_000 / gapMs) * 10) / 10 : null;
  }

  // How many of the remaining quota can actually go out before the window
  // closes, if every send is spaced by the minimum gap. Below `remaining` only
  // when there isn't enough window time left.
  const msAvailable = msWindowAvailableToday(now, window);
  const capacity = Math.floor(msAvailable / drip.minMs);
  const projectedRemaining = Math.min(remaining, capacity);
  const projectedToday = sent + projectedRemaining;

  return {
    sentToday: sent,
    limit,
    remaining,
    warming,
    overridden,
    rampTarget: account.maxDailyLimit,
    ageDays: ageDays(account.createdAt, now),
    windowActive,
    gapMs,
    perHour,
    projectedToday,
  };
}
