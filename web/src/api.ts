import type {
  Account,
  Batch,
  BatchRow,
  Deal,
  DealDetail,
  DealRow,
  DealStatus,
  DomainDetail,
  DomainExclusion,
  DomainFacets,
  DomainListRow,
  DomainAnswerFilter,
  DomainSortKey,
  DomainStateFilter,
  DomainSummary,
  EmailAttachment,
  ExtractionDebug,
  IgnoreEntry,
  NewAccount,
  NewBatch,
  NewTarget,
  Niche,
  Outreach,
  OutreachLanguage,
  Placement,
  PageEnvelope,
  ResponseFacets,
  ResponseRow,
  Status,
  Suppression,
  Target,
  TargetFacets,
  TargetListRow,
  TargetStatus,
  ThreadReply,
} from './types';
import { apiUrl, authHeaders } from './apiBase';

export interface TargetPageQuery {
  limit?: number;
  cursor?: string;
  status?: TargetStatus | '';
  batchId?: string;
  unbatched?: boolean;
  search?: string;
}

export type DomainExportScope = 'regular' | 'both' | 'all';

export interface DomainExportQuery {
  /** Exactly what the list is filtered by — the export answers the same question. */
  filters: DomainPageQuery;
  scope: DomainExportScope;
  title?: string;
  includeExcluded?: boolean;
}

/** GET /api/domains/export&preview=N — the sheet's real shape, before downloading. */
export interface DomainExportPreview {
  columns: string[];
  body: (string | number)[][];
  /** Rows the file will have. */
  total: number;
  /** Excluded domains dropped from it (0 when they are being kept). */
  excluded: number;
}

export interface DomainPageQuery {
  limit?: number;
  cursor?: string;
  search?: string;
  state?: DomainStateFilter;
  batchId?: string;
  /** Domains no batch covers. Cannot be combined with batchId (400). */
  unbatched?: boolean;
  tier?: 'reg' | 'sens';
  category?: string;
  answer?: DomainAnswerFilter;
  sort?: DomainSortKey;
  direction?: 'asc' | 'desc';
}

/** The Domains filters as query params. Shared by the list and the export so the
 *  export cannot quietly read a filter differently from the list it started in. */
function domainParams(query: DomainPageQuery): URLSearchParams {
  const params = new URLSearchParams();
  if (query.search) params.set('q', query.search);
  if (query.state && query.state !== 'all') params.set('state', query.state);
  if (query.batchId) params.set('batchId', query.batchId);
  if (query.unbatched) params.set('unbatched', 'true');
  if (query.tier) params.set('tier', query.tier);
  if (query.category) params.set('category', query.category);
  if (query.answer) params.set('answer', query.answer);
  if (query.sort) params.set('sort', query.sort);
  if (query.direction) params.set('dir', query.direction);
  return params;
}

function exportParams({ filters, scope, title, includeExcluded }: DomainExportQuery): URLSearchParams {
  const params = domainParams(filters);
  params.set('scope', scope);
  if (title?.trim()) params.set('title', title.trim());
  if (includeExcluded) params.set('includeExcluded', 'true');
  return params;
}

/** The server names the file; honour it rather than rebuilding the name here. */
function filenameFrom(header: string | null): string | undefined {
  return header?.match(/filename="([^"]+)"/)?.[1];
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const auth = await authHeaders();
  const res = await fetch(apiUrl(path), {
    ...init,
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...auth,
      ...init?.headers,
    },
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : undefined;
  if (!res.ok) {
    throw new Error((data && data.error) || `${res.status} ${res.statusText}`);
  }
  return data as T;
}

export const api = {
  status: (batchId?: string) =>
    req<Status>('/status' + (batchId ? `?batchId=${encodeURIComponent(batchId)}` : '')),

  // outreach email preview (global pitch profile + selected batch language)
  previewEmail: (body: { websiteUrl?: string; language?: OutreachLanguage; advertised?: { url: string; description?: string }; contactEmail?: string; contactName?: string; notes?: string }) =>
    req<{ subject: string; body: string; senderName: string; senderEmail: string }>('/preview', { method: 'POST', body: JSON.stringify(body) }),

  // accounts
  listAccounts: (signal?: AbortSignal) => req<Account[]>('/accounts', { signal }),
  createAccount: (body: NewAccount) =>
    req<Account>('/accounts', { method: 'POST', body: JSON.stringify(body) }),
  patchAccount: (id: string, body: Partial<Account>) =>
    req<Account>(`/accounts/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  pauseAccount: (id: string) => req<Account>(`/accounts/${id}/pause`, { method: 'POST' }),
  resumeAccount: (id: string) => req<Account>(`/accounts/${id}/resume`, { method: 'POST' }),
  rollbackCursor: (id: string) => req<Account>(`/accounts/${id}/rollback-cursor`, { method: 'POST' }),
  deleteAccount: (id: string) => req<{ ok: boolean }>(`/accounts/${id}`, { method: 'DELETE' }),
  getOAuthUrl: (accountId: string) => req<{ authUrl: string }>(`/oauth/start?accountId=${accountId}`),

  // targets
  listTargets: (status?: TargetStatus | '', batchId?: string, signal?: AbortSignal) => {
    const params = new URLSearchParams();
    if (status) params.set('status', status);
    if (batchId) params.set('batchId', batchId);
    const qs = params.toString();
    return req<Target[]>('/targets' + (qs ? `?${qs}` : ''), { signal });
  },
  listTargetPage: (query: TargetPageQuery, signal?: AbortSignal) => {
    const params = new URLSearchParams();
    if (query.limit) params.set('limit', String(query.limit));
    if (query.cursor) params.set('cursor', query.cursor);
    if (query.status) params.set('status', query.status);
    if (query.batchId) params.set('batchId', query.batchId);
    if (query.unbatched) params.set('unbatched', 'true');
    if (query.search) params.set('q', query.search);
    return req<PageEnvelope<TargetListRow, TargetFacets>>(`/targets/page?${params}`, { signal });
  },
  getTargetThread: (id: string) =>
    req<{
      target: Target;
      outreaches: Outreach[];
      replies: ThreadReply[];
      /** accountId → email, so the timeline can name OUR side of it too. */
      accountEmails: Record<string, string>;
    }>(`/targets/${id}/thread`),
  createTarget: (body: NewTarget) =>
    req<Target>('/targets', { method: 'POST', body: JSON.stringify(body) }),
  deleteTarget: (id: string) => req<{ ok: boolean }>(`/targets/${id}`, { method: 'DELETE' }),

  // batches
  listBatches: (signal?: AbortSignal) => req<BatchRow[]>('/batches', { signal }),
  createBatch: (body: NewBatch) =>
    req<Batch>('/batches', { method: 'POST', body: JSON.stringify(body) }),

  getReply: (id: string) => req<ResponseRow>(`/replies/${encodeURIComponent(id)}`),
  /** Everything needed to debug one extraction (email + prompt + run + records). */
  getReplyDebug: (id: string) => req<ExtractionDebug>(`/replies/${encodeURIComponent(id)}/debug`),
  deleteReply: (id: string) => req<{ ok: boolean }>(`/replies/${id}`, { method: 'DELETE' }),

  patchReply: (
    id: string,
    body: {
      offers: {
        category: string;
        label?: string;
        sensitive?: boolean;
        canPost: string;
        priceRaw: string;
        /** '' = the contacted site. Must round-trip: it scopes the server cell key. */
        website?: string;
        isSpecial?: boolean;
        specialUntil?: string;
      }[];
      optOut?: boolean;
    },
  ) => req<ResponseRow>(`/replies/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),

  // read-only feeds
  listResponsePage: (query: ResponsePageQuery, signal?: AbortSignal) => {
    const params = new URLSearchParams({ limit: String(query.limit ?? 50) });
    if (query.cursor) params.set('cursor', query.cursor);
    if (query.batchId) params.set('batchId', query.batchId);
    if (query.niche) params.set('niche', query.niche);
    if (query.canPost) params.set('canPost', query.canPost);
    if (query.state) params.set('state', query.state);
    if (query.search) params.set('q', query.search);
    return req<PageEnvelope<ResponseRow, ResponseFacets>>(`/responses/page?${params}`, { signal });
  },
  listResponses: (batchId?: string, signal?: AbortSignal) =>
    req<ResponseRow[]>('/responses' + (batchId ? `?batchId=${encodeURIComponent(batchId)}` : ''), { signal }),
  listSuppressions: (signal?: AbortSignal) => req<Suppression[]>('/suppressions', { signal }),
  listNiches: (signal?: AbortSignal) => req<Niche[]>('/niches', { signal }),

  // per-domain price history
  listDomainPage: (query: DomainPageQuery, signal?: AbortSignal) => {
    const params = domainParams(query);
    if (query.limit) params.set('limit', String(query.limit));
    if (query.cursor) params.set('cursor', query.cursor);
    return req<PageEnvelope<DomainListRow, DomainFacets>>(`/domains/page?${params}`, { signal });
  },

  /** The first rows of the export the server would write, with its real columns.
   *  `total` is every matching domain, not just the page on screen. */
  previewDomainsExport: (options: DomainExportQuery, rows: number, signal?: AbortSignal) =>
    req<DomainExportPreview>(`/domains/export?${exportParams(options)}&preview=${rows}`, { signal }),

  /** Downloads the .xlsx the server builds. Not an `<a href>`: the console sends
   *  a bearer token on every call, and a plain link cannot carry one. */
  downloadDomainsExport: async (options: DomainExportQuery): Promise<void> => {
    const res = await fetch(apiUrl(`/domains/export?${exportParams(options)}`), {
      headers: await authHeaders(),
    });
    if (!res.ok) {
      const text = await res.text();
      let message = `${res.status} ${res.statusText}`;
      try { message = JSON.parse(text).error ?? message; } catch { /* not JSON: keep the status */ }
      throw new Error(message);
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filenameFrom(res.headers.get('Content-Disposition')) ?? 'adscout-domains.xlsx';
    document.body.appendChild(link);
    link.click();
    link.remove();
    // Revoked on the next frame, not immediately: Safari cancels a download whose
    // object URL disappears in the same tick as the click.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  },
  listDomains: (signal?: AbortSignal) => req<DomainSummary[]>('/domains', { signal }),
  getDomain: (domain: string) => req<DomainDetail>(`/domains/${encodeURIComponent(domain)}`),

  // ignore list (inbound skip)
  listIgnore: (signal?: AbortSignal) => req<IgnoreEntry[]>('/ignore', { signal }),
  addIgnore: (body: { kind: 'email' | 'domain'; value: string; reason?: string }) =>
    req<IgnoreEntry>('/ignore', { method: 'POST', body: JSON.stringify(body) }),
  deleteIgnore: (id: string) => req<{ ok: boolean }>(`/ignore/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  // domain exclusion (outbound do-not-contact)
  listExclusions: () => req<DomainExclusion[]>('/exclusions'),
  addExclusion: (domain: string) =>
    req<DomainExclusion>('/exclusions', { method: 'POST', body: JSON.stringify({ domain }) }),
  deleteExclusion: (domain: string) =>
    req<{ ok: boolean }>(`/exclusions/${encodeURIComponent(domain)}`, { method: 'DELETE' }),

  // deals (human-operated negotiations)
  listDeals: (signal?: AbortSignal) => req<DealRow[]>('/deals', { signal }),
  getDeal: (id: string) => req<DealDetail>(`/deals/${id}`),
  openDeal: (body: {
    counterpartyEmail: string;
    accountId: string;
    threadIds?: string[];
    domains?: string[];
    note?: string;
  }) => req<Deal>('/deals', { method: 'POST', body: JSON.stringify(body) }),
  patchDeal: (id: string, body: { status?: DealStatus; closedReason?: string; note?: string }) =>
    req<Deal>(`/deals/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteDeal: (id: string) => req<{ ok: boolean }>(`/deals/${id}`, { method: 'DELETE' }),
  addDealDomains: (id: string, domains: string[]) =>
    req<Placement[]>(`/deals/${id}/placements`, { method: 'POST', body: JSON.stringify({ domains }) }),
  attachDealThreads: (id: string, threadIds: string[]) =>
    req<{ ok: boolean }>(`/deals/${id}/threads`, { method: 'POST', body: JSON.stringify({ threadIds }) }),
  // `subject` is derived server-side from the thread being answered; pass one
  // only for the first message on a deal that has no conversation yet.
  sendDealMessage: (
    id: string,
    body: {
      body: string;
      subject?: string;
      threadId?: string;
      attachments?: EmailAttachment[];
    },
  ) =>
    req<{ outreach: Outreach; threadId?: string }>(`/deals/${id}/messages`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  patchPlacement: (
    id: string,
    body: Partial<Omit<Placement, 'id' | 'dealId' | 'agreedPrice'>> & { agreedPrice?: string },
  ) => req<Placement>(`/placements/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deletePlacement: (id: string) => req<{ ok: boolean }>(`/placements/${id}`, { method: 'DELETE' }),

  // manual passes — SSE streaming with progress
  runSend: (opts?: RunPassOpts) => runPass('/run/send', opts),
  runPoll: (opts?: RunPassOpts) => runPass('/run/poll', opts),
  runFetch: (opts?: RunPassOpts) => runPass('/run/fetch', opts),
  cancelRun: () => {/* cancellation is client-side via AbortController */},
};

export interface ResponsePageQuery {
  limit?: number;
  cursor?: string;
  batchId?: string;
  niche?: string;
  canPost?: 'yes' | 'no' | 'maybe';
  state?: 'review' | 'awaiting' | 'late' | 'ok';
  search?: string;
}

export interface RunPassOpts {
  signal?: AbortSignal;
  onProgress?: (current: number, total: number) => void;
}

async function runPass(path: string, opts?: RunPassOpts): Promise<unknown> {
  const res = await fetch(apiUrl(path), {
    method: 'POST',
    signal: opts?.signal,
    headers: await authHeaders(),
  });
  if (!res.ok) {
    const text = await res.text();
    const data = text ? JSON.parse(text) : undefined;
    throw new Error((data && data.error) || `${res.status} ${res.statusText}`);
  }
  // Read the SSE stream
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let result: unknown;
  let error: string | undefined;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    // Parse SSE frames: "event: <type>\ndata: <json>\n\n"
    const frames = buf.split('\n\n');
    buf = frames.pop()!; // keep incomplete frame
    for (const frame of frames) {
      if (!frame.trim()) continue;
      let event = 'message';
      let data = '';
      for (const line of frame.split('\n')) {
        if (line.startsWith('event: ')) event = line.slice(7);
        else if (line.startsWith('data: ')) data = line.slice(6);
        else if (line.startsWith(':')) continue; // comment (heartbeat)
      }
      if (event === 'progress' && data) {
        const { current, total } = JSON.parse(data);
        opts?.onProgress?.(current, total);
      } else if (event === 'done' && data) {
        result = JSON.parse(data);
      } else if (event === 'error' && data) {
        error = JSON.parse(data).error;
      }
    }
  }
  if (error) throw new Error(error);
  return result;
}
