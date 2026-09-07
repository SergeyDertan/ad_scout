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

// --- Outgoing MIME ----------------------------------------------------------

/** Capture the raw message a send would put on the wire, decoded back to text. */
async function rawOf(msg: Parameters<GmailApiProvider['send']>[0]): Promise<string> {
  const store = new MemoryStore();
  await store.putAccount(msg.account);
  const provider = new GmailApiProvider(store, 'cid', 'secret');
  const original = globalThis.fetch;
  let raw = '';
  globalThis.fetch = (async (_input: string | URL, init?: RequestInit) => {
    raw = (JSON.parse(String(init!.body)) as { raw: string }).raw;
    return new Response(JSON.stringify({ id: 'm1', threadId: 't1' }), { status: 200 });
  }) as typeof fetch;
  try {
    await provider.send(msg);
  } finally {
    globalThis.fetch = original;
  }
  return Buffer.from(raw, 'base64url').toString('utf8');
}

function outgoing(attachments?: Array<{ filename: string; mimeType: string; content: Buffer }>) {
  return {
    to: 'admin@t1.com',
    subject: 'Re: guest post',
    body: 'Here is what I meant.',
    rfcMessageId: '<own@adscout>',
    account: account(),
    ...(attachments
      ? {
          attachments: attachments.map((a) => ({
            filename: a.filename,
            mimeType: a.mimeType,
            size: a.content.length,
            contentBase64: a.content.toString('base64'),
          })),
        }
      : {}),
  };
}

// The cold sequence goes down this path on every send. A message with no files
// must therefore be built exactly as it was before attachments existed — not
// "equivalently", but as a single text/plain part with no boundary in sight.
test('a message with no attachments is still a plain single-part message', async () => {
  const raw = await rawOf(outgoing());
  assert.match(raw, /^Content-Type: text\/plain; charset=utf-8$/m);
  assert.doesNotMatch(raw, /multipart/);
  assert.doesNotMatch(raw, /Content-Disposition/);
  assert.match(raw, /Here is what I meant\./);
});

test('attachments make the message multipart, with the text first and the file intact', async () => {
  const png = Buffer.from('89504e470d0a1a0a' + '00'.repeat(120), 'hex');
  const raw = await rawOf(outgoing([{ filename: 'shot.png', mimeType: 'image/png', content: png }]));

  const boundary = raw.match(/boundary="([^"]+)"/)?.[1];
  assert.ok(boundary, 'the multipart header names a boundary');
  assert.match(raw, /^Content-Type: multipart\/mixed; /m);
  assert.equal(raw.split(`--${boundary}`).length - 1, 3, 'two parts, then the closing delimiter');
  assert.ok(raw.trimEnd().endsWith(`--${boundary}--`), 'the message ends with the closing delimiter');

  // The text part comes first: mail clients show it as the message.
  assert.ok(
    raw.indexOf('text/plain') < raw.indexOf('image/png'),
    'the body is the first part',
  );
  assert.match(raw, /Content-Disposition: attachment; filename="shot\.png"/);

  // The bytes survive: pull the last part's base64 back out and compare.
  const parts = raw.split(`--${boundary}`);
  const filePart = parts[2]!;
  const encoded = filePart.slice(filePart.indexOf('\r\n\r\n') + 4).trim();
  assert.deepEqual(Buffer.from(encoded, 'base64'), png, 'the file arrives byte for byte');
  assert.ok(
    encoded.split('\r\n').every((line) => line.length <= 76),
    'base64 is wrapped at the 76 columns RFC 2045 allows',
  );
});

// An encoded-word is not legal in a parameter value, so a non-ASCII name must
// take RFC 2231's filename* form rather than the =?utf-8?B?…?= used for Subject.
test('a non-ASCII filename is encoded as an RFC 2231 parameter', async () => {
  const raw = await rawOf(
    outgoing([{ filename: 'скриншот.png', mimeType: 'image/png', content: Buffer.from('x') }]),
  );
  assert.match(raw, /Content-Disposition: attachment; filename\*=utf-8''/);
  assert.doesNotMatch(raw, /filename="скриншот/, 'never raw UTF-8 in a quoted parameter');
  assert.doesNotMatch(raw, /filename="=\?/, 'and never a Subject-style encoded word');
});

// A header is not a place to accept whatever the client typed: a mimeType with a
// newline in it could inject a header of its own.
test('a malformed mime type falls back to the generic one', async () => {
  const raw = await rawOf(
    outgoing([
      { filename: 'x.bin', mimeType: 'image/png\r\nBcc: someone@else.com', content: Buffer.from('x') },
    ]),
  );
  assert.match(raw, /Content-Type: application\/octet-stream/);
  assert.doesNotMatch(raw, /Bcc:/);
});

// A header line has a hard 998-character limit, and percent-encoding costs up to
// nine characters per character — so the budget belongs to the ENCODED name.
test('a long non-ASCII filename is trimmed to keep the header legal, extension and all', async () => {
  const raw = await rawOf(
    outgoing([
      { filename: `${'счёт'.repeat(80)}.pdf`, mimeType: 'application/pdf', content: Buffer.from('x') },
    ]),
  );
  const line = raw.split('\r\n').find((l) => l.startsWith('Content-Disposition'))!;
  assert.ok(line.length < 998, `header line is ${line.length} characters`);
  assert.match(line, /\.pdf$/, 'and still says what kind of file it is');
});
