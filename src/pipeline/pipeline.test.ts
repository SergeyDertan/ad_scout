import test from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig } from '../config';
import { DummyEmailProvider } from '../adapters/email/dummy.provider';
import { DummyLlmProvider } from '../adapters/llm/dummy.provider';
import { MemoryStore } from '../adapters/store/memory.store';
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
  assert.equal(replies[0].extractionStatus, 'done');
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

test('holding reply keeps the target contacted (follow-ups continue) and flags for review', async () => {
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
  // The reply is recorded and flagged for review.
  const reply = (await store.listReplies()).find((r) => r.targetId === 't1');
  assert.equal(reply?.parsed?.intent, 'holding');
  assert.ok((reply?.review ?? []).some((r) => /no answer yet/i.test(r)));
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
