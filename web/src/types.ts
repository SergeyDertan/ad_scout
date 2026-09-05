// Client-side mirror of the server domain types (src/domain/types.ts) — only
// the fields the UI reads/writes. Kept deliberately small.

export type CanPost = 'yes' | 'no' | 'maybe';

/**
 * The sensitivity tier a niche falls in. Our registry classifies every niche,
 * so this is always one of two and always derives from the `sensitive` boolean.
 *
 * There was a third state, 'unknown', for the read-only viewer: it received the
 * snapshot with every price flattened to `sensitive: false` and its owner
 * classified niches himself, so "he hasn't ruled on this yet" had to be
 * distinguishable from "regular". That build is gone. Not knowing a niche's
 * tier is now modelled where it actually occurs — as an absent tier at the one
 * call site that can fail to resolve one (see answerForNiche) — rather than as
 * a member of this type that no classified niche can ever hold.
 */
export type Tier = 'sens' | 'reg';

export const TIER_LABEL: Record<Tier, string> = {
  sens: 'Sensitive posts',
  reg: 'Regular posts',
};

/** A priced thing's tier. */
export function tierOf(x: { sensitive: boolean }): Tier {
  return x.sensitive ? 'sens' : 'reg';
}

export interface PriceValue {
  amount?: number;
  /** Normalized ISO code, set only when confidently mapped. */
  currency?: string;
  /** Currency token as written — superset of `currency`, present even for currencies
   *  we can't normalize yet. Prefer `currency ?? currencyRaw` when labelling a price. */
  currencyRaw?: string;
  raw: string;
}

/** How long a price buys the placement for (mirrors domain PlacementTerm).
 *  `key` is identity, `days` orders, `months` is set ONLY for exact whole months
 *  so a month filter can't match a 1-week placement, `raw` is what they wrote. */
export interface PlacementTerm {
  key: string;
  days?: number;
  months?: number;
  raw: string;
}

/** A price for one niche AT one placement term. Guest posts are the only product
 *  we buy, so niche + term identifies a cell — there is no product axis. */
export interface PostOffer {
  category: string;
  label: string;
  sensitive: boolean;
  canPost: CanPost;
  price?: PriceValue;
  /** Absent only on records written before terms existed — read as "unstated". */
  term?: PlacementTerm;
  website?: string;
  isSpecial?: boolean;
  specialUntil?: string;
}

/** Human label for a term: the publisher's own words, else a canonical rendering,
 *  else "—" when no duration was stated. For per-offer views, where the exact
 *  phrasing IS the point. Naming a shared column? Use canonicalTerm instead. */
export function formatTerm(term?: PlacementTerm): string {
  if (!term || term.key === 'none') return '—';
  if (term.raw) return term.raw;
  if (term.key === 'perm') return 'permanent';
  if (term.months != null) return `${term.months} month${term.months === 1 ? '' : 's'}`;
  if (term.days != null) return `${term.days} day${term.days === 1 ? '' : 's'}`;
  return term.key;
}

/**
 * Canonical label for a term — derived from the PARSED duration, never from the
 * raw phrase. Use this to name anything SHARED by many offers (a column header,
 * a group heading).
 *
 * Two offers with the same `key` are the same duration, but their `raw` phrases
 * differ wildly ("per year per article", "at least 1 year", "twelve month
 * terms"). formatTerm would label the shared column with whichever offer landed
 * first, so a 12-month column could read "Casino (a minimum of 3 years)" — the
 * header contradicting its own contents. Canonical labels can't do that.
 *
 * `other:*` terms have no parse to render, so they fall back to the raw phrase;
 * that's the honest label there, and it's a signal terms.ts should learn the
 * phrasing.
 */
export function canonicalTerm(term?: PlacementTerm): string {
  if (!term || term.key === 'none') return '—';
  if (term.key === 'perm') return 'permanent';
  if (term.months != null) {
    // Whole years read as years — "2 years" beats "24 months" on a header.
    if (term.months >= 12 && term.months % 12 === 0) {
      const y = term.months / 12;
      return `${y} year${y === 1 ? '' : 's'}`;
    }
    return `${term.months} month${term.months === 1 ? '' : 's'}`;
  }
  if (term.days != null) {
    if (term.days % 7 === 0) {
      const w = term.days / 7;
      return `${w} week${w === 1 ? '' : 's'}`;
    }
    return `${term.days} day${term.days === 1 ? '' : 's'}`;
  }
  return term.raw || term.key;
}

/** Sort by duration: shortest first, indefinite terms (unstated, permanent,
 *  unparseable) at the far end. Mirrors domain/terms.ts compareTerms. */
export function compareTerms(a?: PlacementTerm, b?: PlacementTerm): number {
  const rank = (t?: PlacementTerm) => (!t || t.key === 'none' ? 2 : t.days != null ? 0 : 1);
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra - rb;
  if (ra === 0) return a!.days! - b!.days!;
  return (a?.key ?? '').localeCompare(b?.key ?? '');
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
 * Sensitive (grey-niche) offers should never be cheaper than a regular offer —
 * a sensitive post ≥ a regular post. When a non-sensitive offer is priced ABOVE
 * its sensitive counterpart, that ordering is inverted — usually an extraction
 * error (e.g. a flattened price table read the two tiers backwards),
 * occasionally a genuinely odd publisher. Either way it's worth a human glance.
 *
 * Returns the set of non-sensitive offer cells that exceed the cheapest
 * sensitive price (empty = no anomaly). Skipped when the priced offers mix
 * currencies, since cross-currency amounts aren't comparable.
 *
 * Comparison is per-SITE: one reply often prices a whole portfolio (the sender's
 * site plus other domains they own, tagged via `offer.website`), and those are
 * independent rate cards. A $180 regular post on one domain says nothing about a
 * $130 sensitive post on another, so bucketing by site keeps a pricier site from
 * flagging a cheaper one.
 *
 * Returns a set of CELL keys ("site|category") so only the offending cell is
 * flagged. Use `offerCellKey`.
 */
export function offerSite(offer: PostOffer): string {
  return offer.website?.trim().toLowerCase() ?? '';
}

export function offerTermKey(offer: PostOffer): string {
  return offer.term?.key ?? 'none';
}

export function offerCellKey(offer: PostOffer): string {
  return `${offerSite(offer)}|${offer.category}|${offerTermKey(offer)}`;
}

export function invertedPriceOffers(offers?: PostOffer[]): Set<string> {
  const flagged = new Set<string>();
  const priced = (offers ?? []).filter((o) => o.price?.amount !== undefined);
  if (priced.length < 2) return flagged;

  const currencies = new Set(priced.map((o) => o.price?.currency).filter(Boolean));
  if (currencies.size > 1) return flagged; // not comparable

  // Bucket by site AND placement term, then compare regular vs sensitive within
  // each. A $99 one-month regular says nothing about a $150 three-month
  // sensitive — different durations are different rate cards, exactly like
  // different sites, so mixing them would flag ordinary pricing as inverted.
  const tiers = new Map<string, PostOffer[]>();
  for (const o of priced) {
    const tier = `${offerSite(o)}|${offerTermKey(o)}`;
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
  stats?: AccountStats; // lifetime, server-derived results (GET /api/accounts)
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

/**
 * Lifetime per-account statistics derived on the server from the Outreach log +
 * targets/replies. Mirrors src/domain/account-stats.ts.
 *
 * Two keys, deliberately: the volume counts are what THIS mailbox put on the
 * wire, while the funnel covers the targets it OWNS (the ones whose opening
 * message it sent). A follow-up sent by another mailbox therefore shows up in
 * that mailbox's `messagesSent` but in this one's funnel.
 */
export interface AccountStats {
  messagesSent: number; // delivered messages, all kinds
  initials: number; // of those: opening messages
  followUps: number; // of those: follow-ups
  manual: number; // of those: hand-written deal messages
  failed: number; // sends that errored (nothing delivered)
  reserved: number; // drafted, not yet on the wire
  lastSentAt?: string; // newest send; absent if it never sent
  targetsContacted: number; // targets this mailbox opened and got out the door
  engagement: Engagement; // funnel over the owned targets
  outcomes: Outcomes; // commercial outcomes over the owned targets
  bounceRate: number; // bounced / targetsContacted (0..1)
  replyRate: number; // replied / (targetsContacted - bounced) (0..1)
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
/** 'manual' = a message a person wrote from the Deals view. */
export type OutreachKind = 'initial' | 'followup' | 'manual';

export interface Outreach {
  id: string;
  /** Absent on a 'manual' deal message to a domain with no target row. */
  targetId?: string;
  dealId?: string;
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
  /** Who ANSWERED — not necessarily the address we wrote to (that is the
   *  target's contactEmail). A role alias often hands off to a real person. */
  fromAddress: string;
  /** Which mailbox OF OURS received it, resolved server-side from the reply's
   *  account, else the outreach thread, else the target's assigned account. */
  accountEmail?: string;
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
  /** The mailbox that received it, and the subject line — both needed to find the
   *  message again when debugging. Absent on replies stored before they were kept. */
  accountId?: string;
  subject?: string;
  /** Mailbox-level ids, needed to find the original message when debugging. */
  emailId?: string;
  rfcMessageId?: string;
  parsed?: {
    canPost: string;
    requestedCategory?: string;
    offers?: PostOffer[];
    reasoning?: string;
    /** The AI's fuller account of how it read the reply (a few sentences). */
    aiExplanation?: string;
    conditions?: string;
    notes?: string;
    optOut?: boolean;
    intent?: string;
  };
  /** Which run produced `parsed` — model/provider/prompt, and whether a human
   *  has since corrected it. */
  extraction?: ExtractionProvenance;
}

/** An archived system prompt, resolvable from ExtractionProvenance.promptHash. */
export interface PromptSnapshot {
  hash: string;
  style: string;
  text: string;
  firstSeenAt: string;
}

/** GET /api/replies/:id/debug — everything about one extraction, pre-joined. */
export interface ExtractionDebug {
  reply: ResponseRow;
  mailbox?: { id: string; email: string; providerType: string };
  target?: {
    id: string;
    websiteUrl: string;
    contactEmail: string;
    status: string;
    batchId?: string;
    batchName?: string;
  };
  /** How the outreach framed the ask — decides how a niche-less price is read. */
  pitchStyle: 'casino' | 'broad';
  prompt?: PromptSnapshot;
  priceRecords: PriceRecordRow[];
}

/** Which extraction produced a stored result (mirrors domain ExtractionProvenance). */
export interface ExtractionProvenance {
  provider: string;
  model?: string;
  promptHash: string;
  promptStyle: string;
  extractedAt: string;
  editedByHuman?: boolean;
  editedAt?: string;
}

/** One-line summary of a run, for a tooltip or a muted caption. */
export function formatProvenance(p?: ExtractionProvenance): string {
  if (!p) return 'No extraction record (predates provenance tracking).';
  const model = p.model ? `${p.provider}/${p.model}` : p.provider;
  const when = p.extractedAt ? new Date(p.extractedAt).toLocaleString() : 'unknown time';
  const prompt = p.promptHash ? `prompt ${p.promptHash} (${p.promptStyle})` : 'prompt unknown';
  const edited = p.editedByHuman
    ? ` · edited by hand${p.editedAt ? ` ${new Date(p.editedAt).toLocaleString()}` : ''}`
    : '';
  return `${model} · ${prompt} · extracted ${when}${edited}`;
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
  category: string;
  label: string;
  sensitive: boolean;
  canPost: CanPost;
  price?: PriceValue;
  /** The duration this price buys — part of the cell identity, so one niche can
   *  appear several times (1 month, 3 months, …). Absent on legacy rows. */
  term?: PlacementTerm;
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
  category: string;
  label: string;
  sensitive: boolean;
  canPost: CanPost;
  price?: PriceValue;
  term?: PlacementTerm;
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
  /** Which run produced this record (absent on records predating provenance). */
  extraction?: ExtractionProvenance;
  /** The AI's account of why it read the reply this way. */
  aiExplanation?: string;
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
  /** Replies awaiting AI extraction (pending + failed). */
  pendingExtraction?: number;
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

// --- Deals -------------------------------------------------------------------

/** Coarse on purpose: the middle of a deal has no fixed order (sometimes they
 *  publish first, sometimes we pay first), so it is one stage, not three. */
export type DealStatus = 'negotiation' | 'fulfilment' | 'done' | 'closed';

export interface Deal {
  id: string;
  counterpartyEmail: string;
  accountId: string;
  status: DealStatus;
  origin: 'manual' | 'human_reply';
  openedAt: string;
  closedAt?: string;
  closedReason?: string;
  note?: string;
}

/** A deal in the list, with the counts the server derived from its placements. */
export interface DealRow extends Deal {
  /** The mailbox this negotiation runs through — which address they reply to. */
  accountEmail?: string;
  domains: string[];
  placementCount: number;
  paidCount: number;
  liveCount: number;
}

/** One post on one domain. `paidAt` and `liveAt` are independent facts, not
 *  stages — either can be set first. */
export interface Placement {
  id: string;
  dealId: string;
  domain: string;
  contentText?: string;
  contentUrl?: string;
  agreedPrice?: PriceValue;
  paymentMethod?: string;
  paidAt?: string;
  publishedUrl?: string;
  liveAt?: string;
  note?: string;
}

export type DealTimelineItem =
  | { kind: 'sent'; at: string; outreach: Outreach }
  | { kind: 'received'; at: string; reply: DealReply };

/** A received message on a deal thread. Never extracted — `parsed` is absent by
 *  design, which is the whole point of holding the thread. */
export interface DealReply {
  id: string;
  fromAddress: string;
  subject?: string;
  receivedAt: string;
  text: string;
  attachments?: EmailAttachment[];
}

export interface DealDetail {
  deal: Deal;
  accountEmail?: string;
  placements: Placement[];
  domains: string[];
  threadIds: string[];
  timeline: DealTimelineItem[];
}
