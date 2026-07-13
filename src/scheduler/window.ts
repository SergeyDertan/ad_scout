// Pure send-window + drip-pacing math (overview.md §5). No I/O, no timers.
// "Drip" = spread the remaining daily quota across the send window with
// randomized gaps, instead of bursting.

export interface SendWindow {
  startHour: number; // local hour, inclusive (0-23)
  endHour: number; // local hour, exclusive — hard cutoff, never send past it
  /** Soft target the drip paces toward (local hour). Sends are spread so the
   *  last one lands ~here, leaving [paceEndHour, endHour) as a tail buffer.
   *  Defaults to endHour (no buffer). Must satisfy startHour < paceEndHour <= endHour. */
  paceEndHour?: number;
}

/** The hour the drip paces toward. Falls back to the hard close when unset. */
export function paceEndHourOf(w: SendWindow): number {
  return w.paceEndHour ?? w.endHour;
}

export interface DripConfig {
  minMs: number; // floor between sends
  maxMs: number; // ceiling between sends
  jitterFrac: number; // +/- fraction applied to the base delay (0..1)
  noQuotaDelayMs: number; // recheck cadence when quota is exhausted
  windowClosedRecheckMaxMs: number; // cap on how long we sleep while closed
}

export const DEFAULT_DRIP: DripConfig = {
  minMs: 30_000, // 30s
  maxMs: 20 * 60_000, // 20m
  jitterFrac: 0.3,
  noQuotaDelayMs: 5 * 60_000, // 5m
  windowClosedRecheckMaxMs: 60 * 60_000, // 1h
};

export function isWithinSendWindow(now: Date, w: SendWindow): boolean {
  const h = now.getHours();
  return h >= w.startHour && h < w.endHour;
}

/** ms from `now` until local `hour` today (0 if that hour has already passed). */
function msUntilHour(now: Date, hour: number): number {
  const t = new Date(now);
  t.setHours(hour, 0, 0, 0);
  return Math.max(0, t.getTime() - now.getTime());
}

/** ms from `now` until the hard close today (0 if already closed). */
export function msUntilWindowClose(now: Date, w: SendWindow): number {
  if (!isWithinSendWindow(now, w)) return 0;
  return msUntilHour(now, w.endHour);
}

/** ms from `now` until the soft pace target today (0 once in the tail buffer or
 *  closed). Feeding this to the drip makes sends aim to finish by paceEndHour;
 *  in the tail zone it returns 0, so the drip falls to its floor delay and
 *  drains any leftover quota quickly before the hard close. */
export function msUntilPaceEnd(now: Date, w: SendWindow): number {
  if (!isWithinSendWindow(now, w)) return 0;
  return msUntilHour(now, paceEndHourOf(w));
}

/** The next Date at which the window opens (today if still ahead, else tomorrow). */
export function nextWindowOpen(now: Date, w: SendWindow): Date {
  const open = new Date(now);
  open.setHours(w.startHour, 0, 0, 0);
  if (open.getTime() <= now.getTime()) {
    open.setDate(open.getDate() + 1);
  }
  return open;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** Apply +/- jitterFrac to a base delay. `rnd` is in [0,1). */
export function applyJitter(baseMs: number, jitterFrac: number, rnd: number): number {
  const factor = 1 + (rnd * 2 - 1) * jitterFrac;
  return Math.max(0, Math.round(baseMs * factor));
}

/** Even drip: spread `remaining` sends across the time left in the window. */
export function dripBaseDelayMs(remaining: number, msLeftInWindow: number, cfg: DripConfig): number {
  if (remaining <= 0) return cfg.maxMs;
  return clamp(msLeftInWindow / remaining, cfg.minMs, cfg.maxMs);
}

export type SendAction = 'send' | 'idle_window_closed' | 'idle_no_quota';

export interface SendPlan {
  action: SendAction;
  delayMs: number;
}

/**
 * Decide what the next send tick should do. Pure: pass `rnd` (e.g. Math.random())
 * for deterministic testing.
 */
export function planSendTick(
  now: Date,
  remaining: number,
  w: SendWindow,
  cfg: DripConfig,
  rnd: number,
): SendPlan {
  if (!isWithinSendWindow(now, w)) {
    const wait = nextWindowOpen(now, w).getTime() - now.getTime();
    return {
      action: 'idle_window_closed',
      delayMs: clamp(wait, 1_000, cfg.windowClosedRecheckMaxMs),
    };
  }
  if (remaining <= 0) {
    return { action: 'idle_no_quota', delayMs: cfg.noQuotaDelayMs };
  }
  const base = dripBaseDelayMs(remaining, msUntilPaceEnd(now, w), cfg);
  return { action: 'send', delayMs: applyJitter(base, cfg.jitterFrac, rnd) };
}
