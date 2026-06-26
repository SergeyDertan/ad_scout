import {
  Badge,
  Box,
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
import type { Status } from './types';
import { useStream, type LiveState } from './hooks/useStream';
import { AccountsView } from './components/AccountsView';
import { CampaignsView } from './components/CampaignsView';
import { TargetsView } from './components/TargetsView';
import { ResponsesView } from './components/ResponsesView';
import { SuppressionsView } from './components/SuppressionsView';
import { RunView } from './components/RunView';
import { StatCards } from './components/StatCards';
import {
  InboxIcon,
  MegaphoneIcon,
  PlayIcon,
  ShieldIcon,
  TargetIcon,
  UsersIcon,
} from './components/icons';
import type { IconProps } from '@chakra-ui/react';
import type { ComponentType } from 'react';

const TABS: {
  id: string;
  label: string;
  icon: ComponentType<IconProps>;
  count?: (s: Status | null) => number | undefined;
}[] = [
  { id: 'campaigns', label: 'Campaigns', icon: MegaphoneIcon },
  { id: 'accounts', label: 'Accounts', icon: UsersIcon, count: (s) => s?.accounts },
  { id: 'targets', label: 'Targets', icon: TargetIcon, count: (s) => s?.targets.total },
  { id: 'responses', label: 'Responses', icon: InboxIcon },
  { id: 'suppressions', label: 'Suppressions', icon: ShieldIcon },
  { id: 'run', label: 'Run', icon: PlayIcon },
];

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

// Per-type tick counters — each view only refetches when its data type changes.
type Ticks = { campaign: number; account: number; target: number; reply: number; suppression: number };
const ZERO_TICKS: Ticks = { campaign: 0, account: 0, target: 0, reply: 0, suppression: 0 };

export function App() {
  const [tab, setTab] = useState<string>('campaigns');
  const [status, setStatus] = useState<Status | null>(null);
  const [statusErr, setStatusErr] = useState(false);
  const [ticks, setTicks] = useState<Ticks>(ZERO_TICKS);

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
    const key = type as keyof Ticks | undefined;
    if (key && key in ZERO_TICKS) {
      setTicks((t) => ({ ...t, [key]: t[key] + 1 }));
    } else {
      // Unknown type — bump everything.
      setTicks((t) => ({ campaign: t.campaign+1, account: t.account+1, target: t.target+1, reply: t.reply+1, suppression: t.suppression+1 }));
    }
  }, [refreshStatus]);

  const live = useStream(onChange);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  return (
    <Box minH="100vh">
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
        <HStack gap={2.5}>
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
      </Flex>

      <Box maxW="1100px" mx="auto" px={{ base: 4, md: 6 }} py={6}>
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

        <StatCards status={status} />

        <Tabs.Root
          value={tab}
          onValueChange={(e) => setTab(e.value)}
          variant="enclosed"
          colorPalette="brand"
          size="md"
          lazyMount
        >
          <Tabs.List bg="bg.muted" rounded="lg" p={1} mb={1} flexWrap="wrap">
            {TABS.map((t) => {
              const count = t.count?.(status);
              return (
                <Tabs.Trigger key={t.id} value={t.id} gap={2}>
                  <t.icon boxSize={4} />
                  {t.label}
                  {count != null && (
                    <Badge
                      size="sm"
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
          </Tabs.List>

          <Tabs.Content value="campaigns">
            <CampaignsView tick={ticks.campaign} />
          </Tabs.Content>
          <Tabs.Content value="accounts">
            <AccountsView tick={ticks.account} />
          </Tabs.Content>
          <Tabs.Content value="targets">
            <TargetsView tick={ticks.target} />
          </Tabs.Content>
          <Tabs.Content value="responses">
            <ResponsesView tick={ticks.reply} />
          </Tabs.Content>
          <Tabs.Content value="suppressions">
            <SuppressionsView tick={ticks.suppression} />
          </Tabs.Content>
          <Tabs.Content value="run">
            <RunView status={status} />
          </Tabs.Content>
        </Tabs.Root>
      </Box>
    </Box>
  );
}
