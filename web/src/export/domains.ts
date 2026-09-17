// The domains export, client side: the picker's labels and the default title.
//
// The table itself is built by the server (src/services/domains-export.ts) and
// the file is written there too. It used to be assembled here from the rows the
// page happened to be holding, which silently capped an export at the visible
// 50 rows; the browser now names the shape it wants and downloads the result.

export type DomainExportScope = 'regular' | 'both' | 'all';

export const DOMAIN_EXPORT_SCOPES: { value: DomainExportScope; label: string; hint: string }[] = [
  { value: 'both', label: 'Regular + sensitive', hint: 'Domain, regular price, sensitive price' },
  { value: 'regular', label: 'Regular only', hint: 'Domain, regular price' },
  { value: 'all', label: 'All data', hint: 'Every niche price column' },
];

/** Names the batch the list is filtered to, so a file saved from one batch and a
 *  file saved from another are told apart by their title and their filename. */
export function defaultDomainsHeader(scopeLabel?: string): string {
  const scope = scopeLabel?.trim() || 'All batches';
  return `AdScout — ${scope} — domains export (${new Date().toLocaleDateString()})`;
}
