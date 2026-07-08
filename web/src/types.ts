// Client-side mirror of the server domain types (src/domain/types.ts) — only
// the fields the UI reads/writes. Kept deliberately small.

export type CanPost = 'yes' | 'no' | 'maybe';

export interface PriceValue {
  amount?: number;
  currency?: string;
  raw: string;
}

export interface PostOffer {
  category: string;
  label: string;
  sensitive: boolean;
  canPost: CanPost;
  price?: PriceValue;
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
 * Sensitive (grey-niche) posts should never be cheaper than a regular post.
 * When a non-sensitive offer is priced ABOVE a sensitive one, that ordering is
 * inverted — usually an extraction error (e.g. a flattened price table read the
 * two tiers backwards), occasionally a genuinely odd publisher. Either way it's
 * worth a human glance, so the UI flags it.
 *
 * Returns the set of non-sensitive offer categories that exceed the cheapest
 * sensitive price (empty = no anomaly). Skipped when the priced offers mix
 * currencies, since cross-currency amounts aren't comparable.
 */
export function invertedPriceOffers(offers?: PostOffer[]): Set<string> {
  const flagged = new Set<string>();
  const priced = (offers ?? []).filter((o) => o.price?.amount !== undefined);
  const sensitive = priced.filter((o) => o.sensitive);
  const regular = priced.filter((o) => !o.sensitive);
  if (!sensitive.length || !regular.length) return flagged;

  const currencies = new Set(priced.map((o) => o.price?.currency).filter(Boolean));
  if (currencies.size > 1) return flagged; // not comparable

  const minSensitive = Math.min(...sensitive.map((o) => o.price!.amount!));
  for (const o of regular) {
    if (o.price!.amount! > minSensitive) flagged.add(o.category);
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

export interface ResponseRow {
  id: string;
  fromAddress: string;
  website?: string;
  campaignId?: string;
  campaignName?: string;
  matchMethod: 'threadId' | 'fromAddress' | 'unmatched';
  extractionStatus: 'pending' | 'done' | 'failed';
  review?: string[];
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

export interface Suppression {
  id: string;
  email: string;
  reason: 'opt_out' | 'bounce' | 'manual';
  at: string;
}

export interface Status {
  ok: boolean;
  time: string;
  accounts: number;
  targets: { total: number; byStatus: Record<string, number> };
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
