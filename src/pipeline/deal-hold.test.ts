// The hold: a thread under an open deal is stored and otherwise left completely
// alone. These tests pin the CONSEQUENCES that must not happen, because every
// one of them is a way a live negotiation could silently corrupt the price data
// or the do-not-contact lists.

import test from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig } from '../config';
import { DummyEmailProvider } from '../adapters/email/dummy.provider';
import { MemoryStore } from '../adapters/store/memory.store';
import { LABELS } from '../domain/labels';
import type { Account, Batch, Deal, DealStatus, Target } from '../domain/types';
import { fixedClock } from '../lib/clock';
import type { LlmProvider } from '../ports/llm-provider';
import { Extractor } from '../services/extractor';
import { extractPendingReplies, runPollPass } from './poll-pass';
import { runFetchPass } from './fetch-pass';
import { runSendPass } from './send-pass';

const config = loadConfig({} as NodeJS.ProcessEnv);
const clock = fixedClock(new Date('2026-08-19T12:00:00Z'));

/** An LLM that counts calls and would do real damage if it were ever reached:
 *  it opts the sender out, declines the whole site, and quotes a price. */
function destructiveLlm(): LlmProvider & { calls: number } {
  const llm = {
    calls: 0,
    name: 'stub-destructive',
    async generateJson() {
      llm.calls++;
      return {
        optOut: true,
        intent: 'decline',
        offers: [
          {
            category: 'regular', label: 'Regular', sensitive: false,
            canPost: 'yes', priceRaw: '$999', priceKind: 'absolute', multiplier: 0, relativeTo: '',
            website: '', isSpecial: false, specialUntil: '',
          },
        ],
        reasoning: 'stub', conditions: '', notes: '', isSpam: false,
      };
    },
    async generateText() {
      return '';
    },
  };
  return llm;
}

function seedDocs() {
  const batch: Batch = {
    id: 'batch1', name: 'deals', source: 'import', createdAt: '2026-08-01T00:00:00Z',
  };
  const account: Account = {
    id: 'acc1', email: 'vlad@example.com', providerType: 'smtp-imap', credentialRef: 'VLAD',
    senderName: 'Vlad', status: 'active', createdAt: '2026-08-01T00:00:00Z', maxDailyLimit: 40,
  };
  const target: Target = {
    id: 't1', batchId: 'batch1', websiteUrl: 't1.com', contactEmail: 'admin@t1.com',
    status: 'pending', followUpCount: 0, createdAt: '2026-08-01T00:00:00Z',
  };
  return { batch, account, target };
}

function dealOn(threadId: string, status: DealStatus = 'negotiation'): Deal {
  return {
    id: 'deal1',
    counterpartyEmail: 'admin@t1.com',
    accountId: 'acc1',
    status,
    origin: 'manual',
    openedAt: '2026-08-10T00:00:00Z',
  };
}

/** Send the initial outreach so a real thread exists, then open a deal on it. */
async function setup(llm: LlmProvider, status?: DealStatus) {
  const store = new MemoryStore();
  const email = new DummyEmailProvider();
  const extractor = new Extractor(llm);
  const { batch, account, target } = seedDocs();
  await store.putBatch(batch);
  await store.putAccount(account);
  await store.putTarget(target);

  await runSendPass({ store, email, clock, config });
  const outreach = (await store.listOutreaches({ targetId: 't1' }))[0]!;
  const threadId = outreach.threadId!;

  if (status !== undefined) {
    const deal = dealOn(threadId, status);
    await store.putDeal(deal);
    await store.putThreadLink({ id: threadId, threadId, dealId: deal.id });
  }
  return { store, email, extractor, threadId };
}

test('a reply on an open deal thread is stored and nothing else happens to it', async () => {
  const llm = destructiveLlm();
  const { store, email, extractor, threadId } = await setup(llm, 'negotiation');

  email.injectReply({
    threadId,
    fromAddress: 'admin@t1.com',
    text: "Hello, we're gonna add the post tomorrow, here is the payment link: https://pay.me/x",
  });

  const report = await runPollPass({ store, email, extractor, clock, config });

  assert.equal(report.held, 1);
  assert.equal(report.extracted, 0);
  assert.equal(llm.calls, 0, 'the extractor must never see a deal message');

  const reply = (await store.listReplies())[0]!;
  assert.equal(reply.extractionStatus, 'skipped');
  assert.equal(reply.dealId, 'deal1');
  assert.equal(reply.targetId, 't1', 'still matched, so the deal can show the site');
  assert.equal(reply.parsed, undefined);

  // None of the consequences a normal extraction would have written.
  assert.deepEqual(await store.listPriceRecords(), [], 'no price record');
  assert.deepEqual(await store.listSuppressions(), [], 'no suppression');
  assert.deepEqual(await store.listDomainExclusions(), [], 'no domain exclusion');
  assert.deepEqual(await store.listIgnore(), [], 'no ignore entry');

  const t1 = await store.getTarget('t1');
  assert.equal(t1?.status, 'contacted', 'target status untouched');
  assert.equal(t1?.result, undefined, 'target result untouched');
});

test('a held message is left UNREAD and labelled AS/Deal', async () => {
  const llm = destructiveLlm();
  const { store, email, extractor, threadId } = await setup(llm, 'negotiation');

  const msg = email.injectReply({ threadId, fromAddress: 'admin@t1.com', text: 'invoice attached' });
  await runPollPass({ store, email, extractor, clock, config });

  assert.deepEqual(email.markedRead, [], 'a human is reading this thread — keep it bold');
  assert.deepEqual(email.appliedLabels, [{ emailId: msg.emailId, label: LABELS.deal }]);
});

test('closing the deal lifts the hold — a later reply extracts normally', async () => {
  const llm = destructiveLlm();
  const { store, email, extractor, threadId } = await setup(llm, 'done');

  email.injectReply({ threadId, fromAddress: 'admin@t1.com', text: 'our new rate is $999' });
  const report = await runPollPass({ store, email, extractor, clock, config });

  assert.equal(report.held, 0);
  assert.equal(report.extracted, 1);
  assert.equal(llm.calls, 1);
  assert.equal(email.markedRead.length, 1, 'no longer a human-operated thread');
});

test('an open deal overrides the ignore list', async () => {
  const llm = destructiveLlm();
  const { store, email, extractor, threadId } = await setup(llm, 'negotiation');
  await store.putIgnore({
    id: 'email:admin@t1.com', kind: 'email', value: 'admin@t1.com',
    reason: 'an earlier isSpam misfire', at: '2026-08-05T00:00:00Z',
  });

  email.injectReply({ threadId, fromAddress: 'admin@t1.com', text: 'payment received' });
  const report = await runPollPass({ store, email, extractor, clock, config });

  assert.equal(report.ignored, 0, 'a stale spam verdict must not swallow a live negotiation');
  assert.equal(report.held, 1);
  assert.equal((await store.listReplies()).length, 1);
});

test('a reply already pending is held when its thread joins a deal afterwards', async () => {
  const llm = destructiveLlm();
  // No deal yet: the reply lands as a normal pending one.
  const { store, email, extractor, threadId } = await setup(llm);

  email.injectReply({ threadId, fromAddress: 'admin@t1.com', text: 'sure, what do you need?' });
  await runPollPass({ store, email, extractor, clock, config });
  assert.equal(llm.calls, 1, 'extracted normally — there was no deal at the time');

  // Force it back to pending, as a failed extraction or a reset would.
  const reply = (await store.listReplies())[0]!;
  await store.putReply({ ...reply, extractionStatus: 'pending' });

  // NOW open the deal on that thread and re-run the extraction queue.
  const deal = dealOn(threadId);
  await store.putDeal(deal);
  await store.putThreadLink({ id: threadId, threadId, dealId: deal.id });

  const result = await extractPendingReplies({ store, email, extractor, clock, config });
  assert.equal(result.extracted, 0);
  assert.equal(llm.calls, 1, 'the hold is evaluated at extraction time, not only at ingest');
});

// The drip scheduler polls with runFetchPass, NOT runPollPass. A hold that only
// the poll pass honours would be inert in production, so it gets its own tests.
test('the FETCH pass (what the scheduler runs) honours the hold', async () => {
  const llm = destructiveLlm();
  const { store, email, threadId } = await setup(llm, 'negotiation');

  const msg = email.injectReply({
    threadId,
    fromAddress: 'admin@t1.com',
    text: 'paid — publishing tomorrow, here is the invoice',
  });
  const report = await runFetchPass({ store, email, clock });

  assert.equal(report.held, 1);
  assert.equal(report.matched, 0, 'held is its own bucket');
  assert.deepEqual(email.markedRead, [], 'left unread for the human');
  assert.deepEqual(email.appliedLabels, [{ emailId: msg.emailId, label: LABELS.deal }]);

  const reply = (await store.listReplies())[0]!;
  assert.equal(reply.extractionStatus, 'skipped', 'never enters the extraction queue');
  assert.equal(reply.dealId, 'deal1');

  const t1 = await store.getTarget('t1');
  assert.equal(t1?.status, 'contacted', 'a mid-deal message must not move the target to replied');
});

test('a held reply stored by the fetch pass is not picked up by a later extraction', async () => {
  const llm = destructiveLlm();
  const { store, email, extractor, threadId } = await setup(llm, 'negotiation');

  email.injectReply({ threadId, fromAddress: 'admin@t1.com', text: 'invoice attached' });
  await runFetchPass({ store, email, clock });

  const result = await extractPendingReplies({ store, email, extractor, clock, config });
  assert.equal(result.extracted, 0);
  assert.equal(llm.calls, 0);
});
