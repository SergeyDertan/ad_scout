import test from 'node:test';
import assert from 'node:assert/strict';
import { detectBounce, matchReply } from './reply-matching';

const sent = [
  { targetId: 't1', threadId: 'thr_aaa' },
  { targetId: 't2', threadId: 'thr_bbb' },
];
const awaiting = [
  { targetId: 't1', contactEmail: 'info@site1.com' },
  { targetId: 't3', contactEmail: 'Editor@Site3.com' },
];

test('matchReply prefers threadId', () => {
  const r = matchReply({ threadId: 'thr_bbb', fromAddress: 'x@y.com' }, sent, awaiting);
  assert.deepEqual(r, { targetId: 't2', method: 'threadId' });
});

test('matchReply falls back to exact fromAddress (case-insensitive)', () => {
  const r = matchReply({ fromAddress: 'editor@site3.com' }, sent, awaiting);
  assert.deepEqual(r, { targetId: 't3', method: 'fromAddress' });
});

test('matchReply returns unmatched when nothing fits', () => {
  const r = matchReply({ threadId: 'thr_zzz', fromAddress: 'nobody@nope.com' }, sent, awaiting);
  assert.deepEqual(r, { method: 'unmatched' });
});

test('detectBounce flags mailer-daemon and extracts the failed recipient', () => {
  const body = [
    'This is the mail system at host gmail.com.',
    'Delivery to the following recipient failed permanently:',
    'Final-Recipient: rfc822; dead@nowhere.com',
  ].join('\n');
  const r = detectBounce('mailer-daemon@googlemail.com', body);
  assert.equal(r.isBounce, true);
  assert.equal(r.failedRecipient, 'dead@nowhere.com');
});

test('detectBounce returns false for an ordinary reply', () => {
  const r = detectBounce('owner@site.com', 'Sure, the price is $200.');
  assert.equal(r.isBounce, false);
});
