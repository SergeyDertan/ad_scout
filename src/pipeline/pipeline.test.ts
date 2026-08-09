import test from 'node:test';
import assert from 'node:assert/strict';

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadConfig } from '../config';
import { DummyEmailProvider } from '../adapters/email/dummy.provider';
import { DummyLlmProvider } from '../adapters/llm/dummy.provider';
import { MemoryStore } from '../adapters/store/memory.store';
import { PouchDbStore } from '../adapters/store/pouchdb.store';
import { LABELS } from '../domain/labels';
import type { Account, Batch, Target } from '../domain/types';
import { fixedClock } from '../lib/clock';
import { UsageLimitError } from '../lib/errors';
import type { LlmProvider } from '../ports/llm-provider';
import type { EmailProvider, IncomingEmail, SendResult } from '../ports/email-provider';
import { Extractor } from '../services/extractor';
import { extractPendingReplies, runPollPass } from './poll-pass';
import { runFetchPass } from './fetch-pass';
import { runSendPass } from './send-pass';

const config = loadConfig({} as NodeJS.ProcessEnv);
const clock = fixedClock(new Date('2026-06-19T12:00:00Z'));

function batch(): Batch {
  return {
    id: 'batch1',
    name: 'casino import',
    source: 'import',
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
    batchId: 'batch1',
    websiteUrl: `${id}.com`,
    contactEmail: email,
    status: 'pending',
    followUpCount: 0,
    createdAt: '2026-06-01T00:00:00Z',
  };
}

async function seed(store: MemoryStore) {
  await store.putBatch(batch());
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

  const report = await runPollPass({ store, email, extractor, clock, config });
  assert.equal(report.matched, 1);
  assert.equal(report.extracted, 1);

  const t1 = await store.getTarget('t1');
  assert.equal(t1?.status, 'replied');
  assert.ok(t1?.result);
  assert.ok(Array.isArray(t1?.result?.offers));

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

// A stub extractor that returns a single regular guest-post offer at the given
// price (or a non-substantive 'other' reply when price is null).
function pricingLlm(prices: (string | null)[]): LlmProvider {
  let i = 0;
  return {
    name: 'stub-pricing',
    async generateJson() {
      const price = prices[Math.min(i, prices.length - 1)];
      i++;
      if (price == null) {
        return { optOut: false, intent: 'other', offers: [], reasoning: 'chatter', conditions: '', notes: '', isSpam: false };
      }
      return {
        optOut: false,
        intent: 'answer',
        offers: [
          {
            category: 'regular', label: 'Regular', sensitive: false,
            canPost: 'yes', priceRaw: price, priceKind: 'absolute', multiplier: 0, relativeTo: '',
            website: '', isSpecial: false, specialUntil: '',
          },
        ],
        reasoning: 'regular price', conditions: '', notes: '', isSpam: false,
      };
    },
    async generateText() {
      return '';
    },
  };
}

test('a later substantive reply is re-extracted and appends a new price record (Requirement 2)', async () => {
  const store = new MemoryStore();
  const email = new DummyEmailProvider();
  const extractor = new Extractor(pricingLlm(['$300', '$350']));
  await seed(store);

  await runSendPass({ store, email, clock, config });
  const outreach = (await store.listOutreaches({ targetId: 't1' }))[0];

  email.injectReply({
    threadId: outreach.threadId!,
    fromAddress: 'info@t1.com',
    text: 'Yes we can publish. $300.',
    receivedAt: new Date('2026-06-19T12:30:00Z'),
  });
  const first = await runPollPass({ store, email, extractor, clock, config });
  assert.equal(first.extracted, 1);

  // A LATER reply with an updated price — must be re-extracted and append a record.
  email.injectReply({
    threadId: outreach.threadId!,
    fromAddress: 'info@t1.com',
    text: 'Price update: now $350.',
    receivedAt: new Date('2026-06-20T09:00:00Z'),
  });
  const second = await runPollPass({ store, email, extractor, clock, config });
  assert.equal(second.matched, 1);
  assert.equal(second.extracted, 1, 'the later substantive reply is re-extracted');

  // Two append-only price records for the target's domain, newest reflecting $350.
  const records = (await store.listPriceRecords({ domain: 't1.com' })).sort((a, b) =>
    a.observedAt.localeCompare(b.observedAt),
  );
  assert.equal(records.length, 2);
  assert.equal(records[0].offers[0].price?.amount, 300);
  assert.equal(records[1].offers[0].price?.amount, 350);
  assert.equal(records[0].attribution, 'sender');
  assert.equal(records[0].targetId, 't1');

  // target.result holds the latest substantive snapshot.
  const t1 = await store.getTarget('t1');
  assert.equal(t1?.result?.offers[0].price?.amount, 350);
});

test('a non-substantive later reply preserves the known result and writes no record', async () => {
  const store = new MemoryStore();
  const email = new DummyEmailProvider();
  const extractor = new Extractor(pricingLlm(['$300', null]));
  await seed(store);

  await runSendPass({ store, email, clock, config });
  const outreach = (await store.listOutreaches({ targetId: 't1' }))[0];

  email.injectReply({
    threadId: outreach.threadId!,
    fromAddress: 'info@t1.com',
    text: 'Yes we can publish. $300.',
    receivedAt: new Date('2026-06-19T12:30:00Z'),
  });
  await runPollPass({ store, email, extractor, clock, config });
  const firstResult = (await store.getTarget('t1'))?.result;

  email.injectReply({
    threadId: outreach.threadId!,
    fromAddress: 'info@t1.com',
    text: 'Thanks, talk soon!',
    receivedAt: new Date('2026-06-20T09:00:00Z'),
  });
  await runPollPass({ store, email, extractor, clock, config });

  // The known result is preserved (not clobbered by the chatter) and no 2nd record.
  const after = await store.getTarget('t1');
  assert.deepEqual(after?.result, firstResult);
  assert.equal((await store.listPriceRecords({ domain: 't1.com' })).length, 1);
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
  await runPollPass({ store, email, extractor, clock, config });

  // Re-inject the SAME emailId — should be deduped, not re-stored.
  (email as unknown as { inbox: unknown[] }).inbox.push(injected);
  const second = await runPollPass({ store, email, extractor, clock, config });
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
  await runPollPass({ store, email, extractor, clock, config });

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
  await runPollPass({ store, email, extractor, clock, config });

  const t1 = await store.getTarget('t1');
  assert.equal(t1?.status, 'excluded');
  assert.equal(await store.isSuppressed('info@t1.com'), true);
});

// A stub returning a fixed RawExtraction — the caller controls the whole shape.
function stubLlm(raw: Record<string, unknown>): LlmProvider {
  return {
    name: 'stub',
    model: 'stub-model-v1',
    async generateJson() {
      return raw;
    },
    async generateText() {
      return '';
    },
  };
}

const rawOffer = (o: Record<string, unknown>) => ({
  category: 'regular', label: 'Regular', sensitive: false,
  canPost: 'yes', priceRaw: '', priceKind: 'absolute', multiplier: 0, relativeTo: '',
  website: '', isSpecial: false, specialUntil: '', ...o,
});

async function sendAndReply(store: MemoryStore, email: DummyEmailProvider, text: string, from = 'info@t1.com') {
  await runSendPass({ store, email, clock, config });
  const outreach = (await store.listOutreaches({ targetId: 't1' }))[0];
  email.injectReply({ threadId: outreach.threadId!, fromAddress: from, text, receivedAt: new Date('2026-06-19T12:30:00Z') });
}

test('an offer tagged with a different owned site records against that site (M2, named)', async () => {
  const store = new MemoryStore();
  const email = new DummyEmailProvider();
  const extractor = new Extractor(stubLlm({
    optOut: false, intent: 'answer', reasoning: 'two sites', conditions: '', notes: '', isSpam: false,
    offers: [
      rawOffer({ priceRaw: '$100' }),
      rawOffer({ priceRaw: '$80', website: 'casik.ua' }),
    ],
  }));
  await seed(store);
  await sendAndReply(store, email, 'Our site $100, and on casik.ua it is $80.');
  await runPollPass({ store, email, extractor, clock, config });

  const own = await store.listPriceRecords({ domain: 't1.com' });
  const other = await store.listPriceRecords({ domain: 'casik.ua' });
  assert.equal(own.length, 1);
  assert.equal(own[0].attribution, 'sender');
  assert.equal(own[0].targetId, 't1');
  assert.equal(other.length, 1);
  assert.equal(other[0].attribution, 'named');
  assert.equal(other[0].targetId, undefined); // not associated with the contacted target
  assert.equal(other[0].offers[0].price?.amount, 80);
});

test('untagged offer with a multi-domain sender goes to the site we contacted', async () => {
  const store = new MemoryStore();
  const email = new DummyEmailProvider();
  const extractor = new Extractor(stubLlm({
    optOut: false, intent: 'answer', reasoning: 'x', conditions: '', notes: '', isSpam: false,
    offers: [rawOffer({ priceRaw: '$100' })],
  }));
  await store.putBatch(batch());
  await store.putAccount(account());
  // Same contact email is used for TWO different sites. The reply is still an
  // answer about the site we mailed, so the untagged price is attributed there
  // rather than dropped — otherwise the contacted site ends up with no prices.
  await store.putTarget(target('t1', 'owner@shared.com'));
  await store.putTarget({ ...target('t2', 'owner@shared.com'), websiteUrl: 't2.com' });

  await sendAndReply(store, email, 'Sure, $100.', 'owner@shared.com');
  await runPollPass({ store, email, extractor, clock, config });

  const records = await store.listPriceRecords();
  assert.equal(records.length, 1);
  assert.equal(records[0]!.domain, 't1.com'); // the site we contacted, not t2.com
  assert.equal(records[0]!.attribution, 'sender');
  assert.equal(records[0]!.offers[0]?.price?.amount, 100);

  // …and it is no longer flagged as ambiguous.
  const reply = (await store.listReplies()).find((r) => r.targetId === 't1');
  assert.equal(reply?.review?.some((r) => /associated with 2 sites/.test(r)) ?? false, false);
});

test('a few extra owned sites are all recorded (under the domain cap)', async () => {
  const store = new MemoryStore();
  const email = new DummyEmailProvider();
  const extractor = new Extractor(stubLlm({
    optOut: false, intent: 'answer', reasoning: 'three sites', conditions: '', notes: '', isSpam: false,
    offers: [
      rawOffer({ priceRaw: '$400' }),
      rawOffer({ priceRaw: '$350', website: 'casik_super.ua' }),
      rawOffer({ priceRaw: '$500', website: 'ultra_casik.net' }),
    ],
  }));
  await seed(store);
  await sendAndReply(store, email, 'Guest post $400. Also casik_super.ua $350 and ultra_casik.net $500.');
  await runPollPass({ store, email, extractor, clock, config });

  const records = await store.listPriceRecords();
  assert.deepEqual(records.map((r) => r.domain).sort(), ['casik_super.ua', 't1.com', 'ultra_casik.net']);
  const reply = (await store.listReplies()).find((r) => r.targetId === 't1');
  assert.equal(reply?.review, undefined); // an ordinary multi-site answer, no flag
});

test('a bulk price list is stored only for the site we asked about', async () => {
  const store = new MemoryStore();
  const email = new DummyEmailProvider();
  // "Check prices at example.net/price" → the model came back with 300 sites.
  const extractor = new Extractor(stubLlm({
    optOut: false, intent: 'answer', reasoning: 'price list', conditions: '', notes: '', isSpam: false,
    offers: [
      rawOffer({ priceRaw: '$500' }), // untagged → the site we contacted
      ...Array.from({ length: 300 }, (_, i) => rawOffer({ priceRaw: '$20', website: `bulk${i}.com` })),
    ],
  }));
  await seed(store);
  await sendAndReply(store, email, 'Yeah, sure. Check prices at example.net/price');
  await runPollPass({ store, email, extractor, clock, config });

  // Exactly one record, for the contacted domain — the other 300 never land.
  const records = await store.listPriceRecords();
  assert.equal(records.length, 1);
  assert.equal(records[0]!.domain, 't1.com');
  assert.equal(records[0]!.offers[0]?.price?.amount, 500);
  assert.equal((await store.listPriceRecords({ domain: 'bulk0.com' })).length, 0);

  // The reply snapshot is trimmed too, so the UI and exports don't carry the
  // 300 sites we deliberately discarded.
  const reply = (await store.listReplies()).find((r) => r.targetId === 't1');
  assert.equal(reply?.parsed?.offers.length, 1);
  assert.ok(reply?.review?.some((r) => /bulk price list/.test(r)));
  const t1 = await store.getTarget('t1');
  assert.equal(t1?.result?.offers.length, 1);
});

test('every price record records which run produced it, and the AI explanation', async () => {
  const store = new MemoryStore();
  const email = new DummyEmailProvider();
  const extractor = new Extractor(stubLlm({
    optOut: false, intent: 'answer', reasoning: 'regular $400', conditions: '', notes: '', isSpam: false,
    aiExplanation: 'Owner gave one flat rate, "400$ per article", with no niche named; we asked broadly so that is the regular rate. Their $99 link-insertion price was discarded.',
    offers: [
      rawOffer({ priceRaw: '$400' }),
      rawOffer({ priceRaw: '$350', website: 'casik_super.ua' }),
    ],
  }));
  await seed(store);
  await sendAndReply(store, email, 'Guest post 400$. Also casik_super.ua 350$. Link insertion 99$.');
  await runPollPass({ store, email, extractor, clock, config });

  // Each of the 5-domains-in-one-email case: every record is self-describing.
  const records = await store.listPriceRecords();
  assert.equal(records.length, 2);
  for (const r of records) {
    assert.equal(r.extraction?.provider, 'stub');
    assert.equal(r.extraction?.model, 'stub-model-v1');
    assert.equal(r.extraction?.promptStyle, 'broad');
    assert.ok(r.extraction?.promptHash);
    assert.ok(r.extraction?.extractedAt);
    assert.equal(r.extraction?.editedByHuman, undefined);
    assert.match(r.aiExplanation ?? '', /400\$ per article/);
  }
  // Both records came from one run, so they share a prompt fingerprint.
  assert.equal(records[0]!.extraction!.promptHash, records[1]!.extraction!.promptHash);

  // The reply carries the same stamp…
  const reply = (await store.listReplies()).find((r) => r.targetId === 't1');
  assert.equal(reply?.extraction?.promptHash, records[0]!.extraction!.promptHash);

  // …and the prompt text itself is archived under that hash, so the fingerprint
  // stays resolvable long after the source has changed.
  const prompts = await store.listPromptSnapshots();
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0]!.hash, records[0]!.extraction!.promptHash);
  assert.equal(prompts[0]!.style, 'broad');
  assert.match(prompts[0]!.text, /WE BUY EXACTLY ONE PRODUCT/);
});

test('the prompt archive is written once, not once per reply', async () => {
  const store = new MemoryStore();
  const email = new DummyEmailProvider();
  const extractor = new Extractor(stubLlm({
    optOut: false, intent: 'answer', reasoning: 'x', conditions: '', notes: '', isSpam: false,
    offers: [rawOffer({ priceRaw: '$100' })],
  }));
  await seed(store);
  await sendAndReply(store, email, 'Sure, $100.');
  await runPollPass({ store, email, extractor, clock, config });
  await sendAndReply(store, email, 'Actually now $150.');
  await runPollPass({ store, email, extractor, clock, config });

  assert.equal((await store.listPromptSnapshots()).length, 1); // content-addressed
});

test('AI-detected spam adds the sender to the ignore list and writes no records', async () => {
  const store = new MemoryStore();
  const email = new DummyEmailProvider();
  const extractor = new Extractor(stubLlm({
    optOut: false, intent: 'other', reasoning: 'unrelated pool-cleaner ad', conditions: '', notes: '',
    isSpam: true, offers: [],
  }));
  await seed(store);
  await sendAndReply(store, email, '10% off pool cleaners this week!');
  await runPollPass({ store, email, extractor, clock, config });

  assert.equal(await store.isIgnored('info@t1.com'), true);
  assert.equal((await store.listPriceRecords()).length, 0);
  const reply = (await store.listReplies()).find((r) => r.targetId === 't1');
  assert.equal(reply?.extractionStatus, 'skipped');
  // A subsequent message from that sender is dropped BEFORE any AI work.
  email.injectReply({ threadId: (await store.listOutreaches({ targetId: 't1' }))[0].threadId!, fromAddress: 'info@t1.com', text: 'again!' });
  const second = await runPollPass({ store, email, extractor, clock, config });
  assert.equal(second.ignored, 1);
});

test('a blanket decline excludes the domain; a positive later reply lifts it (D8/D10)', async () => {
  const store = new MemoryStore();
  const email = new DummyEmailProvider();
  const declineThenAccept = (() => {
    let n = 0;
    return {
      name: 'stub-decline-accept',
      async generateJson() {
        n++;
        if (n === 1) return { optOut: false, intent: 'decline', reasoning: 'not interested', conditions: '', notes: '', isSpam: false, offers: [] };
        return { optOut: false, intent: 'answer', reasoning: 'changed mind', conditions: '', notes: '', isSpam: false, offers: [rawOffer({ priceRaw: '$120' })] };
      },
      async generateText() { return ''; },
    } as LlmProvider;
  })();
  const extractor = new Extractor(declineThenAccept);
  await seed(store);

  await sendAndReply(store, email, 'We are not interested, thanks.');
  await runPollPass({ store, email, extractor, clock, config });
  assert.equal(await store.isDomainExcluded('t1.com'), true);
  assert.equal((await store.getTarget('t1'))?.status, 'excluded');

  // Later positive reply → exclusion lifted and price recorded.
  email.injectReply({ threadId: (await store.listOutreaches({ targetId: 't1' }))[0].threadId!, fromAddress: 'info@t1.com', text: 'Actually we can, $120.', receivedAt: new Date('2026-06-20T10:00:00Z') });
  await runPollPass({ store, email, extractor, clock, config });
  assert.equal(await store.isDomainExcluded('t1.com'), false);
  const records = await store.listPriceRecords({ domain: 't1.com' });
  assert.equal(records.length, 1);
  assert.equal(records[0].offers[0].price?.amount, 120);
});

test('send-pass skips a target whose domain is excluded (D9)', async () => {
  const store = new MemoryStore();
  const email = new DummyEmailProvider();
  await seed(store); // t1 → t1.com, t2 → t2.com
  await store.putDomainExclusion({ id: 't1.com', domain: 't1.com', reason: 'declined', at: '2026-06-01T00:00:00Z' });

  const report = await runSendPass({ store, email, clock, config });
  assert.equal(report.sent, 1); // only t2 sent
  assert.equal((await store.getTarget('t1'))?.status, 'pending'); // never contacted
  assert.equal((await store.getTarget('t2'))?.status, 'contacted');
});

test('a sender on the ignore list is dropped before matching or storage', async () => {
  const store = new MemoryStore();
  const email = new DummyEmailProvider();
  const extractor = new Extractor(new DummyLlmProvider());
  await seed(store);
  await store.putIgnore({ id: 'email:spam@spam.com', kind: 'email', value: 'spam@spam.com', reason: 'manual', at: '2026-06-01T00:00:00Z' });

  await runSendPass({ store, email, clock, config });
  email.injectReply({ fromAddress: 'spam@spam.com', text: 'buy now' });
  const report = await runPollPass({ store, email, extractor, clock, config });
  assert.equal(report.ignored, 1);
  assert.equal((await store.listReplies()).length, 0);
});

// --- parallel re-extraction --------------------------------------------------

/** An LLM whose calls take real time, so overlap is observable. */
class SlowLlm implements LlmProvider {
  readonly name = 'slow';
  readonly model = 'slow-1';
  inFlight = 0;
  peak = 0;
  calls = 0;
  async generateJson(): Promise<unknown> {
    this.calls++;
    this.inFlight++;
    this.peak = Math.max(this.peak, this.inFlight);
    await new Promise((r) => setTimeout(r, 25));
    this.inFlight--;
    return {
      optOut: false,
      offers: [{ category: 'regular', label: 'Regular', sensitive: false, canPost: 'yes', priceRaw: '$50' }],
      reasoning: 'test',
      conditions: '',
      notes: '',
      fields: { price: { raw: '$50' } },
    };
  }
  async generateText(): Promise<string> {
    return '';
  }
}

async function seedPendingReplies(store: MemoryStore | PouchDbStore, n: number) {
  for (let k = 0; k < n; k++) {
    await store.putReply({
      id: `reply${k}`,
      emailId: `email${k}`,
      rfcMessageId: `<msg${k}@pub.com>`,
      fromAddress: `editor@pub${k}.com`,
      matchMethod: 'unmatched',
      receivedAt: '2026-06-18T09:00:00Z',
      text: 'Yes, we publish guest posts. Our rate is $50 per article.',
      extractionStatus: 'pending',
    });
  }
}

async function extractAll(concurrency: number | undefined, n = 6) {
  const store = new MemoryStore();
  await seedPendingReplies(store, n);
  const llm = new SlowLlm();
  const deps = {
    store,
    email: new DummyEmailProvider(),
    extractor: new Extractor(llm),
    clock,
    config,
  };
  const result = await extractPendingReplies(deps, concurrency == null ? {} : { concurrency });
  return { llm, result, store };
}

test('re-extraction runs several replies through the model at once', async () => {
  const { llm, result, store } = await extractAll(3);
  assert.equal(result.extracted, 6);
  assert.equal(result.failed, 0);
  assert.equal(llm.calls, 6, 'every pending reply is extracted exactly once');
  assert.ok(llm.peak > 1, `expected overlapping model calls, peak was ${llm.peak}`);
  assert.ok(llm.peak <= 3, `never more than the configured width, peak was ${llm.peak}`);
  // Serialized persistence must still land every reply's result.
  const replies = await store.listReplies();
  assert.equal(replies.filter((r) => r.extractionStatus === 'done').length, 6);
  assert.equal(replies.filter((r) => r.parsed?.offers.length === 1).length, 6);
  // One price record per reply, each attributed to that sender's own domain.
  const records = await store.listPriceRecords();
  assert.equal(records.length, 6);
  assert.deepEqual([...new Set(records.map((r) => r.domain))].sort(), [
    'pub0.com', 'pub1.com', 'pub2.com', 'pub3.com', 'pub4.com', 'pub5.com',
  ]);
});

test('the live poll pass stays sequential unless asked otherwise', async () => {
  const { llm, result } = await extractAll(undefined, 4);
  assert.equal(result.extracted, 4);
  assert.equal(llm.peak, 1, 'default concurrency must remain 1');
});

/** Refuses every call the way an unrecognized usage limit does: instantly. */
class AlwaysFailsLlm implements LlmProvider {
  readonly name = 'always-fails';
  readonly model = 'x';
  calls = 0;
  async generateJson(): Promise<unknown> {
    this.calls++;
    throw new Error("claude CLI failed (generateJson): You've hit your brand-new-wording limit");
  }
  async generateText(): Promise<string> {
    return '';
  }
}

// The incident this guards: the CLI changed its limit wording, detectUsageLimit
// stopped matching, and every call began failing in ~700ms — so one run marked
// hundreds of good replies 'failed' before a human noticed. Detection is now
// fixed for the KNOWN wordings; retry-then-give-up is the backstop for the next
// change to them, and is deliberately blind to what the error actually says.
test('a reply that fails every attempt stops the run instead of burning the queue', async () => {
  const store = new MemoryStore();
  await seedPendingReplies(store, 40);
  const llm = new AlwaysFailsLlm();
  const result = await extractPendingReplies(
    { store, email: new DummyEmailProvider(), extractor: new Extractor(llm), clock, config },
    { concurrency: 1, retrySleepMs: 0 },
  );

  assert.equal(result.stoppedByFailures, true);
  assert.equal(result.failed, 1, 'one reply failed — the run stops, it does not move on');
  assert.equal(llm.calls, 3, 'that reply got all 3 attempts, and no other reply was tried');
  const replies = await store.listReplies();
  assert.equal(replies.filter((r) => r.extractionStatus === 'pending').length, 39, 'the rest is untouched');
});

test('a transient error is retried, and the run carries on once it clears', async () => {
  // Fails the first attempt of each reply, succeeds on the second: nothing is
  // lost and the run must not abort.
  const seen = new Map<string, number>();
  const flaky: LlmProvider = {
    name: 'flaky',
    model: 'x',
    async generateJson(req: { prompt: string }): Promise<unknown> {
      const key = req.prompt;
      const n = (seen.get(key) ?? 0) + 1;
      seen.set(key, n);
      if (n === 1) throw new Error('transient CLI timeout');
      return {
        optOut: false,
        offers: [{ category: 'regular', label: 'Regular', sensitive: false, canPost: 'yes', priceRaw: '$50' }],
        reasoning: 'test',
        conditions: '',
        notes: '',
        fields: { price: { raw: '$50' } },
      };
    },
    async generateText(): Promise<string> {
      return '';
    },
  } as LlmProvider;
  const store = new MemoryStore();
  await seedPendingReplies(store, 5);
  const result = await extractPendingReplies(
    { store, email: new DummyEmailProvider(), extractor: new Extractor(flaky), clock, config },
    { concurrency: 1, retrySleepMs: 0 },
  );

  assert.equal(result.stoppedByFailures, false, 'a retry that succeeds is not a failure');
  assert.equal(result.extracted, 5);
  assert.equal(result.failed, 0);
});

test('a usage limit is not retried — it stops the run and leaves the reply pending', async () => {
  // Retrying a closed window inside a 10s loop cannot succeed, and marking the
  // reply 'failed' would lose the "resume exactly here" property.
  const llm: LlmProvider = {
    name: 'limited',
    model: 'x',
    calls: 0,
    async generateJson(): Promise<unknown> {
      (this as { calls: number }).calls++;
      throw new UsageLimitError("You've hit your session limit · resets 4:20pm (Europe/Kiev)");
    },
    async generateText(): Promise<string> {
      return '';
    },
  } as LlmProvider & { calls: number };
  const store = new MemoryStore();
  await seedPendingReplies(store, 10);
  const result = await extractPendingReplies(
    { store, email: new DummyEmailProvider(), extractor: new Extractor(llm), clock, config },
    { concurrency: 1, retrySleepMs: 0 },
  );

  assert.equal(result.stoppedByLimit, true);
  assert.equal(result.failed, 0, 'the limit must not mark anything failed');
  assert.equal((llm as unknown as { calls: number }).calls, 1, 'one call, no retries against a closed window');
  const replies = await store.listReplies();
  assert.equal(replies.filter((r) => r.extractionStatus === 'pending').length, 10, 'every reply resumes later');
});

/** Every reply reports the SAME brand-new niche, so all workers race to write
 *  one niche doc and one prompt snapshot. */
class SameNicheLlm implements LlmProvider {
  readonly name = 'same-niche';
  readonly model = 'x';
  async generateJson(): Promise<unknown> {
    return {
      optOut: false,
      offers: [
        { category: 'artisan_cheese', label: 'Artisan cheese', sensitive: false, canPost: 'yes', priceRaw: '$50' },
      ],
      reasoning: 'test',
      conditions: '',
      notes: '',
      fields: { price: { raw: '$50' } },
    };
  }
  async generateText(): Promise<string> {
    return '';
  }
}

// The regression this guards: PouchDbStore.put reads a doc's _rev then writes it
// back, so simultaneous writers to ONE id lose. Measured on this store, 10
// concurrent putNiche calls for the same key → 8 rejected with a 409, and
// putPromptSnapshot → 9. Every reply writes a prompt snapshot and replies
// routinely discover the same niche, so without serialized persistence a
// parallel run marks whole bursts of replies 'failed'. MemoryStore has no _rev
// and cannot show this — the test has to run on the real store.
test('parallel extraction does not lose writes to same-document contention', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'adscout-race-'));
  const store = new PouchDbStore(dir);
  try {
    await seedPendingReplies(store, 8);
    const result = await extractPendingReplies(
      { store, email: new DummyEmailProvider(), extractor: new Extractor(new SameNicheLlm()), clock, config },
      { concurrency: 8 },
    );
    assert.equal(result.failed, 0, 'a 409 conflict would surface here as a failed reply');
    assert.equal(result.extracted, 8);
    assert.equal((await store.listNiches()).length, 1, 'the shared niche is learned exactly once');
    assert.equal((await store.listPromptSnapshots()).length, 1);
    assert.equal((await store.listPriceRecords()).length, 8, 'every reply still writes its record');
  } finally {
    await store.close?.();
    await rm(dir, { recursive: true, force: true });
  }
});

// A cursor-advancing provider, modelling gmail-api: fetchReplies writes the new
// historyId into pollCursor BEFORE the caller has handled any of the messages it
// returns, and only reports messages newer than that cursor. That's the shape
// that makes an interrupted pass lose mail.
class CursorAdvancingProvider implements EmailProvider {
  readonly name = 'cursor-advancing';
  readonly supportsThreadId = true;
  constructor(
    private readonly store: MemoryStore,
    private readonly inbox: IncomingEmail[],
  ) {}

  async fetchReplies(account: Account): Promise<IncomingEmail[]> {
    const from = Number(account.pollCursor?.historyId ?? '0');
    const fresh = this.inbox.filter((_, i) => i + 1 > from);
    await this.store.updateAccount(account.id, (current) => ({
      ...current,
      pollCursor: { ...current.pollCursor, mailbox: 'INBOX', historyId: String(this.inbox.length) },
    }));
    return fresh;
  }

  async send(): Promise<SendResult> {
    throw new Error('not used');
  }
  async resolveThreadId(): Promise<string | undefined> {
    return undefined;
  }
  async markRead(): Promise<void> {}
  async applyLabel(): Promise<void> {}
}

function inbound(n: number): IncomingEmail {
  return {
    emailId: `msg${n}`,
    rfcMessageId: `<msg${n}@pub.com>`,
    fromAddress: 'info@t1.com',
    subject: 'Re: sponsored post',
    receivedAt: `2026-06-19T12:0${n}:00Z`,
    text: `We can publish. $${n}00.`,
  };
}

// Regression: goracio.smm.manager@gmail.com silently stopped ingesting for ~32h.
// A manual fetch was cut short (the SSE client disconnects → AbortController
// fires), but the provider had already advanced historyId past everything it
// returned, and the pass still committed the cursor. The messages it never got to
// sat behind the cursor and no later pass could ask Gmail for them again — 10
// real replies lost, nothing in the logs. An aborted account must put the cursor
// back so the next pass re-fetches the window.
test('fetch-pass rewinds the cursor when aborted mid-account so no message is stranded', async () => {
  const store = new MemoryStore();
  await seed(store);
  const email = new CursorAdvancingProvider(store, [inbound(1), inbound(2), inbound(3)]);

  // Abort as soon as the first message has been handled.
  const ac = new AbortController();
  const report = await runFetchPass(
    { store, email, clock },
    { signal: ac.signal, onProgress: () => ac.abort() },
  );

  assert.equal(report.fetched, 3);
  assert.equal((await store.listReplies()).length, 1, 'only the first message was handled');

  const mid = await store.getAccount('acc1');
  assert.equal(mid?.pollCursor?.historyId, undefined, 'cursor rewound to its pre-fetch value');
  assert.equal(mid?.pollCursor?.lastPolledAt, undefined, 'an aborted account is not marked polled');

  // The next, uninterrupted pass must still see all three: dedupe absorbs the
  // one already stored and the two stranded ones finally land.
  const second = await runFetchPass({ store, email, clock });
  assert.equal(second.fetched, 3);
  assert.equal(second.deduped, 1);
  assert.equal(
    (await store.listReplies()).map((r) => r.emailId).sort().join(','),
    'msg1,msg2,msg3',
  );
  assert.equal((await store.getAccount('acc1'))?.pollCursor?.historyId, '3');
});
