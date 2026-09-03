import { Badge, Box, Button, HStack, Input, NativeSelect, Table, Text } from '@chakra-ui/react';
import { useCallback, useState } from 'react';
import { api } from '../api';
import { useIsManager } from '../role';
import { DataPanel } from './DataPanel';
import { Empty } from './Empty';
import { useResource } from '../hooks/useResource';
import { ShieldIcon, TrashIcon } from './icons';

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function IgnoreView({ tick }: { tick: number }) {
  // POST/DELETE /api/ignore are operator routes — a manager reads the list only.
  const isManager = useIsManager();
  const { rows, loading, error, reload } = useResource(useCallback(() => api.listIgnore(), []), tick);
  const [kind, setKind] = useState<'domain' | 'email'>('domain');
  const [value, setValue] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [addErr, setAddErr] = useState<string | null>(null);

  const add = async () => {
    if (!value.trim()) return;
    setBusy(true);
    setAddErr(null);
    try {
      await api.addIgnore({ kind, value: value.trim(), reason: reason.trim() || undefined });
      setValue('');
      setReason('');
      reload();
    } catch (e) {
      setAddErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    await api.deleteIgnore(id);
    reload();
  };

  if (error) return <Text color="red.fg" fontSize="sm" pt={4}>{error}</Text>;

  return (
    <Box pt={4}>
      <Text color="fg.muted" fontSize="sm" mb={4}>
        Inbound senders dropped before any processing — spam and automated senders. Matches an exact email,
        or a whole sender-address domain. Common platforms (Google, Facebook, …) are always ignored.
      </Text>

      <HStack gap={2} mb={4} flexWrap="wrap" align="end" hidden={isManager}>
        <Box>
          <Text fontSize="xs" color="fg.muted" mb={1}>Kind</Text>
          <NativeSelect.Root size="sm" width="32">
            <NativeSelect.Field value={kind} onChange={(e) => setKind(e.target.value as 'domain' | 'email')}>
              <option value="domain">domain</option>
              <option value="email">email</option>
            </NativeSelect.Field>
            <NativeSelect.Indicator />
          </NativeSelect.Root>
        </Box>
        <Box flex="1" minW="200px">
          <Text fontSize="xs" color="fg.muted" mb={1}>{kind === 'email' ? 'Email address' : 'Sender domain'}</Text>
          <Input size="sm" value={value} placeholder={kind === 'email' ? 'noreply@spam.com' : 'spam.com'} onChange={(e) => setValue(e.target.value)} />
        </Box>
        <Box flex="1" minW="160px">
          <Text fontSize="xs" color="fg.muted" mb={1}>Reason (optional)</Text>
          <Input size="sm" value={reason} placeholder="manual" onChange={(e) => setReason(e.target.value)} />
        </Box>
        <Button size="sm" colorPalette="brand" onClick={add} loading={busy}>Add</Button>
      </HStack>
      {addErr && <Text color="red.fg" fontSize="sm" mb={3}>{addErr}</Text>}

      <DataPanel
        loading={loading}
        isEmpty={rows.length === 0}
        empty={<Empty icon={ShieldIcon} title="Ignore list empty" description="Add a sender above, or AI-detected spam will grow this list automatically." />}
      >
        <Table.Root size="md" variant="line">
          <Table.Header>
            <Table.Row bg="bg.subtle">
              <Table.ColumnHeader>Kind</Table.ColumnHeader>
              <Table.ColumnHeader>Value</Table.ColumnHeader>
              <Table.ColumnHeader>Reason</Table.ColumnHeader>
              <Table.ColumnHeader>Added</Table.ColumnHeader>
              <Table.ColumnHeader />
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {rows.map((e) => (
              <Table.Row key={e.id}>
                <Table.Cell><Badge variant="surface" colorPalette={e.kind === 'domain' ? 'blue' : 'gray'}>{e.kind}</Badge></Table.Cell>
                <Table.Cell fontWeight="medium">{e.value}</Table.Cell>
                <Table.Cell color="fg.muted">{e.reason}</Table.Cell>
                <Table.Cell color="fg.muted">{fmtDate(e.at)}</Table.Cell>
                <Table.Cell textAlign="end">
                  <Button size="xs" variant="ghost" colorPalette="red" hidden={isManager} onClick={() => remove(e.id)} aria-label="Remove">
                    <TrashIcon />
                  </Button>
                </Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table.Root>
      </DataPanel>
    </Box>
  );
}
