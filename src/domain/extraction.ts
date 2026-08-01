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
  PlacementTerm,
  PostOffer,
  PriceValue,
  ReplyIntent,
} from './types';
import {
  isNonGuestProduct,
  matchNiche,
  normalizeKey,
  REGULAR_KEY,
  resolveOffer,
} from './niches';
import { parseTerm } from './terms';

/** One offer as the LLM returns it: a niche tag + willingness + a verbatim price. */
export interface RawOffer {
  category: string; // an existing niche key/label, or a NEW snake_case key
  label: string; // human-readable niche name (used when it's a new niche)
  sensitive: boolean; // is this a grey/sensitive niche?
  canPost: CanPost;
  priceRaw: string;
  /** The placement DURATION this price buys, VERBATIM ("for a month", "1 week",
   *  "whole year"), or "" when the reply named none. The LLM only quotes; the
   *  month/day arithmetic happens in parseTerm, same split as multiplier/addend.
   *  One offer per duration quoted — each is its own price cell. */
  termRaw?: string;
  /** How to read priceRaw. 'relative' = priced only off another niche's rate — a
   *  MULTIPLE (casino = "+50% premium") and/or a flat ADD-ON (casino = "€150 extra");
   *  'absolute' (default) = a real figure. Keeps the LLM out of arithmetic — it names
   *  the multiplier/addend, we compute base × multiplier + addend. */
  priceKind?: 'absolute' | 'relative';
  /** For relative pricing: the factor (1.5 for "+50%", 2 for "double"). 0 = none. */
  multiplier?: number;
  /** For relative pricing: a FLAT surcharge added on top of the base ("€150 extra",
   *  "$60 surcharge" → 150 / 60). 0 = none. total = base × multiplier + addend. */
  addend?: number;
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
  /** One entry per niche the owner priced/addressed (regular + any sensitive). */
  offers: RawOffer[];
  /** One short line explaining the offer classification. */
  reasoning: string;
  /** A few sentences on how the reply was read — the fuller account a human
   *  reads when a price looks wrong. */
  aiExplanation?: string;
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
  required: ['category', 'label', 'sensitive', 'canPost', 'priceRaw', 'termRaw', 'priceKind', 'multiplier', 'addend', 'relativeTo', 'website', 'isSpecial', 'specialUntil'],
  properties: {
    category: {
      type: 'string',
      description:
        'Niche key for this guest-post price. REUSE a key from the known-niches list when it fits; otherwise a new lowercase_snake_case key (e.g. "short_term_loans").',
    },
    label: { type: 'string', description: 'Human-readable niche name, e.g. "Short-term loans".' },
    sensitive: {
      type: 'boolean',
      description: 'true if this is a grey/sensitive niche (casino, vpn, gambling, adult, crypto, loans, ...).',
    },
    canPost: {
      type: 'string',
      enum: ['yes', 'no', 'maybe'],
      description:
        'yes = will publish a guest post in this niche. no = EXPLICITLY refuses this niche — emit the offer anyway, with priceRaw "" (a refusal is a cell, and the only thing that rules the site out for that niche). maybe = they addressed the niche but were vague/conditional. NEVER use "no" for a niche the reply simply did not mention: omit that niche entirely.',
    },
    priceRaw: {
      type: 'string',
      description: 'Guest-post price for this niche EXACTLY as written (e.g. "$150", "150 EUR/post"). "" if not stated — always "" when canPost is "no".',
    },
    termRaw: {
      type: 'string',
      description:
        'The placement DURATION this price buys, EXACTLY as written ("for a month", "3 months", "1 week", "whole year", "permanent"), or "" when no duration is mentioned (the usual case for a guest post). Emit a SEPARATE offer for EACH duration quoted: "99$ for a month and 150$ for 3 months" → two offers, same niche, termRaw "for a month" / "3 months". Never convert to a number and never merge two durations into one offer.',
    },
    priceKind: {
      type: 'string',
      enum: ['absolute', 'relative'],
      description:
        'absolute = priceRaw is a real figure ($150). relative = this niche has NO figure of its own and is priced only OFF another rate — a multiple ("casino +50% premium", "3-5x the listed price") AND/OR a flat add-on ("casino €150 extra", "$60 sensitive surcharge"). Use relative ONLY then; NEVER emit the bare surcharge/multiplier as an absolute figure.',
    },
    multiplier: {
      type: 'number',
      description:
        'When priceKind=relative, the factor to multiply the base rate by: "+50% premium" → 1.5, "double" → 2, "3-5x" → use the lower bound 3. 0 when there is no multiple (a pure flat add-on) or when absolute.',
    },
    addend: {
      type: 'number',
      description:
        'When priceKind=relative, a FLAT surcharge ADDED on top of the base rate: "€150 extra" → 150, "$60 surcharge" → 60. 0 when there is no flat add-on (a pure multiple) or when absolute. Final price = base × multiplier + addend.',
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
    required: ['optOut', 'intent', 'offers', 'reasoning', 'aiExplanation', 'conditions', 'notes', 'isSpam'],
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
          'One entry per NICHE the owner priced or addressed FOR A GUEST POST — a written article we supply, whatever they call it (guest post, sponsored post, sponsored article, publication, placement, content). ALWAYS include the regular (standard) guest-post price when given, plus any grey-niche guest-post pricing (casino, vpn, or the generic "sensitive"). "Addressed" INCLUDES REFUSED: a niche they explicitly say they will not publish is an entry with canPost "no" and priceRaw ""; a blanket "no grey niches" is ONE entry, category "sensitive", canPost "no". We do NOT buy any other product: if they quote a LINK INSERTION / niche edit / link in an existing article, a BANNER / display ad, or anything else that is not a new article, SKIP it entirely — emit no offer for it, and never file its price under a niche. Do NOT invent cells the owner did not mention: a niche the reply is SILENT about gets NO entry at all, because silence is neither a yes nor a no.',
        items: OFFER_SCHEMA,
      },
      reasoning: {
        type: 'string',
        description:
          'One short line (max ~20 words) explaining the niche classification, e.g. "Owner priced casino $150 and regular $60; no other niches mentioned".',
      },
      aiExplanation: {
        type: 'string',
        description:
          'A FEW SENTENCES (2-4, at most ~80 words) in plain prose explaining how you read this reply, for a human checking a price that looks wrong. Cover what matters here: which figure you took for which niche and why, how you decided each price\'s duration, which SITE each price belongs to (and why you tagged a different site, if you did), where the numbers came from (the email body, an attached or linked price list — say which), and anything you deliberately DISCARDED (a link-insertion or banner price, other sites in a price list). Be concrete and cite the owner\'s own words for the key figures. If something was ambiguous, say so plainly instead of hiding it. No bullet points, no line breaks, no preamble.',
      },
      conditions: { type: 'string' },
      notes: { type: 'string' },
    },
  };
}

// Prefixed dollar/other marks checked BEFORE the bare '$', so "R$ 300" reads as BRL
// (not USD) and its verbatim mark is kept. Order matters: longer prefixes first.
const PREFIXED_SYMBOLS: [string, string][] = [
  ['US$', 'USD'], ['NZ$', 'NZD'], ['HK$', 'HKD'], ['A$', 'AUD'], ['C$', 'CAD'],
  ['R$', 'BRL'], ['S$', 'SGD'], ['zł', 'PLN'], ['kr', undefined as unknown as string],
];
// Bare symbol → ISO. '$' is intentionally the dominant USD reading; a prefixed
// A$/C$/R$ is disambiguated above.
const CURRENCY_SYMBOLS: Record<string, string> = {
  $: 'USD',
  '€': 'EUR',
  '£': 'GBP',
  '₴': 'UAH',
};
// ISO codes we normalize `currency` to. Generous so common global currencies map
// cleanly; anything outside still lands in currencyRaw for later resolution.
const CURRENCY_CODES = [
  'USD', 'EUR', 'GBP', 'UAH', 'PLN', 'CAD', 'AUD', 'CHF', 'SEK', 'NOK', 'DKK', 'CZK',
  'HUF', 'RON', 'TRY', 'INR', 'JPY', 'CNY', 'BRL', 'MXN', 'ZAR', 'NZD', 'SGD', 'HKD',
  'AED', 'ILS', 'RUB', 'BGN', 'NGN',
];

// Currencies spelled out as words (very common: "350 euro", "90 euros plus VAT").
// Normalized like the codes; the verbatim word is kept in currencyRaw. Ordered so
// nothing shadows another. 'dollar' is USD to match the bare-'$' default.
const CURRENCY_WORDS: [RegExp, string][] = [
  [/\beuros?\b/i, 'EUR'],
  [/\bdollars?\b/i, 'USD'],
  [/\bpounds?\b/i, 'GBP'],
  [/\bz[łl]otych?\b/i, 'PLN'],
  [/\bhryvnias?\b/i, 'UAH'],
  [/\brubles?\b/i, 'RUB'],
];

// Price-adjacent words that are NOT currencies — keeps the fallback below from
// mistaking a unit/qualifier for an unknown currency token.
const NON_CURRENCY_WORDS = new Set([
  'per', 'post', 'posts', 'each', 'link', 'links', 'word', 'words', 'month', 'year',
  'week', 'day', 'days', 'net', 'vat', 'tax', 'and', 'for', 'the', 'min', 'max', 'pcs', 'pc',
]);
// Lowercase ASCII currency abbreviations worth keeping despite looking like words.
const KNOWN_LOWER_CURRENCIES = new Set(['kr', 'lei', 'kn', 'lv']);

/**
 * A currency indicator we do NOT normalize but still preserve: any Unicode
 * currency-symbol char (¥ ₹ ₩ ₪ ฿ …), or a short letter token abutting the amount
 * that looks currency-ish (non-ASCII like "грн", all-caps like an unlisted code, or
 * a known lowercase abbrev). Undefined when nothing plausible sits by the number.
 */
function detectCurrencyToken(value: string): string | undefined {
  const sc = value.match(/\p{Sc}/u);
  if (sc) return sc[0];
  // A 2–4 letter token directly before or (preferably) after the amount.
  const m = value.match(/(?:(\p{L}{2,4})\s?)?\d[\d.,]*(?:\s?(\p{L}{2,4}))?/u);
  const cand = (m?.[2] ?? m?.[1] ?? '').trim();
  if (!cand || NON_CURRENCY_WORDS.has(cand.toLowerCase())) return undefined;
  const nonAscii = /[^\x00-\x7f]/.test(cand);
  if (nonAscii || cand === cand.toUpperCase() || KNOWN_LOWER_CURRENCIES.has(cand.toLowerCase())) {
    return cand;
  }
  return undefined;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// A currency indicator (prefixed mark, Unicode symbol, ISO code, or spelled word)
// used to locate the number that IS the price, so a stray leading figure like the
// "12" in "12 months … $2500" is never mistaken for the amount.
const CUR_WORDS_ALT = 'euros?|dollars?|pounds?|z[łl]otych?|hryvnias?|rubles?';
const CUR_IND = `(?:${PREFIXED_SYMBOLS.map(([m]) => escapeRe(m)).join('|')}|\\p{Sc}|\\b(?:${CURRENCY_CODES.join('|')}|${CUR_WORDS_ALT}|${[...KNOWN_LOWER_CURRENCIES].join('|')})\\b)`;
const NUM = '\\d[\\d.]*';
const CUR_BEFORE_NUM = new RegExp(`${CUR_IND}\\s?(${NUM})`, 'iu');
const CUR_AFTER_NUM = new RegExp(`(${NUM})\\s?${CUR_IND}`, 'iu');

/** The first plain number in a string, or undefined. */
function firstNumber(s: string): number | undefined {
  const m = s.match(/\d[\d.]*/);
  const n = m ? Number(m[0]) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

/** The number that sits next to a currency indicator (the actual price), earliest
 *  in the string. Undefined when no currency-tagged figure is present. */
function currencyAdjacentNumber(seg: string): number | undefined {
  const a = CUR_BEFORE_NUM.exec(seg);
  const b = CUR_AFTER_NUM.exec(seg);
  let best: { idx: number; num: string } | undefined;
  if (a) best = { idx: a.index, num: a[1]! };
  if (b && (!best || b.index < best.idx)) best = { idx: b.index, num: b[1]! };
  if (!best) return undefined;
  const n = Number(best.num);
  return Number.isFinite(n) ? n : undefined;
}

/** Billing-period preference for tiered prices: 12-month/annual (0) beats 6-month
 *  (1) beats everything else (2) — lower wins.
 *
 *  FALLBACK ONLY. Each duration is now its own offer with its own PlacementTerm
 *  (see terms.ts), so a tiered quote should arrive pre-split and never reach here.
 *  This handles the degraded case where the model packed several tiers into one
 *  priceRaw anyway: rather than grabbing whatever number came first, take the
 *  longest committed term, which is the one the publisher is anchoring on. */
function periodRank(s: string): number {
  if (/\b(?:12\s*months?|1\s*year|annual(?:ly)?|yearly|per\s*year|a\s*year)\b/i.test(s)) return 0;
  if (/\b(?:6\s*months?|half[-\s]*year)\b/i.test(s)) return 1;
  return 2;
}

/** Select the amount from a (thousands-normalized) price string. Splits tiered
 *  quotes on "/", takes each segment's currency-tagged figure (falling back to its
 *  first number), then prefers the best billing period, ties broken by reading order. */
function selectAmount(normalized: string): number | undefined {
  const cands: { amount: number; rank: number }[] = [];
  for (const seg of normalized.split(/\s*\/\s*/)) {
    const amt = currencyAdjacentNumber(seg) ?? firstNumber(seg);
    if (amt != null) cands.push({ amount: amt, rank: periodRank(seg) });
  }
  if (cands.length === 0) return firstNumber(normalized);
  let best = cands[0]!;
  for (const c of cands) if (c.rank < best.rank) best = c; // first of the best rank
  return best.amount;
}

/** Parse a verbatim price string into { amount?, currency?, currencyRaw?, raw }.
 *  Undefined if empty. `currency` is a normalized ISO code (only when confident);
 *  `currencyRaw` is the token as written, captured even for currencies we can't map. */
export function parsePrice(raw: string): PriceValue | undefined {
  const value = (raw ?? '').trim();
  if (!value) return undefined;
  // Normalize number formatting first: strip thousands separators (dot/comma/space/
  // nbsp before a 3-digit group so "12.000"/"16 000" → 12000), then turn a decimal
  // comma into a dot ("182,50" → "182.50"). Currency detection still uses `value`.
  const normalized = value
    .replace(/(?<=\d)[.,  ](?=\d{3}\b)/g, '')
    .replace(/(\d),(\d)/g, '$1.$2');
  const amount = selectAmount(normalized);

  let currency: string | undefined;
  let currencyRaw: string | undefined;

  // 1a. Prefixed marks (R$, A$, zł, kr, …) before the bare-symbol pass.
  for (const [mark, iso] of PREFIXED_SYMBOLS) {
    if (value.includes(mark)) {
      currencyRaw = mark;
      if (iso) currency = iso;
      break;
    }
  }
  // 1b. Bare symbol → ISO + verbatim token.
  if (!currencyRaw) {
    for (const sym of Object.keys(CURRENCY_SYMBOLS)) {
      if (value.includes(sym)) {
        currency = CURRENCY_SYMBOLS[sym];
        currencyRaw = sym;
        break;
      }
    }
  }
  // 2. ISO code written out. Leading guard is "not a letter" (not \b) so a code
  //    glued to the amount still matches ("105eur", "600USD"); trailing \b stays.
  if (!currency) {
    const m = value.match(new RegExp(`(?<![A-Za-z])(${CURRENCY_CODES.join('|')})\\b`, 'i'));
    if (m) {
      currency = m[1]!.toUpperCase();
      currencyRaw ??= m[1];
    }
  }
  // 2b. Spelled-out currency word ("euro", "dollars", "pound").
  if (!currency) {
    for (const [re, iso] of CURRENCY_WORDS) {
      const m = value.match(re);
      if (m) {
        currency = iso;
        currencyRaw ??= m[0];
        break;
      }
    }
  }
  // 3. currencyRaw only — an indicator we can't normalize yet, kept to resolve later.
  currencyRaw ??= detectCurrencyToken(value);

  return {
    ...(amount !== undefined && Number.isFinite(amount) ? { amount } : {}),
    ...(currency ? { currency } : {}),
    ...(currencyRaw ? { currencyRaw } : {}),
    raw: value,
  };
}

/**
 * Reconcile the LLM's raw offers against the known niche registry:
 *  - drop anything that is not a guest post (a link insertion, a banner),
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
  // Keyed by niche + website + special + TERM. A guest post is the only product,
  // but the same niche can be quoted at several durations ("$99/month, $150/3
  // months"), and each duration is its own cell with its own price history.
  const byCell = new Map<string, PostOffer>();
  // Relative-priced offers ("casino is double"), resolved in a second pass. They
  // are NOT cells yet: a term-less relative fans out across every term the base
  // niche was quoted at, so one raw offer can become several cells.
  const relatives: RelativeSpec[] = [];

  for (const raw of rawOffers ?? []) {
    // Backstop behind the prompt: a price for a product we don't buy must never
    // become a niche cell, or a $99 link insertion would masquerade as the
    // guest-post rate for that niche.
    if (isNonGuestProduct(raw.category) || isNonGuestProduct(raw.label)) continue;
    let niche = matchNiche(raw.category, known) ?? matchNiche(raw.label, known);
    if (!niche) {
      const key = normalizeKey(raw.category) || normalizeKey(raw.label);
      if (!key) continue; // unusable — skip rather than store junk
      const aliases = [raw.label, raw.category].filter((s) => s && s.trim()).map((s) => s.trim());
      niche = { key, label: raw.label?.trim() || raw.category.trim(), sensitive: Boolean(raw.sensitive), aliases };
      known.push(niche);
      discovered.push(niche);
    }
    // A website tag scopes the cell: a casino price for casik.ua is a distinct
    // cell from a casino price for the contacted site, so they never merge and
    // relative pricing resolves its base WITHIN the same site. A special (promo)
    // price ALSO scopes the cell — it must coexist with the standing price (D5),
    // never overwrite it.
    const website = (raw.website ?? '').trim();
    const specialUntil = (raw.specialUntil ?? '').trim();
    const term = parseTerm(raw.termRaw);
    const template: PostOffer = {
      category: niche.key,
      label: niche.label,
      sensitive: niche.sensitive,
      canPost: raw.canPost ?? 'maybe',
      term,
      ...(website ? { website } : {}),
      ...(raw.isSpecial ? { isSpecial: true } : {}),
      ...(specialUntil ? { specialUntil } : {}),
    };
    const relBase = relativeSpec(raw);
    if (relBase) {
      // A relative offer's priceRaw is a premium phrase ("+50%", "3-5x listed"),
      // NOT a figure — parsing it as absolute grabbed a bogus leading number. It
      // also isn't a cell yet: which terms it produces depends on the base niche.
      relatives.push({ ...relBase, website, template });
      continue;
    }
    const price = parsePrice(raw.priceRaw ?? '');
    const offer: PostOffer = { ...template, ...(price ? { price } : {}) };
    const cellKey = makeCellKey(website, niche.key, Boolean(raw.isSpecial), term.key);
    const existing = byCell.get(cellKey);
    // Keep the richer entry if the LLM emitted the same cell twice.
    if (!existing || (!existing.price && offer.price)) byCell.set(cellKey, offer);
  }

  // Second pass: casino = 1.5 × regular, or regular + €150. The LLM only named the
  // multiplier/addend and the base niche; the arithmetic stays here, in tested code,
  // so nothing is hallucinated and every amount traces back to a base figure + a
  // stated factor/surcharge.
  //
  // The premium applies PER TERM: if regular is $100/month and $150/2 months, then
  // "casino is double" means casino $200/month AND $300/2 months. So a relative
  // offer that names no term of its own FANS OUT across every term its base niche
  // was quoted at, inheriting each base's term wholesale.
  for (const rel of relatives) {
    const bases = findBaseOffers(byCell, rel.website, rel.relativeTo, known);
    // A relative that DOES name a term ("casino 3-month is double") multiplies
    // only that term; one that names none takes them all.
    const targets = rel.template.term.key === 'none'
      ? bases
      : bases.filter((b) => b.term.key === rel.template.term.key);
    if (targets.length === 0) {
      // Base rate unknown — keep the verbatim premium so provenance survives even
      // though we can't compute a figure.
      if (rel.raw) writeDerived(byCell, rel, rel.template.term, { raw: rel.raw });
      continue;
    }
    const factor = rel.multiplier > 0 ? rel.multiplier : 1; // pure add-on ⇒ ×1
    for (const base of targets) {
      writeDerived(byCell, rel, base.term, {
        amount: Math.round((base.price!.amount! * factor + rel.addend) * 100) / 100,
        ...(base.price!.currency ? { currency: base.price!.currency } : {}),
        ...(base.price!.currencyRaw ? { currencyRaw: base.price!.currencyRaw } : {}),
        raw: rel.raw,
      });
    }
  }

  return { offers: [...byCell.values()], discovered };
}

/** Write one cell derived from a relative premium. An EXPLICIT absolute quote
 *  always wins: "casino is double, but casino 12-month is a flat $500" leaves the
 *  12-month cell at $500 rather than overwriting it with the computed figure. */
function writeDerived(
  byCell: Map<string, PostOffer>,
  rel: RelativeSpec,
  term: PlacementTerm,
  price: PriceValue,
): void {
  const key = makeCellKey(rel.website, rel.template.category, Boolean(rel.template.isSpecial), term.key);
  const existing = byCell.get(key);
  if (existing?.price) return;
  byCell.set(key, { ...rel.template, term, price });
}

/** A cell's identity: website tag + niche + special flag + placement term. A
 *  special (promo) price is a SEPARATE cell from the standing price so they
 *  coexist (D5); so is each quoted duration, so each keeps its own history. */
function makeCellKey(website: string, nicheKey: string, special: boolean, termKey: string): string {
  return `${website}|${nicheKey}|${special ? 'special' : ''}|${termKey}`;
}

/** A niche priced off another: a multiple (casino = 1.5× regular) and/or a flat
 *  surcharge (casino = regular + €150). total = base × multiplier + addend. */
interface RelativeSpec {
  website: string; // the cell's website tag ('' = contacted site) — scopes base lookup
  /** The offer minus its price: niche/label/sensitive/canPost/website/special, plus
   *  the term the LLM gave it ('none' ⇒ fan out over all of the base's terms). Each
   *  derived cell is this template with the base's term and the computed price. */
  template: PostOffer;
  multiplier: number; // 0 = no multiple (pure add-on)
  addend: number; // 0 = no flat surcharge (pure multiple)
  relativeTo: string; // base niche wording/key; '' → default to 'regular'
  raw: string; // verbatim premium phrase, kept for provenance
}

// Guards a plausibly-real factor: "3-5x" or "+50%" land in (0, 100]; anything
// outside is treated as absent (fall back to whatever priceRaw parsing found).
const MAX_MULTIPLIER = 100;
// A flat surcharge is a real money amount; guard against a runaway parse.
const MAX_ADDEND = 1_000_000;

/** The multiplier/addend/base/raw parts of a relative price. Valid when it carries
 *  a usable multiplier OR a flat addend. The caller stamps website + the resolved
 *  nicheKey (so write-back hits the same cell). */
function relativeSpec(raw: RawOffer): Omit<RelativeSpec, 'website' | 'template'> | undefined {
  if (raw.priceKind !== 'relative') return undefined;
  const mRaw = Number(raw.multiplier);
  const aRaw = Number(raw.addend);
  const multiplier = Number.isFinite(mRaw) && mRaw > 0 && mRaw <= MAX_MULTIPLIER ? mRaw : 0;
  const addend = Number.isFinite(aRaw) && aRaw > 0 && aRaw <= MAX_ADDEND ? aRaw : 0;
  if (multiplier === 0 && addend === 0) return undefined; // neither factor nor add-on
  return {
    multiplier,
    addend,
    relativeTo: (raw.relativeTo ?? '').trim(),
    raw: (raw.priceRaw ?? '').trim(),
  };
}

/** EVERY priced cell of the base niche a relative price multiplies — one per term
 *  the base was quoted at — resolved WITHIN the same website tag: the named niche
 *  if priced, else the 'regular' rate, else whichever niche does have prices.
 *  Returning the whole set (not one offer) is what lets a premium fan out across
 *  terms: "casino is double" doubles the monthly AND the 3-month base rate. */
function findBaseOffers(
  byCell: Map<string, PostOffer>,
  website: string,
  relativeTo: string,
  known: Niche[],
): PostOffer[] {
  // A relative premium always multiplies a STANDING (non-special) base rate.
  const standing = [...byCell.values()].filter(
    (o) => (o.website ?? '') === website && !o.isSpecial && o.price?.amount != null,
  );
  const forNiche = (key: string) => standing.filter((o) => o.category === key);
  if (relativeTo) {
    const rn = matchNiche(relativeTo, known);
    const named = rn ? forNiche(rn.key) : [];
    if (named.length) return named;
  }
  const regular = forNiche(REGULAR_KEY);
  if (regular.length) return regular;
  // Last resort: all the terms of the first niche that carries a price, so the
  // fan-out still spans terms rather than collapsing to one arbitrary cell.
  const fallback = standing[0];
  return fallback ? forNiche(fallback.category) : [];
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
  // The summary canPost is about the CONTACTED site's requested niche (what the
  // outreach asked about). Offers the owner tagged with a DIFFERENT site they own
  // (website set) are for another domain — never let them decide the contacted
  // target's summary.
  const ownSite = offers.filter((o) => !o.website);
  const summary =
    resolveOffer(ownSite, opts.requestedCategory, knownWithDiscovered) ??
    ownSite.find((o) => o.category === 'regular');
  const result: OutreachResult = {
    canPost: summary?.canPost ?? 'maybe', // back-compat summary
    optOut: Boolean(raw.optOut),
    intent: coerceIntent(raw.intent),
    ...(opts.requestedCategory ? { requestedCategory: opts.requestedCategory } : {}),
    offers,
    ...(raw.reasoning ? { reasoning: raw.reasoning } : {}),
    ...(raw.aiExplanation?.trim() ? { aiExplanation: raw.aiExplanation.trim() } : {}),
    ...(raw.conditions ? { conditions: raw.conditions } : {}),
    ...(raw.notes ? { notes: raw.notes } : {}),
  };
  return { result, discovered };
}
