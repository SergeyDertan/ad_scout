// Post-niche taxonomy — pure, no I/O.
//
// A "niche" is a canonical category of guest post the publisher prices separately
// (regular, casino, vpn, ...). The list is SELF-LEARNING: a fixed seed set lives
// here, and new niches discovered in replies are persisted (see Store.putNiche)
// and merged back in via `allNiches()`. Extraction stays literal — the AI tags
// each offer with a niche key; the sensitive-umbrella expansion happens only at
// FILTER time (see `offerMatchesFilter`).

import type { Niche, PostOffer } from './types';

/** The umbrella niche that every grey/sensitive vertical rolls up under. */
export const SENSITIVE_KEY = 'sensitive';
export const REGULAR_KEY = 'regular';

/**
 * We buy exactly ONE product: a guest post (a.k.a. sponsored post, article,
 * publication, placement). Publishers routinely quote OTHER products in the same
 * breath — link insertions (niche edits), banners/display ads — and we want none
 * of them. There is no product axis on an offer any more; instead these phrasings
 * are a REJECT list, applied in two places:
 *   - reconcileOffers drops any offer the model tagged with one of them, a
 *     deterministic backstop behind the prompt's "skip them" instruction;
 *   - cleanup-niches uses it to spot a product that leaked into the niche
 *     registry as a fake niche.
 * Anything NOT on this list is treated as a guest post, so the many names for the
 * thing we DO want ("sponsored article", "publication") need no enumeration.
 */
export const NON_GUEST_PRODUCT_ALIASES: string[] = [
  // link insertions / niche edits
  'link insertion', 'link insertions', 'link insert', 'link placement', 'niche edit',
  'niche edits', 'existing post', 'existing article', 'insert link', 'link in existing',
  'link building', 'link exchange', 'homepage link', 'sidebar link',
  // banners / display
  'banner', 'banner ad', 'banner ads', 'display ad', 'display ads', 'banner placement',
  'banner advertising',
];

/**
 * Does this free text name a product we do NOT buy (a link insertion, a banner)?
 * Exact match on the canonical key/phrase, plus a loose contains-match so
 * "casino link insertion price" is caught too.
 */
export function isNonGuestProduct(text: string): boolean {
  const key = normalizeKey(text);
  const phrase = norm(text);
  if (!key && !phrase) return false;
  for (const a of NON_GUEST_PRODUCT_ALIASES) {
    if (norm(a) === phrase || normalizeKey(a) === key) return true;
  }
  // Loose contains-match; short aliases are excluded so a legitimate niche whose
  // name merely embeds a short token isn't swept up.
  return NON_GUEST_PRODUCT_ALIASES.some((a) => a.length > 5 && phrase.includes(norm(a)));
}

/** Seed niches — always available to the prompt even before anything is learned. */
export const DEFAULT_NICHES: Niche[] = [
  { key: 'regular', label: 'Regular', sensitive: false, aliases: ['standard', 'normal', 'ordinary', 'guest post', 'general', 'usual'] },
  { key: 'sensitive', label: 'Sensitive', sensitive: true, aliases: ['grey niche', 'gray niche', 'special', 'sensitive topics', 'sensitive niche', 'grey', 'restricted'] },
  { key: 'casino', label: 'Casino', sensitive: true, aliases: ['casino', 'casinos', 'online casino', 'igaming'] },
  { key: 'gambling', label: 'Gambling', sensitive: true, aliases: ['gambling', 'slots', 'poker'] },
  { key: 'betting', label: 'Betting', sensitive: true, aliases: ['betting', 'sports betting', 'bookmaker', 'bookmakers', 'sportsbook'] },
  { key: 'crypto', label: 'Crypto', sensitive: true, aliases: ['crypto', 'cryptocurrency', 'bitcoin', 'blockchain', 'web3', 'nft'] },
  { key: 'vpn', label: 'VPN', sensitive: true, aliases: ['vpn', 'vpns', 'proxy'] },
  { key: 'cbd', label: 'CBD', sensitive: true, aliases: ['cbd', 'cannabis', 'marijuana', 'weed', 'hemp'] },
  { key: 'adult', label: 'Adult', sensitive: true, aliases: ['adult', 'porn', 'xxx', 'escort', 'dating adult'] },
  { key: 'dating', label: 'Dating', sensitive: true, aliases: ['dating', 'hookup', 'matchmaking'] },
  { key: 'forex', label: 'Forex', sensitive: true, aliases: ['forex', 'fx', 'trading', 'financial trading', 'binary options'] },
];

/** Merge the seed set with learned niches (learned entries override by key). */
export function allNiches(learned: Niche[] = []): Niche[] {
  const byKey = new Map<string, Niche>();
  for (const n of DEFAULT_NICHES) byKey.set(n.key, n);
  for (const n of learned) byKey.set(n.key, { ...byKey.get(n.key), ...n });
  return [...byKey.values()];
}

/** Canonicalize free text into a niche key: lowercase, alnum runs → single "_". */
export function normalizeKey(s: string): string {
  return (s ?? '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function norm(s: string): string {
  return (s ?? '').toLowerCase().trim().replace(/\s+/g, ' ');
}

/** Resolve free text (a category key OR the owner's wording) to a known niche. */
export function matchNiche(text: string, niches: Niche[]): Niche | undefined {
  const key = normalizeKey(text);
  const phrase = norm(text);
  if (!key && !phrase) return undefined;
  // 1. exact key match
  const byKey = niches.find((n) => n.key === key);
  if (byKey) return byKey;
  // 2. exact label / alias match
  for (const n of niches) {
    if (norm(n.label) === phrase) return n;
    if (n.aliases.some((a) => norm(a) === phrase || normalizeKey(a) === key)) return n;
  }
  return undefined;
}

const GENERIC = new Set([REGULAR_KEY, SENSITIVE_KEY]);

/**
 * Best-effort map a campaign's free-text topic to a niche key (what we asked about).
 * Prefers a specific niche whose key/alias appears in the topic; falls back to the
 * generic umbrellas only if nothing more specific is found.
 */
export function categorizeTopic(topic: string, niches: Niche[]): string | undefined {
  const hay = norm(topic);
  if (!hay) return undefined;
  const hit = (n: Niche) =>
    hay.includes(norm(n.label)) ||
    n.key !== REGULAR_KEY && hay.includes(n.key) ||
    n.aliases.some((a) => a.length > 2 && hay.includes(norm(a)));
  const specific = niches.find((n) => !GENERIC.has(n.key) && hit(n));
  if (specific) return specific.key;
  const generic = niches.find((n) => GENERIC.has(n.key) && hit(n));
  return generic?.key;
}

/** Is this niche key a sensitive/grey one (rolls under the umbrella)? */
export function isSensitiveKey(key: string, niches: Niche[]): boolean {
  if (key === SENSITIVE_KEY) return true;
  return Boolean(niches.find((n) => n.key === key)?.sensitive);
}

/**
 * Two-way umbrella match used by the UI filter:
 *  - exact key, OR
 *  - filtering a sensitive child (casino) also matches the generic `sensitive` offer, OR
 *  - filtering the `sensitive` umbrella matches any offer flagged sensitive.
 */
export function offerMatchesFilter(offer: PostOffer, filterKey: string, niches: Niche[]): boolean {
  if (offer.category === filterKey) return true;
  if (filterKey === SENSITIVE_KEY) return offer.sensitive;
  if (isSensitiveKey(filterKey, niches) && offer.category === SENSITIVE_KEY) return true;
  return false;
}

/**
 * Resolve the effective offer for a category, applying the child→umbrella fallback
 * (asked casino, owner only priced `sensitive` → use that). Used for the summary canPost.
 */
export function resolveOffer(
  offers: PostOffer[],
  category: string | undefined,
  niches: Niche[],
): PostOffer | undefined {
  if (!category) return undefined;
  const exact = offers.find((o) => o.category === category);
  if (exact) return exact;
  if (isSensitiveKey(category, niches)) return offers.find((o) => o.category === SENSITIVE_KEY);
  return undefined;
}
