// GmailApiProvider — sends and reads via the Gmail REST API (no SMTP/IMAP).
// Stores per-account OAuth tokens on Account.oauthTokens in the Store.
//
// One-time setup:
//  1. Google Cloud Console → enable Gmail API.
//  2. OAuth consent screen → External + Published (avoids 7-day refresh-token expiry).
//  3. Create "Desktop app" OAuth 2.0 Client → download client_secret.json to project root.
//  4. In the web UI, open an account → "Connect Gmail" to run the browser OAuth flow.
//
// Credentials are loaded automatically from client_secret.json (or via
// GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET env vars).

import { ALL_LABELS, LABEL_COLORS, type OutcomeLabel } from '../../domain/labels';
import type { Account, EmailAttachment } from '../../domain/types';
import {
  MAX_ATTACHMENT_BYTES,
  type EmailProvider,
  type IncomingEmail,
  type OutgoingEmail,
  type SendResult,
} from '../../ports/email-provider';
import type { Store } from '../../ports/store';

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';


// Bound every Gmail/OAuth HTTP call. Without this, a request that's mid-flight
// when the machine sleeps hangs on a dead socket until the OS tears it down —
// no error, no log, just a stalled pass. On timeout `fetch` rejects with a
// TimeoutError, which describeError surfaces as a clear, bounded failure.
const HTTP_TIMEOUT_MS = 30_000;

export interface GmailOAuthHandler {
  getAuthUrl(accountId: string, redirectUri: string): string;
  handleCallback(code: string, accountId: string, redirectUri: string): Promise<void>;
}

// Carries the HTTP status so callers can branch on it — notably a 404 from
// users.history means startHistoryId is older than Gmail's ~1-week retention and
// we must fall back to a full search-based resync.
class GmailHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'GmailHttpError';
  }
}

export class GmailApiProvider implements EmailProvider, GmailOAuthHandler {
  readonly name = 'gmail-api';
  readonly supportsThreadId = true;

  // accountId -> (managed label name -> resolved Gmail labelId). Loaded once per
  // account from labels.list, then labels are created lazily on first use. Ids
  // are stable for the mailbox's lifetime, so this avoids a round-trip per call.
  private readonly labelIdCache = new Map<string, Map<string, string>>();

  constructor(
    private readonly store: Store,
    private readonly clientId: string,
    private readonly clientSecret: string,
  ) {}

  // ----- OAuth flow ----------------------------------------------------------

  getAuthUrl(accountId: string, redirectUri: string): string {
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: [
        'https://www.googleapis.com/auth/gmail.send',
        // modify (not readonly) so we can label + mark-read the messages we keep.
        'https://www.googleapis.com/auth/gmail.modify',
      ].join(' '),
      access_type: 'offline',
      prompt: 'consent', // force refresh_token every time
      state: accountId,
    });
    return `${AUTH_URL}?${params}`;
  }

  async handleCallback(code: string, accountId: string, redirectUri: string): Promise<void> {
    const resp = await fetch(TOKEN_URL, {
      method: 'POST',
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: this.clientId,
        client_secret: this.clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
    });
    const data = (await resp.json()) as Record<string, unknown>;
    if (!resp.ok) {
      throw new Error(`OAuth exchange failed: ${data['error_description'] ?? data['error']}`);
    }
    if (typeof data['refresh_token'] !== 'string') {
      throw new Error('Google did not return a refresh_token — ensure prompt=consent was sent');
    }

    const account = await this.store.getAccount(accountId);
    if (!account) throw new Error(`Account ${accountId} not found`);

    await this.store.updateAccount(accountId, (current) => ({
      ...current,
      oauthTokens: {
        refreshToken: data['refresh_token'] as string,
        accessToken: data['access_token'] as string,
        accessTokenExpiresAt: new Date(
          Date.now() + Number(data['expires_in']) * 1000,
        ).toISOString(),
      },
    }));
  }

  // ----- Token management ----------------------------------------------------

  private async getAccessToken(account: Account): Promise<string> {
    const tokens = account.oauthTokens;
    if (!tokens?.refreshToken) {
      throw new Error(
        `No OAuth tokens for ${account.email} — visit /api/oauth/start?accountId=${account.id} to authorize`,
      );
    }

    // Use cached access token when not expired (60 s buffer).
    if (tokens.accessToken && tokens.accessTokenExpiresAt) {
      if (Date.now() + 60_000 < new Date(tokens.accessTokenExpiresAt).getTime()) {
        return tokens.accessToken;
      }
    }

    // Refresh the access token.
    const resp = await fetch(TOKEN_URL, {
      method: 'POST',
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        refresh_token: tokens.refreshToken,
        grant_type: 'refresh_token',
      }),
    });
    const data = (await resp.json()) as Record<string, unknown>;
    if (!resp.ok) {
      throw new Error(`Token refresh failed: ${data['error_description'] ?? data['error']}`);
    }

    await this.store.updateAccount(account.id, (current) => ({
      ...current,
      oauthTokens: {
        refreshToken: tokens.refreshToken,
        accessToken: data['access_token'] as string,
        accessTokenExpiresAt: new Date(
          Date.now() + Number(data['expires_in']) * 1000,
        ).toISOString(),
      },
    }));
    return data['access_token'] as string;
  }

  private async gmailFetch<T>(
    account: Account,
    path: string,
    opts: RequestInit = {},
  ): Promise<T> {
    const token = await this.getAccessToken(account);
    const resp = await fetch(`${GMAIL_API}/users/me${path}`, {
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      ...opts,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(opts.headers as Record<string, string> | undefined),
      },
    });
    if (!resp.ok) {
      const body = await resp.text();
      throw new GmailHttpError(resp.status, `Gmail API ${path}: HTTP ${resp.status} ${body}`);
    }
    return resp.json() as Promise<T>;
  }

  // ----- EmailProvider -------------------------------------------------------

  async send(msg: OutgoingEmail): Promise<SendResult> {
    const raw = buildRfc2822(msg);
    const b64 = Buffer.from(raw).toString('base64url');
    const result = await this.gmailFetch<{ id: string; threadId: string }>(
      msg.account,
      '/messages/send',
      { method: 'POST', body: JSON.stringify({ raw: b64 }) },
    );
    // Gmail API returns threadId immediately — no IMAP lookup needed.
    return { rfcMessageId: msg.rfcMessageId, threadId: result.threadId };
  }

  async resolveThreadId(account: Account, rfcMessageId: string): Promise<string | undefined> {
    const q = `rfc822msgid:${rfcMessageId}`;
    const result = await this.gmailFetch<{
      messages?: Array<{ id: string; threadId: string }>;
    }>(account, `/messages?q=${encodeURIComponent(q)}&maxResults=1`);
    return result.messages?.[0]?.threadId;
  }

  // Clear UNREAD — "the system saw this message". Called for every ingested
  // message, best-effort.
  async markRead(account: Account, emailId: string): Promise<void> {
    await this.gmailFetch(account, `/messages/${emailId}/modify`, {
      method: 'POST',
      body: JSON.stringify({ removeLabelIds: ['UNREAD'] }),
    });
  }

  // Apply one decision label, stripping any other managed AS/ label the message
  // carries so it holds exactly one at a time. Adding/removing a label is a
  // `labelAdded`/`labelRemoved` history event, NOT `messageAdded`, so it does not
  // perturb the fetchViaHistory incremental cursor. Callers invoke this best-effort.
  async applyLabel(account: Account, emailId: string, label: OutcomeLabel): Promise<void> {
    const byName = await this.ensureLabels(account);
    const addId = byName.get(label) ?? (await this.createLabel(account, byName, label));
    // Remove every OTHER managed label that already exists in this mailbox. Gmail
    // no-ops removeLabelIds the message doesn't actually have, so this is safe.
    const removeIds = ALL_LABELS.filter((l) => l !== label)
      .map((l) => byName.get(l))
      .filter((id): id is string => id != null);
    await this.gmailFetch(account, `/messages/${emailId}/modify`, {
      method: 'POST',
      body: JSON.stringify({ addLabelIds: [addId], removeLabelIds: removeIds }),
    });
  }

  /** Load (cached) the account's label name→id map from labels.list. */
  private async ensureLabels(account: Account): Promise<Map<string, string>> {
    const cached = this.labelIdCache.get(account.id);
    if (cached) return cached;
    const { labels } = await this.gmailFetch<{
      labels?: Array<{ id: string; name: string }>;
    }>(account, '/labels');
    const byName = new Map<string, string>();
    for (const l of labels ?? []) byName.set(l.name, l.id);
    this.labelIdCache.set(account.id, byName);
    return byName;
  }

  /** Create a managed label (with its palette color) and cache its id. */
  private async createLabel(
    account: Account,
    byName: Map<string, string>,
    name: OutcomeLabel,
  ): Promise<string> {
    const label = await this.gmailFetch<{ id: string; name: string }>(account, '/labels', {
      method: 'POST',
      body: JSON.stringify({
        name,
        labelListVisibility: 'labelShow',
        messageListVisibility: 'show',
        color: LABEL_COLORS[name],
      }),
    });
    byName.set(name, label.id);
    return label.id;
  }

  // Incremental sync via users.history: from the stored historyId cursor we ask
  // Gmail only for messages ADDED to INBOX since that mailbox position. An idle
  // pass costs one small call and returns nothing; a message only gets fetched
  // (messages.get) when it's genuinely new. The first pass (no cursor yet) and a
  // cursor that outlived Gmail's ~1-week history retention both fall back to a
  // search-based full pull, which reseeds the cursor for next time.
  async fetchReplies(account: Account, since?: Date): Promise<IncomingEmail[]> {
    const startHistoryId = account.pollCursor?.historyId;
    if (startHistoryId) {
      try {
        return await this.fetchViaHistory(account, startHistoryId);
      } catch (err) {
        if (!(err instanceof GmailHttpError && err.status === 404)) throw err;
        // Cursor too old — fall through to a full resync that reseeds it.
      }
    }
    return this.fetchViaSearch(account, since);
  }

  /** Steady state: pull only INBOX additions since the stored historyId. */
  private async fetchViaHistory(
    account: Account,
    startHistoryId: string,
  ): Promise<IncomingEmail[]> {
    const addedIds = new Set<string>();
    let latestHistoryId = startHistoryId;
    let pageToken: string | undefined;

    do {
      const params = new URLSearchParams({
        startHistoryId,
        historyTypes: 'messageAdded',
        labelId: 'INBOX',
      });
      if (pageToken) params.set('pageToken', pageToken);

      const page = await this.gmailFetch<GmailHistoryResponse>(
        account,
        `/history?${params}`,
      );
      // Advances even when nothing changed, keeping the cursor from going stale.
      if (page.historyId) latestHistoryId = page.historyId;

      for (const record of page.history ?? []) {
        for (const added of record.messagesAdded ?? []) {
          const m = added.message;
          // labelId=INBOX filters the records; double-check the message itself.
          if (m?.id && (m.labelIds?.includes('INBOX') ?? true)) addedIds.add(m.id);
        }
      }
      pageToken = page.nextPageToken;
    } while (pageToken);

    const out = await this.hydrate(account, [...addedIds]);
    await this.writeHistoryId(account, latestHistoryId);
    return out;
  }

  /** Bootstrap / fallback: search INBOX by time, then (re)seed the cursor. */
  private async fetchViaSearch(account: Account, since?: Date): Promise<IncomingEmail[]> {
    // Seed the cursor BEFORE listing: if a message lands mid-pass it will be
    // re-reported by the next incremental pass (dedupe absorbs the overlap),
    // whereas seeding afterward could skip past it and lose the reply.
    await this.seedHistoryId(account);

    let q = 'in:inbox';
    if (since) {
      // Gmail 'after:' takes Unix timestamp in seconds.
      q += ` after:${Math.floor(since.getTime() / 1000)}`;
    }

    const list = await this.gmailFetch<{ messages?: Array<{ id: string }> }>(
      account,
      `/messages?labelIds=INBOX&q=${encodeURIComponent(q)}&maxResults=500`,
    );
    return this.hydrate(account, (list.messages ?? []).map((m) => m.id));
  }

  /** messages.get + parse + attachments for each id; skips malformed ones. */
  private async hydrate(account: Account, ids: string[]): Promise<IncomingEmail[]> {
    const out: IncomingEmail[] = [];
    for (const id of ids) {
      try {
        const msg = await this.gmailFetch<GmailMessage>(
          account,
          `/messages/${id}?format=full`,
        );
        const parsed = await parseGmailMessage(msg);
        if (parsed) {
          const attachments = await this.fetchAttachments(account, msg);
          if (attachments.length) parsed.attachments = attachments;
          out.push(parsed);
        }
      } catch {
        // Skip individual malformed messages rather than failing the whole pass.
      }
    }
    return out;
  }

  /** Capture the mailbox's current historyId (via getProfile) as the cursor. */
  private async seedHistoryId(account: Account): Promise<void> {
    try {
      const profile = await this.gmailFetch<{ historyId?: string }>(account, '/profile');
      if (profile.historyId) await this.writeHistoryId(account, profile.historyId);
    } catch {
      // Non-fatal: without a seed the next pass just searches by time again.
    }
  }

  /** Persist the historyId cursor, merging into any existing pollCursor. */
  private async writeHistoryId(account: Account, historyId: string): Promise<void> {
    await this.store.updateAccount(account.id, (current) => ({
      ...current,
      pollCursor: {
        mailbox: 'INBOX',
        ...current.pollCursor,
        historyId,
      },
    }));
  }

  /** Download each attachment part's bytes (Gmail returns them via a separate
   *  endpoint, keyed by attachmentId) and return size-capped EmailAttachments. */
  private async fetchAttachments(
    account: Account,
    msg: GmailMessage,
  ): Promise<EmailAttachment[]> {
    const refs: GmailPart[] = [];
    collectAttachmentParts(msg.payload as GmailPart | undefined, refs);

    const out: EmailAttachment[] = [];
    for (const part of refs) {
      const declaredSize = part.body?.size ?? 0;
      if (declaredSize > MAX_ATTACHMENT_BYTES) continue; // skip huge files up front
      try {
        // Small parts may carry inline data; otherwise fetch by attachmentId.
        let dataB64url = part.body?.data;
        if (!dataB64url && part.body?.attachmentId) {
          const att = await this.gmailFetch<{ data?: string; size?: number }>(
            account,
            `/messages/${msg.id}/attachments/${part.body.attachmentId}`,
          );
          dataB64url = att.data;
        }
        if (!dataB64url) continue;
        const content = Buffer.from(dataB64url, 'base64url');
        if (!content.length || content.length > MAX_ATTACHMENT_BYTES) continue;
        out.push({
          filename: part.filename || `attachment-${out.length + 1}`,
          mimeType: part.mimeType || 'application/octet-stream',
          size: content.length,
          contentBase64: content.toString('base64'),
        });
      } catch {
        // Skip an attachment we can't download rather than failing the message.
      }
    }
    return out;
  }
}

// ----- RFC 2822 builder (plain-text, no external deps) ----------------------

function buildRfc2822(msg: OutgoingEmail): string {
  return [
    `From: ${msg.account.senderName} <${msg.account.email}>`,
    `To: ${msg.to}`,
    `Subject: ${encodeHeader(msg.subject)}`,
    `Message-Id: ${msg.rfcMessageId}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset=utf-8`,
    `Content-Transfer-Encoding: quoted-printable`,
    ``,
    encodeQP(msg.body),
  ].join('\r\n');
}

function encodeHeader(s: string): string {
  if (!/[^\x00-\x7F]/.test(s)) return s;
  return `=?utf-8?B?${Buffer.from(s).toString('base64')}?=`;
}

function encodeQP(text: string): string {
  return text.replace(/[^\x09\x0A\x0D\x20-\x7E]/g, (ch) => {
    const bytes = Buffer.from(ch, 'utf8');
    return [...bytes].map((b) => `=${b.toString(16).toUpperCase().padStart(2, '0')}`).join('');
  });
}

// ----- Gmail message parser -------------------------------------------------

interface GmailMessage {
  id: string;
  threadId?: string;
  internalDate?: string;
  payload?: {
    mimeType?: string;
    headers?: Array<{ name: string; value: string }>;
    body?: { data?: string };
    parts?: GmailPart[];
  };
}

interface GmailPart {
  mimeType?: string;
  filename?: string;
  body?: { data?: string; attachmentId?: string; size?: number };
  parts?: GmailPart[];
}

interface GmailHistoryResponse {
  history?: Array<{
    messagesAdded?: Array<{ message?: { id?: string; labelIds?: string[] } }>;
  }>;
  nextPageToken?: string;
  // Current mailbox historyId; present even when `history` is empty.
  historyId?: string;
}

function header(msg: GmailMessage, name: string): string {
  const lower = name.toLowerCase();
  return msg.payload?.headers?.find((h) => h.name.toLowerCase() === lower)?.value ?? '';
}

// Walk the MIME tree collecting the first text/plain and first text/html part.
// (Gmail nests parts arbitrarily deep for multipart/alternative + related.)
function collectBodies(part: GmailPart, acc: { plain?: string; html?: string }): void {
  const data = part.body?.data;
  if (data) {
    const decoded = Buffer.from(data, 'base64url').toString('utf8');
    if (part.mimeType === 'text/plain' && acc.plain === undefined) acc.plain = decoded;
    else if (part.mimeType === 'text/html' && acc.html === undefined) acc.html = decoded;
  }
  for (const p of part.parts ?? []) collectBodies(p, acc);
}

// Prefer the HTML part (converted to markdown) over plain text — same policy as
// the SMTP/IMAP provider, so extraction quality doesn't depend on auth type.
async function extractText(payload: GmailMessage['payload']): Promise<string> {
  if (!payload) return '';
  const acc: { plain?: string; html?: string } = {};
  collectBodies(payload as GmailPart, acc);
  if (acc.html) {
    const { NodeHtmlMarkdown } = await import('node-html-markdown' as string);
    return NodeHtmlMarkdown.translate(acc.html);
  }
  if (acc.plain !== undefined) return acc.plain;
  // Single-part message whose top-level body is neither text/plain nor text/html.
  if (payload.body?.data) return Buffer.from(payload.body.data, 'base64url').toString('utf8');
  return '';
}

// An attachment is any part carrying a filename (inline bodies have none).
function collectAttachmentParts(part: GmailPart | undefined, acc: GmailPart[]): void {
  if (!part) return;
  if (part.filename && (part.body?.attachmentId || part.body?.data)) acc.push(part);
  for (const p of part.parts ?? []) collectAttachmentParts(p, acc);
}

async function parseGmailMessage(msg: GmailMessage): Promise<IncomingEmail | undefined> {
  const from = header(msg, 'From');
  const subject = header(msg, 'Subject');
  const messageId = header(msg, 'Message-ID') || header(msg, 'Message-Id');
  const dateHeader = header(msg, 'Date');

  // "Name <addr>" → "addr"; bare address stays as-is.
  const fromAddress = from.replace(/^.*<(.+?)>\s*$/, '$1').trim() || from.trim();

  const text = await extractText(msg.payload);

  const receivedAt = msg.internalDate
    ? new Date(Number(msg.internalDate)).toISOString()
    : dateHeader
      ? new Date(dateHeader).toISOString()
      : new Date().toISOString();

  if (!fromAddress) return undefined;

  return {
    emailId: msg.id,
    ...(msg.threadId ? { threadId: msg.threadId } : {}),
    rfcMessageId: messageId || `<${msg.id}@gmail.com>`,
    fromAddress,
    subject,
    receivedAt,
    text,
  };
}
