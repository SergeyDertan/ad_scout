import assert from 'node:assert/strict';
import { test } from 'node:test';

import { describeError, detectUsageLimit, UsageLimitError } from './errors';

test('detectUsageLimit recognizes the CLI limit message and parses the reset epoch', () => {
  const err = detectUsageLimit('Claude AI usage limit reached|1719763200');
  assert.ok(err instanceof UsageLimitError);
  assert.equal(err?.resetAt?.getTime(), 1719763200 * 1000);
  // Without an epoch it still detects, with no resetAt.
  const noEpoch = detectUsageLimit('5-hour limit reached, try again later');
  assert.ok(noEpoch instanceof UsageLimitError);
  assert.equal(noEpoch?.resetAt, undefined);
  // Ordinary errors are not misclassified.
  assert.equal(detectUsageLimit('claude CLI returned non-JSON output'), undefined);
  assert.equal(detectUsageLimit(undefined), undefined);
});

test('unwraps undici "fetch failed" to the root DNS cause', () => {
  // Shape Node throws when offline: TypeError { cause: Error { code: ENOTFOUND } }.
  const root = Object.assign(new Error('getaddrinfo ENOTFOUND gmail.googleapis.com'), {
    code: 'ENOTFOUND',
    syscall: 'getaddrinfo',
    hostname: 'gmail.googleapis.com',
  });
  const err = Object.assign(new TypeError('fetch failed'), { cause: root });

  const d = describeError(err);
  assert.equal(d.error, 'fetch failed');
  assert.equal(d.code, 'ENOTFOUND');
  assert.equal(d.syscall, 'getaddrinfo');
  assert.equal(d.hostname, 'gmail.googleapis.com');
  assert.equal(d.network, true);
  assert.match(d.chain!, /fetch failed <- getaddrinfo ENOTFOUND.*\[ENOTFOUND\]/);
});

test('follows AggregateError.errors (all connect attempts failed)', () => {
  const sub = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
  const agg = Object.assign(new AggregateError([sub], 'all attempts failed'), {});
  const err = Object.assign(new TypeError('fetch failed'), { cause: agg });

  const d = describeError(err);
  assert.equal(d.code, 'ECONNREFUSED');
  assert.equal(d.network, true);
});

test('flags undici connect timeout as a network failure', () => {
  const root = Object.assign(new Error('Connect Timeout Error'), {
    code: 'UND_ERR_CONNECT_TIMEOUT',
  });
  const err = Object.assign(new TypeError('fetch failed'), { cause: root });

  assert.equal(describeError(err).network, true);
});

test('does not flag an application error as network', () => {
  const d = describeError(new Error('Gmail API /messages/send: HTTP 401 invalid_grant'));
  assert.equal(d.network, undefined);
  assert.equal(d.code, undefined);
  assert.equal(d.error, 'Gmail API /messages/send: HTTP 401 invalid_grant');
});

test('is cycle-safe and handles non-Error values', () => {
  const a: { cause?: unknown; message: string } = { message: 'a' };
  const b = { message: 'b', cause: a };
  a.cause = b; // cycle
  assert.doesNotThrow(() => describeError(a));
  assert.equal(describeError('boom').error, 'boom');
});
