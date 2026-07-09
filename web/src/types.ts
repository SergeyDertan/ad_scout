// Client-side mirror of the server domain types (src/domain/types.ts) — only
// the fields the UI reads/writes. Kept deliberately small.

export type CanPost = 'yes' | 'no' | 'maybe';

export interface PriceValue {
  amount?: number;
  currency?: string;
  raw: string;
}

export interface PostOffer {
  postType: string; // 'guest_post' | 'link_insertion' | 'banner' (fixed enum, may be absent on legacy rows)
  category: string;
  label: string;
  sensitive: boolean;
  canPost: CanPost;
  price?: PriceValue;
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
    return price.currency ? `${price.amount} ${price.currency}` : String(price.amount);
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
 * Returns a set of CELL keys ("postType|category") so only the offending cell is
 * flagged — a regular guest post priced above a sensitive guest post must not
 * also highlight the regular link-insertion row. Use `offerCellKey` to test.
 */
export function offerCellKey(offer: PostOffer): string {
  return `${offer.postType || 'guest_post'}|${offer.category}`;
}

export function invertedPriceOffers(offers?: PostOffer[]): Set<string> {
  const flagged = new Set<string>();
  const priced = (offers ?? []).filter((o) => o.price?.amount !== undefined);
  if (priced.length < 2) return flagged;

  const currencies = new Set(priced.map((o) => o.price?.currency).filter(Boolean));
  if (currencies.size > 1) return flagged; // not comparable

  // Bucket by product tier, then compare regular vs sensitive within each tier.
  const tiers = new Map<string, PostOffer[]>();
  for (const o of priced) {
    const tier = offerProductTier(o);
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

export type AccountStatus = 'warming' | 'active' | 'paused' | 'cooldown';
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
  campaignId: string;
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

export type InquiryFieldType = 'price' | 'text' | 'list' | 'enum' | 'boolean';

export interface InquiryField {
  key: string;
  question: string;
  type: InquiryFieldType;
  enumValues?: string[];
  required?: boolean;
}

export interface Campaign {
  id: string;
  name: string;
  advertised: { url: string; description: string };
  topic: string;
  format: string;
  inquiryFields: InquiryField[];
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
  campaignId?: string;
  campaignName?: string;
  matchMethod: 'threadId' | 'fromAddress' | 'unmatched';
  extractionStatus: 'pending' | 'done' | 'failed';
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
    fields: Record<string, unknown>;
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

export interface Suppression {
  id: string;
  email: string;
  reason: 'opt_out' | 'bounce' | 'manual';
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
  sendWindow: { startHour: number; endHour: number };
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
  campaignId?: string;
  contactName?: string;
  notes?: string;
}

export interface NewCampaign {
  name: string;
  advertised: { url: string; description?: string };
  topic?: string;
  format?: string;
}
