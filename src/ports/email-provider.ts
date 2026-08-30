// Email port (overview.md §4). Reply-matching does NOT live here — it uses
// fields the provider surfaces in a normalized way (threadId, emailId).

import type { OutcomeLabel } from '../domain/labels';
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
  /**
   * Reply threading. All three are set together or not at all, and only for a
   * message that continues an existing conversation.
   *
   * `inReplyTo`/`references` are the RFC 5322 headers every mail client threads
   * on. `threadId` is the provider's own id, which Gmail additionally requires
   * in the send request: with the headers but no threadId it grafts the message
   * onto the thread only sometimes, and with neither it silently starts a new
   * one. Belt and braces is the only reliable combination.
   */
  inReplyTo?: string;
  references?: string[];
  threadId?: string;
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
   * Clear the UNREAD flag on an inbound message. Called for EVERY message the
   * pipeline ingests — read means "the system fetched and saw this". Best-effort;
   * callers treat failures as non-fatal. Providers without mailbox mutation no-op.
   */
  markRead(account: Account, emailId: string): Promise<void>;
  /**
   * Apply a single decision label to an inbound message, replacing any other
   * managed label it already carries (a message holds exactly one AS/ label at a
   * time). Best-effort. Providers without label support no-op.
   */
  applyLabel(account: Account, emailId: string, label: OutcomeLabel): Promise<void>;
}
