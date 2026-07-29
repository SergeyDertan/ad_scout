// XLSX export of the (filtered) known-domains list. Sourced from the folded
// per-domain standing cells the /domains list already carries, so no per-domain
// fetch is needed. Three shapes, chosen in DomainsExportDialog:
//
//   • 'regular' — Domain, Regular price
//   • 'both'    — Domain, Regular price, Sensitive price   (the default)
//   • 'all'     — Domain + Records/Specials/Last quote + one column per niche,
//                 the full price matrix
//
// A price shows only when the publisher will post it (canPost === 'yes'), so the
// collapsed columns read as an actionable rate card rather than raw quotes.

import { fileStem } from './model';
import { compareTerms, formatTerm, type DomainCell, type DomainSummary, type PriceValue } from '../types';

export type DomainExportScope = 'regular' | 'both' | 'all';

export const DOMAIN_EXPORT_SCOPES: { value: DomainExportScope; label: string; hint: string }[] = [
  { value: 'both', label: 'Regular + sensitive', hint: 'Domain, regular price, sensitive price' },
  { value: 'regular', label: 'Regular only', hint: 'Domain, regular price' },
  { value: 'all', label: 'All data', hint: 'Every niche price column' },
];

export interface DomainExportTable {
  columns: string[];
  body: (string | number)[][];
}

const canOffer = (c: DomainCell) => c.canPost === 'yes';

/** Numeric amount when known, else the raw quote, else '' (blank cell). */
function priceValue(price?: PriceValue): string | number {
  if (!price) return '';
  if (price.amount != null) return price.amount;
  return price.raw || '';
}

/** A domain's quoting currency. A domain almost always quotes in one currency, so
 *  this is usually a single code; when a domain genuinely mixes currencies across
 *  its cells (rare) ALL distinct ones are joined ("GBP/USD") rather than silently
 *  picking one, so the bare price numbers are never mislabelled. Blank when none. */
function domainCurrency(cells: DomainCell[]): string {
  const seen: string[] = [];
  for (const c of cells) {
    const cur = c.price?.currency ?? c.price?.currencyRaw;
    if (cur && !seen.includes(cur)) seen.push(cur);
  }
  return seen.join('/');
}

/**
 * The one representative regular/sensitive price for a domain. Considers only
 * cells the publisher will post (canPost === 'yes'), prefers the generic
 * 'regular'/'sensitive' bucket, then a cell that actually carries a number.
 * Blank when nothing qualifies.
 */
function pickCell(cells: DomainCell[], sensitive: boolean): DomainCell | undefined {
  const pool = cells.filter((c) => canOffer(c) && c.sensitive === sensitive);
  if (pool.length === 0) return undefined;
  const preferredCat = sensitive ? 'sensitive' : 'regular';
  const sorted = [...pool].sort((a, b) => {
    const ac = a.category === preferredCat ? 0 : 1;
    const bc = b.category === preferredCat ? 0 : 1;
    if (ac !== bc) return ac - bc;
    const ap = a.price?.amount == null ? 1 : 0;
    const bp = b.price?.amount == null ? 1 : 0;
    if (ap !== bp) return ap - bp;
    // Among equals, the SHORTEST placement term is the representative rate: a
    // 12-month figure isn't comparable to another publisher's one-off article
    // price, so ranking on it would punish publishers who quote annually.
    return compareTerms(a.term, b.term);
  });
  return sorted[0];
}

function pickPrice(cells: DomainCell[], sensitive: boolean): string | number {
  return priceValue(pickCell(cells, sensitive)?.price);
}

/** The placement term behind the representative regular price, so the collapsed
 *  columns can never be read as a flat rate when they are in fact a rental. */
function pickTerm(cells: DomainCell[], sensitive: boolean): string {
  const cell = pickCell(cells, sensitive);
  return cell?.term && cell.term.key !== 'none' ? formatTerm(cell.term) : '';
}

/** Exact whole months for the representative regular price — blank for terms we
 *  can't express in months ("1 week"), so a spreadsheet filter on this column
 *  inherits the same guarantee the data model gives: no accidental matches. */
function pickTermMonths(cells: DomainCell[], sensitive: boolean): string | number {
  return pickCell(cells, sensitive)?.term?.months ?? '';
}

/** Marks a domain whose prices come from more than one email source: the distinct
 *  sender count when >1, blank otherwise (so multi-source rows stand out). */
function sourcesMark(d: DomainSummary): string | number {
  return (d.sourceCount ?? 0) > 1 ? d.sourceCount! : '';
}

/** Build the header + body the preview and the sheet share (no title row). */
export function buildDomainsExport(domains: DomainSummary[], scope: DomainExportScope): DomainExportTable {
  if (scope !== 'all') {
    // Term/Months sit next to the price they qualify: blank on the ordinary
    // one-off guest post, filled when the quote buys a fixed-length placement.
    const columns = scope === 'regular'
      ? ['Domain', 'Regular price', 'Term', 'Months', 'Currency', 'Price sources']
      : ['Domain', 'Regular price', 'Term', 'Months', 'Sensitive price', 'Currency', 'Price sources'];
    const body = domains.map((d) => {
      const cells = d.cells ?? [];
      const row: (string | number)[] = [
        d.domain,
        pickPrice(cells, false),
        pickTerm(cells, false),
        pickTermMonths(cells, false),
      ];
      if (scope === 'both') row.push(pickPrice(cells, true));
      row.push(domainCurrency(cells));
      row.push(sourcesMark(d));
      return row;
    });
    return { columns, body };
  }

  // 'all' — one column per niche × TERM present across the exported domains. The
  // term belongs in the column identity: a publisher's monthly and yearly rates
  // are different products, and sharing a column would let one overwrite the other.
  const comboMap = new Map<string, { key: string; label: string; sensitive: boolean; cell: DomainCell }>();
  const cellKey = (c: DomainCell) => `${c.category}|${c.term?.key ?? 'none'}`;
  for (const d of domains) {
    for (const c of d.cells ?? []) {
      const key = cellKey(c);
      if (!comboMap.has(key)) {
        const niche = c.label || c.category;
        const term = c.term && c.term.key !== 'none' ? ` (${formatTerm(c.term)})` : '';
        comboMap.set(key, { key, sensitive: c.sensitive, label: `${niche}${term}`, cell: c });
      }
    }
  }
  const combos = [...comboMap.values()].sort(
    (a, b) =>
      Number(a.sensitive) - Number(b.sensitive) ||
      (a.cell.label || a.cell.category).localeCompare(b.cell.label || b.cell.category) ||
      compareTerms(a.cell.term, b.cell.term),
  );

  const columns = ['Domain', 'Records', 'Price sources', 'Specials', 'Last quote', 'Currency', ...combos.map((c) => c.label)];
  const body = domains.map((d) => {
    const byKey = new Map<string, string | number>();
    for (const c of d.cells ?? []) byKey.set(cellKey(c), priceValue(c.price));
    return [
      d.domain,
      d.recordCount,
      sourcesMark(d),
      d.activeSpecials || '',
      d.lastObservedAt ? new Date(d.lastObservedAt).toLocaleDateString() : '',
      domainCurrency(d.cells ?? []),
      ...combos.map((c) => byKey.get(c.key) ?? ''),
    ];
  });
  return { columns, body };
}

/** Rough column widths so the sheet opens readable rather than all-narrow. */
function colWidths(aoa: (string | number | null)[][]): { wch: number }[] {
  const headerRow = aoa.find((r) => r.length > 1) ?? aoa[aoa.length - 1] ?? [];
  return headerRow.map((_, i) => {
    let max = 8;
    for (const row of aoa) {
      const v = row[i];
      if (v != null) max = Math.max(max, String(v).length + 2);
    }
    return { wch: Math.min(max, 40) };
  });
}

export function defaultDomainsHeader(): string {
  return `AdScout — domains export (${new Date().toLocaleDateString()})`;
}

export async function exportDomainsXlsx(
  domains: DomainSummary[],
  scope: DomainExportScope,
  header: string,
): Promise<void> {
  const XLSX = await import('xlsx');
  const { columns, body } = buildDomainsExport(domains, scope);

  const aoa: (string | number | null)[][] = [];
  if (header.trim()) {
    aoa.push([header.trim()]);
    aoa.push([]);
  }
  aoa.push(columns);
  for (const line of body) aoa.push(line);

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = colWidths(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Domains');
  XLSX.writeFile(wb, `${fileStem(header)}.xlsx`);
}
