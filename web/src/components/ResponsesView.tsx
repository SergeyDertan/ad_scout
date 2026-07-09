import {
  Badge,
  Box,
  Button,
  HStack,
  Input,
  InputGroup,
  NativeSelect,
  Text,
} from '@chakra-ui/react';
import { useCallback, useState } from 'react';
import { List, type RowComponentProps } from 'react-window';
import { api } from '../api';
import {
  invertedPriceOffers,
  isAwaiting,
  isLateMessage,
  needsReview,
  offerMatchesFilter,
  type Campaign,
  type Niche,
  type ResponseRow,
} from '../types';
import { StatusBadge } from './StatusBadge';
import { DataPanel } from './DataPanel';
import { Empty } from './Empty';
import { EditResponseForm } from './EditResponseForm';
import { ResponseDetailModal } from './ResponseDetailModal';
import { ExportDialog } from './ExportDialog';
import { useResource } from '../hooks/useResource';
import { AlertTriangleIcon, DownloadIcon, InboxIcon, SearchIcon } from './icons';

// From | Site | Campaign | Match | Answer | Niches | Actions
const COLS = '1.2fr 1.2fr 130px 96px 96px 120px 150px';
const ROW_H = 56;
const MAX_LIST_H = 640;

/** Compact one-line summary of a reply's extraction, shown in the virtualized row.
 *  Full detail (every price, field, reasoning) lives in the Show modal. */
function NicheSummary({ row }: { row: ResponseRow }) {
  const offers = row.parsed?.offers ?? [];
  const inverted = invertedPriceOffers(offers);
  if (offers.length === 0) {
    return row.parsed ? (
      <Text color="fg.subtle" fontSize="xs">no offers</Text>
    ) : (
      <StatusBadge value={row.extractionStatus} />
    );
  }
  return (
    <HStack gap={1.5}>
      <Badge size="sm" colorPalette="gray" variant="subtle">
        {offers.length} niche{offers.length > 1 ? 's' : ''}
      </Badge>
      {inverted.size > 0 && <AlertTriangleIcon boxSize={3.5} color="red.fg" />}
    </HStack>
  );
}

interface RowData {
  rows: ResponseRow[];
  onShow: (r: ResponseRow) => void;
  onEdit: (id: string) => void;
}

function VirtualRow({ index, style, rows, onShow, onEdit }: RowComponentProps<RowData>) {
  const r = rows[index]!;
  const review = needsReview(r);
  const awaiting = isAwaiting(r);
  const late = isLateMessage(r);
  return (
    <Box
      style={style}
      display="grid"
      gridTemplateColumns={COLS}
      alignItems="center"
      px={4}
      gap={3}
      fontSize="sm"
      borderBottomWidth="1px"
      borderColor="border"
      bg={index % 2 === 0 ? 'bg.panel' : 'bg.subtle'}
      _hover={{ bg: 'bg.muted' }}
      transition="background 0.1s"
    >
      <Text fontWeight="medium" overflow="hidden" textOverflow="ellipsis" whiteSpace="nowrap">
        {r.fromAddress}
      </Text>
      <Text color="fg.muted" overflow="hidden" textOverflow="ellipsis" whiteSpace="nowrap">
        {r.website ?? '—'}
      </Text>
      <Text color="fg.muted" fontSize="xs" overflow="hidden" textOverflow="ellipsis" whiteSpace="nowrap">
        {r.campaignName ?? '—'}
      </Text>
      <Box><StatusBadge value={r.matchMethod} /></Box>
      <Box>{r.parsed?.canPost ? <StatusBadge value={r.parsed.canPost} /> : <Text color="fg.subtle">—</Text>}</Box>
      <HStack gap={1.5} minW={0}>
        <NicheSummary row={r} />
        {review && (
          <Badge size="sm" colorPalette="orange" variant="subtle" gap={1} title={(r.review ?? []).join('\n')}>
            <AlertTriangleIcon boxSize={3} /> review
          </Badge>
        )}
        {awaiting && (
          <Badge
            size="sm"
            colorPalette="blue"
            variant="subtle"
            title="Acknowledged but no answer yet — still awaiting a substantive reply; follow-ups keep chasing."
          >
            {r.parsed?.intent === 'auto_reply' ? 'auto-reply' : 'awaiting'}
          </Badge>
        )}
        {late && (
          <Badge
            size="sm"
            colorPalette="purple"
            variant="subtle"
            title="Arrived after this target was already answered — saved without re-extraction. Open to read it; it may need a human."
          >
            new after answer
          </Badge>
        )}
      </HStack>
      <HStack justify="flex-end" gap={1}>
        <Button size="xs" variant="solid" colorPalette="brand" onClick={() => onShow(r)}>
          Show
        </Button>
        <Button size="xs" variant="ghost" onClick={() => onEdit(r.id)}>
          Edit
        </Button>
      </HStack>
    </Box>
  );
}

export function ResponsesView({ tick }: { tick: number }) {
  const [campaignFilter, setCampaignFilter] = useState('');
  const [nicheFilter, setNicheFilter] = useState('');
  const [canPostFilter, setCanPostFilter] = useState('');
  const [reviewFilter, setReviewFilter] = useState('');
  const [editId, setEditId] = useState<string | null>(null);
  const [showId, setShowId] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
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
    if (reviewFilter === 'awaiting' && !isAwaiting(r)) return false;
    if (reviewFilter === 'late' && !isLateMessage(r)) return false;
    if (reviewFilter === 'ok' && (needsReview(r) || isAwaiting(r) || isLateMessage(r))) return false;
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
  const awaitingCount = allRows.filter(isAwaiting).length;
  const lateCount = allRows.filter(isLateMessage).length;
  const editingRow = editId ? allRows.find((r) => r.id === editId) : undefined;
  const showingRow = showId ? allRows.find((r) => r.id === showId) : undefined;

  if (error)
    return (
      <Text color="red.fg" fontSize="sm" pt={4}>
        {error}
      </Text>
    );

  const selectWrap = { gap: 2, bg: 'bg.panel', borderWidth: '1px', borderColor: 'border', rounded: 'lg', pl: 3, pr: 1.5, py: 1 } as const;
  const listHeight = Math.min(rows.length * ROW_H, MAX_LIST_H);

  return (
    <Box pt={4}>
      <Text color="fg.muted" fontSize="sm" mb={4}>
        Inbound replies matched back to a target. Use <b>Show</b> to open the full thread, every
        AI-extracted niche price, and the raw decision. Filter by niche (grey niches roll up under
        “sensitive”) and willingness.
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
              <option value="awaiting">awaiting reply{awaitingCount ? ` (${awaitingCount})` : ''}</option>
              <option value="late">new after answer{lateCount ? ` (${lateCount})` : ''}</option>
              <option value="ok">no issues</option>
            </NativeSelect.Field>
            <NativeSelect.Indicator />
          </NativeSelect.Root>
        </HStack>

        <Box flex="1" minW="2" />

        <Button
          size="sm"
          variant="outline"
          colorPalette="brand"
          onClick={() => setExporting(true)}
          disabled={rows.length === 0}
          title="Export the filtered responses to XLSX or a self-contained HTML page"
        >
          <DownloadIcon /> Export
        </Button>
      </HStack>

      {editingRow && (
        <EditResponseForm
          row={editingRow}
          onClose={() => setEditId(null)}
          onSaved={reload}
        />
      )}

      {showingRow && (
        <ResponseDetailModal
          row={showingRow}
          onClose={() => setShowId(null)}
          onEdit={() => {
            setShowId(null);
            setEditId(showingRow.id);
          }}
        />
      )}

      {exporting && (
        <ExportDialog
          rows={rows}
          niches={niches as Niche[]}
          campaignName={(campaigns as Campaign[]).find((c) => c.id === campaignFilter)?.name}
          onClose={() => setExporting(false)}
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
              q || nicheFilter || canPostFilter || reviewFilter
                ? 'Try a different search or filter.'
                : 'Replies from contacted targets will show up here as they arrive.'
            }
          />
        }
      >
        <Box>
          {/* Header row (matches the virtualized grid columns) */}
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
            <Text>From</Text>
            <Text>Site</Text>
            <Text>Campaign</Text>
            <Text>Match</Text>
            <Text>Answer</Text>
            <Text>Niches</Text>
            <Text textAlign="end">Actions</Text>
          </Box>

          <List
            style={{ height: listHeight }}
            rowCount={rows.length}
            rowHeight={ROW_H}
            rowComponent={VirtualRow}
            rowProps={{ rows, onShow: (r) => setShowId(r.id), onEdit: setEditId } satisfies RowData}
            overscanCount={5}
          />
        </Box>
      </DataPanel>
    </Box>
  );
}
