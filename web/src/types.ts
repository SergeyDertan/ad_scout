// Client-side mirror of the server domain types (src/domain/types.ts) — only
// the fields the UI reads/writes. Kept deliberately small.

export type AccountStatus = 'warming' | 'active' | 'paused' | 'cooldown';
export type ProviderType = 'smtp-imap' | 'gmail-api';

export interface Account {
  id: string;
  email: string;
  providerType: ProviderType;
  credentialRef: string;
  senderName: string;
  signature?: string;
  status: AccountStatus;
  createdAt: string;
  maxDailyLimit: number;
  dailyLimitOverride?: number;
  lastError?: string;
}

export type TargetStatus =
  | 'pending'
  | 'reserved'
  | 'contacted'
  | 'replied'
  | 'bounced'
  | 'needs_review'
  | 'excluded';

export interface Target {
  id: string;
  campaignId: string;
  websiteUrl: string;
  contactEmail: string;
  contactName?: string;
  notes?: string;
  status: TargetStatus;
  followUpCount: number;
  result?: { canPost?: string };
  createdAt: string;
}

export interface Campaign {
  id: string;
  name: string;
  advertised: { url: string; description: string };
  topic: string;
  format: string;
  createdAt: string;
}

export interface ResponseRow {
  id: string;
  fromAddress: string;
  website?: string;
  matchMethod: 'threadId' | 'fromAddress' | 'unmatched';
  extractionStatus: 'pending' | 'done' | 'failed';
  parsed?: { canPost: string; fields: Record<string, unknown> };
}

export interface Suppression {
  id: string;
  email: string;
  reason: 'opt_out' | 'bounce' | 'manual';
  at: string;
}

export interface Status {
  ok: boolean;
  time: string;
  accounts: number;
  targets: { total: number; byStatus: Record<string, number> };
  providers: { llm: string; email: string; store: string } | null;
}

export interface NewAccount {
  email: string;
  senderName: string;
  providerType?: ProviderType;
  credentialRef?: string;
  maxDailyLimit?: number;
  signature?: string;
}

export interface NewTarget {
  websiteUrl: string;
  contactEmail: string;
  campaignId?: string;
  contactName?: string;
  notes?: string;
}
