// Local HTTP API + SSE, built on node:http (no dependency). Mirrors the Store
// port (overview.md §11) and serves the static web UI from `webDir`.
//
//   GET    /api/status
//   POST   /api/preview                 { websiteUrl?, advertised?{url,description}, contactName?, notes? }
//   GET    /api/accounts
//   POST   /api/accounts                { email, senderName, credentialRef?, providerType?, maxDailyLimit?, signature?, status? }
//   PATCH  /api/accounts/:id            { dailyLimitOverride?, maxDailyLimit?, senderName?, signature? }
//   POST   /api/accounts/:id/pause | /resume
//   DELETE /api/accounts/:id
//   GET    /api/targets?status=&batchId=
//   POST   /api/targets                 { websiteUrl, contactEmail, contactName?, notes?, batchId? }
//   DELETE /api/targets/:id
//   GET    /api/batches                 → batches + live { count, byStatus }
//   POST   /api/batches                 { name?, advertised?{url,description} } → creates an import batch
//   GET    /api/responses?batchId=
//   GET    /api/suppressions
//   POST   /api/run/send | /api/run/poll | /api/run/fetch
//   GET    /api/stream                  (Server-Sent Events: store change feed)
//   GET    /*                           (static web UI)

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, normalize, join } from 'node:path';
import type { Config } from '../config';
import type { GmailOAuthHandler } from '../adapters/email/gmail-api.provider';
import type {
  Account,
  AccountStatus,
  Batch,
  CanPost,
  ExtractionProvenance,
  ID,
  OutreachResult,
  PriceRecord,
  ProviderType,
  Reply,
  Target,
  TargetStatus,
} from '../domain/types';
import { allNiches, categorizeTopic } from '../domain/niches';
import { attributeOffers, emailToDomains, normalizeEmail } from '../domain/reply-matching';
import { normalizeDomain } from '../domain/domain';
import { buildPriceSheet, knownDomains } from '../domain/price-sheet';
import { accountSendState } from '../domain/account-state';
import { assembleResult, type RawExtraction, type RawOffer } from '../domain/extraction';
import { pitchStyleForBatch, resolveProfile } from '../domain/pitch';
import type { Clock } from '../lib/clock';
import { newId } from '../lib/ids';
import { draftEmail } from '../services/drafter';
import { logger } from '../lib/logger';
import type { Store } from '../ports/store';
import { isWithinSendWindow } from '../scheduler/window';

export interface ServerDeps {
  store: Store;
  config: Config;
  clock: Clock;
  /** Manual "Run now" — a full send pass. */
  runSend: () => Promise<unknown>;
  /** Manual "Run now" — a poll pass. */
  runPoll: () => Promise<unknown>;
  /** Manual "Run now" — fetch only (no AI extraction). */
  runFetch: () => Promise<unknown>;
  /** Directory of static UI assets. Default ./web */
  webDir?: string;
  /** Names of the wired providers, for /api/status. */
  providers?: { llm: string; email: string; store: string };
  /** Present when Google OAuth is configured — drives /api/oauth/* endpoints. */
  gmailOAuth?: GmailOAuthHandler;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Uint8Array[] = [];
  for await (const c of req) chunks.push(c as Uint8Array);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return {};
  }
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
}

/** Strip raw OAuth tokens from an account before sending to the client.
 *  Replaces oauthTokens with a safe boolean oauthConnected. */
function sanitizeAccount(a: Account): Record<string, unknown> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { oauthTokens: _tokens, ...rest } = a;
  return { ...rest, oauthConnected: !!a.oauthTokens?.refreshToken };
}

/** Build the OAuth redirect URI from the incoming request's host header. */
function oauthRedirectUri(req: IncomingMessage): string {
  const host = req.headers.host ?? 'localhost:8787';
  const proto = req.headers['x-forwarded-proto'] ?? 'http';
  return `${proto}://${host}/api/oauth/callback`;
}

/** Default env-var NAME for a new account's secret (never the secret itself). */
function deriveCredentialRef(email: string): string {
  const local = email.split('@')[0] ?? email;
  const slug = local.replace(/[^a-zA-Z0-9]+/g, '_').toUpperCase();
  return `GMAIL_${slug}`;
}

/**
 * Re-attribute a hand-corrected reply's offers and bring its PriceRecords back in
 * line. The Domains view derives ENTIRELY from PriceRecords, so without this a
 * correction lands in the responses feed and the price sheet keeps serving the
 * old figure forever.
 *
 * Records are updated IN PLACE rather than appended. A human edit fixes what we
 * believe the message said — it is not a new observation from the publisher — so
 * the record keeps its id and its original `observedAt`. Appending instead would
 * make a typo fix look like a fresh price announcement and would double-count the
 * message in the history.
 *
 * A domain whose offers the edit removed entirely no longer has an observation
 * behind it, so its record is deleted rather than left as an empty husk.
 */
/** Flag a result as human-corrected, preserving the run that originally produced
 *  it. When there is no prior provenance (a record written before provenance
 *  existed), record the edit alone rather than inventing a model/prompt. */
function markEdited(prev: ExtractionProvenance | undefined, clock: Clock): ExtractionProvenance {
  const at = clock.now().toISOString();
  return {
    provider: prev?.provider ?? 'human',
    ...(prev?.model ? { model: prev.model } : {}),
    promptHash: prev?.promptHash ?? '',
    promptStyle: prev?.promptStyle ?? '',
    extractedAt: prev?.extractedAt ?? at,
    editedByHuman: true,
    editedAt: at,
  };
}

async function syncPriceRecords(
  store: Store,
  reply: Reply,
  target: Target,
  result: OutreachResult,
  clock: Clock,
): Promise<void> {
  const own = normalizeDomain(target.websiteUrl);
  const senderDomains = new Set(
    emailToDomains(await store.listTargets()).get(normalizeEmail(reply.fromAddress)) ?? [],
  );
  if (own) senderDomains.add(own);
  const { groups } = attributeOffers(result.offers, [...senderDomains], own || undefined);

  const stale = new Map(
    (await store.listPriceRecords())
      .filter((r) => r.replyId === reply.id)
      .map((r) => [r.domain, r] as const),
  );

  for (const group of groups) {
    const prev = stale.get(group.domain);
    const record: PriceRecord = {
      // Keep identity + observation time; only what the message SAID changes.
      id: prev?.id ?? newId('pricerecord'),
      domain: group.domain,
      offers: group.offers,
      observedAt: prev?.observedAt ?? reply.receivedAt ?? clock.now().toISOString(),
      sourceEmail: normalizeEmail(reply.fromAddress),
      sourceMessageId: reply.rfcMessageId,
      replyId: reply.id,
      ...(group.domain === own ? { targetId: target.id } : {}),
      attribution: group.attribution,
      ...(result.optOut ? { optOut: true } : {}),
      // The record now reflects a human's judgement, not the model's — say so on
      // the record itself, since that is what the price history reads.
      extraction: markEdited(prev?.extraction ?? reply.extraction, clock),
      ...(result.aiExplanation ? { aiExplanation: result.aiExplanation } : {}),
    };
    await store.putPriceRecord(record);
    stale.delete(group.domain);
  }

  for (const orphan of stale.values()) await store.deletePriceRecord(orphan.id);
}

export function createApiServer(deps: ServerDeps): Server {
  const webDir = deps.webDir ?? './web';

  const server = createServer((req, res) => {
    handle(deps, webDir, req, res).catch((err) => {
      logger.error('request handler crashed', { error: String(err) });
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
    });
  });
  return server;
}

async function handle(
  deps: ServerDeps,
  webDir: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const { store } = deps;
  const method = req.method ?? 'GET';
  const url = new URL(req.url ?? '/', 'http://localhost');
  const seg = url.pathname.split('/').filter(Boolean);

  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  // ---- API ----
  if (seg[0] === 'api') {
    // GET /api/status
    if (method === 'GET' && seg[1] === 'status' && seg.length === 2) {
      const batchId = url.searchParams.get('batchId') || undefined;
      const targets = await store.listTargets(batchId ? { batchId } : undefined);
      const byStatus: Record<string, number> = {};
      for (const t of targets) byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;

      // Engagement funnel: byStatus alone can't tell a silent 'contacted' target
      // from one that sent a holding/auto reply (those leave the target
      // 'contacted'), so join in the replies. Each target lands in exactly one
      // bucket; `replied` is everyone who wrote back (incl. holding/auto/opt-out).
      const repliedTargetIds = new Set(
        (await store.listReplies()).map((r) => r.targetId).filter(Boolean),
      );
      const engagement = {
        queued: 0, // pending + reserved (not yet contacted)
        contacted: 0, // contacted, no reply back yet (truly silent)
        acknowledged: 0, // replied, but only a holding/auto message — no info yet
        answered: 0, // replied with a substantive answer
        declined: 0, // replied to decline
        other: 0, // replied, other/question intent
        optedOut: 0, // replied to opt out (→ excluded + suppressed)
        excluded: 0, // excluded without a reply (manual suppression)
        bounced: 0,
      };
      for (const t of targets) {
        const hasReply = repliedTargetIds.has(t.id);
        switch (t.status) {
          case 'pending':
          case 'reserved':
            engagement.queued++;
            break;
          case 'bounced':
            engagement.bounced++;
            break;
          case 'excluded':
            hasReply ? engagement.optedOut++ : engagement.excluded++;
            break;
          case 'replied': {
            const intent = t.result?.intent ?? 'answer';
            if (intent === 'decline') engagement.declined++;
            else if (intent === 'answer') engagement.answered++;
            else engagement.other++;
            break;
          }
          default: // 'contacted', 'needs_review'
            hasReply ? engagement.acknowledged++ : engagement.contacted++;
        }
      }
      const replied =
        engagement.acknowledged +
        engagement.answered +
        engagement.declined +
        engagement.other +
        engagement.optedOut;

      // Commercial outcomes: of the targets that replied, which gave us usable
      // info — a quoted price, and/or a yes/no on whether they'll post at all.
      const outcomes = { informative: 0, priced: 0, postingYes: 0, postingNo: 0 };
      for (const t of targets) {
        const r = t.result;
        if (!r) continue;
        const offers = r.offers ?? [];
        const hasPrice = offers.some((o) => o.price?.amount != null);
        if (hasPrice) outcomes.priced++;
        if (hasPrice || offers.length > 0) outcomes.informative++;
        if (r.canPost === 'yes' || offers.some((o) => o.canPost === 'yes')) outcomes.postingYes++;
        else if (offers.length > 0 && offers.every((o) => o.canPost === 'no')) outcomes.postingNo++;
      }

      const now = deps.clock.now();
      return sendJson(res, 200, {
        ok: true,
        time: now.toISOString(),
        accounts: (await store.listAccounts()).length,
        targets: { total: targets.length, byStatus },
        engagement: { ...engagement, replied },
        outcomes,
        providers: deps.providers ?? null,
        sendWindow: deps.config.sendWindow,
        windowActive: isWithinSendWindow(now, deps.config.sendWindow),
      });
    }

    // POST /api/preview — render the outreach email from the global pitch profile
    // (optionally overriding the advertised site, as a batch would) + a fake target.
    if (method === 'POST' && seg[1] === 'preview' && seg.length === 2) {
      const body = (await readJsonBody(req)) as Record<string, unknown>;
      const websiteUrl = str(body.websiteUrl) ?? 'example.com';
      const accounts = await store.listAccounts();
      const account = accounts.find((a) => a.status === 'active') ?? accounts[0];
      if (!account) return sendJson(res, 400, { error: 'no accounts configured' });
      const adv = (body.advertised ?? {}) as Record<string, unknown>;
      const advertised = str(adv.url)
        ? { url: str(adv.url)!, description: str(adv.description) ?? '' }
        : undefined;
      const profile = resolveProfile(advertised ? { advertised } : undefined, deps.config.pitch);
      const fakeTarget: Target = {
        id: 'preview',
        websiteUrl,
        contactEmail: str(body.contactEmail) ?? `contact@${websiteUrl}`,
        contactName: str(body.contactName),
        notes: str(body.notes),
        status: 'pending',
        followUpCount: 0,
        createdAt: deps.clock.now().toISOString(),
      };
      const draft = draftEmail(profile, account, fakeTarget);
      return sendJson(res, 200, {
        subject: draft.subject,
        body: draft.body,
        senderName: account.senderName,
        senderEmail: account.email,
      });
    }

    // GET /api/accounts — each account enriched with live send state (sent
    // today, current cap, remaining, drip rate, projected-today). All derived
    // from the Outreach log + config, so it can't drift.
    if (method === 'GET' && seg[1] === 'accounts' && seg.length === 2) {
      const now = deps.clock.now();
      const accounts = await store.listAccounts();
      const outreaches = await store.listOutreaches();
      return sendJson(
        res,
        200,
        accounts.map((a) => ({
          ...sanitizeAccount(a),
          state: accountSendState(a, outreaches, now, deps.config.sendWindow, deps.config.warmup),
        })),
      );
    }

    // POST /api/accounts — add a (Gmail) sending account
    if (method === 'POST' && seg[1] === 'accounts' && seg.length === 2) {
      const body = (await readJsonBody(req)) as Record<string, unknown>;
      const email = str(body.email);
      const senderName = str(body.senderName);
      if (!email || !senderName) {
        return sendJson(res, 400, { error: 'email and senderName are required' });
      }
      const providerType = (str(body.providerType) as ProviderType) ?? 'gmail-api';
      const maxDailyLimit =
        typeof body.maxDailyLimit === 'number' && body.maxDailyLimit > 0 ? body.maxDailyLimit : 40;
      const account: Account = {
        id: newId('account'),
        email,
        providerType,
        credentialRef: str(body.credentialRef) ?? deriveCredentialRef(email),
        senderName,
        signature: str(body.signature),
        status: (str(body.status) as AccountStatus) ?? 'paused',
        createdAt: deps.clock.now().toISOString(),
        maxDailyLimit,
      };
      return sendJson(res, 201, sanitizeAccount(await store.putAccount(account)));
    }

    // /api/accounts/:id ...
    if (seg[1] === 'accounts' && seg[2]) {
      const account = await store.getAccount(seg[2]);
      if (!account) return sendJson(res, 404, { error: 'account not found' });

      if (method === 'PATCH' && seg.length === 3) {
        const body = (await readJsonBody(req)) as Partial<Account>;
        const updated = await store.updateAccount(account.id, (current) => {
          const next: Account = { ...current };
          if (typeof body.dailyLimitOverride === 'number')
            next.dailyLimitOverride = body.dailyLimitOverride;
          if (typeof body.maxDailyLimit === 'number') next.maxDailyLimit = body.maxDailyLimit;
          if (typeof body.senderName === 'string') next.senderName = body.senderName;
          if (typeof body.signature === 'string') next.signature = body.signature;
          if (body.providerType === 'gmail-api' || body.providerType === 'smtp-imap')
            next.providerType = body.providerType;
          return next;
        });
        return sendJson(res, 200, sanitizeAccount(updated));
      }
      if (method === 'POST' && seg[3] === 'pause') {
        const updated = await store.updateAccount(account.id, (current) => ({
          ...current,
          status: 'paused',
        }));
        return sendJson(res, 200, sanitizeAccount(updated));
      }
      if (method === 'POST' && seg[3] === 'resume') {
        const updated = await store.updateAccount(account.id, (current) => ({
          ...current,
          status: 'active',
        }));
        return sendJson(res, 200, sanitizeAccount(updated));
      }
      if (method === 'POST' && seg[3] === 'rollback-cursor') {
        // Roll the poll cursor back by 24 h so the next poll re-fetches recent mail.
        const updated = await store.updateAccount(account.id, (current) => {
          const base = current.pollCursor?.lastPolledAt
            ? new Date(current.pollCursor.lastPolledAt).getTime()
            : Date.now();
          const rolled = new Date(base - 24 * 60 * 60 * 1000).toISOString();
          return {
            ...current,
            pollCursor: { mailbox: current.pollCursor?.mailbox ?? 'INBOX', lastPolledAt: rolled },
          };
        });
        return sendJson(res, 200, sanitizeAccount(updated));
      }
      if (method === 'DELETE' && seg.length === 3) {
        await store.deleteAccount(account.id);
        return sendJson(res, 200, { ok: true, id: account.id });
      }
    }

    // GET /api/targets?status=&batchId=
    if (method === 'GET' && seg[1] === 'targets' && seg.length === 2) {
      const status = url.searchParams.get('status') as TargetStatus | null;
      const batchId = url.searchParams.get('batchId') ?? undefined;
      return sendJson(res, 200, await store.listTargets(
        (status || batchId) ? { ...(status ? { status } : {}), ...(batchId ? { batchId } : {}) } : undefined
      ));
    }

    // GET /api/targets/:id/thread — full send+reply history for a target
    if (method === 'GET' && seg[1] === 'targets' && seg[2] && seg[3] === 'thread') {
      const target = await store.getTarget(seg[2]);
      if (!target) return sendJson(res, 404, { error: 'target not found' });
      const outreaches = await store.listOutreaches({ targetId: target.id });
      const allReplies = await store.listReplies();
      const replies = allReplies.filter((r) => r.targetId === target.id);
      return sendJson(res, 200, { target, outreaches, replies });
    }

    // POST /api/targets — queue a new outreach target
    if (method === 'POST' && seg[1] === 'targets' && seg.length === 2) {
      const body = (await readJsonBody(req)) as Record<string, unknown>;
      const websiteUrl = str(body.websiteUrl);
      const contactEmail = str(body.contactEmail);
      if (!websiteUrl || !contactEmail) {
        return sendJson(res, 400, { error: 'websiteUrl and contactEmail are required' });
      }
      // Domain-level do-not-contact (D9): reject an import whose site is excluded.
      // Bulk import tolerates per-row failures, so this drops just the one row.
      if (await store.isDomainExcluded(normalizeDomain(websiteUrl))) {
        return sendJson(res, 409, { error: 'websiteUrl domain is excluded (do-not-contact)' });
      }
      // A bulk import creates its batch up front (POST /api/batches) and passes
      // the id on every row. A lone add omits it → mint a one-off 'manual' batch.
      let batchId = str(body.batchId);
      if (batchId) {
        if (!(await store.getBatch(batchId))) {
          return sendJson(res, 400, { error: 'unknown batchId' });
        }
      } else {
        const batch: Batch = {
          id: newId('batch'),
          source: 'manual',
          createdAt: deps.clock.now().toISOString(),
        };
        await store.putBatch(batch);
        batchId = batch.id;
      }
      const target: Target = {
        id: newId('target'),
        batchId,
        websiteUrl,
        contactEmail,
        contactName: str(body.contactName),
        notes: str(body.notes),
        status: 'pending',
        followUpCount: 0,
        createdAt: deps.clock.now().toISOString(),
      };
      return sendJson(res, 201, await store.putTarget(target));
    }

    // PATCH /api/targets/:id — update mutable fields (status, result)
    if (method === 'PATCH' && seg[1] === 'targets' && seg[2] && seg.length === 3) {
      const target = await store.getTarget(seg[2]);
      if (!target) return sendJson(res, 404, { error: 'target not found' });
      const body = (await readJsonBody(req)) as Partial<Target>;
      const updated = await store.updateTarget(target.id, (current) => {
        const next: Target = { ...current };
        if (typeof body.status === 'string') next.status = body.status as Target['status'];
        if ('result' in body) next.result = body.result as Target['result'];
        return next;
      });
      return sendJson(res, 200, updated);
    }

    // DELETE /api/targets/:id
    if (method === 'DELETE' && seg[1] === 'targets' && seg[2] && seg.length === 3) {
      const target = await store.getTarget(seg[2]);
      if (!target) return sendJson(res, 404, { error: 'target not found' });
      await store.deleteTarget(target.id);
      return sendJson(res, 200, { ok: true, id: target.id });
    }

    // GET /api/batches — batches, each enriched with a live target count + status
    // breakdown derived from the targets (never stored, so it can't drift).
    if (method === 'GET' && seg[1] === 'batches' && seg.length === 2) {
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
      const out = batches
        .map((b) => ({ ...b, count: roll.get(b.id)?.count ?? 0, byStatus: roll.get(b.id)?.byStatus ?? {} }))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return sendJson(res, 200, out);
    }

    // POST /api/batches — create a named import batch; the bulk-import client
    // calls this first, then posts each target with the returned id. An optional
    // `advertised` overrides the global advertised site for this import's emails.
    if (method === 'POST' && seg[1] === 'batches' && seg.length === 2) {
      const body = (await readJsonBody(req)) as Record<string, unknown>;
      const adv = (body.advertised ?? {}) as Record<string, unknown>;
      const advertised = str(adv.url)
        ? { url: str(adv.url)!, description: str(adv.description) ?? '' }
        : undefined;
      const batch: Batch = {
        id: newId('batch'),
        ...(str(body.name) ? { name: str(body.name) } : {}),
        source: 'import',
        ...(advertised ? { advertised } : {}),
        createdAt: deps.clock.now().toISOString(),
      };
      return sendJson(res, 201, await store.putBatch(batch));
    }

    // GET /api/replies/:id — one raw reply (source message behind a price record)
    if (method === 'GET' && seg[1] === 'replies' && seg[2] && seg.length === 3) {
      const id = decodeURIComponent(seg[2]);
      const reply = (await store.listReplies()).find((r) => r.id === id);
      if (!reply) return sendJson(res, 404, { error: 'reply not found' });
      return sendJson(res, 200, reply);
    }

    // GET /api/replies/:id/debug — everything needed to debug ONE extraction, in
    // one payload: the inbound email (which mailbox, which ids), the exact prompt
    // that was sent, which model ran it, what came back, and which price records
    // it ultimately wrote. Assembled here rather than in the client so the UI
    // does not have to make five calls and join them itself.
    if (method === 'GET' && seg[1] === 'replies' && seg[2] && seg[3] === 'debug' && seg.length === 4) {
      const id = decodeURIComponent(seg[2]);
      const reply = (await store.listReplies()).find((r) => r.id === id);
      if (!reply) return sendJson(res, 404, { error: 'reply not found' });

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

      return sendJson(res, 200, {
        reply,
        mailbox: account ? { id: account.id, email: account.email, providerType: account.providerType } : undefined,
        target: target
          ? {
              id: target.id,
              websiteUrl: target.websiteUrl,
              contactEmail: target.contactEmail,
              status: target.status,
              batchId: target.batchId,
              batchName: batch?.name,
            }
          : undefined,
        // The pitch style is what decides how a niche-less price is read, so it
        // belongs next to the prompt when explaining an odd classification.
        pitchStyle: pitchStyleForBatch(target?.batchId),
        prompt,
        priceRecords: records.sort((a, b) => a.domain.localeCompare(b.domain)),
      });
    }

    // DELETE /api/replies/:id
    if (method === 'DELETE' && seg[1] === 'replies' && seg[2] && seg.length === 3) {
      await store.deleteReply(seg[2]);
      return sendJson(res, 200, { ok: true, id: seg[2] });
    }

    // PATCH /api/replies/:id — human correction of the AI extraction.
    // Body: { offers: [{ category, label?, sensitive?, canPost, priceRaw,
    //                    website?, isSpecial?, specialUntil? }], optOut? }
    // Rebuilt through assembleResult so price parsing / niche reconciliation /
    // canPost summary match a normal extraction. Clears the `review` flag.
    if (method === 'PATCH' && seg[1] === 'replies' && seg[2] && seg.length === 3) {
      const id = seg[2];
      const reply = (await store.listReplies()).find((r) => r.id === id);
      if (!reply) return sendJson(res, 404, { error: 'reply not found' });

      const body = (await readJsonBody(req)) as { offers?: unknown; optOut?: unknown };
      const rawOffers: RawOffer[] = Array.isArray(body.offers)
        ? body.offers.map((o) => {
            const off = o as Record<string, unknown>;
            // A newly-added offer may carry only a label; use it as the category
            // seed (reconcileOffers normalizes it into a niche key).
            const category = str(off.category) ?? str(off.label) ?? '';
            // website/isSpecial/specialUntil/termRaw scope the reconcile cell key
            // (website|niche|special|term). Dropping them here merges cells that
            // must stay distinct — a portfolio reply pricing 11 domains would
            // collapse to one site's worth of offers on save, and a publisher's
            // monthly and yearly rates would overwrite each other.
            return {
              category,
              label: str(off.label) ?? category,
              sensitive: Boolean(off.sensitive),
              canPost: (str(off.canPost) as CanPost) ?? 'maybe',
              priceRaw: typeof off.priceRaw === 'string' ? off.priceRaw : '',
              ...(str(off.termRaw) ? { termRaw: str(off.termRaw) } : {}),
              ...(str(off.website) ? { website: str(off.website) } : {}),
              ...(off.isSpecial ? { isSpecial: true } : {}),
              ...(str(off.specialUntil) ? { specialUntil: str(off.specialUntil) } : {}),
            };
          }).filter((o) => o.category)
        : [];

      const target = reply.targetId ? await store.getTarget(reply.targetId) : undefined;
      const niches = allNiches(await store.listNiches());
      // Preserve the AI's prose; only the offers + optOut are edited.
      const raw: RawExtraction = {
        optOut: Boolean(body.optOut),
        offers: rawOffers,
        reasoning: reply.parsed?.reasoning ?? 'Edited by hand.',
        ...(reply.parsed?.conditions ? { conditions: reply.parsed.conditions } : {}),
        ...(reply.parsed?.notes ? { notes: reply.parsed.notes } : {}),
      };
      const requestedCategory = categorizeTopic(deps.config.pitch.topic, niches);
      const { result, discovered } = assembleResult(raw, {
        niches,
        ...(requestedCategory ? { requestedCategory } : {}),
      });
      for (const n of discovered) {
        await store.putNiche({ ...n, createdAt: n.createdAt ?? deps.clock.now().toISOString() });
      }

      reply.parsed = result;
      reply.review = undefined; // corrected by a human
      // Keep the original run's identity (which model/prompt produced the result
      // that needed fixing) and mark that a person changed it, so an edited price
      // is never mistaken for the model's own output.
      reply.extraction = markEdited(reply.extraction, deps.clock);
      reply.extractionStatus = 'done';
      await store.putReply(reply);
      if (target) {
        await store.updateTarget(target.id, (t) => ({
          ...t,
          status: result.optOut ? 'excluded' : 'replied',
          result,
        }));
        await syncPriceRecords(store, reply, target, result, deps.clock);
      }
      return sendJson(res, 200, reply);
    }

    // GET /api/responses?batchId= — replies + parsed result, enriched with target
    // website + batch + the mailbox of OURS the reply landed in.
    if (method === 'GET' && seg[1] === 'responses' && seg.length === 2) {
      const batchId = url.searchParams.get('batchId') ?? undefined;
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
      let out = replies.map((r) => {
        const target = r.targetId ? targets.get(r.targetId) : undefined;
        // Narrowest source first: what the reply itself recorded, then the thread
        // it belongs to, then the account the target was assigned to.
        const accountId = r.accountId
          ?? (r.threadId ? accountByThread.get(r.threadId) : undefined)
          ?? target?.assignedAccountId;
        return {
          ...r,
          website: target?.websiteUrl,
          batchId: target?.batchId,
          batchName: target?.batchId ? batches.get(target.batchId) : undefined,
          accountEmail: accountId ? accountEmails.get(accountId) : undefined,
        };
      });
      if (batchId) out = out.filter((r) => r.batchId === batchId);
      return sendJson(res, 200, out);
    }

    // GET /api/suppressions
    if (method === 'GET' && seg[1] === 'suppressions' && seg.length === 2) {
      return sendJson(res, 200, await store.listSuppressions());
    }

    // GET /api/prompts — the archived extraction prompts, newest first. Resolves
    // an ExtractionProvenance.promptHash back to the exact instructions that
    // produced a result, long after the source has moved on.
    if (method === 'GET' && seg[1] === 'prompts' && seg.length === 2) {
      const list = await store.listPromptSnapshots();
      return sendJson(res, 200, [...list].sort((a, b) => b.firstSeenAt.localeCompare(a.firstSeenAt)));
    }

    // GET /api/prompts/:hash — one archived prompt, full text.
    if (method === 'GET' && seg[1] === 'prompts' && seg[2] && seg.length === 3) {
      const hash = decodeURIComponent(seg[2]);
      const found = (await store.listPromptSnapshots()).find((p) => p.hash === hash);
      if (!found) return sendJson(res, 404, { error: 'prompt not found' });
      return sendJson(res, 200, found);
    }

    // GET /api/niches — seed + learned post-category registry (drives the response filter)
    if (method === 'GET' && seg[1] === 'niches' && seg.length === 2) {
      return sendJson(res, 200, allNiches(await store.listNiches()));
    }

    // GET /api/domains — known domains (record ∪ target sites) with a light summary
    if (method === 'GET' && seg[1] === 'domains' && seg.length === 2) {
      const records = await store.listPriceRecords();
      const targetDomains = (await store.listTargets()).map((t) => normalizeDomain(t.websiteUrl));
      const excluded = new Set((await store.listDomainExclusions()).map((e) => e.domain));
      const now = deps.clock.now();
      // Distinct sender addresses that have priced each domain — >1 flags a domain
      // whose quotes come from more than one email source (cross-check / conflict).
      const sourcesByDomain = new Map<string, Set<string>>();
      for (const rec of records) {
        if (!rec.sourceEmail) continue;
        let set = sourcesByDomain.get(rec.domain);
        if (!set) sourcesByDomain.set(rec.domain, (set = new Set()));
        set.add(rec.sourceEmail.toLowerCase());
      }
      const domains = knownDomains(records, targetDomains).map((domain) => {
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
          // Stripped standing cells so the UI can filter (by sensitivity tier and
          // by niche) and export price columns without a per-domain fetch.
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
      return sendJson(res, 200, domains);
    }

    // GET /api/domains/:domain — full price sheet + raw history + exclusion state
    if (method === 'GET' && seg[1] === 'domains' && seg[2] && seg.length === 3) {
      const domain = normalizeDomain(decodeURIComponent(seg[2]));
      const records = (await store.listPriceRecords({ domain })).sort((a, b) =>
        a.observedAt.localeCompare(b.observedAt),
      );
      const sheet = buildPriceSheet(domain, records, deps.clock.now());
      const excluded = await store.isDomainExcluded(domain);
      return sendJson(res, 200, { sheet, history: records, excluded });
    }

    // --- ignore list (inbound skip) CRUD ---
    if (method === 'GET' && seg[1] === 'ignore' && seg.length === 2) {
      return sendJson(res, 200, await store.listIgnore());
    }
    if (method === 'POST' && seg[1] === 'ignore' && seg.length === 2) {
      const body = (await readJsonBody(req)) as Record<string, unknown>;
      const kind = str(body.kind);
      const rawValue = str(body.value);
      if ((kind !== 'email' && kind !== 'domain') || !rawValue) {
        return sendJson(res, 400, { error: "kind ('email'|'domain') and value are required" });
      }
      const value = kind === 'email' ? rawValue.trim().toLowerCase() : normalizeDomain(rawValue);
      if (!value) return sendJson(res, 400, { error: 'value did not normalize to anything' });
      const entry = await store.putIgnore({
        id: `${kind}:${value}`,
        kind,
        value,
        reason: str(body.reason) ?? 'manual',
        at: deps.clock.now().toISOString(),
      });
      return sendJson(res, 201, entry);
    }
    if (method === 'DELETE' && seg[1] === 'ignore' && seg[2] && seg.length === 3) {
      await store.deleteIgnore(decodeURIComponent(seg[2]));
      return sendJson(res, 200, { ok: true, id: decodeURIComponent(seg[2]) });
    }

    // --- domain exclusion (outbound do-not-contact) CRUD ---
    if (method === 'GET' && seg[1] === 'exclusions' && seg.length === 2) {
      return sendJson(res, 200, await store.listDomainExclusions());
    }
    if (method === 'POST' && seg[1] === 'exclusions' && seg.length === 2) {
      const body = (await readJsonBody(req)) as Record<string, unknown>;
      const domain = normalizeDomain(str(body.domain) ?? '');
      if (!domain) return sendJson(res, 400, { error: 'domain is required' });
      const entry = await store.putDomainExclusion({
        id: domain,
        domain,
        reason: 'manual', // user-added exclusions are manual (auto ones come from declines)
        at: deps.clock.now().toISOString(),
      });
      return sendJson(res, 201, entry);
    }
    if (method === 'DELETE' && seg[1] === 'exclusions' && seg[2] && seg.length === 3) {
      const domain = normalizeDomain(decodeURIComponent(seg[2]));
      await store.deleteDomainExclusion(domain);
      return sendJson(res, 200, { ok: true, domain });
    }

    // POST /api/run/send | /api/run/poll
    if (method === 'POST' && seg[1] === 'run' && seg[2]) {
      if (seg[2] === 'send') return sendJson(res, 200, await deps.runSend());
      if (seg[2] === 'poll') return sendJson(res, 200, await deps.runPoll());
      if (seg[2] === 'fetch') return sendJson(res, 200, await deps.runFetch());
    }

    // GET /api/oauth/start?accountId=xxx
    // Returns { authUrl } — the caller should open it in a browser.
    if (method === 'GET' && seg[1] === 'oauth' && seg[2] === 'start') {
      if (!deps.gmailOAuth) return sendJson(res, 503, { error: 'Google OAuth not configured' });
      const accountId = url.searchParams.get('accountId');
      if (!accountId) return sendJson(res, 400, { error: 'accountId required' });
      const account = await store.getAccount(accountId);
      if (!account) return sendJson(res, 404, { error: 'account not found' });
      const redirectUri = oauthRedirectUri(req);
      const authUrl = deps.gmailOAuth.getAuthUrl(accountId, redirectUri);
      return sendJson(res, 200, { authUrl });
    }

    // GET /api/oauth/callback?code=xxx&state=accountId
    // Google redirects here after the user approves. Exchanges code for tokens,
    // saves them on the account, and responds with a self-closing HTML page.
    if (method === 'GET' && seg[1] === 'oauth' && seg[2] === 'callback') {
      if (!deps.gmailOAuth) return sendJson(res, 503, { error: 'Google OAuth not configured' });
      const code = url.searchParams.get('code');
      const accountId = url.searchParams.get('state');
      if (!code || !accountId) return sendJson(res, 400, { error: 'code and state required' });
      try {
        const redirectUri = oauthRedirectUri(req);
        await deps.gmailOAuth.handleCallback(code, accountId, redirectUri);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(
          '<!DOCTYPE html><html><body style="font-family:sans-serif;padding:2rem">' +
          '<h2>Gmail connected ✓</h2>' +
          '<p>You can close this tab and return to AdScout.</p>' +
          '<script>setTimeout(()=>window.close(),2000)</script>' +
          '</body></html>',
        );
      } catch (err) {
        return sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }

    // GET /api/stream — SSE
    if (method === 'GET' && seg[1] === 'stream' && seg.length === 2) {
      return sse(deps, req, res);
    }

    return sendJson(res, 404, { error: 'not found' });
  }

  // ---- static UI ----
  if (method === 'GET') {
    return serveStatic(webDir, url.pathname, res);
  }
  return sendJson(res, 404, { error: 'not found' });
}

function sse(deps: ServerDeps, req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });
  // Subscribe BEFORE announcing connected, so a client that has seen the
  // ': connected' line is guaranteed to be receiving change events.
  const unsubscribe = deps.store.subscribe((ev) => {
    res.write(`event: change\ndata: ${JSON.stringify(ev)}\n\n`);
  });
  res.write(': connected\n\n');
  const heartbeat = setInterval(() => res.write(': hb\n\n'), 25_000);
  (heartbeat as { unref?: () => void }).unref?.();
  const cleanup = () => {
    clearInterval(heartbeat);
    unsubscribe();
  };
  req.on('close', cleanup);
  res.on('close', cleanup);
}

async function serveStatic(webDir: string, pathname: string, res: ServerResponse): Promise<void> {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  // Guard against path traversal: the normalized join must stay under webDir.
  const full = normalize(join(webDir, rel));
  const base = normalize(webDir);
  if (!full.startsWith(base)) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }
  try {
    const data = await readFile(full);
    res.writeHead(200, { 'Content-Type': MIME[extname(full)] ?? 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  }
}
