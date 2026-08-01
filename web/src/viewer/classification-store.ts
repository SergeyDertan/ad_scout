// Where a viewer's niche classification is kept: Firestore, at viewers/{uid}.
//
// Per account and private to it (see firestore.rules) — it survives a cleared
// browser cache and follows them between machines. Nothing here is ever read by
// the pipeline or written back into the operator's data.

import { doc, getDoc, setDoc } from 'firebase/firestore';
import { db } from './firebase';
import type { Classification } from './classification';

function docRef(uid: string) {
  return doc(db, 'viewers', uid);
}

export async function loadClassification(uid: string): Promise<Classification> {
  const snap = await getDoc(docRef(uid));
  const raw = snap.exists() ? (snap.data().nicheSensitivity as unknown) : undefined;
  const out: Classification = {};
  if (raw && typeof raw === 'object') {
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof value === 'boolean') out[key] = value;
    }
  }
  return out;
}

export async function saveClassification(uid: string, map: Classification): Promise<void> {
  // Whole-map write, not a merge: unclassifying a niche means REMOVING its key,
  // and a merged field update cannot express a deletion without sentinels.
  await setDoc(docRef(uid), { nicheSensitivity: map, updatedAt: new Date().toISOString() });
}
