import test from 'node:test';
import assert from 'node:assert/strict';

import { compareTerms, parseTerm, termLabel, TERM_NONE } from './terms';

test('an unstated duration is its own term, distinct from an explicit permanent', () => {
  // The common case: "we can do a guest post for $50" — no duration named.
  assert.deepEqual(parseTerm(''), TERM_NONE);
  assert.deepEqual(parseTerm(undefined), TERM_NONE);
  assert.equal(parseTerm('   ').key, 'none');
  // Saying nothing is NOT the same as promising permanence — different cells.
  assert.equal(parseTerm('permanent').key, 'perm');
  assert.equal(parseTerm('lifetime placement').key, 'perm');
  assert.equal(parseTerm('the link stays forever').key, 'perm');
  assert.notEqual(parseTerm('permanent').key, TERM_NONE.key);
  // Neither carries a length, so neither can satisfy a numeric filter.
  assert.equal(parseTerm('permanent').days, undefined);
  assert.equal(parseTerm('permanent').months, undefined);
});

test('whole-month terms carry months (filterable) and days (sortable)', () => {
  assert.deepEqual(parseTerm('for a month'), { key: '1m', days: 30, months: 1, raw: 'for a month' });
  assert.deepEqual(parseTerm('3 months'), { key: '3m', days: 90, months: 3, raw: '3 months' });
  assert.equal(parseTerm('monthly').months, 1);
  assert.equal(parseTerm('6 months').months, 6);
});

test('years fold into months so one duration is always one cell', () => {
  // The requirement: "1 year for 99$" must be KNOWN to be 12 months.
  assert.equal(parseTerm('1 year').key, '12m');
  assert.equal(parseTerm('1 year').months, 12);
  assert.equal(parseTerm('whole year').months, 12);
  assert.equal(parseTerm('annual').months, 12);
  assert.equal(parseTerm('2 years').months, 24);
  // However phrased, the same duration lands in the same cell.
  assert.equal(parseTerm('12 months').key, parseTerm('1 year').key);
  assert.equal(parseTerm('half a year').months, 6);
  assert.equal(parseTerm('quarterly').months, 3);
});

test('sub-month terms keep an exact length but NO months, so month filters skip them', () => {
  // The requirement: a 1-week price is stored exactly, but is not a month term.
  assert.equal(parseTerm('1 week').months, undefined);
  assert.deepEqual(parseTerm('1 week'), { key: '7d', days: 7, raw: '1 week' });
  assert.equal(parseTerm('10 days').days, 10);
  assert.equal(parseTerm('10 days').months, undefined);
  assert.equal(parseTerm('2 weeks').days, 14);
  // Weeks fold into days for the same reason years fold into months.
  assert.equal(parseTerm('1 week').key, parseTerm('7 days').key);
  // A fraction of a month is not a whole-month term.
  assert.equal(parseTerm('1.5 months').key, '45d');
  assert.equal(parseTerm('1.5 months').months, undefined);
  // ... but an exact multiple of 30 days is how publishers say "a month".
  assert.equal(parseTerm('30 days').key, '1m');
  assert.equal(parseTerm('30 days').months, 1);
});

test('a range takes the lower bound, the length we can actually promise', () => {
  assert.equal(parseTerm('3-6 months').months, 3);
  assert.equal(parseTerm('7–14 days').days, 7);
});

test('a stated but unparseable term stays distinct and stays out of numeric queries', () => {
  const a = parseTerm('until we rotate it');
  assert.ok(a.key.startsWith('other:'));
  assert.equal(a.days, undefined);
  assert.equal(a.months, undefined);
  assert.equal(a.raw, 'until we rotate it'); // provenance survives
  // Two different odd terms must not collapse into one cell.
  assert.notEqual(a.key, parseTerm('until the client asks').key);
});

test('common non-English durations normalize', () => {
  assert.equal(parseTerm('на 3 месяца').months, 3);
  assert.equal(parseTerm('1 год').months, 12);
  assert.equal(parseTerm('2 semanas').days, 14);
  assert.equal(parseTerm('6 mois').months, 6);
});

test('an English article is not mistaken for a duration', () => {
  // "an" must never read as the French "an" (year) — the phrase names no term.
  assert.equal(parseTerm('an article').key, 'other:an-article');
});

test('terms sort shortest-first with the indefinite ones at the far end', () => {
  const terms = [
    parseTerm('permanent'),
    parseTerm('12 months'),
    parseTerm(''),
    parseTerm('1 week'),
    parseTerm('1 month'),
  ];
  const sorted = [...terms].sort(compareTerms).map((t) => t.key);
  assert.deepEqual(sorted, ['7d', '1m', '12m', 'perm', 'none']);
});

test('termLabel prefers the publisher own words', () => {
  assert.equal(termLabel(parseTerm('whole year')), 'whole year');
  assert.equal(termLabel(parseTerm('')), '—');
  assert.equal(termLabel({ key: '3m', days: 90, months: 3, raw: '' }), '3 months');
  assert.equal(termLabel({ key: '1m', days: 30, months: 1, raw: '' }), '1 month');
});
