import {
  Badge,
  Box,
  Button,
  Card,
  Flex,
  HStack,
  SimpleGrid,
  Text,
  VStack,
  Wrap,
} from '@chakra-ui/react';
import { useRef, useState } from 'react';
import { api } from '../api';
import type { Status } from '../types';
import { Empty } from './Empty';
import { Panel } from './Panel';
import { toastError } from './Toaster';
import { ClockIcon, InboxIcon, PlayIcon, RefreshIcon, SendIcon, StopIcon } from './icons';

type Kind = 'send' | 'poll' | 'fetch';

interface Entry {
  id: number;
  kind: Kind;
  time: string;
  report?: Record<string, unknown>;
  error?: string;
}

interface Progress {
  current: number;
  total: number;
}

// Per-metric color so good/bad outcomes read at a glance.
const METRIC_PALETTE: Record<string, string> = {
  sent: 'green',
  reserved: 'blue',
  matched: 'green',
  extracted: 'green',
  failed: 'red',
  bounced: 'red',
  unmatched: 'orange',
  extractionFailed: 'red',
  skipped: 'gray',
  deduped: 'gray',
  fetched: 'gray',
};

function Metric({ name, value }: { name: string; value: number }) {
  const palette = METRIC_PALETTE[name] ?? 'gray';
  const dim = value === 0;
  return (
    <Badge
      size="lg"
      variant={dim ? 'subtle' : 'surface'}
      colorPalette={dim ? 'gray' : palette}
      rounded="md"
      gap={1.5}
    >
      <Text as="span" fontWeight="bold">
        {value}
      </Text>
      <Text as="span" color={dim ? 'fg.subtle' : undefined} textTransform="none" fontWeight="normal">
        {name.replace(/([A-Z])/g, ' $1').toLowerCase()}
      </Text>
    </Badge>
  );
}

const KIND_META: Record<Kind, { label: string; palette: string; icon: typeof SendIcon }> = {
  send:  { label: 'Send pass',  palette: 'brand',  icon: SendIcon },
  poll:  { label: 'Poll pass',  palette: 'purple', icon: RefreshIcon },
  fetch: { label: 'Fetch pass', palette: 'teal',   icon: InboxIcon },
};

function ReportCard({ entry }: { entry: Entry }) {
  const { label, palette, icon: Icon } = KIND_META[entry.kind];
  return (
    <Card.Root size="sm" variant="outline">
      <Card.Body>
        <Flex align="center" gap={2} mb={entry.report || entry.error ? 3 : 0}>
          <Badge colorPalette={palette} variant="subtle">
            <Icon />
            {label}
          </Badge>
          <Box flex="1" />
          <HStack gap={1} color="fg.subtle" fontSize="xs">
            <ClockIcon boxSize={3} />
            <Text>{entry.time}</Text>
          </HStack>
        </Flex>

        {entry.error ? (
          <Text color="red.fg" fontSize="sm" fontFamily="mono">
            {entry.error}
          </Text>
        ) : entry.report ? (
          <Wrap gap={2}>
            {Object.entries(entry.report).map(([k, v]) =>
              typeof v === 'number' ? <Metric key={k} name={k} value={v} /> : null,
            )}
          </Wrap>
        ) : null}
      </Card.Body>
    </Card.Root>
  );
}

function fmt(h: number) {
  return `${h % 12 === 0 ? 12 : h % 12}${h < 12 ? 'am' : 'pm'}`;
}

function WindowBadge({ status }: { status: Status | null }) {
  if (!status?.sendWindow) return null;
  const { startHour, endHour } = status.sendWindow;
  const active = status.windowActive;
  return (
    <HStack gap={2} align="center">
      <Badge
        colorPalette={active ? 'green' : 'gray'}
        variant={active ? 'surface' : 'subtle'}
        size="md"
        rounded="full"
        gap={1.5}
      >
        <Box
          w="1.5"
          h="1.5"
          rounded="full"
          bg={active ? 'green.500' : 'gray.400'}
          display="inline-block"
        />
        {active ? 'Send window active' : 'Send window closed'}
      </Badge>
      <Text fontSize="xs" color="fg.muted">
        {fmt(startHour)}–{fmt(endHour)} local time
      </Text>
    </HStack>
  );
}

/** Thin progress bar shown below the run button while a pass is in progress. */
function ProgressBar({ progress }: { progress: Progress | null }) {
  if (!progress || progress.total === 0) return null;
  const pct = Math.round((progress.current / progress.total) * 100);
  return (
    <Box w="100%">
      <Box
        h="4px"
        rounded="full"
        bg="bg.subtle"
        overflow="hidden"
      >
        <Box
          h="100%"
          rounded="full"
          bg="colorPalette.solid"
          transition="width 0.3s ease"
          style={{ width: `${pct}%` }}
        />
      </Box>
      <Text fontSize="2xs" color="fg.muted" mt={1}>
        {progress.current}/{progress.total}
      </Text>
    </Box>
  );
}

export function RunView({ status }: { status: Status | null }) {
  const [log, setLog] = useState<Entry[]>([]);
  const [busy, setBusy] = useState<Kind | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const nextId = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  const run = async (kind: Kind) => {
    setBusy(kind);
    setProgress(null);
    const ac = new AbortController();
    abortRef.current = ac;
    const id = nextId.current++;
    const time = new Date().toLocaleTimeString();
    try {
      const apiFn = kind === 'send' ? api.runSend : kind === 'poll' ? api.runPoll : api.runFetch;
      const report = (await apiFn({
        signal: ac.signal,
        onProgress: (current, total) => setProgress({ current, total }),
      })) as Record<string, unknown>;
      setLog((l) => [{ id, kind, time, report }, ...l]);
    } catch (e) {
      if (ac.signal.aborted) {
        setLog((l) => [{ id, kind, time, error: 'Stopped by user' }, ...l]);
      } else {
        const error = toastError(`${kind} pass failed`, e);
        setLog((l) => [{ id, kind, time, error }, ...l]);
      }
    } finally {
      abortRef.current = null;
      setBusy(null);
      setProgress(null);
    }
  };

  const stop = () => {
    abortRef.current?.abort();
  };

  return (
    <Box pt={4}>
      <Flex align="center" mb={4}>
        <WindowBadge status={status} />
      </Flex>
      <SimpleGrid columns={{ base: 1, sm: 3 }} gap={3} mb={5}>
        <Card.Root variant="outline">
          <Card.Body gap={3}>
            <HStack>
              <SendIcon boxSize={5} color="brand.fg" />
              <Text fontWeight="semibold">Send pass</Text>
            </HStack>
            <Text fontSize="sm" color="fg.muted">
              Reserve and send the next batch of outreach — respects each account's daily cap.
            </Text>
            <HStack>
              <Button
                colorPalette="brand"
                onClick={() => run('send')}
                loading={busy === 'send'}
                loadingText="Sending…"
                disabled={busy !== null && busy !== 'send'}
                alignSelf="flex-start"
              >
                <PlayIcon />
                Run send pass
              </Button>
              {busy === 'send' && (
                <Button
                  size="sm"
                  variant="ghost"
                  colorPalette="red"
                  onClick={stop}
                  aria-label="Stop send pass"
                >
                  <StopIcon />
                  Stop
                </Button>
              )}
            </HStack>
            {busy === 'send' && <ProgressBar progress={progress} />}
          </Card.Body>
        </Card.Root>

        <Card.Root variant="outline">
          <Card.Body gap={3}>
            <HStack>
              <RefreshIcon boxSize={5} color="purple.fg" />
              <Text fontWeight="semibold">Poll pass</Text>
            </HStack>
            <Text fontSize="sm" color="fg.muted">
              Fetch new replies, match them to targets, and extract posting terms.
            </Text>
            <HStack>
              <Button
                colorPalette="purple"
                variant="outline"
                onClick={() => run('poll')}
                loading={busy === 'poll'}
                loadingText="Polling…"
                disabled={busy !== null && busy !== 'poll'}
                alignSelf="flex-start"
              >
                <RefreshIcon />
                Run poll pass
              </Button>
              {busy === 'poll' && (
                <Button
                  size="sm"
                  variant="ghost"
                  colorPalette="red"
                  onClick={stop}
                  aria-label="Stop poll pass"
                >
                  <StopIcon />
                  Stop
                </Button>
              )}
            </HStack>
            {busy === 'poll' && <ProgressBar progress={progress} />}
          </Card.Body>
        </Card.Root>

        <Card.Root variant="outline">
          <Card.Body gap={3}>
            <HStack>
              <InboxIcon boxSize={5} color="teal.fg" />
              <Text fontWeight="semibold">Fetch responses</Text>
            </HStack>
            <Text fontSize="sm" color="fg.muted">
              Download new replies and store them — no AI extraction. Run poll pass afterward to process.
            </Text>
            <HStack>
              <Button
                colorPalette="teal"
                variant="outline"
                onClick={() => run('fetch')}
                loading={busy === 'fetch'}
                loadingText="Fetching…"
                disabled={busy !== null && busy !== 'fetch'}
                alignSelf="flex-start"
              >
                <InboxIcon />
                Fetch responses
              </Button>
              {busy === 'fetch' && (
                <Button
                  size="sm"
                  variant="ghost"
                  colorPalette="red"
                  onClick={stop}
                  aria-label="Stop fetch pass"
                >
                  <StopIcon />
                  Stop
                </Button>
              )}
            </HStack>
            {busy === 'fetch' && <ProgressBar progress={progress} />}
          </Card.Body>
        </Card.Root>
      </SimpleGrid>

      <Flex align="center" mb={3}>
        <Text fontWeight="semibold" fontSize="sm">
          Activity
        </Text>
        <Box flex="1" />
        <Button
          variant="ghost"
          size="xs"
          onClick={() => setLog([])}
          disabled={log.length === 0}
          color="fg.muted"
        >
          Clear
        </Button>
      </Flex>

      {log.length === 0 ? (
        <Panel>
          <Empty
            icon={ClockIcon}
            title="No runs yet"
            description="Run a send or poll pass — results appear here. The scheduler also drips automatically within the send window."
          />
        </Panel>
      ) : (
        <VStack align="stretch" gap={2}>
          {log.map((e) => (
            <ReportCard key={e.id} entry={e} />
          ))}
        </VStack>
      )}
    </Box>
  );
}
