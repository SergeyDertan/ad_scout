// Resolving links a publisher puts in a reply into something the model can
// actually READ.
//
// The failure this exists to prevent: WebFetch on a Google Docs/Sheets/Slides
// link returns the app's JavaScript shell, not the document — ~680 KB of HTML
// with zero prices in it. The model then "reads" an empty page and reports it
// found no rates, which looks exactly like a publisher who never sent any. Same
// story for Drive file links.
//
// So: recognize those links, rewrite them to Google's export endpoints (which
// serve the real content as CSV/TXT/PDF for anyone with the share link), and
// download them ourselves to hand to the model as files. Anything we cannot
// turn into readable bytes is reported for a human instead of failing quietly.

/** A link we will download ourselves rather than leave to WebFetch. */
export interface LinkedDoc {
  /** What to actually GET — may be an export endpoint, not the pasted link. */
  url: string;
  filename: string;
  /**
   * Expected content. 'application/pdf' is verified by magic bytes; text/* is
   * verified to not be an HTML page. `undefined` means sniff it from the bytes
   * (Drive file links, which can hold anything).
   */
  mimeType?: string;
  /** Human name for the review message when the download fails ("Google Sheet"). */
  kind: string;
}

const GOOGLE_ID = '[\\w-]{10,}';
const SHEET_RE = new RegExp(`^https?://docs\\.google\\.com/spreadsheets/d/(${GOOGLE_ID})`, 'i');
const DOC_RE = new RegExp(`^https?://docs\\.google\\.com/document/d/(${GOOGLE_ID})`, 'i');
const SLIDES_RE = new RegExp(`^https?://docs\\.google\\.com/presentation/d/(${GOOGLE_ID})`, 'i');
const DRIVE_FILE_RE = new RegExp(`^https?://drive\\.google\\.com/file/d/(${GOOGLE_ID})`, 'i');

/**
 * The document behind `rawUrl`, or undefined when the link is an ordinary web
 * page that WebFetch handles fine.
 */
export function resolveLinkedDoc(rawUrl: string): LinkedDoc | undefined {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return undefined;
  }

  // A direct .pdf link: Read parses PDF tables reliably, WebFetch flattens them
  // and mis-pairs prices.
  if (parsed.pathname.toLowerCase().endsWith('.pdf')) {
    return { url: rawUrl, filename: pdfName(parsed), mimeType: 'application/pdf', kind: 'PDF' };
  }

  const sheet = SHEET_RE.exec(rawUrl);
  if (sheet) {
    // One tab per CSV export, so take the tab the publisher actually linked
    // (?gid= or #gid=), defaulting to the first.
    const gid = gidOf(parsed);
    return {
      url: `https://docs.google.com/spreadsheets/d/${sheet[1]}/export?format=csv&gid=${gid}`,
      filename: `google-sheet-gid${gid}.csv`,
      mimeType: 'text/csv',
      kind: 'Google Sheet',
    };
  }

  const doc = DOC_RE.exec(rawUrl);
  if (doc) {
    return {
      url: `https://docs.google.com/document/d/${doc[1]}/export?format=txt`,
      filename: 'google-doc.txt',
      mimeType: 'text/plain',
      kind: 'Google Doc',
    };
  }

  const slides = SLIDES_RE.exec(rawUrl);
  if (slides) {
    return {
      url: `https://docs.google.com/presentation/d/${slides[1]}/export/pdf`,
      filename: 'google-slides.pdf',
      mimeType: 'application/pdf',
      kind: 'Google Slides deck',
    };
  }

  const drive = DRIVE_FILE_RE.exec(rawUrl);
  if (drive) {
    // Could be a PDF, a spreadsheet, an image — decided by the bytes we get back.
    return {
      url: `https://drive.google.com/uc?export=download&id=${drive[1]}`,
      filename: 'drive-file',
      kind: 'Google Drive file',
    };
  }

  // Already a direct download link (docs/drive `uc?export=download&id=`) — take
  // it as-is; it serves bytes, which WebFetch would only mangle.
  if (
    /^(docs|drive)\.google\.com$/i.test(parsed.hostname) &&
    parsed.pathname === '/uc' &&
    parsed.searchParams.get('export') === 'download'
  ) {
    return { url: rawUrl, filename: 'drive-file', kind: 'Google Drive file' };
  }

  return undefined;
}

/** The sheet tab in a Sheets URL — `?gid=` or `#gid=`, else "0". */
function gidOf(url: URL): string {
  const fromQuery = url.searchParams.get('gid');
  if (fromQuery && /^\d+$/.test(fromQuery)) return fromQuery;
  const fromHash = /gid=(\d+)/.exec(url.hash);
  return fromHash ? fromHash[1] : '0';
}

/** Last path segment of a .pdf URL, percent-decoded. */
function pdfName(url: URL): string {
  try {
    return decodeURIComponent(url.pathname.split('/').pop() || '') || 'linked.pdf';
  } catch {
    return 'linked.pdf';
  }
}

/** True when the bytes are an HTML page — how Google answers an export request
 *  for a document that is not shared publicly (a sign-in page). */
export function looksLikeHtml(buf: Buffer): boolean {
  const head = buf.subarray(0, 512).toString('latin1').trimStart().toLowerCase();
  return head.startsWith('<!doctype html') || head.startsWith('<html') || head.startsWith('<?xml version="1.0" encoding="utf-8"?><!doctype html');
}

/** True when the bytes are a PDF. */
export function looksLikePdf(buf: Buffer): boolean {
  return buf.subarray(0, 5).toString('latin1') === '%PDF-';
}

/** True when the bytes are plausibly plain text (no NUL bytes in the head). */
export function looksLikeText(buf: Buffer): boolean {
  return !buf.subarray(0, 1024).includes(0);
}
