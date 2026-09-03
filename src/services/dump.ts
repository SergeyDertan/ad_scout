// The table that `data:dump` and `data:load` both read, so the two can never
// drift into dumping a type nobody loads back.
//
// It is deliberately expressed in terms of the **Store port**, not PouchDB: a
// dump is then a plain JSON view of the domain, portable to whatever store the
// destination runs, and verifiable by counting. The alternative — copying the
// LevelDB directory — carries the write-ahead log mid-write if the process is
// live, and offers no cross-platform guarantee (arm64 Mac → x86-64 Linux).
//
// Every type in the port has both a `list*` and a `put*`/`add*`. Two are
// asymmetric and are why this table stores functions rather than method names:
// `putPromptSnapshot` returns void, and suppressions use `addSuppression`.
//
// NOTE: a legacy `campaign:` doc exists in older stores. The Store port has no
// campaign methods at all any more (the type is dead code), so it is dropped on
// purpose — nothing reads it.

import { createWriteStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { once } from 'node:events';
import type { Store } from '../ports/store';

export interface DocTypeSpec {
  /** File stem in the dump directory, and the key in the manifest's counts. */
  name: string;
  list: (s: Store) => Promise<unknown[]>;
  put: (s: Store, doc: unknown) => Promise<unknown>;
}

/* eslint-disable @typescript-eslint/no-explicit-any -- docs come back as parsed JSON */
export const DOC_TYPES: DocTypeSpec[] = [
  { name: 'accounts', list: (s) => s.listAccounts(), put: (s, d) => s.putAccount(d as any) },
  { name: 'batches', list: (s) => s.listBatches(), put: (s, d) => s.putBatch(d as any) },
  { name: 'targets', list: (s) => s.listTargets(), put: (s, d) => s.putTarget(d as any) },
  { name: 'outreaches', list: (s) => s.listOutreaches(), put: (s, d) => s.putOutreach(d as any) },
  { name: 'replies', list: (s) => s.listReplies(), put: (s, d) => s.putReply(d as any) },
  { name: 'niches', list: (s) => s.listNiches(), put: (s, d) => s.putNiche(d as any) },
  { name: 'price-records', list: (s) => s.listPriceRecords(), put: (s, d) => s.putPriceRecord(d as any) },
  { name: 'suppressions', list: (s) => s.listSuppressions(), put: (s, d) => s.addSuppression(d as any) },
  { name: 'ignore', list: (s) => s.listIgnore(), put: (s, d) => s.putIgnore(d as any) },
  { name: 'domain-exclusions', list: (s) => s.listDomainExclusions(), put: (s, d) => s.putDomainExclusion(d as any) },
  { name: 'prompt-snapshots', list: (s) => s.listPromptSnapshots(), put: (s, d) => s.putPromptSnapshot(d as any) },
  { name: 'deals', list: (s) => s.listDeals(), put: (s, d) => s.putDeal(d as any) },
  { name: 'placements', list: (s) => s.listPlacements(), put: (s, d) => s.putPlacement(d as any) },
  { name: 'thread-links', list: (s) => s.listThreadLinks(), put: (s, d) => s.putThreadLink(d as any) },
];

export interface DumpManifest {
  createdAt: string;
  /** Docs written per type — what `data:load` verifies against after loading. */
  counts: Record<string, number>;
  source: { store: string; node: string; platform: string; tz: string };
}

/**
 * One NDJSON line. JSON.stringify leaves U+2028 (LINE SEPARATOR) and U+2029
 * (PARAGRAPH SEPARATOR) **raw** — they are legal inside a JSON string — but
 * line-oriented readers treat them as line breaks, which silently splits a
 * document in half. Real reply bodies contain them (they arrive in HTML mail),
 * so this is not theoretical: the first round-trip of this store turned 1200
 * replies into 1212 fragments and failed to parse.
 */
function encodeLine(doc: unknown): string {
  return JSON.stringify(doc).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

/**
 * Write every document in `store` to `outDir` as one NDJSON file per type, plus
 * a manifest of counts.
 *
 * Shared by `pnpm data:dump` and the scheduled backup service on purpose: a
 * backup that is not byte-for-byte the format `data:load` reads is a backup with
 * an untested restore path.
 *
 * The caller decides about locking. The backup service holds the pipeline's
 * write lock across this call so the snapshot is consistent; the CLI holds the
 * whole process instead, because the store is single-writer.
 */
export async function dumpStore(
  store: Store,
  outDir: string,
  source: DumpManifest['source'],
  onType?: (name: string, count: number) => void,
): Promise<DumpManifest> {
  await mkdir(outDir, { recursive: true });
  const counts: Record<string, number> = {};

  for (const spec of DOC_TYPES) {
    const docs = await spec.list(store);
    const out = createWriteStream(join(outDir, `${spec.name}.ndjson`), { encoding: 'utf8' });
    for (const doc of docs) {
      // Respect backpressure — the replies file is large enough that ignoring it
      // would buffer the whole thing in memory, the very thing NDJSON avoids.
      if (!out.write(`${encodeLine(doc)}\n`)) await once(out, 'drain');
    }
    out.end();
    await once(out, 'finish');
    counts[spec.name] = docs.length;
    onType?.(spec.name, docs.length);
  }

  const manifest: DumpManifest = { createdAt: new Date().toISOString(), counts, source };
  await writeFile(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return manifest;
}

/** How this process describes itself in a dump manifest. */
export function describeSource(storeKind: string): DumpManifest['source'] {
  return {
    store: storeKind,
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}
