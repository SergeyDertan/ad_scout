// One-shot repair: put the attachments back on the techfinitive deal thread.
//
// WHY THIS IS NEEDED
// fetch-pass built its Reply document without `attachments` (and without
// `subject`), while poll-pass kept both. The drip scheduler polls with
// fetch-pass, so nearly every reply in the store was written by the path that
// threw the files away. A Reply is written once and never re-read from the
// mailbox, so Ricardo's invoice PDF (3 Sep 2026) existed only in Gmail. Both
// passes now build the document through one shared builder
// (pipeline/inbound-reply.ts), so this is a repair of the backlog, not a
// recurring job — and deliberately a NARROW one: this deal's threads only.
//
// (Reply.accountId was lost exactly the same way once before, and needed
// scripts/backfill-account-id.ts. That is why the builder is now shared.)
//
// WHAT IT DOES
// Re-reads the deal's own messages from Gmail by their stored message id and
// copies any attachments onto the existing Reply documents. It does NOT delete
// replies, re-run extraction, move a poll cursor, change labels or read-state,
// or touch a reply that already has attachments. Everything else on the
// document is left exactly as it is.
//
// Gmail-API accounts only. `fetchReplies` follows the historyId cursor and so
// cannot see mail this old, and `fetchThread` drops attachments by design;
// `fetchByIds` is the one read path that returns them.
//
// Run it where the data lives (production runs its own store):
//     pnpm heal:techfinitive-attachments            # dry run — reports, writes nothing
//     pnpm heal:techfinitive-attachments --apply
//     pnpm heal:techfinitive-attachments --deal deal_<id> --apply

import 'dotenv/config';
import { loadConfig } from '../config';
import { buildStore } from '../lib/factory';
import { GmailApiProvider } from '../adapters/email/gmail-api.provider';
import type { Account, ID, Reply } from '../domain/types';

/** The techfinitive negotiation with ricardo.oliveira@techfinitive.com. */
const DEFAULT_DEAL: ID = 'deal_b22f3916-b02a-46e5-b47a-996658d5e23d';

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i === -1 || i + 1 >= process.argv.length ? undefined : process.argv[i + 1];
}

function describe(r: Reply): string {
  return `${r.receivedAt}  ${r.id}  ${r.fromAddress}`;
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const dealId = argValue('--deal') ?? DEFAULT_DEAL;
  const config = loadConfig();
  const store = buildStore(config);

  console.log(`${apply ? 'APPLY' : 'DRY RUN'}  deal=${dealId}  store=${config.store}\n`);

  const deal = await store.getDeal(dealId);
  if (!deal) throw new Error(`no such deal: ${dealId}`);

  // The deal's messages: stamped with its id at ingest, or sitting on one of its
  // threads (a reply that arrived before the deal was opened has no dealId).
  const threadIds = new Set((await store.listThreadLinks({ dealId })).map((l) => l.threadId));
  const mine = (await store.listReplies()).filter(
    (r) => r.dealId === dealId || (r.threadId && threadIds.has(r.threadId)),
  );
  mine.sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));

  const already = mine.filter((r) => r.attachments?.length);
  const candidates = mine.filter((r) => !r.attachments?.length);
  console.log(`${mine.length} message(s) on this deal — ${already.length} already have attachments, ${candidates.length} to check\n`);
  if (candidates.length === 0) return;

  const { clientId, clientSecret } = config.googleOAuth;
  if (!clientId || !clientSecret) {
    throw new Error('Google OAuth is not configured — this repair reads Gmail directly.');
  }
  const gmail = new GmailApiProvider(store, clientId, clientSecret);

  // Group by mailbox: the message id is only meaningful to the account that
  // holds it, and a deal's thread can in principle span more than one.
  const byAccount = new Map<ID, Reply[]>();
  for (const r of candidates) {
    const accountId = r.accountId ?? deal.accountId;
    byAccount.set(accountId, [...(byAccount.get(accountId) ?? []), r]);
  }

  let healed = 0;
  let noneInMailbox = 0;
  let unreadable = 0;

  for (const [accountId, replies] of byAccount) {
    const account: Account | undefined = await store.getAccount(accountId);
    if (!account) {
      console.log(`! account ${accountId} is gone — skipping ${replies.length} message(s)`);
      unreadable += replies.length;
      continue;
    }
    if (account.providerType !== 'gmail-api' || !account.oauthTokens?.refreshToken) {
      console.log(`! ${account.email} is not a connected gmail-api account — cannot re-read it by message id`);
      unreadable += replies.length;
      continue;
    }

    const fetched = await gmail.fetchByIds(account, replies.map((r) => r.emailId));
    const byEmailId = new Map(fetched.map((m) => [m.emailId, m]));

    for (const reply of replies) {
      const msg = byEmailId.get(reply.emailId);
      if (!msg) {
        console.log(`  ?  ${describe(reply)} — Gmail returned nothing for ${reply.emailId}`);
        unreadable++;
        continue;
      }
      if (!msg.attachments?.length) {
        noneInMailbox++;
        continue;
      }

      const files = msg.attachments.map((a) => `${a.filename} (${a.mimeType}, ${a.size}B)`);
      console.log(`  +  ${describe(reply)}\n       ${files.join('\n       ')}`);
      healed++;

      if (apply) {
        // Read-modify-write of this one field. Everything else — the parsed
        // extraction, the deal stamp, the status — is carried through untouched.
        await store.putReply({ ...reply, attachments: msg.attachments });
      }
    }
  }

  console.log(
    `\n${apply ? 'healed' : 'would heal'} ${healed} message(s); ` +
      `${noneInMailbox} carried no attachment; ${unreadable} could not be re-read`,
  );
  if (!apply && healed > 0) console.log('re-run with --apply to write.');
  await store.close?.();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
