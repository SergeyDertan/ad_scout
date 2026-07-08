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
  parsed?: {
    canPost: string;
    requestedCategory?: string;
    offers?: PostOffer[];
    reasoning?: string;
    fields: Record<string, unknown>;
  };
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
