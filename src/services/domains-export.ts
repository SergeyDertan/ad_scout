// The domains export: the spreadsheet an operator buys from.
//
// This used to be built in the browser from whatever rows the Domains page was
// holding, which meant an export silently stopped at the visible page (50 rows)
// while claiming to be "the domains matching your filters". The table is built
// here now, over every matching row, and the server writes the file.
//
// Three shapes, chosen in the console's export dialog:
//
//   • 'regular' — Domain, Regular price
//   • 'both'    — Domain, Regular price, Sensitive price   (the default)
//   • 'all'     — Domain + Records/Specials/Last quote + one column per niche,
//                 the full price matrix
//
// Every shape carries the batch(es) the site was imported in, so a sheet
// exported across batches can still be grouped by import.
//
// A price shows only when the publisher will post it (canPost === 'yes'), so the
// collapsed columns read as an actionable rate card rather than raw quotes.
//
// Pure except for `domainsExportWorkbook`, which is where `xlsx` is touched —
// lazily, so a send pass never pays to load it.

import { canonicalTerm, compareTerms, termLabel } from '../domain/terms';
import type { PriceValue } from '../domain/types';
import type { DomainCellRow, DomainRow } from './read-models';

export type DomainExportScope = 'regular' | 'both' | 'all';

export const DOMAIN_EXPORT_SCOPES: DomainExportScope[] = ['regular', 'both', 'all'];

export interface DomainExportTable {
  columns: string[];
  body: (string | number)[][];
}

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
function domainCurrency(cells: DomainCellRow[]): string {
  const seen: string[] = [];
  for (const cell of cells) {
    const currency = cell.price?.currency ?? cell.price?.currencyRaw;
    if (currency && !seen.includes(currency)) seen.push(currency);
  }
  return seen.join('/');
}

/**
 * The one representative regular/sensitive price for a domain. Considers only
 * cells the publisher will post (canPost === 'yes'), prefers the generic
 * 'regular'/'sensitive' bucket, then a cell that actually carries a number.
 * Undefined when nothing qualifies.
 */
function pickCell(cells: DomainCellRow[], sensitive: boolean): DomainCellRow | undefined {
  const pool = cells.filter((cell) => cell.canPost === 'yes' && cell.sensitive === sensitive);
  if (pool.length === 0) return undefined;
  const preferred = sensitive ? 'sensitive' : 'regular';
  return [...pool].sort((a, b) => {
    const ac = a.category === preferred ? 0 : 1;
    const bc = b.category === preferred ? 0 : 1;
    if (ac !== bc) return ac - bc;
    const ap = a.price?.amount == null ? 1 : 0;
    const bp = b.price?.amount == null ? 1 : 0;
    if (ap !== bp) return ap - bp;
    // Among equals, the SHORTEST placement term is the representative rate: a
    // 12-month figure isn't comparable to another publisher's one-off article
    // price, so ranking on it would punish publishers who quote annually.
    return compareTerms(a.term, b.term);
  })[0];
}

function pickPrice(cells: DomainCellRow[], sensitive: boolean): string | number {
  return priceValue(pickCell(cells, sensitive)?.price);
}

/** The placement term behind the representative price, so the collapsed columns
 *  can never be read as a flat rate when they are in fact a rental. */
function pickTerm(cells: DomainCellRow[], sensitive: boolean): string {
  const cell = pickCell(cells, sensitive);
  return cell?.term && cell.term.key !== 'none' ? termLabel(cell.term) : '';
}

/** Exact whole months for the representative price — blank for terms we can't
 *  express in months ("1 week"), so a spreadsheet filter on this column inherits
 *  the same guarantee the data model gives: no accidental matches. */
function pickTermMonths(cells: DomainCellRow[], sensitive: boolean): string | number {
  return pickCell(cells, sensitive)?.term?.months ?? '';
}

/** The imports a site came in with. Usually one; a re-imported site carries
 *  several, and all of them are named — a sheet showing only the first would read
 *  as "this domain is not in that batch". Blank for a site no batch covers. */
function batchesLabel(row: DomainRow): string {
  return row.batches
    .map((ref) => ref.name?.trim() || `batch ${ref.id.replace(/^batch_/, '').slice(0, 8)}`)
    .join('; ');
}

/** Marks a domain whose prices come from more than one email source: the distinct
 *  sender count when >1, blank otherwise (so multi-source rows stand out). */
function sourcesMark(row: DomainRow): string | number {
  return row.sourceCount > 1 ? row.sourceCount : '';
}

const cellKey = (cell: DomainCellRow) => `${cell.category}|${cell.term?.key ?? 'none'}`;

/** Header + body, shared by the dialog's preview and the written sheet (no title row). */
export function buildDomainsExport(rows: DomainRow[], scope: DomainExportScope): DomainExportTable {
  if (scope !== 'all') {
    // Term/Months sit next to the price they qualify: blank on the ordinary
    // one-off guest post, filled when the quote buys a fixed-length placement.
    const columns = scope === 'regular'
      ? ['Domain', 'Regular price', 'Term', 'Months', 'Currency', 'Price sources', 'Batch']
      : ['Domain', 'Regular price', 'Term', 'Months', 'Sensitive price', 'Currency', 'Price sources', 'Batch'];
    const body = rows.map((row) => {
      const cells = row.cells;
      const line: (string | number)[] = [
        row.domain,
        pickPrice(cells, false),
        pickTerm(cells, false),
        pickTermMonths(cells, false),
      ];
      if (scope === 'both') line.push(pickPrice(cells, true));
      line.push(domainCurrency(cells));
      line.push(sourcesMark(row));
      line.push(batchesLabel(row));
      return line;
    });
    return { columns, body };
  }

  // 'all' — one column per niche × TERM present across the exported domains. The
  // term belongs in the column identity: a publisher's monthly and yearly rates
  // are different products, and sharing a column would let one overwrite the other.
  const comboMap = new Map<string, { key: string; label: string; sensitive: boolean; cell: DomainCellRow }>();
  for (const row of rows) {
    for (const cell of row.cells) {
      const key = cellKey(cell);
      if (comboMap.has(key)) continue;
      const niche = cell.label || cell.category;
      // Canonical, not the publisher's phrasing: this header names a column every
      // domain shares, and their raw phrases for one duration disagree.
      const term = cell.term && cell.term.key !== 'none' ? ` (${canonicalTerm(cell.term)})` : '';
      comboMap.set(key, { key, sensitive: cell.sensitive, label: `${niche}${term}`, cell });
    }
  }
  const combos = [...comboMap.values()].sort(
    (a, b) =>
      Number(a.sensitive) - Number(b.sensitive) ||
      (a.cell.label || a.cell.category).localeCompare(b.cell.label || b.cell.category) ||
      compareTerms(a.cell.term, b.cell.term),
  );

  const columns = [
    'Domain', 'Records', 'Price sources', 'Specials', 'Last quote', 'Currency', 'Batch',
    ...combos.map((combo) => combo.label),
  ];
  const body = rows.map((row) => {
    const byKey = new Map<string, string | number>();
    for (const cell of row.cells) byKey.set(cellKey(cell), priceValue(cell.price));
    return [
      row.domain,
      row.recordCount,
      sourcesMark(row),
      row.activeSpecials || '',
      // Written as an ISO date, not a locale string: the sheet is read in
      // whatever locale the operator opens it in, and the server's is irrelevant.
      row.lastObservedAt ? row.lastObservedAt.slice(0, 10) : '',
      domainCurrency(row.cells),
      batchesLabel(row),
      ...combos.map((combo) => byKey.get(combo.key) ?? ''),
    ];
  });
  return { columns, body };
}

/** Rough column widths so the sheet opens readable rather than all-narrow. */
function colWidths(aoa: (string | number | null)[][]): { wch: number }[] {
  const headerRow = aoa.find((row) => row.length > 1) ?? aoa[aoa.length - 1] ?? [];
  return headerRow.map((_, i) => {
    let max = 8;
    for (const row of aoa) {
      const value = row[i];
      if (value != null) max = Math.max(max, String(value).length + 2);
    }
    return { wch: Math.min(max, 40) };
  });
}

/** kebab a title into a safe filename stem. */
export function fileStem(title: string): string {
  const stem = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return stem || 'adscout-domains';
}

/** The .xlsx bytes for a table, with `title` as the first row when non-empty. */
export async function domainsExportWorkbook(
  table: DomainExportTable,
  title: string,
): Promise<Buffer> {
  // Lazy: the console downloads a sheet now and then, while every send/poll pass
  // boots this process. It should not pay for a spreadsheet writer.
  const XLSX = await import('xlsx');
  const aoa: (string | number | null)[][] = [];
  if (title.trim()) {
    aoa.push([title.trim()]);
    aoa.push([]);
  }
  aoa.push(table.columns);
  for (const line of table.body) aoa.push(line);

  const sheet = XLSX.utils.aoa_to_sheet(aoa);
  sheet['!cols'] = colWidths(aoa);
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, 'Domains');
  return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}
