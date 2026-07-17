import test from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig } from '../config';
import { DummyEmailProvider } from '../adapters/email/dummy.provider';
import { DummyLlmProvider } from '../adapters/llm/dummy.provider';
import { MemoryStore } from '../adapters/store/memory.store';
import type { Account, Batch, Outreach, Target } from '../domain/types';
import type { IncomingEmail } from '../ports/email-provider';
import { fixedClock } from '../lib/clock';
import { Extractor } from '../services/extractor';
import { runPollPass } from '../pipeline/poll-pass';
import { runSendPass } from '../pipeline/send-pass';
import { refetchReplies } from './refetch-replies';

const config = loadConfig({} as NodeJS.ProcessEnv);
const clock = fixedClock(new Date('2026-06-19T12:00:00Z'));

async function seed(store: MemoryStore) {
  const batch: Batch = {
    id: 'batch1',
    name: 'casino import',
    source: 'import',
    createdAt: '2026-05-01T00:00:00Z',
  };
  const acc: Account = {
    id: 'acc1',
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
    batchId: 'batch1',
    websiteUrl: 't1.com',
    contactEmail: 'info@t1.com',
    status: 'pending',
    followUpCount: 0,
    createdAt: '2026-06-01T00:00:00Z',
  };
  await store.putBatch(batch);
  await store.putAccount(acc);
  await store.putTarget(t1);
}

test('refetch-replies deletes the reply, rewinds the cursor, and re-ingests it (defeating dedup)', async () => {
  const store = new MemoryStore();
  const email = new DummyEmailProvider();
  const extractor = new Extractor(new DummyLlmProvider());
  await seed(store);
  await runSendPass({ store, email, clock, config });
  const outreach = (await store.listOutreaches({ targetId: 't1' }))[0];

  const injected = email.injectReply({
    threadId: outreach.threadId!,
    fromAddress: 'info@t1.com',
    text: 'Yes, $120 per casino post.',
    receivedAt: new Date('2026-06-19T12:30:00Z'),
  });
  await runPollPass({ store, email, extractor, clock, config });

  const before = await store.listReplies();
  assert.equal(before.length, 1);
  const originalReplyId = before[0].id;
  assert.equal((await store.getTarget('t1'))?.status, 'replied');

  // The mailbox still has the message (real IMAP/Gmail don't delete on read);
  // the dummy drains, so re-queue the same emailId to simulate that.
  (email as unknown as { inbox: IncomingEmail[] }).inbox.push(injected);

  const result = await refetchReplies({ store, email, extractor, clock, config });

  assert.equal(result.removed, 1);
  assert.equal(result.targetsReset, 1);
  // Re-fetched and re-extracted (NOT deduped away): 1 fetched, 1 matched.
  assert.equal(result.report?.fetched, 1);
  assert.equal(result.report?.deduped, 0);
  assert.equal(result.report?.matched, 1);

  const after = await store.listReplies();
  assert.equal(after.length, 1); // re-created
  assert.notEqual(after[0].id, originalReplyId); // fresh record
  assert.equal(after[0].emailId, injected.emailId); // same source email
  assert.equal(after[0].extractionStatus, 'done');
  // Cursor was rolled back to before the reply, then re-advanced by the poll.
  assert.ok(result.cursorRolledBackTo);
  assert.ok(new Date(result.cursorRolledBackTo!) < new Date(injected.receivedAt));
});

test('refetch-replies anchors the cursor on our earliest outreach, not a stray older inbound', async () => {
  const store = new MemoryStore();
  const email = new DummyEmailProvider();
  const extractor = new Extractor(new DummyLlmProvider());
  await seed(store);
  await runSendPass({ store, email, clock, config });
  const outreach = (await store.listOutreaches({ targetId: 't1' }))[0];

  // A real reply on our thread…
  email.injectReply({
    threadId: outreach.threadId!,
    fromAddress: 'info@t1.com',
    text: 'Yes.',
    receivedAt: new Date('2026-06-19T12:30:00Z'),
  });
  // …plus a stray/unmatched inbound that predates the app by a year (e.g. an old
  // newsletter swept into replies). It must NOT drag the cursor back to 2025.
  await store.putReply({
    id: 'r-stray',
    emailId: 'e-stray',
    rfcMessageId: '<stray@x>',
    fromAddress: 'newsletter@somewhere.com',
    matchMethod: 'unmatched',
    receivedAt: '2025-07-17T00:00:00Z',
    text: 'old newsletter',
    extractionStatus: 'done',
  });
  await runPollPass({ store, email, extractor, clock, config });

  const result = await refetchReplies({ store, email, extractor, clock, config }, { dryRun: true });
  // Cursor floored at the outreach send time (~12:00), not rewound to the 2025 stray.
  assert.ok(new Date(result.cursorRolledBackTo!) >= new Date('2026-06-19T11:00:00Z'));
  assert.ok(new Date(result.cursorRolledBackTo!) <= new Date(outreach.sentAt ?? outreach.reservedAt));
});

test('refetch-replies rolls each account cursor back to its OWN earliest send', async () => {
  const store = new MemoryStore();
  const email = new DummyEmailProvider();
  const extractor = new Extractor(new DummyLlmProvider());
  await seed(store); // seeds acc1
  const acc2: Account = {
    id: 'acc2',
    email: 'nick@example.com',
    providerType: 'smtp-imap',
    credentialRef: 'NICK',
    senderName: 'Nick',
    status: 'active',
    createdAt: '2026-05-01T00:00:00Z',
    maxDailyLimit: 40,
  };
  await store.putAccount(acc2);

  const outreach = (accountId: string, sentAt: string): Outreach => ({
    id: `o-${accountId}`,
    targetId: 't1',
    accountId,
    kind: 'initial',
    sequenceNo: 0,
    status: 'sent',
    rfcMessageId: `<${accountId}@dummy>`,
    subject: 's',
    body: 'b',
    reservedAt: sentAt,
    sentAt,
    attempts: 1,
  });
  await store.putOutreach(outreach('acc1', '2026-06-01T00:00:00Z')); // acc1 sent earlier
  await store.putOutreach(outreach('acc2', '2026-06-10T00:00:00Z')); // acc2 sent later

  await refetchReplies({ store, email, extractor, clock, config }, { noFetch: true });

  const a1 = await store.getAccount('acc1');
  const a2 = await store.getAccount('acc2');
  // Each floored at its own first send (minus the 60s buffer) — NOT a shared date.
  assert.equal(a1?.pollCursor?.lastPolledAt, '2026-05-31T23:59:00.000Z');
  assert.equal(a2?.pollCursor?.lastPolledAt, '2026-06-09T23:59:00.000Z');
});

test('refetch-replies --dry-run reports without mutating', async () => {
  const store = new MemoryStore();
  const email = new DummyEmailProvider();
  const extractor = new Extractor(new DummyLlmProvider());
  await seed(store);
  await runSendPass({ store, email, clock, config });
  const outreach = (await store.listOutreaches({ targetId: 't1' }))[0];
  email.injectReply({ threadId: outreach.threadId!, fromAddress: 'info@t1.com', text: 'Yes.' });
  await runPollPass({ store, email, extractor, clock, config });

  const result = await refetchReplies({ store, email, extractor, clock, config }, { dryRun: true });
  assert.equal(result.removed, 1);
  assert.equal(result.report, undefined); // no fetch happened
  assert.equal((await store.listReplies()).length, 1); // untouched
  assert.equal((await store.getTarget('t1'))?.status, 'replied'); // untouched
});

test('refetch-replies skips opt-out (excluded) targets unless --include-excluded', async () => {
  const store = new MemoryStore();
  const email = new DummyEmailProvider();
  await seed(store);
  await store.updateTarget('t1', (t) => ({ ...t, status: 'excluded' }));
  await store.putReply({
    id: 'r-excluded',
    emailId: 'e-x',
    rfcMessageId: '<x@x>',
    fromAddress: 'info@t1.com',
    targetId: 't1',
    matchMethod: 'fromAddress',
    receivedAt: '2026-06-19T11:00:00Z',
    text: 'stop emailing me',
    extractionStatus: 'done',
  });
  const extractor = new Extractor(new DummyLlmProvider());

  const skipped = await refetchReplies({ store, email, extractor, clock, config }, { dryRun: true });
  assert.equal(skipped.removed, 0); // excluded reply left alone

  const included = await refetchReplies(
    { store, email, extractor, clock, config },
    { dryRun: true, includeExcluded: true },
  );
  assert.equal(included.removed, 1);
});
