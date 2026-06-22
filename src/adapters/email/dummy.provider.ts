// DummyEmailProvider — no network. Records sent mail, hands out deterministic
// thread ids, and lets tests/demos inject inbound replies. Lets the full
// send→poll→extract pipeline run with no real mailbox.

import { createHash } from 'node:crypto';
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
  private seq = 0;

  async send(msg: OutgoingEmail): Promise<SendResult> {
    const threadId = threadIdFor(msg.rfcMessageId);
    this.threads.set(msg.rfcMessageId, threadId);
    return { rfcMessageId: msg.rfcMessageId, threadId };
  }

  async resolveThreadId(_account: Account, rfcMessageId: string): Promise<string | undefined> {
    return this.threads.get(rfcMessageId);
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
    return msg;
  }
}
