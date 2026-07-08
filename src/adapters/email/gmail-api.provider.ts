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

import type { Account } from '../../domain/types';
import type {
  EmailProvider,
  IncomingEmail,
  OutgoingEmail,
  SendResult,
} from '../../ports/email-provider';
import type { Store } from '../../ports/store';

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';

export interface GmailOAuthHandler {
  getAuthUrl(accountId: string, redirectUri: string): string;
  handleCallback(code: string, accountId: string, redirectUri: string): Promise<void>;
}

export class GmailApiProvider implements EmailProvider, GmailOAuthHandler {
  readonly name = 'gmail-api';
  readonly supportsThreadId = true;

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
        'https://www.googleapis.com/auth/gmail.readonly',
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
      ...opts,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(opts.headers as Record<string, string> | undefined),
      },
    });
    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`Gmail API ${path}: HTTP ${resp.status} ${body}`);
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

  async fetchReplies(account: Account, since?: Date): Promise<IncomingEmail[]> {
    let q = 'in:inbox';
    if (since) {
      // Gmail 'after:' takes Unix timestamp in seconds.
      q += ` after:${Math.floor(since.getTime() / 1000)}`;
    }

    const list = await this.gmailFetch<{ messages?: Array<{ id: string }> }>(
      account,
      `/messages?labelIds=INBOX&q=${encodeURIComponent(q)}&maxResults=500`,
    );
    if (!list.messages?.length) return [];

    const out: IncomingEmail[] = [];
    for (const { id } of list.messages) {
      try {
        const msg = await this.gmailFetch<GmailMessage>(
          account,
          `/messages/${id}?format=full`,
        );
        const parsed = parseGmailMessage(msg);
        if (parsed) out.push(parsed);
      } catch {
        // Skip individual malformed messages rather than failing the whole pass.
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
  body?: { data?: string };
  parts?: GmailPart[];
}

function header(msg: GmailMessage, name: string): string {
  const lower = name.toLowerCase();
  return msg.payload?.headers?.find((h) => h.name.toLowerCase() === lower)?.value ?? '';
}

function extractText(part: GmailPart): string {
  if (part.mimeType === 'text/plain' && part.body?.data) {
    return Buffer.from(part.body.data, 'base64url').toString('utf8');
  }
  for (const p of part.parts ?? []) {
    const t = extractText(p);
    if (t) return t;
  }
  return '';
}

function parseGmailMessage(msg: GmailMessage): IncomingEmail | undefined {
  const from = header(msg, 'From');
  const subject = header(msg, 'Subject');
  const messageId = header(msg, 'Message-ID') || header(msg, 'Message-Id');
  const dateHeader = header(msg, 'Date');

  // "Name <addr>" → "addr"; bare address stays as-is.
  const fromAddress = from.replace(/^.*<(.+?)>\s*$/, '$1').trim() || from.trim();

  let text = '';
  const payload = msg.payload;
  if (payload?.body?.data) {
    text = Buffer.from(payload.body.data, 'base64url').toString('utf8');
  } else if (payload) {
    text = extractText(payload as GmailPart);
  }

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
