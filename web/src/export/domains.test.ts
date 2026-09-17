import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultDomainsHeader } from './domains';

test('the default title names the batch the list is filtered to', () => {
  assert.match(defaultDomainsHeader(), /^AdScout — All batches — domains export/);
  assert.match(defaultDomainsHeader('Casino import'), /^AdScout — Casino import — domains export/);
  // A blank label is "no filter", not an empty scope in the title.
  assert.match(defaultDomainsHeader('  '), /^AdScout — All batches — domains export/);
});
