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

/** Query parameters bulk senders use to carry the real destination. */
const REDIRECT_PARAMS = ['url', 'q', 'target', 'destination', 'redirect', 'u'];

/**
 * The real destination behind one layer of click tracking, or undefined when
 * `url` carries none. Two shapes cover almost every sender:
 *   - a query param holding the destination (Outlook safelinks `?url=`,
 *     Google `/url?q=`),
 *   - an absolute URL percent-encoded into the PATH, which is what AWS SES
 *     does: `https://x.awstrack.me/L0/https:%2F%2Fdocs.google.com%2F...`.
 * Trackers that encode the destination opaquely (SendGrid, Mailchimp) cannot be
 * unwrapped without following a redirect, so they are left alone.
 */
function unwrapOnce(url: string): string | undefined {
  try {
    const p = new URL(url);
    for (const key of REDIRECT_PARAMS) {
      const v = p.searchParams.get(key);
      if (v && /^https?:\/\//i.test(v)) return v;
    }
  } catch {
    return undefined;
  }
  // Skip the leading scheme (`https://`) before looking for a SECOND one.
  const rest = url.slice(8);
  const m = /https?(?::|%3A)(?:\/\/|%2F%2F)/i.exec(rest);
  if (!m) return undefined;
  try {
    // Decoding the whole tail leaves the tracker's own suffix glued to the end
    // ("…/edit#gid=7/1/0100019f…"). Harmless: the id and gid patterns below both
    // match a prefix, so the export URL still comes out right.
    const decoded = decodeURIComponent(rest.slice(m.index));
    return /^https?:\/\//i.test(decoded) ? decoded : undefined;
  } catch {
    return undefined;
  }
}

/** Peel click-tracking wrappers until the real link (or nothing more) is left. */
export function unwrapTrackedUrl(rawUrl: string): string {
  let current = rawUrl;
  for (let i = 0; i < 3; i++) {
    const inner = unwrapOnce(current);
    if (!inner || inner === current) break;
    current = inner;
  }
  return current;
}

/**
 * The document behind `rawUrl`, or undefined when the link is an ordinary web
 * page that WebFetch handles fine.
 *
 * The link is unwrapped first: publishers send price lists through bulk-mail
 * click trackers, and a wrapped Google Sheet that goes unrecognized here is
 * never downloaded, never flagged, and the reply gets extracted from its body
 * alone as if no price list had been sent.
 */
export function resolveLinkedDoc(url: string): LinkedDoc | undefined {
  const unwrapped = unwrapTrackedUrl(url);
  // Second pass on a decoded copy: some clients percent-encode characters inside
  // the document id itself ("…/d/1oB%5FJNc…"), which stops the id pattern dead.
  // Only reached when the URL as written matched nothing, so a link that is
  // already valid is never rewritten.
  return matchLinkedDoc(unwrapped) ?? matchLinkedDoc(percentDecode(unwrapped));
}

function percentDecode(url: string): string {
  if (!url.includes('%')) return url;
  try {
    return decodeURIComponent(url);
  } catch {
    return url;
  }
}

function matchLinkedDoc(rawUrl: string): LinkedDoc | undefined {
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
  // Unwrapping leaves the tracker's own suffix glued after the real path
  // ("/rates.pdf/1/0100019f…"). A sheet id still matches as a prefix, but a PDF
  // path has to end at the file, so cut there. Only when segments FOLLOW the
  // .pdf — a plain link keeps its query string, which may be a signed URL.
  const embeddedPdf = /^(.*?\.pdf)\//i.exec(parsed.pathname);
  if (embeddedPdf) {
    const url = `${parsed.origin}${embeddedPdf[1]}`;
    return { url, filename: pdfName(new URL(url)), mimeType: 'application/pdf', kind: 'PDF' };
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
