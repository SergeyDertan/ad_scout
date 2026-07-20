import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../config';
import { MemoryStore } from '../adapters/store/memory.store';
import type { Account, Batch, Reply, Target } from '../domain/types';
import { systemClock } from '../lib/clock';
import { createApiServer, type ServerDeps } from './app';

const config = loadConfig({} as NodeJS.ProcessEnv);

// Hermetic static-serving fixture (only an index.html), independent of the
// real web/ front-end module and its build artifacts.
const webDir = fileURLToPath(new URL('./__fixtures__/web', import.meta.url));

// fetch().json() is typed `unknown` under @types/node — small typed helper.
async function J(url: string, init?: RequestInit): Promise<any> {
  return (await fetch(url, init)).json();
}

function seed(store: MemoryStore) {
  const batch: Batch = {
    id: 'b1',
    name: 'casino import',
    source: 'import',
    createdAt: '2026-05-01T00:00:00Z',
  };
  const account: Account = {
    id: 'a1',
    email: 'vlad@example.com',
    providerType: 'smtp-imap',
    credentialRef: 'VLAD',
    senderName: 'Vlad',
    status: 'active',
    createdAt: '2026-05-01T00:00:00Z',
    maxDailyLimit: 40,
  };
  const t1: Target = {
    id: 't1',
    batchId: 'b1',
    websiteUrl: 'site1.com',
    contactEmail: 'a@site1.com',
    status: 'pending',
    followUpCount: 0,
    createdAt: '2026-06-01T00:00:00Z',
  };
  const t2: Target = { ...t1, id: 't2', websiteUrl: 'site2.com', contactEmail: 'b@site2.com', status: 'contacted' };
  return Promise.all([store.putBatch(batch), store.putAccount(account), store.putTarget(t1), store.putTarget(t2)]);
}

interface Harness {
  base: string;
  store: MemoryStore;
  sendCalls: () => number;
  pollCalls: () => number;
  close: () => Promise<void>;
}

async function start(): Promise<Harness> {
  const store = new MemoryStore();
  await seed(store);
  let sendCalls = 0;
  let pollCalls = 0;
  const deps: ServerDeps = {
    store,
    config,
    clock: systemClock,
    runSend: async () => {
      sendCalls++;
      return { sent: 1, reserved: 1, failed: 0, skipped: 0 };
    },
    runPoll: async () => {
      pollCalls++;
      return { fetched: 0 };
    },
    runFetch: async () => ({ fetched: 0, deduped: 0, bounced: 0, matched: 0, unmatched: 0 }),
    webDir,
    providers: { llm: 'dummy', email: 'dummy', store: 'memory' },
  };
  const server = createApiServer(deps);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    store,
    sendCalls: () => sendCalls,
    pollCalls: () => pollCalls,
    close: () =>
      new Promise<void>((resolve) => {
        (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

test('GET /api/status returns ok with counts', async () => {
  const h = await start();
  try {
    const s = await J(`${h.base}/api/status`);
    assert.equal(s.ok, true);
    assert.equal(s.accounts, 1);
    assert.equal(s.targets.total, 2);
    assert.deepEqual(s.providers, { llm: 'dummy', email: 'dummy', store: 'memory' });
  } finally {
    await h.close();
  }
});

test('GET /api/status engagement funnel splits replies by intent', async () => {
  const h = await start(); // seeds t1 (pending) + t2 (contacted, no reply)
  try {
    const target = (id: string, status: Target['status'], result?: Target['result']): Target => ({
      id,
      batchId: 'b1',
      websiteUrl: `${id}.com`,
      contactEmail: `${id}@x.com`,
      status,
      followUpCount: 0,
      createdAt: '2026-06-01T00:00:00Z',
      ...(result ? { result } : {}),
    });
    const answer = (intent: 'answer' | 'decline'): NonNullable<Target['result']> => ({
      canPost: intent === 'answer' ? 'yes' : 'no',
      optOut: false,
      intent,
      // The 'answer' target quotes a price; 'decline' addresses posting with a no.
      offers:
        intent === 'answer'
          ? [
              {
                postType: 'guest_post',
                category: 'casino',
                label: 'Casino',
                sensitive: false,
                canPost: 'yes',
                price: { amount: 120, currency: 'USD', raw: '$120' },
              },
            ]
          : [{ postType: 'guest_post', category: 'casino', label: 'Casino', sensitive: false, canPost: 'no' }],
    });
    const reply = (id: string, targetId: string): Reply => ({
      id,
      emailId: `e-${id}`,
      rfcMessageId: `<${id}@x>`,
      fromAddress: `${targetId}@x.com`,
      targetId,
      matchMethod: 'fromAddress',
      receivedAt: '2026-06-19T10:00:00Z',
      text: 'hi',
      extractionStatus: 'done',
    });

    // t3: contacted + holding reply (acknowledged); t4: answered; t5: declined;
    // t6: excluded + reply (opted-out).
    await h.store.putTarget(target('t3', 'contacted'));
    await h.store.putTarget(target('t4', 'replied', answer('answer')));
    await h.store.putTarget(target('t5', 'replied', answer('decline')));
    await h.store.putTarget(target('t6', 'excluded'));
    await h.store.putReply(reply('r3', 't3'));
    await h.store.putReply(reply('r4', 't4'));
    await h.store.putReply(reply('r5', 't5'));
    await h.store.putReply(reply('r6', 't6'));

    const s = await J(`${h.base}/api/status`);
    assert.deepEqual(s.engagement, {
      queued: 1, // t1
      contacted: 1, // t2 (silent)
      acknowledged: 1, // t3 (holding reply)
      answered: 1, // t4
      declined: 1, // t5
      other: 0,
      optedOut: 1, // t6
      excluded: 0,
      bounced: 0,
      replied: 4, // t3 + t4 + t5 + t6
    });
    assert.deepEqual(s.outcomes, {
      informative: 2, // t4 (priced offer) + t5 (posting=no offer)
      priced: 1, // t4 quoted $120
      postingYes: 1, // t4 can post
      postingNo: 1, // t5 declined to post
    });
  } finally {
    await h.close();
  }
});

test('GET /api/accounts lists accounts', async () => {
  const h = await start();
  try {
    const accs = await J(`${h.base}/api/accounts`);
    assert.equal(accs.length, 1);
    assert.equal(accs[0].email, 'vlad@example.com');
  } finally {
    await h.close();
  }
});

test('pause / resume an account', async () => {
  const h = await start();
  try {
    let r = await J(`${h.base}/api/accounts/a1/pause`, { method: 'POST' });
    assert.equal(r.status, 'paused');
    r = await J(`${h.base}/api/accounts/a1/resume`, { method: 'POST' });
    assert.equal(r.status, 'active');
  } finally {
    await h.close();
  }
});

test('PATCH /api/accounts/:id updates the daily limit', async () => {
  const h = await start();
  try {
    const r = await J(`${h.base}/api/accounts/a1`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dailyLimitOverride: 7 }),
    });
    assert.equal(r.dailyLimitOverride, 7);
    const stored = await h.store.getAccount('a1');
    assert.equal(stored?.dailyLimitOverride, 7);
  } finally {
    await h.close();
  }
});

test('GET /api/targets?status= filters', async () => {
  const h = await start();
  try {
    const pending = await J(`${h.base}/api/targets?status=pending`);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].id, 't1');
    const all = await J(`${h.base}/api/targets`);
    assert.equal(all.length, 2);
  } finally {
    await h.close();
  }
});

test('POST /api/preview renders the outreach email from the global pitch profile', async () => {
  const h = await start();
  try {
    const preview = await J(`${h.base}/api/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ websiteUrl: 'target.example' }),
    });
    assert.ok(preview.subject.length > 0);
    assert.match(preview.body, /rates for:/); // the broad pricing ask
    assert.equal(preview.senderEmail, 'vlad@example.com');
    // A per-import advertised override flows into the body.
    const overridden = await J(`${h.base}/api/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ websiteUrl: 'target.example', advertised: { url: 'poker.example', description: 'a poker room' } }),
    });
    assert.match(overridden.body, /poker\.example/);
  } finally {
    await h.close();
  }
});

test('POST /api/accounts creates a Gmail account with derived credentialRef', async () => {
  const h = await start();
  try {
    const acc = await J(`${h.base}/api/accounts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'sales.team@gmail.com', senderName: 'Sales' }),
    });
    assert.equal(acc.email, 'sales.team@gmail.com');
    assert.equal(acc.providerType, 'gmail-api');
    assert.equal(acc.status, 'paused');
    assert.equal(acc.credentialRef, 'GMAIL_SALES_TEAM');
    assert.equal((await h.store.listAccounts()).length, 2);
  } finally {
    await h.close();
  }
});

test('POST /api/accounts validates required fields', async () => {
  const h = await start();
  try {
    const res = await fetch(`${h.base}/api/accounts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'x@y.com' }),
    });
    assert.equal(res.status, 400);
  } finally {
    await h.close();
  }
});

test('DELETE /api/accounts/:id removes an account', async () => {
  const h = await start();
  try {
    const r = await J(`${h.base}/api/accounts/a1`, { method: 'DELETE' });
    assert.equal(r.ok, true);
    assert.equal(await h.store.getAccount('a1'), undefined);
  } finally {
    await h.close();
  }
});

test('POST /api/targets queues a target (mints a manual batch when none given)', async () => {
  const h = await start();
  try {
    const t = await J(`${h.base}/api/targets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ websiteUrl: 'new.example', contactEmail: 'hi@new.example' }),
    });
    assert.equal(t.status, 'pending');
    assert.ok(t.batchId.startsWith('batch_'));
    assert.equal(t.followUpCount, 0);
    assert.equal((await h.store.listTargets()).length, 3);
    // The minted batch is a 'manual' one-off.
    assert.equal((await h.store.getBatch(t.batchId))?.source, 'manual');
  } finally {
    await h.close();
  }
});

test('POST /api/targets rejects an unknown batchId', async () => {
  const h = await start();
  try {
    const res = await fetch(`${h.base}/api/targets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ websiteUrl: 'x.example', contactEmail: 'a@x.example', batchId: 'nope' }),
    });
    assert.equal(res.status, 400);
  } finally {
    await h.close();
  }
});

test('GET /api/domains + /api/domains/:domain expose the derived price sheet', async () => {
  const h = await start();
  try {
    // Two records for site1.com: an older regular+sensitive, a newer regular update.
    await h.store.putPriceRecord({
      id: 'pr1', domain: 'site1.com', attribution: 'sender', sourceEmail: 'a@site1.com',
      sourceMessageId: '<A>', observedAt: '2026-02-01T00:00:00Z',
      offers: [
        { postType: 'guest_post', category: 'regular', label: 'Regular', sensitive: false, canPost: 'yes', price: { amount: 500, raw: '500' } },
        { postType: 'guest_post', category: 'sensitive', label: 'Sensitive', sensitive: true, canPost: 'yes', price: { amount: 600, raw: '600' } },
      ],
    });
    await h.store.putPriceRecord({
      id: 'pr2', domain: 'site1.com', attribution: 'sender', sourceEmail: 'a@site1.com',
      sourceMessageId: '<B>', observedAt: '2026-04-04T00:00:00Z',
      offers: [{ postType: 'guest_post', category: 'regular', label: 'Regular', sensitive: false, canPost: 'yes', price: { amount: 550, raw: '550' } }],
    });

    const domains = await J(`${h.base}/api/domains`);
    const site1 = domains.find((d: any) => d.domain === 'site1.com');
    assert.equal(site1.recordCount, 2);
    assert.equal(site1.standingCells, 2);
    assert.equal(site1.lastObservedAt, '2026-04-04T00:00:00Z');
    // site2.com is known via the seeded target even with no records.
    assert.ok(domains.some((d: any) => d.domain === 'site2.com'));

    const detail = await J(`${h.base}/api/domains/site1.com`);
    const regular = detail.sheet.cells.find((c: any) => c.category === 'regular');
    const sensitive = detail.sheet.cells.find((c: any) => c.category === 'sensitive');
    assert.equal(regular.price.amount, 550);
    assert.equal(regular.stale, false);
    assert.equal(sensitive.price.amount, 600);
    assert.equal(sensitive.stale, true); // carried forward from the earlier message
    assert.equal(detail.history.length, 2);
    assert.equal(detail.excluded, false);
  } finally {
    await h.close();
  }
});

test('GET /api/replies/:id returns the source message behind a price record', async () => {
  const h = await start();
  try {
    const reply: Reply = {
      id: 'rep1',
      emailId: 'em1',
      rfcMessageId: '<A>',
      fromAddress: 'a@site1.com',
      targetId: 't1',
      matchMethod: 'threadId',
      receivedAt: '2026-02-01T00:00:00Z',
      text: 'We can post a guest post for $500.',
      extractionStatus: 'done',
    };
    await h.store.putReply(reply);

    const got = await J(`${h.base}/api/replies/rep1`);
    assert.equal(got.id, 'rep1');
    assert.equal(got.text, 'We can post a guest post for $500.');
    assert.equal(got.fromAddress, 'a@site1.com');

    const res = await fetch(`${h.base}/api/replies/does-not-exist`);
    assert.equal(res.status, 404);
  } finally {
    await h.close();
  }
});

test('ignore + exclusion CRUD round-trips', async () => {
  const h = await start();
  try {
    const ig = await J(`${h.base}/api/ignore`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'domain', value: 'HTTPS://www.Spammy.com/x', reason: 'noise' }),
    });
    assert.equal(ig.value, 'spammy.com');
    assert.equal(ig.id, 'domain:spammy.com');
    assert.equal((await J(`${h.base}/api/ignore`)).length, 1);
    await J(`${h.base}/api/ignore/${encodeURIComponent('domain:spammy.com')}`, { method: 'DELETE' });
    assert.equal((await J(`${h.base}/api/ignore`)).length, 0);

    const ex = await J(`${h.base}/api/exclusions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain: 'blocked.com' }),
    });
    assert.equal(ex.domain, 'blocked.com');
    assert.equal(ex.reason, 'manual');
    assert.equal(await h.store.isDomainExcluded('blocked.com'), true);
    await J(`${h.base}/api/exclusions/blocked.com`, { method: 'DELETE' });
    assert.equal(await h.store.isDomainExcluded('blocked.com'), false);
  } finally {
    await h.close();
  }
});

test('POST /api/targets rejects an import whose domain is excluded (D9)', async () => {
  const h = await start();
  try {
    await h.store.putDomainExclusion({ id: 'blocked.com', domain: 'blocked.com', reason: 'declined', at: '2026-06-01T00:00:00Z' });
    const res = await fetch(`${h.base}/api/targets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ websiteUrl: 'https://www.blocked.com/path', contactEmail: 'a@blocked.com' }),
    });
    assert.equal(res.status, 409);
    assert.equal((await h.store.listTargets()).length, 2); // nothing created
  } finally {
    await h.close();
  }
});

test('DELETE /api/targets/:id removes a target', async () => {
  const h = await start();
  try {
    const r = await J(`${h.base}/api/targets/t1`, { method: 'DELETE' });
    assert.equal(r.ok, true);
    assert.equal(await h.store.getTarget('t1'), undefined);
  } finally {
    await h.close();
  }
});

test('PATCH /api/replies/:id applies a human correction and clears review', async () => {
  const h = await start();
  try {
    const reply: Reply = {
      id: 'r1',
      emailId: 'e1',
      rfcMessageId: '<e1@x>',
      fromAddress: 'a@site1.com',
      targetId: 't1',
      matchMethod: 'fromAddress',
      receivedAt: '2026-06-02T00:00:00Z',
      text: 'see attached price list',
      extractionStatus: 'done',
      review: ['Unsupported attachment type, read it manually: rates.xlsx (…)'],
      parsed: { canPost: 'maybe', optOut: false, offers: [] },
    };
    await h.store.putReply(reply);

    const updated = await J(`${h.base}/api/replies/r1`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        offers: [
          { category: 'regular', label: 'Regular', sensitive: false, canPost: 'yes', priceRaw: '$50' },
          { label: 'Casino', sensitive: true, canPost: 'yes', priceRaw: '$100' },
        ],
      }),
    });

    assert.equal(updated.review, undefined); // cleared
    const offers = updated.parsed.offers as Array<{ category: string; sensitive?: boolean; price?: { amount?: number } }>;
    assert.equal(offers.length, 2);
    const regular = offers.find((o) => o.category === 'regular');
    const casino = offers.find((o) => o.sensitive);
    assert.equal(regular?.price?.amount, 50);
    assert.equal(casino?.price?.amount, 100);

    // Rolled up onto the target.
    const t1 = await h.store.getTarget('t1');
    assert.equal(t1?.status, 'replied');
    assert.equal((t1?.result?.offers ?? []).length, 2);
  } finally {
    await h.close();
  }
});

// A portfolio reply prices several domains the owner runs, distinguished only by
// `website`. That field scopes the reconcile cell key, so if the edit round-trip
// drops it every domain's guest-post cell merges into the contacted site's and
// all but the first are silently discarded (25 offers → 5, seen in production).
test('PATCH /api/replies/:id keeps per-site offers distinct', async () => {
  const h = await start();
  try {
    const reply: Reply = {
      id: 'r2',
      emailId: 'e2',
      rfcMessageId: '<e2@x>',
      fromAddress: 'a@site1.com',
      targetId: 't1',
      matchMethod: 'fromAddress',
      receivedAt: '2026-06-02T00:00:00Z',
      text: 'our network rates',
      extractionStatus: 'done',
      parsed: { canPost: 'yes', optOut: false, offers: [] },
    };
    await h.store.putReply(reply);

    // Same product × niche on three sites — identical but for `website`.
    const updated = await J(`${h.base}/api/replies/r2`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        offers: [
          { postType: 'guest_post', category: 'regular', label: 'Regular', sensitive: false, canPost: 'yes', priceRaw: '$120', website: '' },
          { postType: 'guest_post', category: 'regular', label: 'Regular', sensitive: false, canPost: 'yes', priceRaw: '$180', website: 'turbogeek.org' },
          { postType: 'guest_post', category: 'regular', label: 'Regular', sensitive: false, canPost: 'yes', priceRaw: '$200', website: 'tomoson.com' },
        ],
      }),
    });

    const offers = updated.parsed.offers as Array<{ website?: string; price?: { amount?: number } }>;
    assert.equal(offers.length, 3); // not collapsed to 1
    assert.equal(offers.find((o) => !o.website)?.price?.amount, 120);
    assert.equal(offers.find((o) => o.website === 'turbogeek.org')?.price?.amount, 180);
    assert.equal(offers.find((o) => o.website === 'tomoson.com')?.price?.amount, 200);
  } finally {
    await h.close();
  }
});

// A promo price must coexist with the standing price rather than overwrite it
// (D5) — `isSpecial` scopes the cell key the same way `website` does.
test('PATCH /api/replies/:id keeps a special distinct from the standing price', async () => {
  const h = await start();
  try {
    const reply: Reply = {
      id: 'r3',
      emailId: 'e3',
      rfcMessageId: '<e3@x>',
      fromAddress: 'a@site1.com',
      targetId: 't1',
      matchMethod: 'fromAddress',
      receivedAt: '2026-06-02T00:00:00Z',
      text: 'summer promo',
      extractionStatus: 'done',
      parsed: { canPost: 'yes', optOut: false, offers: [] },
    };
    await h.store.putReply(reply);

    const updated = await J(`${h.base}/api/replies/r3`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        offers: [
          { postType: 'guest_post', category: 'regular', label: 'Regular', sensitive: false, canPost: 'yes', priceRaw: '$120' },
          { postType: 'guest_post', category: 'regular', label: 'Regular', sensitive: false, canPost: 'yes', priceRaw: '$90', isSpecial: true },
        ],
      }),
    });

    const offers = updated.parsed.offers as Array<{ isSpecial?: boolean; price?: { amount?: number } }>;
    assert.equal(offers.length, 2);
    assert.equal(offers.find((o) => !o.isSpecial)?.price?.amount, 120);
    assert.equal(offers.find((o) => o.isSpecial)?.price?.amount, 90);
  } finally {
    await h.close();
  }
});

// The Domains view derives entirely from PriceRecords, so a hand correction that
// only rewrote the reply would leave the price sheet serving the stale figure.
test('PATCH /api/replies/:id re-syncs the price records the Domains view reads', async () => {
  const h = await start();
  try {
    const reply: Reply = {
      id: 'r4',
      emailId: 'e4',
      rfcMessageId: '<e4@x>',
      fromAddress: 'a@site1.com',
      targetId: 't1',
      matchMethod: 'fromAddress',
      receivedAt: '2026-06-02T00:00:00Z',
      text: 'rates',
      extractionStatus: 'done',
      parsed: { canPost: 'yes', optOut: false, offers: [] },
    };
    await h.store.putReply(reply);
    await h.store.putPriceRecord({
      id: 'pr1',
      domain: 'site1.com',
      offers: [{ postType: 'guest_post', category: 'regular', label: 'Regular', sensitive: false, canPost: 'yes', price: { amount: 390, currency: 'USD', raw: '$390' } }],
      observedAt: '2026-06-02T00:00:00Z',
      sourceEmail: 'a@site1.com',
      sourceMessageId: '<e4@x>',
      replyId: 'r4',
      targetId: 't1',
      attribution: 'sender',
    });

    await J(`${h.base}/api/replies/r4`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        offers: [{ postType: 'guest_post', category: 'regular', label: 'Regular', sensitive: false, canPost: 'yes', priceRaw: '$450' }],
      }),
    });

    const records = (await h.store.listPriceRecords()).filter((r) => r.replyId === 'r4');
    assert.equal(records.length, 1); // updated in place, not appended
    assert.equal(records[0]!.id, 'pr1'); // same identity
    assert.equal(records[0]!.observedAt, '2026-06-02T00:00:00Z'); // original observation time kept
    assert.equal(records[0]!.offers[0]?.price?.amount, 450); // the correction landed
  } finally {
    await h.close();
  }
});

// Clearing a price must reach the price sheet too — the case that motivated this:
// a rate we no longer trust should read "can post, price unknown" everywhere.
test('PATCH /api/replies/:id propagates a cleared price into the price record', async () => {
  const h = await start();
  try {
    const reply: Reply = {
      id: 'r5', emailId: 'e5', rfcMessageId: '<e5@x>', fromAddress: 'a@site1.com',
      targetId: 't1', matchMethod: 'fromAddress', receivedAt: '2026-06-02T00:00:00Z',
      text: 'rates', extractionStatus: 'done',
      parsed: { canPost: 'yes', optOut: false, offers: [] },
    };
    await h.store.putReply(reply);

    await J(`${h.base}/api/replies/r5`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        offers: [{ postType: 'guest_post', category: 'casino', label: 'Casino', sensitive: true, canPost: 'yes', priceRaw: '' }],
      }),
    });

    const rec = (await h.store.listPriceRecords()).find((r) => r.replyId === 'r5');
    assert.equal(rec?.offers.length, 1);
    assert.equal(rec?.offers[0]?.price, undefined); // unknown, not stale
    assert.equal(rec?.offers[0]?.canPost, 'yes'); // willingness survives
  } finally {
    await h.close();
  }
});

// Deleting every offer for a site leaves no observation behind it at all.
test('PATCH /api/replies/:id deletes a price record whose offers were all removed', async () => {
  const h = await start();
  try {
    const reply: Reply = {
      id: 'r6', emailId: 'e6', rfcMessageId: '<e6@x>', fromAddress: 'a@site1.com',
      targetId: 't1', matchMethod: 'fromAddress', receivedAt: '2026-06-02T00:00:00Z',
      text: 'rates', extractionStatus: 'done',
      parsed: { canPost: 'yes', optOut: false, offers: [] },
    };
    await h.store.putReply(reply);
    await h.store.putPriceRecord({
      id: 'pr2', domain: 'other.com',
      offers: [{ postType: 'guest_post', category: 'regular', label: 'Regular', sensitive: false, canPost: 'yes', price: { amount: 99, currency: 'USD', raw: '$99' } }],
      observedAt: '2026-06-02T00:00:00Z', sourceEmail: 'a@site1.com',
      sourceMessageId: '<e6@x>', replyId: 'r6', attribution: 'named',
    });

    // The edit keeps only a site1.com offer — other.com is gone.
    await J(`${h.base}/api/replies/r6`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        offers: [{ postType: 'guest_post', category: 'regular', label: 'Regular', sensitive: false, canPost: 'yes', priceRaw: '$50' }],
      }),
    });

    const domains = (await h.store.listPriceRecords()).filter((r) => r.replyId === 'r6').map((r) => r.domain);
    assert.deepEqual(domains, ['site1.com']); // other.com's orphaned record removed
  } finally {
    await h.close();
  }
});

test('POST /api/run/send and /poll invoke the callbacks', async () => {
  const h = await start();
  try {
    const sendReport = await J(`${h.base}/api/run/send`, { method: 'POST' });
    assert.equal(sendReport.sent, 1);
    assert.equal(h.sendCalls(), 1);
    await fetch(`${h.base}/api/run/poll`, { method: 'POST' });
    assert.equal(h.pollCalls(), 1);
  } finally {
    await h.close();
  }
});

test('GET / serves the static web UI', async () => {
  const h = await start();
  try {
    const res = await fetch(`${h.base}/`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /<title>AdScout<\/title>/);
  } finally {
    await h.close();
  }
});

test('static serving refuses path traversal', async () => {
  const h = await start();
  try {
    const res = await fetch(`${h.base}/../package.json`);
    // fetch normalizes ../ in the URL, so this resolves to /package.json → 404,
    // never escaping webDir.
    assert.ok(res.status === 404 || res.status === 403);
  } finally {
    await h.close();
  }
});

test('GET /api/stream delivers change events (SSE)', { timeout: 8000 }, async () => {
  const h = await start();
  const ac = new AbortController();
  try {
    const res = await fetch(`${h.base}/api/stream`, {
      headers: { accept: 'text/event-stream' },
      signal: ac.signal,
    });
    assert.equal(res.headers.get('content-type'), 'text/event-stream; charset=utf-8');
    const reader = res.body!.getReader();
    const dec = new TextDecoder();

    const readUntil = async (needle: string): Promise<string> => {
      let buf = '';
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        if (buf.includes(needle)) return buf;
      }
      return buf;
    };

    await readUntil(': connected'); // subscription is active past this point
    await h.store.putTarget({
      id: 't3',
      batchId: 'b1',
      websiteUrl: 'site3.com',
      contactEmail: 'c@site3.com',
      status: 'pending',
      followUpCount: 0,
      createdAt: '2026-06-01T00:00:00Z',
    });

    const buf = await readUntil('event: change');
    assert.match(buf, /event: change/);
    assert.match(buf, /"type":"target"/);
    assert.match(buf, /"id":"t3"/);
  } finally {
    ac.abort();
    await h.close();
  }
});
