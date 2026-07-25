// Client-side mirror of the server domain types (src/domain/types.ts) — only
// the fields the UI reads/writes. Kept deliberately small.

export type CanPost = 'yes' | 'no' | 'maybe';

export interface PriceValue {
  amount?: number;
  /** Normalized ISO code, set only when confidently mapped. */
  currency?: string;
  /** Currency token as written — superset of `currency`, present even for currencies
   *  we can't normalize yet. Prefer `currency ?? currencyRaw` when labelling a price. */
  currencyRaw?: string;
  raw: string;
}

export interface PostOffer {
  postType: string; // 'guest_post' | 'link_insertion' | 'banner' (fixed enum, may be absent on legacy rows)
  category: string;
  label: string;
  sensitive: boolean;
  canPost: CanPost;
  price?: PriceValue;
  website?: string;
  isSpecial?: boolean;
  specialUntil?: string;
}

/** Display labels for the fixed product enum. */
export const POST_TYPE_LABELS: Record<string, string> = {
  guest_post: 'Guest post',
  link_insertion: 'Link insertion',
  banner: 'Banner',
};

export function postTypeLabel(key?: string): string {
  if (!key) return POST_TYPE_LABELS.guest_post; // legacy rows had no product axis
  return POST_TYPE_LABELS[key] ?? key;
}

/** A post-category the taxonomy knows about (seed or learned). Mirrors domain Niche. */
export interface Niche {
  key: string;
  label: string;
  sensitive: boolean;
  aliases: string[];
  createdAt?: string;
}

/** Format an offer's price for display: "$150", "150 EUR", or "—". */
export function formatPrice(price?: PriceValue): string {
  if (!price) return '—';
  if (price.amount !== undefined) {
    const cur = price.currency ?? price.currencyRaw;
    return cur ? `${price.amount} ${cur}` : String(price.amount);
  }
  return price.raw || '—';
}

/**
 * Two-way umbrella filter (mirrors domain/niches.ts offerMatchesFilter):
 *  - exact category, OR
 *  - filtering the 'sensitive' umbrella matches any sensitive offer, OR
 *  - filtering a sensitive child (casino) also matches a generic 'sensitive' offer.
 */
export function offerMatchesFilter(offer: PostOffer, filterKey: string, niches: Niche[]): boolean {
  if (offer.category === filterKey) return true;
  if (filterKey === 'sensitive') return offer.sensitive;
  const target = niches.find((n) => n.key === filterKey);
  if ((filterKey === 'sensitive' || target?.sensitive) && offer.category === 'sensitive') return true;
  return false;
}

/**
 * The product ladder an offer is priced against — guest post vs link insertion
 * vs banner. Publishers price these separately, so a sensitive/grey offer only
 * compares to its own product. Reads the real postType axis (legacy rows without
 * one fall back to the guest-post ladder).
 */
function offerProductTier(offer: PostOffer): string {
  return offer.postType || 'guest_post';
}

/**
 * Sensitive (grey-niche) offers should never be cheaper than a regular offer of
 * the SAME product tier — a sensitive post ≥ a regular post, a sensitive link
 * insertion ≥ a regular link insertion. When a non-sensitive offer is priced
 * ABOVE its sensitive counterpart, that ordering is inverted — usually an
 * extraction error (e.g. a flattened price table read the two tiers backwards),
 * occasionally a genuinely odd publisher. Either way it's worth a human glance.
 *
 * Crucially the comparison is per-tier: a full post (say $170) must NOT be
 * compared against a sensitive *link insertion* ($150), or an ordinary
 * post-cheaper-than-its-sensitive-post listing would wrongly trip the flag.
 *
 * Returns the set of non-sensitive offer categories that exceed the cheapest
 * sensitive price in their tier (empty = no anomaly). Skipped when the priced
 * offers mix currencies, since cross-currency amounts aren't comparable.
 *
 * Comparison is also per-SITE: one reply often prices a whole portfolio (the
 * sender's site plus other domains they own, tagged via `offer.website`), and
 * those are independent rate cards. A $180 regular post on one domain says
 * nothing about a $130 sensitive post on another, so bucketing by site keeps
 * a pricier site from flagging a cheaper one.
 *
 * Returns a set of CELL keys ("site|postType|category") so only the offending
 * cell is flagged — a regular guest post priced above a sensitive guest post
 * must not also highlight the regular link-insertion row. Use `offerCellKey`.
 */
export function offerSite(offer: PostOffer): string {
  return offer.website?.trim().toLowerCase() ?? '';
}

export function offerCellKey(offer: PostOffer): string {
  return `${offerSite(offer)}|${offer.postType || 'guest_post'}|${offer.category}`;
}

export function invertedPriceOffers(offers?: PostOffer[]): Set<string> {
  const flagged = new Set<string>();
  const priced = (offers ?? []).filter((o) => o.price?.amount !== undefined);
  if (priced.length < 2) return flagged;

  const currencies = new Set(priced.map((o) => o.price?.currency).filter(Boolean));
  if (currencies.size > 1) return flagged; // not comparable

  // Bucket by site × product tier, then compare regular vs sensitive within each.
  const tiers = new Map<string, PostOffer[]>();
  for (const o of priced) {
    const tier = `${offerSite(o)}|${offerProductTier(o)}`;
    (tiers.get(tier) ?? tiers.set(tier, []).get(tier)!).push(o);
  }

  for (const group of tiers.values()) {
    const sensitive = group.filter((o) => o.sensitive);
    const regular = group.filter((o) => !o.sensitive);
    if (!sensitive.length || !regular.length) continue;

    const minSensitive = Math.min(...sensitive.map((o) => o.price!.amount!));
    for (const o of regular) {
      if (o.price!.amount! > minSensitive) flagged.add(offerCellKey(o));
    }
  }
  return flagged;
}

export type AccountStatus = 'active' | 'paused' | 'cooldown';
export type ProviderType = 'smtp-imap' | 'gmail-api';

export interface Account {
  id: string;
  email: string;
  providerType: ProviderType;
  credentialRef: string;
  senderName: string;
  signature?: string;
  status: AccountStatus;
  createdAt: string;
  maxDailyLimit: number;
  dailyLimitOverride?: number;
  lastError?: string;
  oauthConnected?: boolean; // gmail-api accounts: true after OAuth flow completes
  state?: AccountSendState; // live, server-derived send state (GET /api/accounts)
}

/** Live per-account send state derived on the server from the Outreach log +
 *  config. Mirrors src/domain/account-state.ts. */
export interface AccountSendState {
  sentToday: number; // sends today (local calendar day) — what the limiter uses
  limit: number; // effective daily cap right now
  remaining: number; // how many more may send right now
  warming: boolean; // still climbing the warmup ramp
  overridden: boolean; // a manual dailyLimitOverride is in force
  rampTarget: number; // warmup target (maxDailyLimit)
  ageDays: number; // account age in whole days
  windowActive: boolean; // send window open now?
  gapMs: number | null; // current drip gap between sends (null when idle)
  perHour: number | null; // same rate as sends/hour (null when idle)
  projectedToday: number; // total sends expected today given time left in window
}

export type TargetStatus =
  | 'pending'
  | 'reserved'
  | 'contacted'
  | 'replied'
  | 'bounced'
  | 'needs_review'
  | 'excluded';

export interface Target {
  id: string;
  batchId?: string;
  websiteUrl: string;
  contactEmail: string;
  contactName?: string;
  notes?: string;
  status: TargetStatus;
  followUpCount: number;
  result?: {
    canPost?: string;
    requestedCategory?: string;
    offers?: PostOffer[];
    reasoning?: string;
  };
  createdAt: string;
}


export type SendStatus = 'reserved' | 'sent' | 'failed' | 'needs_review';
export type OutreachKind = 'initial' | 'followup';

export interface Outreach {
  id: string;
  targetId: string;
  accountId: string;
  kind: OutreachKind;
  sequenceNo: number;
  status: SendStatus;
  subject: string;
  body: string;
  reservedAt: string;
  sentAt?: string;
  error?: string;
}

export interface ThreadReply {
  id: string;
  fromAddress: string;
  receivedAt: string;
  text: string;
  matchMethod: 'threadId' | 'fromAddress' | 'unmatched';
}

export interface EmailAttachment {
  filename: string;
  mimeType: string;
  size: number;
  contentBase64: string;
}

export interface ResponseRow {
  id: string;
  fromAddress: string;
  website?: string;
  batchId?: string;
  batchName?: string;
  matchMethod: 'threadId' | 'fromAddress' | 'unmatched';
  extractionStatus: 'pending' | 'done' | 'failed' | 'skipped';
  review?: string[];
  // Present on every reply the server returns (spread from the stored Reply).
  targetId?: string;
  threadId?: string;
  receivedAt?: string;
  text?: string;
  attachments?: EmailAttachment[];
  parsed?: {
    canPost: string;
    requestedCategory?: string;
    offers?: PostOffer[];
    reasoning?: string;
    optOut?: boolean;
    intent?: string;
  };
}

/** True when a reply warrants a human look: the AI flagged unprocessable content,
 *  or the prices are inverted (regular dearer than sensitive). */
export function needsReview(row: {
  review?: string[];
  parsed?: { offers?: PostOffer[] };
}): boolean {
  return (row.review?.length ?? 0) > 0 || invertedPriceOffers(row.parsed?.offers).size > 0;
}

/** Reply intents that acknowledge but don't answer — the target stays 'contacted'
 *  and follow-ups keep chasing. Benign: NOT a "needs review" state. */
export const AWAITING_INTENTS = ['holding', 'auto_reply'];

/** True when the reply is a holding/auto acknowledgement, not a real answer.
 *  Surfaced as its own badge so routine autoresponders don't read as review items. */
export function isAwaiting(row: { parsed?: { intent?: string } }): boolean {
  const intent = row.parsed?.intent;
  return intent != null && AWAITING_INTENTS.includes(intent);
}

/** True when this reply landed AFTER the target was already answered (price/opt-out
 *  known). We deliberately saved it without re-extracting ('skipped'), so it may
 *  carry something new a human should read — a renegotiation, a correction, a stop. */
export function isLateMessage(row: { extractionStatus?: string }): boolean {
  return row.extractionStatus === 'skipped';
}

export interface Suppression {
  id: string;
  email: string;
  reason: 'opt_out' | 'bounce' | 'manual';
  at: string;
}

// --- Per-domain price history (mirrors src/domain/price-sheet.ts) ------------

/** A stripped standing cell carried on the domain list row — enough to power the
 *  tier/niche filters and the domains export without a per-domain fetch. */
export interface DomainCell {
  postType: string;
  category: string;
  label: string;
  sensitive: boolean;
  canPost: CanPost;
  price?: PriceValue;
}

/** A row in the known-domains list (GET /api/domains). */
export interface DomainSummary {
  domain: string;
  recordCount: number;
  /** Distinct sender emails that have priced this domain. >1 ⇒ multiple price sources. */
  sourceCount?: number;
  standingCells: number;
  activeSpecials: number;
  lastObservedAt?: string;
  optedOut: boolean;
  excluded: boolean;
  /** Folded standing cells (omitted on legacy responses → treat as []). */
  cells?: DomainCell[];
}

/** A folded standing/special price cell (GET /api/domains/:domain). */
export interface PriceCell {
  postType: string;
  category: string;
  label: string;
  sensitive: boolean;
  canPost: CanPost;
  price?: PriceValue;
  asOf: string;
  sourceMessageId: string;
  replyId?: string;
  stale: boolean;
  specialUntil?: string; // specials only
  active?: boolean; // specials only
}

export interface PriceRecordRow {
  id: string;
  domain: string;
  offers: PostOffer[];
  observedAt: string;
  sourceEmail: string;
  sourceMessageId: string;
  replyId?: string;
  attribution: 'sender' | 'named';
  targetId?: string;
  optOut?: boolean;
}

export interface DomainDetail {
  sheet: {
    domain: string;
    cells: PriceCell[];
    specials: PriceCell[];
    lastObservedAt?: string;
    recordCount: number;
    optedOut: boolean;
  };
  history: PriceRecordRow[];
  excluded: boolean;
}

export interface IgnoreEntry {
  id: string;
  kind: 'email' | 'domain';
  value: string;
  reason: string;
  emailId?: string;
  at: string;
}

export interface DomainExclusion {
  id: string;
  domain: string;
  reason: 'declined' | 'manual';
  sourceReplyId?: string;
  at: string;
}

export interface Engagement {
  queued: number;
  contacted: number;
  acknowledged: number;
  answered: number;
  declined: number;
  other: number;
  optedOut: number;
  excluded: number;
  bounced: number;
  replied: number;
}

export interface Outcomes {
  informative: number; // replied with a price and/or a posting yes/no
  priced: number; // quoted at least one price
  postingYes: number; // will post for ≥1 niche
  postingNo: number; // declined to post
}

export interface Status {
  ok: boolean;
  time: string;
  accounts: number;
  targets: { total: number; byStatus: Record<string, number> };
  engagement?: Engagement;
  outcomes?: Outcomes;
  providers: { llm: string; email: string; store: string } | null;
  sendWindow: { startHour: number; endHour: number; paceEndHour?: number };
  windowActive: boolean;
}

export interface NewAccount {
  email: string;
  senderName: string;
  providerType?: ProviderType;
  credentialRef?: string;
  maxDailyLimit?: number;
  signature?: string;
}

export interface NewTarget {
  websiteUrl: string;
  contactEmail: string;
  contactName?: string;
  notes?: string;
  /** Shared across a bulk import so all its rows land in one batch. Omit for a
   *  single add — the server mints a fresh single-row batch. */
  batchId?: string;
}

export interface Batch {
  id: string;
  name?: string;
  source: 'import' | 'manual';
  /** Per-import advertised site override; global config default when absent. */
  advertised?: { url: string; description: string };
  createdAt: string;
}

/** A batch enriched by GET /api/batches with its live target rollup. */
export interface BatchRow extends Batch {
  count: number;
  byStatus: Record<string, number>;
}

export interface NewBatch {
  name?: string;
  advertised?: { url: string; description?: string };
}
