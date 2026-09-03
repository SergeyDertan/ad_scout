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
