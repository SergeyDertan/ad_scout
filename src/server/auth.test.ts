import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../config';
import { MemoryStore } from '../adapters/store/memory.store';
import { systemClock } from '../lib/clock';
import { createApiServer, type ServerDeps } from './app';
import { authEnabled, evaluateClaims, loadAuthConfig, mayAccess, type AuthResult } from './auth';

const config = loadConfig({} as NodeJS.ProcessEnv);
const webDir = fileURLToPath(new URL('./__fixtures__/web', import.meta.url));

const ALLOW = { adminEmails: new Set(['boss@example.com']), managerEmails: new Set(['deals@example.com']) };

/* ---------- the rule itself, with no Firebase in the way ---------- */

test('an allowlisted, verified email is admitted', () => {
  const r = evaluateClaims({ email: 'boss@example.com', email_verified: true, uid: 'u1' }, ALLOW);
  assert.equal(r.ok, true);
  assert.deepEqual(r.ok && r.identity, { uid: 'u1', email: 'boss@example.com', role: 'admin' });
});

test('the compare is case-insensitive — an allowlist is not a password', () => {
  const r = evaluateClaims({ email: 'Boss@Example.COM', email_verified: true, uid: 'u1' }, ALLOW);
  assert.equal(r.ok, true);
});

test('an UNVERIFIED email is refused even when it is on the allowlist', () => {
  // Without this check anyone can register an unverified account claiming an
  // allowlisted address and walk straight in.
  const r = evaluateClaims({ email: 'boss@example.com', email_verified: false, uid: 'u1' }, ALLOW);
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.status, 403);
});

test('a verified email that is not on the allowlist is refused', () => {
  const r = evaluateClaims({ email: 'stranger@example.com', email_verified: true, uid: 'u2' }, ALLOW);
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.status, 403);
});

test('a token carrying no email at all is refused', () => {
  const r = evaluateClaims({ email_verified: true, uid: 'u3' }, ALLOW);
  assert.equal(r.ok, false);
});

/* ---------- configuration gate ---------- */

test('auth stays off until ADMIN_EMAILS is set, and separators are flexible', () => {
  assert.equal(authEnabled({} as NodeJS.ProcessEnv), false);
  assert.equal(authEnabled({ ADMIN_EMAILS: '' } as NodeJS.ProcessEnv), false);
  assert.equal(authEnabled({ ADMIN_EMAILS: 'a@b.com' } as NodeJS.ProcessEnv), true);

  const cfg = loadAuthConfig({
    ADMIN_EMAILS: 'A@b.com, c@d.com  e@f.com',
    FIREBASE_PROJECT_ID: 'proj',
  } as NodeJS.ProcessEnv);
  assert.deepEqual([...cfg!.adminEmails].sort(), ['a@b.com', 'c@d.com', 'e@f.com']);
});

test('an allowlist with no project id fails loudly at boot, not on first request', () => {
  assert.throws(
    () => loadAuthConfig({ ADMIN_EMAILS: 'a@b.com' } as NodeJS.ProcessEnv),
    /Firebase project id/,
  );
});

/* ---------- the gate, over real HTTP ---------- */

interface Harness {
  base: string;
  close: () => Promise<void>;
}

/** Boots the API with a stub authenticator: "Bearer good" is an admin and
 *  "Bearer mgr" a manager. `open: true` boots it with no authenticator, the
 *  local-development shape. */
async function start(open = false): Promise<Harness> {
  const deps: ServerDeps = {
    store: new MemoryStore(),
    config,
    clock: systemClock,
    runSend: async () => ({}),
    runPoll: async () => ({}),
    runFetch: async () => ({}),
    webDir,
    authenticate: open ? undefined : async (req): Promise<AuthResult> => {
      const h = req.headers.authorization ?? '';
      if (h === 'Bearer good') return { ok: true, identity: { uid: 'u1', email: 'boss@example.com', role: 'admin' } };
      if (h === 'Bearer mgr') return { ok: true, identity: { uid: 'u2', email: 'deals@example.com', role: 'manager' } };
      if (h.startsWith('Bearer ')) return { ok: false, status: 403, error: 'not authorized' };
      return { ok: false, status: 401, error: 'sign in required' };
    },
  };
  const server = createApiServer(deps);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((r) => {
        (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
        server.close(() => r());
      }),
  };
}

test('an unauthenticated API call is refused with 401', async () => {
  const h = await start();
  try {
    assert.equal((await fetch(`${h.base}/api/status`)).status, 401);
  } finally {
    await h.close();
  }
});

test('a signed-in but unauthorized caller gets 403', async () => {
  const h = await start();
  try {
    const res = await fetch(`${h.base}/api/status`, { headers: { authorization: 'Bearer other' } });
    assert.equal(res.status, 403);
  } finally {
    await h.close();
  }
});

test('a valid token reaches the route', async () => {
  const h = await start();
  try {
    const res = await fetch(`${h.base}/api/status`, { headers: { authorization: 'Bearer good' } });
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { ok: boolean }).ok, true);
  } finally {
    await h.close();
  }
});

test('the gate covers mutating routes, not just reads', async () => {
  const h = await start();
  try {
    // The whole point: DELETE /api/accounts/:id and POST /api/run/send must not
    // be reachable by an anonymous caller who found the host.
    assert.equal((await fetch(`${h.base}/api/accounts/a1`, { method: 'DELETE' })).status, 401);
    assert.equal((await fetch(`${h.base}/api/run/send`, { method: 'POST' })).status, 401);
  } finally {
    await h.close();
  }
});

test('the SSE change feed is gated too', async () => {
  const h = await start();
  try {
    assert.equal((await fetch(`${h.base}/api/stream`)).status, 401);
  } finally {
    await h.close();
  }
});

test('/api/oauth/callback stays reachable — Google redirects the browser to it', async () => {
  const h = await start();
  try {
    // No Authorization header is possible on a redirect. It must get PAST the
    // gate; without gmailOAuth wired it then answers 503, which is proof enough
    // that auth did not reject it.
    const res = await fetch(`${h.base}/api/oauth/callback?code=x&state=y`);
    assert.equal(res.status, 503);
  } finally {
    await h.close();
  }
});

test('/api/oauth/start is NOT exempt — the SPA calls it with fetch', async () => {
  const h = await start();
  try {
    assert.equal((await fetch(`${h.base}/api/oauth/start?accountId=a1`)).status, 401);
  } finally {
    await h.close();
  }
});

test('the static UI is served unauthenticated, so the sign-in page can load', async () => {
  const h = await start();
  try {
    const res = await fetch(`${h.base}/index.html`);
    assert.equal(res.status, 200);
  } finally {
    await h.close();
  }
});

test('preflight advertises Authorization, or every authenticated call dies at CORS', async () => {
  const h = await start();
  try {
    const res = await fetch(`${h.base}/api/status`, { method: 'OPTIONS' });
    assert.match(res.headers.get('access-control-allow-headers') ?? '', /Authorization/i);
  } finally {
    await h.close();
  }
});

test('GET /api/auth reports that sign-in is required, without needing a token', async () => {
  // The front end has to learn this BEFORE it can sign in, so this one route
  // must answer unauthenticated or the console can never show a sign-in screen.
  const h = await start();
  try {
    const res = await fetch(`${h.base}/api/auth`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { required: true });
  } finally {
    await h.close();
  }
});

test('GET /api/auth reports an open instance, so one build serves both', async () => {
  const h = await start(true);
  try {
    assert.deepEqual(await (await fetch(`${h.base}/api/auth`)).json(), { required: false });
    // ...and with no authenticator the rest of the API stays open, unchanged.
    assert.equal((await fetch(`${h.base}/api/status`)).status, 200);
  } finally {
    await h.close();
  }
});

/* ---------- roles ---------- */

test('a manager is recognised, and admin wins when an address is on both lists', () => {
  const m = evaluateClaims({ email: 'deals@example.com', email_verified: true, uid: 'u9' }, ALLOW);
  assert.equal(m.ok && m.identity.role, 'manager');

  const both = { adminEmails: new Set(['x@e.com']), managerEmails: new Set(['x@e.com']) };
  const r = evaluateClaims({ email: 'x@e.com', email_verified: true, uid: 'u0' }, both);
  assert.equal(r.ok && r.identity.role, 'admin');
});

test('MANAGER_EMAILS alone is enough to turn auth on', () => {
  assert.equal(authEnabled({ MANAGER_EMAILS: 'm@e.com' } as NodeJS.ProcessEnv), true);
  const cfg = loadAuthConfig({ MANAGER_EMAILS: 'm@e.com', FIREBASE_PROJECT_ID: 'p' } as NodeJS.ProcessEnv);
  assert.deepEqual([...cfg!.managerEmails], ['m@e.com']);
  assert.equal(cfg!.adminEmails.size, 0);
});

test('an admin is unrestricted', () => {
  for (const [method, path] of [
    ['DELETE', 'api/accounts/a1'],
    ['POST', 'api/run/send'],
    ['POST', 'api/targets'],
    ['GET', 'api/oauth/start'],
  ] as const) {
    assert.equal(mayAccess('admin', method, path.split('/')), true, `${method} /${path}`);
  }
});

test('a manager can read everything', () => {
  for (const path of ['api/status', 'api/accounts', 'api/replies/r1', 'api/deals', 'api/domains/x']) {
    assert.equal(mayAccess('manager', 'GET', path.split('/')), true, `GET /${path}`);
  }
});

test('a manager can run the whole deal negotiation', () => {
  const allowed: [string, string][] = [
    ['POST', 'api/deals'],
    ['PATCH', 'api/deals/d1'],
    ['DELETE', 'api/deals/d1'],
    ['POST', 'api/deals/d1/threads'],
    ['POST', 'api/deals/d1/placements'],
    ['POST', 'api/deals/d1/messages'],
    ['PATCH', 'api/placements/p1'],
    ['DELETE', 'api/placements/p1'],
    ['POST', 'api/preview'],
  ];
  for (const [method, path] of allowed) {
    assert.equal(mayAccess('manager', method, path.split('/')), true, `${method} /${path}`);
  }
});

test('a manager cannot touch mailboxes, imports or send passes', () => {
  const denied: [string, string][] = [
    ['POST', 'api/accounts'],
    ['PATCH', 'api/accounts/a1'],
    ['POST', 'api/accounts/a1/pause'],
    ['POST', 'api/accounts/a1/resume'],
    ['POST', 'api/accounts/a1/rollback-cursor'],
    ['DELETE', 'api/accounts/a1'],
    ['POST', 'api/targets'],      // import
    ['PATCH', 'api/targets/t1'],
    ['DELETE', 'api/targets/t1'],
    ['POST', 'api/batches'],      // import
    ['POST', 'api/run/send'],
    ['POST', 'api/run/poll'],
    ['POST', 'api/run/fetch'],
    ['DELETE', 'api/replies/r1'],
    ['PATCH', 'api/replies/r1'],
    ['POST', 'api/ignore'],
    ['DELETE', 'api/ignore/i1'],
    ['POST', 'api/exclusions'],
    ['DELETE', 'api/exclusions/e1'],
  ];
  for (const [method, path] of denied) {
    assert.equal(mayAccess('manager', method, path.split('/')), false, `${method} /${path}`);
  }
});

test('a manager cannot reach the OAuth flow, even though it is a GET', () => {
  // /api/oauth/start mints a Google consent URL that connects a mailbox. It
  // would pass the "every read is allowed" rule, so it is denied by name.
  assert.equal(mayAccess('manager', 'GET', 'api/oauth/start'.split('/')), false);
  assert.equal(mayAccess('manager', 'GET', 'api/oauth/callback'.split('/')), false);
});

test('an unknown future write route is denied to a manager by default', () => {
  // The rule is default-deny on purpose: a route added to app.ts later must not
  // become reachable by a manager just because nobody updated a denylist.
  assert.equal(mayAccess('manager', 'POST', 'api/something-new'.split('/')), false);
  assert.equal(mayAccess('manager', 'DELETE', 'api/whatever/x'.split('/')), false);
});

test('the role is enforced over real HTTP, not just in the predicate', async () => {
  const h = await start();
  const mgr = { authorization: 'Bearer mgr' };
  try {
    // Reads: fine.
    assert.equal((await fetch(`${h.base}/api/status`, { headers: mgr })).status, 200);
    assert.equal((await fetch(`${h.base}/api/deals`, { headers: mgr })).status, 200);

    // Mailboxes, imports and send passes: refused with 403, not 401 — the
    // caller IS authenticated, they are just not allowed.
    for (const [method, path] of [
      ['DELETE', '/api/accounts/a1'],
      ['POST', '/api/accounts/a1/pause'],
      ['POST', '/api/run/send'],
      ['POST', '/api/targets'],
      ['POST', '/api/batches'],
    ] as const) {
      const res = await fetch(`${h.base}${path}`, { method, headers: mgr });
      assert.equal(res.status, 403, `${method} ${path}`);
    }

    // The same routes stay open to an admin, so the gate is the role and not
    // something incidental about the request.
    assert.equal(
      (await fetch(`${h.base}/api/accounts/a1/pause`, { method: 'POST', headers: { authorization: 'Bearer good' } }))
        .status !== 403,
      true,
    );
  } finally {
    await h.close();
  }
});

test('GET /api/auth reports the caller role, so the UI can hide what would 403', async () => {
  const h = await start();
  try {
    assert.deepEqual(await (await fetch(`${h.base}/api/auth`, { headers: { authorization: 'Bearer mgr' } })).json(), {
      required: true,
      email: 'deals@example.com',
      role: 'manager',
    });
    // No token: still 200, still answerable — that is what makes the sign-in
    // screen possible in the first place.
    assert.deepEqual(await (await fetch(`${h.base}/api/auth`)).json(), { required: true });
  } finally {
    await h.close();
  }
});
