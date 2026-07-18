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
    'conditions',
    'notes',
    'isSpam',
  ]);
  assert.equal(schema.properties.offers.type, 'array');
  assert.deepEqual(schema.properties.offers.items.required, [
    'postType',
    'category',
    'label',
    'sensitive',
    'canPost',
    'priceRaw',
    'priceKind',
    'multiplier',
    'relativeTo',
    'website',
    'isSpecial',
    'specialUntil',
  ]);
  assert.deepEqual(schema.properties.offers.items.properties.postType.enum, [
    'guest_post',
    'link_insertion',
    'banner',
  ]);
  assert.equal(schema.properties.offers.items.properties.canPost.enum.length, 3);
  assert.equal(schema.properties.fields, undefined); // inquiry fields removed
});

test('parsePrice extracts amount + currency, undefined when empty', () => {
  assert.deepEqual(parsePrice('$150'), { amount: 150, currency: 'USD', raw: '$150' });
  assert.deepEqual(parsePrice('around 250 EUR'), {
    amount: 250,
    currency: 'EUR',
    raw: 'around 250 EUR',
  });
  assert.equal(parsePrice(''), undefined);
  assert.equal(parsePrice('  '), undefined);
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
  assert.deepEqual(result.offers[0].price, { amount: 120, currency: 'USD', raw: '$120' });
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
  assert.deepEqual(casino?.price, { amount: 150, currency: 'EUR', raw: '150 EUR' });
  assert.equal(casino?.sensitive, true);
  assert.deepEqual(regular?.price, { amount: 60, currency: 'USD', raw: '$60' });
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
  assert.deepEqual(result.offers[0].price, { amount: 40, currency: 'USD', raw: '$40' });
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
  assert.deepEqual(own?.price, { amount: 100, currency: 'USD', raw: '$100' });
  assert.deepEqual(other?.price, { amount: 80, currency: 'USD', raw: '$80' });
  assert.equal(special?.specialUntil, 'end of month');
  assert.deepEqual(special?.price, { amount: 60, currency: 'USD', raw: '$60' });
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
  assert.deepEqual(offers[0].price, { amount: 99, currency: 'USD', raw: '$99' });
});

test('postType × niche: same niche in different products are distinct offers', () => {
  const { offers } = reconcileOffers(
    [
      offer({ postType: 'guest_post', category: 'regular', priceRaw: '$250' }),
      offer({ postType: 'link_insertion', category: 'regular', priceRaw: '$150' }),
      offer({ postType: 'banner', category: 'regular', priceRaw: '$100/month' }),
      offer({ postType: 'guest_post', category: 'casino', label: 'Casino', sensitive: true, priceRaw: '$400' }),
    ],
    NICHES,
  );
  assert.equal(offers.length, 4);
  const cell = (pt: string, cat: string) => offers.find((o) => o.postType === pt && o.category === cat);
  assert.equal(cell('guest_post', 'regular')?.price?.amount, 250);
  assert.equal(cell('link_insertion', 'regular')?.price?.amount, 150);
  assert.equal(cell('banner', 'regular')?.price?.amount, 100);
  assert.equal(cell('guest_post', 'casino')?.price?.amount, 400);
});

test('postType defaults to guest_post and dedupes within a cell (richer wins)', () => {
  const { offers } = reconcileOffers(
    [
      offer({ category: 'casino', label: 'Casino', sensitive: true, priceRaw: '' }), // no price
      offer({ category: 'casino', label: 'Casino', sensitive: true, priceRaw: '$600' }), // priced → wins
      offer({ postType: 'link_insertion', category: 'casino', label: 'Casino', sensitive: true, priceRaw: '$300' }),
    ],
    NICHES,
  );
  const guestCasino = offers.filter((o) => o.postType === 'guest_post' && o.category === 'casino');
  assert.equal(guestCasino.length, 1); // deduped
  assert.equal(guestCasino[0].price?.amount, 600);
  assert.equal(offers.find((o) => o.postType === 'link_insertion' && o.category === 'casino')?.price?.amount, 300);
});

test('relative price resolves within the SAME post type', () => {
  // regular guest post $250, regular link insertion $100; casino is "double" for
  // BOTH products → casino guest post 500, casino link insertion 200.
  const { offers } = reconcileOffers(
    [
      offer({ postType: 'guest_post', category: 'regular', priceRaw: '$250' }),
      offer({ postType: 'link_insertion', category: 'regular', priceRaw: '$100' }),
      offer({ postType: 'guest_post', category: 'casino', label: 'Casino', sensitive: true, priceRaw: 'double', priceKind: 'relative', multiplier: 2, relativeTo: 'regular' }),
      offer({ postType: 'link_insertion', category: 'casino', label: 'Casino', sensitive: true, priceRaw: 'double', priceKind: 'relative', multiplier: 2, relativeTo: 'regular' }),
    ],
    NICHES,
  );
  const cell = (pt: string, cat: string) => offers.find((o) => o.postType === pt && o.category === cat);
  assert.equal(cell('guest_post', 'casino')?.price?.amount, 500); // 250 × 2
  assert.equal(cell('link_insertion', 'casino')?.price?.amount, 200); // 100 × 2, NOT 250 × 2
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
    raw: 'additional 50% premium (1.5x standard rates)',
  });
  // NOT inverted anymore: casino (375) > regular (250).
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
  assert.deepEqual(casino?.price, { amount: 150, currency: 'USD', raw: '3-5 times of the price listed' });
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
  assert.deepEqual(casino?.price, { amount: 700, currency: 'USD', raw: 'grey niches price is doubled' });
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
