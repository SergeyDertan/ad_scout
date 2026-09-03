// Dump every document in the store to a directory of NDJSON files, plus a
// manifest of per-type counts. The other half is `data:load`.
//
//     STORE=pouchdb pnpm data:dump                  # → ./data-dump/
//     STORE=pouchdb pnpm data:dump --out /tmp/snap
//
// The work itself lives in services/dump.ts, shared with the scheduled backup
// service — a backup in a format `data:load` has never read is a backup with an
// untested restore path.
//
// The store is opened the normal way, so if `pnpm serve` is running this fails
// with a LevelDB lock error rather than reading a database mid-write — which is
// exactly the hazard that makes copying data/pouch by hand a bad idea. (The
// backup service has no such problem: it runs *inside* the server.)

import 'dotenv/config';
import { loadConfig } from '../config';
import { applyTimezone } from '../lib/timezone';
import { buildStore } from '../lib/factory';
import { describeSource, dumpStore } from '../services/dump';

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i === -1 || i + 1 >= process.argv.length ? undefined : process.argv[i + 1];
}

async function main(): Promise<void> {
  applyTimezone();
  const outDir = argValue('--out') ?? './data-dump';
  const config = loadConfig();
  const store = buildStore(config);

  const manifest = await dumpStore(store, outDir, describeSource(config.store), (name, count) =>
    console.log(`${String(count).padStart(7)}  ${name}`),
  );

  const total = Object.values(manifest.counts).reduce((a, b) => a + b, 0);
  console.log(`\ndumped ${total} doc(s) to ${outDir}/ — load with: pnpm data:load --in ${outDir}`);
  await store.close?.();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  console.error('\nIf this is a LevelDB lock error, stop `pnpm serve` first — the store is single-process.');
  process.exit(1);
});
