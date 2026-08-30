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
import { DripScheduler } from './scheduler/scheduler';
import { loadPublishConfig, publishEnabled, SnapshotPublisher } from './services/publisher';

async function main(): Promise<void> {
  const config = loadConfig();
  const clock = systemClock;
  const port = Number(process.env.PORT ?? 8787);

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

  server.listen(port, () => {
    logger.info(`AdScout server on http://localhost:${port}`, {
      providers: { llm: agent.llm.name, email: config.dummyEmail ? 'dummy' : 'real', store: config.store },
    });
    scheduler.start();
  });

  const shutdown = () => {
    logger.info('shutting down');
    scheduler.stop();
    detachPublisher?.();
    server.close();
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
