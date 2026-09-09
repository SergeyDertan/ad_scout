const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 100;

export interface PageInfo {
  limit: number;
  total: number;
  nextCursor?: string;
  previousCursor?: string;
}

export interface PageEnvelope<T, F = Record<string, never>> {
  items: T[];
  page: PageInfo;
  facets: F;
}

export class PageInputError extends Error {}

interface CursorKey {
  value: string;
  id: string;
}

interface StoredCursor extends CursorKey {
  version: 1;
  scope: string;
  direction: 'after' | 'before';
}

export function parsePageLimit(raw: string | null): number {
  if (raw == null || raw === '') return DEFAULT_PAGE_SIZE;
  if (!/^\d+$/.test(raw)) throw new PageInputError('limit must be a positive integer');
  const limit = Number(raw);
  if (limit < 1 || limit > MAX_PAGE_SIZE) {
    throw new PageInputError(`limit must be between 1 and ${MAX_PAGE_SIZE}`);
  }
  return limit;
}

function encodeCursor(cursor: StoredCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeCursor(raw: string, scope: string): StoredCursor {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Partial<StoredCursor>;
    if (
      parsed.version !== 1 ||
      parsed.scope !== scope ||
      (parsed.direction !== 'after' && parsed.direction !== 'before') ||
      typeof parsed.value !== 'string' ||
      typeof parsed.id !== 'string'
    ) {
      throw new Error('shape');
    }
    return parsed as StoredCursor;
  } catch {
    throw new PageInputError('invalid or expired cursor');
  }
}

/**
 * Slice an already sorted result set using an opaque value+id cursor. `compare`
 * must express the same total order used to sort `rows`; the id tie-breaker is
 * what makes navigation stable when several rows share the visible sort value.
 *
 * This is the transitional in-memory implementation. The contract and cursor
 * survive Step 5, where the storage adapter will apply the same boundary in an
 * indexed query instead of receiving a fully materialized array here.
 */
export function paginateSorted<T, F>(
  rows: T[],
  options: {
    limit: number;
    cursor?: string;
    scope: string;
    keyOf: (row: T) => CursorKey;
    compare: (a: CursorKey, b: CursorKey) => number;
    facets: F;
  },
): PageEnvelope<T, F> {
  const { limit, scope, keyOf, compare, facets } = options;
  const cursor = options.cursor ? decodeCursor(options.cursor, scope) : undefined;
  let start = 0;

  if (cursor?.direction === 'after') {
    const firstAfter = rows.findIndex((row) => compare(keyOf(row), cursor) > 0);
    start = firstAfter === -1 ? rows.length : firstAfter;
  } else if (cursor?.direction === 'before') {
    const boundary = rows.findIndex((row) => compare(keyOf(row), cursor) >= 0);
    const end = boundary === -1 ? rows.length : boundary;
    start = Math.max(0, end - limit);
  }

  const items = rows.slice(start, start + limit);
  const end = start + items.length;
  const first = items[0];
  const last = items.at(-1);

  return {
    items,
    page: {
      limit,
      total: rows.length,
      ...(first && start > 0
        ? { previousCursor: encodeCursor({ version: 1, scope, direction: 'before', ...keyOf(first) }) }
        : {}),
      ...(last && end < rows.length
        ? { nextCursor: encodeCursor({ version: 1, scope, direction: 'after', ...keyOf(last) }) }
        : {}),
    },
    facets,
  };
}

export function compareStrings(a: CursorKey, b: CursorKey): number {
  return a.value.localeCompare(b.value) || a.id.localeCompare(b.id);
}

export function compareStringsDescending(a: CursorKey, b: CursorKey): number {
  return b.value.localeCompare(a.value) || b.id.localeCompare(a.id);
}
