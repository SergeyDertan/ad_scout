import test from 'node:test';
import assert from 'node:assert/strict';
import { currentLimit, remainingToday, sentToday } from './limits';
import type { Account, Outreach } from './types';

// Local-time constructor so the calendar-day boundary is TZ-deterministic.
const NOW = new Date(2026, 5, 19, 12, 0, 0);
const at = (h: number, m = 0) => new Date(2026, 5, 19, h, m, 0);

function account(partial: Partial<Account> = {}): Account {
  return {
    id: 'acc1',
    email: 'a@x.com',
    providerType: 'smtp-imap',
    credentialRef: 'A',
    senderName: 'A',
    status: 'active',
    createdAt: '2026-05-01T00:00:00Z', // > 21 days → ramp at cap
    maxDailyLimit: 40,
    ...partial,
  };
}

function outreach(partial: Partial<Outreach>): Outreach {
  return {
    id: 'o',
    targetId: 't',
    accountId: 'acc1',
    kind: 'initial',
    sequenceNo: 0,
    status: 'sent',
    rfcMessageId: '<m>',
    subject: 's',
    body: 'b',
    reservedAt: NOW.toISOString(),
    attempts: 0,
    ...partial,
  };
}

test('sentToday counts reserved + sent since local midnight only', () => {
  const list: Outreach[] = [
    outreach({ id: '1', status: 'sent', reservedAt: at(9).toISOString() }), // earlier today
    outreach({ id: '2', status: 'reserved', reservedAt: NOW.toISOString() }),
    outreach({ id: '3', status: 'failed', reservedAt: NOW.toISOString() }), // excluded (status)
    outreach({ id: '4', status: 'sent', reservedAt: at(-4).toISOString() }), // yesterday 20:00
    outreach({ id: '5', status: 'sent', accountId: 'other', reservedAt: NOW.toISOString() }), // other acct
  ];
  assert.equal(sentToday(list, 'acc1', NOW), 2);
});

test('currentLimit clamps ramp to maxDailyLimit and honors override', () => {
  assert.equal(currentLimit(account({ maxDailyLimit: 40 }), NOW), 40);
  assert.equal(currentLimit(account({ maxDailyLimit: 15 }), NOW), 15); // clamp
  assert.equal(currentLimit(account({ dailyLimitOverride: 7, maxDailyLimit: 40 }), NOW), 7);
  assert.equal(currentLimit(account({ dailyLimitOverride: 100, maxDailyLimit: 40 }), NOW), 40);
});

test('remainingToday subtracts in-flight sends', () => {
  const list = [outreach({ id: '1' }), outreach({ id: '2', status: 'reserved' })];
  assert.equal(remainingToday(account(), list, NOW), 38);
  assert.equal(remainingToday(account(), [], NOW), 40);
});
