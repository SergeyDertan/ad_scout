// Firebase wiring: Google sign-in, and nothing else.
//
// AuthGate.tsx dynamic-imports this once `GET /api/auth` reports that sign-in is
// required — which is how one build serves the open laptop console and the gated
// VPS, and why a laptop with auth off never loads Firebase at all.
//
// SIGN-IN ONLY. Firebase is an identity provider here and not a database: the
// browser never touches Cloud Storage or Firestore. Every byte of data comes
// from this project's own /api, gated by the ID-token allowlist in
// src/server/auth.ts. That is why storage.rules denies reads to every client —
// there is no browser code left that a read rule could serve.
//
// THE CONFIG IS HARDCODED, DELIBERATELY. It was six VITE_FIREBASE_* variables
// baked in at build time, which meant a host that required sign-in also needed
// a web/.env.local nobody had ever needed locally — and its absence surfaced as
// `auth/invalid-api-key` in the browser console, nowhere near the cause. None of
// these values are secrets: a web config identifies a project, it does not
// authorize anything. Access is decided by ADMIN_EMAILS/MANAGER_EMAILS on the
// server (src/server/auth.ts). There is one project and it does not change, so
// the indirection bought nothing and cost a broken deploy.
//
// The service-account key is the opposite and must never come near this file:
// anything reachable from here is compiled into a public bundle.

import { initializeApp } from 'firebase/app';
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from 'firebase/app-check';
import {
  getAuth,
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  signOut,
  type User,
} from 'firebase/auth';

const firebaseConfig = {
  apiKey: 'AIzaSyCIPtlMsPkDooH6Lt6RH9QGA59Bg99j1aY',
  authDomain: 'postwormhole.firebaseapp.com',
  projectId: 'postwormhole',
  storageBucket: 'postwormhole.firebasestorage.app',
  messagingSenderId: '949447673843',
  appId: '1:949447673843:web:1d2359a4023099e7aaf486',
};

/** Public by design — a reCAPTCHA Enterprise site key is meant to be embedded. */
const RECAPTCHA_ENTERPRISE_SITE_KEY = '6Ld4CKktAAAAAGT5vdZiO5aWMRoYxadtO5rZMIMv';

const app = initializeApp(firebaseConfig);

// App Check attests that a request came from this app, on an allowed domain,
// before Firebase will serve it. The only Firebase surface left to cover is
// Auth, and only once enforcement is switched on for it in the console. It does
// NOT cover this project's own /api routes: those are gated by the ID-token
// allowlist in src/server/auth.ts, and adding App Check there would mean
// sending the token as a header and verifying it with the Admin SDK.
//
// Initialised before any service is used, which is why it sits here rather than
// behind a call site.
//
// Failure is warned about, not thrown. A hard throw at module scope would reject
// AuthGate's dynamic import and leave no sign-in UI at all — worse than the
// thing it would be reporting, and pointless besides: if enforcement is on, the
// Firebase call fails on its own and says why.
if (import.meta.env.DEV) {
  // Localhost has no reCAPTCHA attestation. This asks the SDK to print a debug
  // token to register under App Check → Apps → Manage debug tokens. Dev-only, so
  // it is dropped from a production bundle.
  (globalThis as unknown as Record<string, unknown>).FIREBASE_APPCHECK_DEBUG_TOKEN = true;
}
try {
  initializeAppCheck(app, {
    provider: new ReCaptchaEnterpriseProvider(RECAPTCHA_ENTERPRISE_SITE_KEY),
    isTokenAutoRefreshEnabled: true,
  });
} catch (err) {
  console.warn('App Check did not initialise; Firebase calls will fail if enforcement is on', err);
}

export const auth = getAuth(app);

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

export function signOutUser(): Promise<void> {
  return signOut(auth);
}
