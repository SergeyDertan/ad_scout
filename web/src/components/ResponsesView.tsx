import { Badge, Box, Button, Code, HStack, Input, InputGroup, NativeSelect, Table, Text, VStack, Wrap } from '@chakra-ui/react';
import { useCallback, useState } from 'react';
import { api } from '../api';
import {
  formatPrice,
  invertedPriceOffers,
  needsReview,
  offerMatchesFilter,
  type Campaign,
  type Niche,
  type PostOffer,
} from '../types';
import { StatusBadge } from './StatusBadge';
import { DataPanel } from './DataPanel';
import { Empty } from './Empty';
import { EditResponseForm } from './EditResponseForm';
import { useResource } from '../hooks/useResource';
import { AlertTriangleIcon, InboxIcon, SearchIcon } from './icons';

/** All priced niches from a reply, as niche-tagged chips (canPost + price).
 *  Regular offers priced above a sensitive one are flagged as likely-inverted. */
function Offers({ offers }: { offers?: PostOffer[] }) {
  if (!offers || offers.length === 0) return <Text color="fg.subtle">—</Text>;
  const inverted = invertedPriceOffers(offers);
  return (
    <Wrap gap={1.5} align="center">
      {inverted.size > 0 && (
        <HStack
          gap={1}
          color="red.fg"
          fontSize="xs"
          fontWeight="semibold"
          title="A regular post is priced higher than a sensitive one — sensitive niches normally cost more. Likely an extraction error; check the source."
        >
          <AlertTriangleIcon boxSize={3.5} />
          <Text>price order?</Text>
        </HStack>
      )}
      {offers.map((o) => {
        const flagged = inverted.has(o.category);
        return (
          <HStack
            key={o.category}
            gap={1.5}
            bg={flagged ? 'red.subtle' : 'bg.muted'}
            rounded="md"
            px={2}
            py={0.5}
            fontSize="xs"
            title={
              flagged
                ? 'This regular post costs more than a sensitive post — unusual, verify against the source.'
                : undefined
            }
          >
            <Badge
              size="xs"
              colorPalette={o.sensitive ? 'orange' : 'gray'}
              variant="subtle"
              textTransform="none"
            >
              {o.label}
            </Badge>
            <StatusBadge value={o.canPost} />
            <Text
              fontWeight="semibold"
              color={flagged ? 'red.fg' : o.price ? 'fg' : 'fg.subtle'}
            >
              {formatPrice(o.price)}
            </Text>
          </HStack>
        );
      })}
    </Wrap>
  );
}

/** Amber chip listing why the AI couldn't fully process a reply (unreadable file,
 *  unreachable link). Full reasons in the tooltip. */
function ReviewBadge({ reasons }: { reasons?: string[] }) {
  if (!reasons || reasons.length === 0) return null;
  return (
    <HStack
      gap={1}
      color="orange.fg"
      bg="orange.subtle"
      rounded="md"
      px={2}
      py={0.5}
      fontSize="xs"
      fontWeight="semibold"
      title={reasons.join('\n')}
    >
      <AlertTriangleIcon boxSize={3.5} />
      <Text>needs review{reasons.length > 1 ? ` (${reasons.length})` : ''}</Text>
    </HStack>
  );
}

const INTENT_LABELS: Record<string, string> = {
  holding: 'holding — no answer yet',
  auto_reply: 'auto-reply',
  question: 'asked a question',
  decline: 'declined',
};

/** A small badge for non-substantive reply intents (holding / auto-reply / …). */
function IntentBadge({ intent }: { intent?: string }) {
  if (!intent || intent === 'answer' || !INTENT_LABELS[intent]) return null;
  return (
    <Badge size="xs" colorPalette="purple" variant="subtle" textTransform="none">
      {INTENT_LABELS[intent]}
    </Badge>
  );
}

function Fields({ fields }: { fields: Record<string, unknown> }) {
  const entries = Object.entries(fields ?? {});
  if (entries.length === 0) return null;
  return (
    <Wrap gap={1.5}>
      {entries.map(([k, v]) => (
        <HStack key={k} gap={1} bg="bg.muted" rounded="md" px={2} py={0.5} fontSize="xs" maxW="100%">
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
  const [nicheFilter, setNicheFilter] = useState('');
  const [canPostFilter, setCanPostFilter] = useState('');
  const [reviewFilter, setReviewFilter] = useState('');
  const [editId, setEditId] = useState<string | null>(null);
  const { rows: campaigns } = useResource(useCallback(() => api.listCampaigns(), []), tick);
  const { rows: niches } = useResource(useCallback(() => api.listNiches(), []), tick);
  const { rows: allRows, loading, error, reload } = useResource(
    useCallback(() => api.listResponses(campaignFilter || undefined), [campaignFilter]),
    tick,
  );
  const [search, setSearch] = useState('');

  const q = search.trim().toLowerCase();
  const rows = allRows.filter((r) => {
    if (q && !r.fromAddress.toLowerCase().includes(q) && !(r.website ?? '').toLowerCase().includes(q))
      return false;
    if (reviewFilter === 'review' && !needsReview(r)) return false;
    if (reviewFilter === 'ok' && needsReview(r)) return false;
    if (nicheFilter || canPostFilter) {
      const offers = r.parsed?.offers ?? [];
      const match = offers.some(
        (o) =>
          (!nicheFilter || offerMatchesFilter(o, nicheFilter, niches as Niche[])) &&
          (!canPostFilter || o.canPost === canPostFilter),
      );
      if (!match) return false;
    }
    return true;
  });
  const reviewCount = allRows.filter(needsReview).length;
  const editingRow = editId ? allRows.find((r) => r.id === editId) : undefined;

  if (error)
    return (
      <Text color="red.fg" fontSize="sm" pt={4}>
        {error}
      </Text>
    );

  const selectWrap = { gap: 2, bg: 'bg.panel', borderWidth: '1px', borderColor: 'border', rounded: 'lg', pl: 3, pr: 1.5, py: 1 } as const;

  return (
    <Box pt={4}>
      <Text color="fg.muted" fontSize="sm" mb={4}>
        Inbound replies matched back to a target, with every AI-extracted niche price. Filter by
        niche (grey niches roll up under “sensitive”) and willingness.
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

        <HStack {...selectWrap}>
          <NativeSelect.Root size="sm" width="40" variant="plain">
            <NativeSelect.Field value={campaignFilter} onChange={(e) => setCampaignFilter(e.target.value)} fontWeight="medium">
              <option value="">all campaigns</option>
              {(campaigns as Campaign[]).map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </NativeSelect.Field>
            <NativeSelect.Indicator />
          </NativeSelect.Root>
        </HStack>

        <HStack {...selectWrap}>
          <NativeSelect.Root size="sm" width="36" variant="plain">
            <NativeSelect.Field value={nicheFilter} onChange={(e) => setNicheFilter(e.target.value)} fontWeight="medium">
              <option value="">all niches</option>
              {(niches as Niche[]).map((n) => (
                <option key={n.key} value={n.key}>{n.label}{n.sensitive ? ' •' : ''}</option>
              ))}
            </NativeSelect.Field>
            <NativeSelect.Indicator />
          </NativeSelect.Root>
        </HStack>

        <HStack {...selectWrap}>
          <NativeSelect.Root size="sm" width="28" variant="plain">
            <NativeSelect.Field value={canPostFilter} onChange={(e) => setCanPostFilter(e.target.value)} fontWeight="medium">
              <option value="">any answer</option>
              <option value="yes">yes</option>
              <option value="maybe">maybe</option>
              <option value="no">no</option>
            </NativeSelect.Field>
            <NativeSelect.Indicator />
          </NativeSelect.Root>
        </HStack>

        <HStack {...selectWrap}>
          <NativeSelect.Root size="sm" width="36" variant="plain">
            <NativeSelect.Field value={reviewFilter} onChange={(e) => setReviewFilter(e.target.value)} fontWeight="medium">
              <option value="">any state</option>
              <option value="review">needs review{reviewCount ? ` (${reviewCount})` : ''}</option>
              <option value="ok">no issues</option>
            </NativeSelect.Field>
            <NativeSelect.Indicator />
          </NativeSelect.Root>
        </HStack>
      </HStack>

      {editingRow && (
        <EditResponseForm
          row={editingRow}
          onClose={() => setEditId(null)}
          onSaved={reload}
        />
      )}

      <DataPanel
        loading={loading}
        isEmpty={rows.length === 0}
        empty={
          <Empty
            icon={InboxIcon}
            title={q ? `No responses match "${search.trim()}"` : 'No responses yet'}
            description={
              q || nicheFilter || canPostFilter
                ? 'Try a different search or filter.'
                : 'Replies from contacted targets will show up here as they arrive.'
            }
          />
        }
      >
        <Box overflowX="auto">
          <Table.Root size="md" variant="line" minW="1100px">
            <Table.Header>
              <Table.Row bg="bg.subtle">
                <Table.ColumnHeader>From</Table.ColumnHeader>
                <Table.ColumnHeader>Site</Table.ColumnHeader>
                <Table.ColumnHeader>Campaign</Table.ColumnHeader>
                <Table.ColumnHeader>Match</Table.ColumnHeader>
                <Table.ColumnHeader>Niche offers</Table.ColumnHeader>
                <Table.ColumnHeader>AI notes &amp; fields</Table.ColumnHeader>
                <Table.ColumnHeader textAlign="end">Edit</Table.ColumnHeader>
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
                  <Table.Cell minW="280px">
                    <VStack align="start" gap={1.5}>
                      <ReviewBadge reasons={r.review} />
                      <IntentBadge intent={r.parsed?.intent} />
                      {r.parsed ? <Offers offers={r.parsed.offers} /> : <StatusBadge value={r.extractionStatus} />}
                    </VStack>
                  </Table.Cell>
                  <Table.Cell minW="260px">
                    {r.parsed && (
                      <VStack align="start" gap={1.5}>
                        {r.parsed.reasoning && (
                          <Text fontSize="xs" color="fg.muted" fontStyle="italic">
                            {r.parsed.reasoning}
                          </Text>
                        )}
                        <Fields fields={r.parsed.fields} />
                      </VStack>
                    )}
                  </Table.Cell>
                  <Table.Cell textAlign="end">
                    <Button size="xs" variant="outline" onClick={() => setEditId(r.id)}>
                      Edit
                    </Button>
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table.Root>
        </Box>
      </DataPanel>
    </Box>
  );
}
