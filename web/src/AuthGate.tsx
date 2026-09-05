import { Box, Button, Flex, Heading, Spinner, Stack, Text } from '@chakra-ui/react';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { apiUrl, setTokenProvider } from './apiBase';
import { RoleContext, type Role } from './role';

// The client half of src/server/auth.ts.
//
// ONE BUILD, BOTH DEPLOYMENTS. Rather than a separate `VITE_TARGET=admin`
// bundle, the app asks the server whether sign-in is required (GET /api/auth,
// the one public route) and adapts. Locally the answer is "no" and this
// component renders its children immediately, having imported nothing — so the
// operator console on a laptop is exactly what it was, with no Firebase in the
// bundle it downloads and no sign-in in the way.
//
// Firebase is loaded with a dynamic import for that reason: it is ~100 KB the
// local console must never pay for. The module imported is the viewer's — the
// Google sign-in there is not viewer-specific, and a second copy would be a
// second thing to keep in step with the allowlist.

type Requirement = 'checking' | 'open' | 'required';

interface FirebaseAuthModule {
  watchAuth: (cb: (user: AuthUser | null) => void) => () => void;
  signInWithGoogle: () => Promise<unknown>;
  signOutViewer: () => Promise<void>;
}

interface AuthUser {
  email: string | null;
  getIdToken: (forceRefresh?: boolean) => Promise<string>;
}

/** The full-page frame the three pre-app states share, so the console does not
 *  change shape between checking, signing in and being refused. */
function Gate({ children }: { children: ReactNode }) {
  return (
    <Flex minH="100dvh" align="center" justify="center" px={6}>
      <Stack gap={5} maxW="26rem" textAlign="center" align="center">
        {children}
      </Stack>
    </Flex>
  );
}

export function AuthGate({ children }: { children: ReactNode }) {
  const [requirement, setRequirement] = useState<Requirement>('checking');
  const [fb, setFb] = useState<FirebaseAuthModule | null>(null);
  const [user, setUser] = useState<AuthUser | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [role, setRole] = useState<Role>(null);
  // Whether apiBase is holding a token provider yet. Children must not mount
  // before it is — see the effect below and the gate at the bottom.
  const [tokenReady, setTokenReady] = useState(false);

  // 1. Does this server want a token at all?
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(apiUrl('/auth'));
        const body = (await res.json()) as { required?: boolean };
        if (!cancelled) setRequirement(body.required ? 'required' : 'open');
      } catch {
        // Unreachable server: treat as open. The app's own error handling then
        // reports the real connection problem, which is far more useful than a
        // sign-in screen that cannot possibly help.
        if (!cancelled) setRequirement('open');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // 2. Only then pull in Firebase, and start watching the session.
  useEffect(() => {
    if (requirement !== 'required') return;
    let cancelled = false;
    let unwatch: (() => void) | undefined;
    void (async () => {
      const mod = (await import('./viewer/firebase')) as unknown as FirebaseAuthModule;
      if (cancelled) return;
      setFb(mod);
      unwatch = mod.watchAuth((u) => setUser(u));
    })();
    return () => {
      cancelled = true;
      unwatch?.();
    };
  }, [requirement]);

  // 3. Hand api.ts a way to mint a token. A PROVIDER, not a token: ID tokens
  //    last an hour and the SDK refreshes them on demand, so asking per request
  //    is what keeps a long session from dying at the 60-minute mark.
  useEffect(() => {
    if (requirement !== 'required' || !user) {
      if (requirement === 'required') setTokenProvider(null);
      setTokenReady(false);
      return;
    }
    setTokenProvider(() => user.getIdToken());
    setTokenReady(true);
    return () => {
      setTokenProvider(null);
      setTokenReady(false);
    };
  }, [requirement, user]);

  // 4. Ask again, now signed in, for the role. The first call was anonymous and
  //    could only answer "yes, sign-in is required". The header is passed
  //    explicitly rather than relying on the provider being installed already —
  //    effect ordering is not worth betting the whole console on.
  useEffect(() => {
    if (requirement !== 'required' || !user) {
      setRole(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const token = await user.getIdToken();
        const res = await fetch(apiUrl('/auth'), { headers: { Authorization: `Bearer ${token}` } });
        const body = (await res.json()) as { role?: Role };
        if (!cancelled) setRole(body.role ?? null);
      } catch {
        // Leave it null: the UI then shows everything, and the server still
        // refuses what this role may not do. Failing open in the UI is right —
        // failing open in the server would not be.
        if (!cancelled) setRole(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [requirement, user]);

  const signIn = useCallback(() => {
    if (!fb) return;
    setBusy(true);
    setError(null);
    void fb
      .signInWithGoogle()
      .catch((err: unknown) => {
        const code = (err as { code?: string })?.code ?? '';
        // Closing the Google popup is a decision, not a failure.
        if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setBusy(false));
  }, [fb]);

  if (requirement === 'checking') {
    return (
      <Gate>
        <Spinner />
      </Gate>
    );
  }

  // The local console, unchanged and untouched by any of the above.
  if (requirement === 'open') return <>{children}</>;

  if (!fb || user === undefined) {
    return (
      <Gate>
        <Spinner />
      </Gate>
    );
  }

  if (user === null) {
    return (
      <Gate>
        <Heading size="md">AdScout</Heading>
        <Text color="fg.muted" fontSize="sm">
          This console sends mail and holds every reply. Sign in with an allowlisted Google account to continue.
        </Text>
        <Button colorPalette="brand" size="lg" onClick={signIn} loading={busy}>
          Sign in with Google
        </Button>
        {error && (
          <Text color="fg.error" fontSize="xs">
            {error}
          </Text>
        )}
      </Gate>
    );
  }

  // DO NOT MOUNT CHILDREN UNTIL THE TOKEN PROVIDER EXISTS.
  //
  // React runs child effects BEFORE parent effects, so rendering {children} in
  // the same commit that sets `user` means every panel fires its first fetch
  // before the effect above has installed the provider. authHeaders() finds
  // none, sends no Authorization header, and the whole dashboard 401s on load
  // while the sign-in itself looks perfectly fine. Effect 4 was already written
  // to dodge this by passing its header explicitly; children cannot, because
  // they do not know about tokens at all.
  //
  // One extra render is the entire cost, and it makes the ordering explicit
  // rather than something the next person has to know about React to see.
  if (!tokenReady) {
    return (
      <Gate>
        <Spinner />
      </Gate>
    );
  }

  return (
    <RoleContext.Provider value={role}>
      <Box>
        <SignedInBar email={user.email} role={role} onSignOut={() => void fb.signOutViewer()} />
        {children}
      </Box>
    </RoleContext.Provider>
  );
}

/** Who you are and how to stop being them. Deliberately unobtrusive — on a
 *  single-operator install this bar is the only sign anything changed. */
function SignedInBar({ email, role, onSignOut }: { email: string | null; role: Role; onSignOut: () => void }) {
  return (
    <Flex
      justify="flex-end"
      align="center"
      gap={3}
      px={4}
      py={1.5}
      borderBottomWidth="1px"
      borderColor="border.muted"
      bg="bg.subtle"
    >
      <Text fontSize="xs" color="fg.muted">
        {email}
        {role === 'manager' && ' · manager'}
      </Text>
      <Button size="xs" variant="ghost" onClick={onSignOut}>
        Sign out
      </Button>
    </Flex>
  );
}
