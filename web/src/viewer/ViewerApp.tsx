import { Badge, Box, Button, Container, Flex, HStack, Spinner, Tabs, Text } from '@chakra-ui/react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { DomainsView } from '../components/DomainsView';
import { ResponsesView } from '../components/ResponsesView';
import type { DomainSummary, Niche } from '../types';
import { setClassification, type Classification } from './classification';
import { loadClassification, saveClassification } from './classification-store';
import {
  isPermissionDenied,
  signInWithGoogle,
  signOutViewer,
  watchAuth,
  type User,
} from './firebase';
import { NichesPanel } from './NichesPanel';
import { Notice, SignIn } from './SignIn';
import { currentManifest, invalidate, loadManifest } from './snapshot-client';
import { Mono, Rule, Wordmark } from './ui';

/**
 * The shared read-only console.
 *
 * Same views as the operator app, fed from a published snapshot instead of a
 * live server: no accounts, no sending, no polling, nothing that writes. The
 * only state that belongs to the viewer is his own niche classification.
 *
 * It deliberately does not look like the operator console — see viewer/theme.ts.
 * This is a price book someone reads, not a machine someone drives.
 */
export function ViewerApp() {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [signingIn, setSigningIn] = useState(false);
  const [signInError, setSignInError] = useState<string | null>(null);
  useEffect(() => watchAuth(setUser), []);

  const signIn = useCallback(() => {
    setSigningIn(true);
    setSignInError(null);
    void signInWithGoogle()
      .catch((err: unknown) => {
        const code = (err as { code?: string })?.code ?? '';
        // Closing the Google popup is a decision, not a failure.
        if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') return;
        setSignInError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setSigningIn(false));
  }, []);

  if (user === undefined) {
    return (
      <Flex minH="100dvh" align="center" justify="center">
        <Spinner size="sm" color="fg.subtle" />
      </Flex>
    );
  }

  if (user === null) {
    return (
      <>
        <SignIn onSignIn={signIn} busy={signingIn} />
        {signInError && (
          <Box position="fixed" bottom={6} left="50%" transform="translateX(-50%)" maxW="md" px={4} w="full">
            <Box bg="red.subtle" borderWidth="1px" borderColor="red.muted" rounded="l2" px={4} py={3}>
              <Mono color="red.fg" mb={1}>
                sign-in failed
              </Mono>
              <Text fontSize="sm">{signInError}</Text>
            </Box>
          </Box>
        )}
      </>
    );
  }

  return <SignedIn user={user} />;
}

// --- signed in --------------------------------------------------------------

function fmtStamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d
    .toLocaleString(undefined, {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
    .replace(',', ' ·');
}

const n = (v: number) => v.toLocaleString();

/**
 * How fresh this data is, and how much of it there is.
 *
 * It is the first question anyone reading a price has, so it sits above the
 * tabs rather than in a corner. Re-checking lives here too — it is the one
 * action that changes what the stamp says.
 */
function AsOfStamp({ onRefresh, busy }: { onRefresh: () => void; busy: boolean }) {
  const manifest = currentManifest();
  return (
    <HStack
      gap={{ base: 2, md: 4 }}
      px={{ base: 3, md: 4 }}
      py={2}
      borderWidth="1px"
      borderColor="border.emphasized"
      rounded="l2"
      bg="bg.panel"
      flexWrap="wrap"
    >
      <Mono color="fg.subtle" flexShrink={0}>
        quotes as of
      </Mono>
      <Mono color="fg" fontWeight="600" flexShrink={0}>
        {manifest ? fmtStamp(manifest.builtAt) : '—'}
      </Mono>
      <Rule display={{ base: 'none', md: 'block' }} minW={4} />
      {manifest && (
        <Mono flexShrink={0}>
          {n(manifest.counts.domains)} sites · {n(manifest.counts.replies)} replies ·{' '}
          {n(manifest.counts.niches)} niches
        </Mono>
      )}
      <Box w="1px" alignSelf="stretch" bg="border" display={{ base: 'none', md: 'block' }} />
      <Box
        as="button"
        {...{ type: 'button', disabled: busy }}
        onClick={onRefresh}
        fontFamily="mono"
        fontSize="11px"
        fontWeight="500"
        textTransform="uppercase"
        letterSpacing="0.1em"
        color="brand.fg"
        cursor="pointer"
        flexShrink={0}
        _hover={{ textDecoration: 'underline' }}
        _disabled={{ opacity: 0.45, cursor: 'default', textDecoration: 'none' }}
        _focusVisible={{ outline: '2px solid', outlineColor: 'brand.focusRing', outlineOffset: '2px' }}
      >
        {busy ? 'checking…' : 'check for new'}
      </Box>
    </HStack>
  );
}

function NavLabel({ children, count }: { children: string; count?: number }) {
  return (
    <HStack gap={2}>
      <Text
        fontFamily="mono"
        fontSize="12px"
        fontWeight="500"
        textTransform="uppercase"
        letterSpacing="0.12em"
        mr="-0.12em"
      >
        {children}
      </Text>
      {count !== undefined && count > 0 && (
        <Text fontFamily="mono" fontSize="11px" color="fg.subtle">
          {n(count)}
        </Text>
      )}
    </HStack>
  );
}

function SignedIn({ user }: { user: User }) {
  const [tab, setTab] = useState('domains');
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [denied, setDenied] = useState(false);
  // Bumped whenever the underlying data or the classification changes; the views
  // re-read through it, which is how a re-classified niche re-renders everywhere.
  const [tick, setTick] = useState(0);
  const [classification, setLocalClassification] = useState<Classification>({});
  const [niches, setNiches] = useState<Niche[]>([]);
  const [domains, setDomains] = useState<DomainSummary[]>([]);

  const boot = useCallback(async () => {
    setError(null);
    try {
      // His classification must be in place BEFORE any data is read, or the
      // first render would show every niche as unclassified and then flicker.
      const map = await loadClassification(user.uid);
      setClassification(map);
      setLocalClassification(map);
      await loadManifest();
      setNiches(await api.listNiches());
      setDomains(await api.listDomains());
      setReady(true);
      setTick((t) => t + 1);
    } catch (err) {
      if (isPermissionDenied(err)) setDenied(true);
      else setError(err instanceof Error ? err.message : String(err));
    }
  }, [user.uid]);

  useEffect(() => {
    void boot();
  }, [boot]);

  const refresh = useCallback(async () => {
    setReady(false);
    invalidate();
    await boot();
  }, [boot]);

  const onClassificationChange = useCallback(
    (next: Classification) => {
      setClassification(next);
      setLocalClassification(next);
      setTick((t) => t + 1);
      // Fire-and-forget: the UI already reflects it, and a failed write is worth
      // surfacing but not worth blocking the click on.
      void saveClassification(user.uid, next).catch((err) =>
        setError(`Your niche settings did not save: ${err instanceof Error ? err.message : String(err)}`),
      );
    },
    [user.uid],
  );

  // Every niche that actually appears in the data, plus the taxonomy itself —
  // so a niche only ever quoted by one publisher is still classifiable.
  const classifiable = useMemo(() => {
    const seen = new Map<string, string>();
    for (const niche of niches) seen.set(niche.key, niche.label || niche.key);
    for (const d of domains) {
      for (const c of d.cells ?? []) if (!seen.has(c.category)) seen.set(c.category, c.label || c.category);
    }
    return [...seen.entries()].map(([key, label]) => ({ key, label }));
  }, [niches, domains]);

  const unknownCount = classifiable.filter((x) => classification[x.key] === undefined).length;

  if (denied) {
    return (
      <Notice
        eyebrow="no access"
        title="That account isn’t on the allowlist."
        action={
          <Button variant="outline" onClick={() => void signOutViewer()} mt={2}>
            Sign in with another account
          </Button>
        }
      >
        You’re signed in as {user.email}. Ask for that address to be added, or switch to the account you were given
        access with.
      </Notice>
    );
  }

  const counts = currentManifest()?.counts;

  return (
    <Box minH="100dvh">
      <Box
        position="sticky"
        top={0}
        zIndex={20}
        bg="bg/85"
        backdropFilter="blur(10px)"
        borderBottomWidth="1px"
        borderColor="border"
      >
        <Container maxW="7xl" px={{ base: 4, md: 6 }}>
          <Flex h="52px" align="center" gap={{ base: 2, md: 4 }}>
            <Wordmark />
            <Badge colorPalette="gray" variant="outline" size="sm" flexShrink={0} display={{ base: 'none', md: 'inline-flex' }}>
              read-only
            </Badge>
            <Box flex="1" />
            <Mono color="fg.subtle" truncate maxW={{ base: '110px', sm: '240px' }} textTransform="none">
              {user.email}
            </Mono>
            <Button size="xs" variant="ghost" onClick={() => void signOutViewer()} flexShrink={0}>
              Sign out
            </Button>
          </Flex>
        </Container>
      </Box>

      <Container maxW="7xl" px={{ base: 4, md: 6 }} pt={5} pb={12}>
        <AsOfStamp onRefresh={() => void refresh()} busy={!ready} />

        {error && (
          <Box mt={4} bg="red.subtle" borderWidth="1px" borderColor="red.muted" rounded="l2" px={4} py={3}>
            <Mono color="red.fg" mb={1}>
              couldn’t load
            </Mono>
            <Text fontSize="sm">{error}</Text>
          </Box>
        )}

        {!ready ? (
          <Flex align="center" justify="center" py={24} gap={3}>
            <Spinner size="sm" color="fg.subtle" />
            <Mono>reading the snapshot…</Mono>
          </Flex>
        ) : (
          <Tabs.Root value={tab} onValueChange={(e) => setTab(e.value)} variant="line" colorPalette="brand" mt={5}>
            <Tabs.List
              borderBottomWidth="1px"
              borderColor="border"
              gap={6}
              // The three tabs plus their counts are wider than a phone; let
              // them scroll rather than stretch the page.
              overflowX="auto"
              css={{ scrollbarWidth: 'none', '&::-webkit-scrollbar': { display: 'none' } }}
            >
              <Tabs.Trigger value="domains" px={0} pb={3} color="fg.muted" _selected={{ color: 'fg' }}>
                <NavLabel count={counts?.domains}>Sites</NavLabel>
              </Tabs.Trigger>
              <Tabs.Trigger value="responses" px={0} pb={3} color="fg.muted" _selected={{ color: 'fg' }}>
                <NavLabel count={counts?.replies}>Replies</NavLabel>
              </Tabs.Trigger>
              <Tabs.Trigger value="niches" px={0} pb={3} color="fg.muted" _selected={{ color: 'fg' }}>
                <NavLabel>Niches</NavLabel>
                {unknownCount > 0 && (
                  <Badge colorPalette="orange" variant="subtle" size="sm" ml={2}>
                    {unknownCount} new
                  </Badge>
                )}
              </Tabs.Trigger>
            </Tabs.List>

            {/* Both data views lay out on fixed pixel columns wider than a
                phone. Giving them their own scroll box keeps the overflow
                inside the table instead of in the page. */}
            <Tabs.Content value="domains" overflowX="auto">
              <DomainsView tick={tick} readOnly />
            </Tabs.Content>
            <Tabs.Content value="responses" overflowX="auto">
              <ResponsesView tick={tick} readOnly />
            </Tabs.Content>
            <Tabs.Content value="niches">
              <NichesPanel
                niches={classifiable}
                classification={classification}
                onChange={onClassificationChange}
              />
            </Tabs.Content>
          </Tabs.Root>
        )}
      </Container>
    </Box>
  );
}
