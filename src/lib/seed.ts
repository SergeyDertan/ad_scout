// Demo fixtures for a throwaway local run.
//
// WHY THIS EXISTS: after the VPS migration the laptop must never write to the
// live dataset, so the local `.env` runs on `STORE=memory` — fresh at boot, gone
// at Ctrl-C. That is safe and, on its own, useless: the dashboard comes up
// empty. This seeds it, so `SEED=demo pnpm dev` gives a real console with real
// data that cannot outlive the process or reach a real mailbox.
//
// The same fixtures back `pnpm demo` (src/index.ts), so there is one set of
// them rather than two that drift.
//
// TWO GUARDS, both fatal at boot rather than discovered later — see
// `assertSeedSafe`. Seeding is only ever allowed to invent data in a store that
// evaporates, on a process that cannot send mail.

import type { Config } from '../config';
import type { Account, Batch, Target } from '../domain/types';
import type { Store } from '../ports/store';
import { newId } from './ids';

export interface SeedResult {
  batch: Batch;
  account: Account;
  targets: Target[];
}

/** Is `SEED` asking for fixtures? Throws on a value that is not a known set. */
export function seedRequested(env: NodeJS.ProcessEnv = process.env): boolean {
  const want = env.SEED?.trim();
  if (!want) return false;
  if (want !== 'demo') {
    throw new Error(`SEED="${want}" is not a known fixture set. The only value is "demo".`);
  }
  return true;
}

/**
 * Refuse to seed anything that could outlive the process or reach a real
 * recipient.
 *
 * The store check is the obvious one. The email check is the one that would
 * actually hurt: the fixtures include an *active* account and targets with
 * real-looking contact addresses, and `serve` starts the drip scheduler
 * unconditionally — so a seeded boot with a live transport would mail strangers
 * within the send window. `STORE=memory` alone does not save you there, because
 * the mail has already left by the time the store evaporates.
 */
export function assertSeedSafe(config: Config): void {
  if (config.store !== 'memory') {
    throw new Error(
      `SEED=demo refuses to run with STORE=${config.store} — fixtures must never be written to a ` +
        'real store. Use STORE=memory (the default when STORE is unset).',
    );
  }
  if (!config.dummyEmail) {
    throw new Error(
      'SEED=demo refuses to run with a live email transport: the fixtures include an active ' +
        'account and the drip scheduler would send to them. Unset EMAIL_PROVIDER (or set it to ' +
        '"dummy") for a seeded run.',
    );
  }
}

/**
 * Populate `store` with one batch, one active account and two pending targets —
 * enough for the dashboard to be worth opening and for "Run now" to exercise the
 * whole pipeline.
 */
export async function seedDemoStore(store: Store, now: Date = new Date()): Promise<SeedResult> {
  const nowIso = now.toISOString();

  // The advertised site + topic/format come from global config (config.pitch);
  // an import is just a batch of target websites (optionally with its own
  // advertised override, omitted here so the global default is used).
  const batch: Batch = {
    id: newId('batch'),
    name: 'Casino outreach — demo import',
    source: 'import',
    createdAt: nowIso,
  };
  await store.putBatch(batch);

  const account: Account = {
    id: newId('account'),
    email: 'vlad@example.com',
    providerType: 'smtp-imap',
    credentialRef: 'VLAD_GMAIL',
    senderName: 'Vlad',
    status: 'active',
    createdAt: nowIso,
    maxDailyLimit: 40,
  };
  await store.putAccount(account);

  const first: Target = {
    id: newId('target'),
    batchId: batch.id,
    websiteUrl: 'egamersworld.com',
    contactEmail: 'info@egamersworld.com',
    status: 'pending',
    followUpCount: 0,
    createdAt: nowIso,
  };
  const second: Target = {
    ...first,
    id: newId('target'),
    websiteUrl: 'example-gaming.com',
    contactEmail: 'editor@example-gaming.com',
  };
  await store.putTarget(first);
  await store.putTarget(second);

  return { batch, account, targets: [first, second] };
}
