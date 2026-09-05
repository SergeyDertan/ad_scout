// DummyEmailProvider — no network. Records sent mail, hands out deterministic
// thread ids, and lets tests/demos inject inbound replies. Lets the full
// send→poll→extract pipeline run with no real mailbox.

import { createHash } from 'node:crypto';
import type { OutcomeLabel } from '../../domain/labels';
import type { Account } from '../../domain/types';
import type {
  EmailProvider,
  IncomingEmail,
  OutgoingEmail,
  SendResult,
} from '../../ports/email-provider';

function threadIdFor(rfcMessageId: string): string {
  return 'thr_' + createHash('sha1').update(rfcMessageId).digest('hex').slice(0, 16);
}

export class DummyEmailProvider implements EmailProvider {
  readonly name = 'dummy';
  readonly supportsThreadId = true;

  /** rfcMessageId -> threadId, populated on send. */
  private threads = new Map<string, string>();
  /** Inbound queue, drained by fetchReplies. */
  private inbox: IncomingEmail[] = [];
  /**
   * Everything the mailbox HOLDS, outbound and inbound alike — what fetchThread
   * reads. Separate from `inbox`, which is a queue that drains: a message stays
   * in the mailbox after it has been polled, exactly as a real one does.
   */
  private mailbox: IncomingEmail[] = [];
  private seq = 0;

  /** Every message sent, in order — so tests can assert on threading headers. */
  sent: OutgoingEmail[] = [];

  async send(msg: OutgoingEmail): Promise<SendResult> {
    this.sent.push(msg);
    // A reply joins the thread it names; anything else opens a new one.
    const threadId = msg.threadId ?? threadIdFor(msg.rfcMessageId);
    this.threads.set(msg.rfcMessageId, threadId);
    // Our own copy, as a real mailbox keeps one in Sent.
    this.mailbox.push({
      emailId: `sent_${++this.seq}`,
      threadId,
      rfcMessageId: msg.rfcMessageId,
      fromAddress: msg.account.email,
      subject: msg.subject,
      receivedAt: new Date().toISOString(),
      text: msg.body,
    });
    return { rfcMessageId: msg.rfcMessageId, threadId };
  }

  /** One conversation, ours included. Never drains — see `mailbox`. */
  async fetchThread(_account: Account, threadId: string): Promise<IncomingEmail[]> {
    return this.mailbox.filter((m) => m.threadId === threadId);
  }

  async resolveThreadId(_account: Account, rfcMessageId: string): Promise<string | undefined> {
    return this.threads.get(rfcMessageId);
  }

  /** No mailbox to mutate — record calls so tests can assert on them. */
  markedRead: string[] = [];
  appliedLabels: Array<{ emailId: string; label: OutcomeLabel }> = [];
  async markRead(_account: Account, emailId: string): Promise<void> {
    this.markedRead.push(emailId);
  }
  async applyLabel(_account: Account, emailId: string, label: OutcomeLabel): Promise<void> {
    this.appliedLabels.push({ emailId, label });
  }

  async fetchReplies(_account: Account, since?: Date): Promise<IncomingEmail[]> {
    const cutoff = since?.getTime() ?? 0;
    const ready = this.inbox.filter((m) => new Date(m.receivedAt).getTime() >= cutoff);
    this.inbox = this.inbox.filter((m) => !ready.includes(m));
    return ready;
  }

  // --- test/demo helpers -----------------------------------------------------

  /** Queue a reply on a known thread (the normal case — Gmail threaded it). */
  injectReply(opts: {
    threadId?: string;
    rfcMessageId?: string; // resolve threadId from a prior send
    fromAddress: string;
    subject?: string;
    text: string;
    receivedAt?: Date;
  }): IncomingEmail {
    const threadId =
      opts.threadId ??
      (opts.rfcMessageId ? this.threads.get(opts.rfcMessageId) : undefined);
    const msg: IncomingEmail = {
      emailId: `eml_${++this.seq}`,
      ...(threadId ? { threadId } : {}),
      rfcMessageId: `<reply-${this.seq}@dummy>`,
      fromAddress: opts.fromAddress,
      subject: opts.subject ?? 'Re: outreach',
      receivedAt: (opts.receivedAt ?? new Date()).toISOString(),
      text: opts.text,
    };
    this.inbox.push(msg);
    this.mailbox.push(msg);
    return msg;
  }

  /**
   * A message the OPERATOR sent by hand from their mail client: it lands in the
   * mailbox but never in the inbound queue, which is exactly why the polling
   * path cannot see it. The case fetchThread exists for.
   */
  injectSent(opts: {
    threadId: string;
    fromAddress: string;
    subject?: string;
    text: string;
    rfcMessageId?: string;
    receivedAt?: Date;
  }): IncomingEmail {
    const msg: IncomingEmail = {
      emailId: `eml_${++this.seq}`,
      threadId: opts.threadId,
      rfcMessageId: opts.rfcMessageId ?? `<hand-${this.seq}@gmail>`,
      fromAddress: opts.fromAddress,
      subject: opts.subject ?? 'Re: outreach',
      receivedAt: (opts.receivedAt ?? new Date()).toISOString(),
      text: opts.text,
    };
    this.mailbox.push(msg);
    return msg;
  }
}
