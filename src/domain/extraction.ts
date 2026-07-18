// Pure extraction helpers (overview.md §6 OutreachResult). No I/O.
//
// Division of labour: the LLM does NLP only — it tags niches, willingness, and a
// VERBATIM price per (product × niche). This deterministic, unit-tested code
// reconciles those offers against the niche registry and parses each raw price.
// That keeps the fragile part (parsing/reconciling) out of the model and testable.

import type {
  CanPost,
  JsonSchema,
  Niche,
  OutreachResult,
  PostOffer,
  PriceValue,
  ReplyIntent,
} from './types';
import {
  DEFAULT_POST_TYPE,
  matchNiche,
  matchPostType,
  normalizeKey,
  POST_TYPE_KEYS,
  REGULAR_KEY,
  resolveOffer,
} from './niches';

/** One offer as the LLM returns it: a niche tag + willingness + a verbatim price. */
export interface RawOffer {
  /** Product ladder this price is for: guest_post | link_insertion | banner.
   *  Defaults to guest_post when the publisher doesn't distinguish. */
  postType?: string;
  category: string; // an existing niche key/label, or a NEW snake_case key
  label: string; // human-readable niche name (used when it's a new niche)
  sensitive: boolean; // is this a grey/sensitive niche?
  canPost: CanPost;
  priceRaw: string;
  /** How to read priceRaw. 'relative' = priced only as a multiple of another
   *  niche's rate (e.g. casino = "+50% premium"); 'absolute' (default) = a real
   *  figure. Keeps the LLM out of arithmetic — it names the multiplier, we compute. */
  priceKind?: 'absolute' | 'relative';
  /** For relative pricing: the factor (1.5 for "+50%", 2 for "double"). */
  multiplier?: number;
  /** For relative pricing: the base niche key it multiplies (usually 'regular'). */
  relativeTo?: string;
  /** The site this price is for, ONLY when the owner explicitly prices a
   *  DIFFERENT site they also own (M2). Blank ⇒ the contacted site (attributed to
   *  the sender). Any URL/host; normalized by the caller (poll-pass). */
  website?: string;
  /** Time-limited promo price (D5). */
  isSpecial?: boolean;
  /** Optional deadline the owner gave for the special (ISO or verbatim). */
  specialUntil?: string;
}

/** The shape the LLM is asked to return. */
export interface RawExtraction {
  optOut: boolean;
  /** Reply intent: answer | holding | auto_reply | question | decline | other. */
  intent?: string;
  /** One entry per post type the owner priced/addressed (regular + any sensitive). */
  offers: RawOffer[];
  /** One short line explaining the offer classification. */
  reasoning: string;
  conditions?: string;
  notes?: string;
  /** True when the reply is WHOLLY unrelated to posting/ads (e.g. "10% off pool
   *  cleaners") — pure spam. The caller ignores the sender and writes nothing (D7). */
  isSpam?: boolean;
}

const REPLY_INTENTS: ReplyIntent[] = ['answer', 'holding', 'auto_reply', 'question', 'decline', 'other'];

function coerceIntent(raw: string | undefined): ReplyIntent {
  return REPLY_INTENTS.includes(raw as ReplyIntent) ? (raw as ReplyIntent) : 'answer';
}

const OFFER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['postType', 'category', 'label', 'sensitive', 'canPost', 'priceRaw', 'priceKind', 'multiplier', 'relativeTo', 'website', 'isSpecial', 'specialUntil'],
  properties: {
    postType: {
      type: 'string',
      enum: POST_TYPE_KEYS,
      description:
        'Which PRODUCT this price is for (separate from the niche): guest_post = a written article/sponsored post; link_insertion = adding a link into an existing post (a.k.a. niche edit); banner = a display/banner ad. Use guest_post when the publisher does not distinguish.',
    },
    category: {
      type: 'string',
      description:
        'Niche key for this post type. REUSE a key from the known-niches list when it fits; otherwise a new lowercase_snake_case key (e.g. "short_term_loans").',
    },
    label: { type: 'string', description: 'Human-readable niche name, e.g. "Short-term loans".' },
    sensitive: {
      type: 'boolean',
      description: 'true if this is a grey/sensitive niche (casino, vpn, gambling, adult, crypto, loans, ...).',
    },
    canPost: {
      type: 'string',
      enum: ['yes', 'no', 'maybe'],
      description: 'yes = will publish this type, no = declines it, maybe = unclear/conditional.',
    },
    priceRaw: {
      type: 'string',
      description: 'Price for this type EXACTLY as written (e.g. "$150", "150 EUR/post"). "" if not stated.',
    },
    priceKind: {
      type: 'string',
      enum: ['absolute', 'relative'],
      description:
        'absolute = priceRaw is a real figure ($150). relative = this niche has NO figure of its own and is priced only as a multiple of another rate (e.g. "casino +50% premium", "sensitive = 3-5x the listed price"). Use relative ONLY then.',
    },
    multiplier: {
      type: 'number',
      description:
        'When priceKind=relative, the factor to multiply the base rate by: "+50% premium" → 1.5, "double" → 2, "3-5x" → use the lower bound 3. 0 when absolute.',
    },
    relativeTo: {
      type: 'string',
      description:
        'When priceKind=relative, the niche key whose rate this multiplies — usually "regular" (the standard/listed rate). "" when absolute.',
    },
    website: {
      type: 'string',
      description:
        'Set ONLY when the owner explicitly prices a DIFFERENT website they also own (e.g. "on casik.ua it is $80"). Then put that site (domain/URL) here. Leave "" for the site we contacted them about — that is the default.',
    },
    isSpecial: {
      type: 'boolean',
      description:
        'true if this price is a TIME-LIMITED promo/discount ("this month only", "special offer", "until Friday"), not the standing rate. false otherwise.',
    },
    specialUntil: {
      type: 'string',
      description:
        'When isSpecial, the deadline the owner gave EXACTLY as written ("end of month", "2026-08-01", "this Friday"), or "" if none given. "" when not special.',
    },
  },
} as const;

/** Build the extraction JSON Schema (structured-output-safe). */
export function buildExtractionSchema(): JsonSchema {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['optOut', 'intent', 'offers', 'reasoning', 'conditions', 'notes', 'isSpam'],
    properties: {
      optOut: { type: 'boolean' },
      isSpam: {
        type: 'boolean',
        description:
          'true ONLY if this email is WHOLLY unrelated to guest posting / link building / advertising with us — e.g. a marketing blast selling an unrelated product ("10% off pool cleaners"), a newsletter, a platform notification. A real (even negative) reply about posting/pricing is NOT spam. false otherwise.',
      },
      intent: {
        type: 'string',
        enum: ['answer', 'holding', 'auto_reply', 'question', 'decline', 'other'],
        description:
          'What kind of reply this is. "answer" = a substantive response (gives prices/willingness, or clearly declines). "holding" = an acknowledgement promising a later reply ("we\'ll get back to you", "received, will respond soon"). "auto_reply" = out-of-office/autoresponder. "question" = they ask US something without answering. "decline" = not interested. "other" = none of these.',
      },
      offers: {
        type: 'array',
        description:
          'One entry per (postType × niche) cell the owner priced or addressed — e.g. a regular guest post, a casino guest post, a regular link insertion, a banner. ALWAYS include the regular (standard) price of each product the owner mentions (guest post, link insertion, banner), plus any grey-niche pricing (casino, vpn, or the generic "sensitive"). Do NOT invent cells the owner did not mention, and do NOT turn a product (link insertion/banner) into a niche — that is what postType is for.',
        items: OFFER_SCHEMA,
      },
      reasoning: {
        type: 'string',
        description:
          'One short line (max ~20 words) explaining the niche classification, e.g. "Owner priced casino $150 and regular $60; no other niches mentioned".',
      },
      conditions: { type: 'string' },
      notes: { type: 'string' },
    },
  };
}

const CURRENCY_SYMBOLS: Record<string, string> = {
  $: 'USD',
  '€': 'EUR',
  '£': 'GBP',
  '₴': 'UAH',
};
const CURRENCY_CODES = ['USD', 'EUR', 'GBP', 'UAH', 'PLN', 'CAD', 'AUD'];

/** Parse a verbatim price string into { amount?, currency?, raw }. Undefined if empty. */
export function parsePrice(raw: string): PriceValue | undefined {
  const value = (raw ?? '').trim();
  if (!value) return undefined;
  const num = value.replace(/[, ](?=\d{3}\b)/g, '').match(/\d+(?:[.,]\d+)?/);
  const amount = num ? Number(num[0].replace(',', '.')) : undefined;
  let currency: string | undefined;
  for (const sym of Object.keys(CURRENCY_SYMBOLS)) {
    if (value.includes(sym)) {
      currency = CURRENCY_SYMBOLS[sym];
      break;
    }
  }
  if (!currency) {
    const code = CURRENCY_CODES.find((c) => new RegExp(`\\b${c}\\b`, 'i').test(value));
    if (code) currency = code;
  }
  return {
    ...(amount !== undefined && Number.isFinite(amount) ? { amount } : {}),
    ...(currency ? { currency } : {}),
    raw: value,
  };
}

/**
 * Reconcile the LLM's raw offers against the known niche registry:
 *  - match each raw offer to an existing niche (by key / label / alias), OR
 *  - mint a NEW niche when nothing fits (returned in `discovered` to be persisted).
 * De-dupes offers by canonical key (an entry with a price wins over one without).
 * Pure — the caller owns persistence.
 */
export function reconcileOffers(
  rawOffers: RawOffer[],
  knownNiches: Niche[],
): { offers: PostOffer[]; discovered: Niche[] } {
  const known = [...knownNiches];
  const discovered: Niche[] = [];
  // Keyed by "postType|nicheKey" — the two axes together identify a cell, so a
  // casino guest post and a casino link insertion are distinct offers.
  const byCell = new Map<string, PostOffer>();
  // Relative-pricing spec for the offer currently held in byCell, same key.
  const relByCell = new Map<string, RelativeSpec>();

  for (const raw of rawOffers ?? []) {
    let niche = matchNiche(raw.category, known) ?? matchNiche(raw.label, known);
    if (!niche) {
      const key = normalizeKey(raw.category) || normalizeKey(raw.label);
      if (!key) continue; // unusable — skip rather than store junk
      const aliases = [raw.label, raw.category].filter((s) => s && s.trim()).map((s) => s.trim());
      niche = { key, label: raw.label?.trim() || raw.category.trim(), sensitive: Boolean(raw.sensitive), aliases };
      known.push(niche);
      discovered.push(niche);
    }
    const postType = matchPostType(raw.postType ?? '');
    // A website tag scopes the cell: a casino price for casik.ua is a distinct
    // cell from a casino price for the contacted site, so they never merge and
    // relative pricing resolves its base WITHIN the same site. A special (promo)
    // price ALSO scopes the cell — it must coexist with the standing price (D5),
    // never overwrite it.
    const website = (raw.website ?? '').trim();
    const special = Boolean(raw.isSpecial);
    const cellKey = makeCellKey(website, postType, niche.key, special);
    const relBase = relativeSpec(raw);
    // Stamp with the RESOLVED keys so the second-pass write-back targets the same
    // cell (raw.category "online casino" resolves to niche.key "casino").
    const rel = relBase ? { ...relBase, website, postType, nicheKey: niche.key, special } : undefined;
    // A relative offer's priceRaw is a premium phrase ("+50%", "3-5x listed"),
    // NOT a figure — parsing it as absolute grabbed a bogus leading number. Defer:
    // its amount is computed from the base offer in the second pass.
    const price = rel ? undefined : parsePrice(raw.priceRaw ?? '');
    const specialUntil = (raw.specialUntil ?? '').trim();
    const offer: PostOffer = {
      postType,
      category: niche.key,
      label: niche.label,
      sensitive: niche.sensitive,
      canPost: raw.canPost ?? 'maybe',
      ...(price ? { price } : {}),
      ...(website ? { website } : {}),
      ...(raw.isSpecial ? { isSpecial: true } : {}),
      ...(specialUntil ? { specialUntil } : {}),
    };
    const existing = byCell.get(cellKey);
    // Keep the richer entry if the LLM emitted the same cell twice.
    if (!existing || (!existing.price && offer.price)) {
      byCell.set(cellKey, offer);
      if (rel) relByCell.set(cellKey, rel);
      else relByCell.delete(cellKey);
    }
  }

  // Second pass: casino = 1.5 × regular. The LLM only named the multiplier and
  // the base niche; the arithmetic stays here, in tested code, so nothing is
  // hallucinated and every amount traces back to a base figure + a stated factor.
  // The base is resolved WITHIN the same post type (a casino link-insertion
  // premium multiplies the regular link-insertion, not the guest-post rate).
  for (const [, rel] of relByCell) {
    const offer = byCell.get(makeCellKey(rel.website, rel.postType, rel.nicheKey, rel.special))!;
    const base = findBaseOffer(byCell, rel.website, rel.postType, rel.relativeTo, known);
    if (base?.price?.amount != null) {
      offer.price = {
        amount: Math.round(base.price.amount * rel.multiplier * 100) / 100,
        ...(base.price.currency ? { currency: base.price.currency } : {}),
        raw: rel.raw,
      };
    } else if (rel.raw) {
      // Base rate unknown — keep the verbatim premium so provenance survives even
      // though we can't compute a figure.
      offer.price = { raw: rel.raw };
    }
  }

  return { offers: [...byCell.values()], discovered };
}

/** A cell's identity: website tag + post type + niche + special flag. A special
 *  (promo) price is a SEPARATE cell from the standing price so they coexist. */
function makeCellKey(website: string, postType: string, nicheKey: string, special: boolean): string {
  return `${website}|${postType}|${nicheKey}|${special ? 'special' : ''}`;
}

/** A niche priced as a multiple of another (casino = 1.5× regular). */
interface RelativeSpec {
  website: string; // the cell's website tag ('' = contacted site) — scopes base lookup
  postType: string; // the cell's post type (for base lookup + write-back)
  nicheKey: string; // the cell's niche key (for write-back)
  special: boolean; // the cell's special flag (for write-back)
  multiplier: number;
  relativeTo: string; // base niche wording/key; '' → default to 'regular'
  raw: string; // verbatim premium phrase, kept for provenance
}

// Guards a plausibly-real factor: "3-5x" or "+50%" land in (0, 100]; anything
// outside is treated as absent (fall back to whatever priceRaw parsing found).
const MAX_MULTIPLIER = 100;

/** The multiplier/base/raw parts of a relative price. The caller stamps website +
 *  postType + the resolved nicheKey (so write-back hits the same cell). */
function relativeSpec(raw: RawOffer): Omit<RelativeSpec, 'website' | 'postType' | 'nicheKey' | 'special'> | undefined {
  if (raw.priceKind !== 'relative') return undefined;
  const m = Number(raw.multiplier);
  if (!Number.isFinite(m) || m <= 0 || m > MAX_MULTIPLIER) return undefined;
  return {
    multiplier: m,
    relativeTo: (raw.relativeTo ?? '').trim(),
    raw: (raw.priceRaw ?? '').trim(),
  };
}

/** The base offer a relative price multiplies, resolved WITHIN the same website
 *  tag and post type: the named niche if priced, else that type's 'regular' rate,
 *  else the default post type's 'regular', else any absolutely-priced offer for
 *  that website. */
function findBaseOffer(
  byCell: Map<string, PostOffer>,
  website: string,
  postType: string,
  relativeTo: string,
  known: Niche[],
): PostOffer | undefined {
  const priced = (o: PostOffer | undefined) => (o && o.price?.amount != null ? o : undefined);
  // A relative premium always multiplies a STANDING (non-special) base rate.
  if (relativeTo) {
    const rn = matchNiche(relativeTo, known);
    const named = rn ? priced(byCell.get(makeCellKey(website, postType, rn.key, false))) : undefined;
    if (named) return named;
  }
  const sameType = priced(byCell.get(makeCellKey(website, postType, REGULAR_KEY, false)));
  if (sameType) return sameType;
  const defaultType = priced(byCell.get(makeCellKey(website, DEFAULT_POST_TYPE, REGULAR_KEY, false)));
  if (defaultType) return defaultType;
  for (const [key, o] of byCell) {
    if (!key.startsWith(`${website}|`) || key.endsWith('|special')) continue;
    const p = priced(o);
    if (p) return p;
  }
  return undefined;
}

/**
 * Assemble a typed OutreachResult from the LLM's raw extraction. Tolerant of gaps.
 * Returns any newly-discovered niches so the caller can persist them.
 */
export function assembleResult(
  raw: RawExtraction,
  opts: { niches: Niche[]; requestedCategory?: string },
): { result: OutreachResult; discovered: Niche[] } {
  const { offers, discovered } = reconcileOffers(raw.offers ?? [], opts.niches);
  const knownWithDiscovered = [...opts.niches, ...discovered];
  // The summary canPost is about the CONTACTED site's requested niche as a guest
  // post (what the outreach asked about). Offers the owner tagged with a DIFFERENT
  // site they own (website set) are for another domain — never let them decide the
  // contacted target's summary. Resolve within guest_post first, then any type.
  const ownSite = offers.filter((o) => !o.website);
  const guestOffers = ownSite.filter((o) => o.postType === DEFAULT_POST_TYPE);
  const summary =
    resolveOffer(guestOffers, opts.requestedCategory, knownWithDiscovered) ??
    resolveOffer(ownSite, opts.requestedCategory, knownWithDiscovered) ??
    guestOffers.find((o) => o.category === 'regular') ??
    ownSite.find((o) => o.category === 'regular');
  const result: OutreachResult = {
    canPost: summary?.canPost ?? 'maybe', // back-compat summary
    optOut: Boolean(raw.optOut),
    intent: coerceIntent(raw.intent),
    ...(opts.requestedCategory ? { requestedCategory: opts.requestedCategory } : {}),
    offers,
    ...(raw.reasoning ? { reasoning: raw.reasoning } : {}),
    ...(raw.conditions ? { conditions: raw.conditions } : {}),
    ...(raw.notes ? { notes: raw.notes } : {}),
  };
  return { result, discovered };
}
