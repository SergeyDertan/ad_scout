// XLSX export of the (filtered) known-domains list. Sourced from the folded
// per-domain standing cells the /domains list already carries, so no per-domain
// fetch is needed. Three shapes, chosen in DomainsExportDialog:
//
//   • 'regular' — Domain, Regular price
//   • 'both'    — Domain, Regular price, Sensitive price   (the default)
//   • 'all'     — Domain + Records/Specials/Last quote + one column per
//                 (product × niche), the full price matrix
//
// A price shows only when the publisher will post it (canPost === 'yes'), so the
// collapsed columns read as an actionable rate card rather than raw quotes.

import { fileStem } from './model';
import { postTypeLabel, type DomainCell, type DomainSummary, type PriceValue } from '../types';

export type DomainExportScope = 'regular' | 'both' | 'all';

export const DOMAIN_EXPORT_SCOPES: { value: DomainExportScope; label: string; hint: string }[] = [
  { value: 'both', label: 'Regular + sensitive', hint: 'Domain, regular price, sensitive price' },
  { value: 'regular', label: 'Regular only', hint: 'Domain, regular price' },
  { value: 'all', label: 'All data', hint: 'Every product × niche price column' },
];

export interface DomainExportTable {
  columns: string[];
  body: (string | number)[][];
}

const POST_TYPE_ORDER = ['guest_post', 'link_insertion', 'banner'];

function ptRank(postType: string): number {
  const i = POST_TYPE_ORDER.indexOf(postType || 'guest_post');
  return i === -1 ? 99 : i;
}

const canOffer = (c: DomainCell) => c.canPost === 'yes';
const cellPostType = (c: DomainCell) => c.postType || 'guest_post';

/** Numeric amount when known, else the raw quote, else '' (blank cell). */
function priceValue(price?: PriceValue): string | number {
  if (!price) return '';
  if (price.amount != null) return price.amount;
  return price.raw || '';
}

/**
 * The one representative regular/sensitive price for a domain. Considers only
 * cells the publisher will post (canPost === 'yes'), prefers the generic
 * 'regular'/'sensitive' bucket, then the primary product (guest post), then a
 * cell that actually carries a number. Blank when nothing qualifies.
 */
function pickPrice(cells: DomainCell[], sensitive: boolean): string | number {
  const pool = cells.filter((c) => canOffer(c) && c.sensitive === sensitive);
  if (pool.length === 0) return '';
  const preferredCat = sensitive ? 'sensitive' : 'regular';
  const sorted = [...pool].sort((a, b) => {
    const ac = a.category === preferredCat ? 0 : 1;
    const bc = b.category === preferredCat ? 0 : 1;
    if (ac !== bc) return ac - bc;
    const r = ptRank(cellPostType(a)) - ptRank(cellPostType(b));
    if (r !== 0) return r;
    return (a.price?.amount == null ? 1 : 0) - (b.price?.amount == null ? 1 : 0);
  });
  return priceValue(sorted[0].price);
}

/** Build the header + body the preview and the sheet share (no title row). */
export function buildDomainsExport(domains: DomainSummary[], scope: DomainExportScope): DomainExportTable {
  if (scope !== 'all') {
    const columns = scope === 'regular'
      ? ['Domain', 'Regular price']
      : ['Domain', 'Regular price', 'Sensitive price'];
    const body = domains.map((d) => {
      const cells = d.cells ?? [];
      const row: (string | number)[] = [d.domain, pickPrice(cells, false)];
      if (scope === 'both') row.push(pickPrice(cells, true));
      return row;
    });
    return { columns, body };
  }

  // 'all' — every (product × niche) column present across the exported domains.
  const comboMap = new Map<string, { key: string; postType: string; label: string; sensitive: boolean }>();
  const cellKey = (c: DomainCell) => `${cellPostType(c)}|${c.category}`;
  for (const d of domains) {
    for (const c of d.cells ?? []) {
      const key = cellKey(c);
      if (!comboMap.has(key)) {
        comboMap.set(key, {
          key,
          postType: cellPostType(c),
          sensitive: c.sensitive,
          label: `${postTypeLabel(cellPostType(c))} — ${c.label || c.category}`,
        });
      }
    }
  }
  const combos = [...comboMap.values()].sort(
    (a, b) =>
      ptRank(a.postType) - ptRank(b.postType) ||
      Number(a.sensitive) - Number(b.sensitive) ||
      a.label.localeCompare(b.label),
  );

  const columns = ['Domain', 'Records', 'Specials', 'Last quote', ...combos.map((c) => c.label)];
  const body = domains.map((d) => {
    const byKey = new Map<string, string | number>();
    for (const c of d.cells ?? []) byKey.set(cellKey(c), priceValue(c.price));
    return [
      d.domain,
      d.recordCount,
      d.activeSpecials || '',
      d.lastObservedAt ? new Date(d.lastObservedAt).toLocaleDateString() : '',
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
