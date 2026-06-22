import { Box, Code, Spinner, Table, Text } from '@chakra-ui/react';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import type { ResponseRow } from '../types';
import { StatusBadge } from './StatusBadge';

export function ResponsesView({ tick }: { tick: number }) {
  const [rows, setRows] = useState<ResponseRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    api
      .listResponses()
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
            <Table.ColumnHeader>From</Table.ColumnHeader>
            <Table.ColumnHeader>Site</Table.ColumnHeader>
            <Table.ColumnHeader>Match</Table.ColumnHeader>
            <Table.ColumnHeader>Can post</Table.ColumnHeader>
            <Table.ColumnHeader>Fields</Table.ColumnHeader>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {rows.map((r) => (
            <Table.Row key={r.id}>
              <Table.Cell>{r.fromAddress}</Table.Cell>
              <Table.Cell color="fg.muted">{r.website ?? ''}</Table.Cell>
              <Table.Cell>
                <StatusBadge value={r.matchMethod} />
              </Table.Cell>
              <Table.Cell>
                {r.parsed ? <StatusBadge value={r.parsed.canPost} /> : <StatusBadge value={r.extractionStatus} />}
              </Table.Cell>
              <Table.Cell>
                {r.parsed && (
                  <Code fontSize="xs" whiteSpace="pre-wrap">
                    {JSON.stringify(r.parsed.fields)}
                  </Code>
                )}
              </Table.Cell>
            </Table.Row>
          ))}
          {rows.length === 0 && !loading && (
            <Table.Row>
              <Table.Cell colSpan={5}>
                <Text color="fg.muted">No responses yet.</Text>
              </Table.Cell>
            </Table.Row>
          )}
        </Table.Body>
      </Table.Root>
    </Box>
  );
}
