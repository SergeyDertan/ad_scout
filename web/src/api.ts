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
  DomainSummary,
  ExtractionDebug,
  IgnoreEntry,
  NewAccount,
  NewBatch,
  NewTarget,
  Niche,
  Outreach,
  Placement,
  ResponseRow,
  Status,
  Suppression,
  Target,
  TargetStatus,
  ThreadReply,
} from './types';
import { apiUrl, authHeaders } from './apiBase';

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

  // outreach email preview (rendered from the global pitch profile)
  previewEmail: (body: { websiteUrl?: string; advertised?: { url: string; description?: string }; contactEmail?: string; contactName?: string; notes?: string }) =>
    req<{ subject: string; body: string; senderName: string; senderEmail: string }>('/preview', { method: 'POST', body: JSON.stringify(body) }),

  // accounts
  listAccounts: () => req<Account[]>('/accounts'),
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
  listTargets: (status?: TargetStatus | '', batchId?: string) => {
    const params = new URLSearchParams();
    if (status) params.set('status', status);
    if (batchId) params.set('batchId', batchId);
    const qs = params.toString();
    return req<Target[]>('/targets' + (qs ? `?${qs}` : ''));
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
  listBatches: () => req<BatchRow[]>('/batches'),
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
  listResponses: (batchId?: string) =>
    req<ResponseRow[]>('/responses' + (batchId ? `?batchId=${encodeURIComponent(batchId)}` : '')),
  listSuppressions: () => req<Suppression[]>('/suppressions'),
  listNiches: () => req<Niche[]>('/niches'),

  // per-domain price history
  listDomains: () => req<DomainSummary[]>('/domains'),
  getDomain: (domain: string) => req<DomainDetail>(`/domains/${encodeURIComponent(domain)}`),

  // ignore list (inbound skip)
  listIgnore: () => req<IgnoreEntry[]>('/ignore'),
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
  listDeals: () => req<DealRow[]>('/deals'),
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
  sendDealMessage: (id: string, body: { subject: string; body: string; threadId?: string }) =>
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
