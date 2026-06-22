// Pure domain types. These mirror the design doc (overview.md §6). They are
// app-level conventions — not enforced by the (schemaless) storage layer.

export type ID = string;
export type ISO = string; // ISO-8601 timestamp

/** A loose JSON Schema object (used for LLM structured output). */
export type JsonSchema = Record<string, unknown>;

// --- Campaign ---------------------------------------------------------------

export interface Campaign {
  id: ID;
  name: string;
  advertised: { url: string; description: string };
  topic: string;
  format: string;
  inquiryFields: InquiryField[];
  referenceEmail?: string;
  subjectTemplate?: string;
  priceExpectation?: string;
  followUp?: FollowUpPolicy;
  createdAt: ISO;
}

export interface FollowUpPolicy {
  afterDays: number;
  maxFollowUps: number;
  templates?: string[];
}

export type InquiryFieldType = 'price' | 'text' | 'list' | 'enum' | 'boolean';

export interface InquiryField {
  key: string;
  question: string;
  type: InquiryFieldType;
  enumValues?: string[];
  required?: boolean;
}

// --- Account ----------------------------------------------------------------

export type AccountStatus = 'warming' | 'active' | 'paused' | 'cooldown';
export type ProviderType = 'smtp-imap' | 'gmail-api';

export interface Account {
  id: ID;
  email: string;
  providerType: ProviderType;
  credentialRef: string; // .env var NAME — never the secret itself
  senderName: string;
  signature?: string;
  status: AccountStatus;
  createdAt: ISO; // drives the warmup ramp
  maxDailyLimit: number;
  dailyLimitOverride?: number;
  lastError?: string;
  lastErrorAt?: ISO;
  pollCursor?: PollCursor;
}

export interface PollCursor {
  mailbox: string;
  lastUid?: number;
  lastPolledAt?: ISO;
}

// --- Target -----------------------------------------------------------------

export type TargetStatus =
  | 'pending'
  | 'reserved'
  | 'contacted'
  | 'replied'
  | 'bounced'
  | 'needs_review'
  | 'excluded';

export interface Target {
  id: ID;
  campaignId: ID;
  websiteUrl: string;
  contactEmail: string;
  contactName?: string;
  notes?: string;
  status: TargetStatus;
  assignedAccountId?: ID;
  lastOutreachAt?: ISO;
  followUpCount: number;
  result?: OutreachResult;
  createdAt: ISO;
}

// --- Outreach (append-only send attempt) ------------------------------------

export type SendStatus = 'reserved' | 'sent' | 'failed' | 'needs_review';
export type OutreachKind = 'initial' | 'followup';

export interface Outreach {
  id: ID;
  targetId: ID;
  accountId: ID;
  kind: OutreachKind;
  sequenceNo: number; // 0 = initial, 1.. = follow-ups
  status: SendStatus;
  rfcMessageId: string;
  threadId?: string;
  subject: string;
  body: string;
  reservedAt: ISO;
  sentAt?: ISO;
  threadResolvedAt?: ISO;
  attempts: number;
  error?: string;
}

// --- Reply (inbound) --------------------------------------------------------

export type MatchMethod = 'threadId' | 'fromAddress' | 'unmatched';
export type ExtractionStatus = 'pending' | 'done' | 'failed';

export interface Reply {
  id: ID;
  emailId: string; // stable dedupe key
  threadId?: string;
  rfcMessageId: string;
  fromAddress: string;
  targetId?: ID;
  matchMethod: MatchMethod;
  receivedAt: ISO;
  text: string;
  parsed?: OutreachResult;
  extractionStatus: ExtractionStatus;
}

// --- Suppression (persistent do-not-contact list) ---------------------------

export type SuppressionReason = 'opt_out' | 'bounce' | 'manual';

export interface Suppression {
  id: ID; // = normalized email
  email: string;
  reason: SuppressionReason;
  at: ISO;
  note?: string;
}

// --- OutreachResult ---------------------------------------------------------

export type CanPost = 'yes' | 'no' | 'maybe';

export interface OutreachResult {
  canPost: CanPost;
  optOut: boolean;
  conditions?: string;
  notes?: string;
  fields: Record<string, FieldValue>;
}

export type FieldValue =
  | { type: 'price'; amount?: number; currency?: string; raw: string }
  | { type: 'text'; value: string }
  | { type: 'list'; values: string[] }
  | { type: 'enum'; value: string }
  | { type: 'boolean'; value: boolean };
