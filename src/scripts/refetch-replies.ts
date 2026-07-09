// Delete stored replies (and their AI extractions) and RE-FETCH them from the
// mailbox, so old messages are re-ingested under the current parser — HTML→
// markdown bodies and attachments that older fetches dropped, plus the current
// extraction prompt.
//
// Why deletion is required: fetchReplies re-pulls the mailbox, but handleMessage
// dedupes on the stable emailId — a reply still in the DB is skipped. Removing it
// first lets the message be parsed and extracted afresh.
//
//     pnpm refetch:replies [--dry-run] [--since <ISO>] [--include-excluded] [--no-fetch]
//
//   --dry-run           report what would change; touch nothing.
//   --since <ISO>       only replies received on/after this date (also the cursor
//                       rollback point). Default: all replies; cursor rolled back
//                       to just before our earliest OUTBOUND email, then the
//                       mailbox is re-polled from there and re-matched to targets.
//   --include-excluded  also process opt-out targets (default: skip them — a
//                       re-fetch re-excludes them anyway, and it's safer to leave
//                       suppressions alone).
//   --no-fetch          delete + roll back the cursor, but don't run the poll pass
//                       now (re-fetch happens on the next scheduled poll instead).
//
// The re-fetch itself is read-only against Gmail/IMAP and never re-sends mail
// (send-pass is separate), but it DOES re-run extraction on every re-pulled
// reply — mind the LLM cost when the window is large.

import 'dotenv/config';
import { loadConfig } from '../config';
import { buildAgent } from '../lib/factory';
import { runPollPass, type PollDeps, type PollReport } from '../pipeline/poll-pass';
import { systemClock } from '../lib/clock';
import type { Target } from '../domain/types';

export interface RefetchOptions {
  since?: Date;
  includeExcluded?: boolean;
  noFetch?: boolean;
  dryRun?: boolean;
  /** Progress sink (defaults to no-op; the CLI passes console.log). */
  log?: (msg: string) => void;
}

export interface RefetchResult {
  removed: number;
  targetsReset: number;
  cursorRolledBackTo?: string;
  report?: PollReport;
}

/**
 * Core of the refetch script, decoupled from argv/config so it can be tested and
 * reused. Deletes the selected replies, rolls affected targets back to
 * 'contacted', rewinds each account's poll cursor, then (unless noFetch) runs a
 * poll pass to re-ingest the messages under the current parser + prompt.
 */
export async function refetchReplies(deps: PollDeps, opts: RefetchOptions = {}): Promise<RefetchResult> {
  const { store } = deps;
  const log = opts.log ?? (() => {});
  const targetsById = new Map((await store.listTargets()).map((t) => [t.id, t]));

  let replies = await store.listReplies();
  if (opts.since) replies = replies.filter((r) => new Date(r.receivedAt) >= opts.since!);
  if (!opts.includeExcluded) {
    replies = replies.filter((r) => {
      const t = r.targetId ? targetsById.get(r.targetId) : undefined;
      return !(t && t.status === 'excluded');
    });
  }

  // Cursor rollback point: the caller's --since, else just before our earliest
  // OUTBOUND email (a 60s buffer keeps the boundary inclusive). A re-fetch re-polls
  // the mailbox from the first send and re-matches every inbound to a target — just
  // like a normal poll — so replies the old parser dropped and never stored are
  // re-pulled too, not only the ones currently in the DB. Anchoring on outbound
  // (rather than on stored replies) is what makes that independent of DB state, and
  // nothing legitimate can predate the first send, so this never scans pre-app mail.
  // Each account polls its OWN mailbox, so each gets its own floor: the earliest
  // email THAT account sent. Rolling one account back to another's first send would
  // make it rescan its inbox from before it ever sent — extra cost, no benefit.
  const earliestSendByAccount = new Map<string, number>();
  for (const o of await store.listOutreaches()) {
    const at = o.sentAt ?? o.reservedAt;
    if (!at || !o.accountId) continue;
    const ms = new Date(at).getTime();
    const prev = earliestSendByAccount.get(o.accountId);
    if (prev === undefined || ms < prev) earliestSendByAccount.set(o.accountId, ms);
  }
  const earliestSend = Math.min(Number.POSITIVE_INFINITY, ...earliestSendByAccount.values());
  // Degenerate fallback (no outbound on record at all): anchor on the earliest
  // reply we're deleting so we can still re-pull it.
  const earliestReply = replies.reduce(
    (min, r) => Math.min(min, new Date(r.receivedAt).getTime()),
    Number.POSITIVE_INFINITY,
  );
  if (!opts.since && !Number.isFinite(earliestSend) && !Number.isFinite(earliestReply)) {
    log('No outreach or replies on record — nothing to re-fetch.');
    return { removed: 0, targetsReset: 0 };
  }

  // Per-account rollback target: --since wins; else that account's own earliest
  // send; else (account never sent) leave its cursor alone — unless nothing on
  // record sent at all, the degenerate case where we fall back to the earliest reply.
  const rollbackFor = (accountId: string): Date | undefined => {
    if (opts.since) return opts.since;
    const own = earliestSendByAccount.get(accountId);
    if (own !== undefined) return new Date(own - 60_000);
    if (!Number.isFinite(earliestSend) && Number.isFinite(earliestReply)) {
      return new Date(earliestReply - 60_000);
    }
    return undefined;
  };

  // Stored replies to delete + their targets to roll back to 'contacted' so they
  // re-enter the awaiting set and the pipeline re-derives status on re-ingest. May
  // be empty — the re-poll still re-pulls and re-matches straight from the mailbox.
  const affectedTargets = [
    ...new Set(replies.map((r) => r.targetId).filter((id): id is string => Boolean(id))),
  ]
    .map((id) => targetsById.get(id))
    .filter((t): t is Target => Boolean(t) && (opts.includeExcluded || t!.status !== 'excluded'));

  const accounts = await store.listAccounts();
  const rollbacks = new Map<string, Date>();
  for (const a of accounts) {
    const rb = rollbackFor(a.id);
    if (rb) rollbacks.set(a.id, rb);
  }
  // Representative for the report/log: the earliest cursor we roll any account to.
  const earliestRollback = rollbacks.size
    ? new Date(Math.min(...[...rollbacks.values()].map((d) => d.getTime())))
    : undefined;

  log(
    `${opts.dryRun ? '[dry-run] ' : ''}removing ${replies.length} repl(y/ies) + extraction(s), ` +
      `resetting ${affectedTargets.length} target(s) to 'contacted', ` +
      `rolling ${rollbacks.size} of ${accounts.length} account cursor(s) back` +
      (earliestRollback ? ` (earliest ${earliestRollback.toISOString()})` : '') +
      (opts.noFetch ? '' : ', then re-fetching'),
  );

  if (opts.dryRun) {
    return {
      removed: replies.length,
      targetsReset: affectedTargets.length,
      cursorRolledBackTo: earliestRollback?.toISOString(),
    };
  }

  for (const r of replies) await store.deleteReply(r.id);

  for (const t of affectedTargets) {
    await store.updateTarget(t.id, (current) => {
      const { result: _drop, ...rest } = current;
      return { ...(rest as Target), status: 'contacted' };
    });
  }

  for (const a of accounts) {
    const rb = rollbacks.get(a.id);
    if (!rb) continue; // account never sent — nothing of ours to re-pull; leave it.
    await store.updateAccount(a.id, (current) => ({
      ...current,
      pollCursor: { mailbox: 'INBOX', lastPolledAt: rb.toISOString() },
    }));
  }

  log(`removed ${replies.length} reply(ies); ${rollbacks.size} cursor(s) rolled back.`);

  const result: RefetchResult = {
    removed: replies.length,
    targetsReset: affectedTargets.length,
    cursorRolledBackTo: earliestRollback?.toISOString(),
  };

  if (opts.noFetch) {
    log('--no-fetch: skipping the poll pass. Run one (pnpm serve → poll) to re-ingest.');
    return result;
  }

  log('re-fetching…');
  result.report = await runPollPass(deps);
  log('re-fetch complete: ' + JSON.stringify(result.report));
  return result;
}

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const sinceArg = argValue('--since');
  const since = sinceArg ? new Date(sinceArg) : undefined;
  if (sinceArg && Number.isNaN(since!.getTime())) {
    throw new Error(`--since is not a valid date: "${sinceArg}"`);
  }

  const config = loadConfig();
  const { store, email, extractor } = buildAgent(config);

  await refetchReplies(
    { store, email, extractor, clock: systemClock },
    {
      since,
      includeExcluded: process.argv.includes('--include-excluded'),
      noFetch: process.argv.includes('--no-fetch'),
      dryRun: process.argv.includes('--dry-run'),
      log: (m) => console.log(m),
    },
  );

  await store.close?.();
}

// Only run as a CLI, not when imported by tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
