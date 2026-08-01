// The viewer owner's OWN niche classification.
//
// Which niches count as sensitive is his call, not ours. The snapshot ships
// every price with `sensitive: false` (see src/services/snapshot.ts) and the
// niche keys alongside it; this module supplies the answers and stamps them
// onto the data as it is read.
//
// The three states matter:
//   true      → he marked it sensitive
//   false     → he marked it regular
//   ABSENT    → he hasn't ruled on it yet → "unknown niche"
//
// Absent is not "regular". A niche that shows up in a reply for the first time
// must surface as unknown so he notices and classifies it, rather than quietly
// joining the regular pile — which is exactly the failure he asked us to avoid.
//
// Persistence lives in classification-store.ts (Firestore, private per account).
// This module stays free of Firebase so the rule above can be tested directly —
// it is the piece most likely to break quietly.

import type { Tier } from '../types';

export type Classification = Record<string, boolean>;

/**
 * The active classification, held at module scope because it has to be applied
 * inside the data layer (api.snapshot.ts), below React. The provider keeps it in
 * step with Firestore and bumps a tick so views re-read through the new map.
 */
let current: Classification = {};

export function setClassification(next: Classification): void {
  current = next;
}

export function getClassification(): Classification {
  return current;
}

export function tierFor(category: string): Tier {
  const known = current[category];
  return known === undefined ? 'unknown' : known ? 'sens' : 'reg';
}

/** Stamp his answer onto anything carrying a niche key. */
export function classify<T extends { category: string; sensitive: boolean }>(x: T): T & { tier: Tier } {
  const tier = tierFor(x.category);
  return { ...x, sensitive: tier === 'sens', tier };
}

/** Same, for a niche in the taxonomy list (keyed by `key`, not `category`). */
export function classifyNiche<T extends { key: string; sensitive: boolean }>(n: T): T & { tier: Tier } {
  const tier = tierFor(n.key);
  return { ...n, sensitive: tier === 'sens', tier };
}
