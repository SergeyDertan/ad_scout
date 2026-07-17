// Storage port. Thin, schemaless data layer. The agent is the sole writer, so
// the wrapper also emits change events (app-level live feed → SSE), which is
// backend-agnostic (works for memory, PouchDB, SQLite, ...).

import type {
  Account,
  Batch,
  Niche,
  Outreach,
  Reply,
  Suppression,
  Target,
  TargetStatus,
} from '../domain/types';

export type DocType =
  | 'account'
  | 'target'
  | 'batch'
  | 'outreach'
  | 'reply'
  | 'suppression'
  | 'niche';

export interface ChangeEvent {
  type: DocType;
  action: 'put' | 'delete';
  id: string;
}

export type ChangeListener = (ev: ChangeEvent) => void;

export interface TargetFilter {
  batchId?: string;
  status?: TargetStatus;
}

export interface OutreachFilter {
  targetId?: string;
  accountId?: string;
}

export interface Store {
  // accounts
  getAccount(id: string): Promise<Account | undefined>;
  putAccount(a: Account): Promise<Account>;
  /**
   * Concurrency-safe update: re-reads the current doc, applies `mutate`, and
   * on a write conflict (another writer landed in between) re-fetches and
   * re-applies `mutate` rather than blindly retrying a stale object. Prefer
   * this over get+putAccount whenever the write depends on the current doc —
   * accounts are written from multiple independent loops (send/poll
   * schedulers, HTTP routes) that can otherwise race each other.
   */
  updateAccount(id: string, mutate: (current: Account) => Account): Promise<Account>;
  listAccounts(): Promise<Account[]>;
  deleteAccount(id: string): Promise<void>;

  // targets
  getTarget(id: string): Promise<Target | undefined>;
  putTarget(t: Target): Promise<Target>;
  /** Concurrency-safe update — see updateAccount. */
  updateTarget(id: string, mutate: (current: Target) => Target): Promise<Target>;
  listTargets(filter?: TargetFilter): Promise<Target[]>;
  deleteTarget(id: string): Promise<void>;

  // batches (a group of targets added together; targets FK via target.batchId)
  getBatch(id: string): Promise<Batch | undefined>;
  putBatch(b: Batch): Promise<Batch>;
  listBatches(): Promise<Batch[]>;

  // outreaches (append-only log)
  getOutreach(id: string): Promise<Outreach | undefined>;
  putOutreach(o: Outreach): Promise<Outreach>;
  listOutreaches(filter?: OutreachFilter): Promise<Outreach[]>;

  // replies (inbound log)
  getReplyByEmailId(emailId: string): Promise<Reply | undefined>;
  putReply(r: Reply): Promise<Reply>;
  listReplies(): Promise<Reply[]>;
  deleteReply(id: string): Promise<void>;

  // niches (self-learning post-category registry; keyed by niche.key)
  listNiches(): Promise<Niche[]>;
  putNiche(n: Niche): Promise<Niche>;
  deleteNiche(key: string): Promise<void>;

  // suppression (persistent do-not-contact)
  isSuppressed(email: string): Promise<boolean>;
  addSuppression(s: Suppression): Promise<void>;
  listSuppressions(): Promise<Suppression[]>;

  // live feed
  subscribe(listener: ChangeListener): () => void;

  /** Release resources (close DB handles). Optional for in-memory. */
  close?(): Promise<void>;
}
