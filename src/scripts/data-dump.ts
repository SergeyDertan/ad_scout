// Dump every document in the store to a directory of NDJSON files, plus a
// manifest of per-type counts. The other half is `data:load`.
//
//     STORE=pouchdb pnpm data:dump                  # → ./data-dump/
//     STORE=pouchdb pnpm data:dump --out /tmp/snap
//
// NDJSON (one doc per line), not one big JSON array: reply docs carry their
// attachments inline as base64, so the replies file is most of the 100 MB+ and
// a single JSON.stringify of it would be a needless 100 MB string in memory.
// Line-per-doc also means a truncated transfer is obvious instead of silent.
//
// The store is opened the normal way, so if `pnpm serve` is running this fails
// with a LevelDB lock error rather than reading a database mid-write — which is
// exactly the hazard that makes copying data/pouch by hand a bad idea.

import 'dotenv/config';
import { createWriteStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { once } from 'node:events';
import { loadConfig } from '../config';
import { buildStore } from '../lib/factory';
import { DOC_TYPES, type DumpManifest } from './data-types';

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i === -1 || i + 1 >= process.argv.length ? undefined : process.argv[i + 1];
}

/**
 * One NDJSON line. JSON.stringify leaves U+2028 (LINE SEPARATOR) and U+2029
 * (PARAGRAPH SEPARATOR) **raw** — they are legal inside a JSON string — but
 * line-oriented readers treat them as line breaks, which silently splits a
 * document in half. Real reply bodies contain them (they arrive in HTML mail),
 * so this is not theoretical: the first round-trip of this store turned 1200
 * replies into 1212 fragments and failed to parse.
 *
 * Escaping them is the fix at the source: `\u2028` parses back to the identical
 * string, and the file becomes safe for every line-based consumer, not just this
 * loader.
 */
function encodeLine(doc: unknown): string {
  return JSON.stringify(doc).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

async function main(): Promise<void> {
  const outDir = argValue('--out') ?? './data-dump';
  const config = loadConfig();
  await mkdir(outDir, { recursive: true });

  const store = buildStore(config);
  const counts: Record<string, number> = {};

  for (const spec of DOC_TYPES) {
    const docs = await spec.list(store);
    const file = join(outDir, `${spec.name}.ndjson`);
    const out = createWriteStream(file, { encoding: 'utf8' });
    for (const doc of docs) {
      // Respect backpressure — the replies file is large enough that ignoring it
      // would buffer the whole thing in memory, the very thing NDJSON avoids.
      if (!out.write(`${encodeLine(doc)}\n`)) await once(out, 'drain');
    }
    out.end();
    await once(out, 'finish');
    counts[spec.name] = docs.length;
    console.log(`${String(docs.length).padStart(7)}  ${spec.name}`);
  }

  const manifest: DumpManifest = {
    createdAt: new Date().toISOString(),
    counts,
    source: {
      store: config.store,
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    },
  };
  await writeFile(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  console.log(`\ndumped ${total} doc(s) to ${outDir}/ — load with: pnpm data:load --in ${outDir}`);
  await store.close?.();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  console.error('\nIf this is a LevelDB lock error, stop `pnpm serve` first — the store is single-process.');
  process.exit(1);
});
