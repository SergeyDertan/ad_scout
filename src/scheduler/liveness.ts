// LivenessMonitor — a heartbeat that tracks two things the drip loops care about:
//   1. Reachability: can we currently open a connection to the mail host?
//   2. Sleep/suspend: was the process just frozen (laptop lid closed)?
//
// It logs a single paired line per outage — one when work pauses, one when it
// resumes — instead of the per-account "fetch failed" spam a suspended machine
// used to produce. Sleep is detected purely from timer drift: a heartbeat
// scheduled every `heartbeatMs` can't fire while the process is suspended, so a
// beat that arrives far later than scheduled means we were asleep in between.
//
// Timers, clock, reachability and the logger are all injected, so the whole
// state machine is deterministically testable without real time or a network.

import type { Clock } from '../lib/clock';
import { logger as defaultLogger } from '../lib/logger';
import type { Reachable } from '../lib/reachability';
import type { Timers, TimerHandle } from './scheduler';

type LogFn = (msg: string, meta?: Record<string, unknown>) => void;

export interface LivenessLogger {
  info: LogFn;
  warn: LogFn;
}

export interface LivenessDeps {
  clock: Clock;
  reachable: Reachable;
  timers: Timers;
  /** How often to probe + check for drift. Default 15s. */
  heartbeatMs?: number;
  /** Extra delay beyond `heartbeatMs` that counts as a suspend. Default 20s. */
  sleepThresholdMs?: number;
  logger?: LivenessLogger;
}

export class LivenessMonitor {
  private readonly clock: Clock;
  private readonly reachable: Reachable;
  private readonly timers: Timers;
  private readonly heartbeatMs: number;
  private readonly sleepThresholdMs: number;
  private readonly log: LivenessLogger;

  private online = true; // optimistic: assume reachable until a probe says otherwise
  private lastBeatAt: number | null = null;
  private outageStartAt: number | null = null;
  private outageSawSleep = false;
  private handle: TimerHandle | null = null;
  private stopped = true;

  constructor(deps: LivenessDeps) {
    this.clock = deps.clock;
    this.reachable = deps.reachable;
    this.timers = deps.timers;
    this.heartbeatMs = deps.heartbeatMs ?? 15_000;
    this.sleepThresholdMs = deps.sleepThresholdMs ?? 20_000;
    this.log = deps.logger ?? defaultLogger;
  }

  /** Last known reachability. Read synchronously by the drip loops. */
  isOnline(): boolean {
    return this.online;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.lastBeatAt = this.clock.now().getTime();
    this.schedule();
  }

  stop(): void {
    this.stopped = true;
    if (this.handle !== null) this.timers.clear(this.handle);
    this.handle = null;
  }

  private schedule(): void {
    this.handle = this.timers.set(async () => {
      if (this.stopped) return;
      try {
        await this.beat();
      } catch {
        // A probe/log failure must never kill the heartbeat.
      }
      if (!this.stopped) this.schedule();
    }, this.heartbeatMs);
  }

  /**
   * One heartbeat: measure drift since the previous beat (→ did we sleep?),
   * probe reachability, and log any pause/resume transition. Exposed for tests.
   */
  async beat(): Promise<void> {
    const nowMs = this.clock.now().getTime();
    const prev = this.lastBeatAt;
    this.lastBeatAt = nowMs;

    const gap = prev == null ? 0 : nowMs - prev;
    const overshoot = gap - this.heartbeatMs;
    const slept = prev != null && overshoot > this.sleepThresholdMs;
    const sleptMs = slept ? overshoot : 0;

    const online = await this.reachable();

    if (online === this.online) {
      if (online && slept) {
        // Woke up but connectivity survived (or was already restored by now).
        this.log.info('Resumed from sleep — network available, continuing work', {
          sleptMs,
        });
      } else if (!online && slept) {
        // Still down, and a suspend happened during the ongoing outage.
        this.outageSawSleep = true;
      }
      return;
    }

    // --- reachability transition ---
    if (!online) {
      this.outageStartAt = nowMs;
      this.outageSawSleep = slept;
      this.log.warn(
        slept
          ? 'Sending/fetching paused due to sleep'
          : 'Sending/fetching paused — network unreachable',
      );
    } else {
      const downMs = this.outageStartAt == null ? undefined : nowMs - this.outageStartAt;
      const sawSleep = this.outageSawSleep || slept;
      this.log.info(
        sawSleep
          ? 'Network available after sleep — continuing work'
          : 'Network available, no sleep — continuing work',
        downMs != null ? { downMs } : undefined,
      );
      this.outageStartAt = null;
      this.outageSawSleep = false;
    }
    this.online = online;
  }
}
