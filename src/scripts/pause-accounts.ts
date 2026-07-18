// Pause (or resume) every account directly in the store, so the app/scheduler can
// run without sending or polling. A paused account is skipped by send-pass,
// poll-pass, and fetch-pass alike.
//
//     STORE=pouchdb pnpm accounts:pause            # pause all
//     STORE=pouchdb pnpm accounts:pause --resume   # set all back to active

import 'dotenv/config';
import { loadConfig } from '../config';
import { buildStore } from '../lib/factory';

async function main() {
  const resume = process.argv.includes('--resume');
  const next = resume ? 'active' : 'paused';
  const store = buildStore(loadConfig());
  const accounts = await store.listAccounts();
  for (const a of accounts) {
    if (a.status === next) continue;
    await store.updateAccount(a.id, (c) => ({ ...c, status: next }));
    console.log(`${a.email}: ${a.status} → ${next}`);
  }
  console.log(`done — ${accounts.length} account(s) now ${next}.`);
  await store.close?.();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
