// In-memory Store. The default, fully-functional implementation used for tests
// and for running end-to-end with dummy providers. Emits change events for the
// live feed. Swap for PouchDB (pouchdb.store.ts) when persistence is needed.

import type {
  Account,
  Batch,
  DomainExclusion,
  IgnoreEntry,
  Niche,
  Outreach,
  PriceRecord,
  Reply,
  Suppression,
  Target,
} from '../../domain/types';
import { normalizeDomain } from '../../domain/domain';
import { isSeedIgnoredDomain } from '../../domain/ignore-seed';
import { normalizeEmail } from '../../domain/reply-matching';
import type {
  ChangeEvent,
  ChangeListener,
  DocType,
  OutreachFilter,
  Store,
  TargetFilter,
} from '../../ports/store';

function clone<T>(v: T): T {
  return structuredClone(v);
}

export class MemoryStore implements Store {
  private accounts = new Map<string, Account>();
  private targets = new Map<string, Target>();
  private batches = new Map<string, Batch>();
  private outreaches = new Map<string, Outreach>();
  private replies = new Map<string, Reply>(); // keyed by id
  private repliesByEmailId = new Map<string, string>(); // emailId -> reply id
  private suppressions = new Map<string, Suppression>(); // keyed by normalized email
  private niches = new Map<string, Niche>(); // keyed by niche.key
  private priceRecords = new Map<string, PriceRecord>(); // keyed by id
  private ignores = new Map<string, IgnoreEntry>(); // keyed by `${kind}:${value}`
  private domainExclusions = new Map<string, DomainExclusion>(); // keyed by domain
  private listeners = new Set<ChangeListener>();

  private emit(type: DocType, action: ChangeEvent['action'], id: string): void {
    for (const l of this.listeners) {
      try {
        l({ type, action, id });
      } catch {
        /* a bad listener must not break a write */
      }
    }
  }

  // accounts
  async getAccount(id: string) {
    const a = this.accounts.get(id);
    return a ? clone(a) : undefined;
  }
  async putAccount(a: Account) {
    this.accounts.set(a.id, clone(a));
    this.emit('account', 'put', a.id);
    return clone(a);
  }
  async updateAccount(id: string, mutate: (current: Account) => Account) {
    const current = this.accounts.get(id);
    if (!current) throw new Error(`account ${id} not found`);
    return this.putAccount(mutate(clone(current)));
  }
  async listAccounts() {
    return [...this.accounts.values()].map(clone);
  }
  async deleteAccount(id: string) {
    if (this.accounts.delete(id)) this.emit('account', 'delete', id);
  }

  // targets
  async getTarget(id: string) {
    const t = this.targets.get(id);
    return t ? clone(t) : undefined;
  }
  async putTarget(t: Target) {
    this.targets.set(t.id, clone(t));
    this.emit('target', 'put', t.id);
    return clone(t);
  }
  async updateTarget(id: string, mutate: (current: Target) => Target) {
    const current = this.targets.get(id);
    if (!current) throw new Error(`target ${id} not found`);
    return this.putTarget(mutate(clone(current)));
  }
  async listTargets(filter?: TargetFilter) {
    let list = [...this.targets.values()];
    if (filter?.batchId) list = list.filter((t) => t.batchId === filter.batchId);
    if (filter?.status) list = list.filter((t) => t.status === filter.status);
    return list.map(clone);
  }
  async deleteTarget(id: string) {
    if (this.targets.delete(id)) this.emit('target', 'delete', id);
  }

  // batches
  async getBatch(id: string) {
    const b = this.batches.get(id);
    return b ? clone(b) : undefined;
  }
  async putBatch(b: Batch) {
    this.batches.set(b.id, clone(b));
    this.emit('batch', 'put', b.id);
    return clone(b);
  }
  async listBatches() {
    return [...this.batches.values()].map(clone);
  }

  // outreaches
  async getOutreach(id: string) {
    const o = this.outreaches.get(id);
    return o ? clone(o) : undefined;
  }
  async putOutreach(o: Outreach) {
    this.outreaches.set(o.id, clone(o));
    this.emit('outreach', 'put', o.id);
    return clone(o);
  }
  async listOutreaches(filter?: OutreachFilter) {
    let list = [...this.outreaches.values()];
    if (filter?.targetId) list = list.filter((o) => o.targetId === filter.targetId);
    if (filter?.accountId) list = list.filter((o) => o.accountId === filter.accountId);
    return list.map(clone);
  }

  // replies
  async getReplyByEmailId(emailId: string) {
    const id = this.repliesByEmailId.get(emailId);
    if (!id) return undefined;
    const r = this.replies.get(id);
    return r ? clone(r) : undefined;
  }
  async putReply(r: Reply) {
    this.replies.set(r.id, clone(r));
    this.repliesByEmailId.set(r.emailId, r.id);
    this.emit('reply', 'put', r.id);
    return clone(r);
  }
  async listReplies() {
    return [...this.replies.values()].map(clone);
  }
  async deleteReply(id: string) {
    const r = this.replies.get(id);
    if (r) {
      this.repliesByEmailId.delete(r.emailId);
      this.replies.delete(id);
      this.emit('reply', 'delete', id);
    }
  }

  // niches
  async listNiches() {
    return [...this.niches.values()].map(clone);
  }
  async putNiche(n: Niche) {
    this.niches.set(n.key, clone(n));
    this.emit('niche', 'put', n.key);
    return clone(n);
  }
  async deleteNiche(key: string) {
    if (this.niches.delete(key)) this.emit('niche', 'delete', key);
  }

  // suppression
  async isSuppressed(email: string) {
    return this.suppressions.has(normalizeEmail(email));
  }
  async addSuppression(s: Suppression) {
    const key = normalizeEmail(s.email);
    this.suppressions.set(key, clone({ ...s, id: key, email: key }));
    this.emit('suppression', 'put', key);
  }
  async listSuppressions() {
    return [...this.suppressions.values()].map(clone);
  }
  // Delete by the exact stored key (see Store.removeSuppression).
  async removeSuppression(email: string) {
    if (this.suppressions.delete(email)) this.emit('suppression', 'delete', email);
  }

  // price records
  async putPriceRecord(r: PriceRecord) {
    this.priceRecords.set(r.id, clone(r));
    this.emit('pricerecord', 'put', r.id);
    return clone(r);
  }
  async listPriceRecords(filter?: { domain?: string }) {
    let list = [...this.priceRecords.values()];
    if (filter?.domain) {
      const d = normalizeDomain(filter.domain);
      list = list.filter((r) => r.domain === d);
    }
    return list.map(clone);
  }
  async deletePriceRecord(id: string) {
    if (this.priceRecords.delete(id)) this.emit('pricerecord', 'delete', id);
  }

  // ignore list
  async putIgnore(e: IgnoreEntry) {
    const key = `${e.kind}:${e.value}`;
    const doc = clone({ ...e, id: key });
    this.ignores.set(key, doc);
    this.emit('ignore', 'put', key);
    return clone(doc);
  }
  async listIgnore() {
    return [...this.ignores.values()].map(clone);
  }
  async isIgnored(email: string) {
    const norm = normalizeEmail(email);
    if (this.ignores.has(`email:${norm}`)) return true;
    const domain = normalizeDomain(norm);
    if (!domain) return false;
    if (this.ignores.has(`domain:${domain}`)) return true;
    return isSeedIgnoredDomain(domain);
  }
  async deleteIgnore(id: string) {
    if (this.ignores.delete(id)) this.emit('ignore', 'delete', id);
  }

  // domain exclusion
  async putDomainExclusion(d: DomainExclusion) {
    const key = normalizeDomain(d.domain);
    const doc = clone({ ...d, id: key, domain: key });
    this.domainExclusions.set(key, doc);
    this.emit('domainexclusion', 'put', key);
    return clone(doc);
  }
  async isDomainExcluded(domain: string) {
    return this.domainExclusions.has(normalizeDomain(domain));
  }
  async listDomainExclusions() {
    return [...this.domainExclusions.values()].map(clone);
  }
  async deleteDomainExclusion(domain: string) {
    const key = normalizeDomain(domain);
    if (this.domainExclusions.delete(key)) this.emit('domainexclusion', 'delete', key);
  }

  subscribe(listener: ChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
