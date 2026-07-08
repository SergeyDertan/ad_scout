// SmtpImapProvider — real implementation for personal Gmail (app password) and
// any IMAP/SMTP host, via nodemailer (send) + imapflow (read). imapflow
// normalizes Gmail's X-GM-THRID / RFC 8474 OBJECTID into message.threadId and
// message.emailId — we read those directly and NEVER parse Re:/References.
//
// Packages are loaded lazily so the core builds without them. To use:
//     pnpm add nodemailer imapflow
//     EMAIL_PROVIDER=smtp-imap
// Credentials come from .env via Account.credentialRef:
//     <credentialRef>_USER, <credentialRef>_PASS, optional <credentialRef>_HOST/_SMTP_PORT/_IMAP_PORT
//
// NOTE: body extraction below is intentionally minimal (split off headers). For
// robust MIME handling, add `mailparser` and parse message.source.

import type { Account, EmailAttachment } from '../../domain/types';
import {
  MAX_ATTACHMENT_BYTES,
  type EmailProvider,
  type IncomingEmail,
  type OutgoingEmail,
  type SendResult,
} from '../../ports/email-provider';

interface Creds {
  user: string;
  pass: string;
  smtpHost: string;
  smtpPort: number;
  imapHost: string;
  imapPort: number;
}

export function credsFor(account: Account, env: NodeJS.ProcessEnv = process.env): Creds {
  const ref = account.credentialRef;
  const user = env[`${ref}_USER`];
  const pass = env[`${ref}_PASS`];
  if (!user || !pass) {
    throw new Error(`Missing ${ref}_USER / ${ref}_PASS in environment for account ${account.email}`);
  }
  const host = env[`${ref}_HOST`] ?? 'gmail';
  const smtpHost = host === 'gmail' ? 'smtp.gmail.com' : env[`${ref}_SMTP_HOST`] ?? host;
  const imapHost = host === 'gmail' ? 'imap.gmail.com' : env[`${ref}_IMAP_HOST`] ?? host;
  return {
    user,
    pass,
    smtpHost,
    smtpPort: Number(env[`${ref}_SMTP_PORT`] ?? 465),
    imapHost,
    imapPort: Number(env[`${ref}_IMAP_PORT`] ?? 993),
  };
}

const ALL_MAIL = '[Gmail]/All Mail';

export class SmtpImapProvider implements EmailProvider {
  readonly name = 'smtp-imap';
  readonly supportsThreadId = true;

  async send(msg: OutgoingEmail): Promise<SendResult> {
    const creds = credsFor(msg.account);
    const nodemailer: any = await import('nodemailer' as string);
    const transport = nodemailer.createTransport({
      host: creds.smtpHost,
      port: creds.smtpPort,
      secure: creds.smtpPort === 465,
      auth: { user: creds.user, pass: creds.pass },
    });
    await transport.sendMail({
      from: { name: msg.account.senderName, address: msg.account.email },
      to: msg.to,
      subject: msg.subject,
      text: msg.body,
      messageId: msg.rfcMessageId, // set our own Message-Id for exact self-lookup
    });
    // SMTP returns no thread id — resolved post-send via resolveThreadId().
    return { rfcMessageId: msg.rfcMessageId };
  }

  private async withImap<T>(account: Account, fn: (client: any) => Promise<T>): Promise<T> {
    const creds = credsFor(account);
    const { ImapFlow }: any = await import('imapflow' as string);
    const client = new ImapFlow({
      host: creds.imapHost,
      port: creds.imapPort,
      secure: true,
      auth: { user: creds.user, pass: creds.pass },
      logger: false,
    });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.logout().catch(() => {});
    }
  }

  async resolveThreadId(account: Account, rfcMessageId: string): Promise<string | undefined> {
    return this.withImap(account, async (client) => {
      const lock = await client.getMailboxLock(ALL_MAIL);
      try {
        for await (const msg of client.fetch(
          { header: { 'message-id': rfcMessageId } },
          { threadId: true, uid: true },
        )) {
          if (msg.threadId) return String(msg.threadId);
        }
        return undefined;
      } finally {
        lock.release();
      }
    });
  }

  async fetchReplies(account: Account, since?: Date): Promise<IncomingEmail[]> {
    return this.withImap(account, async (client) => {
      const out: IncomingEmail[] = [];
      const lock = await client.getMailboxLock('INBOX');
      try {
        const criteria = since ? { since } : { all: true };
        for await (const msg of client.fetch(criteria, {
          uid: true,
          envelope: true,
          threadId: true,
          emailId: true,
          source: true,
        })) {
          const env = msg.envelope ?? {};
          const from = env.from?.[0]?.address ?? '';
          out.push({
            emailId: String(msg.emailId ?? msg.uid),
            ...(msg.threadId ? { threadId: String(msg.threadId) } : {}),
            rfcMessageId: env.messageId ?? '',
            fromAddress: from,
            subject: env.subject ?? '',
            receivedAt: (env.date ?? new Date()).toISOString
              ? (env.date as Date).toISOString()
              : new Date().toISOString(),
            ...(await parseBody(msg.source)),
          });
        }
        return out;
      } finally {
        lock.release();
      }
    });
  }
}

/** Parse the raw MIME source, decode quoted-printable, and return clean text
 *  plus any attachments. Prefers the HTML part (converted to markdown) over
 *  plain text. */
async function parseBody(
  source: unknown,
): Promise<{ text: string; attachments?: EmailAttachment[] }> {
  if (!source) return { text: '' };
  const raw = Buffer.isBuffer(source) ? source : Buffer.from(String(source), 'utf8');
  const { simpleParser } = await import('mailparser' as string);
  const parsed = await simpleParser(raw);

  let text: string;
  if (parsed.html) {
    const { NodeHtmlMarkdown } = await import('node-html-markdown' as string);
    text = NodeHtmlMarkdown.translate(parsed.html);
  } else {
    text = parsed.text ?? '';
  }

  const attachments: EmailAttachment[] = [];
  for (const att of parsed.attachments ?? []) {
    const content: Buffer = att.content;
    if (!content?.length || content.length > MAX_ATTACHMENT_BYTES) continue;
    attachments.push({
      filename: att.filename || `attachment-${attachments.length + 1}`,
      mimeType: att.contentType || 'application/octet-stream',
      size: content.length,
      contentBase64: content.toString('base64'),
    });
  }

  return attachments.length ? { text, attachments } : { text };
}
