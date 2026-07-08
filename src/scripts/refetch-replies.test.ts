import test from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig } from '../config';
import { DummyEmailProvider } from '../adapters/email/dummy.provider';
import { DummyLlmProvider } from '../adapters/llm/dummy.provider';
import { MemoryStore } from '../adapters/store/memory.store';
import type { Account, Campaign, Target } from '../domain/types';
import type { IncomingEmail } from '../ports/email-provider';
import { fixedClock } from '../lib/clock';
import { Extractor } from '../services/extractor';
import { runPollPass } from '../pipeline/poll-pass';
import { runSendPass } from '../pipeline/send-pass';
import { refetchReplies } from './refetch-replies';

const config = loadConfig({} as NodeJS.ProcessEnv);
const clock = fixedClock(new Date('2026-06-19T12:00:00Z'));

async function seed(store: MemoryStore) {
  const campaign: Campaign = {
    id: 'camp1',
    name: 'casino',
    advertised: { url: 'casinoslists.com', description: 'a casino platform' },
    topic: 'casino',
    format: 'article',
    inquiryFields: [{ key: 'price', question: 'Cost?', type: 'price' }],
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
    campaignId: 'camp1',
    websiteUrl: 't1.com',
    contactEmail: 'info@t1.com',
    status: 'pending',
    followUpCount: 0,
    createdAt: '2026-06-01T00:00:00Z',
  };
  await store.putCampaign(campaign);
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
    receivedAt: new Date('2026-06-19T11:00:00Z'),
  });
  await runPollPass({ store, email, extractor, clock });

  const before = await store.listReplies();
  assert.equal(before.length, 1);
  const originalReplyId = before[0].id;
  assert.equal((await store.getTarget('t1'))?.status, 'replied');

  // The mailbox still has the message (real IMAP/Gmail don't delete on read);
  // the dummy drains, so re-queue the same emailId to simulate that.
  (email as unknown as { inbox: IncomingEmail[] }).inbox.push(injected);

  const result = await refetchReplies({ store, email, extractor, clock });

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

test('refetch-replies --dry-run reports without mutating', async () => {
  const store = new MemoryStore();
  const email = new DummyEmailProvider();
  const extractor = new Extractor(new DummyLlmProvider());
  await seed(store);
  await runSendPass({ store, email, clock, config });
  const outreach = (await store.listOutreaches({ targetId: 't1' }))[0];
  email.injectReply({ threadId: outreach.threadId!, fromAddress: 'info@t1.com', text: 'Yes.' });
  await runPollPass({ store, email, extractor, clock });

  const result = await refetchReplies({ store, email, extractor, clock }, { dryRun: true });
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

  const skipped = await refetchReplies({ store, email, extractor, clock }, { dryRun: true });
  assert.equal(skipped.removed, 0); // excluded reply left alone

  const included = await refetchReplies(
    { store, email, extractor, clock },
    { dryRun: true, includeExcluded: true },
  );
  assert.equal(included.removed, 1);
});
