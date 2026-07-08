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

export interface OAuthTokens {
  refreshToken: string;
  accessToken?: string;
  accessTokenExpiresAt?: ISO;
}

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
  oauthTokens?: OAuthTokens; // present for gmail-api accounts after OAuth flow
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

/** A file attached to an inbound email. Content is base64 so it serializes into
 *  JSON (IncomingEmail transport + persisted Reply document) without a Buffer. */
export interface EmailAttachment {
  filename: string;
  mimeType: string;
  size: number; // decoded byte length
  contentBase64: string;
}

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
  attachments?: EmailAttachment[];
  parsed?: OutreachResult;
  extractionStatus: ExtractionStatus;
  /** Human-readable reasons the AI could not fully process this reply (e.g. an
   *  unreadable attachment type, an unreachable link). Present ⇒ needs a human
   *  to review/correct it. Cleared when someone edits the result by hand. */
  review?: string[];
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

/** A parsed price (shared by PostOffer and the 'price' FieldValue). */
export interface PriceValue {
  amount?: number;
  currency?: string;
  raw: string;
}

/**
 * A canonical post category the publisher prices separately. The seed set lives in
 * domain/niches.ts; new ones are learned from replies and persisted as `niche` docs.
 */
export interface Niche {
  key: string; // canonical id, e.g. 'short_term_loans' (also the doc id)
  label: string; // human label, e.g. 'Short-term loans'
  sensitive: boolean; // rolls under the 'sensitive' umbrella for filtering
  aliases: string[]; // owner phrasings seen for this niche (grows over time)
  createdAt?: ISO; // set when learned (seed niches have none)
}

/** Willingness + price for ONE niche the owner addressed in the reply. */
export interface PostOffer {
  category: string; // niche key
  label: string; // niche label at extraction time (display convenience)
  sensitive: boolean; // copied from the niche — lets the UI filter without the registry
  canPost: CanPost;
  price?: PriceValue;
}

/**
 * What kind of reply this is, so a holding/auto message isn't mistaken for a
 * real answer. `answer` = substantive (prices/willingness/decline given);
 * `holding` = "we'll get back to you"; `auto_reply` = OOO/autoresponder;
 * `question` = they asked us something; `decline` = not interested; `other`.
 */
export type ReplyIntent = 'answer' | 'holding' | 'auto_reply' | 'question' | 'decline' | 'other';

/** Intents that mean "no substantive answer yet" — keep chasing the real reply. */
export const AWAITING_INTENTS: ReplyIntent[] = ['holding', 'auto_reply'];

export interface OutreachResult {
  /** Summary for the niche we asked about (umbrella-resolved). Back-compat field. */
  canPost: CanPost;
  optOut: boolean;
  /** Classified reply intent (answer vs holding/auto/…). Defaults to 'answer'. */
  intent?: ReplyIntent;
  /** The niche key the campaign asked about, if we could map its topic. */
  requestedCategory?: string;
  /** Every priced post type found in the reply — the core of the extraction. */
  offers: PostOffer[];
  /** One short line on why the AI classified the offers this way (shown in the UI). */
  reasoning?: string;
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
