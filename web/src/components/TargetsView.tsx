import {
  Box,
  Button,
  Flex,
  HStack,
  NativeSelect,
  Spinner,
  Table,
  Text,
} from '@chakra-ui/react';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import type { Target, TargetStatus } from '../types';
import { StatusBadge } from './StatusBadge';
import { AddTargetForm } from './AddTargetForm';

const STATUSES: (TargetStatus | '')[] = [
  '',
  'pending',
  'reserved',
  'contacted',
  'replied',
  'bounced',
  'needs_review',
  'excluded',
];

export function TargetsView({ tick }: { tick: number }) {
  const [targets, setTargets] = useState<Target[]>([]);
  const [filter, setFilter] = useState<TargetStatus | ''>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    api
      .listTargets(filter)
      .then((t) => {
        setTargets(t);
        setError(null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [filter]);

  useEffect(() => {
    load();
  }, [load, tick]);

  const remove = async (t: Target) => {
    if (!confirm(`Remove ${t.websiteUrl} from the queue?`)) return;
    await api.deleteTarget(t.id);
    load();
  };

  return (
    <Box pt={4}>
      <Flex mb={3} align="center" gap={3} wrap="wrap">
        <HStack gap={2}>
          <Text color="fg.muted" fontSize="sm">
            Filter
          </Text>
          <NativeSelect.Root size="sm" width="40">
            <NativeSelect.Field
              value={filter}
              onChange={(e) => setFilter(e.target.value as TargetStatus | '')}
            >
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s || 'all'}
                </option>
              ))}
            </NativeSelect.Field>
            <NativeSelect.Indicator />
          </NativeSelect.Root>
        </HStack>
        <Box flex="1" />
        <Button size="sm" colorPalette="blue" onClick={() => setAdding((v) => !v)}>
          {adding ? 'Close' : '+ Add target'}
        </Button>
      </Flex>

      {adding && <AddTargetForm onClose={() => setAdding(false)} onCreated={load} />}

      {error && (
        <Text color="red.400" fontSize="sm" mb={3}>
          {error}
        </Text>
      )}

      {loading && targets.length === 0 ? (
        <Spinner />
      ) : (
        <Table.Root size="sm" variant="outline" interactive>
          <Table.Header>
            <Table.Row>
              <Table.ColumnHeader>Website</Table.ColumnHeader>
              <Table.ColumnHeader>Contact</Table.ColumnHeader>
              <Table.ColumnHeader>Status</Table.ColumnHeader>
              <Table.ColumnHeader>Follow-ups</Table.ColumnHeader>
              <Table.ColumnHeader>Can post</Table.ColumnHeader>
              <Table.ColumnHeader textAlign="end">Actions</Table.ColumnHeader>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {targets.map((t) => (
              <Table.Row key={t.id}>
                <Table.Cell fontWeight="medium">{t.websiteUrl}</Table.Cell>
                <Table.Cell color="fg.muted">{t.contactEmail}</Table.Cell>
                <Table.Cell>
                  <StatusBadge value={t.status} />
                </Table.Cell>
                <Table.Cell>{t.followUpCount}</Table.Cell>
                <Table.Cell color="fg.muted">{t.result?.canPost ?? ''}</Table.Cell>
                <Table.Cell>
                  <HStack justify="flex-end">
                    <Button size="xs" variant="outline" colorPalette="red" onClick={() => remove(t)}>
                      Remove
                    </Button>
                  </HStack>
                </Table.Cell>
              </Table.Row>
            ))}
            {targets.length === 0 && !loading && (
              <Table.Row>
                <Table.Cell colSpan={6}>
                  <Text color="fg.muted">No targets — add one to the queue.</Text>
                </Table.Cell>
              </Table.Row>
            )}
          </Table.Body>
        </Table.Root>
      )}
    </Box>
  );
}
