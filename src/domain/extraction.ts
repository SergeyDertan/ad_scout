// Pure extraction helpers (overview.md §6 OutreachResult). No I/O.
//
// Division of labour: the LLM does NLP only — it returns canPost, optOut, and a
// VERBATIM `raw` answer per inquiry field. This deterministic, unit-tested code
// turns each raw string into a typed FieldValue. That keeps the fragile part
// (parsing prices/lists/enums) out of the model and fully testable.

import type {
  CanPost,
  FieldValue,
  InquiryField,
  JsonSchema,
  Niche,
  OutreachResult,
  PostOffer,
  PriceValue,
  ReplyIntent,
} from './types';
import { matchNiche, normalizeKey, resolveOffer } from './niches';

/** One offer as the LLM returns it: a niche tag + willingness + a verbatim price. */
export interface RawOffer {
  category: string; // an existing niche key/label, or a NEW snake_case key
  label: string; // human-readable niche name (used when it's a new niche)
  sensitive: boolean; // is this a grey/sensitive niche?
  canPost: CanPost;
  priceRaw: string;
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
  fields: Record<string, { raw: string }>;
}

const REPLY_INTENTS: ReplyIntent[] = ['answer', 'holding', 'auto_reply', 'question', 'decline', 'other'];

function coerceIntent(raw: string | undefined): ReplyIntent {
  return REPLY_INTENTS.includes(raw as ReplyIntent) ? (raw as ReplyIntent) : 'answer';
}

const OFFER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['category', 'label', 'sensitive', 'canPost', 'priceRaw'],
  properties: {
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
  },
} as const;

/** Build a JSON Schema (structured-output-safe) from a campaign's inquiry fields. */
export function buildExtractionSchema(fields: InquiryField[]): JsonSchema {
  const fieldProps: Record<string, unknown> = {};
  for (const f of fields) {
    fieldProps[f.key] = {
      type: 'object',
      additionalProperties: false,
      required: ['raw'],
      properties: {
        raw: {
          type: 'string',
          description: `Verbatim answer to: "${f.question}". Empty string if not addressed.`,
        },
      },
    };
  }
  return {
    type: 'object',
    additionalProperties: false,
    required: ['optOut', 'intent', 'offers', 'reasoning', 'conditions', 'notes', 'fields'],
    properties: {
      optOut: { type: 'boolean' },
      intent: {
        type: 'string',
        enum: ['answer', 'holding', 'auto_reply', 'question', 'decline', 'other'],
        description:
          'What kind of reply this is. "answer" = a substantive response (gives prices/willingness, or clearly declines). "holding" = an acknowledgement promising a later reply ("we\'ll get back to you", "received, will respond soon"). "auto_reply" = out-of-office/autoresponder. "question" = they ask US something without answering. "decline" = not interested. "other" = none of these.',
      },
      offers: {
        type: 'array',
        description:
          'One entry per post type the owner priced or addressed. ALWAYS include a "regular" entry when a standard/normal post price is mentioned, plus any sensitive niches (casino, vpn, ...). Do not invent entries the owner did not mention.',
        items: OFFER_SCHEMA,
      },
      reasoning: {
        type: 'string',
        description:
          'One short line (max ~20 words) explaining the niche classification, e.g. "Owner priced casino $150 and regular $60; no other niches mentioned".',
      },
      conditions: { type: 'string' },
      notes: { type: 'string' },
      fields: {
        type: 'object',
        additionalProperties: false,
        required: fields.map((f) => f.key),
        properties: fieldProps,
      },
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

const TRUTHY = /\b(yes|yep|sure|of course|we can|possible|available|true|ok|okay)\b/i;
const FALSY = /\b(no|nope|cannot|can't|not possible|unavailable|false|decline)\b/i;

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

/** Convert a verbatim answer to a typed FieldValue per the field's declared type. */
export function parseFieldValue(field: InquiryField, raw: string): FieldValue {
  const value = (raw ?? '').trim();
  switch (field.type) {
    case 'price': {
      const price = parsePrice(value);
      return {
        type: 'price',
        ...(price?.amount !== undefined ? { amount: price.amount } : {}),
        ...(price?.currency ? { currency: price.currency } : {}),
        raw: value,
      };
    }
    case 'list': {
      const values = value
        .split(/[,;\/\n]|(?:\band\b)/i)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      return { type: 'list', values };
    }
    case 'enum': {
      const opts = field.enumValues ?? [];
      const match =
        opts.find((o) => new RegExp(`\\b${escapeRe(o)}\\b`, 'i').test(value)) ??
        opts.find((o) => value.toLowerCase().includes(o.toLowerCase()));
      return { type: 'enum', value: match ?? value };
    }
    case 'boolean': {
      const v = TRUTHY.test(value) ? true : FALSY.test(value) ? false : false;
      return { type: 'boolean', value: v };
    }
    case 'text':
    default:
      return { type: 'text', value };
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
  const byCategory = new Map<string, PostOffer>();

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
    const price = parsePrice(raw.priceRaw ?? '');
    const offer: PostOffer = {
      category: niche.key,
      label: niche.label,
      sensitive: niche.sensitive,
      canPost: raw.canPost ?? 'maybe',
      ...(price ? { price } : {}),
    };
    const existing = byCategory.get(niche.key);
    // Keep the richer entry if the LLM emitted the same niche twice.
    if (!existing || (!existing.price && offer.price)) byCategory.set(niche.key, offer);
  }
  return { offers: [...byCategory.values()], discovered };
}

/**
 * Assemble a typed OutreachResult from the LLM's raw extraction. Tolerant of gaps.
 * Returns any newly-discovered niches so the caller can persist them.
 */
export function assembleResult(
  fields: InquiryField[],
  raw: RawExtraction,
  opts: { niches: Niche[]; requestedCategory?: string },
): { result: OutreachResult; discovered: Niche[] } {
  const out: Record<string, FieldValue> = {};
  for (const f of fields) {
    const answer = raw.fields?.[f.key]?.raw ?? '';
    out[f.key] = parseFieldValue(f, answer);
  }
  const { offers, discovered } = reconcileOffers(raw.offers ?? [], opts.niches);
  const knownWithDiscovered = [...opts.niches, ...discovered];
  const summary =
    resolveOffer(offers, opts.requestedCategory, knownWithDiscovered) ??
    offers.find((o) => o.category === 'regular');
  const result: OutreachResult = {
    canPost: summary?.canPost ?? 'maybe', // back-compat summary
    optOut: Boolean(raw.optOut),
    intent: coerceIntent(raw.intent),
    ...(opts.requestedCategory ? { requestedCategory: opts.requestedCategory } : {}),
    offers,
    ...(raw.reasoning ? { reasoning: raw.reasoning } : {}),
    ...(raw.conditions ? { conditions: raw.conditions } : {}),
    ...(raw.notes ? { notes: raw.notes } : {}),
    fields: out,
  };
  return { result, discovered };
}
