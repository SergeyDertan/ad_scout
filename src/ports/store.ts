// Storage port. Thin, schemaless data layer. The agent is the sole writer, so
// the wrapper also emits change events (app-level live feed → SSE), which is
// backend-agnostic (works for memory, PouchDB, SQLite, ...).

import type {
  Account,
  Campaign,
  Outreach,
  Reply,
  Suppression,
  Target,
  TargetStatus,
} from '../domain/types';

export type DocType =
  | 'campaign'
  | 'account'
  | 'target'
  | 'outreach'
  | 'reply'
  | 'suppression';

export interface ChangeEvent {
  type: DocType;
  action: 'put' | 'delete';
  id: string;
}

export type ChangeListener = (ev: ChangeEvent) => void;

export interface TargetFilter {
  campaignId?: string;
  status?: TargetStatus;
}

export interface OutreachFilter {
  targetId?: string;
  accountId?: string;
}

export interface Store {
  // campaigns
  getCampaign(id: string): Promise<Campaign | undefined>;
  putCampaign(c: Campaign): Promise<Campaign>;
  listCampaigns(): Promise<Campaign[]>;

  // accounts
  getAccount(id: string): Promise<Account | undefined>;
  putAccount(a: Account): Promise<Account>;
  listAccounts(): Promise<Account[]>;
  deleteAccount(id: string): Promise<void>;

  // targets
  getTarget(id: string): Promise<Target | undefined>;
  putTarget(t: Target): Promise<Target>;
  listTargets(filter?: TargetFilter): Promise<Target[]>;
  deleteTarget(id: string): Promise<void>;

  // outreaches (append-only log)
  getOutreach(id: string): Promise<Outreach | undefined>;
  putOutreach(o: Outreach): Promise<Outreach>;
  listOutreaches(filter?: OutreachFilter): Promise<Outreach[]>;

  // replies (inbound log)
  getReplyByEmailId(emailId: string): Promise<Reply | undefined>;
  putReply(r: Reply): Promise<Reply>;
  listReplies(): Promise<Reply[]>;

  // suppression (persistent do-not-contact)
  isSuppressed(email: string): Promise<boolean>;
  addSuppression(s: Suppression): Promise<void>;
  listSuppressions(): Promise<Suppression[]>;

  // live feed
  subscribe(listener: ChangeListener): () => void;

  /** Release resources (close DB handles). Optional for in-memory. */
  close?(): Promise<void>;
}
