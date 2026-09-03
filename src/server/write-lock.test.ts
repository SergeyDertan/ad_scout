import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../config';
import { MemoryStore } from '../adapters/store/memory.store';
import type { Account, Batch, Reply, Target } from '../domain/types';
import { systemClock } from '../lib/clock';
import { Mutex } from '../lib/mutex';
import { createApiServer, type ServerDeps } from './app';

// `PATCH /api/replies/:id` writes four kinds of document in sequence — niches,
// the reply, its target, price records. A poll pass or an incoming extraction
// from the hub writes the same reply, and both used to be able to interleave:
// the dashboard route took no lock at all, so a hand-edit could land between a
// pipeline's own reads and writes and leave the reply edited while its target
// still carried the previous result. Nothing threw; the data was just wrong.
//
// The fix is the lock the pipeline already uses, not a per-document retry: a
// retrying mutator makes each `put` atomic and still lets a writer slip in
// BETWEEN putReply and updateTarget.

const config = loadConfig({} as NodeJS.ProcessEnv);
const webDir = fileURLToPath(new URL('./__fixtures__/web', import.meta.url));

async function seed(store: MemoryStore): Promise<void> {
  const batch: Batch = { id: 'b1', name: 'b', source: 'import', createdAt: '2026-05-01T00:00:00Z' };
  const account: Account = {
    id: 'a1',
    email: 'me@example.com',
    providerType: 'smtp-imap',
    credentialRef: 'X',
    senderName: 'Me',
    status: 'active',
    createdAt: '2026-05-01T00:00:00Z',
    maxDailyLimit: 40,
  };
  const target: Target = {
    id: 't1',
    batchId: 'b1',
    websiteUrl: 'site1.com',
    contactEmail: 'a@site1.com',
    status: 'contacted',
    followUpCount: 0,
    createdAt: '2026-06-01T00:00:00Z',
  };
  const reply: Reply = {
    id: 'r1',
    emailId: 'e1',
    rfcMessageId: '<e1@x>',
    fromAddress: 'a@site1.com',
    targetId: 't1',
    matchMethod: 'fromAddress',
    receivedAt: '2026-06-02T00:00:00Z',
    text: 'Guest post is $500.',
    extractionStatus: 'done',
  };
  await Promise.all([
    store.putBatch(batch),
    store.putAccount(account),
    store.putTarget(target),
    store.putReply(reply),
  ]);
}

test('a dashboard reply edit waits for an in-flight pipeline write instead of interleaving', async () => {
  const store = new MemoryStore();
  await seed(store);

  const events: string[] = [];

  // Observe the route's own writes, so we can see exactly where they land
  // relative to the critical section held by the "pipeline".
  const realPutReply = store.putReply.bind(store);
  (store as unknown as { putReply: typeof store.putReply }).putReply = async (r: Reply) => {
    events.push('edit:putReply');
    return realPutReply(r);
  };
  const realUpdateTarget = store.updateTarget.bind(store);
  (store as unknown as { updateTarget: typeof store.updateTarget }).updateTarget = async (
    id: string,
    mutate: (t: Target) => Target,
  ) => {
    events.push('edit:updateTarget');
    return realUpdateTarget(id, mutate);
  };

  // THE shared lock — the same object serve.ts hands to both the pipeline
  // passes and the API server.
  const writeLock = new Mutex();

  const deps: ServerDeps = {
    store,
    config,
    clock: systemClock,
    runSend: async () => ({}),
    runPoll: async () => ({}),
    runFetch: async () => ({}),
    webDir,
    writeLock,
  };
  const server = createApiServer(deps);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  try {
    // A pipeline-style critical section: takes the lock first and holds it
    // across an await, exactly as persistExtraction does in remote-hub.ts.
    const pipeline = writeLock.run(async () => {
      events.push('hub:start');
      await new Promise((r) => setTimeout(r, 40));
      events.push('hub:end');
    });

    const patch = fetch(`${base}/api/replies/r1`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        offers: [{ category: 'casino', canPost: 'yes', priceRaw: '$400' }],
        optOut: false,
      }),
    });

    const [, res] = await Promise.all([pipeline, patch]);
    assert.equal(res.status, 200);

    // The edit's writes must all land AFTER the held section closed. Without the
    // lock, 'edit:putReply' appears between 'hub:start' and 'hub:end' — the
    // route's body-parse finishes long before the 40 ms section does.
    const start = events.indexOf('hub:start');
    const end = events.indexOf('hub:end');
    assert.ok(start !== -1 && end !== -1, `missing hub markers: ${events.join(',')}`);
    const between = events.slice(start + 1, end);
    assert.deepEqual(between, [], `a write interleaved with the held lock: ${events.join(',')}`);
    assert.ok(
      events.indexOf('edit:putReply') > end,
      `the edit did not wait for the lock: ${events.join(',')}`,
    );

    // ...and the edit really was applied, not merely serialized.
    const saved = (await store.listReplies()).find((r) => r.id === 'r1');
    assert.equal(saved?.parsed?.offers.length, 1);
    const target = await store.getTarget('t1');
    assert.equal(target?.status, 'replied');
  } finally {
    (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test('without a shared lock the server still serializes against itself', async () => {
  // ServerDeps.writeLock is optional: an embedding that passes none still gets a
  // private Mutex, so two concurrent dashboard edits cannot interleave with each
  // other. It just cannot know about a pipeline it was never told about.
  const store = new MemoryStore();
  await seed(store);
  const deps: ServerDeps = {
    store,
    config,
    clock: systemClock,
    runSend: async () => ({}),
    runPoll: async () => ({}),
    runFetch: async () => ({}),
    webDir,
  };
  const server = createApiServer(deps);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  try {
    const body = (price: string) =>
      JSON.stringify({ offers: [{ category: 'casino', canPost: 'yes', priceRaw: price }], optOut: false });
    const [a, b] = await Promise.all([
      fetch(`${base}/api/replies/r1`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: body('$100') }),
      fetch(`${base}/api/replies/r1`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: body('$200') }),
    ]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    // One of them won cleanly; neither produced a half-applied document.
    const saved = (await store.listReplies()).find((r) => r.id === 'r1');
    assert.equal(saved?.parsed?.offers.length, 1);
  } finally {
    (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
