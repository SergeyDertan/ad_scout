import { Box, Circle, Flex, Heading, HStack, Tabs, Text } from '@chakra-ui/react';
import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import type { Status } from './types';
import { useStream } from './hooks/useStream';
import { AccountsView } from './components/AccountsView';
import { TargetsView } from './components/TargetsView';
import { ResponsesView } from './components/ResponsesView';
import { SuppressionsView } from './components/SuppressionsView';
import { RunView } from './components/RunView';

const TABS = [
  { id: 'accounts', label: 'Accounts' },
  { id: 'targets', label: 'Targets' },
  { id: 'responses', label: 'Responses' },
  { id: 'suppressions', label: 'Suppressions' },
  { id: 'run', label: 'Run' },
] as const;

const LIVE_COLOR = { connecting: 'gray.400', live: 'green.400', reconnecting: 'orange.400' };

export function App() {
  const [tab, setTab] = useState<string>('accounts');
  const [status, setStatus] = useState<Status | null>(null);
  const [statusErr, setStatusErr] = useState(false);
  // Bumped on every SSE change → views re-fetch.
  const [tick, setTick] = useState(0);

  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await api.status());
      setStatusErr(false);
    } catch {
      setStatusErr(true);
    }
  }, []);

  const onChange = useCallback(() => {
    setTick((t) => t + 1);
    void refreshStatus();
  }, [refreshStatus]);

  const live = useStream(onChange);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  const summary = statusErr
    ? 'API unreachable'
    : status
      ? `${status.accounts} accounts · ${status.targets.total} targets` +
        (Object.keys(status.targets.byStatus).length
          ? ' · ' +
            Object.entries(status.targets.byStatus)
              .map(([k, v]) => `${k}:${v}`)
              .join('  ')
          : '')
      : 'connecting…';

  return (
    <Box minH="100vh">
      <Flex
        as="header"
        align="center"
        gap={4}
        px={6}
        py={3}
        borderBottomWidth="1px"
        borderColor="border"
      >
        <Heading size="md" letterSpacing="wide">
          AdScout
        </Heading>
        <Text fontSize="sm" color="fg.muted" flex="1" truncate>
          {summary}
        </Text>
        <HStack fontSize="xs" color="fg.muted" gap={2}>
          <Circle size="2" bg={LIVE_COLOR[live]} />
          <Text>{live}</Text>
          {status?.providers && (
            <Text color="fg.subtle">
              · {status.providers.email} / {status.providers.llm} / {status.providers.store}
            </Text>
          )}
        </HStack>
      </Flex>

      <Box maxW="1200px" mx="auto" px={6} py={6}>
        <Tabs.Root value={tab} onValueChange={(e) => setTab(e.value)} variant="enclosed">
          <Tabs.List>
            {TABS.map((t) => (
              <Tabs.Trigger key={t.id} value={t.id}>
                {t.label}
              </Tabs.Trigger>
            ))}
          </Tabs.List>

          <Tabs.Content value="accounts">
            <AccountsView tick={tick} />
          </Tabs.Content>
          <Tabs.Content value="targets">
            <TargetsView tick={tick} />
          </Tabs.Content>
          <Tabs.Content value="responses">
            <ResponsesView tick={tick} />
          </Tabs.Content>
          <Tabs.Content value="suppressions">
            <SuppressionsView tick={tick} />
          </Tabs.Content>
          <Tabs.Content value="run">
            <RunView />
          </Tabs.Content>
        </Tabs.Root>
      </Box>
    </Box>
  );
}
