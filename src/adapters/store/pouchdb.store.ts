// PouchDbStore — real persistence in a local PouchDB (schemaless JSON docs,
// `_id = "<type>:<id>"`). Change events are emitted from this wrapper (the agent
// is the sole writer), so the live feed stays backend-agnostic.
//
// PouchDB is loaded lazily so the core builds without it. To use:
//     pnpm add pouchdb
//     STORE=pouchdb  POUCH_DIR=./data/pouch
// NOTE: PouchDB's Node leveldb adapter is flagged deprecated — pin versions.

import { normalizeDomain } from '../../domain/domain';
import { isSeedIgnoredDomain } from '../../domain/ignore-seed';
import { normalizeEmail } from '../../domain/reply-matching';
import type {
  Account,
  Batch,
  DomainExclusion,
  IgnoreEntry,
  Niche,
  Outreach,
  PriceRecord,
  PromptSnapshot,
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

  /**
   * Read-mutate-write with retry on a 409 conflict. Unlike put(), the write is
   * derived from a *freshly re-read* doc on every attempt, so a concurrent
   * writer's change isn't clobbered by a stale retry — each side's mutate
   * re-applies its own delta on top of whatever the other side just wrote.
   */
  private async update<T extends { id: string }>(
    type: DocType,
    id: string,
    mutate: (current: T) => T,
  ): Promise<T> {
    const db = await this.getDb();
    const _id = this.docId(type, id);
    const MAX_ATTEMPTS = 10;
    for (let attempt = 1; ; attempt++) {
      const existing = await db.get(_id);
      const next = mutate(this.strip<T>(existing));
      try {
        await db.put({ ...next, _id, type, _rev: existing._rev });
        this.emit(type, 'put', id);
        return next;
      } catch (err: any) {
        if (err?.status === 409 && attempt < MAX_ATTEMPTS) continue;
        throw err;
      }
    }
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

  // accounts
  getAccount(id: string) {
    return this.get<Account>('account', id);
  }
  putAccount(a: Account) {
    return this.put('account', a);
  }
  updateAccount(id: string, mutate: (current: Account) => Account) {
    return this.update('account', id, mutate);
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
  updateTarget(id: string, mutate: (current: Target) => Target) {
    return this.update('target', id, mutate);
  }
  async listTargets(filter?: TargetFilter) {
    let list = await this.listByType<Target>('target');
    if (filter?.batchId) list = list.filter((t) => t.batchId === filter.batchId);
    if (filter?.status) list = list.filter((t) => t.status === filter.status);
    return list;
  }
  deleteTarget(id: string) {
    return this.delete('target', id);
  }

  // batches
  getBatch(id: string) {
    return this.get<Batch>('batch', id);
  }
  putBatch(b: Batch) {
    return this.put('batch', b);
  }
  listBatches() {
    return this.listByType<Batch>('batch');
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

  // niches (doc id = niche.key)
  async listNiches() {
    const list = await this.listByType<Niche & { id?: string }>('niche');
    return list.map(({ id, ...n }) => n as Niche);
  }
  deleteNiche(key: string) {
    return this.delete('niche', key);
  }
  async putNiche(n: Niche) {
    await this.put('niche', { ...n, id: n.key });
    return n;
  }

  // prompt archive (doc id = hash)
  async listPromptSnapshots() {
    const list = await this.listByType<PromptSnapshot>('prompt');
    return list.map((p) => ({ ...p, id: p.hash }));
  }
  async putPromptSnapshot(p: PromptSnapshot) {
    // Content-addressed: an existing doc under this hash already holds the same
    // text, so the first write wins and `firstSeenAt` is never disturbed.
    const existing = await this.get<PromptSnapshot>('prompt', p.hash);
    if (existing) return;
    await this.put('prompt', { ...p, id: p.hash });
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
  // Delete by the exact stored key — callers pass the email as listSuppressions
  // returns it, so a legacy malformed key can still be removed.
  async removeSuppression(email: string) {
    await this.delete('suppression', email);
  }

  // price records (doc id = pricerecord id)
  putPriceRecord(r: PriceRecord) {
    return this.put('pricerecord', r);
  }
  async listPriceRecords(filter?: { domain?: string }) {
    let list = await this.listByType<PriceRecord>('pricerecord');
    if (filter?.domain) {
      const d = normalizeDomain(filter.domain);
      list = list.filter((r) => r.domain === d);
    }
    return list;
  }
  deletePriceRecord(id: string) {
    return this.delete('pricerecord', id);
  }

  // ignore list (doc id = `${kind}:${value}`)
  async putIgnore(e: IgnoreEntry) {
    const id = `${e.kind}:${e.value}`;
    await this.put('ignore', { ...e, id });
    return { ...e, id };
  }
  listIgnore() {
    return this.listByType<IgnoreEntry>('ignore');
  }
  async isIgnored(email: string) {
    const norm = normalizeEmail(email);
    if (await this.get<IgnoreEntry>('ignore', `email:${norm}`)) return true;
    const domain = normalizeDomain(norm);
    if (!domain) return false;
    if (await this.get<IgnoreEntry>('ignore', `domain:${domain}`)) return true;
    return isSeedIgnoredDomain(domain);
  }
  deleteIgnore(id: string) {
    return this.delete('ignore', id);
  }

  // domain exclusion (doc id = normalized domain)
  async putDomainExclusion(d: DomainExclusion) {
    const id = normalizeDomain(d.domain);
    await this.put('domainexclusion', { ...d, id, domain: id });
    return { ...d, id, domain: id };
  }
  async isDomainExcluded(domain: string) {
    const doc = await this.get<DomainExclusion>('domainexclusion', normalizeDomain(domain));
    return doc !== undefined;
  }
  listDomainExclusions() {
    return this.listByType<DomainExclusion>('domainexclusion');
  }
  deleteDomainExclusion(domain: string) {
    return this.delete('domainexclusion', normalizeDomain(domain));
  }

  subscribe(listener: ChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async close(): Promise<void> {
    if (this.db) await this.db.close();
  }
}
