// In-app "quick" XLSX export. Reuses the lazily-loaded SheetJS the bulk-import
// form already pulls in, and the shared buildAoa() so the sheet is byte-for-byte
// what the standalone HTML would produce for the same selection.

import {
  buildAoa,
  fileStem,
  NOTE_AUTHOR,
  priceNotes,
  type CellNote,
  type ExportModel,
  type ExportSelection,
} from './model';

/** Rough column widths so the sheet opens readable rather than all-narrow. */
function colWidths(aoa: (string | number | null)[][]): { wch: number }[] {
  const headerRow = aoa.find((r) => r.length > 1) ?? [];
  return headerRow.map((_, i) => {
    let max = 8;
    for (const row of aoa) {
      const v = row[i];
      if (v != null) max = Math.max(max, String(v).length + 2);
    }
    return { wch: Math.min(max, 40) };
  });
}

/**
 * Hang the per-niche breakdowns off the Price range cells as Excel comments —
 * the little red corner marker that opens on hover. Applied AFTER aoa_to_sheet
 * because a cell has to exist before it can carry a note; `hidden` keeps them
 * closed until pointed at, rather than papering the sheet with open boxes.
 */
function attachNotes(XLSX: typeof import('xlsx'), ws: import('xlsx').WorkSheet, notes: CellNote[]): void {
  for (const n of notes) {
    const addr = XLSX.utils.encode_cell({ r: n.row, c: n.col });
    const cell = ws[addr];
    if (!cell) continue;
    cell.c = [{ a: NOTE_AUTHOR, t: n.text }];
    cell.c.hidden = true;
  }
}

export async function exportXlsx(
  model: ExportModel,
  selection: ExportSelection,
  header: string,
): Promise<void> {
  const XLSX = await import('xlsx');
  const aoa = buildAoa(model, model.rows, selection, header);
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = colWidths(aoa);
  attachNotes(XLSX, ws, priceNotes(model.rows, selection, header));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Responses');
  XLSX.writeFile(wb, `${fileStem(header)}.xlsx`);
}
