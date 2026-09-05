// Tests for the Gmail incremental history sync in fetchReplies. We stub global
// fetch to route by URL and drive the provider against a real MemoryStore so the
// historyId cursor writes are observable.

import test from 'node:test';
import assert from 'node:assert/strict';

import { MemoryStore } from '../store/memory.store';
import type { Account } from '../../domain/types';
import { GmailApiProvider } from './gmail-api.provider';

function account(overrides: Partial<Account> = {}): Account {
  return {
    id: 'a1',
    email: 'outreach@gmail.com',
    providerType: 'gmail-api',
    credentialRef: 'GMAIL_OUTREACH',
    senderName: 'Vlad',
    status: 'active',
    createdAt: '2026-06-01T00:00:00Z',
    maxDailyLimit: 40,
    // A non-expired access token short-circuits the OAuth refresh network call.
    oauthTokens: {
      refreshToken: 'r',
      accessToken: 'valid',
      accessTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    },
    ...overrides,
  };
}

function gmailMessage(id: string): unknown {
  return {
    id,
    threadId: `thread-${id}`,
    internalDate: '1700000000000',
    payload: {
      mimeType: 'text/plain',
      headers: [
        { name: 'From', value: `Publisher <pub-${id}@example.com>` },
        { name: 'Subject', value: 'Re: your ad' },
        { name: 'Message-ID', value: `<${id}@example.com>` },
      ],
      body: { data: Buffer.from(`body of ${id}`).toString('base64url') },
    },
  };
}

/** Install a fetch stub that routes Gmail REST calls to `routes`, recording the
 *  path of every call so ordering can be asserted. Returns a restore fn + log. */
function stubFetch(routes: {
  profile?: () => { status: number; body: unknown };
  history?: () => { status: number; body: unknown };
  list?: () => { status: number; body: unknown };
  get?: (id: string) => { status: number; body: unknown };
  thread?: (id: string) => { status: number; body: unknown };
}): { restore: () => void; calls: string[] } {
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL) => {
    const url = String(input);
    calls.push(url);
    let r: { status: number; body: unknown };
    if (url.includes('/profile')) r = routes.profile!();
    else if (/\/threads\/[^?]+/.test(url)) {
      const id = url.match(/\/threads\/([^?]+)/)![1];
      r = routes.thread!(id);
    } else if (url.includes('/history')) r = routes.history!();
    else if (/\/messages\/[^?]+/.test(url)) {
      const id = url.match(/\/messages\/([^?]+)/)![1];
      r = routes.get!(id);
    } else if (url.includes('/messages')) r = routes.list!();
    else throw new Error(`unexpected fetch: ${url}`);
    return new Response(JSON.stringify(r.body), { status: r.status });
  }) as typeof fetch;
  return { restore: () => (globalThis.fetch = original), calls };
}

test('fetchReplies: incremental history pull returns only added INBOX messages and advances the cursor', async () => {
  const store = new MemoryStore();
  const acct = account({ pollCursor: { mailbox: 'INBOX', historyId: '100' } });
  await store.putAccount(acct);
  const provider = new GmailApiProvider(store, 'cid', 'secret');

  const { restore } = stubFetch({
    history: () => ({
      status: 200,
      body: {
        history: [
          { messagesAdded: [{ message: { id: 'm1', labelIds: ['INBOX'] } }] },
          // A non-INBOX add (e.g. our own SENT copy) must be ignored.
          { messagesAdded: [{ message: { id: 'm-sent', labelIds: ['SENT'] } }] },
        ],
        historyId: '150',
      },
    }),
    get: (id) => ({ status: 200, body: gmailMessage(id) }),
  });

  try {
    const replies = await provider.fetchReplies(acct);
    assert.equal(replies.length, 1);
    assert.equal(replies[0]!.emailId, 'm1');
    assert.equal(replies[0]!.fromAddress, 'pub-m1@example.com');
  } finally {
    restore();
  }

  const after = await store.getAccount('a1');
  assert.equal(after!.pollCursor!.historyId, '150');
});

// A publisher reply Gmail misclassifies carries SPAM and no INBOX label. The
// history feed must still surface it — real junk is dropped downstream by the
// ignore list + AI isSpam, but a missed reply is lost until the cursor expires.
test('fetchReplies: incremental history pull includes spam-delivered messages', async () => {
  const store = new MemoryStore();
  const acct = account({ pollCursor: { mailbox: 'INBOX', historyId: '100' } });
  await store.putAccount(acct);
  const provider = new GmailApiProvider(store, 'cid', 'secret');

  const { restore, calls } = stubFetch({
    history: () => ({
      status: 200,
      body: {
        history: [
          { messagesAdded: [{ message: { id: 'm-spam', labelIds: ['CATEGORY_PERSONAL', 'SPAM'] } }] },
          { messagesAdded: [{ message: { id: 'm-sent', labelIds: ['SENT'] } }] },
          { messagesAdded: [{ message: { id: 'm-trash', labelIds: ['TRASH'] } }] },
        ],
        historyId: '150',
      },
    }),
    get: (id) => ({ status: 200, body: gmailMessage(id) }),
  });

  try {
    const replies = await provider.fetchReplies(acct);
    assert.deepEqual(
      replies.map((r) => r.emailId),
      ['m-spam'],
    );
    // The server-side labelId=INBOX filter is what hid these; it must be gone.
    const historyCall = calls.find((u) => u.includes('/history'))!;
    assert.ok(!historyCall.includes('labelId'), `history call still filters: ${historyCall}`);
  } finally {
    restore();
  }
});

test('fetchReplies: an expired history cursor (404) falls back to a search resync and reseeds', async () => {
  const store = new MemoryStore();
  const acct = account({ pollCursor: { mailbox: 'INBOX', historyId: '5' } });
  await store.putAccount(acct);
  const provider = new GmailApiProvider(store, 'cid', 'secret');

  const { restore, calls } = stubFetch({
    history: () => ({ status: 404, body: { error: 'historyId too old' } }),
    profile: () => ({ status: 200, body: { historyId: '200' } }),
    list: () => ({ status: 200, body: { messages: [{ id: 'm2' }] } }),
    get: (id) => ({ status: 200, body: gmailMessage(id) }),
  });

  try {
    const replies = await provider.fetchReplies(acct);
    assert.equal(replies.length, 1);
    assert.equal(replies[0]!.emailId, 'm2');
  } finally {
    restore();
  }

  const after = await store.getAccount('a1');
  assert.equal(after!.pollCursor!.historyId, '200');
  // Cursor is seeded from the profile BEFORE the message list is fetched, so a
  // mid-pass arrival is re-covered next time rather than skipped.
  const profileIdx = calls.findIndex((u) => u.includes('/profile'));
  const listIdx = calls.findIndex((u) => u.includes('/messages?') || u.includes('/messages&'));
  assert.ok(profileIdx !== -1 && listIdx !== -1);
  assert.ok(profileIdx < listIdx, 'profile (seed) must precede the list query');
});

test('fetchReplies: first pass with no cursor bootstraps via search and seeds the cursor', async () => {
  const store = new MemoryStore();
  const acct = account(); // no pollCursor
  await store.putAccount(acct);
  const provider = new GmailApiProvider(store, 'cid', 'secret');

  const { restore, calls } = stubFetch({
    profile: () => ({ status: 200, body: { historyId: '10' } }),
    list: () => ({ status: 200, body: { messages: [{ id: 'm3' }] } }),
    get: (id) => ({ status: 200, body: gmailMessage(id) }),
  });

  try {
    const replies = await provider.fetchReplies(acct, new Date('2026-07-01T00:00:00Z'));
    assert.equal(replies.length, 1);
    assert.equal(replies[0]!.emailId, 'm3');
  } finally {
    restore();
  }

  // No /history call should be made when there is no cursor.
  assert.ok(!calls.some((u) => u.includes('/history')));
  const after = await store.getAccount('a1');
  assert.equal(after!.pollCursor!.historyId, '10');
});

// --- fetchThread: the deal-only read path that DOES include our own sent mail --

/** One message as Gmail returns it inside a thread. */
function threadMessage(id: string, from: string, text: string): unknown {
  return {
    id,
    threadId: 'thr1',
    internalDate: '1700000000000',
    payload: {
      mimeType: 'text/plain',
      headers: [
        { name: 'From', value: from },
        { name: 'Subject', value: 'Re: guest post' },
        { name: 'Message-ID', value: `<${id}@mail>` },
      ],
      body: { data: Buffer.from(text).toString('base64url') },
    },
  };
}

test('fetchThread: returns the whole conversation, our own sent messages included', async () => {
  const store = new MemoryStore();
  await store.putAccount(account());
  const provider = new GmailApiProvider(store, 'cid', 'secret');

  const { restore, calls } = stubFetch({
    thread: () => ({
      status: 200,
      body: {
        messages: [
          threadMessage('m1', 'Vlad <outreach@gmail.com>', 'our pitch'),
          threadMessage('m2', 'Anna <anna@site.com>', 'our rate is 180'),
          // Typed in the Gmail app — the message fetchReplies can never see.
          threadMessage('m3', 'Vlad <outreach@gmail.com>', 'we can do 140'),
        ],
      },
    }),
  });

  try {
    const msgs = await provider.fetchThread(account(), 'thr1');
    assert.equal(msgs.length, 3);
    assert.deepEqual(
      msgs.map((m) => m.fromAddress),
      ['outreach@gmail.com', 'anna@site.com', 'outreach@gmail.com'],
      'ours is not filtered out here — that is the whole point',
    );
    assert.equal(msgs[2]!.text.trim(), 'we can do 140');
    assert.equal(msgs[2]!.rfcMessageId, '<m3@mail>', 'the id the caller dedupes on');
    assert.ok(
      calls.every((u) => !u.includes('q=')),
      'read by thread id, never by a mailbox query',
    );
  } finally {
    restore();
  }
});

test('fetchThread: a thread this mailbox no longer has yields nothing, not a throw', async () => {
  const store = new MemoryStore();
  await store.putAccount(account());
  const provider = new GmailApiProvider(store, 'cid', 'secret');

  const { restore } = stubFetch({
    thread: () => ({ status: 404, body: { error: { message: 'Not Found' } } }),
  });

  try {
    assert.deepEqual(await provider.fetchThread(account(), 'gone'), []);
  } finally {
    restore();
  }
});

test('fetchThread: a real transport failure still propagates', async () => {
  const store = new MemoryStore();
  await store.putAccount(account());
  const provider = new GmailApiProvider(store, 'cid', 'secret');

  const { restore } = stubFetch({
    thread: () => ({ status: 500, body: { error: { message: 'backend error' } } }),
  });

  try {
    await assert.rejects(() => provider.fetchThread(account(), 'thr1'));
  } finally {
    restore();
  }
});
