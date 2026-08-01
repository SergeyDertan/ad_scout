// One-off repair for Reply.accountId — "which mailbox of ours received this".
//
// The field was declared and documented from the start, but fetch-pass built its
// Reply without it, so EVERY stored reply has it empty. poll-pass always set it;
// the data simply all came in through the fetch-only path. Both paths set it now
// (fetch-pass.ts / poll-pass.ts), so this is a one-time repair of the backlog,
// not a recurring job.
//
// Recovered offline, no mailbox API calls, narrowest evidence first:
//   1. thread   — the reply's threadId belongs to an Outreach we sent, and that
//                 outreach knows which account sent it. Exact.
//   2. target   — the reply matched a target by address rather than by thread,
//                 so there is no thread to follow, but the outreach we sent THAT
//                 target names the account. Exact whenever the target was only
//                 ever mailed from one account (checked, not assumed).
//   3. quoted   — the body quotes exactly ONE of our account addresses (the
//                 "On <date>, <us> wrote:" block a reply carries). Exact when
//                 unambiguous; skipped when two of our addresses appear.
// Anything left is inbound that was never our outreach (newsletters, cold
// pitches at us) — there is no offline evidence for those and they are reported,
// not guessed.
//
// Idempotent: only ever FILLS an empty accountId, never rewrites one.
//
// Back up ./data first (see the data-backup-*.tgz convention), then:
//     pnpm backfill:account-id            # dry run — reports, writes nothing
//     pnpm backfill:account-id --apply

import 'dotenv/config';
import { loadConfig } from '../config';
import { buildStore } from '../lib/factory';
import { normalizeEmail } from '../domain/reply-matching';
import type { ID, Reply } from '../domain/types';

type Source = 'thread' | 'target' | 'quoted';

/** Escape a literal for use inside a RegExp (our addresses contain dots). */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The account whose address appears in the reply's quoted history. A reply that
 * quotes us names exactly one of our mailboxes; if it somehow names two (a
 * forward between our own accounts) there is no single right answer, so we
 * decline rather than pick.
 */
function accountFromBody(text: string | undefined, accounts: { id: ID; email: string }[]): ID | undefined {
  if (!text) return undefined;
  const hits = accounts.filter((a) => new RegExp(escapeRe(a.email), 'i').test(text));
  return hits.length === 1 ? hits[0]!.id : undefined;
}

async function main() {
  const apply = process.argv.includes('--apply');
  const store = buildStore(loadConfig());
  console.log(`${apply ? 'APPLY' : 'DRY RUN'}\n`);

  const accounts = (await store.listAccounts()).map((a) => ({ id: a.id, email: normalizeEmail(a.email) }));
  const emailById = new Map(accounts.map((a) => [a.id, a.email]));

  // threadId -> the account that sent that thread. First writer wins: a thread
  // has exactly one sending account, and follow-ups reuse it.
  const accountByThread = new Map<string, ID>();
  // targetId -> its sending account, but ONLY when every outreach to that target
  // used the same one. A target mailed from two accounts cannot say which of them
  // received a given reply, so it contributes no evidence rather than a guess.
  const accountsByTarget = new Map<ID, Set<ID>>();
  for (const o of await store.listOutreaches()) {
    if (o.threadId && !accountByThread.has(o.threadId)) accountByThread.set(o.threadId, o.accountId);
    const set = accountsByTarget.get(o.targetId) ?? new Set<ID>();
    set.add(o.accountId);
    accountsByTarget.set(o.targetId, set);
  }
  const accountByTarget = new Map<ID, ID>();
  for (const [targetId, set] of accountsByTarget) {
    if (set.size === 1) accountByTarget.set(targetId, [...set][0]!);
  }

  const replies = await store.listReplies();
  const bySource = new Map<Source, number>([['thread', 0], ['target', 0], ['quoted', 0]]);
  const byAccount = new Map<string, number>();
  const unresolved: Reply[] = [];
  let alreadySet = 0;
  let written = 0;

  for (const reply of replies) {
    if (reply.accountId) {
      alreadySet++;
      continue;
    }

    let accountId: ID | undefined;
    let source: Source | undefined;

    if (reply.threadId) {
      accountId = accountByThread.get(reply.threadId);
      if (accountId) source = 'thread';
    }
    if (!accountId && reply.targetId) {
      accountId = accountByTarget.get(reply.targetId);
      if (accountId) source = 'target';
    }
    if (!accountId) {
      accountId = accountFromBody(reply.text, accounts);
      if (accountId) source = 'quoted';
    }

    if (!accountId || !source) {
      unresolved.push(reply);
      continue;
    }

    bySource.set(source, (bySource.get(source) ?? 0) + 1);
    const email = emailById.get(accountId) ?? accountId;
    byAccount.set(email, (byAccount.get(email) ?? 0) + 1);

    reply.accountId = accountId;
    written++;
    if (apply) await store.putReply(reply);
  }

  console.log(`replies              ${replies.length}`);
  console.log(`  already had one    ${alreadySet}`);
  console.log(`  resolved by thread ${bySource.get('thread')}`);
  console.log(`  resolved by target ${bySource.get('target')}`);
  console.log(`  resolved by quote  ${bySource.get('quoted')}`);
  console.log(`  UNRESOLVED         ${unresolved.length}`);
  console.log();

  if (byAccount.size) {
    console.log('Filled, by mailbox:');
    for (const [email, n] of [...byAccount].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(n).padStart(5)}  ${email}`);
    }
    console.log();
  }

  if (unresolved.length) {
    console.log(`Unresolved — inbound that was never our outreach (no thread of ours, does not quote us).`);
    console.log(`These stay empty; there is no offline evidence to fill them from.`);
    for (const r of unresolved.slice(0, 20)) {
      console.log(`  ${r.fromAddress.padEnd(44)} ${r.receivedAt.slice(0, 10)}  ${r.matchMethod}`);
    }
    if (unresolved.length > 20) console.log(`  … and ${unresolved.length - 20} more`);
    console.log();
  }

  console.log(`docs written — ${written}/${replies.length} replies`);
  if (!apply) console.log('\nnothing written — re-run with --apply');
  await store.close?.();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
