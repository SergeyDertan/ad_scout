// PouchDbStore — real persistence in a local PouchDB (schemaless JSON docs,
// `_id = "<type>:<id>"`). Change events are emitted from this wrapper (the agent
// is the sole writer), so the live feed stays backend-agnostic.
//
// PouchDB is loaded lazily so the core builds without it. To use:
//     pnpm add pouchdb
//     STORE=pouchdb  POUCH_DIR=./data/pouch
// NOTE: PouchDB's Node leveldb adapter is flagged deprecated — pin versions.

import { normalizeEmail } from '../../domain/reply-matching';
import type {
  Account,
  Campaign,
  Outreach,
  Reply,
  Suppression,
  Target,
} from '../../domain/types';
import type {
  ChangeEvent,
  ChangeListener,
  DocType,
  OutreachFilter,
  Store,
  TargetFilter,
} from '../../ports/store';

const HIGH = '￰';

export class PouchDbStore implements Store {
  private db?: any;
  private listeners = new Set<ChangeListener>();

  constructor(private readonly location: string) {}

  private async getDb(): Promise<any> {
    if (this.db) return this.db;
    const mod: any = await import('pouchdb' as string);
    const PouchDB = mod.default ?? mod;
    this.db = new PouchDB(this.location);
    return this.db;
  }

  private emit(type: DocType, action: ChangeEvent['action'], id: string): void {
    for (const l of this.listeners) {
      try {
        l({ type, action, id });
      } catch {
        /* ignore bad listener */
      }
    }
  }

  private docId(type: DocType, id: string): string {
    return `${type}:${id}`;
  }

  private strip<T>(doc: any): T {
    const { _id, _rev, type, ...rest } = doc;
    return rest as T;
  }

  private async get<T>(type: DocType, id: string): Promise<T | undefined> {
    const db = await this.getDb();
    try {
      const doc = await db.get(this.docId(type, id));
      return this.strip<T>(doc);
    } catch (err: any) {
      if (err?.status === 404) return undefined;
      throw err;
    }
  }

  private async put<T extends { id: string }>(type: DocType, obj: T): Promise<T> {
    const db = await this.getDb();
    const _id = this.docId(type, obj.id);
    let _rev: string | undefined;
    try {
      const existing = await db.get(_id);
      _rev = existing._rev;
    } catch (err: any) {
      if (err?.status !== 404) throw err;
    }
    await db.put({ ...obj, _id, type, ...(_rev ? { _rev } : {}) });
    this.emit(type, 'put', obj.id);
    return obj;
  }

  private async delete(type: DocType, id: string): Promise<void> {
    const db = await this.getDb();
    try {
      const existing = await db.get(this.docId(type, id));
      await db.remove(existing);
      this.emit(type, 'delete', id);
    } catch (err: any) {
      if (err?.status !== 404) throw err;
    }
  }

  private async listByType<T>(type: DocType): Promise<T[]> {
    const db = await this.getDb();
    const res = await db.allDocs({
      include_docs: true,
      startkey: `${type}:`,
      endkey: `${type}:${HIGH}`,
    });
    return res.rows.map((r: any) => this.strip<T>(r.doc));
  }

  // campaigns
  getCampaign(id: string) {
    return this.get<Campaign>('campaign', id);
  }
  putCampaign(c: Campaign) {
    return this.put('campaign', c);
  }
  listCampaigns() {
    return this.listByType<Campaign>('campaign');
  }
  deleteCampaign(id: string) {
    return this.delete('campaign', id);
  }

  // accounts
  getAccount(id: string) {
    return this.get<Account>('account', id);
  }
  putAccount(a: Account) {
    return this.put('account', a);
  }
  listAccounts() {
    return this.listByType<Account>('account');
  }
  deleteAccount(id: string) {
    return this.delete('account', id);
  }

  // targets
  getTarget(id: string) {
    return this.get<Target>('target', id);
  }
  putTarget(t: Target) {
    return this.put('target', t);
  }
  async listTargets(filter?: TargetFilter) {
    let list = await this.listByType<Target>('target');
    if (filter?.campaignId) list = list.filter((t) => t.campaignId === filter.campaignId);
    if (filter?.status) list = list.filter((t) => t.status === filter.status);
    return list;
  }
  deleteTarget(id: string) {
    return this.delete('target', id);
  }

  // outreaches
  getOutreach(id: string) {
    return this.get<Outreach>('outreach', id);
  }
  putOutreach(o: Outreach) {
    return this.put('outreach', o);
  }
  async listOutreaches(filter?: OutreachFilter) {
    let list = await this.listByType<Outreach>('outreach');
    if (filter?.targetId) list = list.filter((o) => o.targetId === filter.targetId);
    if (filter?.accountId) list = list.filter((o) => o.accountId === filter.accountId);
    return list;
  }

  // replies
  async getReplyByEmailId(emailId: string) {
    const list = await this.listByType<Reply>('reply');
    return list.find((r) => r.emailId === emailId);
  }
  putReply(r: Reply) {
    return this.put('reply', r);
  }
  listReplies() {
    return this.listByType<Reply>('reply');
  }
  deleteReply(id: string) {
    return this.delete('reply', id);
  }

  // suppression
  async isSuppressed(email: string) {
    const doc = await this.get<Suppression>('suppression', normalizeEmail(email));
    return doc !== undefined;
  }
  async addSuppression(s: Suppression) {
    const key = normalizeEmail(s.email);
    await this.put('suppression', { ...s, id: key, email: key });
  }
  listSuppressions() {
    return this.listByType<Suppression>('suppression');
  }

  subscribe(listener: ChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async close(): Promise<void> {
    if (this.db) await this.db.close();
  }
}
