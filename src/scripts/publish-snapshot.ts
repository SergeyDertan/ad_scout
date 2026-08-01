// Publish the read-only snapshot a coworker's viewer reads from Firebase.
//
//     STORE=pouchdb pnpm publish:snapshot
//     STORE=pouchdb pnpm publish:snapshot --dry-run     (build only, no upload)
//     STORE=pouchdb pnpm publish:snapshot --out ./tmp   (write the files locally)
//
// The server publishes automatically after every change (see src/serve.ts); this
// is the manual path — a first publish, a forced refresh, or a look at exactly
// what would be uploaded before any of it leaves the machine.
//
// Requires SNAPSHOT_BUCKET and SNAPSHOT_CREDENTIALS (see .env.example).

import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { loadConfig } from '../config';
import { buildAgent } from '../lib/factory';
import { systemClock } from '../lib/clock';
import { loadPublishConfig, SnapshotPublisher } from '../services/publisher';
import { buildSnapshot } from '../services/snapshot';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const outDir = arg('out');
  const config = loadConfig();
  const { store } = buildAgent(config);

  const snapshot = await buildSnapshot(store, systemClock);
  const totalBytes = snapshot.files.reduce((n, f) => n + Buffer.byteLength(f.body), 0);
  console.log(
    `built ${snapshot.files.length} files (${(totalBytes / 1e6).toFixed(2)} MB uncompressed) — ` +
      `${snapshot.manifest.counts.domains} domains, ${snapshot.manifest.counts.replies} replies`,
  );

  if (outDir) {
    const extras = [
      { path: 'manifest.json', body: JSON.stringify(snapshot.manifest) },
      { path: 'files.json', body: JSON.stringify(snapshot.fileHashes) },
    ];
    for (const f of [...snapshot.files, ...extras]) {
      const full = join(outDir, f.path);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, f.body);
    }
    console.log(`wrote snapshot to ${outDir}`);
  }

  if (dryRun || outDir) {
    await store.close?.();
    return;
  }

  const publishConfig = loadPublishConfig();
  if (!publishConfig) {
    console.error(
      'publishing is not configured — set SNAPSHOT_BUCKET and SNAPSHOT_CREDENTIALS in .env\n' +
        '(or run with --dry-run / --out <dir> to build without uploading)',
    );
    process.exit(1);
  }

  const publisher = new SnapshotPublisher(store, systemClock, publishConfig);
  const report = await publisher.publishNow();
  console.log(
    `published: ${report.uploaded} uploaded, ${report.unchanged} unchanged, ${report.deleted} deleted ` +
      `(${(report.bytes / 1e6).toFixed(2)} MB gzipped)`,
  );
  publisher.stop();
  await store.close?.();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
