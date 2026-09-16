import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDomainsExport, defaultDomainsHeader } from './domains';
import type { DomainSummary } from '../types';

function domain(name: string, batches?: { id: string; name?: string }[]): DomainSummary {
  return {
    domain: name,
    recordCount: 1,
    standingCells: 1,
    activeSpecials: 0,
    optedOut: false,
    excluded: false,
    ...(batches ? { batches } : {}),
    cells: [{
      category: 'regular',
      label: 'Regular',
      sensitive: false,
      canPost: 'yes',
      price: { amount: 500, currency: 'USD', raw: '$500' },
      term: { key: 'none', raw: '' },
    }],
  };
}

test('every export shape names the batches a domain was imported in', () => {
  const rows = [
    domain('one.com', [{ id: 'batch_aaaaaaaa1111', name: 'Casino import' }]),
    // Re-imported under another contact: both batches, never just the first.
    domain('two.com', [{ id: 'batch_aaaaaaaa1111', name: 'Casino import' }, { id: 'batch_bbbbbbbb2222' }]),
    // A site named inside a reply — no target, so no batch.
    domain('three.com'),
  ];

  for (const scope of ['regular', 'both', 'all'] as const) {
    const table = buildDomainsExport(rows, scope);
    const col = table.columns.indexOf('Batch');
    assert.ok(col >= 0, `${scope} has a Batch column`);
    assert.deepEqual(
      table.body.map((row) => row[col]),
      ['Casino import', 'Casino import; batch bbbbbbbb', ''],
    );
  }
});

test('the default title names the batch the list is filtered to', () => {
  assert.match(defaultDomainsHeader(), /^AdScout — All batches — domains export/);
  assert.match(defaultDomainsHeader('Casino import'), /^AdScout — Casino import — domains export/);
  // A blank label is "no filter", not an empty scope in the title.
  assert.match(defaultDomainsHeader('  '), /^AdScout — All batches — domains export/);
});
