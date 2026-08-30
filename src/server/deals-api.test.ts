import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';

import { loadConfig } from '../config';
import { DummyEmailProvider } from '../adapters/email/dummy.provider';
import { MemoryStore } from '../adapters/store/memory.store';
import type { Account, Target } from '../domain/types';
import { fixedClock } from '../lib/clock';
import { runSendPass } from '../pipeline/send-pass';
import { createApiServer, type ServerDeps } from './app';

const config = loadConfig({} as NodeJS.ProcessEnv);
const clock = fixedClock(new Date('2026-08-19T12:00:00Z'));

async function J(url: string, init?: RequestInit): Promise<any> {
  return (await fetch(url, init)).json();
}
function post(url: string, body: unknown): RequestInit {
  return { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}
function patch(body: unknown): RequestInit {
  return { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

async function start() {
  const store = new MemoryStore();
  const email = new DummyEmailProvider();
  const account: Account = {
    id: 'a1', email: 'vlad@example.com', providerType: 'smtp-imap', credentialRef: 'VLAD',
    senderName: 'Vlad', status: 'active', createdAt: '2026-08-01T00:00:00Z', maxDailyLimit: 40,
  };
  const target: Target = {
    id: 't1', websiteUrl: 'site1.com', contactEmail: 'admin@site1.com',
    status: 'pending', followUpCount: 0, createdAt: '2026-08-01T00:00:00Z',
  };
  await store.putAccount(account);
  await store.putTarget(target);
  // A real cold outreach, so there is a genuine thread to negotiate in.
  await runSendPass({ store, email, clock, config });
  const threadId = (await store.listOutreaches({ targetId: 't1' }))[0]!.threadId!;

  const deps: ServerDeps = {
    store, config, clock, email,
    runSend: async () => ({}), runPoll: async () => ({}), runFetch: async () => ({}),
  };
  const server = createApiServer(deps);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    store,
    email,
    threadId,
    close: () =>
      new Promise<void>((resolve) => {
        (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

test('a deal can be opened, listed, and read back with its timeline', async () => {
  const h = await start();
  try {
    const created = await J(`${h.base}/api/deals`, post('', {
      counterpartyEmail: 'Admin@Site1.com',
      accountId: 'a1',
      threadIds: [h.threadId],
      domains: ['site1.com'],
    }));
    assert.equal(created.status, 'negotiation');
    assert.equal(created.counterpartyEmail, 'admin@site1.com', 'normalized on the way in');

    const list = await J(`${h.base}/api/deals`);
    assert.equal(list.length, 1);
    assert.deepEqual(list[0].domains, ['site1.com'], 'domains derived from placements');
    assert.equal(list[0].placementCount, 1);
    assert.equal(list[0].paidCount, 0);

    const detail = await J(`${h.base}/api/deals/${created.id}`);
    assert.equal(detail.deal.id, created.id);
    assert.equal(detail.placements.length, 1);
    assert.deepEqual(detail.threadIds, [h.threadId]);
    assert.equal(detail.timeline.length, 1, 'the cold outreach that started it');
    assert.equal(detail.timeline[0].kind, 'sent');
  } finally {
    await h.close();
  }
});

test('opening a deal requires a real account', async () => {
  const h = await start();
  try {
    const bad = await J(`${h.base}/api/deals`, post('', { counterpartyEmail: 'x@y.com', accountId: 'nope' }));
    assert.match(bad.error, /account not found/);
    const missing = await J(`${h.base}/api/deals`, post('', { accountId: 'a1' }));
    assert.match(missing.error, /counterpartyEmail/);
  } finally {
    await h.close();
  }
});

test('posting a message sends it, threads it, and holds the conversation', async () => {
  const h = await start();
  try {
    const deal = await J(`${h.base}/api/deals`, post('', {
      counterpartyEmail: 'admin@site1.com', accountId: 'a1', threadIds: [h.threadId], domains: ['site1.com'],
    }));

    const sent = await J(`${h.base}/api/deals/${deal.id}/messages`, post('', {
      subject: 'Re: guest post', body: 'Here is the draft.',
    }));
    assert.equal(sent.outreach.kind, 'manual');
    assert.equal(sent.threadId, h.threadId);

    const wire = h.email.sent[h.email.sent.length - 1]!;
    assert.ok(wire.inReplyTo, 'threaded as a reply, not a new email');
    assert.equal(wire.threadId, h.threadId);

    assert.equal((await h.store.getThreadLink(h.threadId))?.dealId, deal.id, 'thread held');
  } finally {
    await h.close();
  }
});

test('a placement records content, price, paid and published independently', async () => {
  const h = await start();
  try {
    const deal = await J(`${h.base}/api/deals`, post('', {
      counterpartyEmail: 'admin@site1.com', accountId: 'a1', domains: ['site1.com'],
    }));
    const p = (await J(`${h.base}/api/deals/${deal.id}`)).placements[0];

    const withPost = await J(`${h.base}/api/placements/${p.id}`, patch({
      contentUrl: 'https://docs.google.com/doc/abc',
      agreedPrice: '120 EUR',
    }));
    assert.equal(withPost.contentUrl, 'https://docs.google.com/doc/abc');
    assert.equal(withPost.agreedPrice.amount, 120);
    assert.equal(withPost.agreedPrice.currency, 'EUR');
    assert.equal(withPost.agreedPrice.raw, '120 EUR', 'keeps exactly what was typed');

    const live = await J(`${h.base}/api/placements/${p.id}`, patch({
      publishedUrl: 'https://site1.com/post', liveAt: '2026-08-20T00:00:00Z',
    }));
    assert.equal(live.paidAt, undefined, 'published before paid is fine');
    assert.equal(live.agreedPrice.amount, 120, 'earlier fields survive a partial patch');

    // The agreed price must never leak into the price history.
    assert.deepEqual(await h.store.listPriceRecords(), []);
  } finally {
    await h.close();
  }
});

test('status moves are validated and closing records a reason', async () => {
  const h = await start();
  try {
    const deal = await J(`${h.base}/api/deals`, post('', {
      counterpartyEmail: 'admin@site1.com', accountId: 'a1',
    }));

    const bad = await fetch(`${h.base}/api/deals/${deal.id}`, patch({ status: 'banana' }));
    assert.equal(bad.status, 400);

    const closed = await J(`${h.base}/api/deals/${deal.id}`, patch({
      status: 'closed', closedReason: 'went quiet',
    }));
    assert.equal(closed.status, 'closed');
    assert.equal(closed.closedReason, 'went quiet');
  } finally {
    await h.close();
  }
});

test('deleting a deal releases its threads but keeps the messages', async () => {
  const h = await start();
  try {
    const deal = await J(`${h.base}/api/deals`, post('', {
      counterpartyEmail: 'admin@site1.com', accountId: 'a1', threadIds: [h.threadId], domains: ['site1.com'],
    }));
    const outreachesBefore = (await h.store.listOutreaches()).length;

    await J(`${h.base}/api/deals/${deal.id}`, { method: 'DELETE' });

    assert.equal(await h.store.getDeal(deal.id), undefined);
    assert.equal(await h.store.getThreadLink(h.threadId), undefined, 'thread released');
    assert.deepEqual(await h.store.listPlacements({ dealId: deal.id }), []);
    assert.equal((await h.store.listOutreaches()).length, outreachesBefore, 'correspondence kept');
  } finally {
    await h.close();
  }
});

test('every payload names our own mailbox, not just theirs', async () => {
  const h = await start();
  try {
    const deal = await J(`${h.base}/api/deals`, post('', {
      counterpartyEmail: 'admin@site1.com', accountId: 'a1', threadIds: [h.threadId],
    }));

    const list = await J(`${h.base}/api/deals`);
    assert.equal(list[0].accountEmail, 'vlad@example.com', 'deal list');

    const detail = await J(`${h.base}/api/deals/${deal.id}`);
    assert.equal(detail.accountEmail, 'vlad@example.com', 'deal detail');

    const thread = await J(`${h.base}/api/targets/t1/thread`);
    assert.equal(thread.accountEmails['a1'], 'vlad@example.com', 'target thread');

    const responses = await J(`${h.base}/api/responses`);
    for (const r of responses) {
      assert.ok(r.accountEmail, `response ${r.id} must say which mailbox it landed in`);
    }
  } finally {
    await h.close();
  }
});
