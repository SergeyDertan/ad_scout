// Email port (overview.md §4). Reply-matching does NOT live here — it uses
// fields the provider surfaces in a normalized way (threadId, emailId).

import type { Account, ISO } from '../domain/types';

export interface OutgoingEmail {
  to: string;
  subject: string;
  body: string;
  rfcMessageId: string; // we set our own Message-Id for exact self-lookup
  account: Account; // sending identity + credentialRef
}

export interface SendResult {
  rfcMessageId: string;
  threadId?: string; // usually resolved post-send (SMTP returns none)
}

export interface IncomingEmail {
  emailId: string; // X-GM-MSGID / OBJECTID EMAILID — stable dedupe key
  threadId?: string;
  rfcMessageId: string;
  fromAddress: string;
  subject: string;
  receivedAt: ISO;
  text: string;
}

export interface EmailProvider {
  readonly name: string;
  /** Gmail (X-GM-THRID) / RFC 8474 OBJECTID THREADID → true. */
  readonly supportsThreadId: boolean;
  send(msg: OutgoingEmail): Promise<SendResult>;
  fetchReplies(account: Account, since?: Date): Promise<IncomingEmail[]>;
  /** Exact self-lookup of our just-sent copy in All Mail to read its threadId. */
  resolveThreadId(account: Account, rfcMessageId: string): Promise<string | undefined>;
}
