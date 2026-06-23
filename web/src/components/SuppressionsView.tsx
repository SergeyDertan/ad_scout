import { Box, Table, Text } from '@chakra-ui/react';
import { useCallback } from 'react';
import { api } from '../api';
import { StatusBadge } from './StatusBadge';
import { DataPanel } from './DataPanel';
import { Empty } from './Empty';
import { useResource } from '../hooks/useResource';
import { ShieldIcon } from './icons';

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function SuppressionsView({ tick }: { tick: number }) {
  const { rows, loading, error } = useResource(
    useCallback(() => api.listSuppressions(), []),
    tick,
  );

  if (error)
    return (
      <Text color="red.fg" fontSize="sm" pt={4}>
        {error}
      </Text>
    );

  return (
    <Box pt={4}>
      <Text color="fg.muted" fontSize="sm" mb={4}>
        Addresses that will never be contacted — opt-outs, hard bounces, and manual blocks.
      </Text>
      <DataPanel
        loading={loading}
        isEmpty={rows.length === 0}
        empty={
          <Empty
            icon={ShieldIcon}
            title="Nothing suppressed"
            description="Opt-outs and bounced addresses are added here automatically."
          />
        }
      >
        <Table.Root size="md" variant="line">
          <Table.Header>
            <Table.Row bg="bg.subtle">
              <Table.ColumnHeader>Email</Table.ColumnHeader>
              <Table.ColumnHeader>Reason</Table.ColumnHeader>
              <Table.ColumnHeader>Added</Table.ColumnHeader>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {rows.map((s) => (
              <Table.Row key={s.id}>
                <Table.Cell fontWeight="medium">{s.email}</Table.Cell>
                <Table.Cell>
                  <StatusBadge value={s.reason} />
                </Table.Cell>
                <Table.Cell color="fg.muted">{fmtDate(s.at)}</Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table.Root>
      </DataPanel>
    </Box>
  );
}
