import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';

import { loadConfig } from '../config';
import { DummyEmailProvider } from '../adapters/email/dummy.provider';
import { DummyLlmProvider } from '../adapters/llm/dummy.provider';
import { MemoryStore } from '../adapters/store/memory.store';
import { LABELS, type OutcomeLabel } from '../domain/labels';
import type { Account, PostOffer, Reply, Target } from '../domain/types';
import { TERM_NONE } from '../domain/terms';
import { systemClock } from '../lib/clock';
import type { ExtractedReply } from '../pipeline/extract-core';
import { Extractor } from '../services/extractor';
import { createRemoteHub, type RemoteHubOptions, type RemoteJob } from './remote-hub';

const config = loadConfig({} as NodeJS.ProcessEnv);
const TOKEN = 'test-token';

async function J(res: Response): Promise<any> {
  return res.json();
}

/** Records what the hub asks the mailbox to do — labeling happens on the HOST,
 *  through the host's email provider, since the worker has no mailbox access. */
class RecordingEmailProvider extends DummyEmailProvider {
  readonly labels: { emailId: string; label: OutcomeLabel }[] = [];
  override async applyLabel(account: Account, emailId: string, label: OutcomeLabel): Promise<void> {
    this.labels.push({ emailId, label });
    await super.applyLabel(account, emailId, label);
  }
}

interface Harness {
  base: string;
  store: MemoryStore;
  email: RecordingEmailProvider;
  close: () => Promise<void>;
}

function reply(over: Partial<Reply> = {}): Reply {
  return {
    id: 'r1',
    emailId: 'm1',
    rfcMessageId: '<m1@x>',
    fromAddress: 'owner@site1.com',
    accountId: 'a1',
    targetId: 't1',
    matchMethod: 'fromAddress',
    receivedAt: '2026-06-02T10:00:00Z',
    text: 'Guest post is $200.',
    extractionStatus: 'pending',
    ...over,
  };
}

async function harness(opts: Partial<RemoteHubOptions> = {}, replies: Reply[] = [reply()]): Promise<Harness> {
  const store = new MemoryStore();
  const account: Account = {
    id: 'a1',
    email: 'vlad@example.com',
    providerType: 'smtp-imap',
    credentialRef: 'VLAD',
    senderName: 'Vlad',
    status: 'active',
    createdAt: '2026-05-01T00:00:00Z',
    maxDailyLimit: 40,
  };
  const target: Target = {
    id: 't1',
    websiteUrl: 'site1.com',
    contactEmail: 'owner@site1.com',
    status: 'contacted',
    followUpCount: 0,
    createdAt: '2026-06-01T00:00:00Z',
  };
  await store.putAccount(account);
  await store.putTarget(target);
  for (const r of replies) await store.putReply(r);

  const email = new RecordingEmailProvider();
  const hub = createRemoteHub(
    {
      store,
      email,
      extractor: new Extractor(new DummyLlmProvider()),
      clock: systemClock,
      config,
    },
    { token: TOKEN, claimWaitMs: 50, ...opts },
  );
  await new Promise<void>((resolve) => hub.server.listen(0, resolve));
  const { port } = hub.server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    store,
    email,
    close: () => new Promise<void>((resolve) => hub.server.close(() => resolve())),
  };
}

function auth(body?: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  };
}

async function claim(h: Harness): Promise<RemoteJob | undefined> {
  const res = await fetch(`${h.base}/work/claim`, auth({ workerId: 'w1', model: 'claude-sonnet-5' }));
  if (res.status === 204) return undefined;
  return (await J(res)).job;
}

const offer: PostOffer = {
  category: 'regular',
  label: 'Regular',
  sensitive: false,
  canPost: 'yes',
  price: { amount: 200, currency: 'USD', raw: '$200' },
  term: TERM_NONE,
};

function extracted(over: { isSpam?: boolean; offers?: PostOffer[] } = {}): ExtractedReply {
  return {
    outcome: {
      result: {
        canPost: 'yes',
        optOut: false,
        offers: over.offers ?? [offer],
        reasoning: 'flat guest post price',
      },
      provenance: {
        provider: 'claude-code',
        model: 'claude-sonnet-5',
        promptHash: 'hash-1',
        promptStyle: 'broad',
      },
      promptSnapshot: { id: 'hash-1', hash: 'hash-1', style: 'broad', text: 'SYSTEM PROMPT' },
      discovered: [],
      review: [],
      isSpam: over.isSpam ?? false,
    },
    ownDomain: 'site1.com',
    senderSiteRejected: false,
  };
}

test('rejects requests without the token, but answers an unauthenticated ping', async () => {
  const h = await harness();
  try {
    assert.equal((await fetch(`${h.base}/status`)).status, 401);
    assert.equal((await fetch(`${h.base}/work/claim`, { method: 'POST' })).status, 401);

    const wrong = await fetch(`${h.base}/status`, { headers: { authorization: 'Bearer nope' } });
    assert.equal(wrong.status, 401);

    const ping = await fetch(`${h.base}/`);
    assert.equal(ping.status, 200);
    assert.equal((await J(ping)).service, 'adscout-remote-hub');
  } finally {
    await h.close();
  }
});

test('a claim carries everything an extraction needs, and is not offered twice', async () => {
  const h = await harness();
  try {
    const job = await claim(h);
    assert.ok(job);
    assert.equal(job.id, 'r1');
    assert.equal(job.site, 'site1.com');
    assert.equal(job.attempt, 1);
    assert.equal(job.input.reply.text, 'Guest post is $200.');
    assert.equal(job.input.target?.websiteUrl, 'site1.com');
    // The HOST's pitch travels with the job — the worker never supplies its own.
    assert.equal(job.input.pitch.topic, config.pitch.topic);
    assert.ok(Array.isArray(job.input.niches));

    // Leased ⇒ a second worker gets nothing rather than the same reply.
    assert.equal(await claim(h), undefined);
  } finally {
    await h.close();
  }
});

test('204 when there is nothing pending', async () => {
  const h = await harness({}, [reply({ extractionStatus: 'done' })]);
  try {
    assert.equal(await claim(h), undefined);
  } finally {
    await h.close();
  }
});

test('a posted result lands through the normal persist path', async () => {
  const h = await harness();
  try {
    const job = await claim(h);
    const res = await fetch(`${h.base}/work/${job!.id}/result`, auth({ extracted: extracted() }));
    assert.equal(res.status, 200);
    assert.deepEqual(await J(res), { outcome: 'done', offers: 1 });

    const stored = (await h.store.listReplies())[0]!;
    assert.equal(stored.extractionStatus, 'done');
    assert.equal(stored.parsed?.offers.length, 1);
    // Provenance survives the round trip — this is what price history is audited on.
    assert.equal(stored.extraction?.provider, 'claude-code');
    assert.equal(stored.extraction?.model, 'claude-sonnet-5');
    assert.equal(stored.extraction?.promptHash, 'hash-1');
    assert.ok(stored.extraction?.extractedAt, 'extractedAt is stamped by the hub, not the worker');

    // The full local pipeline ran: target rollup, price history, prompt archive.
    assert.equal((await h.store.getTarget('t1'))?.status, 'replied');
    const records = await h.store.listPriceRecords();
    assert.equal(records.length, 1);
    assert.equal(records[0]!.domain, 'site1.com');
    assert.equal(records[0]!.offers[0]?.price?.amount, 200);
    const snapshots = await h.store.listPromptSnapshots();
    assert.equal(snapshots.length, 1);
    assert.equal(snapshots[0]!.hash, 'hash-1');

    // Settled ⇒ never offered again.
    assert.equal(await claim(h), undefined);
  } finally {
    await h.close();
  }
});

test('the mailbox is relabelled exactly as a local extraction would', async () => {
  // Done → the intent's label. The worker never touches the mailbox; the hub
  // applies it through the host's own email provider.
  const answered = await harness();
  try {
    const job = await claim(answered);
    await fetch(`${answered.base}/work/${job!.id}/result`, auth({ extracted: extracted() }));
    assert.deepEqual(answered.email.labels, [{ emailId: 'm1', label: LABELS.answered }]);
  } finally {
    await answered.close();
  }

  // Opt-out overrides intent, same as labelForResult().
  const optOut = await harness();
  try {
    const job = await claim(optOut);
    const body = extracted();
    body.outcome.result.optOut = true;
    await fetch(`${optOut.base}/work/${job!.id}/result`, auth({ extracted: body }));
    assert.deepEqual(optOut.email.labels, [{ emailId: 'm1', label: LABELS.unsubscribe }]);
  } finally {
    await optOut.close();
  }

  // Spam → AS/Ignored.
  const spam = await harness();
  try {
    const job = await claim(spam);
    await fetch(`${spam.base}/work/${job!.id}/result`, auth({ extracted: extracted({ isSpam: true }) }));
    assert.deepEqual(spam.email.labels, [{ emailId: 'm1', label: LABELS.ignored }]);
  } finally {
    await spam.close();
  }

  // Out of attempts → the provisional AS/Replied a failed local extraction leaves.
  const failed = await harness({ attempts: 1 });
  try {
    const job = await claim(failed);
    await fetch(`${failed.base}/work/${job!.id}/error`, auth({ message: 'boom' }));
    assert.deepEqual(failed.email.labels, [{ emailId: 'm1', label: LABELS.matched }]);
  } finally {
    await failed.close();
  }
});

test('a usage-limit pause does not relabel anything', async () => {
  const h = await harness();
  try {
    const job = await claim(h);
    await fetch(`${h.base}/work/${job!.id}/error`, auth({ message: 'session limit', usageLimit: true }));
    // The reply is untouched and still pending, so its label must not change.
    assert.deepEqual(h.email.labels, []);
  } finally {
    await h.close();
  }
});

test('a spam verdict ignores the sender and writes no price records', async () => {
  const h = await harness();
  try {
    const job = await claim(h);
    const res = await fetch(`${h.base}/work/${job!.id}/result`, auth({ extracted: extracted({ isSpam: true }) }));
    assert.equal((await J(res)).outcome, 'ignored');

    const stored = (await h.store.listReplies())[0]!;
    assert.equal(stored.extractionStatus, 'skipped');
    assert.equal((await h.store.listPriceRecords()).length, 0);
    assert.equal((await h.store.listIgnore()).length, 1);
  } finally {
    await h.close();
  }
});

test('a malformed result is refused rather than half-written', async () => {
  const h = await harness();
  try {
    const job = await claim(h);
    for (const bad of [
      {},
      { outcome: {} },
      // Missing provenance: would store an untraceable price forever.
      { outcome: { result: { canPost: 'yes', optOut: false, offers: [] }, discovered: [], review: [], isSpam: false }, senderSiteRejected: false },
    ]) {
      const res = await fetch(`${h.base}/work/${job!.id}/result`, auth({ extracted: bad }));
      assert.equal(res.status, 400, JSON.stringify(bad));
    }
    const stored = (await h.store.listReplies())[0]!;
    assert.equal(stored.extractionStatus, 'pending');
    assert.equal(stored.parsed, undefined);
  } finally {
    await h.close();
  }
});

test('stops handing out work once a reply fails every attempt', async () => {
  // Local parity: extractPendingReplies aborts the whole run the first time a
  // reply burns every attempt, because the rest of the queue would hit the same
  // thing. The hub must not quietly grind through 400 replies marking them failed.
  const h = await harness({ attempts: 1 }, [reply(), reply({ id: 'r2', emailId: 'm2', rfcMessageId: '<m2@x>' })]);
  try {
    const job = await claim(h);
    await fetch(`${h.base}/work/${job!.id}/error`, auth({ message: 'claude CLI is broken' }));

    const refused = await fetch(`${h.base}/work/claim`, auth({ workerId: 'w1' }));
    assert.equal(refused.status, 503);
    assert.equal((await J(refused)).stopped, true);

    // The untouched reply stays pending for a later run — it was never spent.
    const r2 = (await h.store.listReplies()).find((r) => r.id === 'r2')!;
    assert.equal(r2.extractionStatus, 'pending');

    const status = await J(await fetch(`${h.base}/status`, { headers: { authorization: `Bearer ${TOKEN}` } }));
    assert.equal(status.aborted, true);
  } finally {
    await h.close();
  }
});

test('--max-failed raises the backstop for multi-machine runs', async () => {
  const h = await harness({ attempts: 1, maxFailed: 2 }, [reply(), reply({ id: 'r2', emailId: 'm2', rfcMessageId: '<m2@x>' })]);
  try {
    const first = await claim(h);
    await fetch(`${h.base}/work/${first!.id}/error`, auth({ message: 'one bad worker' }));
    // One failure is tolerated: the next reply is still handed out.
    const second = await claim(h);
    assert.equal(second?.id, 'r2');
  } finally {
    await h.close();
  }
});

test('errors are retried, then the reply is marked failed', async () => {
  const h = await harness({ attempts: 2 });
  try {
    const first = await claim(h);
    let res = await fetch(`${h.base}/work/${first!.id}/error`, auth({ message: 'claude CLI timed out' }));
    assert.deepEqual(await J(res), { status: 'requeued', attempt: 1, attempts: 2 });
    assert.equal((await h.store.listReplies())[0]!.extractionStatus, 'pending');

    // Re-offered, and the attempt counter carries over.
    const second = await claim(h);
    assert.equal(second?.id, 'r1');
    assert.equal(second?.attempt, 2);

    res = await fetch(`${h.base}/work/${second!.id}/error`, auth({ message: 'claude CLI timed out' }));
    assert.deepEqual(await J(res), { status: 'failed', attempt: 2, attempts: 2 });
    assert.equal((await h.store.listReplies())[0]!.extractionStatus, 'failed');

    // Exhausted ⇒ the backstop trips rather than re-offering it in a loop
    // ('failed' still reads as pending work to isPending).
    const refused = await fetch(`${h.base}/work/claim`, auth({ workerId: 'w1' }));
    assert.equal(refused.status, 503);
  } finally {
    await h.close();
  }
});

test('a usage limit costs no attempt and leaves the reply pending', async () => {
  const h = await harness({ attempts: 2 });
  try {
    const first = await claim(h);
    const res = await fetch(
      `${h.base}/work/${first!.id}/error`,
      auth({ message: "You've hit your session limit", usageLimit: true, resetAt: '2026-06-02T16:20:00Z' }),
    );
    assert.deepEqual(await J(res), { status: 'requeued' });
    assert.equal((await h.store.listReplies())[0]!.extractionStatus, 'pending');

    // Straight back into the queue, still on attempt 1 — the window closing is
    // not this reply's fault, so it must not burn its retries.
    const again = await claim(h);
    assert.equal(again?.id, 'r1');
    assert.equal(again?.attempt, 1);
  } finally {
    await h.close();
  }
});

test('an expired lease re-queues the reply and discards a late result', async () => {
  const h = await harness({ leaseMs: 1 });
  try {
    const first = await claim(h);
    await new Promise((r) => setTimeout(r, 20));

    // Re-offered to whoever asks next…
    const second = await claim(h);
    assert.equal(second?.id, 'r1');

    // …so the abandoned worker's late result must not also be written.
    const late = await fetch(`${h.base}/work/${first!.id}/result`, auth({ extracted: extracted() }));
    assert.equal(late.status, 200, 'the live lease holder owns the reply');
    const dup = await fetch(`${h.base}/work/${first!.id}/result`, auth({ extracted: extracted() }));
    assert.equal(dup.status, 409);
    assert.equal((await h.store.listPriceRecords()).length, 1, 'exactly one price record, not two');
  } finally {
    await h.close();
  }
});

test('a heartbeat holds the lease, and reports when it is gone', async () => {
  const h = await harness({ leaseMs: 60_000 });
  try {
    const job = await claim(h);
    const ok = await fetch(`${h.base}/work/${job!.id}/heartbeat`, auth());
    assert.equal(ok.status, 200);

    const missing = await fetch(`${h.base}/work/nope/heartbeat`, auth());
    assert.equal(missing.status, 409);
  } finally {
    await h.close();
  }
});

test('two replies go to two workers, and status reports the run', async () => {
  const h = await harness({}, [reply(), reply({ id: 'r2', emailId: 'm2', rfcMessageId: '<m2@x>', targetId: undefined })]);
  try {
    const a = await claim(h);
    const b = await claim(h);
    assert.ok(a && b);
    assert.notEqual(a.id, b.id);
    // A targetless reply is normal work, not an error — price history is by domain.
    const targetless = [a, b].find((j) => j.id === 'r2');
    assert.equal(targetless?.input.target, undefined);

    const status = await J(await fetch(`${h.base}/status`, { headers: { authorization: `Bearer ${TOKEN}` } }));
    assert.equal(status.claimed, 2);
    assert.equal(status.inFlight.length, 2);
    assert.equal(status.workers[0].id, 'w1');
  } finally {
    await h.close();
  }
});
