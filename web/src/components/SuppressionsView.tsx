import { Box, Spinner, Table, Text } from '@chakra-ui/react';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import type { Suppression } from '../types';
import { StatusBadge } from './StatusBadge';

export function SuppressionsView({ tick }: { tick: number }) {
  const [rows, setRows] = useState<Suppression[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    api
      .listSuppressions()
      .then((r) => {
        setRows(r);
        setError(null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load, tick]);

  if (error)
    return (
      <Text color="red.400" fontSize="sm" pt={4}>
        {error}
      </Text>
    );
  if (loading && rows.length === 0) return <Spinner mt={4} />;

  return (
    <Box pt={4}>
      <Table.Root size="sm" variant="outline">
        <Table.Header>
          <Table.Row>
            <Table.ColumnHeader>Email</Table.ColumnHeader>
            <Table.ColumnHeader>Reason</Table.ColumnHeader>
            <Table.ColumnHeader>At</Table.ColumnHeader>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {rows.map((s) => (
            <Table.Row key={s.id}>
              <Table.Cell>{s.email}</Table.Cell>
              <Table.Cell>
                <StatusBadge value={s.reason} />
              </Table.Cell>
              <Table.Cell color="fg.muted">{s.at}</Table.Cell>
            </Table.Row>
          ))}
          {rows.length === 0 && !loading && (
            <Table.Row>
              <Table.Cell colSpan={3}>
                <Text color="fg.muted">Nothing suppressed.</Text>
              </Table.Cell>
            </Table.Row>
          )}
        </Table.Body>
      </Table.Root>
    </Box>
  );
}
