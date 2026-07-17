import { Badge, Box, Button, HStack, Text } from '@chakra-ui/react';
import { useCallback, useState } from 'react';
import { api } from '../api';
import type { BatchRow, TargetStatus } from '../types';
import { StatusBadge } from './StatusBadge';
import { Empty } from './Empty';
import { BatchPreviewDialog } from './BatchPreviewDialog';
import { useResource } from '../hooks/useResource';
import { TagIcon } from './icons';

// Batch | Advertised | Targets | Status breakdown | Started | Actions
const COLS = '1.3fr 1fr 76px 1.7fr 150px 92px';

const STATUS_ORDER: TargetStatus[] = [
  'pending', 'reserved', 'contacted', 'replied', 'needs_review', 'bounced', 'excluded',
];

function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function shortId(id: string): string {
  return id.replace(/^batch_/, '').slice(0, 8);
}

export function BatchesView({ tick }: { tick: number }) {
  const { rows: batches, loading, error } = useResource(
    useCallback(() => api.listBatches(), []),
    tick,
  );
  const [previewBatch, setPreviewBatch] = useState<BatchRow | null>(null);

  if (error) return <Text color="red.fg" fontSize="sm" pt={4}>{error}</Text>;

  const rows = batches as BatchRow[];

  return (
    <Box pt={4}>
      <Text color="fg.muted" fontSize="sm" mb={4}>
        Every <b>batch</b> is one import (or a single manual add). Open the <b>Targets</b> tab and
        use its batch filter to see a batch's targets.
      </Text>

      {loading && rows.length === 0 ? (
        <Box py={12} display="flex" justifyContent="center">
          <Text color="fg.muted" fontSize="sm">Loading…</Text>
        </Box>
      ) : rows.length === 0 ? (
        <Empty
          icon={TagIcon}
          title="No batches yet"
          description="Import a list of targets and each import shows up here as a batch."
        />
      ) : (
        <Box bg="bg.panel" borderWidth="1px" borderColor="border" rounded="xl" boxShadow="xs" overflow="hidden">
          {/* Header */}
          <Box
            display="grid"
            gridTemplateColumns={COLS}
            px={4}
            py={2}
            bg="bg.subtle"
            borderBottomWidth="1px"
            borderColor="border"
            gap={3}
            fontSize="xs"
            fontWeight="semibold"
            color="fg.muted"
            textTransform="uppercase"
            letterSpacing="wide"
          >
            <Text>Batch</Text>
            <Text>Advertised</Text>
            <Text textAlign="center">Targets</Text>
            <Text>Status breakdown</Text>
            <Text>Started</Text>
            <Text textAlign="end">Actions</Text>
          </Box>

          {rows.map((b, i) => (
            <Box
              key={b.id}
              display="grid"
              gridTemplateColumns={COLS}
              alignItems="center"
              px={4}
              py={2.5}
              gap={3}
              fontSize="sm"
              borderBottomWidth={i === rows.length - 1 ? 0 : '1px'}
              borderColor="border"
              bg={i % 2 === 0 ? 'bg.panel' : 'bg.subtle'}
              _hover={{ bg: 'bg.muted' }}
              transition="background 0.1s"
            >
              <HStack minW={0} gap={2}>
                <Box minW={0}>
                  <Text
                    fontWeight="semibold"
                    color={b.name ? 'fg' : 'fg.subtle'}
                    overflow="hidden"
                    textOverflow="ellipsis"
                    whiteSpace="nowrap"
                  >
                    {b.name ?? 'manual add'}
                  </Text>
                  <Text fontSize="xs" color="fg.subtle" fontFamily="mono" title={b.id}>
                    {shortId(b.id)}
                  </Text>
                </Box>
                {b.source === 'manual' && (
                  <Badge size="sm" colorPalette="gray" variant="subtle">manual</Badge>
                )}
              </HStack>

              <Text
                color={b.advertised ? 'fg.muted' : 'fg.subtle'}
                overflow="hidden"
                textOverflow="ellipsis"
                whiteSpace="nowrap"
                title={b.advertised?.url}
              >
                {b.advertised?.url ?? 'global default'}
              </Text>

              <Text textAlign="center" fontWeight="medium">{b.count}</Text>

              <HStack gap={1.5} flexWrap="wrap">
                {STATUS_ORDER.filter((s) => b.byStatus[s]).map((s) => (
                  <HStack key={s} gap={1}>
                    <StatusBadge value={s} />
                    <Text fontSize="xs" color="fg.muted">{b.byStatus[s]}</Text>
                  </HStack>
                ))}
                {rows.length > 0 && Object.keys(b.byStatus).length === 0 && (
                  <Text fontSize="xs" color="fg.subtle">—</Text>
                )}
              </HStack>

              <Text color="fg.muted" fontSize="xs" whiteSpace="nowrap">
                {fmtDateTime(b.createdAt)}
              </Text>

              <HStack justify="flex-end">
                <Button size="xs" variant="outline" onClick={() => setPreviewBatch(b)}>
                  Preview
                </Button>
              </HStack>
            </Box>
          ))}
        </Box>
      )}

      {previewBatch && (
        <BatchPreviewDialog batch={previewBatch} onClose={() => setPreviewBatch(null)} />
      )}
    </Box>
  );
}
