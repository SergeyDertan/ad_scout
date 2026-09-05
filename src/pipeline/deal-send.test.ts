import test from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig } from '../config';
import { DummyEmailProvider } from '../adapters/email/dummy.provider';
import { MemoryStore } from '../adapters/store/memory.store';
import { sentToday } from '../domain/limits';
import type { Account, Target } from '../domain/types';
import { fixedClock } from '../lib/clock';
import { openDeal, setDealStatus, addDomains, updatePlacement, DealTransitionError } from './deal-ops';
import {
  dealTimeline,
  MissingSubjectError,
  replySubject,
  sendDealMessage,
  threadingHeaders,
} from './deal-send';
import { runSendPass } from './send-pass';

const config = loadConfig({} as NodeJS.ProcessEnv);
const clock = fixedClock(new Date('2026-08-19T12:00:00Z'));

function account(): Account {
  return {
    id: 'acc1', email: 'vlad@example.com', providerType: 'smtp-imap', credentialRef: 'VLAD',
    senderName: 'Vlad', status: 'active', createdAt: '2026-08-01T00:00:00Z', maxDailyLimit: 40,
  };
}

function target(): Target {
  return {
    id: 't1', websiteUrl: 't1.com', contactEmail: 'admin@t1.com',
    status: 'pending', followUpCount: 0, createdAt: '2026-08-01T00:00:00Z',
  };
}

async function withThread() {
  const store = new MemoryStore();
  const email = new DummyEmailProvider();
  await store.putAccount(account());
  await store.putTarget(target());
  await runSendPass({ store, email, clock, config });
  const outreach = (await store.listOutreaches({ targetId: 't1' }))[0]!;
  return { store, email, threadId: outreach.threadId!, initial: outreach };
}

test('threading headers chain oldest-first, replying to the newest message', () => {
  const headers = threadingHeaders([
    { at: '2026-08-02T00:00:00Z', rfcMessageId: '<b@x>' },
    { at: '2026-08-01T00:00:00Z', rfcMessageId: '<a@x>' },
    { at: '2026-08-03T00:00:00Z', rfcMessageId: '<c@x>' },
  ]);
  assert.equal(headers.inReplyTo, '<c@x>');
  assert.deepEqual(headers.references, ['<a@x>', '<b@x>', '<c@x>']);
});

test('a thread with no history yields no headers — the message opens a new one', () => {
  assert.deepEqual(threadingHeaders([]), {});
});

test('a message stored without an rfc id still counts for the subject, not the chain', () => {
  const history = [
    { at: '2026-08-01T00:00:00Z', rfcMessageId: '<a@x>', subject: 'Guest post on t1.com' },
    { at: '2026-08-02T00:00:00Z', subject: 'Re: Guest post on t1.com' },
  ];
  assert.equal(threadingHeaders(history).inReplyTo, '<a@x>', 'the idless message cannot be replied to');
  assert.equal(replySubject(history), 'Re: Guest post on t1.com');
});

test('the reply subject is the newest one, prefixed Re: exactly once', () => {
  assert.equal(
    replySubject([
      { at: '2026-08-01T00:00:00Z', subject: 'Old thread' },
      { at: '2026-08-03T00:00:00Z', subject: 'Guest post on t1.com' },
    ]),
    'Re: Guest post on t1.com',
  );
  assert.equal(
    replySubject([{ at: '2026-08-03T00:00:00Z', subject: 'RE: Guest post' }]),
    'RE: Guest post',
    'an answer to an answer does not stack prefixes',
  );
  assert.equal(replySubject([{ at: '2026-08-03T00:00:00Z' }]), undefined);
  assert.equal(replySubject([]), undefined);
});

test('a deal message replies into the existing thread with proper headers', async () => {
  const { store, email, threadId, initial } = await withThread();
  const deal = await openDeal(store, clock, {
    counterpartyEmail: 'admin@t1.com', accountId: 'acc1', threadIds: [threadId], domains: ['t1.com'],
  });

  const { outreach } = await sendDealMessage({ store, email, clock }, {
    dealId: deal.id,
    subject: 'Re: guest post',
    body: 'Great — here is the draft.',
  });

  const sent = email.sent[email.sent.length - 1]!;
  assert.equal(sent.to, 'admin@t1.com');
  assert.equal(sent.threadId, threadId, 'Gmail needs the threadId as well as the headers');
  assert.equal(sent.inReplyTo, initial.rfcMessageId);
  assert.deepEqual(sent.references, [initial.rfcMessageId]);

  assert.equal(outreach.kind, 'manual');
  assert.equal(outreach.status, 'sent');
  assert.equal(outreach.dealId, deal.id);
  assert.equal(outreach.threadId, threadId, 'stayed in the same thread');
  assert.equal(outreach.targetId, 't1', 'linked to the target we already had for that address');
});

test('a reply with no subject given inherits the thread\'s', async () => {
  const { store, email, threadId, initial } = await withThread();
  const deal = await openDeal(store, clock, {
    counterpartyEmail: 'admin@t1.com', accountId: 'acc1', threadIds: [threadId], domains: ['t1.com'],
  });

  const { outreach } = await sendDealMessage({ store, email, clock }, {
    dealId: deal.id,
    body: 'Great — here is the draft.',
  });

  const expected = `Re: ${initial.subject}`;
  assert.equal(outreach.subject, expected, 'the operator never retypes the line');
  assert.equal(email.sent[email.sent.length - 1]!.subject, expected);
});

test('the first message on a deal with no thread must carry a subject', async () => {
  const { store, email } = await withThread();
  const deal = await openDeal(store, clock, {
    counterpartyEmail: 'stranger@new-site.com', accountId: 'acc1', domains: ['new-site.com'],
  });

  await assert.rejects(
    () => sendDealMessage({ store, email, clock }, { dealId: deal.id, body: 'hello' }),
    MissingSubjectError,
  );
  assert.equal(
    (await store.listOutreaches()).filter((o) => o.dealId === deal.id).length,
    0,
    'rejected before anything was reserved — nothing to clean up',
  );

  const { outreach } = await sendDealMessage({ store, email, clock }, {
    dealId: deal.id, subject: 'Guest post on new-site.com', body: 'hello',
  });
  assert.equal(outreach.subject, 'Guest post on new-site.com');
});

test('the cold sequence still sends NO threading headers', async () => {
  const { email } = await withThread();
  const initial = email.sent[0]!;
  assert.equal(initial.inReplyTo, undefined);
  assert.equal(initial.references, undefined);
  assert.equal(initial.threadId, undefined);
});

test('a manual send counts toward the daily quota but is never gated by it', async () => {
  const { store, email, threadId } = await withThread();
  const deal = await openDeal(store, clock, {
    counterpartyEmail: 'admin@t1.com', accountId: 'acc1', threadIds: [threadId],
  });

  const before = sentToday(await store.listOutreaches(), 'acc1', clock.now());

  // An account with nothing left in the tank must still be able to answer.
  await store.putAccount({ ...account(), dailyLimitOverride: 0 });
  await sendDealMessage({ store, email, clock }, {
    dealId: deal.id, subject: 'Re: guest post', body: 'paid, thanks',
  });

  const after = sentToday(await store.listOutreaches(), 'acc1', clock.now());
  assert.equal(after, before + 1, 'recorded in the same log, so deliverability math is honest');
});

test('opening a deal on an existing conversation holds it straight away', async () => {
  const { store, threadId } = await withThread();
  const deal = await openDeal(store, clock, { counterpartyEmail: 'admin@t1.com', accountId: 'acc1' });
  assert.equal(
    (await store.getThreadLink(threadId))?.dealId,
    deal.id,
    'held from the moment the deal exists — not only once we write',
  );
});

test('a brand-new conversation is held by the send that creates it', async () => {
  const { store, email } = await withThread();
  // Nobody we have ever written to, so there is no thread to adopt.
  const deal = await openDeal(store, clock, {
    counterpartyEmail: 'stranger@new-site.com', accountId: 'acc1', domains: ['new-site.com'],
  });
  assert.deepEqual(await store.listThreadLinks({ dealId: deal.id }), [], 'no thread yet');

  const { threadId } = await sendDealMessage({ store, email, clock }, {
    dealId: deal.id, subject: 'guest post', body: 'are you able to publish?',
  });

  assert.ok(threadId, 'the send created one');
  assert.equal((await store.getThreadLink(threadId!))?.dealId, deal.id, 'and held it');
  const wire = email.sent[email.sent.length - 1]!;
  assert.equal(wire.inReplyTo, undefined, 'nothing to reply to — this opens the conversation');
});

test('opening a deal on an already-held thread returns the existing one', async () => {
  const { store, threadId } = await withThread();
  const first = await openDeal(store, clock, {
    counterpartyEmail: 'admin@t1.com', accountId: 'acc1', threadIds: [threadId], domains: ['t1.com'],
  });
  const second = await openDeal(store, clock, {
    counterpartyEmail: 'admin@t1.com', accountId: 'acc1', threadIds: [threadId], domains: ['other.com'],
  });

  assert.equal(second.id, first.id, 'two open deals must never claim one thread');
  assert.equal((await store.listDeals()).length, 1);
  const domains = (await store.listPlacements({ dealId: first.id })).map((p) => p.domain).sort();
  assert.deepEqual(domains, ['other.com', 't1.com'], 'the second call extended the first deal');
});

test('a CLOSED deal does not absorb a new one on the same thread', async () => {
  const { store, threadId } = await withThread();
  const first = await openDeal(store, clock, {
    counterpartyEmail: 'admin@t1.com', accountId: 'acc1', threadIds: [threadId],
  });
  await setDealStatus(store, clock, first.id, 'done');

  const second = await openDeal(store, clock, {
    counterpartyEmail: 'admin@t1.com', accountId: 'acc1', threadIds: [threadId],
  });
  assert.notEqual(second.id, first.id, 'a new negotiation months later is a new deal');
  assert.equal((await store.getThreadLink(threadId))?.dealId, second.id, 'the thread moved');
});

test('domains are added as draft placements, never duplicated', async () => {
  const store = new MemoryStore();
  await store.putAccount(account());
  const deal = await openDeal(store, clock, {
    counterpartyEmail: 'admin@t1.com', accountId: 'acc1', domains: ['T1.com', 'https://t1.com/'],
  });
  const placements = await store.listPlacements({ dealId: deal.id });
  assert.equal(placements.length, 1, 'the same domain written two ways is one placement');
  assert.equal(placements[0]!.domain, 't1.com');
  assert.equal(placements[0]!.contentText, undefined, 'a committed site with no post yet');

  await addDomains(store, deal.id, ['t1.com']);
  assert.equal((await store.listPlacements({ dealId: deal.id })).length, 1);
});

test('placement edits record paid and published independently', async () => {
  const store = new MemoryStore();
  await store.putAccount(account());
  const deal = await openDeal(store, clock, {
    counterpartyEmail: 'admin@t1.com', accountId: 'acc1', domains: ['t1.com'],
  });
  const p = (await store.listPlacements({ dealId: deal.id }))[0]!;

  const published = await updatePlacement(store, p.id, {
    publishedUrl: 'https://t1.com/post', liveAt: '2026-08-20T00:00:00Z',
  });
  assert.equal(published.paidAt, undefined, 'published first is a legal state');

  const paid = await updatePlacement(store, p.id, {
    paidAt: '2026-08-21T00:00:00Z', paymentMethod: 'wise',
  });
  assert.equal(paid.publishedUrl, 'https://t1.com/post', 'the earlier edit survived');
  assert.equal(paid.paidAt, '2026-08-21T00:00:00Z');
});

test('reopening a deal clears its closing record', async () => {
  const store = new MemoryStore();
  await store.putAccount(account());
  const deal = await openDeal(store, clock, { counterpartyEmail: 'admin@t1.com', accountId: 'acc1' });

  const closed = await setDealStatus(store, clock, deal.id, 'closed', 'went quiet');
  assert.equal(closed.closedReason, 'went quiet');
  assert.ok(closed.closedAt);

  const reopened = await setDealStatus(store, clock, deal.id, 'negotiation');
  assert.equal(reopened.closedReason, undefined);
  assert.equal(reopened.closedAt, undefined, 'a live deal must not carry a closing date');
});

test('an unknown transition is refused rather than silently applied', async () => {
  const store = new MemoryStore();
  await store.putAccount(account());
  const deal = await openDeal(store, clock, { counterpartyEmail: 'admin@t1.com', accountId: 'acc1' });
  await assert.rejects(
    () => setDealStatus(store, clock, deal.id, 'nonsense' as never),
    DealTransitionError,
  );
});

test('the timeline includes the cold outreach that started the conversation', async () => {
  const { store, email, threadId } = await withThread();
  const deal = await openDeal(store, clock, {
    counterpartyEmail: 'admin@t1.com', accountId: 'acc1', threadIds: [threadId],
  });
  await sendDealMessage({ store, email, clock }, {
    dealId: deal.id, subject: 'Re: guest post', body: 'draft attached',
  });

  const items = await dealTimeline(store, deal.id);
  assert.equal(items.length, 2);
  assert.equal(items[0]!.kind, 'sent');
  assert.equal(items[1]!.kind, 'sent');
  const kinds = items.map((i) => (i.kind === 'sent' ? i.outreach.kind : 'reply'));
  assert.deepEqual(kinds, ['initial', 'manual'], 'oldest first, cold pitch included');
});

test('a failed send is recorded as failed rather than lost', async () => {
  const { store, threadId } = await withThread();
  const deal = await openDeal(store, clock, {
    counterpartyEmail: 'admin@t1.com', accountId: 'acc1', threadIds: [threadId],
  });
  const email = new DummyEmailProvider();
  email.send = async () => {
    throw new Error('smtp refused');
  };

  await assert.rejects(() =>
    sendDealMessage({ store, email, clock }, { dealId: deal.id, subject: 's', body: 'b' }),
  );

  const manual = (await store.listOutreaches()).filter((o) => o.kind === 'manual');
  assert.equal(manual.length, 1);
  assert.equal(manual[0]!.status, 'failed');
  assert.equal(manual[0]!.error, 'smtp refused');
});

test('opening a deal adopts the existing conversation with that address', async () => {
  const { store, email, threadId } = await withThread();

  // No threadIds given — the flow a person actually uses: pick the site, write.
  const deal = await openDeal(store, clock, {
    counterpartyEmail: 'admin@t1.com', accountId: 'acc1', domains: ['t1.com'],
  });

  assert.equal((await store.getThreadLink(threadId))?.dealId, deal.id, 'found the cold thread');

  await sendDealMessage({ store, email, clock }, {
    dealId: deal.id, subject: 'Re: guest post', body: 'ready to go ahead',
  });
  const wire = email.sent[email.sent.length - 1]!;
  assert.equal(wire.threadId, threadId, 'replied into the conversation, not a new one');
  assert.ok(wire.inReplyTo);
});

test('a reply from a DIFFERENT mailbox still identifies the conversation', async () => {
  const { store, email, threadId } = await withThread();
  // The publisher answered from an address we never wrote to.
  await store.putReply({
    id: 'r1', emailId: 'e1', threadId, rfcMessageId: '<pub@x>',
    fromAddress: 'billing@t1.com', matchMethod: 'threadId',
    receivedAt: '2026-08-18T09:00:00Z', text: '$120 per post', extractionStatus: 'done',
  });

  const deal = await openDeal(store, clock, { counterpartyEmail: 'billing@t1.com', accountId: 'acc1' });
  assert.equal((await store.getThreadLink(threadId))?.dealId, deal.id);
  assert.equal(email.sent.length, 1, 'nothing sent by opening a deal');
});

// Both of these are drawn from a real case: contact@imediaone.com was pitched
// from two mailboxes — an older thread where they sent a rate card, and a newer
// cold pitch they ignored.
test('thread discovery ignores threads that live in another mailbox', async () => {
  const { store, threadId } = await withThread();
  // A second account pitched the same publisher, more recently, and got nothing.
  await store.putAccount({ ...account(), id: 'acc2', email: 'other@example.com' });
  await store.putTarget({ ...target(), id: 't2', assignedAccountId: 'acc2' });
  await store.putOutreach({
    id: 'o2', targetId: 't2', accountId: 'acc2', kind: 'initial', sequenceNo: 0,
    status: 'sent', rfcMessageId: '<o2@x>', threadId: 'thread-in-acc2',
    subject: 'guest post', body: '…', reservedAt: '2026-08-11T06:00:00Z',
    sentAt: '2026-08-11T06:00:00Z', attempts: 1,
  });

  const deal = await openDeal(store, clock, { counterpartyEmail: 'admin@t1.com', accountId: 'acc1' });
  const linked = (await store.listThreadLinks({ dealId: deal.id })).map((l) => l.threadId);

  assert.deepEqual(linked, [threadId], 'a per-mailbox threadId is unusable from another account');
});

test('the thread they ANSWERED wins over a more recent one they ignored', async () => {
  const { store, email, threadId } = await withThread();
  // They replied on the original thread…
  await store.putReply({
    id: 'r1', emailId: 'e1', threadId, rfcMessageId: '<their-quote@x>',
    fromAddress: 'admin@t1.com', accountId: 'acc1', matchMethod: 'threadId',
    receivedAt: '2026-08-19T13:22:10.000Z', text: 'our rate is $250', extractionStatus: 'done',
  });
  // …then a LATER cold pitch on a second thread went unanswered.
  await store.putOutreach({
    id: 'o2', targetId: 't1', accountId: 'acc1', kind: 'initial', sequenceNo: 0,
    status: 'sent', rfcMessageId: '<later@x>', threadId: 'ignored-thread',
    subject: 'guest post', body: '…', reservedAt: '2026-08-20T06:00:00Z',
    sentAt: '2026-08-20T06:00:00Z', attempts: 1,
  });

  const deal = await openDeal(store, clock, { counterpartyEmail: 'admin@t1.com', accountId: 'acc1' });
  assert.equal((await store.listThreadLinks({ dealId: deal.id })).length, 2, 'both adopted');

  await sendDealMessage({ store, email, clock }, {
    dealId: deal.id, subject: 'Re: guest post', body: 'about that $250…',
  });
  const wire = email.sent[email.sent.length - 1]!;
  assert.equal(wire.threadId, threadId, 'replied where they actually have context');
  assert.equal(wire.inReplyTo, '<their-quote@x>', 'as a reply to their own message');
});
