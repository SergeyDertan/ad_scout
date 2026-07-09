// Builds the self-contained HTML export entirely in the browser: it stitches the
// template, the embedded normalized model, the standalone mini-app, and an inlined
// copy of SheetJS into one file the user can open offline and re-export from.
//
// SheetJS (~900 KB) is imported dynamically as a raw string, so it only loads
// when the user actually generates an HTML page — the initial bundle stays lean.

import { fileStem, type ExportModel } from './model';
import template from './standalone/template.html?raw';
import appJs from './standalone/app.js?raw';

export async function buildStandaloneHtml(model: ExportModel, header: string): Promise<string> {
  const sheetjs = (await import('xlsx/dist/xlsx.full.min.js?raw')).default;
  // Escape "<" so nothing in the JSON (or a stray "</script>") can break out of
  // the inline <script> that carries it.
  const data = JSON.stringify({ model, header }).replace(/</g, '\\u003c');

  // Function replacers so "$" sequences inside SheetJS / the JSON are inserted
  // literally rather than interpreted as replacement patterns.
  return template
    .replace('/*__SHEETJS__*/', () => sheetjs)
    .replace('/*__EXPORT_DATA__*/', () => data)
    .replace('/*__APP__*/', () => appJs);
}

/** Trigger a browser download of the assembled HTML file. */
export function downloadHtml(html: string, header: string): void {
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${fileStem(header)}.html`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
