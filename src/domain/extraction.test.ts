import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assembleResult,
  buildExtractionSchema,
  parseFieldValue,
  type RawExtraction,
} from './extraction';
import type { InquiryField } from './types';

const FIELDS: InquiryField[] = [
  { key: 'price', question: 'Cost?', type: 'price' },
  { key: 'categories', question: 'Categories?', type: 'list' },
  { key: 'section', question: 'Section?', type: 'text' },
  { key: 'linkType', question: 'Do-follow?', type: 'enum', enumValues: ['dofollow', 'nofollow'] },
  { key: 'sponsored', question: 'Marked sponsored?', type: 'boolean' },
];

test('buildExtractionSchema lists universal + per-field requirements', () => {
  const schema = buildExtractionSchema(FIELDS) as any;
  assert.deepEqual(schema.required, ['canPost', 'optOut', 'conditions', 'notes', 'fields']);
  assert.equal(schema.properties.canPost.enum.length, 3);
  assert.deepEqual(schema.properties.fields.required, [
    'price',
    'categories',
    'section',
    'linkType',
    'sponsored',
  ]);
  assert.deepEqual(schema.properties.fields.properties.price.required, ['raw']);
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

test('assembleResult maps raw answers to typed fields and is gap-tolerant', () => {
  const raw: RawExtraction = {
    canPost: 'yes',
    optOut: false,
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
  const result = assembleResult(FIELDS, raw);
  assert.equal(result.canPost, 'yes');
  assert.equal(result.optOut, false);
  assert.equal(result.conditions, 'must be original');
  assert.deepEqual(result.fields.price, { type: 'price', amount: 300, currency: 'USD', raw: '$300' });
  assert.deepEqual(result.fields.categories, { type: 'list', values: ['esports', 'betting'] });
  assert.deepEqual(result.fields.section, { type: 'text', value: '' }); // gap → empty
});
