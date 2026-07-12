import assert from 'node:assert/strict';
import test from 'node:test';

import { LivenessMonitor, type LivenessLogger } from './liveness';
import type { Timers } from './scheduler';

const HEARTBEAT = 15_000;
const SLEEP_THRESHOLD = 20_000;

/** A mutable clock the test advances by hand. */
function stepClock(startMs: number) {
  let t = startMs;
  return {
    clock: { now: () => new Date(t) },
    advance: (ms: number) => {
      t += ms;
    },
  };
}

function captureLogs() {
  const lines: Array<{ level: 'info' | 'warn'; msg: string; meta?: Record<string, unknown> }> = [];
  const logger: LivenessLogger = {
    info: (msg, meta) => lines.push({ level: 'info', msg, ...(meta ? { meta } : {}) }),
    warn: (msg, meta) => lines.push({ level: 'warn', msg, ...(meta ? { meta } : {}) }),
  };
  return { logger, lines };
}

// A no-op timer set — the tests drive beat() directly rather than via the loop.
const noTimers: Timers = { set: () => ({}), clear: () => {} };

function make(reachable: () => Promise<boolean>) {
  const { clock, advance } = stepClock(0);
  const { logger, lines } = captureLogs();
  const mon = new LivenessMonitor({
    clock,
    reachable,
    timers: noTimers,
    heartbeatMs: HEARTBEAT,
    sleepThresholdMs: SLEEP_THRESHOLD,
    logger,
  });
  mon.start(); // seeds lastBeatAt at t=0 (does not schedule via noTimers usefully)
  return { mon, advance, lines };
}

test('logs a pause/resume pair for a plain network outage (no sleep)', async () => {
  let online = true;
  const { mon, advance, lines } = make(async () => online);

  advance(HEARTBEAT);
  await mon.beat(); // still online — no log
  assert.equal(lines.length, 0);
  assert.equal(mon.isOnline(), true);

  online = false;
  advance(HEARTBEAT);
  await mon.beat(); // online -> offline
  assert.equal(mon.isOnline(), false);
  assert.equal(lines[0].msg, 'Sending/fetching paused — network unreachable');

  online = true;
  advance(HEARTBEAT);
  await mon.beat(); // offline -> online
  assert.equal(mon.isOnline(), true);
  assert.equal(lines[1].msg, 'Network available, no sleep — continuing work');
  assert.equal((lines[1].meta as { downMs: number }).downMs, HEARTBEAT);
});

test('attributes the pause to sleep when a beat arrives after a suspend', async () => {
  let online = true;
  const { mon, advance, lines } = make(async () => online);

  // Simulate the laptop sleeping: the next beat lands far later than scheduled,
  // and the network is unreachable on wake.
  online = false;
  advance(HEARTBEAT + SLEEP_THRESHOLD + 60_000);
  await mon.beat();
  assert.equal(lines[0].msg, 'Sending/fetching paused due to sleep');

  online = true;
  advance(HEARTBEAT);
  await mon.beat();
  assert.equal(lines[1].msg, 'Network available after sleep — continuing work');
});

test('notes a brief suspend that did not break connectivity', async () => {
  const { mon, advance, lines } = make(async () => true);

  advance(HEARTBEAT + SLEEP_THRESHOLD + 5_000); // slept, but network is fine on wake
  await mon.beat();
  assert.equal(mon.isOnline(), true);
  assert.equal(lines[0].msg, 'Resumed from sleep — network available, continuing work');
  assert.equal((lines[0].meta as { sleptMs: number }).sleptMs, SLEEP_THRESHOLD + 5_000);
});

test('a suspend during an ongoing outage is remembered for the resume line', async () => {
  let online = true;
  const { mon, advance, lines } = make(async () => online);

  online = false;
  advance(HEARTBEAT);
  await mon.beat(); // offline via plain network drop (no sleep yet)
  assert.equal(lines[0].msg, 'Sending/fetching paused — network unreachable');

  advance(HEARTBEAT + SLEEP_THRESHOLD + 30_000);
  await mon.beat(); // still offline, but slept meanwhile — no new line
  assert.equal(lines.length, 1);

  online = true;
  advance(HEARTBEAT);
  await mon.beat();
  assert.equal(lines[1].msg, 'Network available after sleep — continuing work');
});
