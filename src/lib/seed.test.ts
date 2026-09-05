import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../config';
import { MemoryStore } from '../adapters/store/memory.store';
import { assertSeedSafe, seedDemoStore, seedRequested } from './seed';

/** A config built from an explicit env, so nothing leaks in from the shell. */
function configFor(env: Record<string, string>): ReturnType<typeof loadConfig> {
  return loadConfig(env as NodeJS.ProcessEnv);
}

test('seedRequested is off unless SEED asks for it', () => {
  assert.equal(seedRequested({} as NodeJS.ProcessEnv), false);
  assert.equal(seedRequested({ SEED: '' } as NodeJS.ProcessEnv), false);
  assert.equal(seedRequested({ SEED: 'demo' } as NodeJS.ProcessEnv), true);
});

test('seedRequested rejects an unknown fixture set rather than silently skipping', () => {
  assert.throws(
    () => seedRequested({ SEED: 'production' } as NodeJS.ProcessEnv),
    /not a known fixture set/,
  );
});

test('assertSeedSafe allows a memory store with the dummy transport', () => {
  assert.doesNotThrow(() => assertSeedSafe(configFor({ STORE: 'memory' })));
  // STORE unset defaults to memory — the normal local case.
  assert.doesNotThrow(() => assertSeedSafe(configFor({})));
});

test('assertSeedSafe refuses to write fixtures into a real store', () => {
  assert.throws(() => assertSeedSafe(configFor({ STORE: 'pouchdb' })), /must never be written/);
});

test('assertSeedSafe refuses to seed a process that can send real mail', () => {
  // The fixtures carry an ACTIVE account, and serve.ts starts the drip
  // scheduler unconditionally — memory storage would not stop the mail leaving.
  assert.throws(
    () => assertSeedSafe(configFor({ STORE: 'memory', EMAIL_PROVIDER: 'smtp-imap' })),
    /live email transport/,
  );
});

test('seedDemoStore populates enough for the dashboard to be usable', async () => {
  const store = new MemoryStore();
  const seeded = await seedDemoStore(store, new Date('2026-09-05T10:00:00Z'));

  assert.equal((await store.listBatches()).length, 1);
  assert.equal((await store.listAccounts()).length, 1);

  const targets = await store.listTargets();
  assert.equal(targets.length, 2);
  assert.ok(targets.every((t) => t.status === 'pending'));
  assert.equal(targets[0]!.batchId, seeded.batch.id);
  // Distinct ids — the second target is spread from the first.
  assert.notEqual(targets[0]!.id, targets[1]!.id);
});

test('seedDemoStore leaves nothing behind between stores', async () => {
  const a = new MemoryStore();
  const b = new MemoryStore();
  await seedDemoStore(a);
  assert.equal((await b.listTargets()).length, 0);
});
