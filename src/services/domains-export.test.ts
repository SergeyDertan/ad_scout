import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDomainsExport, fileStem } from './domains-export';
import { TERM_NONE } from '../domain/terms';
import type { DomainRow } from './read-models';

function row(domain: string, batches: DomainRow['batches'] = [], over: Partial<DomainRow> = {}): DomainRow {
  return {
    domain,
    recordCount: 1,
    sourceCount: 1,
    standingCells: 1,
    activeSpecials: 0,
    optedOut: false,
    excluded: false,
    batches,
    cells: [{
      category: 'regular',
      label: 'Regular',
      sensitive: false,
      canPost: 'yes',
      price: { amount: 500, currency: 'USD', raw: '$500' },
      term: TERM_NONE,
    }],
    ...over,
  };
}

test('every export shape names the batches a domain was imported in', () => {
  const rows = [
    row('one.com', [{ id: 'batch_aaaaaaaa1111', name: 'Casino import' }]),
    // Re-imported under another contact: both batches, never just the first.
    row('two.com', [{ id: 'batch_aaaaaaaa1111', name: 'Casino import' }, { id: 'batch_bbbbbbbb2222' }]),
    // A site named inside a reply — no target, so no batch.
    row('three.com'),
  ];

  for (const scope of ['regular', 'both', 'all'] as const) {
    const table = buildDomainsExport(rows, scope);
    const col = table.columns.indexOf('Batch');
    assert.ok(col >= 0, `${scope} has a Batch column`);
    assert.deepEqual(
      table.body.map((line) => line[col]),
      ['Casino import', 'Casino import; batch bbbbbbbb', ''],
    );
  }
});

test('a price column is filled only when the publisher will post it', () => {
  const refuses = row('no.com', [], {
    cells: [{
      category: 'casino', label: 'Casino', sensitive: true, canPost: 'no',
      price: { amount: 900, currency: 'USD', raw: '$900' }, term: TERM_NONE,
    }],
  });
  const table = buildDomainsExport([row('yes.com'), refuses], 'both');
  const regular = table.columns.indexOf('Regular price');
  const sensitive = table.columns.indexOf('Sensitive price');
  assert.deepEqual(table.body.map((line) => line[regular]), [500, '']);
  // Quoted, but refused: it is not a rate anyone can buy, so it stays blank.
  assert.deepEqual(table.body.map((line) => line[sensitive]), ['', '']);
});

test("the 'all' shape gives one column per niche AND term", () => {
  const monthly = row('m.com', [], {
    cells: [
      { category: 'casino', label: 'Casino', sensitive: true, canPost: 'yes', price: { amount: 100, raw: '100' }, term: { key: '1m', raw: 'a month', months: 1, days: 30 } },
      { category: 'casino', label: 'Casino', sensitive: true, canPost: 'yes', price: { amount: 250, raw: '250' }, term: { key: '12m', raw: 'twelve month terms', months: 12, days: 360 } },
    ],
  });
  const table = buildDomainsExport([monthly], 'all');
  // Canonical labels, not the publisher's phrasing ("twelve month terms").
  assert.ok(table.columns.includes('Casino (1 month)'));
  assert.ok(table.columns.includes('Casino (1 year)'));
  assert.equal(table.body[0]![table.columns.indexOf('Casino (1 month)')], 100);
  assert.equal(table.body[0]![table.columns.indexOf('Casino (1 year)')], 250);
});

test('a title becomes a safe filename stem', () => {
  assert.equal(fileStem('AdScout — Casino import — domains export (9/17/2026)'), 'adscout-casino-import-domains-export-9-17-2026');
  assert.equal(fileStem('***'), 'adscout-domains');
});
