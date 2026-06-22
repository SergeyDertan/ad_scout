import test from 'node:test';
import assert from 'node:assert/strict';
import { bounceRate, evaluateHealth } from './health';

test('auth error pauses immediately', () => {
  const v = evaluateHealth({ sentInWindow: 1, bouncedInWindow: 0, authError: true });
  assert.equal(v.action, 'pause');
  assert.equal(v.nextStatus, 'paused');
});

test('bounce rate over threshold (with enough samples) cools down', () => {
  const v = evaluateHealth({ sentInWindow: 20, bouncedInWindow: 3 }); // 15% > 10%
  assert.equal(v.action, 'cooldown');
  assert.equal(v.nextStatus, 'cooldown');
});

test('bounce rate under threshold is healthy', () => {
  const v = evaluateHealth({ sentInWindow: 50, bouncedInWindow: 2 }); // 4%
  assert.equal(v.action, 'none');
});

test('too few samples never trips the bounce rule', () => {
  const v = evaluateHealth({ sentInWindow: 3, bouncedInWindow: 3 }); // 100% but < minSamples
  assert.equal(v.action, 'none');
});

test('bounceRate handles zero sends', () => {
  assert.equal(bounceRate(0, 0), 0);
});
