// Firebase wiring for the shared read-only viewer.
//
// This module is only reachable from the viewer build (VITE_TARGET=viewer); the
// operator console never imports it and never talks to Firebase.
//
// None of these values are secrets. A Firebase web config identifies the
// project, it does not authorize anything: access is decided entirely by the
// Storage/Firestore security rules, which require a signed-in user on the
// allowlist. Anyone can load the page; only allowlisted accounts can read data.

import { initializeApp } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  signOut,
  type User,
} from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';
import { getStorage } from 'firebase/storage';

const env = import.meta.env;

export const SNAPSHOT_PREFIX: string = env.VITE_SNAPSHOT_PREFIX || 'snapshot';

/** True when the build was given a Firebase project to talk to. A missing
 *  config is a deploy mistake, not a runtime state, so the UI says so plainly
 *  instead of failing later inside the SDK. */
export const firebaseConfigured = Boolean(env.VITE_FIREBASE_API_KEY && env.VITE_FIREBASE_PROJECT_ID);

const app = initializeApp({
  apiKey: env.VITE_FIREBASE_API_KEY,
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: env.VITE_FIREBASE_APP_ID,
});

export const auth = getAuth(app);
export const db = getFirestore(app);
export const storage = getStorage(app);

export type { User };

export function watchAuth(onChange: (user: User | null) => void): () => void {
  return onAuthStateChanged(auth, onChange);
}

export function signInWithGoogle(): Promise<unknown> {
  const provider = new GoogleAuthProvider();
  // Always show the account chooser: people land here from a personal browser
  // where the wrong Google account is often already signed in, and a silent
  // sign-in as the wrong identity looks like "access denied" for no reason.
  provider.setCustomParameters({ prompt: 'select_account' });
  return signInWithPopup(auth, provider);
}

export function signOutViewer(): Promise<void> {
  return signOut(auth);
}

/** Does this error mean "signed in, but not on the allowlist"? Storage and
 *  Firestore spell the same refusal differently. */
export function isPermissionDenied(err: unknown): boolean {
  const code = (err as { code?: string })?.code ?? '';
  return code === 'storage/unauthorized' || code === 'permission-denied';
}
