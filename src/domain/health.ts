// Pure account-health rules (overview.md §5). No I/O.

import type { AccountStatus } from './types';

export interface HealthConfig {
  /** Bounce rate over the window above which we cool the account down. */
  bounceRateThreshold: number; // e.g. 0.1 (10%)
  /** Minimum sends in the window before the bounce rate is meaningful. */
  minSamples: number; // e.g. 10
}

export const DEFAULT_HEALTH: HealthConfig = {
  bounceRateThreshold: 0.1,
  minSamples: 10,
};

export interface HealthInput {
  sentInWindow: number;
  bouncedInWindow: number;
  /** A hard auth/security send failure (SMTP 535, suspicious-activity block). */
  authError?: boolean;
}

export interface HealthVerdict {
  action: 'none' | 'pause' | 'cooldown';
  nextStatus?: AccountStatus;
  reason?: string;
}

export function bounceRate(sent: number, bounced: number): number {
  if (sent <= 0) return 0;
  return bounced / sent;
}

/**
 * Decide whether an account should be auto-paused/cooled down.
 * - Auth/security error → pause immediately (needs human attention).
 * - Bounce rate over threshold (with enough samples) → cooldown.
 */
export function evaluateHealth(
  input: HealthInput,
  cfg: HealthConfig = DEFAULT_HEALTH,
): HealthVerdict {
  if (input.authError) {
    return { action: 'pause', nextStatus: 'paused', reason: 'auth/security send error' };
  }
  if (input.sentInWindow >= cfg.minSamples) {
    const rate = bounceRate(input.sentInWindow, input.bouncedInWindow);
    if (rate > cfg.bounceRateThreshold) {
      return {
        action: 'cooldown',
        nextStatus: 'cooldown',
        reason: `bounce rate ${(rate * 100).toFixed(1)}% over ${(cfg.bounceRateThreshold * 100).toFixed(0)}%`,
      };
    }
  }
  return { action: 'none' };
}
