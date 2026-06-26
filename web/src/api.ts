import type {
  Account,
  Campaign,
  InquiryField,
  NewAccount,
  NewCampaign,
  NewTarget,
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
  status: () => req<Status>('/status'),

  // campaigns
  listCampaigns: () => req<Campaign[]>('/campaigns'),
  createCampaign: (body: NewCampaign) =>
    req<Campaign>('/campaigns', { method: 'POST', body: JSON.stringify(body) }),
  patchCampaign: (id: string, body: { inquiryFields?: InquiryField[]; name?: string; topic?: string; format?: string; advertised?: { url: string; description?: string } }) =>
    req<Campaign>(`/campaigns/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteCampaign: (id: string) => req<{ ok: boolean }>(`/campaigns/${id}`, { method: 'DELETE' }),
  previewEmail: (campaignId: string, body: { websiteUrl?: string; contactEmail?: string; contactName?: string; notes?: string }) =>
    req<{ subject: string; body: string; senderName: string; senderEmail: string }>(`/campaigns/${campaignId}/preview`, { method: 'POST', body: JSON.stringify(body) }),

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

  // targets
  listTargets: (status?: TargetStatus | '', campaignId?: string) => {
    const params = new URLSearchParams();
    if (status) params.set('status', status);
    if (campaignId) params.set('campaignId', campaignId);
    const qs = params.toString();
    return req<Target[]>('/targets' + (qs ? `?${qs}` : ''));
  },
  getTargetThread: (id: string) =>
    req<{ target: Target; outreaches: Outreach[]; replies: ThreadReply[] }>(`/targets/${id}/thread`),
  createTarget: (body: NewTarget) =>
    req<Target>('/targets', { method: 'POST', body: JSON.stringify(body) }),
  deleteTarget: (id: string) => req<{ ok: boolean }>(`/targets/${id}`, { method: 'DELETE' }),

  deleteReply: (id: string) => req<{ ok: boolean }>(`/replies/${id}`, { method: 'DELETE' }),

  // read-only feeds
  listResponses: () => req<ResponseRow[]>('/responses'),
  listSuppressions: () => req<Suppression[]>('/suppressions'),

  // manual passes
  runSend: () => req<unknown>('/run/send', { method: 'POST' }),
  runPoll: () => req<unknown>('/run/poll', { method: 'POST' }),
  runFetch: () => req<unknown>('/run/fetch', { method: 'POST' }),
};
