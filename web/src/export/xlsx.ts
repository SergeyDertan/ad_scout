// In-app "quick" XLSX export. Reuses the lazily-loaded SheetJS the bulk-import
// form already pulls in, and the shared buildAoa() so the sheet is byte-for-byte
// what the standalone HTML would produce for the same selection.

import { buildAoa, fileStem, type ExportModel, type ExportSelection } from './model';

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

export async function exportXlsx(
  model: ExportModel,
  selection: ExportSelection,
  header: string,
): Promise<void> {
  const XLSX = await import('xlsx');
  const aoa = buildAoa(model, model.rows, selection, header);
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = colWidths(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Responses');
  XLSX.writeFile(wb, `${fileStem(header)}.xlsx`);
}
