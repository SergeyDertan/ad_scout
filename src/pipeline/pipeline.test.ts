import test from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig } from '../config';
import { DummyEmailProvider } from '../adapters/email/dummy.provider';
import { DummyLlmProvider } from '../adapters/llm/dummy.provider';
import { MemoryStore } from '../adapters/store/memory.store';
import { LABELS } from '../domain/labels';
import type { Account, Campaign, Target } from '../domain/types';
import { fixedClock } from '../lib/clock';
import type { LlmProvider } from '../ports/llm-provider';
import { Extractor } from '../services/extractor';
import { runPollPass } from './poll-pass';
import { runSendPass } from './send-pass';

const config = loadConfig({} as NodeJS.ProcessEnv);
const clock = fixedClock(new Date('2026-06-19T12:00:00Z'));

function campaign(): Campaign {
  return {
    id: 'camp1',
    name: 'casino',
    advertised: { url: 'casinoslists.com', description: 'a casino platform' },
    topic: 'casino',
    format: 'article',
    inquiryFields: [
      { key: 'price', question: 'Cost?', type: 'price' },
      { key: 'categories', question: 'Categories?', type: 'list' },
      { key: 'section', question: 'Section?', type: 'text' },
    ],
    createdAt: '2026-05-01T00:00:00Z',
  };
}

function account(): Account {
  return {
    id: 'acc1',
    email: 'vlad@example.com',
    providerType: 'smtp-imap',
    credentialRef: 'VLAD',
    senderName: 'Vlad',
    status: 'active',
    createdAt: '2026-05-01T00:00:00Z',
    maxDailyLimit: 40,
  };
}

function target(id: string, email: string): Target {
  return {
    id,
    campaignId: 'camp1',
    websiteUrl: `${id}.com`,
    contactEmail: email,
    status: 'pending',
    followUpCount: 0,
    createdAt: '2026-06-01T00:00:00Z',
  };
}

async function seed(store: MemoryStore) {
  await store.putCampaign(campaign());
  await store.putAccount(account());
  await store.putTarget(target('t1', 'info@t1.com'));
  await store.putTarget(target('t2', 'editor@t2.com'));
}

test('send-pass reserves, sends, resolves threadId, and contacts targets', async () => {
  const store = new MemoryStore();
  const email = new DummyEmailProvider();
  await seed(store);

  const report = await runSendPass({ store, email, clock, config });
  assert.equal(report.sent, 2);
  assert.equal(report.failed, 0);

  const targets = await store.listTargets();
  assert.ok(targets.every((t) => t.status === 'contacted'));
  assert.ok(targets.every((t) => t.lastOutreachAt));

  const outreaches = await store.listOutreaches();
  assert.equal(outreaches.length, 2);
  assert.ok(outreaches.every((o) => o.status === 'sent' && o.threadId && o.kind === 'initial'));
});

test('send-pass is idempotent — a second run sends nothing new', async () => {
  const store = new MemoryStore();
  const email = new DummyEmailProvider();
  await seed(store);

  await runSendPass({ store, email, clock, config });
  const second = await runSendPass({ store, email, clock, config });
  assert.equal(second.reserved, 0);
  assert.equal(second.sent, 0);
  assert.equal((await store.listOutreaches()).length, 2);
});

test('poll-pass matches a reply by threadId, extracts, and marks target replied', async () => {
  const store = new MemoryStore();
  const email = new DummyEmailProvider();
  const extractor = new Extractor(new DummyLlmProvider());
  await seed(store);

  await runSendPass({ store, email, clock, config });
  const outreach = (await store.listOutreaches({ targetId: 't1' }))[0];
  assert.ok(outreach.threadId);

  email.injectReply({
    threadId: outreach.threadId!,
    fromAddress: 'info@t1.com',
    text: 'Yes we can publish. $300. Categories: esports, betting. Section: News.',
    receivedAt: new Date('2026-06-19T12:30:00Z'),
  });

  const report = await runPollPass({ store, email, extractor, clock });
  assert.equal(report.matched, 1);
  assert.equal(report.extracted, 1);

  const t1 = await store.getTarget('t1');
  assert.equal(t1?.status, 'replied');
  assert.ok(t1?.result);
  assert.ok(t1?.result?.fields.price);

  const replies = await store.listReplies();
  assert.equal(replies.length, 1);
  assert.equal(replies[0].matchMethod, 'threadId');
  assert.equal(replies[0].targetId, 't1');

  // The message was seen (marked read) and got the extraction-outcome label.
  const emailId = replies[0].emailId;
  assert.deepEqual(email.markedRead, [emailId]);
  assert.deepEqual(email.appliedLabels, [{ emailId, label: LABELS.answered }]);
  assert.equal(replies[0].extractionStatus, 'done');
});

test('a later reply on an already-answered target is saved but not re-extracted', async () => {
  const store = new MemoryStore();
  const email = new DummyEmailProvider();
  // Count how many times the LLM is invoked so we can prove the second reply is
  // saved without an extraction call.
  let calls = 0;
  const dummy = new DummyLlmProvider();
  const countingLlm: LlmProvider = {
    name: 'counting',
    generateJson(req) {
      calls++;
      return dummy.generateJson(req);
    },
    generateText: (req) => dummy.generateText(req),
  };
  const extractor = new Extractor(countingLlm);
  await seed(store);

  await runSendPass({ store, email, clock, config });
  const outreach = (await store.listOutreaches({ targetId: 't1' }))[0];

  // First reply — a real answer. Extracts and resolves the target.
  email.injectReply({
    threadId: outreach.threadId!,
    fromAddress: 'info@t1.com',
    text: 'Yes we can publish. $300. Categories: esports. Section: News.',
    receivedAt: new Date('2026-06-19T12:30:00Z'),
  });
  const first = await runPollPass({ store, email, extractor, clock });
  assert.equal(first.extracted, 1);
  assert.equal(calls, 1);
  const resolved = await store.getTarget('t1');
  assert.equal(resolved?.status, 'replied');
  const firstResult = resolved?.result;
  assert.ok(firstResult);

  // Second reply in the SAME thread — must be saved, but NOT extracted, and must
  // leave the known result untouched.
  email.injectReply({
    threadId: outreach.threadId!,
    fromAddress: 'info@t1.com',
    text: 'Actually never mind, disregard.',
    receivedAt: new Date('2026-06-19T13:00:00Z'),
  });
  const second = await runPollPass({ store, email, extractor, clock });
  assert.equal(second.matched, 1);
  assert.equal(second.skipped, 1);
  assert.equal(second.extracted, 0);
  assert.equal(calls, 1, 'the AI must not be invoked on the later reply');

  const replies = (await store.listReplies()).sort((a, b) =>
    a.receivedAt.localeCompare(b.receivedAt),
  );
  assert.equal(replies.length, 2);
  assert.equal(replies[1].extractionStatus, 'skipped');
  assert.equal(replies[1].parsed, undefined);

  const after = await store.getTarget('t1');
  assert.equal(after?.status, 'replied');
  assert.deepEqual(after?.result, firstResult, 'the known result must be preserved');
});

test('poll-pass dedupes the same inbound emailId', async () => {
  const store = new MemoryStore();
  const email = new DummyEmailProvider();
  const extractor = new Extractor(new DummyLlmProvider());
  await seed(store);
  await runSendPass({ store, email, clock, config });
  const outreach = (await store.listOutreaches({ targetId: 't1' }))[0];

  const injected = email.injectReply({
    threadId: outreach.threadId!,
    fromAddress: 'info@t1.com',
    text: 'Yes.',
  });
  await runPollPass({ store, email, extractor, clock });

  // Re-inject the SAME emailId — should be deduped, not re-stored.
  (email as unknown as { inbox: unknown[] }).inbox.push(injected);
  const second = await runPollPass({ store, email, extractor, clock });
  assert.equal(second.deduped, 1);
  assert.equal((await store.listReplies()).length, 1);
});

test('holding reply keeps the target contacted (follow-ups continue) without a spurious review flag', async () => {
  const store = new MemoryStore();
  const email = new DummyEmailProvider();
  const holdingLlm: LlmProvider = {
    name: 'stub-holding',
    async generateJson() {
      return {
        optOut: false,
        intent: 'holding',
        offers: [],
        reasoning: 'acknowledgement only',
        conditions: '',
        notes: '',
        fields: { price: { raw: '' }, categories: { raw: '' }, section: { raw: '' } },
      };
    },
    async generateText() {
      return '';
    },
  };
  const extractor = new Extractor(holdingLlm);
  await seed(store);
  await runSendPass({ store, email, clock, config });
  const outreach = (await store.listOutreaches({ targetId: 't1' }))[0];

  email.injectReply({
    threadId: outreach.threadId!,
    fromAddress: 'info@t1.com',
    text: 'Thanks for reaching out, we will get back to you soon.',
  });
  await runPollPass({ store, email, extractor, clock });

  // NOT marked replied — still 'contacted' so follow-ups keep chasing the answer.
  const t1 = await store.getTarget('t1');
  assert.equal(t1?.status, 'contacted');
  // The reply is recorded with the holding intent, but a routine acknowledgement
  // is NOT a review item — the awaiting state lives in parsed.intent, not review.
  const reply = (await store.listReplies()).find((r) => r.targetId === 't1');
  assert.equal(reply?.parsed?.intent, 'holding');
  assert.equal(reply?.review, undefined);
});

test('opt-out reply excludes the target and adds a persistent suppression', async () => {
  const store = new MemoryStore();
  const email = new DummyEmailProvider();
  const optOutLlm: LlmProvider = {
    name: 'stub-optout',
    async generateJson() {
      return {
        canPost: 'no',
        optOut: true,
        conditions: '',
        notes: '',
        fields: { price: { raw: '' }, categories: { raw: '' }, section: { raw: '' } },
      };
    },
    async generateText() {
      return '';
    },
  };
  const extractor = new Extractor(optOutLlm);
  await seed(store);
  await runSendPass({ store, email, clock, config });
  const outreach = (await store.listOutreaches({ targetId: 't1' }))[0];

  email.injectReply({
    threadId: outreach.threadId!,
    fromAddress: 'info@t1.com',
    text: 'Please stop emailing me.',
  });
  await runPollPass({ store, email, extractor, clock });

  const t1 = await store.getTarget('t1');
  assert.equal(t1?.status, 'excluded');
  assert.equal(await store.isSuppressed('info@t1.com'), true);
});
