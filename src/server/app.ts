// Local HTTP API + SSE, built on node:http (no dependency). Mirrors the Store
// port (overview.md §11) and serves the static web UI from `webDir`.
//
//   GET    /api/status
//   GET    /api/campaigns
//   POST   /api/campaigns               { name, advertised{url,description}, topic?, format?, inquiryFields? }
//   GET    /api/accounts
//   POST   /api/accounts                { email, senderName, credentialRef?, providerType?, maxDailyLimit?, signature?, status? }
//   PATCH  /api/accounts/:id            { dailyLimitOverride?, maxDailyLimit?, senderName?, signature? }
//   POST   /api/accounts/:id/pause | /resume
//   DELETE /api/accounts/:id
//   GET    /api/targets?status=
//   POST   /api/targets                 { websiteUrl, contactEmail, campaignId?, contactName?, notes? }
//   DELETE /api/targets/:id
//   GET    /api/responses
//   GET    /api/suppressions
//   POST   /api/run/send | /api/run/poll
//   GET    /api/stream                  (Server-Sent Events: store change feed)
//   GET    /*                           (static web UI)

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, normalize, join } from 'node:path';
import type { Config } from '../config';
import type {
  Account,
  AccountStatus,
  Campaign,
  ProviderType,
  Target,
  TargetStatus,
} from '../domain/types';
import type { Clock } from '../lib/clock';
import { newId } from '../lib/ids';
import { logger } from '../lib/logger';
import type { Store } from '../ports/store';

export interface ServerDeps {
  store: Store;
  config: Config;
  clock: Clock;
  /** Manual "Run now" — a full send pass. */
  runSend: () => Promise<unknown>;
  /** Manual "Run now" — a poll pass. */
  runPoll: () => Promise<unknown>;
  /** Directory of static UI assets. Default ./web */
  webDir?: string;
  /** Names of the wired providers, for /api/status. */
  providers?: { llm: string; email: string; store: string };
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
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
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

/** Default env-var NAME for a new account's secret (never the secret itself). */
function deriveCredentialRef(email: string): string {
  const local = email.split('@')[0] ?? email;
  const slug = local.replace(/[^a-zA-Z0-9]+/g, '_').toUpperCase();
  return `GMAIL_${slug}`;
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
      const targets = await store.listTargets();
      const byStatus: Record<string, number> = {};
      for (const t of targets) byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;
      return sendJson(res, 200, {
        ok: true,
        time: deps.clock.now().toISOString(),
        accounts: (await store.listAccounts()).length,
        targets: { total: targets.length, byStatus },
        providers: deps.providers ?? null,
      });
    }

    // GET /api/campaigns
    if (method === 'GET' && seg[1] === 'campaigns' && seg.length === 2) {
      return sendJson(res, 200, await store.listCampaigns());
    }

    // POST /api/campaigns — create a campaign (targets attach to one)
    if (method === 'POST' && seg[1] === 'campaigns' && seg.length === 2) {
      const body = (await readJsonBody(req)) as Record<string, unknown>;
      const name = str(body.name);
      const advertised = (body.advertised ?? {}) as Record<string, unknown>;
      const url = str(advertised.url);
      if (!name || !url) {
        return sendJson(res, 400, { error: 'name and advertised.url are required' });
      }
      const campaign: Campaign = {
        id: newId('campaign'),
        name,
        advertised: { url, description: str(advertised.description) ?? '' },
        topic: str(body.topic) ?? '',
        format: str(body.format) ?? 'article',
        inquiryFields: Array.isArray(body.inquiryFields) ? (body.inquiryFields as never) : [],
        createdAt: deps.clock.now().toISOString(),
      };
      return sendJson(res, 201, await store.putCampaign(campaign));
    }

    // GET /api/accounts
    if (method === 'GET' && seg[1] === 'accounts' && seg.length === 2) {
      return sendJson(res, 200, await store.listAccounts());
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
        status: (str(body.status) as AccountStatus) ?? 'warming',
        createdAt: deps.clock.now().toISOString(),
        maxDailyLimit,
      };
      return sendJson(res, 201, await store.putAccount(account));
    }

    // /api/accounts/:id ...
    if (seg[1] === 'accounts' && seg[2]) {
      const account = await store.getAccount(seg[2]);
      if (!account) return sendJson(res, 404, { error: 'account not found' });

      if (method === 'PATCH' && seg.length === 3) {
        const body = (await readJsonBody(req)) as Partial<Account>;
        const updated: Account = { ...account };
        if (typeof body.dailyLimitOverride === 'number')
          updated.dailyLimitOverride = body.dailyLimitOverride;
        if (typeof body.maxDailyLimit === 'number') updated.maxDailyLimit = body.maxDailyLimit;
        if (typeof body.senderName === 'string') updated.senderName = body.senderName;
        if (typeof body.signature === 'string') updated.signature = body.signature;
        return sendJson(res, 200, await store.putAccount(updated));
      }
      if (method === 'POST' && seg[3] === 'pause') {
        return sendJson(res, 200, await store.putAccount({ ...account, status: 'paused' }));
      }
      if (method === 'POST' && seg[3] === 'resume') {
        return sendJson(res, 200, await store.putAccount({ ...account, status: 'active' }));
      }
      if (method === 'DELETE' && seg.length === 3) {
        await store.deleteAccount(account.id);
        return sendJson(res, 200, { ok: true, id: account.id });
      }
    }

    // GET /api/targets?status=
    if (method === 'GET' && seg[1] === 'targets' && seg.length === 2) {
      const status = url.searchParams.get('status') as TargetStatus | null;
      return sendJson(res, 200, await store.listTargets(status ? { status } : undefined));
    }

    // POST /api/targets — queue a new outreach target
    if (method === 'POST' && seg[1] === 'targets' && seg.length === 2) {
      const body = (await readJsonBody(req)) as Record<string, unknown>;
      const websiteUrl = str(body.websiteUrl);
      const contactEmail = str(body.contactEmail);
      if (!websiteUrl || !contactEmail) {
        return sendJson(res, 400, { error: 'websiteUrl and contactEmail are required' });
      }
      // Resolve the campaign: explicit id, else the only/first campaign.
      let campaignId = str(body.campaignId);
      const campaigns = await store.listCampaigns();
      if (campaignId) {
        if (!campaigns.some((c) => c.id === campaignId)) {
          return sendJson(res, 400, { error: 'unknown campaignId' });
        }
      } else {
        campaignId = campaigns[0]?.id;
        if (!campaignId) {
          return sendJson(res, 400, { error: 'no campaign exists — create one first' });
        }
      }
      const target: Target = {
        id: newId('target'),
        campaignId,
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

    // DELETE /api/targets/:id
    if (method === 'DELETE' && seg[1] === 'targets' && seg[2] && seg.length === 3) {
      const target = await store.getTarget(seg[2]);
      if (!target) return sendJson(res, 404, { error: 'target not found' });
      await store.deleteTarget(target.id);
      return sendJson(res, 200, { ok: true, id: target.id });
    }

    // GET /api/responses — replies + parsed result, enriched with target website
    if (method === 'GET' && seg[1] === 'responses' && seg.length === 2) {
      const replies = await store.listReplies();
      const targets = new Map((await store.listTargets()).map((t) => [t.id, t]));
      const out = replies.map((r) => ({
        ...r,
        website: r.targetId ? targets.get(r.targetId)?.websiteUrl : undefined,
      }));
      return sendJson(res, 200, out);
    }

    // GET /api/suppressions
    if (method === 'GET' && seg[1] === 'suppressions' && seg.length === 2) {
      return sendJson(res, 200, await store.listSuppressions());
    }

    // POST /api/run/send | /api/run/poll
    if (method === 'POST' && seg[1] === 'run' && seg[2]) {
      if (seg[2] === 'send') return sendJson(res, 200, await deps.runSend());
      if (seg[2] === 'poll') return sendJson(res, 200, await deps.runPoll());
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
