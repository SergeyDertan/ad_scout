import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PageInputError,
  compareStringsDescending,
  paginateSorted,
  parsePageLimit,
} from './pagination';

interface Row {
  id: string;
  at: string;
}

const keyOf = (row: Row) => ({ value: row.at, id: row.id });
const newestFirst = (a: Row, b: Row) => compareStringsDescending(keyOf(a), keyOf(b));

test('page limits default, validate, and stay bounded', () => {
  assert.equal(parsePageLimit(null), 50);
  assert.equal(parsePageLimit('1'), 1);
  assert.equal(parsePageLimit('100'), 100);
  assert.throws(() => parsePageLimit('0'), PageInputError);
  assert.throws(() => parsePageLimit('101'), PageInputError);
  assert.throws(() => parsePageLimit('2.5'), PageInputError);
});

test('cursor pages stay stable when a newer row arrives', () => {
  const original: Row[] = [
    { id: 'c', at: '2026-09-03' },
    { id: 'b', at: '2026-09-02' },
    { id: 'a', at: '2026-09-01' },
  ].sort(newestFirst);
  const first = paginateSorted(original, {
    limit: 2,
    scope: 'responses:test',
    keyOf,
    compare: compareStringsDescending,
    facets: {},
  });
  assert.deepEqual(first.items.map((r) => r.id), ['c', 'b']);
  assert.ok(first.page.nextCursor);

  const withNewRow = [{ id: 'd', at: '2026-09-04' }, ...original].sort(newestFirst);
  const second = paginateSorted(withNewRow, {
    limit: 2,
    cursor: first.page.nextCursor,
    scope: 'responses:test',
    keyOf,
    compare: compareStringsDescending,
    facets: {},
  });
  assert.deepEqual(second.items.map((r) => r.id), ['a']);
  assert.equal(second.page.nextCursor, undefined);
});

test('cursor scope prevents reuse with different filters or sorting', () => {
  const page = paginateSorted(
    [
      { id: 'b', at: '2026-09-02' },
      { id: 'a', at: '2026-09-01' },
    ],
    {
    limit: 1,
    scope: 'responses:all',
    keyOf,
    compare: compareStringsDescending,
    facets: {},
    },
  );
  const cursor = page.page.nextCursor!;
  assert.throws(
    () =>
      paginateSorted([], {
        limit: 1,
        cursor,
        scope: 'responses:other-filter',
        keyOf,
        compare: compareStringsDescending,
        facets: {},
      }),
    PageInputError,
  );
});
