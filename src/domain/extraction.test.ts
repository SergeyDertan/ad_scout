import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assembleResult,
  buildExtractionSchema,
  parsePrice,
  reconcileOffers,
  type RawExtraction,
  type RawOffer,
} from './extraction';
import { allNiches } from './niches';

const NICHES = allNiches();

test('buildExtractionSchema lists the universal requirements', () => {
  const schema = buildExtractionSchema() as any;
  assert.deepEqual(schema.required, [
    'optOut',
    'intent',
    'offers',
    'reasoning',
    'aiExplanation',
    'conditions',
    'notes',
    'isSpam',
  ]);
  assert.equal(schema.properties.offers.type, 'array');
  assert.deepEqual(schema.properties.offers.items.required, [
    'category',
    'label',
    'sensitive',
    'canPost',
    'priceRaw',
    'termRaw',
    'priceKind',
    'multiplier',
    'addend',
    'relativeTo',
    'website',
    'isSpecial',
    'specialUntil',
  ]);
  // The product axis is gone — a guest post is the only thing we buy.
  assert.equal(schema.properties.offers.items.properties.postType, undefined);
  assert.equal(schema.properties.offers.items.properties.canPost.enum.length, 3);
  assert.equal(schema.properties.fields, undefined); // inquiry fields removed
});

test('parsePrice extracts amount + currency, undefined when empty', () => {
  assert.deepEqual(parsePrice('$150'), { amount: 150, currency: 'USD', currencyRaw: '$', raw: '$150' });
  assert.deepEqual(parsePrice('around 250 EUR'), {
    amount: 250,
    currency: 'EUR',
    currencyRaw: 'EUR',
    raw: 'around 250 EUR',
  });
  assert.equal(parsePrice(''), undefined);
  assert.equal(parsePrice('  '), undefined);
});

test('parsePrice captures unmapped currencies in currencyRaw for later resolution', () => {
  // Unknown symbol (Sc): no ISO mapping, but the token is preserved.
  assert.deepEqual(parsePrice('₹5000'), { amount: 5000, currencyRaw: '₹', raw: '₹5000' });
  // Non-ASCII word token abutting the amount.
  assert.deepEqual(parsePrice('250 zł/post'), { amount: 250, currency: 'PLN', currencyRaw: 'zł', raw: '250 zł/post' });
  // Prefixed dollar disambiguates from USD.
  assert.deepEqual(parsePrice('R$ 300'), { amount: 300, currency: 'BRL', currencyRaw: 'R$', raw: 'R$ 300' });
  // An expanded ISO code normalizes.
  assert.deepEqual(parsePrice('CHF 400'), { amount: 400, currency: 'CHF', currencyRaw: 'CHF', raw: 'CHF 400' });
  // A plain number carries no currency token at all.
  assert.deepEqual(parsePrice('150'), { amount: 150, raw: '150' });
  // Spelled-out currency words normalize, keeping the verbatim word.
  assert.deepEqual(parsePrice('350 euro'), { amount: 350, currency: 'EUR', currencyRaw: 'euro', raw: '350 euro' });
  assert.deepEqual(parsePrice('90 euros plus VAT'), { amount: 90, currency: 'EUR', currencyRaw: 'euros', raw: '90 euros plus VAT' });
  // An ISO code glued to the amount (no space) still resolves.
  assert.deepEqual(parsePrice('105eur'), { amount: 105, currency: 'EUR', currencyRaw: 'eur', raw: '105eur' });
});

test('parsePrice reads European thousands separators and the price next to the currency', () => {
  // Dot/space/nbsp thousands separators — not decimals.
  assert.equal(parsePrice('12.000 SEK per year (1090 euro)')?.amount, 12000);
  assert.equal(parsePrice('1.400 USD')?.amount, 1400);
  assert.equal(parsePrice('1.800€')?.amount, 1800);
  assert.equal(parsePrice('16 000 SEK')?.amount, 16000);
  // Genuine decimals are preserved (dot with <3 trailing digits, or a decimal comma).
  assert.equal(parsePrice('$19.99')?.amount, 19.99);
  assert.equal(parsePrice('182,50 EUR')?.amount, 182.5);
  // The amount is the currency-tagged figure, not a stray leading number.
  assert.equal(parsePrice('12 months footer link = $2500')?.amount, 2500);
});

test('parsePrice prefers the 12-month tier, then 6-month, then whatever is left', () => {
  assert.equal(parsePrice('6 months = $1500 / 12 months = $2500')?.amount, 2500);
  assert.equal(parsePrice('6 months = $3000 / 12 months = $5000')?.amount, 5000);
  assert.equal(parsePrice('1 year = €900 / 6 months = €500')?.amount, 900);
  // No period tiers → first currency-tagged figure wins (unchanged behavior).
  assert.equal(parsePrice('400€ (no-follow) / 640€ (do-follow)')?.amount, 400);
});

const offer = (o: Partial<RawOffer>): RawOffer => ({
  category: 'regular',
  label: 'Regular',
  sensitive: false,
  canPost: 'yes',
  priceRaw: '',
  ...o,
});

test('assembleResult preserves prose and is gap-tolerant', () => {
  const raw: RawExtraction = {
    optOut: false,
    offers: [offer({ category: 'regular', priceRaw: '$120' })],
    reasoning: 'Regular price stated',
    conditions: 'must be original',
    notes: '',
  };
  const { result } = assembleResult(raw, { niches: NICHES });
  assert.equal(result.optOut, false);
  assert.equal(result.conditions, 'must be original');
  assert.deepEqual(result.offers[0].price, { amount: 120, currency: 'USD', currencyRaw: '$', raw: '$120' });
});

test('assembleResult captures every priced niche + summary canPost for the requested one', () => {
  // We asked about casino; owner quoted casino AND a regular price.
  const raw: RawExtraction = {
    optOut: false,
    offers: [
      offer({ category: 'casino', label: 'Casino', sensitive: true, canPost: 'yes', priceRaw: '150 EUR' }),
      offer({ category: 'regular', canPost: 'yes', priceRaw: '$60' }),
    ],
    reasoning: 'Owner quoted casino €150 and regular $60',
  };
  const { result } = assembleResult(raw, { niches: NICHES, requestedCategory: 'casino' });
  assert.equal(result.requestedCategory, 'casino');
  assert.equal(result.canPost, 'yes'); // summary = requested (casino) offer
  const casino = result.offers.find((o) => o.category === 'casino');
  const regular = result.offers.find((o) => o.category === 'regular');
  assert.deepEqual(casino?.price, { amount: 150, currency: 'EUR', currencyRaw: 'EUR', raw: '150 EUR' });
  assert.equal(casino?.sensitive, true);
  assert.deepEqual(regular?.price, { amount: 60, currency: 'USD', currencyRaw: '$', raw: '$60' });
  assert.equal(result.reasoning, 'Owner quoted casino €150 and regular $60');
});

test('summary canPost falls back from a requested child to the sensitive umbrella', () => {
  // Asked casino, owner only priced generic "sensitive".
  const raw: RawExtraction = {
    optOut: false,
    offers: [offer({ category: 'sensitive', label: 'Sensitive', sensitive: true, canPost: 'yes', priceRaw: '$40' })],
    reasoning: 'Owner priced sensitive $40; casino not named',
  };
  const { result } = assembleResult(raw, { niches: NICHES, requestedCategory: 'casino' });
  assert.equal(result.canPost, 'yes'); // resolved via umbrella
  assert.deepEqual(result.offers[0].price, { amount: 40, currency: 'USD', currencyRaw: '$', raw: '$40' });
});

test('reconcileOffers carries website / isSpecial / specialUntil onto the offer', () => {
  const { offers } = reconcileOffers(
    [
      offer({ category: 'regular', priceRaw: '$100' }),
      offer({ category: 'regular', priceRaw: '$80', website: 'casik.ua' }),
      offer({ category: 'regular', priceRaw: '$60', isSpecial: true, specialUntil: 'end of month' }),
    ],
    NICHES,
  );
  // Same niche, three different scopes → three distinct cells (own site standing,
  // other-site, own-site special) — none merged.
  assert.equal(offers.length, 3);
  const own = offers.find((o) => !o.website && !o.isSpecial);
  const other = offers.find((o) => o.website === 'casik.ua');
  const special = offers.find((o) => o.isSpecial);
  assert.deepEqual(own?.price, { amount: 100, currency: 'USD', currencyRaw: '$', raw: '$100' });
  assert.deepEqual(other?.price, { amount: 80, currency: 'USD', currencyRaw: '$', raw: '$80' });
  assert.equal(special?.specialUntil, 'end of month');
  assert.deepEqual(special?.price, { amount: 60, currency: 'USD', currencyRaw: '$', raw: '$60' });
});

test('assembleResult summary ignores offers tagged with a different site', () => {
  // Asked casino; own site only priced regular, another site priced casino.
  const raw: RawExtraction = {
    optOut: false,
    offers: [
      offer({ category: 'regular', canPost: 'yes', priceRaw: '$60' }),
      offer({ category: 'casino', label: 'Casino', sensitive: true, canPost: 'no', priceRaw: '', website: 'casik.ua' }),
    ],
    reasoning: 'own regular $60; casik.ua casino declined',
  };
  const { result } = assembleResult(raw, { niches: NICHES, requestedCategory: 'casino' });
  // Summary must NOT pick up the other site's casino 'no'.
  assert.notEqual(result.canPost, 'no');
  assert.equal(result.offers.length, 2); // both offers kept for grouping
});

test('reconcileOffers learns a new niche not in the registry', () => {
  const { offers, discovered } = reconcileOffers(
    [offer({ category: 'short_term_loans', label: 'Short-term loans', sensitive: true, canPost: 'yes', priceRaw: '$99' })],
    NICHES,
  );
  assert.equal(discovered.length, 1);
  assert.equal(discovered[0].key, 'short_term_loans');
  assert.equal(discovered[0].sensitive, true);
  assert.equal(offers[0].category, 'short_term_loans');
  assert.deepEqual(offers[0].price, { amount: 99, currency: 'USD', currencyRaw: '$', raw: '$99' });
});

test('one cell per niche: a niche appears at most once', () => {
  const { offers } = reconcileOffers(
    [
      offer({ category: 'regular', priceRaw: '$250' }),
      offer({ category: 'casino', label: 'Casino', sensitive: true, priceRaw: '$400' }),
    ],
    NICHES,
  );
  assert.equal(offers.length, 2);
  const cell = (cat: string) => offers.find((o) => o.category === cat);
  assert.equal(cell('regular')?.price?.amount, 250);
  assert.equal(cell('casino')?.price?.amount, 400);
});

test('offers for products we do not buy are dropped, never filed under a niche', () => {
  // The prompt tells the model to skip these; this is the deterministic backstop.
  // A $99 link insertion must NOT become the regular guest-post rate.
  const { offers, discovered } = reconcileOffers(
    [
      offer({ category: 'regular', priceRaw: '$250' }),
      offer({ category: 'link_insertion', label: 'Link insertion', priceRaw: '$99' }),
      offer({ category: 'banner', label: 'Banner', priceRaw: '$100/month' }),
      offer({ category: 'casino_link_insertion', label: 'Casino link insertion', sensitive: true, priceRaw: '$300' }),
      offer({ category: 'niche_edit', label: 'Niche edit', priceRaw: '$80' }),
    ],
    NICHES,
  );
  assert.equal(offers.length, 1);
  assert.equal(offers[0].category, 'regular');
  assert.equal(offers[0].price?.amount, 250);
  assert.equal(discovered.length, 0); // and none of them leaked into the registry
});

test('a reply pricing ONLY a link insertion yields no offers at all', () => {
  const { offers } = reconcileOffers(
    [offer({ category: 'link_insertion', label: 'Link insertion', canPost: 'yes', priceRaw: '$99' })],
    NICHES,
  );
  assert.deepEqual(offers, []);
});

test('dedupes within a cell (richer wins)', () => {
  const { offers } = reconcileOffers(
    [
      offer({ category: 'casino', label: 'Casino', sensitive: true, priceRaw: '' }), // no price
      offer({ category: 'casino', label: 'Casino', sensitive: true, priceRaw: '$600' }), // priced → wins
    ],
    NICHES,
  );
  const casino = offers.filter((o) => o.category === 'casino');
  assert.equal(casino.length, 1); // deduped
  assert.equal(casino[0].price?.amount, 600);
});

test('a niche quoted at several durations becomes one cell per duration', () => {
  // "regular post is 99$ for a month and 150$ for 3 months, we also got a super
  // offer of 400$ for the whole year!"
  const { offers } = reconcileOffers(
    [
      offer({ category: 'regular', priceRaw: '99$', termRaw: 'for a month' }),
      offer({ category: 'regular', priceRaw: '150$', termRaw: 'for 3 months' }),
      offer({ category: 'regular', priceRaw: '400$', termRaw: 'the whole year', isSpecial: true }),
    ],
    NICHES,
  );
  assert.equal(offers.length, 3);
  const at = (key: string) => offers.find((o) => o.term.key === key);
  assert.equal(at('1m')?.price?.amount, 99);
  assert.equal(at('3m')?.price?.amount, 150);
  // "the whole year" is known to be 12 months, and stays a promo cell (D5).
  assert.equal(at('12m')?.price?.amount, 400);
  assert.equal(at('12m')?.term.months, 12);
  assert.equal(at('12m')?.isSpecial, true);
  // Each keeps the publisher's own wording for display/provenance.
  assert.equal(at('3m')?.term.raw, 'for 3 months');
});

test('an unstated duration is its own cell, never merged with a termed one', () => {
  const { offers } = reconcileOffers(
    [
      offer({ category: 'regular', priceRaw: '$50' }), // "we can do a guest post for $50"
      offer({ category: 'regular', priceRaw: '$120', termRaw: '12 months' }),
    ],
    NICHES,
  );
  assert.equal(offers.length, 2);
  assert.equal(offers.find((o) => o.term.key === 'none')?.price?.amount, 50);
  assert.equal(offers.find((o) => o.term.key === '12m')?.price?.amount, 120);
});

test('a sub-month duration is stored exactly but carries no months', () => {
  // "we can do 1 week post for 5$" — usable for display/sorting, excluded from
  // month-based filters by construction (no `months`).
  const { offers } = reconcileOffers(
    [offer({ category: 'regular', priceRaw: '5$', termRaw: '1 week' })],
    NICHES,
  );
  assert.equal(offers[0].term.key, '7d');
  assert.equal(offers[0].term.days, 7);
  assert.equal(offers[0].term.months, undefined);
  assert.equal(offers[0].term.raw, '1 week');
});

test('a relative premium fans out across EVERY duration of its base niche', () => {
  // "regular post is 100$ for a month, 150$ for 2 months, casino is double"
  const { offers } = reconcileOffers(
    [
      offer({ category: 'regular', priceRaw: '100$', termRaw: 'for a month' }),
      offer({ category: 'regular', priceRaw: '150$', termRaw: '2 months' }),
      offer({
        category: 'casino',
        label: 'Casino',
        sensitive: true,
        priceRaw: 'double',
        priceKind: 'relative',
        multiplier: 2,
        relativeTo: 'regular',
      }),
    ],
    NICHES,
  );
  const casino = offers.filter((o) => o.category === 'casino');
  assert.equal(casino.length, 2); // one derived cell per base duration
  assert.equal(casino.find((o) => o.term.key === '1m')?.price?.amount, 200);
  assert.equal(casino.find((o) => o.term.key === '2m')?.price?.amount, 300);
  // Each derived cell inherits the base's term wholesale, so it sorts and filters
  // exactly like the regular one it came from.
  assert.equal(casino.find((o) => o.term.key === '2m')?.term.months, 2);
  // The verbatim premium is kept on every derived cell for provenance.
  assert.equal(casino[0].price?.raw, 'double');
});

test('a flat surcharge fans out per placement, not per month', () => {
  const { offers } = reconcileOffers(
    [
      offer({ category: 'regular', priceRaw: '€100', termRaw: '1 month' }),
      offer({ category: 'regular', priceRaw: '€150', termRaw: '3 months' }),
      offer({
        category: 'casino',
        label: 'Casino',
        sensitive: true,
        priceRaw: '€50 extra',
        priceKind: 'relative',
        multiplier: 0,
        addend: 50,
        relativeTo: 'regular',
      }),
    ],
    NICHES,
  );
  const casino = offers.filter((o) => o.category === 'casino');
  assert.equal(casino.find((o) => o.term.key === '1m')?.price?.amount, 150);
  assert.equal(casino.find((o) => o.term.key === '3m')?.price?.amount, 200);
});

test('an explicitly quoted duration beats one derived from a premium', () => {
  // "casino is double, but casino for 12 months is a flat $500".
  const { offers } = reconcileOffers(
    [
      offer({ category: 'regular', priceRaw: '$100', termRaw: '1 month' }),
      offer({ category: 'regular', priceRaw: '$300', termRaw: '12 months' }),
      offer({
        category: 'casino',
        label: 'Casino',
        sensitive: true,
        priceRaw: 'double',
        priceKind: 'relative',
        multiplier: 2,
        relativeTo: 'regular',
      }),
      offer({ category: 'casino', label: 'Casino', sensitive: true, priceRaw: '$500', termRaw: '12 months' }),
    ],
    NICHES,
  );
  const casino = offers.filter((o) => o.category === 'casino');
  assert.equal(casino.find((o) => o.term.key === '1m')?.price?.amount, 200); // derived
  assert.equal(casino.find((o) => o.term.key === '12m')?.price?.amount, 500); // explicit wins
});

test('a relative premium that names its own duration targets only that duration', () => {
  const { offers } = reconcileOffers(
    [
      offer({ category: 'regular', priceRaw: '$100', termRaw: '1 month' }),
      offer({ category: 'regular', priceRaw: '$300', termRaw: '12 months' }),
      offer({
        category: 'casino',
        label: 'Casino',
        sensitive: true,
        priceRaw: 'double',
        termRaw: '12 months',
        priceKind: 'relative',
        multiplier: 2,
        relativeTo: 'regular',
      }),
    ],
    NICHES,
  );
  const casino = offers.filter((o) => o.category === 'casino');
  assert.equal(casino.length, 1);
  assert.equal(casino[0].term.key, '12m');
  assert.equal(casino[0].price?.amount, 600);
});

test('relative price: casino = 1.5x regular is computed from the base (japan-zone case)', () => {
  const { offers } = reconcileOffers(
    [
      offer({ category: 'regular', canPost: 'yes', priceRaw: '$250/year (feature article)' }),
      offer({
        category: 'casino',
        label: 'Casino',
        sensitive: true,
        canPost: 'yes',
        priceRaw: 'additional 50% premium (1.5x standard rates)',
        priceKind: 'relative',
        multiplier: 1.5,
        relativeTo: 'regular',
      }),
    ],
    NICHES,
  );
  const casino = offers.find((o) => o.category === 'casino');
  // 250 * 1.5 = 375, currency inherited from the base, raw kept verbatim.
  assert.deepEqual(casino?.price, {
    amount: 375,
    currency: 'USD',
    currencyRaw: '$',
    raw: 'additional 50% premium (1.5x standard rates)',
  });
  // NOT inverted anymore: casino (375) > regular (250).
  assert.ok(casino!.price!.amount! > offers.find((o) => o.category === 'regular')!.price!.amount!);
});

test('relative price: a flat surcharge is ADDED to the base (jalta "€150 extra" case)', () => {
  const { offers } = reconcileOffers(
    [
      offer({ category: 'regular', canPost: 'yes', priceRaw: '€325' }),
      offer({
        category: 'casino',
        label: 'Casino',
        sensitive: true,
        canPost: 'yes',
        priceRaw: '€150 extra',
        priceKind: 'relative',
        multiplier: 0,
        addend: 150,
        relativeTo: 'regular',
      }),
    ],
    NICHES,
  );
  const casino = offers.find((o) => o.category === 'casino');
  // 325 + 150 = 475 (base × 1 + addend), NOT a bare 150 (which would look cheaper).
  assert.equal(casino?.price?.amount, 475);
  assert.equal(casino?.price?.currency, 'EUR');
  assert.ok(casino!.price!.amount! > offers.find((o) => o.category === 'regular')!.price!.amount!);
});

test('relative price: a range multiplier uses its lower bound (devopsschool 3-5x case)', () => {
  const { offers } = reconcileOffers(
    [
      offer({ category: 'regular', canPost: 'yes', priceRaw: '$50-$150' }),
      offer({
        category: 'casino',
        label: 'Casino',
        sensitive: true,
        canPost: 'yes',
        priceRaw: '3-5 times of the price listed',
        priceKind: 'relative',
        multiplier: 3,
        relativeTo: 'regular',
      }),
    ],
    NICHES,
  );
  const casino = offers.find((o) => o.category === 'casino');
  // base parses to its low end 50; 50 * 3 = 150 (was a bogus $3 before the fix).
  assert.deepEqual(casino?.price, { amount: 150, currency: 'USD', currencyRaw: '$', raw: '3-5 times of the price listed' });
});

test('relative price: "doubled" with a clean base (incomera case)', () => {
  const { offers } = reconcileOffers(
    [
      offer({ category: 'regular', canPost: 'yes', priceRaw: '$350 per link' }),
      offer({
        category: 'casino',
        label: 'Casino',
        sensitive: true,
        canPost: 'yes',
        priceRaw: 'grey niches price is doubled',
        priceKind: 'relative',
        multiplier: 2,
        relativeTo: 'regular',
      }),
    ],
    NICHES,
  );
  const casino = offers.find((o) => o.category === 'casino');
  assert.deepEqual(casino?.price, { amount: 700, currency: 'USD', currencyRaw: '$', raw: 'grey niches price is doubled' });
});

test('relative price with no resolvable base keeps the verbatim phrase, no amount', () => {
  const { offers } = reconcileOffers(
    [
      offer({
        category: 'casino',
        label: 'Casino',
        sensitive: true,
        canPost: 'yes',
        priceRaw: '2x our normal rate',
        priceKind: 'relative',
        multiplier: 2,
        relativeTo: 'regular',
      }),
    ],
    NICHES,
  );
  const casino = offers.find((o) => o.category === 'casino');
  assert.deepEqual(casino?.price, { raw: '2x our normal rate' }); // no base → no fabricated amount
});

test('a relative offer never parses a bogus absolute from its premium phrase', () => {
  // "50% premium" must NOT become $50 when there is no base to multiply.
  const { offers } = reconcileOffers(
    [
      offer({
        category: 'casino',
        label: 'Casino',
        sensitive: true,
        canPost: 'yes',
        priceRaw: 'additional 50% premium',
        priceKind: 'relative',
        multiplier: 1.5,
        relativeTo: 'regular',
      }),
    ],
    NICHES,
  );
  assert.equal(offers[0].price?.amount, undefined);
});

test('reconcileOffers matches an existing niche by alias without re-learning', () => {
  // "online casino" is a seed alias of the casino niche.
  const { offers, discovered } = reconcileOffers(
    [offer({ category: 'online casino', label: 'Online casino', sensitive: true, canPost: 'yes', priceRaw: '$150' })],
    NICHES,
  );
  assert.equal(discovered.length, 0);
  assert.equal(offers[0].category, 'casino');
});
