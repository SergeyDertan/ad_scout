import test from 'node:test';
import assert from 'node:assert/strict';
import {
  allNiches,
  categorizeTopic,
  isNonGuestProduct,
  matchNiche,
  normalizeKey,
  offerMatchesFilter,
  resolveOffer,
} from './niches';
import type { Niche, PostOffer } from './types';
import { TERM_NONE } from './terms';

const NICHES = allNiches();

const mkOffer = (o: Partial<PostOffer>): PostOffer => ({
  category: 'regular',
  label: 'Regular',
  sensitive: false,
  canPost: 'yes',
  term: TERM_NONE,
  ...o,
});

test('normalizeKey slugifies free text', () => {
  assert.equal(normalizeKey('Short-Term Loans'), 'short_term_loans');
  assert.equal(normalizeKey('  VPN & Proxy!! '), 'vpn_proxy');
});

test('allNiches merges learned entries over the seed set by key', () => {
  const learned: Niche[] = [{ key: 'casino', label: 'Casino', sensitive: true, aliases: ['casino', 'kasyno'] }];
  const merged = allNiches(learned);
  const casino = merged.find((n) => n.key === 'casino');
  assert.ok(casino?.aliases.includes('kasyno'));
  // and a brand-new learned niche shows up too
  const withNew = allNiches([{ key: 'pharma', label: 'Pharma', sensitive: true, aliases: ['pharma'] }]);
  assert.ok(withNew.some((n) => n.key === 'pharma'));
});

test('isNonGuestProduct flags products we do not buy, passes everything else', () => {
  assert.equal(isNonGuestProduct('link insertion'), true);
  assert.equal(isNonGuestProduct('link_insertion'), true);
  assert.equal(isNonGuestProduct('niche edit'), true);
  assert.equal(isNonGuestProduct('casino link insertion price'), true); // loose contains
  assert.equal(isNonGuestProduct('banner ad'), true);
  assert.equal(isNonGuestProduct('Banner'), true);
  // The guest post, under any of its names, is what we DO buy.
  assert.equal(isNonGuestProduct('guest post'), false);
  assert.equal(isNonGuestProduct('sponsored article'), false);
  assert.equal(isNonGuestProduct('publication'), false);
  // Real niches are never mistaken for products.
  assert.equal(isNonGuestProduct('casino'), false);
  assert.equal(isNonGuestProduct('short_term_loans'), false);
  assert.equal(isNonGuestProduct(''), false);
});

test('matchNiche resolves by key, label, and alias', () => {
  assert.equal(matchNiche('casino', NICHES)?.key, 'casino');
  assert.equal(matchNiche('Online Casino', NICHES)?.key, 'casino');
  assert.equal(matchNiche('sports betting', NICHES)?.key, 'betting');
  assert.equal(matchNiche('totally-unknown-niche', NICHES), undefined);
});

test('categorizeTopic maps a campaign topic to the most specific niche', () => {
  assert.equal(categorizeTopic('premium casino reviews and listings', NICHES), 'casino');
  assert.equal(categorizeTopic('best VPN services', NICHES), 'vpn');
  // generic grey wording falls back to the umbrella
  assert.equal(categorizeTopic('sensitive topics only', NICHES), 'sensitive');
  // an ordinary topic maps to nothing specific
  assert.equal(categorizeTopic('gardening tips', NICHES), undefined);
});

test('offerMatchesFilter: child filter matches the sensitive umbrella (two-way)', () => {
  const sensitiveOffer = mkOffer({ category: 'sensitive', sensitive: true });
  const casinoOffer = mkOffer({ category: 'casino', sensitive: true });
  const regularOffer = mkOffer({ category: 'regular', sensitive: false });

  // filtering casino matches a literal casino OR a generic sensitive offer
  assert.equal(offerMatchesFilter(casinoOffer, 'casino', NICHES), true);
  assert.equal(offerMatchesFilter(sensitiveOffer, 'casino', NICHES), true);
  assert.equal(offerMatchesFilter(regularOffer, 'casino', NICHES), false);

  // filtering the umbrella matches any sensitive child
  assert.equal(offerMatchesFilter(casinoOffer, 'sensitive', NICHES), true);
  assert.equal(offerMatchesFilter(regularOffer, 'sensitive', NICHES), false);

  // regular is standalone
  assert.equal(offerMatchesFilter(regularOffer, 'regular', NICHES), true);
  assert.equal(offerMatchesFilter(casinoOffer, 'regular', NICHES), false);
});

test('resolveOffer falls back from a sensitive child to the umbrella', () => {
  const offers = [mkOffer({ category: 'sensitive', sensitive: true, canPost: 'yes' })];
  assert.equal(resolveOffer(offers, 'casino', NICHES)?.category, 'sensitive');
  assert.equal(resolveOffer(offers, 'regular', NICHES), undefined);
});
