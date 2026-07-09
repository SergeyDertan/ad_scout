import { Badge, Box, Button, Heading, HStack, Spinner, Text, VStack } from '@chakra-ui/react';
import { useEffect, useState } from 'react';
import { api } from '../api';
import type { Outreach, Target, ThreadReply } from '../types';
import { toaster, toastError } from './Toaster';
import { TrashIcon } from './icons';

type ThreadItem =
  | { kind: 'sent'; time: string; data: Outreach }
  | { kind: 'received'; time: string; data: ThreadReply };

function buildThread(outreaches: Outreach[], replies: ThreadReply[]): ThreadItem[] {
  const items: ThreadItem[] = [
    ...outreaches.map((o) => ({ kind: 'sent' as const, time: o.sentAt ?? o.reservedAt, data: o })),
    ...replies.map((r) => ({ kind: 'received' as const, time: r.receivedAt, data: r })),
  ];
  return items.sort((a, b) => a.time.localeCompare(b.time));
}

function SentItem({ o }: { o: Outreach }) {
  const [open, setOpen] = useState(false);
  return (
    <Box
      bg="brand.subtle"
      borderWidth="1px"
      borderColor="brand.muted"
      rounded="lg"
      p={3}
      ml={6}
    >
      <HStack mb={1} justify="space-between" wrap="wrap" gap={2}>
        <HStack gap={2}>
          <Badge size="sm" colorPalette="brand" variant="subtle">
            {o.kind === 'followup' ? `Follow-up #${o.sequenceNo}` : 'Initial'}
          </Badge>
          <Badge
            size="sm"
            colorPalette={o.status === 'sent' ? 'green' : o.status === 'failed' ? 'red' : 'gray'}
            variant="subtle"
          >
            {o.status}
          </Badge>
        </HStack>
        <Text fontSize="xs" color="fg.muted">
          {o.sentAt ? new Date(o.sentAt).toLocaleString() : 'not sent'}
        </Text>
      </HStack>
      <Text fontSize="sm" fontWeight="semibold" mb={1}>{o.subject}</Text>
      {open ? (
        <>
          <Text as="pre" fontSize="xs" whiteSpace="pre-wrap" fontFamily="inherit" color="fg" lineHeight="1.6">
            {o.body}
          </Text>
          <Button size="xs" variant="ghost" mt={1} onClick={() => setOpen(false)}>Hide</Button>
        </>
      ) : (
        <Button size="xs" variant="ghost" onClick={() => setOpen(true)}>Show body</Button>
      )}
      {o.error && <Text color="red.fg" fontSize="xs" mt={1}>{o.error}</Text>}
    </Box>
  );
}

function ReceivedItem({ r, onDeleted }: { r: ThreadReply; onDeleted: () => void }) {
  const [open, setOpen] = useState(true);

  const remove = async () => {
    try {
      await api.deleteReply(r.id);
      toaster.create({ type: 'success', title: 'Reply removed' });
      onDeleted();
    } catch (e) {
      toastError('Could not remove reply', e);
    }
  };

  return (
    <Box
      bg="bg.subtle"
      borderWidth="1px"
      borderColor="border"
      rounded="lg"
      p={3}
      mr={6}
    >
      <HStack mb={1} justify="space-between" wrap="wrap" gap={2}>
        <HStack gap={2}>
          <Badge size="sm" colorPalette="green" variant="subtle">Reply</Badge>
          <Badge size="sm" colorPalette="gray" variant="subtle">{r.matchMethod}</Badge>
        </HStack>
        <HStack gap={1}>
          <Text fontSize="xs" color="fg.muted">{new Date(r.receivedAt).toLocaleString()}</Text>
          <Button size="xs" variant="ghost" colorPalette="red" onClick={remove} title="Delete reply">
            <TrashIcon />
          </Button>
        </HStack>
      </HStack>
      <Text fontSize="xs" color="fg.muted" mb={1}>{r.fromAddress}</Text>
      {open ? (
        <>
          <Text as="pre" fontSize="xs" whiteSpace="pre-wrap" fontFamily="inherit" color="fg" lineHeight="1.6">
            {r.text}
          </Text>
          <Button size="xs" variant="ghost" mt={1} onClick={() => setOpen(false)}>Hide</Button>
        </>
      ) : (
        <Button size="xs" variant="ghost" onClick={() => setOpen(true)}>Show</Button>
      )}
    </Box>
  );
}

/** Fetches and renders the full send + reply timeline for a target. Reused by
 *  the Targets thread panel and the Responses detail modal. */
export function ThreadTimeline({ targetId }: { targetId: string }) {
  const [items, setItems] = useState<ThreadItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    api.getTargetThread(targetId)
      .then(({ outreaches, replies }) => setItems(buildThread(outreaches, replies)))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  };

  useEffect(() => { load(); }, [targetId]);

  if (error) return <Text color="red.fg" fontSize="sm">{error}</Text>;

  if (items === null)
    return <Box py={6} display="flex" justifyContent="center"><Spinner color="brand.solid" /></Box>;

  if (items.length === 0)
    return <Text color="fg.muted" fontSize="sm">No emails sent or received yet.</Text>;

  return (
    <VStack gap={3} align="stretch">
      {items.map((item) =>
        item.kind === 'sent'
          ? <SentItem key={item.data.id} o={item.data} />
          : <ReceivedItem key={item.data.id} r={item.data} onDeleted={load} />
      )}
    </VStack>
  );
}

export function ThreadPanel({ target, onClose }: { target: Target; onClose: () => void }) {
  return (
    <Box
      bg="bg.panel"
      borderWidth="1px"
      borderColor="border"
      rounded="xl"
      boxShadow="xs"
      p={4}
      mb={4}
    >
      <HStack mb={4} justify="space-between">
        <VStack align="flex-start" gap={0}>
          <Heading size="sm">Email thread</Heading>
          <Text fontSize="xs" color="fg.muted">{target.websiteUrl} · {target.contactEmail}</Text>
        </VStack>
        <Button size="xs" variant="ghost" onClick={onClose}>Close</Button>
      </HStack>

      <ThreadTimeline targetId={target.id} />
    </Box>
  );
}
