import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assembleResult,
  buildExtractionSchema,
  parseFieldValue,
  parsePrice,
  reconcileOffers,
  type RawExtraction,
  type RawOffer,
} from './extraction';
import { allNiches } from './niches';
import type { InquiryField } from './types';

const NICHES = allNiches();

const FIELDS: InquiryField[] = [
  { key: 'price', question: 'Cost?', type: 'price' },
  { key: 'categories', question: 'Categories?', type: 'list' },
  { key: 'section', question: 'Section?', type: 'text' },
  { key: 'linkType', question: 'Do-follow?', type: 'enum', enumValues: ['dofollow', 'nofollow'] },
  { key: 'sponsored', question: 'Marked sponsored?', type: 'boolean' },
];

test('buildExtractionSchema lists universal + per-field requirements', () => {
  const schema = buildExtractionSchema(FIELDS) as any;
  assert.deepEqual(schema.required, [
    'optOut',
    'offers',
    'reasoning',
    'conditions',
    'notes',
    'fields',
  ]);
  assert.equal(schema.properties.offers.type, 'array');
  assert.deepEqual(schema.properties.offers.items.required, [
    'category',
    'label',
    'sensitive',
    'canPost',
    'priceRaw',
  ]);
  assert.equal(schema.properties.offers.items.properties.canPost.enum.length, 3);
  assert.deepEqual(schema.properties.fields.required, [
    'price',
    'categories',
    'section',
    'linkType',
    'sponsored',
  ]);
  assert.deepEqual(schema.properties.fields.properties.price.required, ['raw']);
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

test('parseFieldValue: price extracts amount + currency', () => {
  assert.deepEqual(parseFieldValue(FIELDS[0], '$300 per article'), {
    type: 'price',
    amount: 300,
    currency: 'USD',
    raw: '$300 per article',
  });
  const eur = parseFieldValue(FIELDS[0], 'around 250 EUR');
  assert.deepEqual(eur, { type: 'price', amount: 250, currency: 'EUR', raw: 'around 250 EUR' });
});

test('parseFieldValue: list splits on separators and "and"', () => {
  assert.deepEqual(parseFieldValue(FIELDS[1], 'esports, betting and slots'), {
    type: 'list',
    values: ['esports', 'betting', 'slots'],
  });
});

test('parseFieldValue: enum matches declared values, else passthrough', () => {
  assert.deepEqual(parseFieldValue(FIELDS[3], 'we only do nofollow links'), {
    type: 'enum',
    value: 'nofollow',
  });
});

test('parseFieldValue: boolean reads yes/no language', () => {
  assert.deepEqual(parseFieldValue(FIELDS[4], 'Yes, it is marked'), {
    type: 'boolean',
    value: true,
  });
  assert.deepEqual(parseFieldValue(FIELDS[4], 'No, never'), { type: 'boolean', value: false });
});

const offer = (o: Partial<RawOffer>): RawOffer => ({
  category: 'regular',
  label: 'Regular',
  sensitive: false,
  canPost: 'yes',
  priceRaw: '',
  ...o,
});

test('assembleResult maps raw answers to typed fields and is gap-tolerant', () => {
  const raw: RawExtraction = {
    optOut: false,
    offers: [offer({ category: 'regular', priceRaw: '$120' })],
    reasoning: 'Regular price stated',
    conditions: 'must be original',
    notes: '',
    fields: {
      price: { raw: '$300' },
      categories: { raw: 'esports, betting' },
      // section intentionally omitted
      linkType: { raw: 'dofollow' },
      sponsored: { raw: 'yes' },
    },
  };
  const { result } = assembleResult(FIELDS, raw, { niches: NICHES });
  assert.equal(result.optOut, false);
  assert.equal(result.conditions, 'must be original');
  assert.deepEqual(result.fields.price, { type: 'price', amount: 300, currency: 'USD', raw: '$300' });
  assert.deepEqual(result.fields.categories, { type: 'list', values: ['esports', 'betting'] });
  assert.deepEqual(result.fields.section, { type: 'text', value: '' }); // gap → empty
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
    fields: {},
  };
  const { result } = assembleResult([], raw, { niches: NICHES, requestedCategory: 'casino' });
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
    fields: {},
  };
  const { result } = assembleResult([], raw, { niches: NICHES, requestedCategory: 'casino' });
  assert.equal(result.canPost, 'yes'); // resolved via umbrella
  assert.deepEqual(result.offers[0].price, { amount: 40, currency: 'USD', raw: '$40' });
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

test('reconcileOffers matches an existing niche by alias without re-learning', () => {
  // "online casino" is a seed alias of the casino niche.
  const { offers, discovered } = reconcileOffers(
    [offer({ category: 'online casino', label: 'Online casino', sensitive: true, canPost: 'yes', priceRaw: '$150' })],
    NICHES,
  );
  assert.equal(discovered.length, 0);
  assert.equal(offers[0].category, 'casino');
});
