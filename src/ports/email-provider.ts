// Email port (overview.md §4). Reply-matching does NOT live here — it uses
// fields the provider surfaces in a normalized way (threadId, emailId).

import type { OutcomeLabel } from '../domain/labels';
import type { Account, EmailAttachment, ISO } from '../domain/types';

// Attachments are persisted (base64) on the Reply document and later written to
// disk for the extractor to read. Cap the per-file size so a rogue/huge file
// can't bloat the store — publisher price lists (PDF/XLSX) are tens of KB.
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

/**
 * The decoded total one OUTGOING message may carry, across all its files.
 *
 * Deliberately far below anything a provider would refuse, because three limits
 * sit above it and the smallest is not documented: Gmail's own 25 MB ceiling on
 * a sent message, the 32m nginx allows on the API vhost, and — the binding one —
 * the size at which `messages.send` stops accepting a raw body inline and wants
 * a resumable upload instead. Google's reference does not state that figure, so
 * this cap is set to keep the base64-encoded message (≈ +33%) under 5 MB, which
 * is the lowest value anyone reports for it.
 *
 * The real use is screenshots, at a few hundred KB each. If someone ever needs
 * more than this, the fix is a resumable upload in the Gmail adapter, not a
 * bigger number here.
 */
export const MAX_OUTGOING_ATTACHMENT_TOTAL_BYTES = 3.5 * 1024 * 1024;

/** Sending files is a Gmail-API-only capability. The SMTP adapter throws this
 *  rather than quietly dropping them, and callers check for it BEFORE reserving
 *  an Outreach so a message we know we cannot send is never recorded as failed. */
export class AttachmentsUnsupportedError extends Error {}

export interface OutgoingEmail {
  to: string;
  subject: string;
  body: string;
  rfcMessageId: string; // we set our own Message-Id for exact self-lookup
  account: Account; // sending identity + credentialRef
  /**
   * Files to send alongside the body — screenshots, mostly, on a deal message a
   * person wrote. The cold sequence never sets this.
   *
   * Same shape as the attachments that arrive on a Reply, so one representation
   * covers both directions and the UI renders either with the same component.
   * Supported only by the Gmail API adapter; see AttachmentsUnsupportedError.
   */
  attachments?: EmailAttachment[];
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
  /**
   * The Message-Id we ASKED for. Not necessarily the one the message ended up
   * with: Gmail replaces a self-set Message-Id on send, so for a gmail-api
   * account this identifies our intent and nothing in the mailbox. Anything that
   * has to recognise the message later wants `emailId`.
   */
  rfcMessageId: string;
  threadId?: string; // usually resolved post-send (SMTP returns none)
  /**
   * The provider's OWN id for the message it just sent — the same value
   * `IncomingEmail.emailId` carries when we read that message back. Present for
   * gmail-api, which returns it from messages.send; absent over SMTP, which
   * reports nothing about where the message landed.
   */
  emailId?: string;
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
  /**
   * Can THIS mailbox send files? Asked before a message is reserved, so a send
   * we already know will fail is refused as a client error rather than recorded
   * as a failed outreach.
   *
   * Per-account rather than a readonly flag, because RoutingEmailProvider picks
   * an adapter per account: a gmail-api account that has not finished OAuth
   * falls back to smtp-imap, which refuses. Optional — a provider that does not
   * answer is simply tried, and says so at send time.
   */
  canSendAttachments?(account: Account): boolean;
  fetchReplies(account: Account, since?: Date): Promise<IncomingEmail[]>;
  /**
   * Every message on ONE conversation, ours included — the only read path that
   * returns our own sent mail.
   *
   * It exists for deals. `fetchReplies` reads INBOX (+ Spam) and deliberately
   * excludes SENT, which is right for the extractor — our own pitch must never
   * be mistaken for a publisher's price. But it means a person answering from
   * the Gmail app leaves a hole in the negotiation's timeline, and the deal view
   * is the one place that half of the conversation matters.
   *
   * Kept OFF the polling path on purpose: callers ask for a thread already under
   * an open deal, by id, so nothing we wrote can reach the extractor by widening
   * a mailbox query. Providers with no way to read a thread return [] — the
   * feature degrades to what it was rather than failing a pass.
   */
  fetchThread(account: Account, threadId: string): Promise<IncomingEmail[]>;
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
