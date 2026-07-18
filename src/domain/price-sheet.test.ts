import test from 'node:test';
import assert from 'node:assert/strict';

import { buildPriceSheet, knownDomains } from './price-sheet';
import type { PostOffer, PriceRecord } from './types';

const offer = (o: Partial<PostOffer>): PostOffer => ({
  postType: 'guest_post', category: 'regular', label: 'Regular', sensitive: false, canPost: 'yes', ...o,
});

const rec = (o: Partial<PriceRecord>): PriceRecord => ({
  id: `pr_${Math.random()}`,
  domain: 'casik.com',
  offers: [],
  observedAt: '2026-02-01T00:00:00Z',
  sourceEmail: 'help@casik.com',
  sourceMessageId: '<m@x>',
  attribution: 'sender',
  ...o,
});

test('price sheet: newest-per-cell with carry-forward + staleness (§4.1 worked example)', () => {
  // 01.02 record A → {regular: 500, sensitive: 600}; 04.04 record B → {regular: 550}.
  const A = rec({
    observedAt: '2026-02-01T00:00:00Z',
    sourceMessageId: '<A>',
    offers: [
      offer({ category: 'regular', price: { amount: 500, raw: '500' } }),
      offer({ category: 'sensitive', sensitive: true, price: { amount: 600, raw: '600' } }),
    ],
  });
  const B = rec({
    observedAt: '2026-04-04T00:00:00Z',
    sourceMessageId: '<B>',
    offers: [offer({ category: 'regular', price: { amount: 550, raw: '550' } })],
  });

  const sheet = buildPriceSheet('casik.com', [A, B], new Date('2026-04-05T00:00:00Z'));
  const regular = sheet.cells.find((c) => c.category === 'regular');
  const sensitive = sheet.cells.find((c) => c.category === 'sensitive');

  // regular = 550 (B, 04.04, fresh); sensitive = 600 (A, 01.02, stale/carried over).
  assert.equal(regular?.price?.amount, 550);
  assert.equal(regular?.asOf, '2026-04-04T00:00:00Z');
  assert.equal(regular?.sourceMessageId, '<B>');
  assert.equal(regular?.stale, false);
  assert.equal(sensitive?.price?.amount, 600);
  assert.equal(sensitive?.asOf, '2026-02-01T00:00:00Z');
  assert.equal(sensitive?.stale, true);
  assert.equal(sheet.lastObservedAt, '2026-04-04T00:00:00Z');
  assert.equal(sheet.recordCount, 2);
});

test('price sheet: an explicit later canPost:no overrides an earlier price', () => {
  const A = rec({ observedAt: '2026-01-01T00:00:00Z', offers: [offer({ category: 'casino', sensitive: true, canPost: 'yes', price: { amount: 200, raw: '200' } })] });
  const B = rec({ observedAt: '2026-03-01T00:00:00Z', offers: [offer({ category: 'casino', sensitive: true, canPost: 'no' })] });
  const sheet = buildPriceSheet('casik.com', [A, B]);
  const casino = sheet.cells.find((c) => c.category === 'casino');
  assert.equal(casino?.canPost, 'no');
  assert.equal(casino?.price, undefined);
});

test('price sheet: specials are a parallel layer; expired ones drop from active', () => {
  const standing = rec({ observedAt: '2026-05-01T00:00:00Z', offers: [offer({ category: 'regular', price: { amount: 100, raw: '100' } })] });
  const promoActive = rec({
    observedAt: '2026-05-02T00:00:00Z',
    offers: [offer({ category: 'regular', price: { amount: 70, raw: '70' }, isSpecial: true, specialUntil: '2026-12-31' })],
  });
  const promoExpired = rec({
    observedAt: '2026-05-03T00:00:00Z',
    offers: [offer({ postType: 'link_insertion', category: 'regular', price: { amount: 40, raw: '40' }, isSpecial: true, specialUntil: '2026-05-10' })],
  });
  const sheet = buildPriceSheet('casik.com', [standing, promoActive, promoExpired], new Date('2026-06-01T00:00:00Z'));

  // The standing regular price is untouched by the promo.
  assert.equal(sheet.cells.find((c) => c.category === 'regular')?.price?.amount, 100);
  assert.equal(sheet.specials.length, 2);
  const active = sheet.specials.find((s) => s.postType === 'guest_post');
  const expired = sheet.specials.find((s) => s.postType === 'link_insertion');
  assert.equal(active?.active, true);
  assert.equal(expired?.active, false);
});

test('knownDomains unions record domains with target domains, sorted + deduped', () => {
  const records = [rec({ domain: 'b.com' }), rec({ domain: 'a.com' })];
  assert.deepEqual(knownDomains(records, ['a.com', 'c.com']), ['a.com', 'b.com', 'c.com']);
});
