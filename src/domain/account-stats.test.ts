import test from 'node:test';
import assert from 'node:assert/strict';
import { accountStats } from './account-stats';
import { engagementOf, outcomesOf } from './engagement';
import type { Account, Outreach, Target, TargetStatus } from './types';
import { TERM_NONE } from './terms';

const A = 'acc1';
const B = 'acc2';

function account(id = A): Account {
  return {
    id,
    email: `${id}@x.com`,
    providerType: 'gmail-api',
    credentialRef: 'X',
    senderName: id,
    status: 'active',
    createdAt: new Date(2026, 0, 1).toISOString(),
    maxDailyLimit: 40,
  };
}

let seq = 0;
function out(over: Partial<Outreach> & { accountId: string }): Outreach {
  seq++;
  return {
    id: `o${seq}`,
    targetId: `t${seq}`,
    kind: 'initial',
    sequenceNo: 0,
    status: 'sent',
    rfcMessageId: `m${seq}`,
    subject: 's',
    body: 'b',
    reservedAt: '2026-06-19T10:00:00.000Z',
    sentAt: '2026-06-19T10:00:00.000Z',
    attempts: 1,
    ...over,
  };
}

function target(id: string, status: TargetStatus, over?: Partial<Target>): Target {
  return {
    id,
    websiteUrl: `${id}.com`,
    contactEmail: `a@${id}.com`,
    status,
    assignedAccountId: A,
    followUpCount: 0,
    createdAt: '2026-06-01T00:00:00.000Z',
    ...over,
  };
}

// --- Volume: counted off the Outreach log, by accountId ----------------------

test('messagesSent counts only what left the building, split by kind', () => {
  const s = accountStats(
    account(),
    [
      out({ accountId: A, kind: 'initial' }),
      out({ accountId: A, kind: 'followup', sequenceNo: 1 }),
      out({ accountId: A, kind: 'followup', sequenceNo: 2 }),
      out({ accountId: A, kind: 'manual' }),
      out({ accountId: A, status: 'failed' }),
      out({ accountId: A, status: 'reserved', sentAt: undefined }),
      out({ accountId: B }), // another mailbox entirely
    ],
    [],
    new Set(),
  );
  assert.equal(s.messagesSent, 4);
  assert.equal(s.initials, 1);
  assert.equal(s.followUps, 2);
  assert.equal(s.manual, 1);
  assert.equal(s.failed, 1);
  assert.equal(s.reserved, 1);
  assert.equal(s.initials + s.followUps + s.manual, s.messagesSent);
});

test('lastSentAt is the newest send, and absent for a mailbox that never sent', () => {
  const s = accountStats(
    account(),
    [
      out({ accountId: A, sentAt: '2026-06-01T09:00:00.000Z' }),
      out({ accountId: A, sentAt: '2026-06-19T14:00:00.000Z' }),
      out({ accountId: A, sentAt: '2026-06-10T09:00:00.000Z' }),
      out({ accountId: B, sentAt: '2026-07-01T09:00:00.000Z' }), // not ours
    ],
    [],
    new Set(),
  );
  assert.equal(s.lastSentAt, '2026-06-19T14:00:00.000Z');

  const fresh = accountStats(account(), [out({ accountId: A, status: 'reserved', sentAt: undefined })], [], new Set());
  assert.equal(fresh.lastSentAt, undefined);
});

// --- Reach: counted over the targets the mailbox OWNS -------------------------

test('the funnel covers the targets this mailbox owns, and nobody else’s', () => {
  const targets = [
    target('t1', 'contacted'),
    target('t2', 'replied'),
    target('t3', 'bounced'),
    target('t4', 'contacted', { assignedAccountId: B }),
    target('t5', 'pending', { assignedAccountId: undefined }), // owned by no one yet
  ];
  const s = accountStats(account(), [], targets, new Set());
  assert.equal(s.engagement.contacted, 1);
  assert.equal(s.engagement.answered, 1);
  assert.equal(s.engagement.bounced, 1);
  assert.equal(s.targetsContacted, 3);
});

test('a reserved or reverted-to-pending target is the account’s backlog, not a contact', () => {
  const targets = [
    target('t1', 'contacted'),
    target('t2', 'reserved'), // drafted, still in flight
    target('t3', 'pending'), // send failed and reverted; assignment stuck
  ];
  const s = accountStats(account(), [], targets, new Set());
  assert.equal(s.engagement.queued, 2);
  assert.equal(s.targetsContacted, 1);
});

test('a follow-up from another mailbox counts as its volume but stays in the owner’s funnel', () => {
  const targets = [target('t1', 'replied')]; // owned by A
  const outreaches = [
    out({ accountId: A, targetId: 't1', kind: 'initial' }),
    out({ accountId: B, targetId: 't1', kind: 'followup', sequenceNo: 1 }),
  ];
  const a = accountStats(account(A), outreaches, targets, new Set());
  const b = accountStats(account(B), outreaches, targets, new Set());

  assert.equal(a.messagesSent, 1);
  assert.equal(b.messagesSent, 1); // B really did send a mail
  assert.equal(a.engagement.replied, 1); // …but A opened it, so A owns the reply
  assert.equal(b.engagement.replied, 0);
  assert.equal(b.targetsContacted, 0);
});

// --- Rates -------------------------------------------------------------------

test('bounceRate is over everyone contacted; replyRate excludes the bounces', () => {
  // 10 contacted: 2 bounced, 4 replied, 4 silent. Reply rate is 4/8, not 4/10 —
  // a dead address never had the chance to answer.
  const targets = [
    ...Array.from({ length: 2 }, (_, i) => target(`b${i}`, 'bounced')),
    ...Array.from({ length: 4 }, (_, i) => target(`r${i}`, 'replied')),
    ...Array.from({ length: 4 }, (_, i) => target(`c${i}`, 'contacted')),
  ];
  const s = accountStats(account(), [], targets, new Set());
  assert.equal(s.targetsContacted, 10);
  assert.equal(s.bounceRate, 0.2);
  assert.equal(s.replyRate, 0.5);
});

test('rates are 0, never NaN, for a mailbox that has not contacted anyone', () => {
  const s = accountStats(account(), [], [], new Set());
  assert.equal(s.bounceRate, 0);
  assert.equal(s.replyRate, 0);
  assert.equal(s.targetsContacted, 0);
});

test('an all-bounced mailbox has no reply denominator left, and reads 0 rather than NaN', () => {
  const s = accountStats(account(), [], [target('t1', 'bounced')], new Set());
  assert.equal(s.bounceRate, 1);
  assert.equal(s.replyRate, 0);
});

// --- The whole point: the parts add up to the whole ---------------------------

test('per-account funnels partition the global funnel', () => {
  const targets = [
    target('t1', 'contacted'),
    target('t2', 'replied'),
    target('t3', 'bounced'),
    target('t4', 'excluded'),
    target('t5', 'contacted', { assignedAccountId: B }),
    target('t6', 'replied', { assignedAccountId: B }),
    target('t7', 'pending', { assignedAccountId: undefined }), // unassigned
  ];
  const replied = new Set(['t4']); // t4 opted out rather than being suppressed by hand
  const global = engagementOf(targets, replied);
  const a = accountStats(account(A), [], targets, replied).engagement;
  const b = accountStats(account(B), [], targets, replied).engagement;

  for (const k of ['contacted', 'answered', 'bounced', 'optedOut', 'excluded', 'replied'] as const) {
    assert.equal(a[k] + b[k], global[k], `bucket ${k} does not reconcile`);
  }
  // Only the unassigned target is missing from the per-account split.
  assert.equal(a.queued + b.queued + 1, global.queued);
});

test('outcomes are scoped to the owning mailbox too', () => {
  const priced = (id: string, owner: string): Target =>
    target(id, 'replied', {
      assignedAccountId: owner,
      result: {
        intent: 'answer',
        canPost: 'yes',
        optOut: false,
        offers: [
          {
            category: 'casino',
            label: 'Casino',
            sensitive: true,
            canPost: 'yes',
            price: { amount: 300, currency: 'USD', raw: '$300' },
            term: TERM_NONE,
          },
        ],
      },
    });
  const targets = [priced('t1', A), priced('t2', A), priced('t3', B)];
  assert.equal(accountStats(account(A), [], targets, new Set()).outcomes.priced, 2);
  assert.equal(accountStats(account(B), [], targets, new Set()).outcomes.priced, 1);
  assert.equal(outcomesOf(targets).priced, 3);
});
