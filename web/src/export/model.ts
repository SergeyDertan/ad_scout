// Pure, dependency-free export model shared by the in-app XLSX export
// (web/src/export/xlsx.ts) and the self-contained HTML export
// (web/src/export/html.ts). It flattens the response feed into a wide,
// spreadsheet-friendly shape:
//
//   one row per website  ×  one price column per (product × niche)
//
// e.g. columns "Guest post — Regular", "Guest post — Casino", "Link insertion — VPN".
// The normalized ExportModel is what gets embedded into the standalone HTML, so
// the vanilla-JS mini-app in web/src/export/standalone/app.js re-filters and
// re-exports the SAME data with no server round-trip. Keep buildAoa() here in
// sync with the copy in app.js.

import { formatPrice, postTypeLabel, type Niche, type ResponseRow } from '../types';

/** A (product × niche) pairing that becomes one price column. Key matches the
 *  `offerCellKey` convention "postType|category". */
export interface ComboColumn {
  key: string;
  postType: string;
  category: string;
  label: string;
  sensitive: boolean;
}

export interface MetaColumn {
  key: string;
  label: string;
}

/** Fixed, selectable per-website columns (everything that isn't a price cell). */
export const META_COLUMNS: MetaColumn[] = [
  { key: 'website', label: 'Website' },
  { key: 'email', label: 'Contact email' },
  { key: 'campaign', label: 'Campaign' },
  { key: 'canPost', label: 'Can post' },
  { key: 'received', label: 'Received' },
];

export interface ExportCell {
  raw: string;
  amount: number | null;
  currency: string | null;
  canPost: string;
}

/** One website, with its offers pivoted into a comboKey → cell map. */
export interface ExportRow {
  id: string;
  website: string;
  email: string;
  campaign: string;
  campaignId: string;
  canPost: string;
  received: string;
  receivedLabel: string;
  categories: string[];
  sensitive: boolean;
  cells: Record<string, ExportCell>;
  search: string;
}

export interface ExportModel {
  rows: ExportRow[];
  combos: ComboColumn[];
  niches: { key: string; label: string; sensitive: boolean }[];
  campaigns: { id: string; name: string }[];
  generatedAt: string;
}

export interface ExportSelection {
  meta: string[];
  combos: string[];
  includeCanPost: boolean;
  numericPrices: boolean;
}

const POST_TYPE_ORDER = ['guest_post', 'link_insertion', 'banner'];

function nicheLabel(key: string, niches: Niche[], fallback: string): string {
  return niches.find((n) => n.key === key)?.label ?? fallback ?? key;
}

function comboSort(a: ComboColumn, b: ComboColumn): number {
  const pa = POST_TYPE_ORDER.indexOf(a.postType);
  const pb = POST_TYPE_ORDER.indexOf(b.postType);
  return (
    (pa === -1 ? 99 : pa) - (pb === -1 ? 99 : pb) ||
    Number(a.sensitive) - Number(b.sensitive) ||
    a.label.localeCompare(b.label)
  );
}

/** Flatten the response feed into the normalized, embeddable export model. */
export function buildExportModel(rows: ResponseRow[], niches: Niche[]): ExportModel {
  const comboMap = new Map<string, ComboColumn>();
  const campaignMap = new Map<string, string>();

  const exportRows: ExportRow[] = rows.map((r) => {
    const offers = r.parsed?.offers ?? [];
    const cells: Record<string, ExportCell> = {};
    const cats = new Set<string>();
    let sensitive = false;
    for (const o of offers) {
      const postType = o.postType || 'guest_post';
      const key = `${postType}|${o.category}`;
      if (!comboMap.has(key)) {
        comboMap.set(key, {
          key,
          postType,
          category: o.category,
          label: `${postTypeLabel(postType)} — ${nicheLabel(o.category, niches, o.label)}`,
          sensitive: o.sensitive,
        });
      }
      cells[key] = {
        raw: formatPrice(o.price),
        amount: o.price?.amount ?? null,
        currency: o.price?.currency ?? null,
        canPost: o.canPost ?? '',
      };
      cats.add(o.category);
      if (o.sensitive) sensitive = true;
    }
    if (r.campaignId && r.campaignName) campaignMap.set(r.campaignId, r.campaignName);
    return {
      id: r.id,
      website: r.website ?? '',
      email: r.fromAddress,
      campaign: r.campaignName ?? '',
      campaignId: r.campaignId ?? '',
      canPost: r.parsed?.canPost ?? '',
      received: r.receivedAt ?? '',
      receivedLabel: r.receivedAt ? new Date(r.receivedAt).toLocaleString() : '',
      categories: [...cats],
      sensitive,
      cells,
      search: `${r.website ?? ''} ${r.fromAddress}`.toLowerCase(),
    };
  });

  return {
    rows: exportRows,
    combos: [...comboMap.values()].sort(comboSort),
    niches: niches.map((n) => ({ key: n.key, label: n.label, sensitive: n.sensitive })),
    campaigns: [...campaignMap.entries()]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    generatedAt: new Date().toISOString(),
  };
}

export function defaultSelection(model: ExportModel): ExportSelection {
  return {
    meta: ['website', 'email', 'campaign', 'canPost'],
    combos: model.combos.map((c) => c.key),
    includeCanPost: false,
    numericPrices: true,
  };
}

export function defaultHeader(campaignName?: string): string {
  const scope = campaignName && campaignName.trim() ? campaignName.trim() : 'All campaigns';
  return `AdScout — ${scope} — responses export (${new Date().toLocaleDateString()})`;
}

/** kebab a header/scope into a safe filename stem. */
export function fileStem(header: string): string {
  const stem = header
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return stem || 'adscout-export';
}

function metaValue(r: ExportRow, key: string): string {
  switch (key) {
    case 'website': return r.website;
    case 'email': return r.email;
    case 'campaign': return r.campaign;
    case 'canPost': return r.canPost;
    case 'received': return r.receivedLabel;
    default: return '';
  }
}

function priceValue(cell: ExportCell | undefined, numeric: boolean): string | number {
  if (!cell) return '';
  if (numeric && cell.amount != null) return cell.amount;
  return cell.raw === '—' ? '' : cell.raw;
}

/**
 * Build the array-of-arrays a SheetJS sheet is made from. Kept pure (no SheetJS
 * import) so it works identically in the web app and in the standalone HTML.
 * `rows` is passed separately so the standalone app can feed its re-filtered set.
 */
export function buildAoa(
  model: ExportModel,
  rows: ExportRow[],
  selection: ExportSelection,
  header: string,
): (string | number | null)[][] {
  const metaCols = META_COLUMNS.filter((m) => selection.meta.includes(m.key));
  const combos = selection.combos
    .map((k) => model.combos.find((c) => c.key === k))
    .filter((c): c is ComboColumn => !!c);

  const headerRow: (string | number | null)[] = metaCols.map((m) => m.label);
  for (const c of combos) {
    headerRow.push(c.label);
    if (selection.includeCanPost) headerRow.push(`${c.label} — can post`);
  }

  const body = rows.map((r) => {
    const line: (string | number | null)[] = metaCols.map((m) => metaValue(r, m.key));
    for (const c of combos) {
      const cell = r.cells[c.key];
      line.push(priceValue(cell, selection.numericPrices));
      if (selection.includeCanPost) line.push(cell?.canPost || '');
    }
    return line;
  });

  const aoa: (string | number | null)[][] = [];
  if (header.trim()) {
    aoa.push([header.trim()]);
    aoa.push([]);
  }
  aoa.push(headerRow);
  for (const line of body) aoa.push(line);
  return aoa;
}
