// Audit: for each account, fetch the real Gmail INBOX since the account's
// first sent outreach and cross-check against our Reply store — catches
// emails the poll/fetch pass never ingested (e.g. missed due to a poll-cursor
// write conflict) as distinct from emails ingested but not yet extracted.
// Read-only: does not write to the store or the mailbox.
//
//     pnpm verify:replies

import 'dotenv/config';
import { loadConfig } from '../config';
import { buildStore } from '../lib/factory';
import { GmailApiProvider } from '../adapters/email/gmail-api.provider';
import { detectBounce, normalizeEmail } from '../domain/reply-matching';
import type { Account } from '../domain/types';

async function main() {
  const config = loadConfig();
  const store = buildStore(config);
  const { clientId, clientSecret } = config.googleOAuth;
  if (!clientId || !clientSecret) {
    throw new Error('Google OAuth not configured (client_secret.json / GOOGLE_CLIENT_ID+SECRET) — needed to query Gmail directly');
  }
  const gmail = new GmailApiProvider(store, clientId, clientSecret);

  const accounts = await store.listAccounts();
  const outreaches = await store.listOutreaches();
  const replies = await store.listReplies();
  const repliesByEmailId = new Map(replies.map((r) => [r.emailId, r]));
  const suppressedEmails = new Set((await store.listSuppressions()).map((s) => normalizeEmail(s.email)));

  for (const account of accounts) {
    console.log(`\n=== ${account.email} (${account.id}) ===`);

    const sent = outreaches
      .filter((o) => o.accountId === account.id && (o.sentAt || o.reservedAt))
      .sort((a, b) => (a.sentAt ?? a.reservedAt) < (b.sentAt ?? b.reservedAt) ? -1 : 1);
    const first = sent[0];
    if (!first) {
      console.log('no outreaches sent from this account yet — skipping');
      continue;
    }
    const since = new Date(first.sentAt ?? first.reservedAt);
    console.log(`first outreach: ${first.id} sent ${since.toISOString()}`);

    let inbox: Awaited<ReturnType<GmailApiProvider['fetchReplies']>>;
    try {
      inbox = await gmail.fetchReplies(account as Account, since);
    } catch (err) {
      console.log('FAILED to query Gmail:', err instanceof Error ? err.message : String(err));
      continue;
    }

    if (inbox.length === 500) {
      console.log('WARNING: hit the 500-message API cap — results below may be truncated (oldest messages missing)');
    }
    console.log(`inbox messages since first send: ${inbox.length}`);

    const missing = inbox.filter((msg) => !repliesByEmailId.has(msg.emailId));
    const ingested = inbox.length - missing.length;
    console.log(`ingested into store: ${ingested}/${inbox.length}`);

    // Bounces are never stored as Reply docs by design (fetch-pass suppresses
    // the failed recipient and returns early) — a bounce absent from the
    // Reply store is expected, NOT a gap. Classify "missing" accordingly, and
    // for bounces, check the failed recipient was actually suppressed as
    // corroborating evidence the pipeline really did see and process it
    // (vs. never having fetched it at all, which would also show as "missing").
    const realGaps: typeof missing = [];
    const confirmedBounces: typeof missing = [];
    const unconfirmedBounces: typeof missing = [];
    for (const m of missing) {
      const bounce = detectBounce(m.fromAddress, m.text);
      if (!bounce.isBounce) {
        realGaps.push(m);
      } else if (bounce.failedRecipient && suppressedEmails.has(bounce.failedRecipient)) {
        confirmedBounces.push(m);
      } else {
        unconfirmedBounces.push(m);
      }
    }

    console.log(
      `missing breakdown: ${realGaps.length} real gap(s), ${confirmedBounces.length} confirmed-processed bounce(s), ${unconfirmedBounces.length} unconfirmed bounce-shaped message(s)`,
    );

    if (realGaps.length > 0) {
      console.log(`REAL GAPS — non-bounce messages with no Reply record — ${realGaps.length}:`);
      for (const m of realGaps) {
        console.log(`  - ${m.receivedAt}  from=${m.fromAddress}  subject="${m.subject}"  emailId=${m.emailId}`);
      }
    }
    if (unconfirmedBounces.length > 0) {
      console.log(`UNCONFIRMED bounce-shaped messages (no matching suppression found) — ${unconfirmedBounces.length}:`);
      for (const m of unconfirmedBounces) {
        console.log(`  - ${m.receivedAt}  from=${m.fromAddress}  subject="${m.subject}"  emailId=${m.emailId}`);
      }
    }

    const matchedReplies = inbox
      .map((m) => repliesByEmailId.get(m.emailId))
      .filter((r): r is NonNullable<typeof r> => !!r);
    const extractionCounts: Record<string, number> = {};
    for (const r of matchedReplies) {
      extractionCounts[r.extractionStatus] = (extractionCounts[r.extractionStatus] ?? 0) + 1;
    }
    console.log('extractionStatus of ingested replies:', extractionCounts);
  }

  await store.close?.();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
