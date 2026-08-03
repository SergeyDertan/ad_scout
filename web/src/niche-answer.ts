// "What would a post in THIS niche cost on THIS domain?"
//
// Publishers quote what they were asked about, not a full rate card, so most
// domains never mention most niches. Matching the niche key literally answers
// the wrong question: filtering for VPN would hide a casino site that has never
// been asked about VPN and would almost certainly quote the same grey-niche
// price. What actually rules a site out is an explicit refusal.
//
// So a niche filter resolves to one of four verdicts:
//
//   yes       they named this niche and will take it → their own price
//   maybe     either they hedged on it by name, or they never mentioned it but
//             priced OTHER niches in the same tier → the range those siblings cost
//   no        they refused it: this niche by name, or the whole tier around it
//   unknown   nothing here answers the question — no quote, and no same-tier
//             price to go on, since a regular-post price says nothing about a
//             sensitive one. Not a result: such a domain is not shown at all.
//
// A niche is always quoted at its CHEAPEST placement term — see priceLabel.
//
// Inference is per TIER, and the tier is the viewer's own classification. Which
// means an UNCLASSIFIED niche cannot be inferred for at all: without knowing
// whether it is grey or regular there is no defensible peer group, and pooling
// everything would answer a casino query with a $40 regular price — the exact
// mistake tiering exists to prevent. Unclassified niches therefore return only
// what publishers actually quoted, and inference switches on once the niche is
// classified. (The operator console classifies everything, so this never
// applies there.)

import { tierOf, type DomainCell, type PriceValue, type Tier } from './types';

/** The umbrella niche key: a blanket grey-niche answer ("no sensitive topics",
 *  "any grey niche is $500") rather than a named vertical. */
export const SENSITIVE_KEY = 'sensitive';

/** 'unknown' is the "don't show this domain" case — see the header comment. */
export type NicheVerdict = 'yes' | 'maybe' | 'no' | 'unknown';

export interface NicheAnswer {
  verdict: NicheVerdict;
  /** True when no cell named this niche and the verdict comes from same-tier
   *  siblings. Drives the "we're extrapolating" hint in the UI — it qualifies a
   *  'no' every bit as much as a 'maybe'. */
  inferred: boolean;
  /** The cells the verdict (and the price) came from. */
  from: DomainCell[];
  /** Display label: "500 USD", "850–900 USD", "850 USD / 800 EUR", or "—". */
  price: string;
}

const UNKNOWN: NicheAnswer = { verdict: 'unknown', inferred: false, from: [], price: '—' };

/** A refusal carries no price — what they won't sell has no rate. */
const refused = (from: DomainCell[], inferred: boolean): NicheAnswer =>
  ({ verdict: 'no', inferred, from, price: '—' });

/** Does this cell speak for `tier`? The umbrella key counts as sensitive
 *  whatever the viewer has (or hasn't) classified 'sensitive' itself as —
 *  "no grey niches" is a statement about the tier by definition. */
function speaksFor(cell: DomainCell, tier: Tier): boolean {
  return tierOf(cell) === tier || (cell.category === SENSITIVE_KEY && tier === 'sens');
}

/**
 * Resolve one domain's standing cells against a niche filter.
 * A verdict of 'unknown' means the domain should not appear in the results.
 *
 * `tier` is the filtered niche's tier — it has to be passed in because the
 * interesting case is precisely the one where this domain has no cell for that
 * niche to read it from.
 */
export function answerForNiche(cells: DomainCell[], niche: string, tier: Tier): NicheAnswer {
  // 1. Did they name this niche? Their own words win over anything inferred.
  const named = cells.filter((c) => c.category === niche);
  if (named.length > 0) {
    const open = named.filter((c) => c.canPost !== 'no');
    if (open.length === 0) return refused(named, false); // they said no to this niche
    return {
      verdict: open.some((c) => c.canPost === 'yes') ? 'yes' : 'maybe',
      inferred: false,
      from: open,
      price: priceLabel(open),
    };
  }

  // 2. A blanket refusal of the whole grey area rules out every sensitive niche.
  //    It outranks the sibling pass below: when a site both quotes casino and
  //    says "no grey niches", the refusal is the safer of two contradictions.
  const umbrella = cells.filter((c) => c.category === SENSITIVE_KEY);
  if (tier === 'sens' && umbrella.length > 0 && umbrella.every((c) => c.canPost === 'no'))
    return refused(umbrella, true);

  if (tier === 'unknown') return UNKNOWN; // no tier ⇒ no peer group ⇒ no honest read

  // 3. Infer from what they DID price in the same tier. Only cells they said yes
  //    to: a 'maybe' priced elsewhere is too weak to extrapolate from, and a 'no'
  //    for one vertical says nothing about the price of another.
  //    A blanket sensitive quote lands here too — it answers the tier, not the
  //    niche, so it reads as 'maybe' like any other extrapolation.
  const sameTier = cells.filter((c) => speaksFor(c, tier));
  const siblings = sameTier.filter((c) => c.canPost === 'yes' && c.category !== niche);
  if (siblings.length > 0) return { verdict: 'maybe', inferred: true, from: siblings, price: priceLabel(siblings) };

  // 4. Nothing in this tier is on offer and everything in it was refused: the
  //    site takes nothing of this kind, so the unasked niche is a no as well.
  //    Only when the refusals are ALL the tier evidence there is — a single 'no'
  //    alongside a 'maybe' is an open question, not a closed door.
  if (sameTier.length > 0 && sameTier.every((c) => c.canPost === 'no')) return refused(sameTier, true);

  return UNKNOWN;
}

/**
 * A price range across cells, grouped by currency.
 *
 * A niche is worth ONE number here, and that number is its CHEAPEST placement
 * term. Prices are keyed by niche × duration, so casino at 1 month = $100 and
 * casino at 3 months = $200 are two cells for one niche — reporting them as
 * "100–200" would read as uncertainty about the casino price when it is really
 * a choice of product. The entry price is the one that answers "what does a
 * post here cost?", so the longer terms fold away.
 *
 * That collapse happens BEFORE the range is taken, which is what keeps the
 * inferred answer honest too: siblings are compared at their entry prices, so a
 * 6-month quote for one niche can't stretch the top of a range that a 1-month
 * quote for another niche sets the bottom of.
 *
 * Currencies are never mixed into one range — 850 USD and 800 EUR have no
 * meaningful min or max between them, so they are listed side by side and the
 * reader converts if they care.
 */
export function priceLabel(cells: DomainCell[]): string {
  // currency → niche → cheapest amount quoted for that niche in that currency.
  const byCurrency = new Map<string, Map<string, number>>();
  const rawOnly: string[] = [];
  for (const c of cells) {
    const p: PriceValue | undefined = c.price;
    if (!p) continue;
    if (p.amount === undefined) {
      if (p.raw) rawOnly.push(p.raw);
      continue;
    }
    const cur = p.currency ?? p.currencyRaw ?? '';
    let perNiche = byCurrency.get(cur);
    if (!perNiche) byCurrency.set(cur, (perNiche = new Map()));
    const cheapest = perNiche.get(c.category);
    if (cheapest === undefined || p.amount < cheapest) perNiche.set(c.category, p.amount);
  }

  if (byCurrency.size === 0) return rawOnly[0] ?? '—';

  // Unlabelled amounts last: a bare number is the least informative of the set.
  const currencies = [...byCurrency.keys()].sort((a, b) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)));
  return currencies
    .map((cur) => {
      const amounts = [...byCurrency.get(cur)!.values()];
      const lo = Math.min(...amounts);
      const hi = Math.max(...amounts);
      const span = lo === hi ? `${lo}` : `${lo}–${hi}`;
      return cur ? `${span} ${cur}` : span;
    })
    .join(' / ');
}
