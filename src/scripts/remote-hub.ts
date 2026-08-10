// Serve unextracted replies to worker machines, and write back what they return.
// The database lives HERE; the model calls happen THERE (see server/remote-hub.ts
// for the protocol and scripts/remote-worker.ts for the other end).
//
//     STORE=pouchdb REMOTE_TOKEN=<secret> pnpm remote:hub
//     ngrok http 8788                       # in a second terminal
//
// Then on the other machine, against the ngrok URL:
//
//     REMOTE_HUB_URL=https://xxxx.ngrok-free.app REMOTE_TOKEN=<secret> pnpm remote:worker
//
//   --port N          worker-facing listen port (default 8788, or REMOTE_PORT).
//                     THIS is the one to publish; never expose the dashboard.
//   --ui-port N       dashboard port (default 8787, or PORT).
//   --no-ui           don't serve the dashboard at all (headless run).
//   --attempts N      tries per reply before it is marked 'failed' (default 3).
//   --max-failed N    failed replies tolerated before the hub stops handing out
//                     work (default 1 — the same backstop a local run applies).
//   --lease-ms MS     how long a claimed reply is held before re-offering it
//                     (default 20 min — must outlast a slow extraction).
//   --wait-ms MS      how long a worker's claim is held open when idle (default 20s).
//   --until-empty     shut down once every reply is extracted, instead of
//                     waiting for more. For unattended runs.
//
// THE DASHBOARD RUNS HERE. Because this process holds the store (and the lock),
// `pnpm serve` cannot run alongside it — so the hub serves the same UI and SSE
// change feed itself, on the same port serve.ts uses. Watching a remote run in
// the browser therefore works exactly as it always does: replies flip to
// extracted, targets to 'replied', prices appear, live. Manual "Run now" buttons
// work too, serialized against incoming remote results by one shared lock.
//
// Exit codes match reextract:stored, so the same wrappers work:
//   0  nothing left pending.
//   3  some replies are left 'failed' (re-run to retry them).
//   1  fatal.
//
// LOCKING: this takes the same process lock `pnpm serve` does, because it is a
// WRITER — PouchDB is single-process, and two writers racing the same doc's _rev
// is exactly the corruption the lock exists to prevent. Stop the server first.

import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { loadConfig } from '../config';
import { buildAgent } from '../lib/factory';
import { systemClock } from '../lib/clock';
import { describeError } from '../lib/errors';
import { acquireLock, LockHeldError } from '../lib/lock';
import { enableFileLogging, logger } from '../lib/logger';
import { Mutex } from '../lib/mutex';
import { runFetchPass } from '../pipeline/fetch-pass';
import { runPollPass } from '../pipeline/poll-pass';
import { runSendPass } from '../pipeline/send-pass';
import { createApiServer } from '../server/app';
import { createRemoteHub, type HubEvent } from '../server/remote-hub';

function numArg(flag: string): number | undefined {
  const i = process.argv.indexOf(flag);
  if (i === -1 || i + 1 >= process.argv.length) return undefined;
  const n = Number(process.argv[i + 1]);
  return Number.isFinite(n) ? n : undefined;
}

/** "2m36s" / "14s" — durations at a glance in the progress log. */
function fmtMs(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m${String(s % 60).padStart(2, '0')}s`;
}

function clock(): string {
  return new Date().toLocaleTimeString();
}

/** One line per event — this is the "is it working?" view of a remote run. */
function report(ev: HubEvent): void {
  const at = clock();
  switch (ev.kind) {
    case 'claimed':
      console.log(
        `[${at}] claim  ${ev.site} → ${ev.workerId} (${ev.model}) attempt ${ev.attempt} · ${ev.pending} pending`,
      );
      break;
    case 'done':
      console.log(
        `[${at}] ${ev.outcome === 'ignored' ? 'spam ' : 'ok   '} ${ev.site} ← ${ev.workerId} · ` +
          `${ev.outcome === 'ignored' ? 'ignored' : `${ev.offers} offer(s)`} in ${fmtMs(ev.ms)}`,
      );
      break;
    case 'failed':
      console.log(
        `[${at}] ${ev.givingUp ? 'FAIL ' : 'retry'} ${ev.site} ← ${ev.workerId} ` +
          `attempt ${ev.attempt} · ${ev.message.slice(0, 140)}`,
      );
      break;
    case 'limit':
      console.log(
        `[${at}] LIMIT  ${ev.workerId} hit its usage window${ev.resetAt ? ` — resets ${new Date(ev.resetAt).toLocaleString()}` : ''}` +
          ` · reply re-queued, nothing lost`,
      );
      break;
    case 'expired':
      console.log(`[${at}] lease  ${ev.site} expired (${ev.workerId} went away) — re-queued`);
      break;
    case 'aborted':
      console.log(
        `\n[${at}] ABORT  ${ev.site} failed every attempt — not handing out more work.\n` +
          `         Whatever is failing is not transient, and the rest of the queue would hit it too.\n` +
          `         Check logs/adscout-<date>.log (an unrecognized usage limit or a broken worker looks like this).\n` +
          `         Re-run to resume — the ${ev.failedReplies} failed repl(y/ies) are re-picked.\n`,
      );
      break;
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  const port = numArg('--port') ?? Number(process.env.REMOTE_PORT ?? 8788);
  const uiPort = numArg('--ui-port') ?? Number(process.env.PORT ?? 8787);
  const withUi = !process.argv.includes('--no-ui');
  const untilEmpty = process.argv.includes('--until-empty');

  // A token is not optional: this endpoint is meant to be published through a
  // tunnel, and it writes to the database. Generate one rather than start naked.
  let token = process.env.REMOTE_TOKEN?.trim();
  const generated = !token;
  if (!token) token = randomBytes(24).toString('base64url');

  const logDir = process.env.LOG_DIR === 'off' ? null : enableFileLogging();

  let lock;
  try {
    lock = acquireLock(config.lockPath);
  } catch (err) {
    if (err instanceof LockHeldError) {
      logger.error(`${err.message} — stop \`pnpm serve\` first: the hub writes to the same database.`);
      process.exit(1);
    }
    throw err;
  }

  const agent = buildAgent(config);
  const { store, email, extractor } = agent;
  const deps = { store, email, extractor, clock: systemClock, config };

  // ONE lock across everything that writes in this process: results arriving from
  // workers, and any pass a "Run now" button starts. Without it a manual poll and
  // a remote result would race the same target/niche/prompt docs.
  const writeLock = new Mutex();

  const hub = createRemoteHub(deps, {
    token,
    writeLock,
    ...(numArg('--attempts') != null ? { attempts: numArg('--attempts')! } : {}),
    ...(numArg('--max-failed') != null ? { maxFailed: numArg('--max-failed')! } : {}),
    ...(numArg('--lease-ms') != null ? { leaseMs: numArg('--lease-ms')! } : {}),
    ...(numArg('--wait-ms') != null ? { claimWaitMs: numArg('--wait-ms')! } : {}),
    onEvent: report,
  });

  // The dashboard, served from this process because `pnpm serve` cannot run while
  // the hub holds the store. Same app, same SSE change feed — so the browser
  // shows remote extractions landing live, with no polling of its own.
  const ui = withUi
    ? createApiServer({
        store,
        config,
        clock: systemClock,
        runSend: (o) => writeLock.run(() => runSendPass({ store, email, clock: systemClock, config }, o)),
        runPoll: (o) => writeLock.run(() => runPollPass(deps, o)),
        runFetch: (o) => writeLock.run(() => runFetchPass({ store, email, clock: systemClock }, o)),
        webDir: process.env.WEB_DIR ?? './web/dist',
        providers: {
          llm: agent.llm.name,
          email: config.dummyEmail ? 'dummy' : 'real',
          store: config.store,
        },
        ...(agent.gmailOAuth ? { gmailOAuth: agent.gmailOAuth } : {}),
      })
    : undefined;

  const pending = await hub.pendingCount();
  ui?.listen(uiPort, () => {
    console.log(`\n  dashboard: http://localhost:${uiPort}  — watch replies land here as workers finish them`);
  });
  hub.server.listen(port, () => {
    console.log(`\nAdScout remote hub on http://localhost:${port}  ·  store=${config.store}  ·  ${pending} reply(ies) pending`);
    console.log(`\n  1. publish it:   ngrok http ${port}   (this port ONLY — never the dashboard)`);
    console.log(`  2. on the other machine, against the URL ngrok prints:\n`);
    console.log(`       REMOTE_HUB_URL=https://xxxx.ngrok-free.app \\`);
    console.log(`       REMOTE_TOKEN=${token} \\`);
    console.log(`       CLAUDE_CODE_MODEL=${config.claudeCode.model} pnpm remote:worker\n`);
    if (generated) console.log('  (token generated for this run — set REMOTE_TOKEN in .env to keep it stable)\n');
    if (logDir) console.log(`  logging to ${logDir}/adscout-<date>.log\n`);
    console.log('  waiting for workers… (Ctrl-C to stop; nothing is lost, replies stay pending)\n');
  });

  // Periodic heartbeat so an idle terminal still shows the run is alive and where
  // it stands — a single extraction can take minutes with no other output.
  const ticker = setInterval(() => {
    const s = hub.stats();
    const inFlight = s.inFlight.map((f) => `${f.site} ${fmtMs(f.sinceMs)}`).join(', ');
    void hub.pendingCount().then((left) => {
      console.log(
        `[${clock()}] · ${left} pending · ${s.inFlight.length} in flight${inFlight ? ` (${inFlight})` : ''} · ` +
          `${s.done} done, ${s.ignored} spam, ${s.failed} failed, ${s.retried} retried` +
          (s.workers.length ? ` · workers: ${s.workers.map((w) => `${w.id}(${w.done}✓/${w.failed}✗)`).join(' ')}` : ''),
      );
    });
  }, 60_000);
  ticker.unref?.();

  let finishing = false;
  const finish = (code: number): void => {
    if (finishing) return;
    finishing = true;
    clearInterval(ticker);
    const s = hub.stats();
    console.log(
      `\nremote hub stopped — ${s.done} extracted, ${s.ignored} spam, ${s.failed} failed, ` +
        `${s.retried} retried, ${s.limits} usage-limit pause(s).`,
    );
    if (s.failed > 0) console.log(`${s.failed} reply(ies) left 'failed' — re-run to retry just those.`);
    hub.server.close();
    ui?.close();
    void store.close?.();
    lock.release();
    process.exit(code);
  };

  if (untilEmpty) {
    // Only after a worker has actually taken something: starting with an empty
    // queue and exiting immediately would defeat an unattended wrapper that
    // launches the hub before the worker connects.
    const drain = setInterval(() => {
      void hub.pendingCount().then((left) => {
        const s = hub.stats();
        if (s.inFlight.length > 0) return;
        // Aborted ⇒ work is left pending on purpose; waiting for the queue to
        // empty would hang forever. Exit 3 so a wrapper retries, same as
        // reextract:stored's stoppedByFailures.
        if (s.aborted) {
          clearInterval(drain);
          finish(3);
        } else if (s.claimed > 0 && left === 0) {
          console.log('\n--until-empty: every reply extracted.');
          clearInterval(drain);
          finish(s.failed > 0 ? 3 : 0);
        }
      });
    }, 5_000);
    drain.unref?.();
  }

  process.on('SIGINT', () => finish(hub.stats().failed > 0 ? 3 : 0));
  process.on('SIGTERM', () => finish(hub.stats().failed > 0 ? 3 : 0));
}

main().catch((err) => {
  logger.error('remote:hub aborted', { ...describeError(err) });
  process.exit(1);
});
