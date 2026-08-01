// Read models — the denormalized payloads the UI reads, assembled from the
// store in one place.
//
// These used to live inline in the HTTP handlers (src/server/app.ts). They moved
// here because there are now TWO readers: the local operator console, which asks
// over HTTP, and the published snapshot (src/services/snapshot.ts), which a
// coworker reads from Firebase with no server in the loop. A join written twice
// drifts, and a viewer showing subtly different prices from the operator console
// is worse than no viewer at all.
//
// Everything here is read-only and side-effect free.

import { normalizeDomain } from '../domain/domain';
import { pitchStyleForBatch } from '../domain/pitch';
import { buildPriceSheet, knownDomains, type DomainPriceSheet } from '../domain/price-sheet';
import type {
  Batch,
  CanPost,
  ID,
  PlacementTerm,
  PriceRecord,
  PriceValue,
  PromptSnapshot,
  Reply,
} from '../domain/types';
import type { Store } from '../ports/store';

// --- Batches ----------------------------------------------------------------

export interface BatchRow extends Batch {
  count: number;
  byStatus: Record<string, number>;
}

/** Batches with their live target rollup, newest first. */
export async function buildBatchRows(store: Store): Promise<BatchRow[]> {
  const batches = await store.listBatches();
  const targets = await store.listTargets();
  const roll = new Map<string, { count: number; byStatus: Record<string, number> }>();
  for (const t of targets) {
    if (!t.batchId) continue;
    let e = roll.get(t.batchId);
    if (!e) {
      e = { count: 0, byStatus: {} };
      roll.set(t.batchId, e);
    }
    e.count++;
    e.byStatus[t.status] = (e.byStatus[t.status] ?? 0) + 1;
  }
  return batches
    .map((b) => ({
      ...b,
      count: roll.get(b.id)?.count ?? 0,
      byStatus: roll.get(b.id)?.byStatus ?? {},
    }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

// --- Domains ----------------------------------------------------------------

/** A stripped standing cell carried on the list row — enough for the tier/niche
 *  filters and the domains export without a per-domain fetch. */
export interface DomainCellRow {
  category: string;
  label: string;
  sensitive: boolean;
  canPost: CanPost;
  price?: PriceValue;
  term?: PlacementTerm;
}

export interface DomainRow {
  domain: string;
  recordCount: number;
  sourceCount: number;
  standingCells: number;
  activeSpecials: number;
  lastObservedAt?: string;
  optedOut: boolean;
  excluded: boolean;
  cells: DomainCellRow[];
}

/** Every known domain (priced ∪ contacted) with a light price summary. */
export async function buildDomainRows(store: Store, now: Date): Promise<DomainRow[]> {
  const records = await store.listPriceRecords();
  const targetDomains = (await store.listTargets()).map((t) => normalizeDomain(t.websiteUrl));
  const excluded = new Set((await store.listDomainExclusions()).map((e) => e.domain));
  // Distinct sender addresses that have priced each domain — >1 flags a domain
  // whose quotes come from more than one email source (cross-check / conflict).
  const sourcesByDomain = new Map<string, Set<string>>();
  for (const rec of records) {
    if (!rec.sourceEmail) continue;
    let set = sourcesByDomain.get(rec.domain);
    if (!set) sourcesByDomain.set(rec.domain, (set = new Set()));
    set.add(rec.sourceEmail.toLowerCase());
  }
  return knownDomains(records, targetDomains).map((domain) => {
    const sheet = buildPriceSheet(domain, records, now);
    return {
      domain,
      recordCount: sheet.recordCount,
      sourceCount: sourcesByDomain.get(domain)?.size ?? 0,
      standingCells: sheet.cells.length,
      activeSpecials: sheet.specials.filter((s) => s.active).length,
      ...(sheet.lastObservedAt ? { lastObservedAt: sheet.lastObservedAt } : {}),
      optedOut: sheet.optedOut,
      excluded: excluded.has(domain),
      cells: sheet.cells.map((c) => ({
        category: c.category,
        label: c.label,
        sensitive: c.sensitive,
        canPost: c.canPost,
        ...(c.price ? { price: c.price } : {}),
        // The term is part of the cell identity, so the row can carry the same
        // niche several times (1 month / 3 months); without it the UI would
        // show duplicate-looking niches it cannot tell apart.
        term: c.term,
      })),
    };
  });
}

export interface DomainDetail {
  sheet: DomainPriceSheet;
  history: PriceRecord[];
  excluded: boolean;
}

/** One domain's folded price sheet plus the raw observations behind it. */
export async function buildDomainDetail(
  store: Store,
  rawDomain: string,
  now: Date,
): Promise<DomainDetail> {
  const domain = normalizeDomain(rawDomain);
  const records = (await store.listPriceRecords({ domain })).sort((a, b) =>
    a.observedAt.localeCompare(b.observedAt),
  );
  return {
    sheet: buildPriceSheet(domain, records, now),
    history: records,
    excluded: await store.isDomainExcluded(domain),
  };
}

// --- Responses --------------------------------------------------------------

export interface ResponseRow extends Reply {
  website?: string;
  batchId?: string;
  batchName?: string;
  accountEmail?: string;
}

/** Replies + parsed result, enriched with the target website, its batch, and the
 *  mailbox OF OURS the reply landed in. */
export async function buildResponseRows(store: Store, batchId?: string): Promise<ResponseRow[]> {
  const replies = await store.listReplies();
  const targets = new Map((await store.listTargets()).map((t) => [t.id, t]));
  const batches = new Map((await store.listBatches()).map((b) => [b.id, b.name]));
  const accountEmails = new Map((await store.listAccounts()).map((a) => [a.id, a.email]));
  // Which of our accounts owns each sent thread. Replies stored before
  // Reply.accountId was populated carry no account of their own, so the
  // outreach that started the thread is what identifies the inbox for them.
  const accountByThread = new Map<string, ID>();
  for (const o of await store.listOutreaches()) {
    if (o.threadId && !accountByThread.has(o.threadId)) accountByThread.set(o.threadId, o.accountId);
  }
  const out = replies.map((r) => {
    const target = r.targetId ? targets.get(r.targetId) : undefined;
    // Narrowest source first: what the reply itself recorded, then the thread
    // it belongs to, then the account the target was assigned to.
    const accountId =
      r.accountId ?? (r.threadId ? accountByThread.get(r.threadId) : undefined) ?? target?.assignedAccountId;
    return {
      ...r,
      website: target?.websiteUrl,
      batchId: target?.batchId,
      batchName: target?.batchId ? batches.get(target.batchId) : undefined,
      accountEmail: accountId ? accountEmails.get(accountId) : undefined,
    };
  });
  return batchId ? out.filter((r) => r.batchId === batchId) : out;
}

// --- One extraction, explained ----------------------------------------------

export interface ReplyDebug {
  reply: Reply;
  mailbox?: { id: string; email: string; providerType: string };
  target?: {
    id: string;
    websiteUrl: string;
    contactEmail: string;
    status: string;
    batchId?: string;
    batchName?: string;
  };
  pitchStyle: 'casino' | 'broad';
  prompt?: PromptSnapshot;
  priceRecords: PriceRecord[];
}

/**
 * Everything needed to debug ONE extraction, in one payload: the inbound email
 * (which mailbox, which ids), the exact prompt that was sent, which model ran
 * it, what came back, and which price records it ultimately wrote. Assembled
 * here rather than in the client so the UI does not have to make five calls and
 * join them itself.
 *
 * `reply` is the caller's — resolved once by the caller and passed in, since
 * both callers already hold it.
 */
export async function buildReplyDebug(store: Store, reply: Reply): Promise<ReplyDebug> {
  const target = reply.targetId ? await store.getTarget(reply.targetId) : undefined;
  const account = reply.accountId ? await store.getAccount(reply.accountId) : undefined;
  const batch = target?.batchId ? await store.getBatch(target.batchId) : undefined;
  // The prompt behind this run — resolvable only if the run recorded a hash
  // (records written before provenance existed carry none).
  const promptHash = reply.extraction?.promptHash;
  const prompt = promptHash
    ? (await store.listPromptSnapshots()).find((p) => p.hash === promptHash)
    : undefined;
  // What the extraction actually produced downstream.
  const records = (await store.listPriceRecords()).filter((r) => r.replyId === reply.id);

  return {
    reply,
    ...(account
      ? { mailbox: { id: account.id, email: account.email, providerType: account.providerType } }
      : {}),
    ...(target
      ? {
          target: {
            id: target.id,
            websiteUrl: target.websiteUrl,
            contactEmail: target.contactEmail,
            status: target.status,
            ...(target.batchId ? { batchId: target.batchId } : {}),
            ...(batch?.name ? { batchName: batch.name } : {}),
          },
        }
      : {}),
    // The pitch style is what decides how a niche-less price is read, so it
    // belongs next to the prompt when explaining an odd classification.
    pitchStyle: pitchStyleForBatch(target?.batchId),
    ...(prompt ? { prompt } : {}),
    priceRecords: records.sort((a, b) => a.domain.localeCompare(b.domain)),
  };
}
