// RoutingEmailProvider — dispatches send/fetch/resolve to smtp-imap or
// gmail-api based on Account.providerType. Lets both account types coexist.

import type { Account } from '../../domain/types';
import type {
  EmailProvider,
  IncomingEmail,
  OutgoingEmail,
  SendResult,
} from '../../ports/email-provider';

export class RoutingEmailProvider implements EmailProvider {
  readonly name: string;
  readonly supportsThreadId = true;

  constructor(
    private readonly smtpImap: EmailProvider,
    private readonly gmailApi: EmailProvider,
  ) {
    this.name = `${smtpImap.name}+${gmailApi.name}`;
  }

  private pick(account: Account): EmailProvider {
    // Fall back to smtp-imap when an account is marked gmail-api but hasn't
    // completed the OAuth flow yet (no refresh token stored).
    if (account.providerType === 'gmail-api' && account.oauthTokens?.refreshToken) {
      return this.gmailApi;
    }
    return this.smtpImap;
  }

  send(msg: OutgoingEmail): Promise<SendResult> {
    return this.pick(msg.account).send(msg);
  }

  fetchReplies(account: Account, since?: Date): Promise<IncomingEmail[]> {
    return this.pick(account).fetchReplies(account, since);
  }

  resolveThreadId(account: Account, rfcMessageId: string): Promise<string | undefined> {
    return this.pick(account).resolveThreadId(account, rfcMessageId);
  }
}
