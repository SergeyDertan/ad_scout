// Derived per-domain price sheet — pure, no I/O (PRICE-HISTORY-PLAN.md §4.1).
//
// PriceRecords are append-only and event-shaped: each carries ONLY the cells one
// message mentioned. The "current prices" for a domain are folded here at read
// time, never stored (D1/D2): for each (postType × niche) cell, take the most
// recent record that mentioned it. Cells whose newest mention predates the
// domain's newest record are flagged `stale` (carried over). Specials form a
// parallel layer that annotates — never replaces — the standing cell, and an
// expired specialUntil drops from the active view.

import type { CanPost, ID, ISO, PostOffer, PriceRecord, PriceValue } from './types';

/** A folded standing-price cell for one (postType × niche). */
export interface PriceCell {
  postType: string;
  category: string;
  label: string;
  sensitive: boolean;
  canPost: CanPost;
  price?: PriceValue;
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
  /** Standing prices, one per (postType × niche), newest mention wins. */
  cells: PriceCell[];
  /** Promo layer (parallel to `cells`); expired ones have active:false. */
  specials: SpecialCell[];
  /** The domain's newest record time (the reference for staleness). */
  lastObservedAt?: ISO;
  recordCount: number;
  optedOut: boolean;
}

function cellKey(o: Pick<PostOffer, 'postType' | 'category'>): string {
  return `${o.postType}|${o.category}`;
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
        postType: offer.postType,
        category: offer.category,
        label: offer.label,
        sensitive: offer.sensitive,
        canPost: offer.canPost,
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

function byCell(a: PriceCell, b: PriceCell): number {
  return a.postType.localeCompare(b.postType) || a.category.localeCompare(b.category);
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
