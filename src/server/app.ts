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
//   GET    /api/deals                    → deals + derived domains/paid/live counts
//   POST   /api/deals                    { counterpartyEmail, accountId, threadIds?, domains?, note? }
//   GET    /api/deals/:id                → { deal, placements, domains, threadIds, timeline }
//   PATCH  /api/deals/:id                { status?, closedReason?, note? }
//   DELETE /api/deals/:id                (releases its threads; keeps the messages)
//   POST   /api/deals/:id/threads        { threadId | threadIds }
//   POST   /api/deals/:id/placements     { domain | domains }
//   POST   /api/deals/:id/messages       { body, subject?, threadId? } → sends, holds the thread
//                                        (subject defaults to Re: the thread's own)
//   PATCH  /api/placements/:id           { contentText?, contentUrl?, agreedPrice?, paidAt?, ... }
//   DELETE /api/placements/:id
//   POST   /api/run/send | /api/run/poll | /api/run/fetch
//   GET    /api/stream                  (Server-Sent Events: store change feed)
//   GET    /*                           (static web UI)

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { authEnabled, createAuthenticator, loadAuthConfig, mayAccess, type AuthResult } from './auth';
import { Mutex } from '../lib/mutex';
import { readFile } from 'node:fs/promises';
import { extname, normalize, join } from 'node:path';
import type { Config } from '../config';
import type { GmailOAuthHandler } from '../adapters/email/gmail-api.provider';
import type {
  Account,
  AccountStatus,
  Batch,
  CanPost,
  DealStatus,
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
import { accountSendState } from '../domain/account-state';
import { accountStats } from '../domain/account-stats';
import { engagementOf, outcomesOf } from '../domain/engagement';
import { assembleResult, parsePrice, type RawExtraction, type RawOffer } from '../domain/extraction';
import { resolveProfile } from '../domain/pitch';
import {
  buildBatchRows,
  buildDomainDetail,
  buildDomainRows,
  buildReplyDebug,
  buildResponseRows,
} from '../services/read-models';
import type { Clock } from '../lib/clock';
import { newId } from '../lib/ids';
import { draftEmail } from '../services/drafter';
import { logger } from '../lib/logger';
import type { EmailProvider } from '../ports/email-provider';
import type { Store } from '../ports/store';
import { dealTimeline, MissingSubjectError, sendDealMessage } from '../pipeline/deal-send';
import {
  addDomains,
  attachThreads,
  DealTransitionError,
  openDeal,
  setDealStatus,
  updatePlacement,
} from '../pipeline/deal-ops';
import { dealDomains } from '../domain/deals';
import { isWithinSendWindow } from '../scheduler/window';

export interface ServerDeps {
  store: Store;
  config: Config;
  clock: Clock;
  /** Manual "Run now" — a full send pass. */
  runSend: (opts?: { signal?: AbortSignal; onProgress?: (current: number, total: number) => void }) => Promise<unknown>;
  /** Manual "Run now" — a poll pass. */
  runPoll: (opts?: { signal?: AbortSignal; onProgress?: (current: number, total: number) => void }) => Promise<unknown>;
  /** Manual "Run now" — fetch only (no AI extraction). */
  runFetch: (opts?: { signal?: AbortSignal; onProgress?: (current: number, total: number) => void }) => Promise<unknown>;
  /** Directory of static UI assets. Default ./web */
  webDir?: string;
  /** Names of the wired providers, for /api/status. */
  providers?: { llm: string; email: string; store: string };
  /** Present when Google OAuth is configured — drives /api/oauth/* endpoints. */
  gmailOAuth?: GmailOAuthHandler;
  /** The email provider, for sending deal messages from the Deals UI. Absent in
   *  tests that never post one; those routes then answer 503. */
  email?: EmailProvider;
  /**
   * Serializes this server's multi-document writes. Pass the SAME Mutex the
   * pipeline passes use (`passLock` in serve.ts): a hand-edit in the dashboard
   * and an incoming poll/hub result otherwise interleave, and routes like
   * `PATCH /api/replies/:id` write four documents in sequence — leaving the
   * reply edited but its target still carrying the old result.
   *
   * Omitted ⇒ a private Mutex, which still serializes this server against
   * itself. That is the right default for tests and for any embedding that has
   * no pipeline of its own.
   */
  writeLock?: Mutex;
  /** Per-request Google ID-token check. Built from ADMIN_EMAILS when omitted;
   *  injected directly by tests. Absent + no ADMIN_EMAILS ⇒ the API is open,
   *  which is the local-development case. See server/auth.ts. */
  authenticate?: (req: IncomingMessage) => Promise<AuthResult>;
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

  // Auth is opt-in via ADMIN_EMAILS (see server/auth.ts). Resolve it once here so
  // a misconfiguration — an allowlist with no project id — fails at boot rather
  // than on the first request from someone locked out with no way to tell why.
  const authConfig = deps.authenticate ? null : authEnabled() ? loadAuthConfig() : null;
  const authenticate = deps.authenticate ?? (authConfig ? createAuthenticator(authConfig) : undefined);
  if (authenticate) {
    logger.info('API authentication ENABLED — a verified Google account on an allowlist is required', {
      ...(authConfig ? { admins: authConfig.adminEmails.size, managers: authConfig.managerEmails.size } : {}),
    });
  } else {
    logger.warn('API authentication is OFF (ADMIN_EMAILS unset) — do not expose this port publicly');
  }
  const guarded: ResolvedDeps = {
    ...deps,
    ...(authenticate ? { authenticate } : {}),
    writeLock: deps.writeLock ?? new Mutex(),
  };

  const server = createServer((req, res) => {
    handle(guarded, webDir, req, res).catch((err) => {
      logger.error('request handler crashed', { error: String(err) });
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
    });
  });
  return server;
}

/** ServerDeps after createApiServer has filled in the defaults it guarantees. */
type ResolvedDeps = ServerDeps & { writeLock: Mutex };

async function handle(
  deps: ResolvedDeps,
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
      // Authorization, or the browser rejects every authenticated call at
      // preflight and the failure looks like CORS rather than auth.
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    });
    res.end();
    return;
  }

  // ---- API ----
  if (seg[0] === 'api') {
    // GET /api/auth — PUBLIC, and deliberately so. It answers one question:
    // "does this instance require sign-in?" The front end has to know that
    // before it can decide whether to show a sign-in screen, and it cannot ask
    // an endpoint that needs the token it does not have yet. Leaking the answer
    // costs nothing — a 401 from any other route reveals the same thing — and it
    // is what lets ONE build serve both the open local console and the gated VPS.
    if (method === 'GET' && seg[1] === 'auth' && seg.length === 2) {
      if (!deps.authenticate) return sendJson(res, 200, { required: false });
      // With a token present, also report WHO you are and WHAT you may do, so
      // the console can hide controls that would only 403. Without one it still
      // answers 200 — that is the point of the route.
      const who = await deps.authenticate(req);
      return sendJson(
        res,
        200,
        who.ok ? { required: true, email: who.identity.email, role: who.identity.role } : { required: true },
      );
    }

    // Everything else under /api is gated once ADMIN_EMAILS is configured, with
    // one structural exemption: Google redirects the BROWSER to
    // /api/oauth/callback, so that request cannot carry an Authorization header.
    // It is not a hole — the route is useless without a valid authorization
    // `code` minted by Google for this OAuth client and redirect URI, which an
    // attacker cannot forge. (/api/oauth/start is a normal fetch and stays gated.)
    const isOAuthCallback = seg[1] === 'oauth' && seg[2] === 'callback';
    if (deps.authenticate && !isOAuthCallback) {
      const result = await deps.authenticate(req);
      if (!result.ok) return sendJson(res, result.status, { error: result.error });
      // Authentication said who; authorization says what. A manager reads
      // everything and runs deals, but must not reach mailboxes, imports or a
      // send pass — see mayAccess() for the rule and why it is default-deny.
      if (!mayAccess(result.identity.role, method, seg)) {
        logger.warn('role refused a route', {
          email: result.identity.email,
          role: result.identity.role,
          method,
          path: url.pathname,
        });
        return sendJson(res, 403, { error: `your role (${result.identity.role}) cannot do that` });
      }
    }

    // GET /api/status
    if (method === 'GET' && seg[1] === 'status' && seg.length === 2) {
      const batchId = url.searchParams.get('batchId') || undefined;
      const targets = await store.listTargets(batchId ? { batchId } : undefined);
      const byStatus: Record<string, number> = {};
      for (const t of targets) byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;

      // Engagement + commercial outcomes over every target in scope. The same
      // two functions build the per-account rollup on GET /api/accounts, so the
      // parts always add back up to this whole.
      const replies = await store.listReplies();
      const repliedTargetIds = new Set(replies.map((r) => r.targetId).filter(Boolean) as ID[]);
      const engagement = engagementOf(targets, repliedTargetIds);
      const outcomes = outcomesOf(targets);

      // Replies awaiting AI extraction (queued by fetch-only or failed earlier).
      const pendingExtraction = replies.filter(
        (r) => r.extractionStatus === 'pending' || r.extractionStatus === 'failed',
      ).length;

      const now = deps.clock.now();
      return sendJson(res, 200, {
        ok: true,
        time: now.toISOString(),
        accounts: (await store.listAccounts()).length,
        targets: { total: targets.length, byStatus },
        engagement,
        outcomes,
        pendingExtraction,
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

    // GET /api/accounts — each account enriched with two derived rollups:
    // `state` (live: sent today, current cap, remaining, drip rate) and `stats`
    // (lifetime: volume sent, targets contacted, the engagement funnel and
    // outcomes for the targets this mailbox owns). Both come from the Outreach
    // log + target/reply records, so neither can drift from a stored counter.
    if (method === 'GET' && seg[1] === 'accounts' && seg.length === 2) {
      const now = deps.clock.now();
      const accounts = await store.listAccounts();
      const outreaches = await store.listOutreaches();
      const targets = await store.listTargets();
      const repliedTargetIds = new Set(
        (await store.listReplies()).map((r) => r.targetId).filter(Boolean) as ID[],
      );
      return sendJson(
        res,
        200,
        accounts.map((a) => ({
          ...sanitizeAccount(a),
          state: accountSendState(a, outreaches, now, deps.config.sendWindow, deps.config.warmup),
          stats: accountStats(a, outreaches, targets, repliedTargetIds),
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
      // Which mailbox each side of the conversation used. Without this the UI can
      // show the publisher's address but not our own, and with several sending
      // accounts there is no way to tell which one they actually replied to.
      const accountEmails: Record<string, string> = {};
      for (const a of await store.listAccounts()) accountEmails[a.id] = a.email;
      return sendJson(res, 200, { target, outreaches, replies, accountEmails });
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
      return sendJson(res, 200, await buildBatchRows(store));
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
      return sendJson(res, 200, await buildReplyDebug(store, reply));
    }

    // DELETE /api/replies/:id
    if (method === 'DELETE' && seg[1] === 'replies' && seg[2] && seg.length === 3) {
      const id = seg[2];
      // Under the lock: a pass holding this reply mid-sequence would otherwise
      // re-create it by writing the copy it is still working from.
      await deps.writeLock.run(() => store.deleteReply(id));
      return sendJson(res, 200, { ok: true, id });
    }

    // PATCH /api/replies/:id — human correction of the AI extraction.
    // Body: { offers: [{ category, label?, sensitive?, canPost, priceRaw,
    //                    website?, isSpecial?, specialUntil? }], optOut? }
    // Rebuilt through assembleResult so price parsing / niche reconciliation /
    // canPost summary match a normal extraction. Clears the `review` flag.
    if (method === 'PATCH' && seg[1] === 'replies' && seg[2] && seg.length === 3) {
      const id = seg[2];
      // Read the request body BEFORE taking the lock: it is client I/O, and a
      // slow client must not hold the store lock while it dribbles bytes in.
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

      // ONE critical section, under the same lock the pipeline passes and the
      // extraction hub hold. This route writes four kinds of document — niches,
      // the reply, its target, price records — and a poll pass or an incoming
      // hub result landing between them would leave the reply edited while its
      // target still carries the previous result. remote-hub.ts wraps the
      // mirror-image operation (persist an extraction) in exactly this lock.
      //
      // The reply is re-read INSIDE the lock so the edit lands on whatever is
      // current, not on a copy read before waiting for our turn.
      const saved = await deps.writeLock.run(async () => {
        const reply = (await store.listReplies()).find((r) => r.id === id);
        if (!reply) return undefined;

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
        return reply;
      });
      if (!saved) return sendJson(res, 404, { error: 'reply not found' });
      return sendJson(res, 200, saved);
    }

    // GET /api/responses?batchId= — replies + parsed result, enriched with target
    // website + batch + the mailbox of OURS the reply landed in.
    if (method === 'GET' && seg[1] === 'responses' && seg.length === 2) {
      const batchId = url.searchParams.get('batchId') ?? undefined;
      return sendJson(res, 200, await buildResponseRows(store, batchId));
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
      return sendJson(res, 200, await buildDomainRows(store, deps.clock.now()));
    }

    // GET /api/domains/:domain — full price sheet + raw history + exclusion state
    if (method === 'GET' && seg[1] === 'domains' && seg[2] && seg.length === 3) {
      const detail = await buildDomainDetail(store, decodeURIComponent(seg[2]), deps.clock.now());
      return sendJson(res, 200, detail);
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

    // --- deals (human-operated negotiations) ---
    //
    // Everything under here is deliberately dumb: it moves fields a person typed.
    // No extraction, no inference, and in particular a placement's agreedPrice
    // never becomes a PriceRecord — a negotiated figure must not rewrite the
    // publisher's standing rate (see domain/types.ts `Placement`).

    // GET /api/deals — the list, each with its derived domains and counts.
    if (method === 'GET' && seg[1] === 'deals' && seg.length === 2) {
      const deals = await store.listDeals();
      const accountEmails = new Map((await store.listAccounts()).map((a) => [a.id, a.email]));
      const rows = [];
      for (const deal of deals) {
        const placements = await store.listPlacements({ dealId: deal.id });
        rows.push({
          ...deal,
          accountEmail: accountEmails.get(deal.accountId),
          domains: dealDomains(placements),
          placementCount: placements.length,
          paidCount: placements.filter((p) => p.paidAt).length,
          liveCount: placements.filter((p) => p.liveAt ?? p.publishedUrl).length,
        });
      }
      rows.sort((a, b) => b.openedAt.localeCompare(a.openedAt));
      return sendJson(res, 200, rows);
    }

    // POST /api/deals — open one. Idempotent per open thread (see openDeal).
    if (method === 'POST' && seg[1] === 'deals' && seg.length === 2) {
      const body = (await readJsonBody(req)) as Record<string, unknown>;
      const counterpartyEmail = normalizeEmail(str(body.counterpartyEmail) ?? '');
      const accountId = str(body.accountId);
      if (!counterpartyEmail) return sendJson(res, 400, { error: 'counterpartyEmail is required' });
      if (!accountId) return sendJson(res, 400, { error: 'accountId is required' });
      if (!(await store.getAccount(accountId))) {
        return sendJson(res, 404, { error: 'account not found' });
      }
      const deal = await openDeal(store, deps.clock, {
        counterpartyEmail,
        accountId,
        ...(Array.isArray(body.threadIds) ? { threadIds: body.threadIds.map(String) } : {}),
        ...(Array.isArray(body.domains) ? { domains: body.domains.map(String) } : {}),
        ...(str(body.note) ? { note: str(body.note)! } : {}),
      });
      return sendJson(res, 201, deal);
    }

    // GET /api/deals/:id — the deal, its placements, and its full message timeline.
    if (method === 'GET' && seg[1] === 'deals' && seg[2] && seg.length === 3) {
      const deal = await store.getDeal(seg[2]);
      if (!deal) return sendJson(res, 404, { error: 'deal not found' });
      const placements = await store.listPlacements({ dealId: deal.id });
      const dealAccount = await store.getAccount(deal.accountId);
      return sendJson(res, 200, {
        deal,
        accountEmail: dealAccount?.email,
        placements: placements.sort((a, b) => a.domain.localeCompare(b.domain)),
        domains: dealDomains(placements),
        threadIds: (await store.listThreadLinks({ dealId: deal.id })).map((l) => l.threadId),
        timeline: await dealTimeline(store, deal.id),
      });
    }

    // PATCH /api/deals/:id — status, note. Status moves are validated.
    if (method === 'PATCH' && seg[1] === 'deals' && seg[2] && seg.length === 3) {
      const body = (await readJsonBody(req)) as Record<string, unknown>;
      const dealId = seg[2];
      // A status move and a note edit are two writes derived from one read.
      const outcome = await deps.writeLock.run(async () => {
        const existing = await store.getDeal(dealId);
        if (!existing) return { ok: false as const, status: 404, error: 'deal not found' };

        let deal = existing;
        const status = str(body.status);
        if (status && status !== existing.status) {
          try {
            deal = await setDealStatus(
              store, deps.clock, existing.id, status as DealStatus, str(body.closedReason),
            );
          } catch (err) {
            if (err instanceof DealTransitionError) {
              return { ok: false as const, status: 400, error: err.message };
            }
            throw err;
          }
        }
        if (body.note !== undefined) {
          const note = str(body.note);
          const { note: _drop, ...rest } = deal;
          deal = await store.putDeal({ ...rest, ...(note ? { note } : {}) });
        }
        return { ok: true as const, deal };
      });
      if (!outcome.ok) return sendJson(res, outcome.status, { error: outcome.error });
      return sendJson(res, 200, outcome.deal);
    }

    // DELETE /api/deals/:id — remove the deal, its placements and its links.
    // Deleting RELEASES every thread it held; the messages themselves are kept.
    if (method === 'DELETE' && seg[1] === 'deals' && seg[2] && seg.length === 3) {
      const dealId = seg[2];
      // Placements, thread links and the deal itself must go together — a reader
      // must never see a deal whose placements are half-deleted.
      const removed = await deps.writeLock.run(async () => {
        const deal = await store.getDeal(dealId);
        if (!deal) return undefined;
        for (const p of await store.listPlacements({ dealId: deal.id })) {
          await store.deletePlacement(p.id);
        }
        for (const l of await store.listThreadLinks({ dealId: deal.id })) {
          await store.deleteThreadLink(l.threadId);
        }
        await store.deleteDeal(deal.id);
        return deal.id;
      });
      if (!removed) return sendJson(res, 404, { error: 'deal not found' });
      return sendJson(res, 200, { ok: true, id: removed });
    }

    // POST /api/deals/:id/threads — attach an existing conversation to the deal.
    if (method === 'POST' && seg[1] === 'deals' && seg[2] && seg[3] === 'threads') {
      const body = (await readJsonBody(req)) as Record<string, unknown>;
      const threadIds = Array.isArray(body.threadIds)
        ? body.threadIds.map(String)
        : [str(body.threadId) ?? ''].filter(Boolean);
      if (threadIds.length === 0) return sendJson(res, 400, { error: 'threadId(s) required' });
      const dealId = seg[2];
      const attached = await deps.writeLock.run(async () => {
        if (!(await store.getDeal(dealId))) return false;
        await attachThreads(store, dealId, threadIds);
        return true;
      });
      if (!attached) return sendJson(res, 404, { error: 'deal not found' });
      return sendJson(res, 200, { ok: true, threadIds });
    }

    // POST /api/deals/:id/placements — add domains as draft placements.
    if (method === 'POST' && seg[1] === 'deals' && seg[2] && seg[3] === 'placements') {
      const body = (await readJsonBody(req)) as Record<string, unknown>;
      const domains = Array.isArray(body.domains)
        ? body.domains.map(String)
        : [str(body.domain) ?? ''].filter(Boolean);
      if (domains.length === 0) return sendJson(res, 400, { error: 'domain(s) required' });
      const dealId = seg[2];
      const added = await deps.writeLock.run(async () => {
        if (!(await store.getDeal(dealId))) return undefined;
        return addDomains(store, dealId, domains);
      });
      if (!added) return sendJson(res, 404, { error: 'deal not found' });
      return sendJson(res, 201, added);
    }

    // POST /api/deals/:id/messages — write into the conversation.
    //
    // DELIBERATELY NOT under writeLock. sendDealMessage sends the mail and
    // records it in one call, so holding the lock across it would hold it across
    // an SMTP/Gmail round-trip — stalling the scheduler and every hub result
    // behind network latency. remote-hub.ts applies its Gmail label outside the
    // lock for exactly this reason.
    //
    // Safe to leave out: the documents it writes (an Outreach and a ThreadLink)
    // are deal-scoped, and no pipeline pass writes them concurrently. Splitting
    // the send from the write is the fix if that ever stops being true.
    if (method === 'POST' && seg[1] === 'deals' && seg[2] && seg[3] === 'messages') {
      if (!deps.email) return sendJson(res, 503, { error: 'no email provider wired' });
      const body = (await readJsonBody(req)) as Record<string, unknown>;
      // The subject is derived from the thread being answered, not sent by the
      // client — see replySubject. It is only accepted (and only needed) for the
      // first message on a deal that has no conversation yet.
      const subject = str(body.subject);
      const text = str(body.body);
      if (!text) return sendJson(res, 400, { error: 'body is required' });
      if (!(await store.getDeal(seg[2]))) return sendJson(res, 404, { error: 'deal not found' });
      try {
        const sent = await sendDealMessage(
          { store, email: deps.email, clock: deps.clock },
          {
            dealId: seg[2],
            ...(subject ? { subject } : {}),
            body: text,
            ...(str(body.threadId) ? { threadId: str(body.threadId)! } : {}),
          },
        );
        return sendJson(res, 201, sent);
      } catch (err) {
        // Nothing was sent and nothing recorded — the caller must name a subject.
        if (err instanceof MissingSubjectError) return sendJson(res, 400, { error: err.message });
        // The Outreach is already recorded as 'failed' — report, don't swallow.
        return sendJson(res, 502, { error: err instanceof Error ? err.message : String(err) });
      }
    }

    // PATCH /api/placements/:id — content, price, paid, published.
    if (method === 'PATCH' && seg[1] === 'placements' && seg[2] && seg.length === 3) {
      const body = (await readJsonBody(req)) as Record<string, unknown>;
      const placementId = seg[2];
      const patch: Record<string, unknown> = {};
      for (const field of [
        'contentText', 'contentUrl', 'publishedUrl', 'paymentMethod',
        'paidAt', 'liveAt', 'note',
      ]) {
        if (body[field] !== undefined) patch[field] = str(body[field]) || undefined;
      }
      // agreedPrice is stored as a PriceValue so it formats like every other
      // amount. `raw` keeps exactly what was typed.
      if (body.agreedPrice !== undefined) {
        const raw = str(body.agreedPrice);
        patch.agreedPrice = raw ? parsePrice(raw) : undefined;
      }
      // Existence check and update are one section: updatePlacement reads the
      // placement again to merge the patch.
      const updated = await deps.writeLock.run(async () => {
        if (!(await store.getPlacement(placementId))) return undefined;
        return updatePlacement(store, placementId, patch);
      });
      if (!updated) return sendJson(res, 404, { error: 'placement not found' });
      return sendJson(res, 200, updated);
    }

    // DELETE /api/placements/:id
    if (method === 'DELETE' && seg[1] === 'placements' && seg[2] && seg.length === 3) {
      const id = seg[2];
      await deps.writeLock.run(() => store.deletePlacement(id));
      return sendJson(res, 200, { ok: true, id });
    }

    // POST /api/run/send | /api/run/poll | /api/run/fetch — SSE progress stream
    if (method === 'POST' && seg[1] === 'run' && seg[2]) {
      const runFn =
        seg[2] === 'send' ? deps.runSend :
        seg[2] === 'poll' ? deps.runPoll :
        seg[2] === 'fetch' ? deps.runFetch :
        null;
      if (runFn) return runPassSSE(res, req, runFn);
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

function runPassSSE(
  res: ServerResponse,
  req: IncomingMessage,
  runFn: (opts?: { signal?: AbortSignal; onProgress?: (current: number, total: number) => void }) => Promise<unknown>,
): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });
  const ac = new AbortController();
  const cleanup = () => ac.abort();
  req.on('close', cleanup);
  res.on('close', cleanup);

  const onProgress = (current: number, total: number) => {
    if (!res.writableEnded) {
      res.write(`event: progress\ndata: ${JSON.stringify({ current, total })}\n\n`);
    }
  };

  runFn({ signal: ac.signal, onProgress })
    .then((report) => {
      if (!res.writableEnded) {
        res.write(`event: done\ndata: ${JSON.stringify(report)}\n\n`);
        res.end();
      }
    })
    .catch((err) => {
      if (!res.writableEnded) {
        const msg = err instanceof Error ? err.message : String(err);
        res.write(`event: error\ndata: ${JSON.stringify({ error: msg })}\n\n`);
        res.end();
      }
    });
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
    // SPA fallback: the UI uses real paths (/deals/<id>), so a refresh or a
    // shared link asks the server for a file that was never built. Hand those
    // back index.html and let the client router resolve them. Only for
    // extension-less paths — a missing .js or .png is a genuine 404, and
    // answering it with HTML would turn a broken asset into a confusing parse
    // error instead of an honest one.
    if (!extname(full)) {
      try {
        const html = await readFile(join(base, 'index.html'));
        res.writeHead(200, { 'Content-Type': MIME['.html']! });
        res.end(html);
        return;
      } catch {
        /* no index.html to fall back to — fall through to the 404 */
      }
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  }
}
