// Pure, dependency-free export model shared by the in-app XLSX export
// (web/src/export/xlsx.ts) and the self-contained HTML export
// (web/src/export/html.ts). It flattens the response feed into a wide,
// spreadsheet-friendly shape:
//
//   one row per website  ×  one price column per niche
//
// e.g. columns "Regular", "Casino", "VPN". Guest posts are the only product we
// buy, so a niche alone names a column.
// The normalized ExportModel is what gets embedded into the standalone HTML, so
// the vanilla-JS mini-app in web/src/export/standalone/app.js re-filters and
// re-exports the SAME data with no server round-trip. Keep buildAoa() here in
// sync with the copy in app.js.

import { canonicalTerm, compareTerms, formatPrice, type Niche, type PlacementTerm, type ResponseRow } from '../types';

/** A niche AT a placement term, which is what becomes one price column. The term
 *  belongs in the key: a publisher quoting $99/month and $150/3 months has two
 *  different products, and sharing a column would let one overwrite the other. */
export interface ComboColumn {
  key: string;
  category: string;
  /** Display header — the niche, plus the CANONICAL term when one was stated
   *  ("Casino (3 months)"). Canonical, not the publisher's phrasing: this header
   *  names a column many replies share, and their raw phrases disagree. */
  label: string;
  /** The niche name alone. Sorting uses this so a niche's durations group together
   *  and then order by LENGTH; sorting on `label` would put "(12 months)" before
   *  "(3 months)" alphabetically. */
  baseLabel: string;
  sensitive: boolean;
  /** Absent ⇒ no duration stated (the ordinary one-off guest post). */
  term?: PlacementTerm;
}

export interface MetaColumn {
  key: string;
  label: string;
}

/** Fixed, selectable per-website columns (everything that isn't a price cell).
 *  Order here is the order in the sheet. */
export const META_COLUMNS: MetaColumn[] = [
  { key: 'website', label: 'Website' },
  // The two sides of the conversation, in that order: our mailbox, their sender.
  { key: 'accountEmail', label: 'Our inbox' },
  { key: 'email', label: 'Replied from' },
  { key: 'batch', label: 'Batch' },
  { key: 'canPost', label: 'Can post' },
  { key: 'currency', label: 'Currency' },
  // The at-a-glance summary of everything to its right. Carries a cell note with
  // the full per-niche breakdown, so the sheet reads without 100+ price columns.
  { key: 'priceRange', label: 'Price range' },
  { key: 'received', label: 'Received' },
];

/** The meta column that carries the per-niche breakdown note. */
export const PRICE_RANGE_KEY = 'priceRange';

/** Author on the XLSX cell notes — shows as the bold name above the text. */
export const NOTE_AUTHOR = 'AdScout';

/** Cap on lines in a cell note. A handful of sites quote dozens of niches, and a
 *  note that long is unreadable anyway; the columns still hold every value. */
const NOTE_MAX_LINES = 40;

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
  /** Our mailbox that received the reply. '' when it can't be resolved (an
   *  unmatched reply with no outreach thread behind it). */
  accountEmail: string;
  /** The address the reply came FROM. */
  email: string;
  batch: string;
  batchId: string;
  canPost: string;
  /** The website's quoting currency — first currency seen across its offers.
   *  Disambiguates the bare price numbers in the sheet. '' when none carried one. */
  currency: string;
  received: string;
  receivedLabel: string;
  categories: string[];
  sensitive: boolean;
  cells: Record<string, ExportCell>;
  search: string;
  /** Cheapest–dearest across every priced offer, e.g. "500-999 USD" (or the bare
   *  amount when the site quoted one price). '' when nothing parsed to a number. */
  priceRange: string;
  /** The full per-niche breakdown behind `priceRange`, one "Label: price" per
   *  line. Attached as an XLSX cell note and an HTML hover title. */
  priceNote: string;
}

export interface ExportModel {
  rows: ExportRow[];
  combos: ComboColumn[];
  niches: { key: string; label: string; sensitive: boolean }[];
  batches: { id: string; name: string }[];
  generatedAt: string;
}

export interface ExportSelection {
  meta: string[];
  combos: string[];
  includeCanPost: boolean;
  numericPrices: boolean;
}

function nicheLabel(key: string, niches: Niche[], fallback: string): string {
  return niches.find((n) => n.key === key)?.label ?? fallback ?? key;
}

function comboSort(a: ComboColumn, b: ComboColumn): number {
  return (
    Number(a.sensitive) - Number(b.sensitive) ||
    a.baseLabel.localeCompare(b.baseLabel) ||
    compareTerms(a.term, b.term)
  );
}

/**
 * Cheapest–dearest across a website's priced cells: "500-999 USD", or "500 USD"
 * when every quote lands on the same number.
 *
 * `currencies` is joined rather than compared: a reply that mixes currencies is
 * already flagged in the Currency column, and a range labelled "USD/EUR" is
 * honest about being un-normalized. Better than dropping the range entirely,
 * which would hide the only summary the sheet has.
 */
function priceRange(cells: Record<string, ExportCell>, currencies: string[]): string {
  const amounts = Object.values(cells)
    .map((c) => c.amount)
    .filter((a): a is number => a != null);
  if (!amounts.length) return '';
  const lo = Math.min(...amounts);
  const hi = Math.max(...amounts);
  const span = lo === hi ? String(lo) : `${lo}-${hi}`;
  const cur = currencies.join('/');
  return cur ? `${span} ${cur}` : span;
}

/** The per-niche breakdown behind a row's price range — "Casino (2 years): 400
 *  USD", one per line, in column order. Empty cells are skipped. */
function priceNote(row: ExportRow, combos: ComboColumn[]): string {
  const lines: string[] = [];
  for (const c of combos) {
    const cell = row.cells[c.key];
    if (!cell || cell.raw === '—') continue;
    lines.push(`${c.label}: ${cell.raw}`);
    if (lines.length === NOTE_MAX_LINES) {
      lines.push('…');
      break;
    }
  }
  return lines.join('\n');
}

/** Flatten the response feed into the normalized, embeddable export model. */
export function buildExportModel(rows: ResponseRow[], niches: Niche[]): ExportModel {
  const comboMap = new Map<string, ComboColumn>();
  const batchMap = new Map<string, string>();

  const exportRows: ExportRow[] = rows.map((r) => {
    const offers = r.parsed?.offers ?? [];
    const cells: Record<string, ExportCell> = {};
    const cats = new Set<string>();
    let sensitive = false;
    // Distinct currencies across the reply's offers. Usually one; a multi-site rate
    // card that mixes them (rare) is joined ("GBP/USD") so no cell is mislabelled.
    const currencies: string[] = [];
    for (const o of offers) {
      // Niche + term is the column identity, so a reply quoting the same niche at
      // several durations contributes one column each instead of overwriting itself.
      const termKey = o.term?.key ?? 'none';
      const key = `${o.category}|${termKey}`;
      if (!comboMap.has(key)) {
        const baseLabel = nicheLabel(o.category, niches, o.label);
        comboMap.set(key, {
          key,
          category: o.category,
          baseLabel,
          label: termKey === 'none' ? baseLabel : `${baseLabel} (${canonicalTerm(o.term)})`,
          sensitive: o.sensitive,
          ...(o.term ? { term: o.term } : {}),
        });
      }
      cells[key] = {
        raw: formatPrice(o.price),
        amount: o.price?.amount ?? null,
        currency: o.price?.currency ?? o.price?.currencyRaw ?? null,
        canPost: o.canPost ?? '',
      };
      const cur = o.price?.currency ?? o.price?.currencyRaw;
      if (cur && !currencies.includes(cur)) currencies.push(cur);
      cats.add(o.category);
      if (o.sensitive) sensitive = true;
    }
    if (r.batchId && r.batchName) batchMap.set(r.batchId, r.batchName);
    return {
      id: r.id,
      website: r.website ?? '',
      accountEmail: r.accountEmail ?? '',
      email: r.fromAddress,
      batch: r.batchName ?? '',
      batchId: r.batchId ?? '',
      canPost: r.parsed?.canPost ?? '',
      currency: currencies.join('/'),
      received: r.receivedAt ?? '',
      receivedLabel: r.receivedAt ? new Date(r.receivedAt).toLocaleString() : '',
      categories: [...cats],
      sensitive,
      cells,
      search: `${r.website ?? ''} ${r.fromAddress}`.toLowerCase(),
      priceRange: priceRange(cells, currencies),
      priceNote: '', // filled below, once every column is known
    };
  });

  const combos = [...comboMap.values()].sort(comboSort);
  // Second pass: the note names columns, so it can only be built once the full,
  // sorted column list exists. It lists EVERY niche the site quoted, including
  // columns the user later deselects — that is the point of the note.
  for (const row of exportRows) row.priceNote = priceNote(row, combos);

  return {
    rows: exportRows,
    combos,
    niches: niches.map((n) => ({ key: n.key, label: n.label, sensitive: n.sensitive })),
    batches: [...batchMap.entries()]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    generatedAt: new Date().toISOString(),
  };
}

export function defaultSelection(model: ExportModel): ExportSelection {
  return {
    meta: ['website', 'accountEmail', 'email', 'batch', 'canPost', 'currency', 'priceRange'],
    combos: model.combos.map((c) => c.key),
    includeCanPost: false,
    numericPrices: true,
  };
}

export function defaultHeader(batchName?: string): string {
  const scope = batchName && batchName.trim() ? batchName.trim() : 'All batches';
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
    case 'accountEmail': return r.accountEmail;
    case 'email': return r.email;
    case 'batch': return r.batch;
    case 'canPost': return r.canPost;
    case 'currency': return r.currency;
    case 'priceRange': return r.priceRange;
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

/** A note to hang off one already-written sheet cell (0-based, as buildAoa laid it out). */
export interface CellNote {
  row: number;
  col: number;
  text: string;
}

/**
 * Where the per-niche breakdown notes go, for the same `rows`/`selection`/
 * `header` buildAoa was just called with.
 *
 * Split out rather than folded into buildAoa because an array-of-arrays has
 * nowhere to put a note — the caller attaches these after handing the AoA to
 * SheetJS. Keeping the geometry here (instead of re-deriving it at each call
 * site) means the row/column offsets can only ever be wrong in one place.
 */
export function priceNotes(
  rows: ExportRow[],
  selection: ExportSelection,
  header: string,
): CellNote[] {
  const metaCols = META_COLUMNS.filter((m) => selection.meta.includes(m.key));
  const col = metaCols.findIndex((m) => m.key === PRICE_RANGE_KEY);
  if (col === -1) return [];
  // Mirrors buildAoa: an optional title row + blank spacer, then the header row.
  const firstBodyRow = (header.trim() ? 2 : 0) + 1;
  const notes: CellNote[] = [];
  rows.forEach((r, i) => {
    if (r.priceNote) notes.push({ row: firstBodyRow + i, col, text: r.priceNote });
  });
  return notes;
}
