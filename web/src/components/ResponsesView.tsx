import { Box, Code, HStack, Input, InputGroup, NativeSelect, Table, Text, Wrap } from '@chakra-ui/react';
import { useCallback, useState } from 'react';
import { api } from '../api';
import type { Campaign } from '../types';
import { StatusBadge } from './StatusBadge';
import { DataPanel } from './DataPanel';
import { Empty } from './Empty';
import { useResource } from '../hooks/useResource';
import { InboxIcon, SearchIcon } from './icons';

function Fields({ fields }: { fields: Record<string, unknown> }) {
  const entries = Object.entries(fields ?? {});
  if (entries.length === 0) return <Text color="fg.subtle">—</Text>;
  return (
    <Wrap gap={1.5}>
      {entries.map(([k, v]) => (
        <HStack
          key={k}
          gap={1}
          bg="bg.muted"
          rounded="md"
          px={2}
          py={0.5}
          fontSize="xs"
          maxW="100%"
        >
          <Text color="fg.muted">{k}</Text>
          <Code bg="transparent" px={0} fontWeight="medium" truncate maxW="40ch">
            {typeof v === 'string' ? v : JSON.stringify(v)}
          </Code>
        </HStack>
      ))}
    </Wrap>
  );
}

export function ResponsesView({ tick }: { tick: number }) {
  const [campaignFilter, setCampaignFilter] = useState('');
  const { rows: campaigns } = useResource(useCallback(() => api.listCampaigns(), []), tick);
  const { rows: allRows, loading, error } = useResource(
    useCallback(() => api.listResponses(campaignFilter || undefined), [campaignFilter]),
    tick,
  );
  const [search, setSearch] = useState('');

  const q = search.trim().toLowerCase();
  const rows = q
    ? allRows.filter(
        (r) =>
          r.fromAddress.toLowerCase().includes(q) || (r.website ?? '').toLowerCase().includes(q),
      )
    : allRows;

  if (error)
    return (
      <Text color="red.fg" fontSize="sm" pt={4}>
        {error}
      </Text>
    );

  return (
    <Box pt={4}>
      <Text color="fg.muted" fontSize="sm" mb={4}>
        Inbound replies matched back to a target, with the AI-extracted posting terms.
      </Text>
      <HStack gap={2} mb={3} flexWrap="wrap">
        <InputGroup startElement={<SearchIcon boxSize={3.5} color="fg.muted" />} maxW="64">
          <Input
            size="sm"
            placeholder="Search email or website…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            bg="bg.panel"
          />
        </InputGroup>

        <HStack
          gap={2}
          bg="bg.panel"
          borderWidth="1px"
          borderColor="border"
          rounded="lg"
          pl={3}
          pr={1.5}
          py={1}
        >
          <NativeSelect.Root size="sm" width="40" variant="plain">
            <NativeSelect.Field
              value={campaignFilter}
              onChange={(e) => setCampaignFilter(e.target.value)}
              fontWeight="medium"
            >
              <option value="">all campaigns</option>
              {(campaigns as Campaign[]).map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </NativeSelect.Field>
            <NativeSelect.Indicator />
          </NativeSelect.Root>
        </HStack>
      </HStack>
      <DataPanel
        loading={loading}
        isEmpty={rows.length === 0}
        empty={
          <Empty
            icon={InboxIcon}
            title={q ? `No responses match "${search.trim()}"` : 'No responses yet'}
            description={
              q
                ? 'Try a different search.'
                : 'Replies from contacted targets will show up here as they arrive.'
            }
          />
        }
      >
        <Box overflowX="auto">
          <Table.Root size="md" variant="line" minW="900px">
            <Table.Header>
              <Table.Row bg="bg.subtle">
                <Table.ColumnHeader>From</Table.ColumnHeader>
                <Table.ColumnHeader>Site</Table.ColumnHeader>
                <Table.ColumnHeader>Campaign</Table.ColumnHeader>
                <Table.ColumnHeader>Match</Table.ColumnHeader>
                <Table.ColumnHeader>Can post</Table.ColumnHeader>
                <Table.ColumnHeader>Fields</Table.ColumnHeader>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {rows.map((r) => (
                <Table.Row key={r.id}>
                  <Table.Cell fontWeight="medium">{r.fromAddress}</Table.Cell>
                  <Table.Cell color="fg.muted">{r.website ?? '—'}</Table.Cell>
                  <Table.Cell color="fg.muted">{r.campaignName ?? '—'}</Table.Cell>
                  <Table.Cell>
                    <StatusBadge value={r.matchMethod} />
                  </Table.Cell>
                  <Table.Cell>
                    {r.parsed ? (
                      <StatusBadge value={r.parsed.canPost} />
                    ) : (
                      <StatusBadge value={r.extractionStatus} />
                    )}
                  </Table.Cell>
                  <Table.Cell minW="260px">{r.parsed && <Fields fields={r.parsed.fields} />}</Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table.Root>
        </Box>
      </DataPanel>
    </Box>
  );
}
