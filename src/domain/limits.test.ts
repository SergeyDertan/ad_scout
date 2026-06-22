import test from 'node:test';
import assert from 'node:assert/strict';
import { currentLimit, remainingToday, sentInLast24h } from './limits';
import type { Account, Outreach } from './types';

const NOW = new Date('2026-06-19T12:00:00Z');

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

test('sentInLast24h counts reserved + sent within window only', () => {
  const list: Outreach[] = [
    outreach({ id: '1', status: 'sent', reservedAt: NOW.toISOString() }),
    outreach({ id: '2', status: 'reserved', reservedAt: NOW.toISOString() }),
    outreach({ id: '3', status: 'failed', reservedAt: NOW.toISOString() }), // excluded
    outreach({ id: '4', status: 'sent', reservedAt: '2026-06-17T00:00:00Z' }), // > 24h ago
    outreach({ id: '5', status: 'sent', accountId: 'other', reservedAt: NOW.toISOString() }), // other acct
  ];
  assert.equal(sentInLast24h(list, 'acc1', NOW), 2);
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
