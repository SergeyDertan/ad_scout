// Reads the published snapshot out of Cloud Storage.
//
// The snapshot is a set of plain JSON objects (see src/services/snapshot.ts).
// manifest.json is the entry point and the only file fetched unconditionally;
// everything else is pulled on demand and cached for the session, since a
// snapshot is immutable until the next publish.

import { getBytes, ref } from 'firebase/storage';
import { SNAPSHOT_PREFIX, storage } from './firebase';

/** Must match SNAPSHOT_FORMAT in src/services/snapshot.ts. */
export const SUPPORTED_FORMAT = 1;

export interface SnapshotManifest {
  format: number;
  builtAt: string;
  counts: { domains: number; replies: number; niches: number };
}

export class SnapshotOutOfDateError extends Error {
  constructor(readonly found: number) {
    super(
      `This viewer reads snapshot format ${SUPPORTED_FORMAT}, but the published data is format ${found}. ` +
        'Reload the page — if it persists, the viewer needs redeploying.',
    );
    this.name = 'SnapshotOutOfDateError';
  }
}

export class NotInSnapshotError extends Error {
  constructor(path: string) {
    super(`not in this snapshot: ${path}`);
    this.name = 'NotInSnapshotError';
  }
}

const cache = new Map<string, Promise<unknown>>();
let manifest: SnapshotManifest | null = null;

async function fetchJson<T>(path: string): Promise<T> {
  const bytes = await getBytes(ref(storage, `${SNAPSHOT_PREFIX}/${path}`));
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

/** Fetch a snapshot file, once per session. Concurrent callers share the same
 *  in-flight request rather than each starting their own. */
export function load<T>(path: string): Promise<T> {
  const hit = cache.get(path);
  if (hit) return hit as Promise<T>;
  const started = fetchJson<T>(path).catch((err) => {
    // A failed fetch must not poison the cache — the next attempt should retry
    // (a dropped connection, a token that has since refreshed).
    cache.delete(path);
    if ((err as { code?: string })?.code === 'storage/object-not-found') {
      throw new NotInSnapshotError(path);
    }
    throw err;
  });
  cache.set(path, started);
  return started as Promise<T>;
}

/** Load (and verify) the manifest. Everything else in the viewer waits on this. */
export async function loadManifest(): Promise<SnapshotManifest> {
  const m = await load<SnapshotManifest>('manifest.json');
  if (m.format !== SUPPORTED_FORMAT) throw new SnapshotOutOfDateError(m.format);
  manifest = m;
  return m;
}

export function currentManifest(): SnapshotManifest | null {
  return manifest;
}

/** Drop every cached file so the next read sees a newly published snapshot. */
export function invalidate(): void {
  cache.clear();
  manifest = null;
}
