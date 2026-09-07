import test from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig } from '../config';
import { DummyEmailProvider } from '../adapters/email/dummy.provider';
import { MemoryStore } from '../adapters/store/memory.store';
import { sentToday } from '../domain/limits';
import type { Account, Target } from '../domain/types';
import { fixedClock } from '../lib/clock';
import { openDeal, setDealStatus } from './deal-ops';
import { dealTimeline, sendDealMessage } from './deal-send';
import { syncDealThreads } from './deal-thread-sync';
import { runSendPass } from './send-pass';

const config = loadConfig({} as NodeJS.ProcessEnv);
const clock = fixedClock(new Date('2026-08-19T12:00:00Z'));

function account(): Account {
  return {
    id: 'acc1', email: 'vlad@example.com', providerType: 'gmail-api', credentialRef: 'VLAD',
    senderName: 'Vlad', status: 'active', createdAt: '2026-08-01T00:00:00Z', maxDailyLimit: 40,
  };
}
function target(): Target {
  return {
    id: 't1', websiteUrl: 't1.com', contactEmail: 'admin@t1.com',
    status: 'pending', followUpCount: 0, createdAt: '2026-08-01T00:00:00Z',
  };
}

/** An account, a target, one cold outreach — so there is a real thread. */
async function withDeal() {
  const store = new MemoryStore();
  const email = new DummyEmailProvider();
  await store.putAccount(account());
  await store.putTarget(target());
  await runSendPass({ store, email, clock, config });
  const threadId = (await store.listOutreaches({ targetId: 't1' }))[0]!.threadId!;
  const deal = await openDeal(store, clock, {
    counterpartyEmail: 'admin@t1.com', accountId: 'acc1', threadIds: [threadId], domains: ['t1.com'],
  });
  return { store, email, threadId, deal };
}

test('a message sent from the mail client lands on the deal timeline', async () => {
  const { store, email, threadId, deal } = await withDeal();

  // The polling path cannot see this: it is in the mailbox, never in the inbox.
  email.injectSent({
    threadId,
    fromAddress: 'vlad@example.com',
    subject: 'Re: guest post',
    text: 'Sending payment today.',
    receivedAt: new Date('2026-08-19T09:30:00Z'),
  });
  assert.equal((await email.fetchReplies(account())).length, 0, 'not inbound — nothing to poll');

  const report = await syncDealThreads({ store, email });
  assert.equal(report.dealMessages, 1);

  const timeline = await dealTimeline(store, deal.id);
  const adopted = timeline.find(
    (i) => i.kind === 'sent' && i.outreach.body === 'Sending payment today.',
  );
  assert.ok(adopted, 'it shows as ours in the conversation');
  assert.equal(adopted.kind === 'sent' && adopted.outreach.kind, 'manual');
  assert.equal(adopted.kind === 'sent' && adopted.outreach.status, 'sent');
  assert.equal(adopted.kind === 'sent' && adopted.outreach.threadId, threadId);
  assert.equal(
    adopted.kind === 'sent' && adopted.outreach.targetId,
    't1',
    'tied to the target we already had for that address',
  );
});

test('running twice adopts nothing the second time', async () => {
  const { store, email, threadId } = await withDeal();
  email.injectSent({ threadId, fromAddress: 'vlad@example.com', text: 'first' });

  assert.equal((await syncDealThreads({ store, email })).dealMessages, 1);
  assert.equal((await syncDealThreads({ store, email })).dealMessages, 0, 'idempotent on Message-Id');
  assert.equal(
    (await store.listOutreaches()).filter((o) => o.body === 'first').length,
    1,
  );
});

test('our own sends are recognised, not adopted a second time', async () => {
  const { store, email, deal } = await withDeal();
  await sendDealMessage({ store, email, clock }, { dealId: deal.id, body: 'from the Deals view' });

  const before = (await store.listOutreaches()).length;
  const report = await syncDealThreads({ store, email });

  assert.equal(report.dealMessages, 0, 'the Message-Id is one we generated');
  assert.equal((await store.listOutreaches()).length, before);
});

test("the publisher's own messages are left to the poll pass", async () => {
  const { store, email, threadId } = await withDeal();
  // Present on the thread, but inbound: it must arrive through fetchReplies, with
  // the hold and the AS/Deal label that path applies — not as an Outreach here.
  email.injectReply({ threadId, fromAddress: 'admin@t1.com', text: '150 EUR' });

  const report = await syncDealThreads({ store, email });
  assert.equal(report.dealMessages, 0);
  assert.equal((await store.listReplies()).length, 0, 'this pass never writes replies');
});

test('a closed deal is not read at all', async () => {
  const { store, email, threadId, deal } = await withDeal();
  email.injectSent({ threadId, fromAddress: 'vlad@example.com', text: 'after the fact' });
  await setDealStatus(store, clock, deal.id, 'closed', 'done');

  const report = await syncDealThreads({ store, email });
  assert.equal(report.threads, 0, 'no thread was even fetched');
  assert.equal(report.dealMessages, 0);
});

test('a paused mailbox is left alone', async () => {
  const { store, email, threadId } = await withDeal();
  email.injectSent({ threadId, fromAddress: 'vlad@example.com', text: 'hi' });
  await store.putAccount({ ...account(), status: 'paused' });

  assert.equal((await syncDealThreads({ store, email })).dealMessages, 0);
});

test('a thread we cannot read fails that thread, not the pass', async () => {
  const { store, email, threadId } = await withDeal();
  email.injectSent({ threadId, fromAddress: 'vlad@example.com', text: 'hi' });
  const broken = {
    ...email,
    fetchThread: async () => {
      throw new Error('gmail is down');
    },
  } as unknown as DummyEmailProvider;

  const report = await syncDealThreads({ store, email: broken });
  assert.deepEqual(report, { threads: 0, dealMessages: 0 }, 'reported empty, not thrown');
});

test('a hand-sent message counts toward the day it was actually sent', async () => {
  const { store, email, threadId } = await withDeal();
  const before = sentToday(await store.listOutreaches(), 'acc1', clock.now());

  // Sent today: deliverability is physical, so the mailbox really did spend it.
  email.injectSent({
    threadId, fromAddress: 'vlad@example.com', text: 'today',
    receivedAt: new Date('2026-08-19T08:00:00Z'),
  });
  // Sent last week: backfilling history must not eat today's quota.
  email.injectSent({
    threadId, fromAddress: 'vlad@example.com', text: 'last week',
    receivedAt: new Date('2026-08-12T08:00:00Z'),
  });
  await syncDealThreads({ store, email });

  assert.equal(sentToday(await store.listOutreaches(), 'acc1', clock.now()), before + 1);
});

test('a deal on a domain we never targeted adopts without a target', async () => {
  const store = new MemoryStore();
  const email = new DummyEmailProvider();
  await store.putAccount(account());
  const deal = await openDeal(store, clock, {
    counterpartyEmail: 'stranger@new-site.com', accountId: 'acc1', domains: ['new-site.com'],
  });
  // A conversation that only ever existed in the mail client.
  await store.putThreadLink({ id: 'thr-hand', threadId: 'thr-hand', dealId: deal.id });
  email.injectSent({ threadId: 'thr-hand', fromAddress: 'vlad@example.com', text: 'hello' });

  assert.equal((await syncDealThreads({ store, email })).dealMessages, 1);
  const [adopted] = (await store.listOutreaches()).filter((o) => o.dealId === deal.id);
  assert.equal(adopted!.targetId, undefined);
});

/* ---------- the Message-Id we set is not the one that comes back ---------- */

test('a send whose Message-Id Gmail replaced is recognised, not adopted', async () => {
  const { store, email, deal } = await withDeal();
  const { outreach } = await sendDealMessage(
    { store, email, clock },
    { dealId: deal.id, body: 'from the Deals view' },
  );

  // The premise: what the mailbox holds is NOT what we asked for. Gmail assigns
  // its own Message-Id on send, so matching on ours can only ever miss.
  const inMailbox = await email.fetchThread(account(), outreach.threadId!);
  const copy = inMailbox.find((m) => m.text === 'from the Deals view');
  assert.ok(copy, 'the mailbox has our message');
  assert.notEqual(copy.rfcMessageId, outreach.rfcMessageId, 'the id was rewritten');

  // What makes it recognisable is the provider's own id, recorded at send.
  assert.equal(outreach.emailId, copy.emailId, "the send recorded Gmail's id");

  const before = (await store.listOutreaches()).length;
  assert.equal((await syncDealThreads({ store, email })).dealMessages, 0);
  assert.equal((await store.listOutreaches()).length, before, 'no second copy');
});

test('an outreach written before emailId existed is still recognised', async () => {
  const { store, email, threadId, deal } = await withDeal();
  // A row as ~5.4k of them actually sit in production: our own generated
  // Message-Id, which Gmail discarded, and no emailId at all.
  await store.putOutreach({
    id: 'outreach_legacy',
    dealId: deal.id,
    accountId: 'acc1',
    kind: 'manual',
    sequenceNo: 0,
    status: 'sent',
    rfcMessageId: '<legacy@adscout.local>',
    threadId,
    subject: 'Re: guest post',
    body: 'We can do 150 EUR for the guest post.',
    reservedAt: '2026-08-19T09:30:00.000Z',
    sentAt: '2026-08-19T09:30:00.000Z',
    attempts: 1,
  });
  // The same message as the mailbox holds it: different id, seconds later.
  email.injectSent({
    threadId,
    fromAddress: 'vlad@example.com',
    rfcMessageId: '<CAKjX6WY@mail.gmail.com>',
    text: 'We can do 150 EUR for the guest post.\n',
    receivedAt: new Date('2026-08-19T09:30:03Z'),
  });

  assert.equal((await syncDealThreads({ store, email })).dealMessages, 0);
});

test('the same words sent again later are a real message, not a duplicate', async () => {
  const { store, email, threadId, deal } = await withDeal();
  await store.putOutreach({
    id: 'outreach_legacy', dealId: deal.id, accountId: 'acc1', kind: 'manual',
    sequenceNo: 0, status: 'sent', rfcMessageId: '<legacy@adscout.local>', threadId,
    subject: 'Re: guest post', body: 'Any update?',
    reservedAt: '2026-08-16T09:30:00.000Z', sentAt: '2026-08-16T09:30:00.000Z', attempts: 1,
  });
  // Three days on, chasing again. Same text — and a message in its own right.
  email.injectSent({
    threadId, fromAddress: 'vlad@example.com', text: 'Any update?',
    receivedAt: new Date('2026-08-19T09:30:00Z'),
  });

  assert.equal((await syncDealThreads({ store, email })).dealMessages, 1);
});
