import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../config';
import { MemoryStore } from '../adapters/store/memory.store';
import type { Account, Campaign, Reply, Target } from '../domain/types';
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
  const campaign: Campaign = {
    id: 'c1',
    name: 'casino',
    advertised: { url: 'casinoslists.com', description: 'a casino platform' },
    topic: 'casino',
    format: 'article',
    inquiryFields: [{ key: 'price', question: 'Cost?', type: 'price' }],
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
    campaignId: 'c1',
    websiteUrl: 'site1.com',
    contactEmail: 'a@site1.com',
    status: 'pending',
    followUpCount: 0,
    createdAt: '2026-06-01T00:00:00Z',
  };
  const t2: Target = { ...t1, id: 't2', websiteUrl: 'site2.com', contactEmail: 'b@site2.com', status: 'contacted' };
  return Promise.all([store.putCampaign(campaign), store.putAccount(account), store.putTarget(t1), store.putTarget(t2)]);
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

test('GET /api/campaigns lists campaigns; POST creates one', async () => {
  const h = await start();
  try {
    let cs = await J(`${h.base}/api/campaigns`);
    assert.equal(cs.length, 1);
    const created = await J(`${h.base}/api/campaigns`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'poker', advertised: { url: 'poker.example' } }),
    });
    assert.equal(created.name, 'poker');
    assert.ok(created.id.startsWith('campaign_'));
    cs = await J(`${h.base}/api/campaigns`);
    assert.equal(cs.length, 2);
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
    assert.equal(acc.status, 'warming');
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

test('POST /api/targets queues a target (defaults to the sole campaign)', async () => {
  const h = await start();
  try {
    const t = await J(`${h.base}/api/targets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ websiteUrl: 'new.example', contactEmail: 'hi@new.example' }),
    });
    assert.equal(t.status, 'pending');
    assert.equal(t.campaignId, 'c1');
    assert.equal(t.followUpCount, 0);
    assert.equal((await h.store.listTargets()).length, 3);
  } finally {
    await h.close();
  }
});

test('POST /api/targets rejects an unknown campaignId', async () => {
  const h = await start();
  try {
    const res = await fetch(`${h.base}/api/targets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ websiteUrl: 'x.example', contactEmail: 'a@x.example', campaignId: 'nope' }),
    });
    assert.equal(res.status, 400);
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
      parsed: { canPost: 'maybe', optOut: false, offers: [], fields: { price: { raw: '' } } as never },
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
      campaignId: 'c1',
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
