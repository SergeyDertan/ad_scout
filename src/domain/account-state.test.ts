import test from 'node:test';
import assert from 'node:assert/strict';
import { accountSendState } from './account-state';
import type { Account, Outreach } from './types';
import type { SendWindow } from '../scheduler/window';
import { DEFAULT_DRIP } from '../scheduler/window';

const W: SendWindow = { startHour: 9, endHour: 18 };
const at = (h: number, m = 0) => new Date(2026, 5, 19, h, m, 0);

function account(over?: Partial<Account>): Account {
  return {
    id: 'acc1',
    email: 'a@x.com',
    providerType: 'gmail-api',
    credentialRef: 'X',
    senderName: 'A',
    status: 'active',
    createdAt: new Date(2026, 0, 1).toISOString(), // old account → ramp at cap
    maxDailyLimit: 40,
    ...over,
  };
}

function sends(n: number, reservedAt: Date): Outreach[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `o${i}`,
    targetId: `t${i}`,
    accountId: 'acc1',
    kind: 'initial',
    sequenceNo: 0,
    status: 'sent',
    rfcMessageId: `m${i}`,
    subject: 's',
    body: 'b',
    reservedAt: reservedAt.toISOString(),
    attempts: 1,
  }));
}

test('mature account: limit at cap, remaining = limit - sentToday', () => {
  const s = accountSendState(account(), sends(10, at(10)), at(12), W);
  assert.equal(s.limit, 40);
  assert.equal(s.sentToday, 10);
  assert.equal(s.remaining, 30);
  assert.equal(s.warming, false);
  assert.equal(s.overridden, false);
});

test('young account is warming: limit below max, ramp target = maxDailyLimit', () => {
  const young = account({ createdAt: at(9).toISOString() }); // day 0 → ramp base 5
  const s = accountSendState(young, [], at(12), W);
  assert.equal(s.warming, true);
  assert.equal(s.limit, 5);
  assert.equal(s.rampTarget, 40);
});

test('override suppresses warming flag and sets limit', () => {
  const s = accountSendState(account({ dailyLimitOverride: 12 }), [], at(12), W);
  assert.equal(s.overridden, true);
  assert.equal(s.warming, false);
  assert.equal(s.limit, 12);
});

test('rate is set inside the window with quota, null when closed', () => {
  const open = accountSendState(account(), sends(10, at(10)), at(12), W);
  assert.ok(open.gapMs && open.gapMs > 0);
  assert.ok(open.perHour && open.perHour > 0);
  const closed = accountSendState(account(), sends(10, at(10)), at(20), W);
  assert.equal(closed.gapMs, null);
  assert.equal(closed.perHour, null);
});

test('projectedToday drops below limit when the window is too short to drain quota', () => {
  // 40 remaining, but only ~10 minutes of window left → min gap 30s → 20 fit.
  const now = new Date(2026, 5, 19, 17, 50, 0);
  const s = accountSendState(account(), [], now, W);
  assert.equal(s.remaining, 40);
  const capacity = Math.floor((10 * 60_000) / DEFAULT_DRIP.minMs); // 20
  assert.equal(s.projectedToday, capacity);
  assert.ok(s.projectedToday < s.limit);
});

test('projectedToday counts already-sent today plus what still fits', () => {
  // Plenty of window left → all remaining quota fits.
  const s = accountSendState(account(), sends(5, at(9, 30)), at(10), W);
  assert.equal(s.sentToday, 5);
  assert.equal(s.remaining, 35);
  assert.equal(s.projectedToday, 40); // 5 sent + 35 remaining all fit
});
