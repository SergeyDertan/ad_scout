import type {
  Account,
  Batch,
  BatchRow,
  DomainDetail,
  DomainExclusion,
  DomainSummary,
  IgnoreEntry,
  NewAccount,
  NewBatch,
  NewTarget,
  Niche,
  Outreach,
  ResponseRow,
  Status,
  Suppression,
  Target,
  TargetStatus,
  ThreadReply,
} from './types';

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch('/api' + path, {
    ...init,
    headers: init?.body ? { 'Content-Type': 'application/json', ...init.headers } : init?.headers,
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
    req<{ target: Target; outreaches: Outreach[]; replies: ThreadReply[] }>(`/targets/${id}/thread`),
  createTarget: (body: NewTarget) =>
    req<Target>('/targets', { method: 'POST', body: JSON.stringify(body) }),
  deleteTarget: (id: string) => req<{ ok: boolean }>(`/targets/${id}`, { method: 'DELETE' }),

  // batches
  listBatches: () => req<BatchRow[]>('/batches'),
  createBatch: (body: NewBatch) =>
    req<Batch>('/batches', { method: 'POST', body: JSON.stringify(body) }),

  getReply: (id: string) => req<ResponseRow>(`/replies/${encodeURIComponent(id)}`),
  deleteReply: (id: string) => req<{ ok: boolean }>(`/replies/${id}`, { method: 'DELETE' }),

  patchReply: (
    id: string,
    body: {
      offers: { category: string; label?: string; sensitive?: boolean; canPost: string; priceRaw: string }[];
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

  // manual passes
  runSend: () => req<unknown>('/run/send', { method: 'POST' }),
  runPoll: () => req<unknown>('/run/poll', { method: 'POST' }),
  runFetch: () => req<unknown>('/run/fetch', { method: 'POST' }),
};
