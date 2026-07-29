// Derived per-domain price sheet — pure, no I/O (PRICE-HISTORY-PLAN.md §4.1).
//
// PriceRecords are append-only and event-shaped: each carries ONLY the cells one
// message mentioned. The "current prices" for a domain are folded here at read
// time, never stored (D1/D2): for each niche cell, take the most
// recent record that mentioned it. Cells whose newest mention predates the
// domain's newest record are flagged `stale` (carried over). Specials form a
// parallel layer that annotates — never replaces — the standing cell, and an
// expired specialUntil drops from the active view.

import type { CanPost, ID, ISO, PlacementTerm, PostOffer, PriceRecord, PriceValue } from './types';
import { compareTerms, TERM_NONE } from './terms';

/** A folded standing-price cell for one niche AT ONE placement term. */
export interface PriceCell {
  category: string;
  label: string;
  sensitive: boolean;
  canPost: CanPost;
  price?: PriceValue;
  /** The duration this price buys. `{key:'none'}` when the reply named none.
   *  Part of the cell identity, so a publisher's monthly and 3-month rates fold
   *  independently and each keeps its own history. */
  term: PlacementTerm;
  /** observedAt of the record that last mentioned this cell. */
  asOf: ISO;
  sourceMessageId: string;
  replyId?: ID;
  /** True when this cell's newest mention is older than the domain's newest
   *  record — i.e. carried forward from an earlier message. */
  stale: boolean;
}

/** A promo cell in the parallel special layer. */
export interface SpecialCell extends PriceCell {
  specialUntil?: ISO;
  /** False once past its deadline (a parseable specialUntil earlier than `now`). */
  active: boolean;
}

export interface DomainPriceSheet {
  domain: string;
  /** Standing prices, one per niche, newest mention wins. */
  cells: PriceCell[];
  /** Promo layer (parallel to `cells`); expired ones have active:false. */
  specials: SpecialCell[];
  /** The domain's newest record time (the reference for staleness). */
  lastObservedAt?: ISO;
  recordCount: number;
  optedOut: boolean;
}

/** A cell is a niche AT a term: "regular, 1 month" folds separately from
 *  "regular, 3 months", so a change to one never overwrites the other. Records
 *  written before terms existed carry no `term` — they fold as 'none'. */
function cellKey(o: Pick<PostOffer, 'category' | 'term'>): string {
  return `${o.category}|${o.term?.key ?? TERM_NONE.key}`;
}

/** A specialUntil is "expired" only when it parses to a real date before `now`.
 *  Verbatim/undated deadlines ("end of month") can't be adjudicated → stay active. */
function isSpecialActive(specialUntil: string | undefined, now: Date): boolean {
  if (!specialUntil) return true;
  const t = Date.parse(specialUntil);
  if (Number.isNaN(t)) return true;
  return t >= now.getTime();
}

/**
 * Fold a domain's PriceRecords into its current price sheet. `records` need not be
 * sorted or pre-filtered to the domain — records for other domains are ignored.
 */
export function buildPriceSheet(
  domain: string,
  records: PriceRecord[],
  now: Date = new Date(),
): DomainPriceSheet {
  const mine = records.filter((r) => r.domain === domain);
  const lastObservedAt = mine.reduce<string | undefined>(
    (max, r) => (max == null || r.observedAt > max ? r.observedAt : max),
    undefined,
  );
  const optedOut = mine.some((r) => r.optOut);

  // Latest mention per standing cell and per special cell, tracked separately.
  const standing = new Map<string, PriceCell>();
  const specials = new Map<string, SpecialCell>();

  for (const r of mine) {
    for (const offer of r.offers) {
      const base: PriceCell = {
        category: offer.category,
        label: offer.label,
        sensitive: offer.sensitive,
        canPost: offer.canPost,
        term: offer.term ?? TERM_NONE,
        ...(offer.price ? { price: offer.price } : {}),
        asOf: r.observedAt,
        sourceMessageId: r.sourceMessageId,
        ...(r.replyId ? { replyId: r.replyId } : {}),
        stale: false, // set in a final pass
      };
      if (offer.isSpecial) {
        const key = cellKey(offer);
        const prev = specials.get(key);
        if (!prev || r.observedAt >= prev.asOf) {
          specials.set(key, {
            ...base,
            ...(offer.specialUntil ? { specialUntil: offer.specialUntil } : {}),
            active: isSpecialActive(offer.specialUntil, now),
          });
        }
      } else {
        const key = cellKey(offer);
        const prev = standing.get(key);
        if (!prev || r.observedAt >= prev.asOf) standing.set(key, base);
      }
    }
  }

  const markStale = <T extends PriceCell>(cell: T): T => ({
    ...cell,
    stale: lastObservedAt != null && cell.asOf < lastObservedAt,
  });

  return {
    domain,
    cells: [...standing.values()].map(markStale).sort(byCell),
    specials: [...specials.values()].map(markStale).sort(byCell),
    ...(lastObservedAt ? { lastObservedAt } : {}),
    recordCount: mine.length,
    optedOut,
  };
}

/** Niche first, then shortest term first — so a niche's durations read as a ladder
 *  (1 month, 3 months, 12 months, permanent, unstated). */
function byCell(a: PriceCell, b: PriceCell): number {
  return a.category.localeCompare(b.category) || compareTerms(a.term, b.term);
}

/** The distinct known domains: every domain that has a PriceRecord, unioned with
 *  every target's site domain (D2/§4.2). Caller passes the pre-normalized target
 *  domains. Returns a sorted, de-duplicated list. */
export function knownDomains(records: PriceRecord[], targetDomains: string[]): string[] {
  const set = new Set<string>();
  for (const r of records) if (r.domain) set.add(r.domain);
  for (const d of targetDomains) if (d) set.add(d);
  return [...set].sort();
}
