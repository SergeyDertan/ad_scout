import test from 'node:test';
import assert from 'node:assert/strict';
import { answerForNiche, priceLabel } from './niche-answer';
import type { CanPost, DomainCell, Tier } from './types';

/** A standing cell. `tier` is the viewer's classification, as api.snapshot.ts
 *  stamps it on; `sensitive` tracks it so the two can't disagree here. */
function cell(category: string, tier: Tier, canPost: CanPost, amount?: number, currency = 'USD'): DomainCell {
  return {
    category,
    label: category,
    sensitive: tier === 'sens',
    tier,
    canPost,
    ...(amount === undefined ? {} : { price: { amount, currency, raw: `$${amount}` } }),
    term: { key: 'none', raw: '' },
  };
}

/** The same, at a named placement term — one niche legitimately has one cell
 *  per duration. */
function termCell(
  category: string,
  tier: Tier,
  months: number,
  amount: number,
  currency = 'USD',
): DomainCell {
  return {
    ...cell(category, tier, 'yes', amount, currency),
    term: { key: `${months}m`, months, days: months * 30, raw: `${months} months` },
  };
}

test('a grey-niche site with no VPN quote answers "maybe" at its grey-niche price', () => {
  // casik.ua: regular $40, casino $500. He has classified casino AND vpn as
  // sensitive, and filters for vpn.
  const cells = [cell('regular', 'reg', 'yes', 40), cell('casino', 'sens', 'yes', 500)];

  const answer = answerForNiche(cells, 'vpn', 'sens');
  assert.ok(answer, 'nothing refuses vpn here, so the domain must still appear');
  assert.equal(answer.canPost, 'maybe');
  assert.equal(answer.inferred, true);
  assert.equal(answer.price, '500 USD', 'the casino price is the evidence, not the $40 regular one');
});

test('an explicit refusal drops the domain from the results', () => {
  // omega_casik: regular $50, casino $999, vpn — no.
  const cells = [
    cell('regular', 'reg', 'yes', 50),
    cell('casino', 'sens', 'yes', 999),
    cell('vpn', 'sens', 'no'),
  ];

  assert.equal(answerForNiche(cells, 'vpn', 'sens'), null);
  // ...but only for the niche they refused.
  assert.equal(answerForNiche(cells, 'casino', 'sens')?.canPost, 'yes');
});

test('several same-tier quotes infer a range', () => {
  // ultra_casik.ua: regular $50, casino $900, cbd $850 → filtering vpn.
  const cells = [
    cell('regular', 'reg', 'yes', 50),
    cell('casino', 'sens', 'yes', 900),
    cell('cbd', 'sens', 'yes', 850),
  ];

  const answer = answerForNiche(cells, 'vpn', 'sens');
  assert.equal(answer?.canPost, 'maybe');
  assert.equal(answer?.price, '850–900 USD');
});

test('the same inference applies inside the regular tier', () => {
  // regular $40, health $30, sport $50 → filtering a regular niche they never
  // priced. Sensitive prices must not leak into a regular estimate.
  const cells = [
    cell('regular', 'reg', 'yes', 40),
    cell('health', 'reg', 'yes', 30),
    cell('sport', 'reg', 'yes', 50),
    cell('casino', 'sens', 'yes', 900),
  ];

  const answer = answerForNiche(cells, 'travel', 'reg');
  assert.equal(answer?.price, '30–50 USD');
});

test('a quoted niche answers for itself, at its own price', () => {
  const cells = [cell('regular', 'reg', 'yes', 40), cell('casino', 'sens', 'yes', 500)];

  const answer = answerForNiche(cells, 'casino', 'sens');
  assert.equal(answer?.canPost, 'yes');
  assert.equal(answer?.inferred, false);
  assert.equal(answer?.price, '500 USD');
});

test('a blanket "no grey niches" rules out every sensitive niche', () => {
  // The extractor emits one umbrella cell for a blanket refusal.
  const cells = [cell('regular', 'reg', 'yes', 40), cell('sensitive', 'sens', 'no')];

  assert.equal(answerForNiche(cells, 'vpn', 'sens'), null);
  assert.equal(answerForNiche(cells, 'casino', 'sens'), null);
  // The regular tier is untouched by it.
  assert.equal(answerForNiche(cells, 'travel', 'reg')?.price, '40 USD');
});

test('a blanket grey-niche PRICE answers the tier, but only as "maybe"', () => {
  const cells = [cell('regular', 'reg', 'yes', 40), cell('sensitive', 'sens', 'yes', 500)];

  const answer = answerForNiche(cells, 'vpn', 'sens');
  assert.equal(answer?.canPost, 'maybe', 'a tier-wide quote still is not a vpn quote');
  assert.equal(answer?.price, '500 USD');
});

test('no same-tier evidence means no answer at all', () => {
  // A site that only ever quoted a regular post tells us nothing about vpn —
  // showing it with its $40 regular price would be actively misleading.
  const cells = [cell('regular', 'reg', 'yes', 40)];
  assert.equal(answerForNiche(cells, 'vpn', 'sens'), null);
});

test('an unclassified niche is never inferred for — only quoted', () => {
  const cells = [
    cell('regular', 'reg', 'yes', 40),
    cell('casino', 'sens', 'yes', 900),
    cell('crypto', 'unknown', 'yes', 300),
  ];

  // He hasn't ruled on 'nft', so there is no peer group: answering $40 (regular)
  // or $900 (casino) would both be guesses dressed as estimates.
  assert.equal(answerForNiche(cells, 'nft', 'unknown'), null);

  // A quote for the unclassified niche itself still shows — that is their word,
  // not our extrapolation.
  assert.equal(answerForNiche(cells, 'crypto', 'unknown')?.price, '300 USD');
  assert.equal(answerForNiche(cells, 'crypto', 'unknown')?.inferred, false);
});

test('mixed currencies are listed side by side, never averaged into one range', () => {
  const cells = [
    cell('casino', 'sens', 'yes', 850, 'USD'),
    cell('cbd', 'sens', 'yes', 800, 'EUR'),
  ];

  assert.equal(answerForNiche(cells, 'vpn', 'sens')?.price, '800 EUR / 850 USD');
});

test('a niche priced at several durations answers at its cheapest term', () => {
  // casino: 1 month $100, 3 months $200. Two products, one niche — the entry
  // price is the answer to "what does a casino post cost here?".
  const cells = [termCell('casino', 'sens', 1, 100), termCell('casino', 'sens', 3, 200)];

  assert.equal(answerForNiche(cells, 'casino', 'sens')?.price, '100 USD');
});

test('inference compares siblings at their cheapest terms, not across durations', () => {
  // casino 1m $100 / 3m $200, cbd 1m $150 / 6m $400 → filtering vpn.
  // The range must span the two niches' entry prices, not $100–$400.
  const cells = [
    termCell('casino', 'sens', 1, 100),
    termCell('casino', 'sens', 3, 200),
    termCell('cbd', 'sens', 1, 150),
    termCell('cbd', 'sens', 6, 400),
  ];

  const answer = answerForNiche(cells, 'vpn', 'sens');
  assert.equal(answer?.inferred, true);
  assert.equal(answer?.price, '100–150 USD');
});

test('the cheapest term is found per currency, not across currencies', () => {
  // A cheap EUR long-term quote must not hide the USD entry price.
  const cells = [
    termCell('casino', 'sens', 1, 500, 'USD'),
    termCell('casino', 'sens', 12, 900, 'USD'),
    termCell('casino', 'sens', 12, 700, 'EUR'),
  ];

  assert.equal(answerForNiche(cells, 'casino', 'sens')?.price, '700 EUR / 500 USD');
});

test('priceLabel copes with cells that carry no usable amount', () => {
  assert.equal(priceLabel([cell('casino', 'sens', 'yes')]), '—');
  const raw: DomainCell = {
    category: 'casino',
    label: 'casino',
    sensitive: true,
    tier: 'sens',
    canPost: 'yes',
    price: { raw: 'depends on the topic' },
    term: { key: 'none', raw: '' },
  };
  assert.equal(priceLabel([raw]), 'depends on the topic');
});
