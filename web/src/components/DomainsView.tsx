import { Badge, Box, Button, HStack, Table, Text, VStack } from '@chakra-ui/react';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { DataPanel } from './DataPanel';
import { Empty } from './Empty';
import { useResource } from '../hooks/useResource';
import { TagIcon } from './icons';
import { formatPrice, postTypeLabel, type DomainDetail, type PriceCell } from '../types';

function fmtDate(iso?: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function CanPostBadge({ value }: { value: string }) {
  const palette = value === 'yes' ? 'green' : value === 'no' ? 'red' : 'gray';
  return <Badge colorPalette={palette} variant="subtle">{value}</Badge>;
}

function CellRow({ cell, special }: { cell: PriceCell; special?: boolean }) {
  return (
    <Table.Row>
      <Table.Cell>{postTypeLabel(cell.postType)}</Table.Cell>
      <Table.Cell>
        <HStack gap={1.5}>
          <Text>{cell.label || cell.category}</Text>
          {cell.sensitive && <Badge colorPalette="orange" variant="surface" size="sm">sensitive</Badge>}
        </HStack>
      </Table.Cell>
      <Table.Cell><CanPostBadge value={cell.canPost} /></Table.Cell>
      <Table.Cell fontWeight="medium">{formatPrice(cell.price)}</Table.Cell>
      <Table.Cell color="fg.muted">
        <HStack gap={1.5}>
          <Text>{fmtDate(cell.asOf)}</Text>
          {special ? (
            <Badge colorPalette="purple" variant="subtle" size="sm">
              {cell.active ? 'special' : 'expired'}{cell.specialUntil ? ` · till ${cell.specialUntil}` : ''}
            </Badge>
          ) : cell.stale ? (
            <Badge colorPalette="yellow" variant="subtle" size="sm">carried over</Badge>
          ) : null}
        </HStack>
      </Table.Cell>
    </Table.Row>
  );
}

function DomainDetailPanel({ domain, onChanged }: { domain: string; onChanged: () => void }) {
  const [detail, setDetail] = useState<DomainDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api.getDomain(domain).then(setDetail).catch((e) => setError(String(e)));
  }, [domain]);
  useEffect(() => { load(); }, [load]);

  const toggleExcluded = async () => {
    if (!detail) return;
    setBusy(true);
    try {
      if (detail.excluded) await api.deleteExclusion(domain);
      else await api.addExclusion(domain);
      load();
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  if (error) return <Text color="red.fg" fontSize="sm">{error}</Text>;
  if (!detail) return <Text color="fg.muted" fontSize="sm">Loading…</Text>;

  const { sheet, history } = detail;
  return (
    <VStack align="stretch" gap={4}>
      <HStack justify="space-between" flexWrap="wrap" gap={2}>
        <HStack gap={2}>
          <Text fontWeight="semibold" fontSize="lg">{domain}</Text>
          {detail.excluded && <Badge colorPalette="red" variant="solid">excluded</Badge>}
          {sheet.optedOut && <Badge colorPalette="purple" variant="subtle">opted out</Badge>}
        </HStack>
        <Button size="sm" variant={detail.excluded ? 'outline' : 'subtle'} colorPalette="red" onClick={toggleExcluded} loading={busy}>
          {detail.excluded ? 'Re-include (remove exclusion)' : 'Exclude domain'}
        </Button>
      </HStack>

      <Box>
        <Text fontSize="sm" fontWeight="semibold" color="fg.muted" mb={2}>Current prices ({sheet.cells.length})</Text>
        {sheet.cells.length === 0 ? (
          <Text fontSize="sm" color="fg.muted">No priced cells recorded yet.</Text>
        ) : (
          <Table.Root size="sm" variant="line">
            <Table.Header>
              <Table.Row bg="bg.subtle">
                <Table.ColumnHeader>Product</Table.ColumnHeader>
                <Table.ColumnHeader>Niche</Table.ColumnHeader>
                <Table.ColumnHeader>Can post</Table.ColumnHeader>
                <Table.ColumnHeader>Price</Table.ColumnHeader>
                <Table.ColumnHeader>As of</Table.ColumnHeader>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {sheet.cells.map((c) => <CellRow key={`${c.postType}|${c.category}`} cell={c} />)}
            </Table.Body>
          </Table.Root>
        )}
      </Box>

      {sheet.specials.length > 0 && (
        <Box>
          <Text fontSize="sm" fontWeight="semibold" color="fg.muted" mb={2}>Special offers ({sheet.specials.length})</Text>
          <Table.Root size="sm" variant="line">
            <Table.Header>
              <Table.Row bg="bg.subtle">
                <Table.ColumnHeader>Product</Table.ColumnHeader>
                <Table.ColumnHeader>Niche</Table.ColumnHeader>
                <Table.ColumnHeader>Can post</Table.ColumnHeader>
                <Table.ColumnHeader>Price</Table.ColumnHeader>
                <Table.ColumnHeader>As of</Table.ColumnHeader>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {sheet.specials.map((c) => <CellRow key={`s|${c.postType}|${c.category}`} cell={c} special />)}
            </Table.Body>
          </Table.Root>
        </Box>
      )}

      <Box>
        <Text fontSize="sm" fontWeight="semibold" color="fg.muted" mb={2}>History ({history.length} record{history.length === 1 ? '' : 's'})</Text>
        <VStack align="stretch" gap={1.5}>
          {history.slice().reverse().map((r) => (
            <HStack key={r.id} fontSize="xs" color="fg.muted" gap={3} borderBottomWidth="1px" borderColor="border" pb={1.5}>
              <Text minW="90px">{fmtDate(r.observedAt)}</Text>
              <Badge size="sm" variant="surface" colorPalette={r.attribution === 'named' ? 'blue' : 'gray'}>{r.attribution}</Badge>
              <Text flex="1" truncate>{r.sourceEmail}</Text>
              <Text>{r.offers.length} cell{r.offers.length === 1 ? '' : 's'}</Text>
            </HStack>
          ))}
        </VStack>
      </Box>
    </VStack>
  );
}

export function DomainsView({ tick }: { tick: number }) {
  const { rows, loading, error, reload } = useResource(useCallback(() => api.listDomains(), []), tick);
  const [selected, setSelected] = useState<string | null>(null);

  if (error) return <Text color="red.fg" fontSize="sm" pt={4}>{error}</Text>;

  return (
    <Box pt={4}>
      <Text color="fg.muted" fontSize="sm" mb={4}>
        Per-domain price history — every recorded quote, folded into a current price sheet. Subdomains and
        TLDs are kept distinct (casik.com ≠ casik.ua).
      </Text>
      <DataPanel
        loading={loading}
        isEmpty={rows.length === 0}
        empty={<Empty icon={TagIcon} title="No domains yet" description="Price records appear here as publishers reply with quotes." />}
      >
        <Table.Root size="md" variant="line" interactive>
          <Table.Header>
            <Table.Row bg="bg.subtle">
              <Table.ColumnHeader>Domain</Table.ColumnHeader>
              <Table.ColumnHeader>Prices</Table.ColumnHeader>
              <Table.ColumnHeader>Specials</Table.ColumnHeader>
              <Table.ColumnHeader>Records</Table.ColumnHeader>
              <Table.ColumnHeader>Last quote</Table.ColumnHeader>
              <Table.ColumnHeader>State</Table.ColumnHeader>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {rows.map((d) => (
              <Table.Row
                key={d.domain}
                onClick={() => setSelected(d.domain === selected ? null : d.domain)}
                cursor="pointer"
                bg={d.domain === selected ? 'bg.muted' : undefined}
              >
                <Table.Cell fontWeight="medium">{d.domain}</Table.Cell>
                <Table.Cell>{d.standingCells}</Table.Cell>
                <Table.Cell>{d.activeSpecials || '—'}</Table.Cell>
                <Table.Cell>{d.recordCount}</Table.Cell>
                <Table.Cell color="fg.muted">{fmtDate(d.lastObservedAt)}</Table.Cell>
                <Table.Cell>
                  <HStack gap={1.5}>
                    {d.excluded && <Badge colorPalette="red" variant="solid" size="sm">excluded</Badge>}
                    {d.optedOut && <Badge colorPalette="purple" variant="subtle" size="sm">opted out</Badge>}
                    {!d.excluded && !d.optedOut && <Text color="fg.subtle">—</Text>}
                  </HStack>
                </Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table.Root>
      </DataPanel>

      {selected && (
        <Box mt={4} p={4} borderWidth="1px" borderColor="border" rounded="lg" bg="bg.panel">
          <DomainDetailPanel domain={selected} onChanged={reload} />
        </Box>
      )}
    </Box>
  );
}
