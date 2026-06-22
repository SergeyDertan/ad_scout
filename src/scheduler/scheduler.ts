// In-process drip scheduler. Two self-rescheduling loops:
//  - send loop: within the window, drips one send per account at jittered gaps.
//  - poll loop: fixed cadence, independent.
// Timers + randomness are injectable so the loops are deterministically testable.

import type { Clock } from '../lib/clock';
import { logger } from '../lib/logger';
import {
  DEFAULT_DRIP,
  planSendTick,
  type DripConfig,
  type SendPlan,
  type SendWindow,
} from './window';

export type TimerHandle = unknown;

export interface Timers {
  set(fn: () => void | Promise<void>, ms: number): TimerHandle;
  clear(h: TimerHandle): void;
}

export const realTimers: Timers = {
  set: (fn, ms) => {
    const h = setTimeout(fn, ms);
    (h as { unref?: () => void }).unref?.();
    return h;
  },
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export interface SchedulerDeps {
  clock: Clock;
  /** Run one drip send step (the agent should cap this to 1/account). */
  runSend: () => Promise<unknown>;
  /** Run one poll step. */
  runPoll: () => Promise<unknown>;
  /** Total remaining daily quota across active accounts, right now. */
  quotaRemaining: () => Promise<number>;
  window: SendWindow;
  drip?: Partial<DripConfig>;
  /** Poll cadence; <= 0 disables the poll loop. Default 60s. */
  pollIntervalMs?: number;
  random?: () => number;
  timers?: Timers;
  onError?: (where: string, err: unknown) => void;
}

export class DripScheduler {
  private readonly clock: Clock;
  private readonly drip: DripConfig;
  private readonly window: SendWindow;
  private readonly pollIntervalMs: number;
  private readonly random: () => number;
  private readonly timers: Timers;
  private readonly onError: (where: string, err: unknown) => void;

  private sendHandle: TimerHandle | null = null;
  private pollHandle: TimerHandle | null = null;
  private stopped = true;

  constructor(private readonly deps: SchedulerDeps) {
    this.clock = deps.clock;
    this.drip = { ...DEFAULT_DRIP, ...deps.drip };
    this.window = deps.window;
    this.pollIntervalMs = deps.pollIntervalMs ?? 60_000;
    this.random = deps.random ?? Math.random;
    this.timers = deps.timers ?? realTimers;
    this.onError =
      deps.onError ?? ((where, err) => logger.warn(`scheduler ${where} error`, { err: String(err) }));
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.sendHandle = this.timers.set(() => this.sendLoop(), 0);
    if (this.pollIntervalMs > 0) {
      this.pollHandle = this.timers.set(() => this.pollLoop(), this.pollIntervalMs);
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.sendHandle !== null) this.timers.clear(this.sendHandle);
    if (this.pollHandle !== null) this.timers.clear(this.pollHandle);
    this.sendHandle = null;
    this.pollHandle = null;
  }

  isRunning(): boolean {
    return !this.stopped;
  }

  /** One send step. Returns the plan it acted on (exposed for tests). */
  async sendStep(): Promise<SendPlan> {
    const now = this.clock.now();
    const remaining = await this.deps.quotaRemaining();
    const plan = planSendTick(now, remaining, this.window, this.drip, this.random());
    if (plan.action === 'send') {
      await this.deps.runSend();
    }
    return plan;
  }

  /** One poll step (exposed for tests). */
  async pollStep(): Promise<void> {
    await this.deps.runPoll();
  }

  private async sendLoop(): Promise<void> {
    if (this.stopped) return;
    let delayMs = this.drip.noQuotaDelayMs;
    try {
      const plan = await this.sendStep();
      delayMs = plan.delayMs;
    } catch (err) {
      this.onError('send', err);
    }
    if (!this.stopped) {
      this.sendHandle = this.timers.set(() => this.sendLoop(), delayMs);
    }
  }

  private async pollLoop(): Promise<void> {
    if (this.stopped) return;
    try {
      await this.pollStep();
    } catch (err) {
      this.onError('poll', err);
    }
    if (!this.stopped) {
      this.pollHandle = this.timers.set(() => this.pollLoop(), this.pollIntervalMs);
    }
  }
}
