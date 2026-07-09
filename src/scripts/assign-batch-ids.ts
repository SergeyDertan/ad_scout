// One-time backfill for the batch model. Two idempotent steps:
//   1. Stamp a batchId on any target created before batches existed.
//   2. Create a Batch record for every distinct batchId that doesn't have one.
// All pre-existing targets came from a single import, so the one legacy batch is
// named 'first'. Safe to re-run.
//
//     pnpm assign:batch-ids

import 'dotenv/config';
import { loadConfig } from '../config';
import { buildStore } from '../lib/factory';
import { newId } from '../lib/ids';
import type { Batch, Target } from '../domain/types';

async function main() {
  const config = loadConfig();
  const store = buildStore(config);

  // 1) Ensure every target carries a batchId.
  const before = await store.listTargets();
  const missing = before.filter((t) => !t.batchId);
  if (missing.length > 0) {
    const batchId = newId('batch');
    console.log(`assigning ${missing.length} target(s) without a batchId to ${batchId}`);
    for (const t of missing) {
      await store.updateTarget(t.id, (cur) => (cur.batchId ? cur : { ...cur, batchId }));
    }
  } else {
    console.log('all targets already have a batchId');
  }

  // 2) Create a Batch record for any distinct batchId that lacks one.
  const targets = await store.listTargets();
  const existing = new Set((await store.listBatches()).map((b) => b.id));

  const groups = new Map<string, Target[]>();
  for (const t of targets) {
    if (!t.batchId) continue;
    const arr = groups.get(t.batchId) ?? [];
    arr.push(t);
    groups.set(t.batchId, arr);
  }

  const toCreate = [...groups.keys()].filter((id) => !existing.has(id));
  console.log(`${groups.size} batch id(s) on targets; ${toCreate.length} need a Batch record`);

  for (const id of toCreate) {
    const arr = groups.get(id)!;
    // Uniform campaign in practice; fall back to the first target's campaign.
    const campaignId = arr[0]!.campaignId;
    const createdAt = arr.reduce((min, t) => (t.createdAt < min ? t.createdAt : min), arr[0]!.createdAt);
    // The single legacy batch is 'first'; label any others by their short id.
    const name = toCreate.length === 1 ? 'first' : `legacy ${id.replace(/^batch_/, '').slice(0, 8)}`;
    const batch: Batch = { id, campaignId, name, source: 'import', createdAt };
    await store.putBatch(batch);
    console.log(`  created batch ${id} name="${name}" campaign=${campaignId} targets=${arr.length}`);
  }
  console.log('done');

  await store.close?.();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
