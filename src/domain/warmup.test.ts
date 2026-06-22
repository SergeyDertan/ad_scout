import test from 'node:test';
import assert from 'node:assert/strict';
import { ageDays, warmupRamp, DEFAULT_WARMUP } from './warmup';

test('warmupRamp climbs by step then caps', () => {
  assert.equal(warmupRamp(0), 5);
  assert.equal(warmupRamp(2), 5);
  assert.equal(warmupRamp(3), 10);
  assert.equal(warmupRamp(6), 15);
  assert.equal(warmupRamp(18), 35);
  assert.equal(warmupRamp(21), 40); // cap
  assert.equal(warmupRamp(1000), 40); // stays capped
});

test('warmupRamp honors a custom config', () => {
  const cfg = { base: 10, stepEvery: 1, stepBy: 10, cap: 50 };
  assert.equal(warmupRamp(0, cfg), 10);
  assert.equal(warmupRamp(2, cfg), 30);
  assert.equal(warmupRamp(99, cfg), 50);
});

test('ageDays floors and never goes negative', () => {
  const now = new Date('2026-06-19T12:00:00Z');
  assert.equal(ageDays('2026-06-19T00:00:00Z', now), 0);
  assert.equal(ageDays('2026-06-16T00:00:00Z', now), 3);
  assert.equal(ageDays('2099-01-01T00:00:00Z', now), 0); // future → 0
});

test('DEFAULT_WARMUP caps at 40', () => {
  assert.equal(DEFAULT_WARMUP.cap, 40);
});
