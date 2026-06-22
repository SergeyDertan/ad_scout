import type {
  Account,
  Campaign,
  NewAccount,
  NewTarget,
  ResponseRow,
  Status,
  Suppression,
  Target,
  TargetStatus,
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
  createCampaign: (body: { name: string; advertised: { url: string; description?: string } }) =>
    req<Campaign>('/campaigns', { method: 'POST', body: JSON.stringify(body) }),

  // accounts
  listAccounts: () => req<Account[]>('/accounts'),
  createAccount: (body: NewAccount) =>
    req<Account>('/accounts', { method: 'POST', body: JSON.stringify(body) }),
  patchAccount: (id: string, body: Partial<Account>) =>
    req<Account>(`/accounts/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  pauseAccount: (id: string) => req<Account>(`/accounts/${id}/pause`, { method: 'POST' }),
  resumeAccount: (id: string) => req<Account>(`/accounts/${id}/resume`, { method: 'POST' }),
  deleteAccount: (id: string) => req<{ ok: boolean }>(`/accounts/${id}`, { method: 'DELETE' }),

  // targets
  listTargets: (status?: TargetStatus | '') =>
    req<Target[]>('/targets' + (status ? `?status=${status}` : '')),
  createTarget: (body: NewTarget) =>
    req<Target>('/targets', { method: 'POST', body: JSON.stringify(body) }),
  deleteTarget: (id: string) => req<{ ok: boolean }>(`/targets/${id}`, { method: 'DELETE' }),

  // read-only feeds
  listResponses: () => req<ResponseRow[]>('/responses'),
  listSuppressions: () => req<Suppression[]>('/suppressions'),

  // manual passes
  runSend: () => req<unknown>('/run/send', { method: 'POST' }),
  runPoll: () => req<unknown>('/run/poll', { method: 'POST' }),
};
