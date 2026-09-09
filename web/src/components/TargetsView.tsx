import {
  Badge,
  Box,
  Button,
  Flex,
  HStack,
  Input,
  InputGroup,
  Link,
  NativeSelect,
  Text,
} from '@chakra-ui/react';
import { useCallback, useDeferredValue, useState } from 'react';
import { List, type RowComponentProps } from 'react-window';
import { api } from '../api';
import { useIsManager } from '../role';
import type { BatchFilterOption, TargetFacets, TargetListRow, TargetStatus } from '../types';
import { StatusBadge } from './StatusBadge';
import { AddTargetForm } from './AddTargetForm';
import { BulkImportForm } from './BulkImportForm';
import { ThreadPanel } from './ThreadPanel';
import { Empty } from './Empty';
import { useConfirm } from './Confirm';
import { toaster, toastError } from './Toaster';
import { usePagedResource } from '../hooks/useResource';
import { FilterIcon, PlusIcon, SearchIcon, TargetIcon, TrashIcon } from './icons';

const TARGET_STATUSES: TargetStatus[] = [
  'pending', 'reserved', 'contacted', 'replied', 'bounced', 'needs_review', 'excluded',
];
const STATUSES: (TargetStatus | '')[] = ['', ...TARGET_STATUSES];

// px widths for the 7 columns: website | batch | contact | status | followups | canpost | actions
const COLS = '1fr 140px 200px 110px 64px 70px 80px';
const ROW_H = 52;
const MAX_LIST_H = 600;
const PAGE_SIZE = 50;
const EMPTY_FACETS: TargetFacets = { byStatus: {}, unbatched: 0, batches: [] };

type Mode = 'add' | 'import' | null;

// Sentinel batch-filter value for targets that carry no batchId (pre-backfill).
const NO_BATCH = '__none__';

/** Human label for a batch option — date/time of the import + row count. The raw
 *  id (a uuid) is unhelpful on its own, so it goes in the option's title tooltip. */
function batchLabel(b: BatchFilterOption): string {
  const when = new Date(b.createdAt).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
  return `${when} · ${b.count}`;
}

// Stat chip for status breakdown
function StatChip({ label, value, active, onClick }: { label: string; value: number; active: boolean; onClick: () => void }) {
  return (
    <HStack
      gap={1.5}
      px={2.5}
      py={1}
      rounded="full"
      cursor="pointer"
      bg={active ? 'brand.subtle' : 'bg.muted'}
      borderWidth="1px"
      borderColor={active ? 'brand.muted' : 'border'}
      onClick={onClick}
      userSelect="none"
      _hover={{ borderColor: 'brand.emphasized' }}
      transition="all 0.12s"
    >
      <Text fontSize="xs" color={active ? 'brand.fg' : 'fg.muted'} fontWeight={active ? 'semibold' : 'normal'}>
        {label}
      </Text>
      <Badge size="sm" colorPalette={active ? 'brand' : 'gray'} variant={active ? 'solid' : 'subtle'} rounded="full">
        {value}
      </Badge>
    </HStack>
  );
}

// Row renderer for react-window 2.x — extra props come from rowProps
interface RowData {
  targets: TargetListRow[];
  onRemove: (t: TargetListRow) => void;
  /** False for a manager: DELETE /api/targets/:id is refused for that role. */
  canRemove: boolean;
  onThread: (t: TargetListRow) => void;
  threadId: string | null;
}

function VirtualRow({ index, style, targets, onRemove, canRemove, onThread, threadId }: RowComponentProps<RowData>) {
  const t = targets[index]!;
  const isThreadOpen = threadId === t.id;
  return (
    <Box
      style={style}
      display="grid"
      gridTemplateColumns={COLS}
      alignItems="center"
      px={4}
      borderBottomWidth="1px"
      borderColor="border"
      bg={isThreadOpen ? 'bg.muted' : index % 2 === 0 ? 'bg.panel' : 'bg.subtle'}
      _hover={{ bg: 'bg.muted' }}
      transition="background 0.1s"
      gap={3}
      fontSize="sm"
    >
      <Box minW={0}>
        <Link
          href={t.websiteUrl.startsWith('http') ? t.websiteUrl : `https://${t.websiteUrl}`}
          target="_blank"
          rel="noreferrer"
          fontWeight="semibold"
          color="fg"
          display="block"
          overflow="hidden"
          textOverflow="ellipsis"
          whiteSpace="nowrap"
          _hover={{ color: 'brand.fg', textDecoration: 'underline' }}
        >
          {t.websiteUrl}
        </Link>
        {t.contactName && (
          <Text fontSize="xs" color="fg.muted" overflow="hidden" textOverflow="ellipsis" whiteSpace="nowrap">
            {t.contactName}
          </Text>
        )}
      </Box>
      <Text color="fg.muted" overflow="hidden" textOverflow="ellipsis" whiteSpace="nowrap" fontSize="xs">
        {t.batchName ?? (t.batchId ? `batch ${t.batchId.replace(/^batch_/, '').slice(0, 8)}` : '—')}
      </Text>
      <Text color="fg.muted" overflow="hidden" textOverflow="ellipsis" whiteSpace="nowrap">
        {t.contactEmail}
      </Text>
      <Box><StatusBadge value={t.status} /></Box>
      <Text textAlign="center" color={t.followUpCount ? 'fg' : 'fg.subtle'}>{t.followUpCount}</Text>
      <Text color="fg.muted">{t.canPost ?? '—'}</Text>
      <HStack justify="flex-end" gap={1}>
        <Button
          size="xs"
          variant={isThreadOpen ? 'solid' : 'outline'}
          colorPalette={isThreadOpen ? 'brand' : 'gray'}
          onClick={() => onThread(t)}
          px={2}
        >
          {isThreadOpen ? '↑' : 'Thread'}
        </Button>
        <Button size="xs" variant="ghost" colorPalette="red" hidden={!canRemove} onClick={() => onRemove(t)}>
          <TrashIcon />
        </Button>
      </HStack>
    </Box>
  );
}

export function TargetsView({ tick }: { tick: number }) {
  // Importing targets is explicitly not a manager's job; reading them is.
  const isManager = useIsManager();
  const [statusFilter, setStatusFilter] = useState<TargetStatus | ''>('');
  const [batchFilter, setBatchFilter] = useState('');
  const [search, setSearch] = useState('');
  const [mode, setMode] = useState<Mode>(null);
  const [threadTarget, setThreadTarget] = useState<TargetListRow | null>(null);
  const confirm = useConfirm();

  const deferredSearch = useDeferredValue(search.trim());
  const filterKey = JSON.stringify([statusFilter, batchFilter, deferredSearch]);
  const [pageCursor, setPageCursor] = useState<{ filterKey: string; value?: string }>({ filterKey: '' });
  const cursor = pageCursor.filterKey === filterKey ? pageCursor.value : undefined;
  const {
    result,
    loading,
    error,
    reload: load,
  } = usePagedResource(
    useCallback(
      (signal: AbortSignal) => api.listTargetPage({
        limit: PAGE_SIZE,
        ...(cursor ? { cursor } : {}),
        ...(statusFilter ? { status: statusFilter } : {}),
        ...(batchFilter && batchFilter !== NO_BATCH ? { batchId: batchFilter } : {}),
        ...(batchFilter === NO_BATCH ? { unbatched: true } : {}),
        ...(deferredSearch ? { search: deferredSearch } : {}),
      }, signal),
      [batchFilter, cursor, deferredSearch, statusFilter],
    ),
    tick,
  );
  const targets = result?.items ?? [];
  const facets = result?.facets ?? EMPTY_FACETS;
  const batches = facets.batches;
  const hasUnbatched = facets.unbatched > 0;
  const byStatus = facets.byStatus;
  const statusTotal = Object.values(byStatus).reduce((sum, count) => sum + (count ?? 0), 0);

  const remove = async (t: TargetListRow) => {
    const ok = await confirm({
      title: 'Remove target?',
      description: <><b>{t.websiteUrl}</b> will be removed from the outreach queue.</>,
      confirmLabel: 'Remove',
      destructive: true,
    });
    if (!ok) return;
    try {
      await api.deleteTarget(t.id);
      toaster.create({ type: 'success', title: `Removed ${t.websiteUrl}` });
      if (threadTarget?.id === t.id) setThreadTarget(null);
      load();
    } catch (e) {
      toastError('Could not remove target', e);
    }
  };

  const handleThread = (t: TargetListRow) => {
    setThreadTarget((prev) => (prev?.id === t.id ? null : t));
  };

  const listHeight = Math.min(targets.length * ROW_H, MAX_LIST_H);

  const rowData: RowData = {
    targets,
    onRemove: remove,
    canRemove: !isManager,
    onThread: handleThread,
    threadId: threadTarget?.id ?? null,
  };

  return (
    <Box pt={4}>
      {/* Stats row */}
      {statusTotal > 0 && !loading && (
        <HStack gap={2} mb={3} flexWrap="wrap">
          <StatChip
            label="all"
            value={statusTotal}
            active={statusFilter === ''}
            onClick={() => setStatusFilter('')}
          />
          {TARGET_STATUSES.map((s) =>
            byStatus[s] ? (
              <StatChip
                key={s}
                label={s.replace(/_/g, ' ')}
                value={byStatus[s] ?? 0}
                active={statusFilter === s}
                onClick={() => setStatusFilter(statusFilter === s ? '' : s as TargetStatus)}
              />
            ) : null
          )}
        </HStack>
      )}

      {/* Toolbar */}
      <Flex mb={3} align="center" gap={2} wrap="wrap">
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
          <FilterIcon boxSize={3.5} color="fg.muted" />
          <NativeSelect.Root size="sm" width="36" variant="plain">
            <NativeSelect.Field
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as TargetStatus | '')}
              fontWeight="medium"
            >
              {STATUSES.map((s) => (
                <option key={s} value={s}>{s ? s.replace(/_/g, ' ') : 'all statuses'}</option>
              ))}
            </NativeSelect.Field>
            <NativeSelect.Indicator />
          </NativeSelect.Root>
        </HStack>

        {(batches.length > 0 || hasUnbatched) && (
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
            <NativeSelect.Root size="sm" width="44" variant="plain">
              <NativeSelect.Field
                value={batchFilter}
                onChange={(e) => setBatchFilter(e.target.value)}
                fontWeight="medium"
              >
                <option value="">all batches</option>
                {batches.map((b) => (
                  <option key={b.id} value={b.id} title={b.id}>
                    {b.name?.trim() || batchLabel(b)}
                  </option>
                ))}
                {hasUnbatched && <option value={NO_BATCH}>— no batch —</option>}
              </NativeSelect.Field>
              <NativeSelect.Indicator />
            </NativeSelect.Root>
          </HStack>
        )}

        <InputGroup startElement={<SearchIcon boxSize={3.5} color="fg.muted" />} maxW="64">
          <Input
            size="sm"
            placeholder="Search email or website…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            bg="bg.panel"
          />
        </InputGroup>

        <Box flex="1" />
        {!isManager && (
          <>
            <Button
              size="sm"
              variant={mode === 'import' ? 'outline' : 'subtle'}
              onClick={() => setMode((m) => (m === 'import' ? null : 'import'))}
            >
              Import list
            </Button>
            <Button
              size="sm"
              colorPalette="brand"
              variant={mode === 'add' ? 'outline' : 'solid'}
              onClick={() => setMode((m) => (m === 'add' ? null : 'add'))}
            >
              {mode === 'add' ? 'Close' : <><PlusIcon /> Add target</>}
            </Button>
          </>
        )}
      </Flex>

      {mode === 'add' && !isManager && <AddTargetForm onClose={() => setMode(null)} onCreated={load} />}
      {mode === 'import' && !isManager && <BulkImportForm onClose={() => setMode(null)} onCreated={load} />}
      {threadTarget && <ThreadPanel target={threadTarget} onClose={() => setThreadTarget(null)} />}

      {error && <Text color="red.fg" fontSize="sm" mb={3}>{error}</Text>}

      {loading && targets.length === 0 ? (
        <Box py={12} display="flex" justifyContent="center">
          <Text color="fg.muted" fontSize="sm">Loading…</Text>
        </Box>
      ) : targets.length === 0 ? (
        <Empty
          icon={TargetIcon}
          title={
            deferredSearch
              ? `No targets match "${search.trim()}"`
              : statusFilter
                ? `No ${statusFilter.replace(/_/g, ' ')} targets`
                : 'No targets queued'
          }
          description={
            deferredSearch || statusFilter || batchFilter
              ? 'Try a different filter.'
              : 'Add a website to the outreach queue to begin.'
          }
        >
          {!statusFilter && !deferredSearch && (
            <Button size="sm" colorPalette="brand" mt={2} hidden={isManager} onClick={() => setMode('add')}>
              <PlusIcon /> Add target
            </Button>
          )}
        </Empty>
      ) : (
        <>
          <Box
            bg="bg.panel"
            borderWidth="1px"
            borderColor="border"
            rounded="xl"
            boxShadow="xs"
            overflow="hidden"
          >
          {/* Sticky header */}
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
            position="sticky"
            top={0}
            zIndex={1}
          >
            <Text>Website</Text>
            <Text>Batch</Text>
            <Text>Contact</Text>
            <Text>Status</Text>
            <Text textAlign="center">F/U</Text>
            <Text>Can post</Text>
            <Text textAlign="end">Actions</Text>
          </Box>

            <List
              style={{ height: listHeight }}
              rowCount={targets.length}
              rowHeight={ROW_H}
              rowComponent={VirtualRow}
              rowProps={rowData}
              overscanCount={5}
            />
          </Box>
          <Flex mt={3} align="center" justify="space-between" gap={3} wrap="wrap">
            <Text color="fg.muted" fontSize="xs">
              {targets.length} on this page · {result?.page.total ?? 0} matching
            </Text>
            <HStack gap={2}>
              <Button
                size="xs"
                variant="outline"
                disabled={!result?.page.previousCursor || loading}
                onClick={() => setPageCursor({ filterKey, value: result?.page.previousCursor })}
              >
                Previous
              </Button>
              <Button
                size="xs"
                variant="outline"
                disabled={!result?.page.nextCursor || loading}
                onClick={() => setPageCursor({ filterKey, value: result?.page.nextCursor })}
              >
                Next
              </Button>
            </HStack>
          </Flex>
        </>
      )}
    </Box>
  );
}
