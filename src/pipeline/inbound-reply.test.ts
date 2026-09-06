// The Reply builder both passes share. These tests exist because the two passes
// used to build the document separately and drifted apart in silence.

import test from 'node:test';
import assert from 'node:assert/strict';

import type { Account, Deal } from '../domain/types';
import type { IncomingEmail } from '../ports/email-provider';
import { buildInboundReply } from './inbound-reply';

const account: Account = {
  id: 'acc1', email: 'vlad@example.com', providerType: 'smtp-imap', credentialRef: 'VLAD',
  senderName: 'Vlad', status: 'active', createdAt: '2026-08-01T00:00:00Z', maxDailyLimit: 40,
};

const deal: Deal = {
  id: 'deal1', counterpartyEmail: 'admin@t1.com', accountId: 'acc1', status: 'negotiation',
  origin: 'manual', openedAt: '2026-08-19T00:00:00Z',
};

function msg(over: Partial<IncomingEmail> = {}): IncomingEmail {
  return {
    emailId: 'eml1',
    threadId: 'thr1',
    rfcMessageId: '<m1@pub.com>',
    fromAddress: 'admin@t1.com',
    subject: 'Invoice for your article',
    receivedAt: '2026-09-03T00:27:52.000Z',
    text: 'your invoice is attached',
    ...over,
  };
}

const invoice = {
  filename: 'invoice-4471.pdf',
  mimeType: 'application/pdf',
  size: 3,
  contentBase64: Buffer.from('pdf').toString('base64'),
};

test('everything the message carried survives being stored', () => {
  const reply = buildInboundReply({
    account,
    msg: msg({ attachments: [invoice] }),
    match: { targetId: 't1', method: 'threadId' },
  });

  assert.deepEqual(reply.attachments, [invoice]);
  assert.equal(reply.subject, 'Invoice for your article');
  assert.equal(reply.accountId, 'acc1');
  assert.equal(reply.threadId, 'thr1');
  assert.equal(reply.targetId, 't1');
  assert.equal(reply.extractionStatus, 'pending');
  assert.equal(reply.dealId, undefined);
});

test("a held thread's message is skipped and stamped with the deal, whatever its body", () => {
  const reply = buildInboundReply({
    account,
    msg: msg(),
    match: { targetId: 't1', method: 'threadId' },
    deal,
  });

  assert.equal(reply.extractionStatus, 'skipped', 'must never enter the extraction queue');
  assert.equal(reply.dealId, 'deal1');
});

// Was the one real behaviour change in unifying the two builders: poll-pass
// stored an UNMATCHED empty reply as 'pending', which queued a body with nothing
// in it for the model. Emptiness is a property of the message, not of whether we
// could name a target.
test('an empty body is skipped even when it matched no target', () => {
  const matched = buildInboundReply({
    account, msg: msg({ text: '   ' }), match: { targetId: 't1', method: 'threadId' },
  });
  const unmatched = buildInboundReply({
    account, msg: msg({ text: '' }), match: { method: 'unmatched' },
  });

  assert.equal(matched.extractionStatus, 'skipped');
  assert.equal(unmatched.extractionStatus, 'skipped');
  assert.equal(unmatched.targetId, undefined);
});

test('absent optional fields are omitted, not stored as undefined', () => {
  const reply = buildInboundReply({
    account,
    msg: { emailId: 'e', rfcMessageId: '<m@x>', fromAddress: 'a@b.com', subject: '', receivedAt: '2026-09-03T00:00:00Z', text: 'hi' },
    match: { method: 'unmatched' },
  });

  for (const key of ['threadId', 'subject', 'targetId', 'attachments', 'dealId']) {
    assert.equal(key in reply, false, `${key} should be absent`);
  }
});
