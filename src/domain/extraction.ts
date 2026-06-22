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
  OutreachResult,
} from './types';

/** The shape the LLM is asked to return (one `raw` answer per field). */
export interface RawExtraction {
  canPost: CanPost;
  optOut: boolean;
  conditions?: string;
  notes?: string;
  fields: Record<string, { raw: string }>;
}

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
    required: ['canPost', 'optOut', 'conditions', 'notes', 'fields'],
    properties: {
      canPost: { type: 'string', enum: ['yes', 'no', 'maybe'] },
      optOut: { type: 'boolean' },
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

/** Convert a verbatim answer to a typed FieldValue per the field's declared type. */
export function parseFieldValue(field: InquiryField, raw: string): FieldValue {
  const value = (raw ?? '').trim();
  switch (field.type) {
    case 'price': {
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
        type: 'price',
        ...(amount !== undefined && Number.isFinite(amount) ? { amount } : {}),
        ...(currency ? { currency } : {}),
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

/** Assemble a typed OutreachResult from the LLM's raw extraction. Tolerant of gaps. */
export function assembleResult(fields: InquiryField[], raw: RawExtraction): OutreachResult {
  const out: Record<string, FieldValue> = {};
  for (const f of fields) {
    const answer = raw.fields?.[f.key]?.raw ?? '';
    out[f.key] = parseFieldValue(f, answer);
  }
  return {
    canPost: raw.canPost ?? 'maybe',
    optOut: Boolean(raw.optOut),
    ...(raw.conditions ? { conditions: raw.conditions } : {}),
    ...(raw.notes ? { notes: raw.notes } : {}),
    fields: out,
  };
}
