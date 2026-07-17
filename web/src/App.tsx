import {
  Badge,
  Box,
  Circle,
  Flex,
  Heading,
  HStack,
  NativeSelect,
  Span,
  Square,
  Tabs,
  Text,
  Tooltip,
} from '@chakra-ui/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import type { BatchRow, Status } from './types';
import { useStream, type LiveState } from './hooks/useStream';
import { AccountsView } from './components/AccountsView';
import { TargetsView } from './components/TargetsView';
import { BatchesView } from './components/BatchesView';
import { ResponsesView } from './components/ResponsesView';
import { SuppressionsView } from './components/SuppressionsView';
import { LabelsView } from './components/LabelsView';
import { RunView } from './components/RunView';
import { StatCards } from './components/StatCards';
import {
  InboxIcon,
  LabelsIcon,
  PlayIcon,
  ShieldIcon,
  TagIcon,
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
  { id: 'accounts', label: 'Accounts', icon: UsersIcon, count: (s) => s?.accounts },
  { id: 'targets', label: 'Targets', icon: TargetIcon, count: (s) => s?.targets.total },
  { id: 'batches', label: 'Batches', icon: TagIcon },
  { id: 'responses', label: 'Responses', icon: InboxIcon },
  { id: 'suppressions', label: 'Suppressions', icon: ShieldIcon },
  { id: 'labels', label: 'Labels', icon: LabelsIcon },
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
type Ticks = { batch: number; account: number; target: number; reply: number; suppression: number };
const ZERO_TICKS: Ticks = { batch: 0, account: 0, target: 0, reply: 0, suppression: 0 };

/** A batch's display label: its name, else a short id (manual adds are unnamed). */
function batchLabel(b: BatchRow): string {
  return b.name?.trim() || `batch ${b.id.replace(/^batch_/, '').slice(0, 8)}`;
}

export function App() {
  const [tab, setTab] = useState<string>('targets');
  const [status, setStatus] = useState<Status | null>(null);
  const [statusErr, setStatusErr] = useState(false);
  const [ticks, setTicks] = useState<Ticks>(ZERO_TICKS);
  const [batches, setBatches] = useState<BatchRow[]>([]);
  const [statBatch, setStatBatch] = useState('');

  // Keep the selected batch in a ref so the SSE-driven refreshStatus stays
  // stable (no stream re-subscribe) while always reading the latest filter.
  const statBatchRef = useRef(statBatch);
  statBatchRef.current = statBatch;

  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await api.status(statBatchRef.current || undefined));
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
      setTicks((t) => ({ batch: t.batch+1, account: t.account+1, target: t.target+1, reply: t.reply+1, suppression: t.suppression+1 }));
    }
  }, [refreshStatus]);

  const live = useStream(onChange);

  // Refetch stats on mount and whenever the batch filter changes.
  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus, statBatch]);

  // Batch list for the stats filter; refresh when batches or targets change.
  useEffect(() => {
    api.listBatches().then(setBatches).catch(() => {});
  }, [ticks.batch, ticks.target]);

  // A deleted batch shouldn't stay selected in the filter.
  useEffect(() => {
    if (statBatch && !batches.some((b) => b.id === statBatch)) {
      setStatBatch('');
    }
  }, [batches, statBatch]);

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

        <Flex align="center" justify="space-between" gap={3} mb={3} flexWrap="wrap">
          <Text fontSize="sm" fontWeight="semibold" color="fg.muted" textTransform="uppercase" letterSpacing="wider">
            {(() => {
              const b = batches.find((x) => x.id === statBatch);
              return b ? `Statistics · ${batchLabel(b)}` : 'Statistics · all batches';
            })()}
          </Text>
          <HStack gap={2} bg="bg.panel" borderWidth="1px" borderColor="border" rounded="lg" pl={3} pr={1.5} py={1}>
            <NativeSelect.Root size="sm" width="48" variant="plain">
              <NativeSelect.Field
                value={statBatch}
                onChange={(e) => setStatBatch(e.target.value)}
                fontWeight="medium"
              >
                <option value="">all batches</option>
                {batches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {batchLabel(b)}
                  </option>
                ))}
              </NativeSelect.Field>
              <NativeSelect.Indicator />
            </NativeSelect.Root>
          </HStack>
        </Flex>

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
            <ResponsesView tick={ticks.reply} />
          </Tabs.Content>
          <Tabs.Content value="suppressions">
            <SuppressionsView tick={ticks.suppression} />
          </Tabs.Content>
          <Tabs.Content value="labels">
            <LabelsView />
          </Tabs.Content>
          <Tabs.Content value="run">
            <RunView status={status} />
          </Tabs.Content>
        </Tabs.Root>
      </Box>
    </Box>
  );
}
