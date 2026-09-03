// Load a `data:dump` directory into the configured store, then VERIFY by
// re-reading every type and comparing counts against the dump's manifest.
//
//     STORE=pouchdb pnpm data:load --in ./data-dump
//     STORE=pouchdb pnpm data:load --in ./data-dump --force   # non-empty target
//
// Verification is the whole point. Copying data/pouch between machines gives you
// no way to tell a good migration from a truncated one until a mailbox is
// already pointed at the new box; a count that has to match makes the answer
// immediate. A mismatch is a real signal, not noise — some `put*` methods
// normalize or dedupe, and that is precisely what you want to find out here.
//
// Types are loaded in the table's order (accounts and batches before the targets
// that reference them, targets before outreaches and replies), so a partially
// loaded store is still coherent.

import 'dotenv/config';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig } from '../config';
import { applyTimezone } from '../lib/timezone';
import { buildStore } from '../lib/factory';
import type { Store } from '../ports/store';
import { DOC_TYPES, type DumpManifest } from '../services/dump';

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i === -1 || i + 1 >= process.argv.length ? undefined : process.argv[i + 1];
}

/**
 * Stream one NDJSON file, applying `onDoc` per line. Blank lines are skipped so
 * a trailing newline is not a parse error.
 *
 * Splits on "\n" and nothing else — deliberately NOT node:readline, which also
 * breaks lines on U+2028/U+2029. Those are legal raw inside a JSON string and do
 * occur in reply bodies, so readline splits documents in half and the parse
 * fails somewhere in the middle of a 100 MB migration. `data:dump` now escapes
 * them on the way out; this keeps a dump taken before that fix loadable.
 *
 * The stream carries an encoding, so multi-byte characters are never split
 * across chunk boundaries.
 */
async function readNdjson(file: string, onDoc: (doc: unknown) => Promise<void>): Promise<number> {
  let n = 0;
  let buf = '';
  const flush = async (line: string): Promise<void> => {
    const trimmed = line.trim();
    if (!trimmed) return;
    await onDoc(JSON.parse(trimmed));
    n++;
  };
  for await (const chunk of createReadStream(file, { encoding: 'utf8' })) {
    buf += chunk as string;
    let nl = buf.indexOf('\n');
    while (nl !== -1) {
      await flush(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
      nl = buf.indexOf('\n');
    }
  }
  await flush(buf);
  return n;
}

async function totalDocs(store: Store): Promise<number> {
  let n = 0;
  for (const spec of DOC_TYPES) n += (await spec.list(store)).length;
  return n;
}

async function main(): Promise<void> {
  applyTimezone();
  const inDir = argValue('--in') ?? './data-dump';
  const force = process.argv.includes('--force');
  const config = loadConfig();

  const manifest = JSON.parse(await readFile(join(inDir, 'manifest.json'), 'utf8')) as DumpManifest;
  console.log(
    `loading ${inDir}/ (dumped ${manifest.createdAt} from ${manifest.source.platform}, ` +
      `store=${manifest.source.store}, tz=${manifest.source.tz})\n`,
  );

  const store = buildStore(config);

  // Loading into a store that already has documents merges the two by id, which
  // is almost never what a migration wants and is not undoable. Make it explicit.
  const existing = await totalDocs(store);
  if (existing > 0 && !force) {
    console.error(
      `refusing to load: the target store already holds ${existing} doc(s).\n` +
        'Loading would merge into it by id. Point STORE/POUCH_DIR at an empty store, ' +
        'or pass --force if merging is what you actually want.',
    );
    await store.close?.();
    process.exit(1);
  }

  const loaded: Record<string, number> = {};
  for (const spec of DOC_TYPES) {
    const file = join(inDir, `${spec.name}.ndjson`);
    let n = 0;
    try {
      n = await readNdjson(file, (doc) => spec.put(store, doc).then(() => undefined));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      // A dump taken before this type existed simply has no file for it.
      console.log(`${'—'.padStart(7)}  ${spec.name} (no file in dump)`);
      loaded[spec.name] = 0;
      continue;
    }
    loaded[spec.name] = n;
    console.log(`${String(n).padStart(7)}  ${spec.name}`);
  }

  // Verify: re-read the store through the same port and compare to the manifest.
  console.log('\nverifying…\n');
  console.log(`${'type'.padEnd(20)} ${'dumped'.padStart(8)} ${'loaded'.padStart(8)} ${'in store'.padStart(9)}`);
  let mismatches = 0;
  for (const spec of DOC_TYPES) {
    const expected = manifest.counts[spec.name] ?? 0;
    const inStore = (await spec.list(store)).length;
    const ok = inStore === expected;
    if (!ok) mismatches++;
    console.log(
      `${spec.name.padEnd(20)} ${String(expected).padStart(8)} ${String(loaded[spec.name] ?? 0).padStart(8)} ` +
        `${String(inStore).padStart(9)}  ${ok ? 'ok' : '← MISMATCH'}`,
    );
  }

  await store.close?.();
  if (mismatches > 0) {
    console.error(`\n${mismatches} type(s) do not match the manifest. Do NOT cut over until this is understood.`);
    process.exit(1);
  }
  console.log('\nevery type matches the manifest — the store is a faithful copy.');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
