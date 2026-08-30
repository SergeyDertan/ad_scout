import test from 'node:test';
import assert from 'node:assert/strict';

import {
  canTransition,
  dealDomains,
  isDealOpen,
  isFulfilled,
  isPaid,
  isPublished,
} from './deals';
import type { Deal, DealStatus, Placement } from './types';

function deal(status: DealStatus): Deal {
  return {
    id: 'deal1',
    counterpartyEmail: 'admin@site.com',
    accountId: 'acc1',
    status,
    origin: 'manual',
    openedAt: '2026-08-01T00:00:00Z',
  };
}

function placement(over: Partial<Placement> = {}): Placement {
  return { id: 'p1', dealId: 'deal1', domain: 'site.com', ...over };
}

test('a deal is open only while it is being worked', () => {
  assert.equal(isDealOpen(deal('negotiation')), true);
  assert.equal(isDealOpen(deal('fulfilment')), true);
  assert.equal(isDealOpen(deal('done')), false);
  assert.equal(isDealOpen(deal('closed')), false);
});

test('a missing deal is not open — a dangling ThreadLink must not hold a thread', () => {
  assert.equal(isDealOpen(undefined), false);
});

test('deal domains are derived from placements, deduped and sorted', () => {
  const placements = [
    placement({ id: 'p1', domain: 'zeta.com' }),
    placement({ id: 'p2', domain: 'alpha.com' }),
    placement({ id: 'p3', domain: 'zeta.com' }),
  ];
  assert.deepEqual(dealDomains(placements), ['alpha.com', 'zeta.com']);
  assert.deepEqual(dealDomains([]), []);
});

test('paid and published are independent — either order, or neither', () => {
  const neither = placement();
  assert.equal(isPaid(neither), false);
  assert.equal(isPublished(neither), false);

  const paidFirst = placement({ paidAt: '2026-08-02T00:00:00Z' });
  assert.equal(isPaid(paidFirst), true);
  assert.equal(isPublished(paidFirst), false);

  const publishedFirst = placement({ liveAt: '2026-08-02T00:00:00Z' });
  assert.equal(isPaid(publishedFirst), false);
  assert.equal(isPublished(publishedFirst), true);
});

test('a published post counts as published before its link is recorded', () => {
  assert.equal(isPublished(placement({ liveAt: '2026-08-02T00:00:00Z' })), true);
  assert.equal(isPublished(placement({ publishedUrl: 'https://site.com/post' })), true);
});

test('a deal is fulfilled only when EVERY placement is both paid and live', () => {
  const done = placement({ paidAt: '2026-08-02T00:00:00Z', liveAt: '2026-08-03T00:00:00Z' });
  const halfway = placement({ id: 'p2', domain: 'other.com', paidAt: '2026-08-02T00:00:00Z' });

  assert.equal(isFulfilled([done]), true);
  assert.equal(isFulfilled([done, halfway]), false, 'one paid-but-unpublished site blocks it');
  assert.equal(isFulfilled([]), false, 'a deal with no placements is not fulfilled');
});

test('status transitions allow reopening a finished deal', () => {
  assert.equal(canTransition('negotiation', 'fulfilment'), true);
  assert.equal(canTransition('fulfilment', 'negotiation'), true, 'price can reopen mid-fulfilment');
  assert.equal(canTransition('done', 'fulfilment'), true, 'a post that vanished is live work again');
  assert.equal(canTransition('closed', 'negotiation'), true);
  assert.equal(canTransition('done', 'done'), true, 'a no-op transition is allowed');
});
