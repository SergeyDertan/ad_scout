import test from 'node:test';
import assert from 'node:assert/strict';
import { DripScheduler, type Timers } from './scheduler';
import { fixedClock } from '../lib/clock';
import type { SendWindow } from './window';

const W: SendWindow = { startHour: 9, endHour: 18 };
const within = fixedClock(new Date(2026, 5, 19, 12, 0, 0)); // local noon → in window
const closed = fixedClock(new Date(2026, 5, 19, 3, 0, 0)); // 3am → window closed

/** A single-slot fake timer the test drives by hand. */
function fakeTimers() {
  let pending: { fn: () => void; ms: number } | null = null;
  const timers: Timers = {
    set: (fn, ms) => {
      pending = { fn, ms };
      return pending;
    },
    clear: () => {
      pending = null;
    },
  };
  return {
    timers,
    get pending() {
      return pending;
    },
    async fire() {
      const p = pending;
      pending = null;
      if (p) await p.fn();
    },
  };
}

function make(opts: {
  clock?: ReturnType<typeof fixedClock>;
  quota?: number;
  timers?: Timers;
}) {
  let sendCalls = 0;
  let pollCalls = 0;
  const sched = new DripScheduler({
    clock: opts.clock ?? within,
    window: W,
    quotaRemaining: async () => opts.quota ?? 3,
    runSend: async () => {
      sendCalls++;
    },
    runPoll: async () => {
      pollCalls++;
    },
    pollIntervalMs: 0, // disable poll loop so the single fake slot is send-only
    random: () => 0.5,
    ...(opts.timers ? { timers: opts.timers } : {}),
  });
  return { sched, counts: () => ({ sendCalls, pollCalls }) };
}

test('sendStep sends when within window with quota', async () => {
  const { sched, counts } = make({ quota: 3 });
  const plan = await sched.sendStep();
  assert.equal(plan.action, 'send');
  assert.equal(counts().sendCalls, 1);
});

test('sendStep does not send when window closed', async () => {
  const { sched, counts } = make({ clock: closed, quota: 3 });
  const plan = await sched.sendStep();
  assert.equal(plan.action, 'idle_window_closed');
  assert.equal(counts().sendCalls, 0);
});

test('sendStep does not send when no quota', async () => {
  const { sched, counts } = make({ quota: 0 });
  const plan = await sched.sendStep();
  assert.equal(plan.action, 'idle_no_quota');
  assert.equal(counts().sendCalls, 0);
});

test('pollStep runs the poll callback', async () => {
  const { sched, counts } = make({});
  await sched.pollStep();
  assert.equal(counts().pollCalls, 1);
});

test('start drives a self-rescheduling drip loop; stop halts it', async () => {
  const ft = fakeTimers();
  const { sched, counts } = make({ quota: 3, timers: ft.timers });

  sched.start();
  assert.equal(ft.pending?.ms, 0); // first tick scheduled immediately

  await ft.fire(); // tick 1: sends, reschedules with a drip delay
  assert.equal(counts().sendCalls, 1);
  assert.ok(ft.pending && ft.pending.ms > 0);

  await ft.fire(); // tick 2
  assert.equal(counts().sendCalls, 2);

  sched.stop();
  assert.equal(ft.pending, null); // stop cleared the next tick
  assert.equal(sched.isRunning(), false);
});
