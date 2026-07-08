// One-time repair: an 'initial' outreach that's confirmed 'sent' but whose
// target is still 'pending'/'reserved' means the post-send target-status
// update was lost (the write-conflict bug fixed earlier — pre-fix casualty).
// Re-applies exactly the same status transition sendOne() would have made.
//
//     pnpm fix:stuck-targets

import 'dotenv/config';
import { loadConfig } from '../config';
import { buildStore } from '../lib/factory';

async function main() {
  const config = loadConfig();
  const store = buildStore(config);

  const outreaches = await store.listOutreaches();
  const targets = await store.listTargets();
  const targetById = new Map(targets.map((t) => [t.id, t]));

  const mismatches = outreaches.filter((o) => {
    if (o.kind !== 'initial' || o.status !== 'sent') return false;
    const t = targetById.get(o.targetId);
    return t && (t.status === 'pending' || t.status === 'reserved');
  });

  console.log(`found ${mismatches.length} target(s) to fix`);

  for (const o of mismatches) {
    const before = targetById.get(o.targetId)!;
    const updated = await store.updateTarget(o.targetId, (t) =>
      t.status === 'pending' || t.status === 'reserved'
        ? { ...t, status: 'contacted', assignedAccountId: o.accountId, lastOutreachAt: o.sentAt ?? t.lastOutreachAt }
        : t,
    );
    console.log(`  ${o.targetId}: ${before.status} -> ${updated.status}`);
  }

  await store.close?.();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
