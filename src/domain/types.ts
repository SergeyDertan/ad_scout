// Pure domain types. These mirror the design doc (overview.md §6). They are
// app-level conventions — not enforced by the (schemaless) storage layer.

export type ID = string;
export type ISO = string; // ISO-8601 timestamp

/** A loose JSON Schema object (used for LLM structured output). */
export type JsonSchema = Record<string, unknown>;

// --- Pitch profile ----------------------------------------------------------

/**
 * The "what & how" of an outreach email: the site we advertise, the topic/format
 * we pitch, and an optional subject override. Global defaults live in Config; a
 * Batch may override `advertised` per import. Resolved via resolveProfile().
 */
export interface PitchProfile {
  advertised: { url: string; description: string };
  topic: string;
  format: string;
  subjectTemplate?: string;
}

// --- Account ----------------------------------------------------------------

export type AccountStatus = 'active' | 'paused' | 'cooldown';
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
  // Gmail mailbox change-sequence position (users.history startHistoryId). Owned
  // by the gmail-api provider for exact, gapless incremental sync; the SMTP/IMAP
  // path ignores it and uses lastPolledAt instead. See GmailApiProvider.
  historyId?: string;
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
  /** Groups targets added together — one bulk import, or a single manual add.
   *  Assigned at creation and shared across every row of the same import. The
   *  batch also carries the per-import advertised site (else global defaults). */
  batchId?: ID;
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

// --- Batch (a group of targets added together) ------------------------------

/** How a batch came to be: a bulk import, or a single manual "Add target". */
export type BatchSource = 'import' | 'manual';

/**
 * A batch is created once when targets are added — a bulk import (named by the
 * user), or a lone manual add (unnamed, source 'manual'). Every Target carries
 * this record's id in `batchId`. Live target count/status is derived from the
 * targets at read time, so it's never stored here (it can't drift).
 */
export interface Batch {
  id: ID;
  name?: string; // user-given label for an import; absent for manual adds
  source: BatchSource;
  /** Per-import advertised site override. Absent ⇒ the global config default is
   *  used when drafting. This is the only pitch field that varies per import. */
  advertised?: { url: string; description: string };
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
// 'skipped' = deliberately not AI-extracted (the target was already answered);
// the reply is saved for the record but never enters the extraction queue.
export type ExtractionStatus = 'pending' | 'done' | 'failed' | 'skipped';

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

/** A parsed price attached to a PostOffer. */
export interface PriceValue {
  amount?: number;
  /** Normalized ISO code (USD/EUR/GBP/…), set ONLY when the token maps confidently. */
  currency?: string;
  /** The currency token EXACTLY as written ("£", "zł", "R$", "грн"), captured whenever
   *  any currency indicator sits by the amount — even one we can't normalize yet, so it
   *  can be resolved later. Superset of `currency`; absent only when no token was found. */
  currencyRaw?: string;
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

/** Willingness + price for ONE (post type × niche) the owner addressed. */
export interface PostOffer {
  postType: string; // product ladder: 'guest_post' | 'link_insertion' | 'banner' (fixed enum)
  category: string; // niche key
  label: string; // niche label at extraction time (display convenience)
  sensitive: boolean; // copied from the niche — lets the UI filter without the registry
  canPost: CanPost;
  price?: PriceValue;
  /** The site the owner tagged this offer with, ONLY when they priced a DIFFERENT
   *  site they also own (M2). Blank/absent ⇒ the contacted site. Used by the
   *  ingest phase to group offers into per-domain PriceRecords, then it is implied
   *  by the record's `domain` (kept here for provenance). */
  website?: string;
  /** Time-limited promo price. A special does NOT overwrite the standing cell —
   *  both coexist; the derived price sheet surfaces the promo separately (D5). */
  isSpecial?: boolean;
  /** Optional deadline the owner gave for a special. Expired ⇒ drops from active. */
  specialUntil?: ISO;
}

// --- Price history (append-only, per domain) --------------------------------

/**
 * One observation of a domain's posting terms, as a single inbound message
 * stated them (PRICE-HISTORY-PLAN.md §3.1). Append-only and event-shaped: it
 * carries ONLY the cells that message mentioned. The "current price sheet" and
 * the known-domains list are DERIVED from these records at read time, never
 * stored (D1/D2).
 */
export interface PriceRecord {
  id: ID; // newId('pricerecord')
  domain: string; // normalizeDomain(...) — the index key
  offers: PostOffer[]; // ONLY the cells this message said; [] = "can post, no price"
  optOut?: boolean; // rare; opt-out is email-level, kept for completeness
  observedAt: ISO; // the "date" of this observation
  sourceEmail: string; // normalized from-address
  sourceMessageId: string; // reply.rfcMessageId
  replyId?: ID; // provenance → Reply
  targetId?: ID; // set when domain == the contacted target's site
  attribution: 'sender' | 'named'; // M1 (sender's domain) vs M2 (owner-tagged site) — D4
}

// --- Ignore list (inbound skip) ---------------------------------------------

/**
 * A sender we drop before doing any work — spam / automated senders (D6/D7).
 * `kind:'email'` matches an exact from-address; `kind:'domain'` matches the
 * sender ADDRESS domain (e.g. facebook.com). Checked at the top of message
 * handling, replacing any regex prefilter.
 */
export interface IgnoreEntry {
  id: ID; // `${kind}:${value}` (normalized) — natural key
  kind: 'email' | 'domain';
  value: string; // normalized email, or bare sender-address domain
  reason: string; // AI reason (spam) or human note
  emailId?: string; // the message that triggered it — for manual review (D7)
  at: ISO;
}

// --- Domain exclusion (outbound do-not-contact by website domain) ------------

/**
 * A website domain we won't contact (D8). Distinct from email-level suppression:
 * a blanket `intent:'decline'` excludes the DOMAIN; a per-cell `canPost:'no'` is
 * just a price cell, not an exclusion. A later positive record lifts it (D10).
 */
export interface DomainExclusion {
  id: ID; // = normalized domain
  domain: string;
  reason: 'declined' | 'manual';
  sourceReplyId?: ID; // provenance
  at: ISO;
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
}
