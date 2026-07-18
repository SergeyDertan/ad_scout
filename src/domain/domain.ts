// Domain-key normalization — pure, no I/O. The index key for the per-domain
// price history (PRICE-HISTORY-PLAN.md D3).
//
// Rule: lowercase → strip scheme → strip a single leading "www." → drop any
// path/query/fragment/port/userinfo → keep the rest VERBATIM. Subdomains are
// preserved, so casik.com ≠ casik.ua ≠ ultra.casik.biz. No public-suffix list.

/**
 * Normalize a URL or bare host into a domain key.
 * Returns '' when there is no usable host (the caller decides what to do).
 */
export function normalizeDomain(urlOrHost: string): string {
  let s = (urlOrHost ?? '').trim().toLowerCase();
  if (!s) return '';
  // Strip scheme (http://, https://, mailto:, //) if present.
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/^\/\//, '');
  // Drop userinfo (user:pass@host).
  const at = s.lastIndexOf('@');
  if (at !== -1) s = s.slice(at + 1);
  // Drop path/query/fragment — cut at the first of / ? #.
  s = s.split(/[/?#]/)[0] ?? '';
  // Drop port.
  const colon = s.indexOf(':');
  if (colon !== -1) s = s.slice(0, colon);
  // Strip a single leading www.
  s = s.replace(/^www\./, '');
  // Trim any stray leading/trailing dots.
  s = s.replace(/^\.+|\.+$/g, '');
  return s;
}
