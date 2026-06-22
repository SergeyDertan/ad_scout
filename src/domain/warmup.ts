// Pure warmup-ramp logic. No I/O.
// The per-account daily limit climbs with account age until it hits the cap.

export interface WarmupConfig {
  base: number; // limit on day 0
  stepEvery: number; // add `stepBy` every N days
  stepBy: number;
  cap: number; // hard ceiling (== Account.maxDailyLimit, default 40)
}

export const DEFAULT_WARMUP: WarmupConfig = {
  base: 5,
  stepEvery: 3,
  stepBy: 5,
  cap: 40,
};

/** Whole days between `createdAt` and `now` (never negative). */
export function ageDays(createdAt: string, now: Date): number {
  const created = new Date(createdAt).getTime();
  const diffMs = now.getTime() - created;
  if (!Number.isFinite(diffMs) || diffMs <= 0) return 0;
  return Math.floor(diffMs / 86_400_000);
}

/** Daily send limit for an account of the given age, before maxDailyLimit clamp. */
export function warmupRamp(days: number, cfg: WarmupConfig = DEFAULT_WARMUP): number {
  const steps = Math.floor(Math.max(0, days) / cfg.stepEvery);
  return Math.min(cfg.base + steps * cfg.stepBy, cfg.cap);
}
