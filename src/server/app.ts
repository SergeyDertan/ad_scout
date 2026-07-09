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
//   GET    /api/targets?status=&campaignId=
//   POST   /api/targets                 { websiteUrl, contactEmail, campaignId?, contactName?, notes? }
//   DELETE /api/targets/:id
//   GET    /api/responses?campaignId=
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
  CanPost,
  Campaign,
  ProviderType,
  Target,
  TargetStatus,
} from '../domain/types';
import { allNiches, categorizeTopic } from '../domain/niches';
import { assembleResult, type RawExtraction, type RawOffer } from '../domain/extraction';
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
        const hasPrice =
          offers.some((o) => o.price?.amount != null) ||
          Object.values(r.fields ?? {}).some((f) => f?.type === 'price' && f.amount != null);
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

    // GET /api/campaigns
    if (method === 'GET' && seg[1] === 'campaigns' && seg.length === 2) {
      return sendJson(res, 200, await store.listCampaigns());
    }

    // PATCH /api/campaigns/:id — update name, advertised, topic, format, inquiryFields
    if (method === 'PATCH' && seg[1] === 'campaigns' && seg[2] && seg.length === 3) {
      const campaign = await store.getCampaign(seg[2]);
      if (!campaign) return sendJson(res, 404, { error: 'campaign not found' });
      const body = (await readJsonBody(req)) as Record<string, unknown>;
      const updated = { ...campaign };
      if (str(body.name)) updated.name = str(body.name)!;
      if (str(body.topic) !== undefined) updated.topic = str(body.topic) ?? '';
      if (str(body.format) !== undefined) updated.format = str(body.format) ?? '';
      if (body.advertised && typeof body.advertised === 'object') {
        const adv = body.advertised as Record<string, unknown>;
        updated.advertised = {
          url: str(adv.url) ?? updated.advertised.url,
          description: str(adv.description) ?? updated.advertised.description,
        };
      }
      if (Array.isArray(body.inquiryFields)) {
        updated.inquiryFields = body.inquiryFields as never;
      }
      return sendJson(res, 200, await store.putCampaign(updated));
    }

    // DELETE /api/campaigns/:id
    if (method === 'DELETE' && seg[1] === 'campaigns' && seg[2] && seg.length === 3) {
      const campaign = await store.getCampaign(seg[2]);
      if (!campaign) return sendJson(res, 404, { error: 'campaign not found' });
      await store.deleteCampaign(campaign.id);
      return sendJson(res, 200, { ok: true, id: campaign.id });
    }

    // POST /api/campaigns/:id/preview — render email for a hypothetical target
    if (method === 'POST' && seg[1] === 'campaigns' && seg[2] && seg[3] === 'preview') {
      const campaign = await store.getCampaign(seg[2]);
      if (!campaign) return sendJson(res, 404, { error: 'campaign not found' });
      const body = (await readJsonBody(req)) as Record<string, unknown>;
      const websiteUrl = str(body.websiteUrl) ?? 'example.com';
      const accounts = await store.listAccounts();
      const account = accounts.find((a) => a.status === 'active') ?? accounts[0];
      if (!account) return sendJson(res, 400, { error: 'no accounts configured' });
      const fakeTarget: Target = {
        id: 'preview',
        campaignId: campaign.id,
        websiteUrl,
        contactEmail: str(body.contactEmail) ?? `contact@${websiteUrl}`,
        contactName: str(body.contactName),
        notes: str(body.notes),
        status: 'pending',
        followUpCount: 0,
        createdAt: deps.clock.now().toISOString(),
      };
      const draft = draftEmail(campaign, account, fakeTarget);
      return sendJson(res, 200, {
        subject: draft.subject,
        body: draft.body,
        senderName: account.senderName,
        senderEmail: account.email,
      });
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
      return sendJson(res, 200, (await store.listAccounts()).map(sanitizeAccount));
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

    // GET /api/targets?status=&campaignId=
    if (method === 'GET' && seg[1] === 'targets' && seg.length === 2) {
      const status = url.searchParams.get('status') as TargetStatus | null;
      const campaignId = url.searchParams.get('campaignId') ?? undefined;
      return sendJson(res, 200, await store.listTargets(
        (status || campaignId) ? { ...(status ? { status } : {}), ...(campaignId ? { campaignId } : {}) } : undefined
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

    // DELETE /api/replies/:id
    if (method === 'DELETE' && seg[1] === 'replies' && seg[2] && seg.length === 3) {
      await store.deleteReply(seg[2]);
      return sendJson(res, 200, { ok: true, id: seg[2] });
    }

    // PATCH /api/replies/:id — human correction of the AI extraction.
    // Body: { offers: [{ category, label?, sensitive?, canPost, priceRaw }], optOut? }
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
            return {
              category,
              label: str(off.label) ?? category,
              sensitive: Boolean(off.sensitive),
              canPost: (str(off.canPost) as CanPost) ?? 'maybe',
              priceRaw: typeof off.priceRaw === 'string' ? off.priceRaw : '',
            };
          }).filter((o) => o.category)
        : [];

      const target = reply.targetId ? await store.getTarget(reply.targetId) : undefined;
      const campaign = target ? await store.getCampaign(target.campaignId) : undefined;
      const niches = allNiches(await store.listNiches());
      // Preserve the AI's prose/field answers; only the offers + optOut are edited.
      const raw: RawExtraction = {
        optOut: Boolean(body.optOut),
        offers: rawOffers,
        reasoning: reply.parsed?.reasoning ?? 'Edited by hand.',
        ...(reply.parsed?.conditions ? { conditions: reply.parsed.conditions } : {}),
        ...(reply.parsed?.notes ? { notes: reply.parsed.notes } : {}),
        fields: Object.fromEntries(
          Object.entries(reply.parsed?.fields ?? {}).map(([k, v]) => [
            k,
            { raw: typeof (v as { raw?: unknown })?.raw === 'string' ? (v as { raw: string }).raw : '' },
          ]),
        ),
      };
      const requestedCategory = campaign ? categorizeTopic(campaign.topic, niches) : undefined;
      const { result, discovered } = assembleResult(campaign?.inquiryFields ?? [], raw, {
        niches,
        ...(requestedCategory ? { requestedCategory } : {}),
      });
      for (const n of discovered) {
        await store.putNiche({ ...n, createdAt: n.createdAt ?? deps.clock.now().toISOString() });
      }

      reply.parsed = result;
      reply.review = undefined; // corrected by a human
      reply.extractionStatus = 'done';
      await store.putReply(reply);
      if (target) {
        await store.updateTarget(target.id, (t) => ({
          ...t,
          status: result.optOut ? 'excluded' : 'replied',
          result,
        }));
      }
      return sendJson(res, 200, reply);
    }

    // GET /api/responses?campaignId= — replies + parsed result, enriched with target website + campaign
    if (method === 'GET' && seg[1] === 'responses' && seg.length === 2) {
      const campaignId = url.searchParams.get('campaignId') ?? undefined;
      const replies = await store.listReplies();
      const targets = new Map((await store.listTargets()).map((t) => [t.id, t]));
      const campaigns = new Map((await store.listCampaigns()).map((c) => [c.id, c.name]));
      let out = replies.map((r) => {
        const target = r.targetId ? targets.get(r.targetId) : undefined;
        return {
          ...r,
          website: target?.websiteUrl,
          campaignId: target?.campaignId,
          campaignName: target?.campaignId ? campaigns.get(target.campaignId) : undefined,
        };
      });
      if (campaignId) out = out.filter((r) => r.campaignId === campaignId);
      return sendJson(res, 200, out);
    }

    // GET /api/suppressions
    if (method === 'GET' && seg[1] === 'suppressions' && seg.length === 2) {
      return sendJson(res, 200, await store.listSuppressions());
    }

    // GET /api/niches — seed + learned post-category registry (drives the response filter)
    if (method === 'GET' && seg[1] === 'niches' && seg.length === 2) {
      return sendJson(res, 200, allNiches(await store.listNiches()));
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
