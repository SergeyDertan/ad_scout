import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeDomain } from './domain';

test('normalizeDomain strips scheme, www, path, query, port', () => {
  assert.equal(normalizeDomain('https://www.casik.com/prices?x=1'), 'casik.com');
  assert.equal(normalizeDomain('http://casik.com'), 'casik.com');
  assert.equal(normalizeDomain('//casik.com'), 'casik.com');
  assert.equal(normalizeDomain('www.casik.com'), 'casik.com');
  assert.equal(normalizeDomain('casik.com:8080/path'), 'casik.com');
  assert.equal(normalizeDomain('CASIK.COM'), 'casik.com');
  assert.equal(normalizeDomain('  casik.com  '), 'casik.com');
});

test('normalizeDomain preserves subdomains and distinct TLDs', () => {
  assert.equal(normalizeDomain('casik.com'), 'casik.com');
  assert.equal(normalizeDomain('casik.ua'), 'casik.ua');
  assert.equal(normalizeDomain('ultra.casik.biz'), 'ultra.casik.biz');
  assert.notEqual(normalizeDomain('casik.com'), normalizeDomain('casik.ua'));
  // Only ONE leading www. is stripped — a deeper www stays as a subdomain.
  assert.equal(normalizeDomain('www.blog.casik.com'), 'blog.casik.com');
});

test('normalizeDomain handles email-like and empty inputs', () => {
  assert.equal(normalizeDomain('user:pass@casik.com/x'), 'casik.com');
  assert.equal(normalizeDomain(''), '');
  assert.equal(normalizeDomain('   '), '');
});
