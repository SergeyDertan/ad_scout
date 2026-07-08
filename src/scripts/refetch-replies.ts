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
//                       to just before the earliest one.
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
  const { store, clock } = deps;
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

  if (replies.length === 0) {
    log('No replies match — nothing to re-fetch.');
    return { removed: 0, targetsReset: 0 };
  }

  // Targets to roll back to 'contacted' so they re-enter the awaiting set and the
  // pipeline re-derives status on re-ingest.
  const affectedTargets = [
    ...new Set(replies.map((r) => r.targetId).filter((id): id is string => Boolean(id))),
  ]
    .map((id) => targetsById.get(id))
    .filter((t): t is Target => Boolean(t) && (opts.includeExcluded || t!.status !== 'excluded'));

  // Cursor rollback point: the caller's --since, else just before the earliest
  // reply we're removing (a 60s buffer keeps the boundary message inclusive).
  const earliest = replies.reduce(
    (min, r) => Math.min(min, new Date(r.receivedAt).getTime()),
    Number.POSITIVE_INFINITY,
  );
  const rollbackTo = opts.since ?? new Date(earliest - 60_000);
  const accounts = await store.listAccounts();

  log(
    `${opts.dryRun ? '[dry-run] ' : ''}removing ${replies.length} repl(y/ies) + extraction(s), ` +
      `resetting ${affectedTargets.length} target(s) to 'contacted', ` +
      `rolling ${accounts.length} account cursor(s) back to ${rollbackTo.toISOString()}` +
      (opts.noFetch ? '' : ', then re-fetching'),
  );

  if (opts.dryRun) {
    return {
      removed: replies.length,
      targetsReset: affectedTargets.length,
      cursorRolledBackTo: rollbackTo.toISOString(),
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
    await store.updateAccount(a.id, (current) => ({
      ...current,
      pollCursor: { mailbox: 'INBOX', lastPolledAt: rollbackTo.toISOString() },
    }));
  }

  log(`removed ${replies.length} reply(ies); cursors rolled back.`);

  const result: RefetchResult = {
    removed: replies.length,
    targetsReset: affectedTargets.length,
    cursorRolledBackTo: rollbackTo.toISOString(),
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
