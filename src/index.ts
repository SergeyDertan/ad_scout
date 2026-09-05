// Entry point. With the default config (memory store + dummy email + dummy LLM)
// this runs a full send → reply → poll → extract cycle end-to-end with no
// external services — a live demonstration of the pipeline. Swap providers via
// .env (LLM_PROVIDER / STORE / set EMAIL_PROVIDER=smtp-imap) to use Ollama/OpenAI/Claude,
// real SMTP/IMAP, and PouchDB.
//
//   pnpm demo

import 'dotenv/config';
import { loadConfig } from './config';
import { DummyEmailProvider } from './adapters/email/dummy.provider';
import { DummyLlmProvider } from './adapters/llm/dummy.provider';
import { MemoryStore } from './adapters/store/memory.store';
import { systemClock } from './lib/clock';
import { logger } from './lib/logger';
import { runPollPass } from './pipeline/poll-pass';
import { runReconcile } from './pipeline/reconcile';
import { runSendPass } from './pipeline/send-pass';
import { Extractor } from './services/extractor';
import { seedDemoStore } from './lib/seed';

async function main(): Promise<void> {
  const config = loadConfig();
  const store = new MemoryStore();
  const email = new DummyEmailProvider();
  const llm = new DummyLlmProvider();
  const extractor = new Extractor(llm);
  const clock = systemClock;

  logger.info('AdScout demo — dummy adapters (no external services)');
  const { targets } = await seedDemoStore(store);
  const target = targets[0]!;

  const rec = await runReconcile({ store, email, clock, config });
  logger.info('reconcile', rec as unknown as Record<string, unknown>);

  const sent = await runSendPass({ store, email, clock, config });
  logger.info('send-pass', sent as unknown as Record<string, unknown>);

  // Simulate a reply on the first target's thread (Gmail would have threaded it).
  const outreach = (await store.listOutreaches({ targetId: target.id })).find(
    (o) => o.status === 'sent',
  );
  if (outreach?.threadId) {
    email.injectReply({
      threadId: outreach.threadId,
      fromAddress: target.contactEmail,
      text: 'Yes, we can publish. Cost is $300. Categories: esports, betting, slots. Section: News.',
    });
  }

  const polled = await runPollPass({ store, email, extractor, clock, config });
  logger.info('poll-pass', polled as unknown as Record<string, unknown>);

  // Show final state.
  for (const t of await store.listTargets()) {
    logger.info(`target ${t.websiteUrl}`, {
      status: t.status,
      canPost: t.result?.canPost,
      offers: t.result?.offers,
    });
  }
  logger.info('Note: extraction here is stubbed by DummyLlmProvider. Set LLM_PROVIDER=ollama|openai|claude for real parsing.');
}

main().catch((err) => {
  logger.error('fatal', { error: err instanceof Error ? err.stack : String(err) });
  process.exit(1);
});
