import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyJitter,
  dripBaseDelayMs,
  isWithinSendWindow,
  msUntilWindowClose,
  nextWindowOpen,
  planSendTick,
  DEFAULT_DRIP,
  type SendWindow,
} from './window';

const W: SendWindow = { startHour: 9, endHour: 18 };
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
