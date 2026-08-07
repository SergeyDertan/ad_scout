import test from 'node:test';
import assert from 'node:assert/strict';
import { attributeOffers, detectBounce, domainsMentionedIn, emailToDomains, isFreemailAddress, matchReply, MAX_DOMAINS_PER_REPLY, senderSiteDomain, senderSiteIsCredible } from './reply-matching';
import type { PostOffer } from './types';
import { TERM_NONE } from './terms';

const po = (o: Partial<PostOffer>): PostOffer => ({
  category: 'regular', label: 'Regular', sensitive: false, canPost: 'yes', term: TERM_NONE, ...o,
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

// A publisher naming a few of their own sites is an ordinary, useful reply.
test('attributeOffers: a handful of named sites are all kept', () => {
  // "Guest post 400$. Also casik_super.ua for 350$ and ultra_casik.net for 500$."
  const { groups, reviewReasons } = attributeOffers(
    [
      po({ price: { raw: '$400' } }),
      po({ price: { raw: '$350' }, website: 'casik_super.ua' }),
      po({ price: { raw: '$500' }, website: 'ultra_casik.net' }),
    ],
    ['casik.com'],
    'casik.com',
  );
  assert.equal(groups.length, 3); // contacted site + both named sites
  assert.equal(reviewReasons.length, 0);
  assert.deepEqual(
    groups.map((g) => g.domain).sort(),
    ['casik.com', 'casik_super.ua', 'ultra_casik.net'],
  );
});

test('attributeOffers: exactly at the cap is still stored in full', () => {
  const offers = [
    po({ price: { raw: '$100' } }), // the contacted site
    ...Array.from({ length: MAX_DOMAINS_PER_REPLY - 1 }, (_, i) =>
      po({ price: { raw: '$50' }, website: `site${i}.com` }),
    ),
  ];
  const { groups, reviewReasons } = attributeOffers(offers, ['own.com'], 'own.com');
  assert.equal(groups.length, MAX_DOMAINS_PER_REPLY);
  assert.equal(reviewReasons.length, 0);
});

// The bulk-price-list case: "check our prices at example.net/price" → hundreds of
// rows. We asked about one site; that is the only row we have any reason to trust.
test('attributeOffers: a bulk price list collapses to the contacted site', () => {
  const offers = [
    po({ price: { raw: '$500' } }), // untagged → the contacted site
    ...Array.from({ length: 500 }, (_, i) =>
      po({ price: { raw: '$20' }, website: `bulk${i}.com` }),
    ),
  ];
  const { groups, reviewReasons } = attributeOffers(offers, ['omega_casik.net'], 'omega_casik.net');
  assert.deepEqual(groups.map((g) => g.domain), ['omega_casik.net']);
  assert.equal(groups[0].offers.length, 1);
  assert.equal(groups[0].offers[0].price?.raw, '$500');
  // Dropping 500 domains is never silent — it surfaces for a human.
  assert.equal(reviewReasons.length, 1);
  assert.match(reviewReasons[0], /501 sites/);
  assert.match(reviewReasons[0], /omega_casik\.net/);
});

test('attributeOffers: the contacted site is kept even when the list tags it explicitly', () => {
  // A price sheet usually lists the publisher's own site as just another row.
  const offers = Array.from({ length: 60 }, (_, i) =>
    po({ price: { raw: '$20' }, website: `bulk${i}.com` }),
  );
  offers.splice(30, 0, po({ price: { raw: '$500' }, website: 'omega_casik.net' }));
  const { groups } = attributeOffers(offers, ['omega_casik.net'], 'omega_casik.net');
  assert.deepEqual(groups.map((g) => g.domain), ['omega_casik.net']);
  assert.equal(groups[0].offers[0].price?.raw, '$500');
});

test('attributeOffers: a bulk list that never mentions the contacted site records nothing', () => {
  const offers = Array.from({ length: 40 }, (_, i) =>
    po({ price: { raw: '$20' }, website: `bulk${i}.com` }),
  );
  const { groups, reviewReasons } = attributeOffers(offers, ['omega_casik.net'], 'omega_casik.net');
  // Guessing which of 40 unrelated rows to believe is worse than recording none.
  assert.equal(groups.length, 0);
  assert.equal(reviewReasons.length, 1);
  assert.match(reviewReasons[0], /None of them is the contacted site/);
});

test('attributeOffers: an unmatched bulk reply falls back to the unambiguous sender domain', () => {
  const offers = [
    po({ price: { raw: '$500' }, website: 'sender.com' }),
    ...Array.from({ length: 30 }, (_, i) => po({ price: { raw: '$20' }, website: `bulk${i}.com` })),
  ];
  const { groups } = attributeOffers(offers, ['sender.com']); // no matched target
  assert.deepEqual(groups.map((g) => g.domain), ['sender.com']);
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

test('senderSiteDomain reads a corporate sender as their own site', () => {
  assert.equal(senderSiteDomain('info@coincodex.com'), 'coincodex.com');
  assert.equal(senderSiteDomain('Adriana <adriana@MiamiLivingMagazine.com>'), 'miamilivingmagazine.com');
});

test('senderSiteDomain refuses to read a free mailbox as a site', () => {
  // The hinge for an unmatched reply: gmail.com is not the sender's website, so
  // there is nothing to anchor a bulk price list to.
  for (const addr of ['tokyo.reporter@gmail.com', 'x@outlook.com', 'y@yandex.ru', 'z@proton.me']) {
    assert.equal(senderSiteDomain(addr), undefined, addr);
    assert.equal(isFreemailAddress(addr), true, addr);
  }
  assert.equal(isFreemailAddress('info@coincodex.com'), false);
});

test('a bulk price list from a corporate sender keeps that sender own row', () => {
  // Over the cap, the one row we can trust is the sender's own site.
  const offers = Array.from({ length: MAX_DOMAINS_PER_REPLY + 5 }, (_, i) =>
    po({ website: `site${i}.com`, price: { raw: `$${i + 1}`, amount: i + 1 } }),
  );
  offers.push(po({ website: 'publishnova.com', price: { raw: '$99', amount: 99 } }));

  const { groups, capped, reviewReasons } = attributeOffers(
    offers,
    ['publishnova.com'],
    senderSiteDomain('louis.verdet@publishnova.com'),
  );
  assert.equal(capped, true);
  assert.deepEqual(groups.map((g) => g.domain), ['publishnova.com']);
  assert.match(reviewReasons.join(' '), /Kept only the contacted site/);
});

test('a bulk price list from a free mailbox is discarded entirely', () => {
  // No domain to anchor to, so nothing is kept — recording an arbitrary row out
  // of a 900-row rate card would be worse than recording none.
  const offers = Array.from({ length: MAX_DOMAINS_PER_REPLY + 5 }, (_, i) =>
    po({ website: `site${i}.com`, price: { raw: `$${i + 1}`, amount: i + 1 } }),
  );
  const { groups, capped, reviewReasons } = attributeOffers(
    offers,
    [],
    senderSiteDomain('tokyo.reporter@gmail.com'),
  );
  assert.equal(capped, true);
  assert.deepEqual(groups, []);
  assert.match(reviewReasons.join(' '), /None of them is the contacted site/);
});

test('a SHORT price list from a free mailbox is still kept', () => {
  // The cap is what discards; a free mailbox quoting a couple of sites is
  // ordinary and must survive.
  const offers = [
    po({ website: 'a.com', price: { raw: '$100', amount: 100 } }),
    po({ website: 'b.com', price: { raw: '$200', amount: 200 } }),
  ];
  const { groups, capped } = attributeOffers(offers, [], senderSiteDomain('someone@gmail.com'));
  assert.equal(capped, false);
  assert.deepEqual(groups.map((g) => g.domain).sort(), ['a.com', 'b.com']);
});

// --- sender-site credibility (an unmatched reply's guessed domain) -----------

test('a publisher who never names their own site is still credible', () => {
  // The common case: info@theirsite.com quoting a price, no domain in the body.
  assert.equal(senderSiteIsCredible('theirsite.com', 'Yes, we can publish. Our rate is $80 per post.'), true);
});

test('a support desk is never a site you can buy a post on', () => {
  assert.equal(senderSiteIsCredible('signingdaysports.zendesk.com', 'Guest post is $150.'), false);
});

test("a network rate card is not attributed to the agency's own domain", () => {
  // The wpmit.com case: prices for seven other sites, sender's own site absent.
  const body = [
    'Our current rates:',
    'booksummaryclub.com — $100', 'playmyworld.com — $150', 'turbogeek.org — $180',
  ].join('\n');
  assert.equal(senderSiteIsCredible('wpmit.com', body), false);
});

test('a rate card that DOES include the sender site keeps its attribution', () => {
  const body = 'Rates: wpmit.com — $80, booksummaryclub.com — $100, turbogeek.org — $180';
  assert.equal(senderSiteIsCredible('wpmit.com', body), true);
});

test('one stray link does not disqualify the sender site', () => {
  assert.equal(senderSiteIsCredible('theirsite.com', 'Sure — see our media kit at cdn.example.com/kit'), true);
});

test('domainsMentionedIn ignores mail plumbing, freemail and filenames', () => {
  const found = domainsMentionedIn(
    'Write to me at rina@gmail.com or see docs.google.com/spreadsheets/d/abc — rates in media-kit.pdf for turbogeek.org',
  );
  assert.deepEqual(found, ['turbogeek.org']);
});
