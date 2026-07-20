import test from 'node:test';
import assert from 'node:assert/strict';
import { attributeOffers, detectBounce, emailToDomains, matchReply } from './reply-matching';
import type { PostOffer } from './types';

const po = (o: Partial<PostOffer>): PostOffer => ({
  postType: 'guest_post', category: 'regular', label: 'Regular', sensitive: false, canPost: 'yes', ...o,
});

test('emailToDomains maps normalized contact emails to their distinct site domains', () => {
  const map = emailToDomains([
    { contactEmail: 'Owner@Shared.com', websiteUrl: 'https://www.a.com/x' },
    { contactEmail: 'owner@shared.com', websiteUrl: 'b.com' },
    { contactEmail: 'solo@one.com', websiteUrl: 'one.com' },
  ]);
  assert.deepEqual(map.get('owner@shared.com')?.sort(), ['a.com', 'b.com']);
  assert.deepEqual(map.get('solo@one.com'), ['one.com']);
});

test('attributeOffers: named site (M2) vs single sender (M1)', () => {
  const { groups, reviewReasons } = attributeOffers(
    [po({ price: { raw: '$100' } }), po({ price: { raw: '$80' }, website: 'casik.ua' })],
    ['casik.com'],
  );
  assert.equal(reviewReasons.length, 0);
  const sender = groups.find((g) => g.domain === 'casik.com');
  const named = groups.find((g) => g.domain === 'casik.ua');
  assert.equal(sender?.attribution, 'sender');
  assert.equal(named?.attribution, 'named');
});

test('attributeOffers: multi-domain sender + untagged offer → review, no group', () => {
  const { groups, reviewReasons } = attributeOffers([po({})], ['a.com', 'b.com']);
  assert.equal(groups.length, 0);
  assert.equal(reviewReasons.length, 1);
});

// An owner running several of our targets from one mailbox: the reply is still an
// answer about the site we mailed, so its untagged prices belong to that site
// rather than being dropped as ambiguous.
test('attributeOffers: matched target wins over an ambiguous multi-domain sender', () => {
  const { groups, reviewReasons } = attributeOffers(
    [po({ price: { raw: '$100' } }), po({ price: { raw: '$250' }, website: 'b.com' })],
    ['a.com', 'b.com'],
    'a.com',
  );
  assert.equal(reviewReasons.length, 0); // no longer ambiguous
  assert.equal(groups.find((g) => g.domain === 'a.com')?.attribution, 'sender');
  assert.equal(groups.find((g) => g.domain === 'a.com')?.offers.length, 1);
  // An explicitly named site still wins for its own offer.
  assert.equal(groups.find((g) => g.domain === 'b.com')?.attribution, 'named');
});

test('attributeOffers: matched target takes the untagged offer even when the sender maps to one other site', () => {
  const { groups } = attributeOffers([po({})], ['other.com'], 'own.com');
  assert.deepEqual(groups.map((g) => g.domain), ['own.com']);
});

test('attributeOffers: zero sender domains + untagged offer → nothing attributed', () => {
  const { groups, reviewReasons } = attributeOffers([po({})], []);
  assert.equal(groups.length, 0);
  assert.equal(reviewReasons.length, 0);
});

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

test('detectBounce peels the bare address out of a markdown-rendered DSN body', () => {
  // Some providers hand us the bounce body already rendered to markdown, so the
  // failed recipient arrives as an autolink. The recipient must be the bare
  // address, not the `[x](mailto:x)` wrapper (which used to be suppressed verbatim).
  const body = 'Delivery has failed to: [admin@buddymantra.com](mailto:admin@buddymantra.com)';
  const r = detectBounce('mailer-daemon@googlemail.com', body);
  assert.equal(r.isBounce, true);
  assert.equal(r.failedRecipient, 'admin@buddymantra.com');
});

test('detectBounce returns false for an ordinary reply', () => {
  const r = detectBounce('owner@site.com', 'Sure, the price is $200.');
  assert.equal(r.isBounce, false);
});
