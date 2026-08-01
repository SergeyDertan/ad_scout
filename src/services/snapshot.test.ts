import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../adapters/store/memory.store';
import { fixedClock } from '../lib/clock';
import { buildSnapshot, domainPath, replyPath, snapshotSlug, SNAPSHOT_FORMAT } from './snapshot';
import type { PostOffer, PriceRecord, Reply, Target } from '../domain/types';

const NOW = new Date('2026-08-01T12:00:00.000Z');
const clock = fixedClock(NOW);

function offer(category: string, sensitive: boolean): PostOffer {
  return {
    category,
    label: category,
    sensitive,
    canPost: 'yes',
    price: { amount: 150, currency: 'USD', raw: '$150' },
    term: { key: 'none', raw: '' },
  };
}

function seed(store: MemoryStore) {
  const target: Target = {
    id: 't1',
    websiteUrl: 'https://example.com',
    contactEmail: 'ed@example.com',
    status: 'replied',
    followUpCount: 0,
    createdAt: NOW.toISOString(),
  };
  const reply: Reply = {
    id: 'r1',
    emailId: 'e1',
    rfcMessageId: '<m1@example.com>',
    fromAddress: 'ed@example.com',
    targetId: 't1',
    matchMethod: 'threadId',
    receivedAt: NOW.toISOString(),
    text: 'Casino posts are $150.',
    extractionStatus: 'done',
    parsed: {
      optOut: false,
      canPost: 'yes',
      offers: [offer('casino', true), offer('regular', false)],
      reasoning: 'stated',
    },
  };
  const record: PriceRecord = {
    id: 'pr1',
    domain: 'example.com',
    offers: [offer('casino', true)],
    observedAt: NOW.toISOString(),
    sourceEmail: 'ed@example.com',
    sourceMessageId: '<m1@example.com>',
    replyId: 'r1',
    targetId: 't1',
    attribution: 'sender',
  };
  return Promise.all([store.putTarget(target), store.putReply(reply), store.putPriceRecord(record)]);
}

test('snapshot publishes the domains, the replies behind them, and a manifest', async () => {
  const store = new MemoryStore();
  await seed(store);

  const snapshot = await buildSnapshot(store, clock);
  const paths = new Set(snapshot.files.map((f) => f.path));

  assert.equal(snapshot.manifest.format, SNAPSHOT_FORMAT);
  assert.equal(snapshot.manifest.builtAt, NOW.toISOString());
  assert.equal(snapshot.manifest.counts.replies, 1);
  for (const p of ['domains.json', 'responses.json', 'niches.json', 'batches.json']) {
    assert.ok(paths.has(p), `missing ${p}`);
  }
  assert.ok(paths.has(domainPath('example.com')));
  assert.ok(paths.has(replyPath('r1')));
  // Every data file is hashed, and the hash is what the publisher diffs on.
  assert.deepEqual(
    Object.keys(snapshot.fileHashes).sort(),
    snapshot.files.map((f) => f.path).sort(),
  );
});

test('our sensitivity calls never reach the snapshot', async () => {
  const store = new MemoryStore();
  await seed(store);

  const snapshot = await buildSnapshot(store, clock);
  // The viewer's owner classifies niches himself; anything we shipped as
  // sensitive:true would silently seed his filters with our answers.
  for (const f of snapshot.files) {
    const hits = f.body.match(/"sensitive":true/g);
    assert.equal(hits, null, `${f.path} leaked a sensitivity call`);
  }

  // ...but the niche KEY still travels, or he'd have nothing to classify.
  const domains = JSON.parse(snapshot.files.find((f) => f.path === 'domains.json')!.body);
  assert.deepEqual(
    domains[0].cells.map((c: { category: string }) => c.category),
    ['casino'],
  );
  const niches = JSON.parse(snapshot.files.find((f) => f.path === 'niches.json')!.body);
  assert.ok(niches.some((n: { key: string }) => n.key === 'casino'));
});

test('object names stay addressable, even for keys that are not really domains', () => {
  // The ordinary case is untouched — names stay readable in the bucket.
  assert.equal(snapshotSlug('example.com'), 'example.com');
  assert.equal(snapshotSlug('reply_add229c9-a71c-4f7e-b82d-44510a733299'), 'reply_add229c9-a71c-4f7e-b82d-44510a733299');

  // A botched extraction produced this one. No '%' may survive into the name,
  // or the browser SDK re-encodes it and the file becomes unreachable.
  const messy = snapshotSlug('nftplazas.com and memeburn.com');
  assert.match(messy, /^[a-z0-9._-]+$/);
  assert.ok(messy.startsWith('nftplazas.com-and-memeburn.com-'));

  // Rewritten keys carry a hash of the original, so near-misses stay distinct.
  assert.notEqual(snapshotSlug('a b'), snapshotSlug('a  b'));
  assert.notEqual(snapshotSlug('Example.com'), snapshotSlug('example.com'));
});

test('reply bodies are split out of the list so the index stays small', async () => {
  const store = new MemoryStore();
  await seed(store);

  const snapshot = await buildSnapshot(store, clock);
  const rows = JSON.parse(snapshot.files.find((f) => f.path === 'responses.json')!.body);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].text, undefined);
  assert.equal(rows[0].attachments, undefined);
  // The row still carries what the table, the filters and the export need.
  assert.equal(rows[0].website, 'https://example.com');
  assert.equal(rows[0].parsed.offers.length, 2);

  // The body — and the provenance behind it — live in the per-reply file.
  const detail = JSON.parse(snapshot.files.find((f) => f.path === replyPath('r1'))!.body);
  assert.equal(detail.reply.text, 'Casino posts are $150.');
  assert.equal(detail.reply.website, 'https://example.com');
  assert.equal(detail.priceRecords.length, 1);
  assert.equal(detail.pitchStyle, 'broad');
});
