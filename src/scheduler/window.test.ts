import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyJitter,
  dripBaseDelayMs,
  isWithinSendWindow,
  msUntilPaceEnd,
  msUntilWindowClose,
  nextWindowOpen,
  paceEndHourOf,
  planSendTick,
  DEFAULT_DRIP,
  type SendWindow,
} from './window';

const W: SendWindow = { startHour: 9, endHour: 18 };
// Same window with a soft pace target 1h before the hard close.
const WP: SendWindow = { startHour: 9, endHour: 18, paceEndHour: 17 };
// local-time constructor → getHours() is deterministic regardless of TZ
const at = (h: number, m = 0) => new Date(2026, 5, 19, h, m, 0);

test('isWithinSendWindow respects [start, end)', () => {
  assert.equal(isWithinSendWindow(at(12), W), true);
  assert.equal(isWithinSendWindow(at(9), W), true);
  assert.equal(isWithinSendWindow(at(18), W), false); // exclusive
  assert.equal(isWithinSendWindow(at(3), W), false);
});

test('msUntilWindowClose', () => {
  assert.equal(msUntilWindowClose(at(12), W), 6 * 3_600_000);
  assert.equal(msUntilWindowClose(at(3), W), 0); // closed
});

test('paceEndHourOf falls back to endHour when unset', () => {
  assert.equal(paceEndHourOf(W), 18);
  assert.equal(paceEndHourOf(WP), 17);
});

test('msUntilPaceEnd targets the soft end, 0 in the tail buffer', () => {
  assert.equal(msUntilPaceEnd(at(12), WP), 5 * 3_600_000); // noon → 17:00
  assert.equal(msUntilPaceEnd(at(17, 30), WP), 0); // in tail zone [17,18)
  assert.equal(msUntilPaceEnd(at(3), WP), 0); // closed
  assert.equal(msUntilPaceEnd(at(12), W), msUntilWindowClose(at(12), W)); // unset → hard close
});

test('nextWindowOpen rolls to tomorrow once today opened', () => {
  assert.equal(nextWindowOpen(at(3), W).getHours(), 9);
  assert.equal(nextWindowOpen(at(3), W).getDate(), 19); // today
  assert.equal(nextWindowOpen(at(12), W).getDate(), 20); // tomorrow
});

test('applyJitter scales by +/- fraction', () => {
  assert.equal(applyJitter(1000, 0.3, 0.5), 1000); // midpoint → no change
  assert.equal(applyJitter(1000, 0.3, 0), 700); // -30%
  assert.equal(applyJitter(1000, 0.3, 1), 1300); // +30%
});

test('dripBaseDelayMs spreads quota and clamps', () => {
  assert.equal(dripBaseDelayMs(100, 21_600_000, DEFAULT_DRIP), 216_000); // 6h / 100
  assert.equal(dripBaseDelayMs(0, 21_600_000, DEFAULT_DRIP), DEFAULT_DRIP.maxMs);
  assert.equal(dripBaseDelayMs(100000, 21_600_000, DEFAULT_DRIP), DEFAULT_DRIP.minMs); // clamped up
});

test('planSendTick: send within window with quota', () => {
  const plan = planSendTick(at(12), 100, W, DEFAULT_DRIP, 0.5);
  assert.equal(plan.action, 'send');
  assert.equal(plan.delayMs, 216_000);
});

test('planSendTick: paces toward the soft end when set', () => {
  // noon, 100 left, 5h until pace-end (17:00) → 5h/100 = 180s (tighter than the
  // 216s it would be pacing to the hard 18:00 close).
  const plan = planSendTick(at(12), 100, WP, DEFAULT_DRIP, 0.5);
  assert.equal(plan.action, 'send');
  assert.equal(plan.delayMs, 180_000);
});

test('planSendTick: tail buffer drains leftover quota at the floor', () => {
  // 17:30 is past the soft end but before the hard close → still sends, at the
  // minimum gap, so any remaining quota goes out before 18:00.
  const plan = planSendTick(at(17, 30), 5, WP, DEFAULT_DRIP, 0.5);
  assert.equal(plan.action, 'send');
  assert.equal(plan.delayMs, DEFAULT_DRIP.minMs);
});

test('planSendTick: idle when window closed', () => {
  const plan = planSendTick(at(3), 100, W, DEFAULT_DRIP, 0.5);
  assert.equal(plan.action, 'idle_window_closed');
  assert.ok(plan.delayMs > 0 && plan.delayMs <= DEFAULT_DRIP.windowClosedRecheckMaxMs);
});

test('planSendTick: idle when no quota', () => {
  const plan = planSendTick(at(12), 0, W, DEFAULT_DRIP, 0.5);
  assert.equal(plan.action, 'idle_no_quota');
  assert.equal(plan.delayMs, DEFAULT_DRIP.noQuotaDelayMs);
});
