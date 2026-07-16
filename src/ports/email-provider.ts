// Email port (overview.md §4). Reply-matching does NOT live here — it uses
// fields the provider surfaces in a normalized way (threadId, emailId).

import type { Account, EmailAttachment, ISO } from '../domain/types';

// Attachments are persisted (base64) on the Reply document and later written to
// disk for the extractor to read. Cap the per-file size so a rogue/huge file
// can't bloat the store — publisher price lists (PDF/XLSX) are tens of KB.
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

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
  attachments?: EmailAttachment[];
}

export interface EmailProvider {
  readonly name: string;
  /** Gmail (X-GM-THRID) / RFC 8474 OBJECTID THREADID → true. */
  readonly supportsThreadId: boolean;
  send(msg: OutgoingEmail): Promise<SendResult>;
  fetchReplies(account: Account, since?: Date): Promise<IncomingEmail[]>;
  /** Exact self-lookup of our just-sent copy in All Mail to read its threadId. */
  resolveThreadId(account: Account, rfcMessageId: string): Promise<string | undefined>;
  /**
   * Best-effort post-processing of an inbound message we've decided to KEEP:
   * label it as processed and mark it read. Called ONLY for messages matched to
   * a target — never for bounces or unmatched/unknown-sender mail. Callers treat
   * failures as non-fatal. Providers without label support no-op.
   */
  markProcessed(account: Account, emailId: string): Promise<void>;
}
