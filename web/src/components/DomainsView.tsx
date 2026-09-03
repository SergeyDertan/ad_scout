import {
  Badge,
  Box,
  Button,
  CloseButton,
  Dialog,
  HStack,
  Input,
  InputGroup,
  NativeSelect,
  Portal,
  Spinner,
  Table,
  Text,
  VStack,
} from '@chakra-ui/react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { List, type RowComponentProps } from 'react-window';
import { api } from '../api';
import { useIsManager } from '../role';
import { DataPanel } from './DataPanel';
import { Empty } from './Empty';
import { useResource } from '../hooks/useResource';
import { ChevronDownIcon, DownloadIcon, SearchIcon, TagIcon } from './icons';
import { DomainsExportDialog } from './DomainsExportDialog';
import { ExtractionDebugModal } from './ExtractionDebugModal';
import { TierBadge } from './TierBadge';
import { answerForNiche, type NicheAnswer, type NicheVerdict } from '../niche-answer';
import {
  formatPrice,
  formatProvenance,
  formatTerm,
  tierOf,
  TIER_LABEL,
  type DomainCell,
  type DomainDetail,
  type DomainSummary,
  type EmailAttachment,
  type Niche,
  type PostOffer,
  type PriceCell,
  type PriceRecordRow,
  type ResponseRow,
  type Tier,
} from '../types';

function fmtDate(iso?: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function fmtDateTime(iso?: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function CanPostBadge({ value }: { value: string }) {
  const palette = value === 'yes' ? 'green' : value === 'no' ? 'red' : 'gray';
  return <Badge colorPalette={palette} variant="subtle">{value}</Badge>;
}

// --- Source-message viewer (the raw reply behind a price record) --------------

/** Fetches and shows the raw inbound message a price record was extracted from. */
function SourceMessage({ replyId }: { replyId: string }) {
  const [reply, setReply] = useState<ResponseRow | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api.getReply(replyId).then((r) => live && setReply(r)).catch((e) => live && setError(String(e)));
    return () => { live = false; };
  }, [replyId]);

  if (error) return <Text color="red.fg" fontSize="xs">{error}</Text>;
  if (!reply) return <HStack fontSize="xs" color="fg.muted" gap={2}><Spinner size="xs" /><Text>Loading message…</Text></HStack>;

  return (
    <VStack align="stretch" gap={2} mt={2}>
      <HStack fontSize="xs" color="fg.muted" gap={3} flexWrap="wrap">
        <Text><Text as="span" fontWeight="semibold">From:</Text> {reply.fromAddress}</Text>
        {reply.receivedAt && <Text><Text as="span" fontWeight="semibold">Received:</Text> {fmtDateTime(reply.receivedAt)}</Text>}
        {reply.parsed?.intent && <Badge size="sm" variant="surface">{reply.parsed.intent}</Badge>}
      </HStack>
      <Box bg="bg.subtle" borderWidth="1px" borderColor="border" rounded="md" p={3} maxH="320px" overflowY="auto">
        <Text as="pre" fontSize="xs" whiteSpace="pre-wrap" fontFamily="inherit" lineHeight="1.6">
          {reply.text?.trim() || '(no body)'}
        </Text>
      </Box>
      <Attachments attachments={reply.attachments} />
    </VStack>
  );
}

function Attachments({ attachments }: { attachments?: EmailAttachment[] }) {
  if (!attachments || attachments.length === 0) return null;
  return (
    <HStack gap={2} flexWrap="wrap">
      {attachments.map((a, i) => (
        <Box
          key={`${a.filename}-${i}`}
          as="a"
          {...{ href: `data:${a.mimeType};base64,${a.contentBase64}`, download: a.filename }}
          fontSize="xs"
          bg="bg.muted"
          rounded="md"
          px={2.5}
          py={1.5}
          _hover={{ bg: 'bg.subtle' }}
        >
          <Text as="span" fontWeight="medium">{a.filename}</Text>
          <Text as="span" color="fg.subtle" ml={2}>{(a.size / 1024).toFixed(1)} KB</Text>
        </Box>
      ))}
    </HStack>
  );
}

// --- Folded price sheet tables ------------------------------------------------

function CellRow({ cell, special }: { cell: PriceCell; special?: boolean }) {
  return (
    <Table.Row>
      <Table.Cell>
        <HStack gap={1.5}>
          <Text>{cell.label || cell.category}</Text>
          <TierBadge of={cell} />
        </HStack>
      </Table.Cell>
      <Table.Cell><CanPostBadge value={cell.canPost} /></Table.Cell>
      <Table.Cell fontWeight="medium">{formatPrice(cell.price)}</Table.Cell>
      <Table.Cell color="fg.muted">{formatTerm(cell.term)}</Table.Cell>
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

function PriceTable({ cells, special }: { cells: PriceCell[]; special?: boolean }) {
  return (
    <Table.Root size="sm" variant="line">
      <Table.Header>
        <Table.Row bg="bg.subtle">
          <Table.ColumnHeader>Niche</Table.ColumnHeader>
          <Table.ColumnHeader>Can post</Table.ColumnHeader>
          <Table.ColumnHeader>Price</Table.ColumnHeader>
          <Table.ColumnHeader>Term</Table.ColumnHeader>
          <Table.ColumnHeader>As of</Table.ColumnHeader>
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {/* Key on niche + term: one niche legitimately appears once per duration. */}
        {cells.map((c) => (
          <CellRow key={`${special ? 's|' : ''}${c.category}|${c.term?.key ?? 'none'}`} cell={c} special={special} />
        ))}
      </Table.Body>
    </Table.Root>
  );
}

// --- One history record (a single observed message) ---------------------------

function OfferRow({ offer }: { offer: PostOffer }) {
  return (
    <Table.Row>
      <Table.Cell>
        <HStack gap={1.5}>
          <Text>{offer.label || offer.category}</Text>
          <TierBadge of={offer} />
          {offer.isSpecial && (
            <Badge colorPalette="purple" variant="subtle" size="sm">
              special{offer.specialUntil ? ` · till ${offer.specialUntil}` : ''}
            </Badge>
          )}
        </HStack>
      </Table.Cell>
      <Table.Cell><CanPostBadge value={offer.canPost} /></Table.Cell>
      <Table.Cell fontWeight="medium">{formatPrice(offer.price)}</Table.Cell>
      <Table.Cell color="fg.muted">{formatTerm(offer.term)}</Table.Cell>
    </Table.Row>
  );
}

function HistoryRecord({ record }: { record: PriceRecordRow }) {
  const [showMsg, setShowMsg] = useState(false);
  const [debugId, setDebugId] = useState<string | null>(null);
  return (
    <Box borderWidth="1px" borderColor="border" rounded="lg" bg="bg.panel" p={3}>
      <HStack justify="space-between" flexWrap="wrap" gap={2} mb={2}>
        <HStack gap={2} flexWrap="wrap">
          <Text fontWeight="semibold" fontSize="sm">{fmtDateTime(record.observedAt)}</Text>
          <Badge size="sm" variant="surface" colorPalette={record.attribution === 'named' ? 'blue' : 'gray'}>
            {record.attribution === 'named' ? 'named site' : 'sender'}
          </Badge>
          {record.optOut && <Badge size="sm" colorPalette="red" variant="subtle">opted out</Badge>}
          {record.extraction?.editedByHuman && (
            <Badge size="sm" colorPalette="green" variant="subtle" title={formatProvenance(record.extraction)}>
              edited by hand
            </Badge>
          )}
        </HStack>
        {record.replyId ? (
          <HStack gap={2}>
            <Button size="xs" variant="outline" onClick={() => setShowMsg((v) => !v)}>
              {showMsg ? 'Hide message' : 'View source message'}
            </Button>
            {/* The full chain behind this record: email → prompt → model → records. */}
            <Button size="xs" variant="outline" onClick={() => setDebugId(record.replyId!)}>
              Debug extraction
            </Button>
          </HStack>
        ) : (
          <Text fontSize="xs" color="fg.subtle">no linked message</Text>
        )}
      </HStack>

      <HStack gap={4} fontSize="xs" color="fg.muted" flexWrap="wrap" mb={1}>
        <Text><Text as="span" fontWeight="semibold">Email:</Text> {record.sourceEmail || '—'}</Text>
        <Text truncate maxW="360px" title={record.sourceMessageId}>
          <Text as="span" fontWeight="semibold">Message-Id:</Text> {record.sourceMessageId || '—'}
        </Text>
      </HStack>

      {/* Which run produced this record — the answer to "can I trust this price?" */}
      <Text fontSize="xs" color="fg.subtle" mb={record.offers.length ? 2 : 0}>
        <Text as="span" fontWeight="semibold">Extracted by:</Text> {formatProvenance(record.extraction)}
      </Text>

      {record.aiExplanation && (
        <Box bg="bg.subtle" borderWidth="1px" borderColor="border" rounded="md" px={3} py={2} mb={2}>
          <Text fontSize="xs" fontWeight="semibold" color="fg.muted" mb={0.5}>Why the AI read it this way</Text>
          <Text fontSize="xs" lineHeight="1.6">{record.aiExplanation}</Text>
        </Box>
      )}

      {record.offers.length > 0 ? (
        <Box borderWidth="1px" borderColor="border" rounded="md" overflow="hidden">
          <Table.Root size="sm" variant="line">
            <Table.Header>
              <Table.Row bg="bg.subtle">
                <Table.ColumnHeader>Niche</Table.ColumnHeader>
                <Table.ColumnHeader>Can post</Table.ColumnHeader>
                <Table.ColumnHeader>Price</Table.ColumnHeader>
                <Table.ColumnHeader>Term</Table.ColumnHeader>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {record.offers.map((o, i) => <OfferRow key={`${o.category}|${o.term?.key ?? 'none'}|${i}`} offer={o} />)}
            </Table.Body>
          </Table.Root>
        </Box>
      ) : (
        <Text fontSize="xs" color="fg.subtle">No priced cells in this message (acknowledgement only).</Text>
      )}

      {showMsg && record.replyId && <SourceMessage replyId={record.replyId} />}
      {debugId && <ExtractionDebugModal replyId={debugId} onClose={() => setDebugId(null)} />}
    </Box>
  );
}

// --- Per-domain detail modal --------------------------------------------------

function DomainDetailModal({
  domain,
  onClose,
  onChanged,
  readOnly: readOnlyProp,
}: {
  domain: string;
  onClose: () => void;
  onChanged: () => void;
  readOnly?: boolean;
}) {
  // The viewer build already passes readOnly; a manager is read-only here for
  // the same reason — POST/DELETE /api/exclusions is an operator route. Folding
  // it into the existing flag keeps one notion of "cannot edit this panel".
  //
  // The hook is called unconditionally and combined after: `readOnlyProp ||
  // useIsManager()` would skip the call whenever the prop is true, which is a
  // conditional hook and breaks the moment that prop changes.
  const isManager = useIsManager();
  const readOnly = readOnlyProp || isManager;
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

  const sheet = detail?.sheet;
  const history = detail?.history ?? [];

  return (
    <Dialog.Root open onOpenChange={(e) => { if (!e.open) onClose(); }} size="xl" placement="center" scrollBehavior="inside">
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content rounded="xl" maxW="900px">
            <Dialog.Header>
              <HStack justify="space-between" flex="1" flexWrap="wrap" gap={2}>
                <HStack gap={2} flexWrap="wrap">
                  <Dialog.Title>{domain}</Dialog.Title>
                  {detail?.excluded && <Badge colorPalette="red" variant="solid">excluded</Badge>}
                  {sheet?.optedOut && <Badge colorPalette="purple" variant="subtle">opted out</Badge>}
                </HStack>
                {detail && !readOnly && (
                  <Button
                    size="sm"
                    variant={detail.excluded ? 'outline' : 'subtle'}
                    colorPalette="red"
                    onClick={toggleExcluded}
                    loading={busy}
                    mr={8}
                  >
                    {detail.excluded ? 'Re-include' : 'Exclude domain'}
                  </Button>
                )}
              </HStack>
            </Dialog.Header>

            <Dialog.Body>
              {error ? (
                <Text color="red.fg" fontSize="sm">{error}</Text>
              ) : !detail || !sheet ? (
                <HStack color="fg.muted" fontSize="sm" gap={2}><Spinner size="sm" /><Text>Loading…</Text></HStack>
              ) : (
                <VStack align="stretch" gap={5}>
                  <Box>
                    <Text fontSize="sm" fontWeight="semibold" color="fg.muted" mb={2}>
                      Current prices ({sheet.cells.length})
                    </Text>
                    {sheet.cells.length === 0 ? (
                      <Text fontSize="sm" color="fg.muted">No priced cells recorded yet.</Text>
                    ) : (
                      <PriceTable cells={sheet.cells} />
                    )}
                  </Box>

                  {sheet.specials.length > 0 && (
                    <Box>
                      <Text fontSize="sm" fontWeight="semibold" color="fg.muted" mb={2}>
                        Special offers ({sheet.specials.length})
                      </Text>
                      <PriceTable cells={sheet.specials} special />
                    </Box>
                  )}

                  <Box>
                    <Text fontSize="sm" fontWeight="semibold" color="fg.muted" mb={2}>
                      History ({history.length} record{history.length === 1 ? '' : 's'})
                    </Text>
                    {history.length === 0 ? (
                      <Text fontSize="sm" color="fg.muted">No observed messages for this domain yet.</Text>
                    ) : (
                      <VStack align="stretch" gap={2.5}>
                        {history.slice().reverse().map((r) => <HistoryRecord key={r.id} record={r} />)}
                      </VStack>
                    )}
                  </Box>
                </VStack>
              )}
            </Dialog.Body>

            <Dialog.Footer>
              <Button variant="outline" onClick={onClose}>Close</Button>
            </Dialog.Footer>

            <Dialog.CloseTrigger asChild>
              <CloseButton size="sm" />
            </Dialog.CloseTrigger>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}

// --- Sortable domains list ----------------------------------------------------

type SortKey = 'domain' | 'standingCells' | 'activeSpecials' | 'recordCount' | 'lastObservedAt';
type StateFilter = 'all' | 'excluded' | 'optedOut' | 'active' | 'specials';

/** Which niche verdicts to keep. 'open' — the default — is the question the page
 *  was built to answer ("where could this run?"), so it stays the landing state;
 *  the single-verdict options split that into certainty vs extrapolation, and
 *  'no' turns the page around into "who has ruled this out?". */
type AnswerFilter = 'open' | 'yes' | 'maybe' | 'no';

const ANSWER_FILTERS: { value: AnswerFilter; label: string }[] = [
  { value: 'open', label: 'yes + maybe' },
  { value: 'yes', label: 'yes — will post' },
  { value: 'maybe', label: 'maybe — fallback' },
  { value: 'no', label: 'no — refused' },
];

/** 'unknown' matches nothing: a domain with no evidence either way is not an
 *  answer to any of the four questions above. */
function matchesAnswer(verdict: NicheVerdict, filter: AnswerFilter): boolean {
  if (filter === 'open') return verdict === 'yes' || verdict === 'maybe';
  return verdict === filter;
}

// --- Offer filters (mutually exclusive): tier = sensitivity, category = niche.
// A cell counts as "on offer" only when the publisher said yes.
const canOffer = (c: DomainCell) => c.canPost === 'yes';

/** Regular → sensitive → unknown. Unclassified last: in the viewer it is a
 *  to-do pile, not a tier that sits between the other two. */
const TIER_ORDER: Tier[] = ['reg', 'sens', 'unknown'];
function tierRank(value: string): number {
  const i = TIER_ORDER.indexOf(value as Tier);
  return i < 0 ? TIER_ORDER.length : i;
}

// Domain | Prices | Specials | Records | Last quote | State
const COLS = '1fr 90px 90px 90px 150px 170px';
// Same, with the niche-answer column wedged in after Domain (niche filter on).
const COLS_WITH_ANSWER = '1fr 200px 90px 90px 90px 150px 170px';
const ROW_H = 52;
const MAX_LIST_H = 640;

function SortHeader({
  label, col, sortKey, dir, onSort,
}: {
  label: string; col: SortKey; sortKey: SortKey; dir: 'asc' | 'desc';
  onSort: (c: SortKey) => void;
}) {
  const active = sortKey === col;
  return (
    <HStack
      gap={1}
      as="button"
      {...{ type: 'button' }}
      onClick={() => onSort(col)}
      cursor="pointer"
      userSelect="none"
      minW={0}
      _hover={{ color: 'fg' }}
      color={active ? 'fg' : undefined}
    >
      <Text>{label}</Text>
      <Box
        as="span"
        transform={active && dir === 'asc' ? 'rotate(180deg)' : undefined}
        opacity={active ? 1 : 0.25}
        transition="transform 0.15s"
      >
        <ChevronDownIcon boxSize={3.5} />
      </Box>
    </HStack>
  );
}

/** A list row plus, when a niche filter is on, that niche's resolved answer. */
type DomainRowView = DomainSummary & { answer?: NicheAnswer };

interface RowData {
  rows: DomainRowView[];
  onSelect: (domain: string) => void;
  /** Set while a niche filter is active — drives the extra column. */
  answerColumn?: boolean;
}

const VERDICT_PALETTE: Record<NicheVerdict, string> = {
  yes: 'green', maybe: 'gray', no: 'red', unknown: 'gray',
};

function AnswerCell({ answer }: { answer: NicheAnswer }) {
  // What they'd charge, and how much of that is their word vs our inference.
  // One niche can contribute several cells (one per placement term), so name the
  // sources once each — "inferred from casino, casino" reads like a bug.
  const sources = [...new Set(answer.from.map((c) => c.label || c.category))];
  const title =
    answer.verdict === 'no'
      ? answer.inferred
        ? `Not asked about this niche — but they refuse ${sources.join(', ')} and offer nothing else in this tier`
        : 'They refused this niche by name'
      : answer.inferred
        ? `Not quoted for this niche — inferred from what they charge for ${sources.join(', ')}`
        : 'Quoted for this niche';
  return (
    <HStack gap={1.5} minW={0} title={title}>
      <Badge colorPalette={VERDICT_PALETTE[answer.verdict]} variant="subtle" size="sm">
        {answer.verdict}
      </Badge>
      <Text fontWeight="medium" overflow="hidden" textOverflow="ellipsis" whiteSpace="nowrap">
        {answer.price}
      </Text>
      {answer.inferred && <Text color="fg.subtle" fontSize="xs">~</Text>}
    </HStack>
  );
}

function VirtualRow({ index, style, rows, onSelect, answerColumn }: RowComponentProps<RowData>) {
  const d = rows[index]!;
  return (
    <Box
      style={style}
      display="grid"
      gridTemplateColumns={answerColumn ? COLS_WITH_ANSWER : COLS}
      alignItems="center"
      px={4}
      gap={3}
      fontSize="sm"
      cursor="pointer"
      onClick={() => onSelect(d.domain)}
      borderBottomWidth="1px"
      borderColor="border"
      bg={index % 2 === 0 ? 'bg.panel' : 'bg.subtle'}
      _hover={{ bg: 'bg.muted' }}
      transition="background 0.1s"
    >
      <Text fontWeight="medium" overflow="hidden" textOverflow="ellipsis" whiteSpace="nowrap">
        {d.domain}
      </Text>
      {answerColumn && (d.answer ? <AnswerCell answer={d.answer} /> : <Text color="fg.subtle">—</Text>)}
      <Text>{d.standingCells}</Text>
      <Text>{d.activeSpecials || '—'}</Text>
      <Text>{d.recordCount}</Text>
      <Text color="fg.muted" overflow="hidden" textOverflow="ellipsis" whiteSpace="nowrap">
        {fmtDate(d.lastObservedAt)}
      </Text>
      <HStack gap={1.5} minW={0}>
        {d.excluded && <Badge colorPalette="red" variant="solid" size="sm">excluded</Badge>}
        {d.optedOut && <Badge colorPalette="purple" variant="subtle" size="sm">opted out</Badge>}
        {!d.excluded && !d.optedOut && <Text color="fg.subtle">—</Text>}
      </HStack>
    </Box>
  );
}

export function DomainsView({ tick, readOnly }: { tick: number; readOnly?: boolean }) {
  const { rows, loading, error, reload } = useResource(useCallback(() => api.listDomains(), []), tick);
  // The full taxonomy, not just what has been quoted: with same-tier inference,
  // filtering for a niche NOBODY has priced is a meaningful question — every
  // grey-niche site answers it — so it has to be offered in the dropdown.
  const { rows: niches } = useResource(useCallback(() => api.listNiches(), []), tick);
  const [selected, setSelected] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [stateFilter, setStateFilter] = useState<StateFilter>('all');
  const [tierFilter, setTierFilter] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [answerFilter, setAnswerFilter] = useState<AnswerFilter>('open');
  const [sortKey, setSortKey] = useState<SortKey>('lastObservedAt');
  const [dir, setDir] = useState<'asc' | 'desc'>('desc');
  const [showExport, setShowExport] = useState(false);

  const onSort = (col: SortKey) => {
    if (col === sortKey) setDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(col); setDir(col === 'domain' ? 'asc' : 'desc'); }
  };

  // Offer-filter dropdown options, derived from what the domains actually offer
  // (canPost === 'yes'). Tier = sensitivity; category = niche.
  const tierOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const d of rows as DomainSummary[]) {
      for (const c of d.cells ?? []) {
        if (!canOffer(c)) continue;
        const value = tierOf(c);
        if (!seen.has(value)) seen.set(value, TIER_LABEL[value]);
      }
    }
    return [...seen.entries()]
      .map(([value, label]) => ({ value, label }))
      .sort((a, b) => tierRank(a.value) - tierRank(b.value));
  }, [rows]);

  // Every niche's tier, read off the cells that DO carry it. Needed because the
  // interesting case is a domain with no cell for the filtered niche at all —
  // there is nothing local to read the tier from. In the viewer these tiers are
  // his classification, so a re-classification flows straight through here.
  const tierByCategory = useMemo(() => {
    const map = new Map<string, Tier>();
    for (const n of niches as Niche[]) map.set(n.key, tierOf(n));
    for (const d of rows as DomainSummary[]) {
      for (const c of d.cells ?? []) if (!map.has(c.category)) map.set(c.category, tierOf(c));
    }
    return map;
  }, [rows, niches]);

  const categoryOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const n of niches as Niche[]) seen.set(n.key, n.label || n.key);
    // Plus anything quoted that the taxonomy hasn't caught up with yet. Includes
    // niches only ever REFUSED: "who else might take a VPN post?" is precisely
    // the question the refusal answers for one site and inference answers for
    // the rest.
    for (const d of rows as DomainSummary[]) {
      for (const c of d.cells ?? []) if (!seen.has(c.category)) seen.set(c.category, c.label || c.category);
    }
    return [...seen.entries()]
      .map(([value, label]) => ({ value, label }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [rows, niches]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filterTier = categoryFilter ? tierByCategory.get(categoryFilter) ?? 'unknown' : 'unknown';
    const filtered: DomainRowView[] = [];
    for (const d of rows as DomainSummary[]) {
      if (q && !d.domain.toLowerCase().includes(q)) continue;
      switch (stateFilter) {
        case 'excluded': if (!d.excluded) continue; break;
        case 'optedOut': if (!d.optedOut) continue; break;
        case 'specials': if (d.activeSpecials <= 0) continue; break;
        case 'active': if (d.excluded || d.optedOut) continue; break;
        default: break;
      }
      if (tierFilter && !(d.cells ?? []).some((c) => canOffer(c) && tierOf(c) === tierFilter)) continue;
      if (categoryFilter) {
        // Not a key match: what would a post in this niche cost here? A domain
        // that never mentioned it still answers, from its same-tier prices; one
        // that refused it answers 'no'; one with nothing to go on drops out
        // whatever the answer filter says. See niche-answer.ts.
        const answer = answerForNiche(d.cells ?? [], categoryFilter, filterTier);
        if (!matchesAnswer(answer.verdict, answerFilter)) continue;
        filtered.push({ ...d, answer });
        continue;
      }
      filtered.push(d);
    }
    const factor = dir === 'asc' ? 1 : -1;
    return filtered.sort((a, b) => {
      if (sortKey === 'domain') return factor * a.domain.localeCompare(b.domain);
      if (sortKey === 'lastObservedAt') return factor * (a.lastObservedAt ?? '').localeCompare(b.lastObservedAt ?? '');
      return factor * ((a[sortKey] as number) - (b[sortKey] as number));
    });
  }, [rows, search, stateFilter, tierFilter, categoryFilter, answerFilter, tierByCategory, sortKey, dir]);

  const listHeight = Math.min(visible.length * ROW_H, MAX_LIST_H);

  if (error) return <Text color="red.fg" fontSize="sm" pt={4}>{error}</Text>;

  return (
    <Box pt={4}>
      <Text color="fg.muted" fontSize="sm" mb={4}>
        Per-domain price history — every recorded quote, folded into a current price sheet. Click a row to open the
        full history. Subdomains and TLDs are kept distinct (casik.com ≠ casik.ua). Filtering by niche answers “what
        would this cost here?”: <Text as="span" fontWeight="semibold">yes</Text> is their own quote for that niche,{' '}
        <Text as="span" fontWeight="semibold">maybe ~</Text> is a fallback from what they charge for others in the same
        tier, and <Text as="span" fontWeight="semibold">no</Text> is a refusal — of that niche, or of the whole tier.
        Sites with nothing to go on are left out either way.
      </Text>

      <HStack gap={2} mb={3} flexWrap="wrap">
        <InputGroup startElement={<SearchIcon boxSize={3.5} color="fg.muted" />} maxW="64">
          <Input
            size="sm"
            placeholder="Search domain…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            bg="bg.panel"
          />
        </InputGroup>
        <NativeSelect.Root size="sm" width="44" variant="plain">
          <NativeSelect.Field value={stateFilter} onChange={(e) => setStateFilter(e.target.value as StateFilter)} fontWeight="medium">
            <option value="all">all domains</option>
            <option value="active">active (contactable)</option>
            <option value="specials">has active specials</option>
            <option value="optedOut">opted out</option>
            <option value="excluded">excluded</option>
          </NativeSelect.Field>
          <NativeSelect.Indicator />
        </NativeSelect.Root>

        {/* Offer filters — only one at a time (a sensitivity tier and a niche
            would usually contradict, e.g. "regular" × "casino" → nothing). */}
        <NativeSelect.Root size="sm" width="48" variant="plain" disabled={!!categoryFilter}>
          <NativeSelect.Field
            value={tierFilter}
            onChange={(e) => { setTierFilter(e.target.value); if (e.target.value) setCategoryFilter(''); }}
            fontWeight="medium"
          >
            <option value="">any tier</option>
            {tierOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </NativeSelect.Field>
          <NativeSelect.Indicator />
        </NativeSelect.Root>

        <NativeSelect.Root size="sm" width="44" variant="plain" disabled={!!tierFilter}>
          <NativeSelect.Field
            value={categoryFilter}
            onChange={(e) => {
              setCategoryFilter(e.target.value);
              if (e.target.value) setTierFilter('');
              // Clearing the niche leaves nothing for the verdict to be about, so
              // don't let a stale 'no' silently narrow the next niche picked.
              else setAnswerFilter('open');
            }}
            fontWeight="medium"
          >
            <option value="">any niche</option>
            {categoryOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </NativeSelect.Field>
          <NativeSelect.Indicator />
        </NativeSelect.Root>

        {/* Availability for the picked niche. Meaningless without one — there is
            no verdict to filter on until a niche is chosen. */}
        <NativeSelect.Root size="sm" width="48" variant="plain" disabled={!categoryFilter}>
          <NativeSelect.Field
            value={answerFilter}
            onChange={(e) => setAnswerFilter(e.target.value as AnswerFilter)}
            fontWeight="medium"
            title={categoryFilter ? undefined : 'Pick a niche first'}
          >
            {ANSWER_FILTERS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </NativeSelect.Field>
          <NativeSelect.Indicator />
        </NativeSelect.Root>

        <Button
          size="sm"
          variant="outline"
          ml="auto"
          onClick={() => setShowExport(true)}
          disabled={visible.length === 0}
        >
          <DownloadIcon /> Export
        </Button>
        <Text fontSize="xs" color="fg.subtle">
          {visible.length} of {rows.length} domain{rows.length === 1 ? '' : 's'}
        </Text>
      </HStack>

      {categoryFilter && (tierByCategory.get(categoryFilter) ?? 'unknown') === 'unknown' && (
        <Text fontSize="xs" color="fg.muted" mb={3}>
          <Text as="span" fontWeight="semibold">
            {categoryOptions.find((o) => o.value === categoryFilter)?.label ?? categoryFilter}
          </Text>{' '}
          isn’t classified yet, so this shows only sites that quoted it by name. Mark it sensitive or regular under
          Niches to also see what comparable sites charge.
        </Text>
      )}

      <DataPanel
        loading={loading}
        isEmpty={rows.length === 0}
        empty={<Empty icon={TagIcon} title="No domains yet" description="Price records appear here as publishers reply with quotes." />}
      >
        {visible.length === 0 ? (
          <Text fontSize="sm" color="fg.muted" py={6} textAlign="center">No domains match the current filter.</Text>
        ) : (
          <Box>
            {/* Header row (matches the virtualized grid columns) */}
            <Box
              display="grid"
              gridTemplateColumns={categoryFilter ? COLS_WITH_ANSWER : COLS}
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
              <SortHeader label="Domain" col="domain" sortKey={sortKey} dir={dir} onSort={onSort} />
              {categoryFilter && (
                <Text title="Their own quote where they gave one; otherwise inferred from what they charge for other niches in the same tier (marked ~)">
                  {categoryOptions.find((o) => o.value === categoryFilter)?.label ?? categoryFilter} price
                </Text>
              )}
              <SortHeader label="Prices" col="standingCells" sortKey={sortKey} dir={dir} onSort={onSort} />
              <SortHeader label="Specials" col="activeSpecials" sortKey={sortKey} dir={dir} onSort={onSort} />
              <SortHeader label="Records" col="recordCount" sortKey={sortKey} dir={dir} onSort={onSort} />
              <SortHeader label="Last quote" col="lastObservedAt" sortKey={sortKey} dir={dir} onSort={onSort} />
              <Text>State</Text>
            </Box>

            <List
              style={{ height: listHeight }}
              rowCount={visible.length}
              rowHeight={ROW_H}
              rowComponent={VirtualRow}
              rowProps={{ rows: visible, onSelect: setSelected, answerColumn: !!categoryFilter } satisfies RowData}
              overscanCount={5}
            />
          </Box>
        )}
      </DataPanel>

      {showExport && (
        <DomainsExportDialog
          domains={visible}
          defaultIncludeExcluded={stateFilter === 'excluded'}
          onClose={() => setShowExport(false)}
        />
      )}

      {selected && (
        <DomainDetailModal
          domain={selected}
          onClose={() => setSelected(null)}
          onChanged={reload}
          readOnly={readOnly}
        />
      )}
    </Box>
  );
}
