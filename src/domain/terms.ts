// Placement terms — how long a price buys the post for. Pure, no I/O.
//
// A publisher may quote the SAME niche at several durations ("99$ for a month,
// 150$ for 3 months"). Each duration is its own price cell (see makeCellKey), so
// each gets an independent price history. This module turns the verbatim phrase
// the LLM copied out of the reply into a canonical PlacementTerm.
//
// The four fields do four different jobs, and keeping them apart is the point:
//   key    — identity (the cell-key component). Equal keys = the same cell.
//   days   — ORDERING. Present whenever a duration was stated, so everything
//            sortable sorts, including terms we can't express in months.
//   months — EXACT-MONTH FILTERING. Set ONLY for whole months, so a "12 month"
//            filter can never silently swallow a 1-week or 45-day placement.
//   raw    — provenance: what the publisher actually wrote.
// That is how a "1 week for $5" quote stays fully stored, sorted and exported
// while staying invisible to month-based queries (the reason for the split).

import type { PlacementTerm } from './types';

/** Days per month, used ONLY to give month terms a sortable `days`. Months are
 *  the source of truth for those terms; this is an ordering aid, not a date calc. */
const DAYS_PER_MONTH = 30;

/** "Duration not mentioned at all" — the overwhelmingly common case, and a
 *  DISTINCT cell from an explicit "permanent" (which is a promise, not a gap). */
export const TERM_NONE: PlacementTerm = { key: 'none', raw: '' };

/** An explicit forever-placement. */
const TERM_PERM_KEY = 'perm';

/** Word-boundary matching that also works for Cyrillic and accented Latin: JS `\b`
 *  is defined in terms of ASCII \w, so `\bмесяц\b` never matches at all. */
const uword = (alt: string) => new RegExp(`(?<!\\p{L})(?:${alt})(?!\\p{L})`, 'iu');

/** Phrases that mean "we never take it down". Distinct from TERM_NONE by design:
 *  saying nothing is not the same as promising permanence. */
const PERMANENT_RE = uword(
  'permanent\\p{L}*|perpetual|lifetime|life[-\\s]?time|for[-\\s]?ever|indefinite(?:ly)?|no\\s+removal|never\\s+(?:removed?|deleted?)|for\\s+life|навсегда|назавжди|постоянн\\p{L}*|dauerhaft|définitif' +
    // Romance/Slavic "for an indefinite period": a tempo indeterminato (it),
    // tiempo indefinido (es), na czas nieokreślony (pl). Each is a promise of
    // permanence, so it belongs in the same cell as "permanent" — not in its own
    // other:* cell, which is where they all landed before.
    '|indeterminat\\p{L}*|indefinid\\p{L}*|nieokreślon\\p{L}*|neurčit\\p{L}*',
);

/** Phrases that promise permanence without using a permanence WORD — "for the
 *  entire duration of the site" is a publisher saying it never comes down. Kept
 *  separate from PERMANENT_RE because these are multi-word and need no boundary. */
const PERMANENT_PHRASE_RE =
  /entire\s+duration|whole\s+(?:life|duration)|as\s+long\s+as\s+the\s+(?:site|website|domain)|sin\s+fecha\s+de\s+cadu/iu;

// Unit vocabularies. English first, plus the languages that actually show up in
// the inbox — the same pragmatic approach parsePrice takes with currency words.
// NB: no bare "an" — the English article would turn "an article" into a 1-year term.
// NB: Portuguese "anos"/"ano" and Italian "anni"/"anno" were missing, so every
// "publicados por 5 anos" / "online 2 anni" fell through to an other:* cell.
const YEAR_RE = uword('years?|yrs?|annual(?:ly)?|yearly|год[ауие]*|лет|рік|рок[иу]|років|años?|anos?|ann[oi]|ans|années?|jahre?n?|rok[ui]?|lata?');
const MONTH_RE = uword('months?|mos?\\.?|monthly|месяц\\p{L}*|місяц\\p{L}*|mes(?:es|i)?|mois|monate?n?|miesi[ąa]c\\p{L}*');
const WEEK_RE = uword('weeks?|wks?\\.?|weekly|недел\\p{L}*|тижн\\p{L}*|semanas?|semaines?|settiman[ae]|wochen?|tydzie[ńn]|tygodni\\p{L}*');
const DAY_RE = uword('days?|dias?|días?|giorn[oi]|jours?|tage?n?|дн\\p{L}*|день|dni|dzie[ńn]');

/** Spelled-out counts. "a month" is by far the most common ("99$ for a month"). */
const WORD_NUMBERS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  один: 1, одну: 1, два: 2, три: 3, шесть: 6, двенадцать: 12,
};

/** Terms that name a period without naming a unit. */
const NAMED_PERIODS: [RegExp, number][] = [
  [/\bhalf[-\s]?(?:a[-\s]?)?year\b|\bполгода\b/iu, 6],
  [/\bquarter(?:ly)?\b|\bквартал\w*\b/iu, 3],
  [/\bsemester\b/iu, 6],
];

/** The count sitting immediately before a unit word ("3 months", "a month"),
 *  or 1 when the unit stands alone ("monthly", "for a year"). */
function countBefore(text: string, unit: RegExp): number | undefined {
  const m = unit.exec(text);
  if (!m) return undefined;
  // Drop the joiner between count and unit before reading the count. A hyphen is
  // as common as a space in this position ("12-month", "two-year"), and leaving
  // it attached defeated BOTH matchers below — which then fell through to the
  // `return 1` at the bottom, silently turning "12-month" into one month and
  // "two-year period" into one year.
  const before = text.slice(0, m.index).replace(/[\s ]*[-–—]?[\s ]*$/u, '');

  // A parenthesised numeral restating the word before it — "three (3) years" —
  // is the most precise figure on offer, so it is read first.
  const paren = /\((\d+(?:[.,]\d+)?)\)$/.exec(before);
  if (paren) {
    const n = Number(paren[1]!.replace(',', '.'));
    if (Number.isFinite(n) && n > 0) return n;
  }
  // A digit count, possibly fractional ("1.5 months") or a range ("3-6 months",
  // where the LOWER bound is what we can promise — same convention as "3-5x").
  const digits = /(\d+(?:[.,]\d+)?)\s*(?:[-–—]\s*\d+(?:[.,]\d+)?)?$/.exec(before);
  if (digits) {
    const n = Number(digits[1]!.replace(',', '.'));
    if (Number.isFinite(n) && n > 0) return n;
  }
  const word = /([\p{L}]+)$/u.exec(before);
  if (word) {
    const n = WORD_NUMBERS[word[1]!.toLowerCase()];
    if (n) return n;
  }
  // Nothing quantifies the unit, which is itself the statement of quantity:
  // "monthly", "year", "per month per article", "/site/year". All mean one.
  return 1;
}

/** Build a whole-month term: key "12m", months set (filterable), days for sorting. */
function monthsTerm(months: number, raw: string): PlacementTerm {
  return { key: `${months}m`, days: months * DAYS_PER_MONTH, months, raw };
}

/** Build a sub-month / non-month term: key "7d", days set (sortable) but NO
 *  months, so month filters skip it while the data stays intact. */
function daysTerm(days: number, raw: string): PlacementTerm {
  // An exact multiple of 30 days IS a month quote in every publisher's mouth
  // ("30 days" = "1 month"), so it collapses rather than forming a rival cell.
  if (days % DAYS_PER_MONTH === 0) return monthsTerm(days / DAYS_PER_MONTH, raw);
  return { key: `${days}d`, days, raw };
}

/** A stated-but-unparseable term ("до снятия", "until we rotate it"). Keyed by a
 *  slug so two DIFFERENT odd terms stay in different cells, and carrying no
 *  days/months so it is excluded from every numeric query. */
function otherTerm(raw: string): PlacementTerm {
  const slug = raw.toLowerCase().replace(/\s+/g, '-').replace(/[^\p{L}\p{N}-]/gu, '').slice(0, 40);
  return { key: slug ? `other:${slug}` : 'none', raw };
}

/**
 * Normalize a verbatim duration phrase into a canonical PlacementTerm.
 *
 * Years fold into months ("1 year" → 12m) so the same duration is always the
 * same cell however it was written. Weeks fold into days ("1 week" → 7d), for
 * the same reason. Sub-month terms keep `days` only — they sort and export, but
 * carry no `months`, so they can never satisfy a month filter.
 */
export function parseTerm(raw: string | undefined): PlacementTerm {
  const value = (raw ?? '').trim();
  if (!value) return TERM_NONE;
  if (PERMANENT_RE.test(value) || PERMANENT_PHRASE_RE.test(value)) return { key: TERM_PERM_KEY, raw: value };

  for (const [re, months] of NAMED_PERIODS) {
    if (re.test(value)) return monthsTerm(months, value);
  }

  // Longest unit first: "1 year 6 months" reads as the year (the headline term).
  const years = countBefore(value, YEAR_RE);
  if (years != null) {
    const months = years * 12;
    return Number.isInteger(months) ? monthsTerm(months, value) : daysTerm(Math.round(years * 365), value);
  }
  const months = countBefore(value, MONTH_RE);
  if (months != null) {
    // A fractional month ("1.5 months") is not a whole-month term — down to days.
    return Number.isInteger(months) ? monthsTerm(months, value) : daysTerm(Math.round(months * DAYS_PER_MONTH), value);
  }
  const weeks = countBefore(value, WEEK_RE);
  if (weeks != null) return daysTerm(Math.round(weeks * 7), value);
  const days = countBefore(value, DAY_RE);
  if (days != null) return daysTerm(Math.round(days), value);

  return otherTerm(value);
}

/** Is this term an exact whole number of months? (i.e. safe for month filters) */
export function hasMonths(term: PlacementTerm | undefined): boolean {
  return term?.months != null;
}

/** Human label for a term: the publisher's own words when we have them, else a
 *  canonical rendering. "—" for an unstated term. */
export function termLabel(term: PlacementTerm | undefined): string {
  if (!term || term.key === 'none') return '—';
  if (term.raw) return term.raw;
  if (term.key === TERM_PERM_KEY) return 'permanent';
  if (term.months != null) return `${term.months} month${term.months === 1 ? '' : 's'}`;
  if (term.days != null) return `${term.days} day${term.days === 1 ? '' : 's'}`;
  return term.key;
}

/** Sort by duration: shortest first, then the indefinite terms (unstated,
 *  permanent, unparseable) at the far end. */
export function compareTerms(a: PlacementTerm | undefined, b: PlacementTerm | undefined): number {
  const rank = (t: PlacementTerm | undefined): number => {
    if (!t || t.key === 'none') return 2;
    if (t.days != null) return 0;
    return 1; // perm / other:* — stated, but no measurable length
  };
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra - rb;
  if (ra === 0) return a!.days! - b!.days!;
  return (a?.key ?? '').localeCompare(b?.key ?? '');
}
