import {
  Badge,
  Box,
  Button,
  Circle,
  Flex,
  Heading,
  HStack,
  Span,
  Square,
  Tabs,
  Text,
  Tooltip,
} from '@chakra-ui/react';
import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import { useRoute } from './hooks/useRoute';
import { useIsManager, useRole } from './role';
import { useSession } from './session';
import type { Status } from './types';
import { useStream, type LiveState } from './hooks/useStream';
import { AccountsView } from './components/AccountsView';
import { TargetsView } from './components/TargetsView';
import { BatchesView } from './components/BatchesView';
import { ResponsesView } from './components/ResponsesView';
import { DealsView } from './components/DealsView';
import { DomainsView } from './components/DomainsView';
import { IgnoreView } from './components/IgnoreView';
import { SuppressionsView } from './components/SuppressionsView';
import { LabelsView } from './components/LabelsView';
import { RunView } from './components/RunView';
import { OverviewView } from './components/OverviewView';
import {
  InboxIcon,
  LayoutIcon,
  LabelsIcon,
  LogOutIcon,
  MegaphoneIcon,
  PlayIcon,
  ShieldIcon,
  TagIcon,
  TargetIcon,
  UsersIcon,
} from './components/icons';
import type { IconProps } from '@chakra-ui/react';
import type { ComponentType } from 'react';

/** The order the sections appear in the rail: the screen you land on, then the
 *  funnel, then the record it produces, then the things you set once and forget. */
const GROUPS = ['Overview', 'Outreach', 'Replies', 'Negotiation', 'Settings'] as const;
type Group = (typeof GROUPS)[number];

const TABS: {
  id: string;
  label: string;
  icon: ComponentType<IconProps>;
  group: Group;
  count?: (s: Status | null) => number | undefined;
  /** Hidden from a manager. The server refuses these routes regardless — this
   *  only keeps a control out of the UI that could never work. */
  adminOnly?: boolean;
}[] = [
  { id: 'overview', label: 'Overview', icon: LayoutIcon, group: 'Overview' },
  { id: 'targets', label: 'Targets', icon: TargetIcon, group: 'Outreach', count: (s) => s?.targets.total },
  { id: 'batches', label: 'Batches', icon: TagIcon, group: 'Outreach' },
  // Starting a send pass is the operator's call, not a deal manager's.
  { id: 'run', label: 'Run', icon: PlayIcon, group: 'Outreach', adminOnly: true },
  { id: 'responses', label: 'Responses', icon: InboxIcon, group: 'Replies' },
  { id: 'domains', label: 'Domains', icon: TagIcon, group: 'Replies' },
  { id: 'deals', label: 'Deals', icon: MegaphoneIcon, group: 'Negotiation' },
  { id: 'accounts', label: 'Accounts', icon: UsersIcon, group: 'Settings', count: (s) => s?.accounts },
  { id: 'labels', label: 'Labels', icon: LabelsIcon, group: 'Settings' },
  { id: 'suppressions', label: 'Suppressions', icon: ShieldIcon, group: 'Settings' },
  { id: 'ignore', label: 'Ignore', icon: ShieldIcon, group: 'Settings' },
];

const TAB_IDS = new Set(TABS.map((t) => t.id));
const DEFAULT_TAB = 'overview';

const LIVE: Record<LiveState, { color: string; label: string }> = {
  connecting: { color: 'gray.400', label: 'Connecting' },
  live: { color: 'green.500', label: 'Live' },
  reconnecting: { color: 'orange.500', label: 'Reconnecting' },
};

function ConnectionPill({ live }: { live: LiveState }) {
  const { color, label } = LIVE[live];
  return (
    <HStack
      gap={2}
      bg="bg.muted"
      rounded="full"
      px={3}
      py={1.5}
      borderWidth="1px"
      borderColor="border"
    >
      <Box position="relative" display="inline-flex">
        <Circle size="2.5" bg={color} />
        {live === 'live' && (
          <Circle
            size="2.5"
            bg={color}
            position="absolute"
            inset="0"
            opacity={0.6}
            animation="ping 1.4s cubic-bezier(0,0,0.2,1) infinite"
          />
        )}
      </Box>
      <Text fontSize="xs" fontWeight="medium" color="fg.muted">
        {label}
      </Text>
    </HStack>
  );
}

/** Who is signed in, and the way out — at the foot of the rail, where an
 *  application puts its account menu. On the local console (no auth at all)
 *  this renders nothing, so that install is exactly what it was.
 *
 *  `compact` is the narrow-window version: the rail has become a scrolling row
 *  with no foot to sit in, so only the initials and the way out survive. */
function SessionFooter({ compact }: { compact?: boolean }) {
  const session = useSession();
  const role = useRole();
  if (!session) return null;
  const email = session.email ?? 'signed in';
  if (compact) {
    return (
      <HStack gap={1}>
        <Circle size={7} bg="brand.subtle" color="brand.fg" fontSize="2xs" fontWeight="bold" title={email}>
          {email.slice(0, 2).toUpperCase()}
        </Circle>
        <Button
          size="xs"
          variant="ghost"
          color="fg.muted"
          onClick={session.signOut}
          aria-label="Sign out"
          title="Sign out"
          px={2}
        >
          <LogOutIcon boxSize={4} />
        </Button>
      </HStack>
    );
  }
  return (
    <Box borderTopWidth="1px" borderColor="border" px={3} py={2.5}>
      <HStack gap={2.5}>
        <Circle size={7} bg="brand.subtle" color="brand.fg" fontSize="2xs" fontWeight="bold" flexShrink={0}>
          {email.slice(0, 2).toUpperCase()}
        </Circle>
        <Box minW={0} flex="1">
          <Text fontSize="xs" fontWeight="medium" truncate title={email}>
            {email}
          </Text>
          <Text fontSize="2xs" color="fg.muted" textTransform="uppercase" letterSpacing="wide">
            {role === 'manager' ? 'Manager' : 'Operator'}
          </Text>
        </Box>
        <Button
          size="xs"
          variant="ghost"
          color="fg.muted"
          onClick={session.signOut}
          aria-label="Sign out"
          title="Sign out"
          px={2}
        >
          <LogOutIcon boxSize={4} />
        </Button>
      </HStack>
    </Box>
  );
}

// Per-type tick counters — each view only refetches when its data type changes.
type Ticks = { batch: number; account: number; target: number; reply: number; suppression: number; deal: number };
const ZERO_TICKS: Ticks = { batch: 0, account: 0, target: 0, reply: 0, suppression: 0, deal: 0 };

export function App() {
  const { route, navigate } = useRoute(DEFAULT_TAB);
  // An unknown path (a stale bookmark, a typo) shows the default rather than a
  // blank screen with every tab unselected.
  const isManager = useIsManager();
  const tabs = isManager ? TABS.filter((t) => !t.adminOnly) : TABS;
  const visibleTabIds = new Set(tabs.map((t) => t.id));
  // Fall back to the default rather than render a tab that is not in the list:
  // a manager arriving on a bookmarked #run would otherwise land on a tab with
  // no trigger, which reads as a blank page.
  const tab = visibleTabIds.has(route.tab) ? route.tab : TAB_IDS.has(route.tab) && !isManager ? route.tab : DEFAULT_TAB;
  const tabMeta = TABS.find((t) => t.id === tab);
  const [status, setStatus] = useState<Status | null>(null);
  const [statusErr, setStatusErr] = useState(false);
  const [ticks, setTicks] = useState<Ticks>(ZERO_TICKS);

  // Unfiltered on purpose. The batch filter belongs to the Overview screen's
  // funnel; the rail's Targets badge is a count of everything, and reading a
  // filtered number there made the nav disagree with the page it pointed at.
  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await api.status());
      setStatusErr(false);
    } catch {
      setStatusErr(true);
    }
  }, []);

  const onChange = useCallback((type?: string) => {
    void refreshStatus();
    // Placements and thread links are parts of a deal — they drive the same tick,
    // so editing a post refreshes the Deals view and nothing else.
    const mapped = type === 'placement' || type === 'threadlink' ? 'deal' : type;
    const key = mapped as keyof Ticks | undefined;
    if (key && key in ZERO_TICKS) {
      setTicks((t) => ({ ...t, [key]: t[key] + 1 }));
    } else {
      // Unknown type — bump everything.
      setTicks((t) => ({ batch: t.batch+1, account: t.account+1, target: t.target+1, reply: t.reply+1, suppression: t.suppression+1, deal: t.deal+1 }));
    }
  }, [refreshStatus]);

  const live = useStream(onChange);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  // NAVIGATION LIVES IN A LEFT RAIL, not a strip of tabs over the page. Ten
  // destinations is more than a tab row can hold without wrapping to a second
  // line (which it did, on any window narrower than a desktop), and a rail can
  // group them: the funnel, the record it produces, and the settings you touch
  // once. It also stays put — a page's own content no longer shifts the way you
  // move around. Below `lg` there is no room for a column, so the same list
  // becomes a scrolling row above the page.
  //
  // These are still Chakra tabs, deliberately: the triggers keep their roles,
  // arrow-key navigation and content association, and `lazyMount` still means a
  // view keeps its filters once you have visited it.
  return (
    <Tabs.Root
      value={tab}
      onValueChange={(e) => navigate(e.value)}
      orientation="vertical"
      variant="plain"
      colorPalette="brand"
      size="md"
      lazyMount
      display="flex"
      flexDirection={{ base: 'column', lg: 'row' }}
      alignItems="stretch"
      minH="100dvh"
    >
      <Flex
        as="nav"
        direction="column"
        w={{ base: 'full', lg: '15.5rem' }}
        flexShrink={0}
        bg="bg.panel"
        borderColor="border"
        borderRightWidth={{ base: 0, lg: '1px' }}
        borderBottomWidth={{ base: '1px', lg: 0 }}
        position="sticky"
        top="0"
        alignSelf="flex-start"
        h={{ lg: '100dvh' }}
        zIndex="docked"
      >
        <HStack gap={2.5} px={4} py={3.5} flexShrink={0}>
          <Square size={9} rounded="lg" bg="brand.solid" color="brand.contrast" boxShadow="sm">
            <TargetIcon boxSize={5} />
          </Square>
          <Box>
            <Heading size="md" lineHeight="1.1" letterSpacing="tight">
              AdScout
            </Heading>
            <Text fontSize="2xs" color="fg.muted" letterSpacing="wide" textTransform="uppercase">
              Outreach console
            </Text>
          </Box>
        </HStack>

        <Tabs.List
          flexDirection={{ base: 'row', lg: 'column' }}
          alignItems={{ base: 'center', lg: 'stretch' }}
          gap={0.5}
          px={2}
          pb={2}
          flex={{ lg: '1' }}
          minH={0}
          overflowX={{ base: 'auto', lg: 'hidden' }}
          overflowY={{ lg: 'auto' }}
          borderWidth={0}
        >
          {GROUPS.map((group) => {
            const inGroup = tabs.filter((t) => t.group === group);
            if (inGroup.length === 0) return null;
            return (
              <Box key={group} display="contents">
                <Text
                  // Decoration inside a tablist: hidden from assistive tech so
                  // the list still reads as ten tabs, not ten tabs and four
                  // stray labels.
                  aria-hidden
                  // Overview is a single destination that already says its own
                  // name — a section header repeating it above would be one word
                  // printed twice.
                  display={{ base: 'none', lg: group === 'Overview' ? 'none' : 'block' }}
                  px={3}
                  pt={3}
                  pb={1}
                  fontSize="2xs"
                  fontWeight="semibold"
                  color="fg.subtle"
                  textTransform="uppercase"
                  letterSpacing="wider"
                >
                  {group}
                </Text>
                {inGroup.map((t) => {
                  const count = t.count?.(status);
                  return (
                    <Tabs.Trigger
                      key={t.id}
                      value={t.id}
                      gap={2.5}
                      justifyContent="flex-start"
                      flexShrink={0}
                      w={{ lg: 'full' }}
                      px={3}
                      py={2}
                      rounded="md"
                      fontSize="sm"
                      fontWeight="medium"
                      color="fg.muted"
                      _hover={{ bg: 'bg.muted', color: 'fg' }}
                      _selected={{ bg: 'brand.subtle', color: 'brand.fg', fontWeight: 'semibold' }}
                    >
                      <t.icon boxSize={4} flexShrink={0} />
                      {t.label}
                      {count != null && (
                        <Badge
                          size="sm"
                          ms="auto"
                          rounded="full"
                          colorPalette={tab === t.id ? 'brand' : 'gray'}
                          variant={tab === t.id ? 'solid' : 'subtle'}
                        >
                          {count}
                        </Badge>
                      )}
                    </Tabs.Trigger>
                  );
                })}
              </Box>
            );
          })}
        </Tabs.List>

        <Box display={{ base: 'none', lg: 'block' }} flexShrink={0}>
          <SessionFooter />
        </Box>
      </Flex>

      <Box flex="1" minW={0}>
        <Flex
          as="header"
          align="center"
          gap={4}
          px={{ base: 4, md: 8 }}
          py={3}
          bg="bg.panel"
          borderBottomWidth="1px"
          borderColor="border"
          position="sticky"
          top="0"
          zIndex="docked"
          boxShadow="xs"
        >
          <Heading size="md" letterSpacing="tight">
            {tabMeta?.label ?? 'AdScout'}
          </Heading>

          <Box flex="1" />

          {status?.providers && (
            <Tooltip.Root openDelay={200} closeDelay={100}>
              <Tooltip.Trigger asChild>
                <HStack gap={1.5} display={{ base: 'none', md: 'flex' }}>
                  {[
                    ['email', status.providers.email],
                    ['llm', status.providers.llm],
                    ['store', status.providers.store],
                  ].map(([k, v]) => (
                    <Badge key={k} variant="surface" colorPalette="gray" textTransform="none">
                      <Span color="fg.subtle">{k}</Span>
                      <Span fontWeight="semibold">{v}</Span>
                    </Badge>
                  ))}
                </HStack>
              </Tooltip.Trigger>
              <Tooltip.Positioner>
                <Tooltip.Content>Active providers — email / LLM / store</Tooltip.Content>
              </Tooltip.Positioner>
            </Tooltip.Root>
          )}

          <ConnectionPill live={live} />

          {/* No room for the rail's footer on a narrow window, so the account
              rides in the header there instead. */}
          <Box display={{ base: 'block', lg: 'none' }}>
            <SessionFooter compact />
          </Box>
        </Flex>

        <Box maxW="1280px" mx="auto" px={{ base: 4, md: 6 }} py={6}>
          {statusErr && (
            <Box
              bg="red.subtle"
              color="red.fg"
              borderWidth="1px"
              borderColor="red.muted"
              rounded="lg"
              px={4}
              py={3}
              mb={5}
              fontSize="sm"
            >
              Can't reach the AdScout API. Is the server running (<code>pnpm dev</code> / <code>pnpm serve</code>)?
            </Box>
          )}

          <Tabs.Content value="overview">
            <OverviewView
              tick={ticks.target + ticks.reply + ticks.deal + ticks.account + ticks.batch}
              onNavigate={(t) => navigate(t)}
              onOpenDeal={(id) => navigate('deals', id)}
            />
          </Tabs.Content>
          <Tabs.Content value="accounts">
            <AccountsView tick={ticks.account} />
          </Tabs.Content>
          <Tabs.Content value="targets">
            <TargetsView tick={ticks.target} />
          </Tabs.Content>
          <Tabs.Content value="batches">
            <BatchesView tick={ticks.batch + ticks.target} />
          </Tabs.Content>
          <Tabs.Content value="responses">
            <ResponsesView tick={ticks.reply} onOpenDeal={(id) => navigate('deals', id)} />
          </Tabs.Content>
          <Tabs.Content value="domains">
            <DomainsView tick={ticks.reply + ticks.target} />
          </Tabs.Content>
          <Tabs.Content value="deals">
            {/* A publisher's answer arrives as a `reply`, not a `deal` — without
                it in the tick the open conversation would sit stale until
                something else touched the deal. */}
            <DealsView
              tick={ticks.deal + ticks.reply}
              dealId={route.tab === 'deals' ? route.id : undefined}
              onSelect={(id) => navigate('deals', id)}
            />
          </Tabs.Content>
          <Tabs.Content value="suppressions">
            <SuppressionsView tick={ticks.suppression} />
          </Tabs.Content>
          <Tabs.Content value="ignore">
            <IgnoreView tick={ticks.reply} />
          </Tabs.Content>
          <Tabs.Content value="labels">
            <LabelsView />
          </Tabs.Content>
          {!isManager && (
            <Tabs.Content value="run">
              <RunView status={status} />
            </Tabs.Content>
          )}
        </Box>
      </Box>
    </Tabs.Root>
  );
}
