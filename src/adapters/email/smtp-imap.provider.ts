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

import type { Account } from '../../domain/types';
import type {
  EmailProvider,
  IncomingEmail,
  OutgoingEmail,
  SendResult,
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
            text: extractText(msg.source),
          });
        }
        return out;
      } finally {
        lock.release();
      }
    });
  }
}

/** Minimal body extraction: drop the header block. Use mailparser for real MIME. */
function extractText(source: unknown): string {
  if (!source) return '';
  const raw = Buffer.isBuffer(source) ? source.toString('utf8') : String(source);
  const idx = raw.indexOf('\r\n\r\n');
  return idx >= 0 ? raw.slice(idx + 4) : raw;
}
