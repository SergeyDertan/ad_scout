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
import { Empty } from './Empty';
import { Panel } from './Panel';
import { toastError } from './Toaster';
import { ClockIcon, PlayIcon, RefreshIcon, SendIcon } from './icons';

type Kind = 'send' | 'poll';

interface Entry {
  id: number;
  kind: Kind;
  time: string;
  report?: Record<string, unknown>;
  error?: string;
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

function ReportCard({ entry }: { entry: Entry }) {
  const isSend = entry.kind === 'send';
  return (
    <Card.Root size="sm" variant="outline">
      <Card.Body>
        <Flex align="center" gap={2} mb={entry.report || entry.error ? 3 : 0}>
          <Badge colorPalette={isSend ? 'brand' : 'purple'} variant="subtle">
            {isSend ? <SendIcon /> : <RefreshIcon />}
            {isSend ? 'Send pass' : 'Poll pass'}
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

export function RunView() {
  const [log, setLog] = useState<Entry[]>([]);
  const [busy, setBusy] = useState<Kind | null>(null);
  const nextId = useRef(0);

  const run = async (kind: Kind) => {
    setBusy(kind);
    const id = nextId.current++;
    const time = new Date().toLocaleTimeString();
    try {
      const report = (await (kind === 'send' ? api.runSend() : api.runPoll())) as Record<
        string,
        unknown
      >;
      setLog((l) => [{ id, kind, time, report }, ...l]);
    } catch (e) {
      const error = toastError(`${kind} pass failed`, e);
      setLog((l) => [{ id, kind, time, error }, ...l]);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Box pt={4}>
      <SimpleGrid columns={{ base: 1, sm: 2 }} gap={3} mb={5}>
        <Card.Root variant="outline">
          <Card.Body gap={3}>
            <HStack>
              <SendIcon boxSize={5} color="brand.fg" />
              <Text fontWeight="semibold">Send pass</Text>
            </HStack>
            <Text fontSize="sm" color="fg.muted">
              Reserve and send the next batch of outreach — respects each account's daily cap.
            </Text>
            <Button
              colorPalette="brand"
              onClick={() => run('send')}
              loading={busy === 'send'}
              loadingText="Sending…"
              alignSelf="flex-start"
            >
              <PlayIcon />
              Run send pass
            </Button>
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
            <Button
              colorPalette="purple"
              variant="outline"
              onClick={() => run('poll')}
              loading={busy === 'poll'}
              loadingText="Polling…"
              alignSelf="flex-start"
            >
              <RefreshIcon />
              Run poll pass
            </Button>
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
