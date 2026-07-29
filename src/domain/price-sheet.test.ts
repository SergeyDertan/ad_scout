import test from 'node:test';
import assert from 'node:assert/strict';

import { buildPriceSheet, knownDomains } from './price-sheet';
import { parseTerm, TERM_NONE } from './terms';
import type { PostOffer, PriceRecord } from './types';

const offer = (o: Partial<PostOffer> & { termRaw?: string }): PostOffer => {
  const { termRaw, ...rest } = o;
  return {
    category: 'regular', label: 'Regular', sensitive: false, canPost: 'yes',
    term: termRaw ? parseTerm(termRaw) : TERM_NONE,
    ...rest,
  };
};

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
    offers: [offer({ category: 'casino', label: 'Casino', sensitive: true, price: { amount: 40, raw: '40' }, isSpecial: true, specialUntil: '2026-05-10' })],
  });
  const sheet = buildPriceSheet('casik.com', [standing, promoActive, promoExpired], new Date('2026-06-01T00:00:00Z'));

  // The standing regular price is untouched by the promo.
  assert.equal(sheet.cells.find((c) => c.category === 'regular')?.price?.amount, 100);
  assert.equal(sheet.specials.length, 2);
  const active = sheet.specials.find((s) => s.category === 'regular');
  const expired = sheet.specials.find((s) => s.category === 'casino');
  assert.equal(active?.active, true);
  assert.equal(expired?.active, false);
});

test('price sheet: each placement term folds independently', () => {
  // The publisher's monthly rate changes; the 3-month rate is untouched and must
  // carry forward at its own price rather than being overwritten.
  const A = rec({
    observedAt: '2026-01-01T00:00:00Z',
    sourceMessageId: '<A>',
    offers: [
      offer({ category: 'regular', termRaw: '1 month', price: { amount: 99, raw: '99$' } }),
      offer({ category: 'regular', termRaw: '3 months', price: { amount: 150, raw: '150$' } }),
    ],
  });
  const B = rec({
    observedAt: '2026-03-01T00:00:00Z',
    sourceMessageId: '<B>',
    offers: [offer({ category: 'regular', termRaw: 'for a month', price: { amount: 120, raw: '120$' } })],
  });

  const sheet = buildPriceSheet('casik.com', [A, B], new Date('2026-03-02T00:00:00Z'));
  const at = (key: string) => sheet.cells.find((c) => c.term.key === key);
  assert.equal(sheet.cells.length, 2); // one niche, two durations, two cells
  // The 1-month cell moved to the new quote...
  assert.equal(at('1m')?.price?.amount, 120);
  assert.equal(at('1m')?.stale, false);
  // ...while the 3-month cell kept its own price and is flagged carried-over.
  assert.equal(at('3m')?.price?.amount, 150);
  assert.equal(at('3m')?.stale, true);
  assert.equal(at('3m')?.sourceMessageId, '<A>');
});

test('price sheet: an unstated duration never collides with a termed one', () => {
  const A = rec({
    observedAt: '2026-01-01T00:00:00Z',
    offers: [
      offer({ category: 'regular', price: { amount: 50, raw: '$50' } }),
      offer({ category: 'regular', termRaw: '12 months', price: { amount: 400, raw: '$400' } }),
    ],
  });
  const sheet = buildPriceSheet('casik.com', [A]);
  assert.equal(sheet.cells.length, 2);
  // Cells sort shortest-term-first, with the unstated one at the far end.
  assert.deepEqual(sheet.cells.map((c) => c.term.key), ['12m', 'none']);
});

test('price sheet: a record written before terms existed folds as unstated', () => {
  // Back-compat: legacy PriceRecords carry no `term` on their offers.
  const legacy = rec({
    observedAt: '2026-01-01T00:00:00Z',
    offers: [{ category: 'regular', label: 'Regular', sensitive: false, canPost: 'yes', price: { amount: 80, raw: '$80' } } as PostOffer],
  });
  const sheet = buildPriceSheet('casik.com', [legacy]);
  assert.equal(sheet.cells.length, 1);
  assert.equal(sheet.cells[0].term.key, 'none');
  assert.equal(sheet.cells[0].price?.amount, 80);
});

test('knownDomains unions record domains with target domains, sorted + deduped', () => {
  const records = [rec({ domain: 'b.com' }), rec({ domain: 'a.com' })];
  assert.deepEqual(knownDomains(records, ['a.com', 'c.com']), ['a.com', 'b.com', 'c.com']);
});
