// Real boot: lock → reconcile → HTTP/SSE server → drip scheduler.
//   pnpm serve                  (defaults: dummy providers, memory store)
// Switch providers/store via .env (see .env.example).

import 'dotenv/config';
import { loadConfig } from './config';
import { buildAgent } from './lib/factory';
import { acquireLock, LockHeldError } from './lib/lock';
import { systemClock } from './lib/clock';
import { enableFileLogging, logger } from './lib/logger';
import { makeTcpProbe } from './lib/reachability';
import { Mutex } from './lib/mutex';
import { runReconcile } from './pipeline/reconcile';
import { runSendPass } from './pipeline/send-pass';
import { runPollPass } from './pipeline/poll-pass';
import { runFetchPass } from './pipeline/fetch-pass';
import { totalRemainingToday } from './pipeline/quota';
import { createApiServer } from './server/app';
import { createRemoteHub, type HubEvent } from './server/remote-hub';
import { DripScheduler } from './scheduler/scheduler';
import { loadPublishConfig, publishEnabled, SnapshotPublisher } from './services/publisher';

/**
 * Hub progress, as log lines rather than console output: this process runs
 * headless under a service manager, so extraction activity has to survive into
 * logs/adscout-<date>.log the same way every other pass does.
 */
function reportHubEvent(ev: HubEvent): void {
  switch (ev.kind) {
    case 'claimed':
      logger.info('remote claim', { site: ev.site, worker: ev.workerId, model: ev.model, attempt: ev.attempt, pending: ev.pending });
      break;
    case 'done':
      logger.info('remote extracted', { site: ev.site, worker: ev.workerId, outcome: ev.outcome, offers: ev.offers, ms: ev.ms });
      break;
    case 'failed':
      logger.error('remote extraction failed', { site: ev.site, worker: ev.workerId, attempt: ev.attempt, givingUp: ev.givingUp, message: ev.message });
      break;
    case 'limit':
      logger.warn('remote worker hit its usage window — reply re-queued', { worker: ev.workerId, ...(ev.resetAt ? { resetAt: ev.resetAt } : {}) });
      break;
    case 'expired':
      logger.warn('remote lease expired — reply re-queued', { site: ev.site, worker: ev.workerId });
      break;
    case 'aborted':
      // Terminal for this process: `aborted` never clears, so extraction is done
      // until a restart. Loud on purpose — see REMOTE_MAX_FAILED above.
      logger.error('remote hub STOPPED handing out work — a reply failed every attempt; restart to resume', {
        site: ev.site,
        failedReplies: ev.failedReplies,
      });
      break;
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  const clock = systemClock;
  const port = Number(process.env.PORT ?? 8787);

  // Which interface to listen on. Unset = every interface, which is Node's own
  // default and right for a laptop. On a public host set BIND_HOST=127.0.0.1:
  // nginx reaches both servers over loopback anyway (and so does an SSH tunnel
  // to the hub), so binding loopback makes a forgotten firewall rule harmless
  // instead of publishing the dashboard and the hub to the internet.
  //
  // Left unset the listen() call omits `host` entirely rather than passing
  // 0.0.0.0 — that keeps today's dual-stack IPv6 behaviour exactly as it was.
  const bindHost = process.env.BIND_HOST?.trim() || undefined;
  const listenOn = (p: number) => ({ port: p, ...(bindHost ? { host: bindHost } : {}) });

  // Tee all logs to a daily JSONL file so failures that happen while unattended
  // (laptop asleep overnight) survive a closed terminal. LOG_DIR=off disables.
  const logDir = process.env.LOG_DIR === 'off' ? null : enableFileLogging();
  if (logDir) logger.info('file logging enabled', { dir: logDir });

  let lock;
  try {
    lock = acquireLock(config.lockPath);
  } catch (err) {
    if (err instanceof LockHeldError) {
      logger.error(err.message);
      process.exit(1);
    }
    throw err;
  }

  const agent = buildAgent(config);
  const { store, email, extractor, gmailOAuth } = agent;

  const sendDeps = { store, email, clock, config };
  const pollDeps = { store, email, extractor, clock, config };
  const fetchDeps = { store, email, clock };

  // One shared mutex serializes every pass — scheduled AND manual "Run now" —
  // so overlapping runs queue instead of racing the store's read-modify-writes.
  const passLock = new Mutex();

  const rec = await runReconcile({ store, email, clock, config });
  logger.info('reconcile', rec as unknown as Record<string, unknown>);

  // Read-only snapshot for the shared viewer (Firebase). Driven off the store's
  // change feed rather than any one pass, so a poll cycle, an extraction and a
  // hand-edit all trigger it; debounced, so a burst publishes once at the end.
  // Unconfigured (no SNAPSHOT_BUCKET) is the normal local case — a no-op.
  const publishConfig = publishEnabled() ? loadPublishConfig() : null;
  const publisher = publishConfig ? new SnapshotPublisher(store, clock, publishConfig) : null;
  const detachPublisher = publisher?.attach();
  if (publisher) {
    logger.info('snapshot publishing enabled', {
      bucket: publishConfig!.bucket,
      prefix: publishConfig!.prefix,
      debounceMs: publishConfig!.debounceMs,
    });
    // Publish once at boot so the viewer reflects anything that changed while
    // the server was down (scripts, hand-edits, a restore from backup).
    publisher.schedule();
  }

  const server = createApiServer({
    store,
    config,
    clock,
    runSend: (opts) => passLock.run(() => runSendPass(sendDeps, opts)),
    runPoll: (opts) => passLock.run(() => runPollPass(pollDeps, opts)),
    runFetch: (opts) => passLock.run(() => runFetchPass(fetchDeps, opts)),
    // Built front-end (web/ is a separate Vite + React + Chakra module).
    // Run `pnpm web:build` first; in dev use `pnpm web:dev` (proxies /api).
    webDir: process.env.WEB_DIR ?? './web/dist',
    providers: { llm: agent.llm.name, email: config.dummyEmail ? 'dummy' : 'real', store: config.store },
    gmailOAuth,
    email: agent.email, // deal messages are sent straight from the Deals UI
  });

  const scheduler = new DripScheduler({
    clock,
    window: config.sendWindow,
    runSend: () => passLock.run(() => runSendPass(sendDeps, { maxPerAccount: 1 })),
    runPoll: () => passLock.run(() => runFetchPass(fetchDeps)),
    // Gmail incremental history sync makes each idle poll cheap, so we don't need
    // a tight cadence — 5 min keeps reply latency low without busy-looping.
    // Override with POLL_INTERVAL_MS.
    pollIntervalMs: Number(process.env.POLL_INTERVAL_MS ?? 5 * 60_000),
    quotaRemaining: () => totalRemainingToday(store, config, clock.now()),
    // Pause the drip loops (and log one line per outage) when the mail host is
    // unreachable — e.g. Wi-Fi down or the laptop was asleep. Dummy-email runs
    // have no real host to reach, so only enable it for real providers.
    ...(config.dummyEmail ? {} : { reachable: makeTcpProbe() }),
  });

  // --- Remote extraction hub -------------------------------------------------
  // Extraction runs against a Claude Code subscription bound to a logged-in
  // desktop (adapters/llm/claude-code.provider.ts strips ANTHROPIC_API_KEY so it
  // cannot silently fall back to per-token billing), and no server can hold that
  // session. So this process is the HUB: it owns the database and hands
  // unextracted replies to `pnpm remote:worker` on that desktop, which dials IN.
  // The worker never listens on anything, so it needs no tunnel and no fixed
  // address — only this port has to be reachable.
  //
  // It shares `passLock` with every pipeline pass: a worker's result and a
  // scheduled send both write the store, and PouchDB's read-_rev-then-write is
  // exactly the race that lock exists to prevent.
  //
  // On by default; REMOTE_HUB=off disables it. A token is mandatory (the port is
  // published), so an unset REMOTE_TOKEN skips the hub rather than starting a
  // writable endpoint naked, or churning a random token every restart and
  // silently locking the worker out.
  const hubEnabled = !/^(0|false|no|off)$/i.test(process.env.REMOTE_HUB?.trim() ?? '');
  const remoteToken = process.env.REMOTE_TOKEN?.trim();
  let hub: ReturnType<typeof createRemoteHub> | undefined;

  if (hubEnabled && !remoteToken) {
    logger.error(
      'REMOTE extraction hub NOT started: REMOTE_TOKEN is unset. Replies will be ' +
        'fetched but never extracted. Set REMOTE_TOKEN in .env (same value on the ' +
        'worker), or set REMOTE_HUB=off to silence this.',
    );
  } else if (hubEnabled) {
    hub = createRemoteHub(pollDeps, {
      token: remoteToken!,
      writeLock: passLock,
      // The hub's own default is 1, matching a one-shot re-extract campaign that
      // should stop the moment something systemic breaks. That is wrong for a
      // server: `aborted` never clears, so one poison reply would silently end
      // extraction until the next restart. Keep a backstop, set it far enough
      // out that only a genuinely systemic failure trips it.
      maxFailed: Number(process.env.REMOTE_MAX_FAILED ?? 10),
      onEvent: reportHubEvent,
    });
  }

  server.listen(listenOn(port), () => {
    logger.info(`AdScout server on http://localhost:${port}`, {
      bind: bindHost ?? 'all interfaces',
      providers: { llm: agent.llm.name, email: config.dummyEmail ? 'dummy' : 'real', store: config.store },
    });
    scheduler.start();
    if (hub) {
      const remotePort = Number(process.env.REMOTE_PORT ?? 8788);
      hub.server.listen(listenOn(remotePort), () => {
        logger.info(
          `remote extraction hub on :${remotePort} — run \`pnpm remote:worker\` on the machine holding the Claude subscription`,
          { bind: bindHost ?? 'all interfaces' },
        );
      });
    }
  });

  const shutdown = () => {
    logger.info('shutting down');
    scheduler.stop();
    detachPublisher?.();
    server.close();
    hub?.server.close();
    void store.close?.();
    lock.release();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  logger.error('fatal', { error: err instanceof Error ? err.stack : String(err) });
  process.exit(1);
});
