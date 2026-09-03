// Google ID-token verification for the operator/admin API.
//
// WHY THIS EXISTS: app.ts had no authentication of any kind. Locally that was
// fine — it listened on a laptop's loopback. On a public VPS the same routes let
// anyone who finds the host send mail from the Gmail accounts, delete accounts,
// trigger send passes and read every reply. This is the gate.
//
// The predicate is deliberately the SAME three conditions firestore.rules already
// enforces for the read-only viewer (`allowed()`): a signed-in user, a verified
// email, and that email on an allowlist. One rule, two runtimes.
//
// GATED, NOT UNCONDITIONAL — exactly how publishEnabled() gates publishing:
// auth is required only once ADMIN_EMAILS is set. An unset ADMIN_EMAILS is the
// normal local case (`pnpm serve` on a laptop, `pnpm web:dev`'s proxy) and stays
// open, so turning this on is a deploy decision rather than a local-dev tax.
//
// NO LOOPBACK EXEMPTION, ON PURPOSE. "Skip auth for 127.0.0.1" is the obvious
// convenience and it is a trap here: behind nginx/Caddy every proxied request
// arrives FROM 127.0.0.1, so that exemption would silently disable auth for the
// whole internet on the exact deployment this was written for.
//
// Verification needs a project id, not a service account: the signature is
// checked against Google's public certs, and the project id only fixes the
// expected `aud`. So this works on a box that has no firebase-service-account.json
// — the credential the snapshot publisher needs is not needed here.

import type { IncomingMessage } from 'node:http';
import { logger } from '../lib/logger';

/**
 * Two roles.
 *
 *   admin    the operator. Everything: accounts, imports, send passes, deals.
 *   manager  viewer + deal manager. Reads everything and runs the negotiation —
 *            open a thread, answer it, record placements — but cannot import
 *            targets, cannot touch mailboxes, and cannot start a send pass.
 *
 * The manager rule is DEFAULT-DENY (see `mayAccess`): reads are open, and only
 * a named set of deal writes is allowed. A denylist would be the easier thing to
 * write and the wrong shape — the next route added to app.ts would silently be
 * reachable by a manager, and nobody would notice until it was used.
 */
export type Role = 'admin' | 'manager';

export interface AdminIdentity {
  uid: string;
  email: string;
  role: Role;
}

export interface AuthConfig {
  projectId: string;
  /** Lower-cased, for the same case-insensitive compare firestore.rules does. */
  adminEmails: Set<string>;
  managerEmails: Set<string>;
}

/** Why a request was refused — the caller turns this into a status + message. */
export type AuthFailure =
  | { ok: false; status: 401; error: string }
  | { ok: false; status: 403; error: string };

export type AuthResult = { ok: true; identity: AdminIdentity } | AuthFailure;

/** True once either allowlist is configured. Mirrors publishEnabled()'s shape. */
export function authEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return parseEmails(env.ADMIN_EMAILS).size > 0 || parseEmails(env.MANAGER_EMAILS).size > 0;
}

function parseEmails(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? '')
      .split(/[,\s]+/)
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function loadAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig | null {
  const adminEmails = parseEmails(env.ADMIN_EMAILS);
  const managerEmails = parseEmails(env.MANAGER_EMAILS);
  if (adminEmails.size === 0 && managerEmails.size === 0) return null;
  const projectId =
    env.FIREBASE_PROJECT_ID || env.GCP_PROJECT || env.FIREBASE_PROJECT || env.GOOGLE_CLOUD_PROJECT || '';
  if (!projectId) {
    throw new Error(
      'ADMIN_EMAILS/MANAGER_EMAILS is set but no Firebase project id is. Set FIREBASE_PROJECT_ID ' +
        '(the project whose Google sign-in issues the tokens, e.g. the one in .firebaserc).',
    );
  }
  return { projectId, adminEmails, managerEmails };
}

function bearer(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ')) return undefined;
  const token = header.slice(7).trim();
  return token || undefined;
}

/**
 * Build the per-request check. firebase-admin is imported lazily so a run with
 * auth disabled — every local run — never pays to load it.
 */
export function createAuthenticator(config: AuthConfig): (req: IncomingMessage) => Promise<AuthResult> {
  let getAuthFn: Promise<(t: string) => Promise<Record<string, unknown>>> | undefined;

  async function verifier(): Promise<(t: string) => Promise<Record<string, unknown>>> {
    const [{ getApps, initializeApp }, { getAuth }] = await Promise.all([
      import('firebase-admin/app'),
      import('firebase-admin/auth'),
    ]);
    const NAME = 'adscout-admin-auth';
    const app = getApps().find((a) => a.name === NAME) ?? initializeApp({ projectId: config.projectId }, NAME);
    const auth = getAuth(app);
    // checkRevoked is deliberately off: it costs a network round-trip per
    // request, and an hour-long token on a two-person allowlist is not the
    // threat this is defending against.
    return (t: string) => auth.verifyIdToken(t) as unknown as Promise<Record<string, unknown>>;
  }

  return async function authenticate(req: IncomingMessage): Promise<AuthResult> {
    const token = bearer(req);
    if (!token) return { ok: false, status: 401, error: 'sign in required' };

    getAuthFn ??= verifier();
    let decoded: Record<string, unknown>;
    try {
      decoded = await (await getAuthFn)(token);
    } catch (err) {
      // Expired is the common, boring case (tokens last an hour) — the client
      // refreshes and retries, so log it quietly rather than as an incident.
      logger.warn('rejected an ID token', { reason: err instanceof Error ? err.message : String(err) });
      return { ok: false, status: 401, error: 'invalid or expired token' };
    }

    return evaluateClaims(decoded, config);
  };
}

/**
 * The authorization rule, separated from the token plumbing so it can be tested
 * without Firebase — this is the part that actually decides who gets in.
 *
 * The same three conditions as firestore.rules `allowed()`: signed in, email
 * verified, email on the allowlist. `email_verified` is not ceremony: without
 * it, anyone can register an unverified account claiming an allowlisted address.
 */
export function evaluateClaims(
  decoded: Record<string, unknown>,
  config: Pick<AuthConfig, 'adminEmails' | 'managerEmails'>,
): AuthResult {
  const email = typeof decoded.email === 'string' ? decoded.email.toLowerCase() : '';
  if (!email || decoded.email_verified !== true) {
    return { ok: false, status: 403, error: 'a verified Google email is required' };
  }
  // Admin wins if an address is on both lists — the more permissive of two
  // deliberate grants is the intended one, and silently demoting an operator
  // because they were also listed as a manager would be a confusing failure.
  const role: Role | undefined = config.adminEmails.has(email)
    ? 'admin'
    : config.managerEmails.has(email)
      ? 'manager'
      : undefined;
  if (!role) {
    logger.warn('denied a signed-in user on neither allowlist', { email });
    return { ok: false, status: 403, error: `${email} is not authorized for this instance` };
  }
  return { ok: true, identity: { uid: String(decoded.uid ?? decoded.sub ?? ''), email, role } };
}

/**
 * May this role make this request? `seg` is the path split on '/', so seg[0] is
 * always 'api'.
 *
 * Admins are unrestricted. For a manager the rule is: every read, plus writes
 * that belong to a deal — and nothing else.
 */
export function mayAccess(role: Role, method: string, seg: string[]): boolean {
  if (role === 'admin') return true;

  // /api/oauth/* is mailbox plumbing: `start` mints a Google consent URL that
  // connects or re-connects an account. It is a GET, so it would sail through
  // the read rule below — deny the whole namespace explicitly instead.
  if (seg[1] === 'oauth') return false;

  // "View all the data" — every read is allowed, including reply bodies and
  // extraction debug output.
  if (method === 'GET') return true;

  // Rendering an outreach preview writes nothing; it is a template render.
  if (method === 'POST' && seg[1] === 'preview' && seg.length === 2) return true;

  // The deal surface: the deal itself, its threads, its placements, and
  // answering into the thread. This is the whole job.
  if (seg[1] === 'deals' || seg[1] === 'placements') return true;

  // Everything else — accounts, targets, batches (import), replies, ignore,
  // exclusions, and POST /api/run/* — is the operator's.
  return false;
}
