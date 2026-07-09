// In-memory Store. The default, fully-functional implementation used for tests
// and for running end-to-end with dummy providers. Emits change events for the
// live feed. Swap for PouchDB (pouchdb.store.ts) when persistence is needed.

import type {
  Account,
  Campaign,
  Niche,
  Outreach,
  Reply,
  Suppression,
  Target,
} from '../../domain/types';
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
  private campaigns = new Map<string, Campaign>();
  private accounts = new Map<string, Account>();
  private targets = new Map<string, Target>();
  private outreaches = new Map<string, Outreach>();
  private replies = new Map<string, Reply>(); // keyed by id
  private repliesByEmailId = new Map<string, string>(); // emailId -> reply id
  private suppressions = new Map<string, Suppression>(); // keyed by normalized email
  private niches = new Map<string, Niche>(); // keyed by niche.key
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

  // campaigns
  async getCampaign(id: string) {
    const c = this.campaigns.get(id);
    return c ? clone(c) : undefined;
  }
  async putCampaign(c: Campaign) {
    this.campaigns.set(c.id, clone(c));
    this.emit('campaign', 'put', c.id);
    return clone(c);
  }
  async listCampaigns() {
    return [...this.campaigns.values()].map(clone);
  }
  async deleteCampaign(id: string) {
    if (this.campaigns.delete(id)) this.emit('campaign', 'delete', id);
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
    if (filter?.campaignId) list = list.filter((t) => t.campaignId === filter.campaignId);
    if (filter?.status) list = list.filter((t) => t.status === filter.status);
    return list.map(clone);
  }
  async deleteTarget(id: string) {
    if (this.targets.delete(id)) this.emit('target', 'delete', id);
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

  subscribe(listener: ChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
