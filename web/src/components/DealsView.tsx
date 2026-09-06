// The Deals workspace: every human-operated negotiation, its correspondence, and
// the posts being bought. Nothing here is inferred — every field is one a person
// typed, and the agreed price is deliberately never fed back into the price
// history (a negotiated figure is not the publisher's standing rate).
//
// The detail view is a messenger, not a form: the conversation is the page, and
// what we know about the deal sits in a rail beside it. That is not decoration.
// Negotiating means reading the last message and answering it, and the previous
// layout put a screen and a half of post-editing fields above the chat box.

import {
  Badge,
  Box,
  Button,
  CloseButton,
  Dialog,
  Field,
  Flex,
  HStack,
  Heading,
  Input,
  NativeSelect,
  Portal,
  Table,
  Text,
  Textarea,
  VStack,
} from '@chakra-ui/react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { splitQuoted } from '../quoted-text';
import type {
  Account,
  DealDetail,
  DealRow,
  DealStatus,
  DealTimelineItem,
  Placement,
} from '../types';
import { Attachments } from './Attachments';
import { DataPanel } from './DataPanel';
import { Empty } from './Empty';
import { Panel } from './Panel';
import { useConfirm } from './Confirm';
import { useResource } from '../hooks/useResource';
import { toaster, toastError } from './Toaster';
import { AlertTriangleIcon, CheckIcon, MegaphoneIcon, PlusIcon, SendIcon, TrashIcon } from './icons';

const STATUS_META: Record<DealStatus, { label: string; palette: string }> = {
  negotiation: { label: 'Negotiation', palette: 'orange' },
  fulfilment: { label: 'Pay · Publish · Verify', palette: 'blue' },
  done: { label: 'Done', palette: 'green' },
  closed: { label: 'Closed', palette: 'gray' },
};

function fmtDate(iso?: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** Just the clock, for the line under a bubble — the day is on its own divider. */
function fmtTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function fmtShortDate(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** The label on a day divider: relative for the two days you actually work in. */
function fmtDay(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const today = new Date();
  const dayKey = (x: Date) => x.toDateString();
  if (dayKey(d) === dayKey(today)) return 'Today';
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (dayKey(d) === dayKey(yesterday)) return 'Yesterday';
  return d.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    ...(d.getFullYear() === today.getFullYear() ? {} : { year: 'numeric' }),
  });
}

/** A date input wants `yyyy-mm-dd`; the store holds a full ISO timestamp. */
function toDateInput(iso?: string): string {
  return iso ? iso.slice(0, 10) : '';
}
function fromDateInput(value: string): string | undefined {
  return value ? new Date(value + 'T12:00:00Z').toISOString() : undefined;
}

export function DealsView({
  tick,
  dealId,
  onSelect,
}: {
  tick: number;
  /** The open deal, from the URL (/deals/<id>) — so a refresh or a shared link
   *  lands on the same conversation instead of the list. */
  dealId?: string;
  onSelect: (id?: string) => void;
}) {
  const { rows, loading, error, reload } = useResource<DealRow>(
    useCallback(() => api.listDeals(), []),
    tick,
  );
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    api.listAccounts().then(setAccounts).catch(() => setAccounts([]));
  }, []);

  if (error)
    return (
      <Text color="red.fg" fontSize="sm" pt={4}>
        {error}
      </Text>
    );

  if (dealId) {
    return (
      <DealDetailView
        dealId={dealId}
        tick={tick}
        onBack={() => {
          onSelect(undefined);
          reload();
        }}
      />
    );
  }

  return (
    <Box pt={4}>
      <HStack justify="space-between" mb={4} align="start">
        <Text color="fg.muted" fontSize="sm" maxW="3xl">
          Conversations you are running by hand. While a deal is open its threads are held: replies
          are stored and labelled <b>AS/Deal</b>, left unread, and never sent to the extractor — so
          nothing said mid-negotiation can rewrite a price, exclude a domain, or suppress an address.
        </Text>
        <Button size="sm" colorPalette="brand" onClick={() => setCreating((v) => !v)}>
          {creating ? 'Cancel' : 'New deal'}
        </Button>
      </HStack>

      {creating && (
        <NewDealForm
          accounts={accounts}
          onCreated={(id) => {
            setCreating(false);
            reload();
            onSelect(id);
          }}
        />
      )}

      <DataPanel
        loading={loading}
        isEmpty={rows.length === 0}
        empty={
          <Empty
            icon={MegaphoneIcon}
            title="No deals yet"
            description="Open one when a publisher answers with a price: Start a deal on the Responses page continues that very thread, or use New deal here."
          />
        }
      >
        <Table.Root size="sm" interactive>
          <Table.Header>
            <Table.Row>
              <Table.ColumnHeader>Status</Table.ColumnHeader>
              <Table.ColumnHeader>Webmaster</Table.ColumnHeader>
              <Table.ColumnHeader>Our mailbox</Table.ColumnHeader>
              <Table.ColumnHeader>Sites</Table.ColumnHeader>
              <Table.ColumnHeader>Progress</Table.ColumnHeader>
              <Table.ColumnHeader>Opened</Table.ColumnHeader>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {rows.map((d) => (
              <Table.Row key={d.id} cursor="pointer" onClick={() => onSelect(d.id)}>
                <Table.Cell>
                  <Badge size="sm" colorPalette={STATUS_META[d.status].palette} variant="subtle">
                    {STATUS_META[d.status].label}
                  </Badge>
                </Table.Cell>
                <Table.Cell fontWeight="medium">{d.counterpartyEmail}</Table.Cell>
                <Table.Cell color="fg.muted" fontSize="xs">
                  {d.accountEmail ?? '—'}
                </Table.Cell>
                <Table.Cell>
                  {d.domains.length ? d.domains.join(', ') : <Text color="fg.subtle">no site yet</Text>}
                </Table.Cell>
                <Table.Cell>
                  <Text fontSize="xs" color="fg.muted">
                    {d.placementCount} post{d.placementCount === 1 ? '' : 's'} · {d.paidCount} paid ·{' '}
                    {d.liveCount} live
                  </Text>
                </Table.Cell>
                <Table.Cell color="fg.muted" fontSize="xs">
                  {fmtDate(d.openedAt)}
                </Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table.Root>
      </DataPanel>
    </Box>
  );
}

function NewDealForm({
  accounts,
  onCreated,
}: {
  accounts: Account[];
  onCreated: (id: string) => void;
}) {
  const [email, setEmail] = useState('');
  const [domains, setDomains] = useState('');
  const [accountId, setAccountId] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!accountId && accounts[0]) setAccountId(accounts[0].id);
  }, [accounts, accountId]);

  const submit = async () => {
    setBusy(true);
    try {
      const deal = await api.openDeal({
        counterpartyEmail: email.trim(),
        accountId,
        domains: domains.split(/[,\s]+/).map((d) => d.trim()).filter(Boolean),
      });
      toaster.create({ type: 'success', title: 'Deal opened' });
      onCreated(deal.id);
    } catch (e) {
      toastError('Could not open the deal', e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel p={4} mb={4}>
      <VStack align="stretch" gap={3}>
        <HStack gap={3} align="end" wrap="wrap">
          <Field.Root flex="1" minW="15rem">
            <Field.Label>Webmaster email</Field.Label>
            <Input
              size="sm"
              placeholder="admin@site.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </Field.Root>
          <Field.Root flex="1" minW="15rem">
            <Field.Label>Site(s)</Field.Label>
            <Input
              size="sm"
              placeholder="site.com, othersite.com"
              value={domains}
              onChange={(e) => setDomains(e.target.value)}
            />
          </Field.Root>
          <Field.Root w="14rem">
            <Field.Label>Send from</Field.Label>
            <NativeSelect.Root size="sm">
              <NativeSelect.Field value={accountId} onChange={(e) => setAccountId(e.target.value)}>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.email}
                  </option>
                ))}
              </NativeSelect.Field>
              <NativeSelect.Indicator />
            </NativeSelect.Root>
          </Field.Root>
          <Button
            size="sm"
            colorPalette="brand"
            loading={busy}
            disabled={!email.trim() || !accountId}
            onClick={submit}
          >
            Open deal
          </Button>
        </HStack>
        <Text fontSize="xs" color="fg.muted">
          The conversation you already have with this address on that mailbox is adopted
          automatically, so your first message continues it rather than opening a thread they would
          have to reconcile by hand. If a deal is already open on it, you'll be taken there. To
          start from one particular reply, use <b>Start a deal</b> on the Responses page.
        </Text>
      </VStack>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// The workspace: conversation centre, deal facts in the rail.
// ---------------------------------------------------------------------------

/**
 * How tall the two panes can be: everything left under them, measured.
 *
 * A `calc(100vh - <constant>)` is wrong the moment anything above changes — the
 * tab strip wraps to two rows on a narrow window, and the stats bar folds away.
 * Measuring the row's own top is the only version that stays right. Undefined
 * below `lg`, where the panes stack and each takes its natural height.
 */
function useAvailableHeight(ref: React.RefObject<HTMLDivElement | null>): number | undefined {
  const [height, setHeight] = useState<number | undefined>(undefined);

  useLayoutEffect(() => {
    const measure = () => {
      const el = ref.current;
      if (!el) return;
      if (window.innerWidth < 992) return setHeight(undefined);
      const top = el.getBoundingClientRect().top + window.scrollY;
      setHeight(Math.max(420, window.innerHeight - top - 24));
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  });

  return height;
}

function DealDetailView({
  dealId,
  tick,
  onBack,
}: {
  dealId: string;
  tick: number;
  onBack: () => void;
}) {
  const workspaceRef = useRef<HTMLDivElement>(null);
  const workspaceHeight = useAvailableHeight(workspaceRef);
  const [detail, setDetail] = useState<DealDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const confirm = useConfirm();

  const load = useCallback(() => {
    api
      .getDeal(dealId)
      .then((d) => {
        setDetail(d);
        setError(null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [dealId]);

  useEffect(load, [load, tick]);

  if (error)
    return (
      <Box pt={4}>
        <Button size="xs" variant="subtle" mb={3} onClick={onBack}>
          ← All deals
        </Button>
        <Text color="red.fg" fontSize="sm">
          {error}
        </Text>
      </Box>
    );
  if (!detail) return null;

  const { deal, accountEmail, placements, threadIds, timeline } = detail;

  const setStatus = async (status: DealStatus) => {
    let closedReason: string | undefined;
    if (status === 'closed') {
      const ok = await confirm({
        title: 'Close this deal?',
        description:
          'Closing releases the hold on its threads — later replies from this webmaster will be extracted normally again.',
        confirmLabel: 'Close deal',
      });
      if (!ok) return;
      closedReason = 'closed by hand';
    }
    try {
      await api.patchDeal(deal.id, { status, ...(closedReason ? { closedReason } : {}) });
      load();
    } catch (e) {
      toastError('Could not change the status', e);
    }
  };

  return (
    // One column that owns the viewport: the header never scrolls away, and the
    // two panes below it scroll independently. The old layout stacked a tall
    // form above a 26rem chat box inside the page scroll — three scrollbars,
    // and the conversation always the smallest thing on screen.
    <Flex direction="column" pt={4} gap={3}>
      <HStack justify="space-between" wrap="wrap" gap={3} flexShrink={0}>
        <HStack gap={3}>
          <Button size="xs" variant="subtle" onClick={onBack}>
            ← All deals
          </Button>
          <VStack align="start" gap={0}>
            <Heading size="md">{deal.counterpartyEmail}</Heading>
            <Text fontSize="xs" color="fg.muted">
              via {accountEmail ?? 'an unknown mailbox'}
            </Text>
          </VStack>
          <Badge colorPalette={STATUS_META[deal.status].palette} variant="subtle">
            {STATUS_META[deal.status].label}
          </Badge>
        </HStack>
        <HStack gap={2}>
          {deal.status === 'negotiation' && (
            <Button size="xs" colorPalette="blue" onClick={() => setStatus('fulfilment')}>
              Move to pay · publish
            </Button>
          )}
          {deal.status === 'fulfilment' && (
            <Button size="xs" colorPalette="green" onClick={() => setStatus('done')}>
              Mark done
            </Button>
          )}
          {(deal.status === 'done' || deal.status === 'closed') && (
            <Button size="xs" variant="subtle" onClick={() => setStatus('negotiation')}>
              Reopen
            </Button>
          )}
          {deal.status !== 'closed' && (
            <Button size="xs" variant="subtle" onClick={() => setStatus('closed')}>
              Close
            </Button>
          )}
        </HStack>
      </HStack>

      <Flex
        ref={workspaceRef}
        direction={{ base: 'column', lg: 'row' }}
        gap={4}
        h={workspaceHeight ? `${workspaceHeight}px` : 'auto'}
        minH="0"
        align="stretch"
      >
        <Conversation
          dealId={deal.id}
          timeline={timeline}
          hasThread={threadIds.length > 0}
          fromEmail={accountEmail}
          toEmail={deal.counterpartyEmail}
          onSent={load}
        />
        <DealRail
          dealId={deal.id}
          note={deal.note}
          closedNotice={
            deal.status === 'done' || deal.status === 'closed'
              ? `This deal is finished, so its threads are no longer held — a new reply from ${deal.counterpartyEmail} will be extracted as a normal price message again.`
              : undefined
          }
          placements={placements}
          onChange={load}
        />
      </Flex>
    </Flex>
  );
}

// ---------------------------------------------------------------------------
// Conversation
// ---------------------------------------------------------------------------

type Side = 'ours' | 'theirs';

/** Consecutive messages from one side, shown as one run of bubbles with a single
 *  caption above and a single timestamp below — the messenger convention. */
interface Run {
  kind: 'run';
  key: string;
  side: Side;
  caption?: string;
  items: DealTimelineItem[];
}
type Row = Run | { kind: 'day'; key: string; at: string };

function itemId(item: DealTimelineItem): string {
  return item.kind === 'sent' ? item.outreach.id : item.reply.id;
}

/** What to write above a run. Ours is captioned only when it was NOT written by
 *  hand — an automated pitch in the middle of a negotiation is worth flagging;
 *  your own replies need no label, the side and colour say it. */
function captionOf(item: DealTimelineItem): string | undefined {
  if (item.kind === 'received') return item.reply.fromAddress;
  if (item.outreach.kind === 'manual') return undefined;
  return item.outreach.kind === 'followup'
    ? `Follow-up #${item.outreach.sequenceNo}`
    : 'Initial pitch';
}

function buildRows(timeline: DealTimelineItem[]): Row[] {
  const rows: Row[] = [];
  let day = '';
  let run: Run | undefined;
  for (const item of timeline) {
    const key = new Date(item.at).toDateString();
    if (key !== day) {
      day = key;
      rows.push({ kind: 'day', key: `day-${key}-${itemId(item)}`, at: item.at });
      run = undefined;
    }
    const side: Side = item.kind === 'sent' ? 'ours' : 'theirs';
    const caption = captionOf(item);
    if (!run || run.side !== side || run.caption !== caption) {
      run = { kind: 'run', key: `run-${itemId(item)}`, side, caption, items: [] };
      rows.push(run);
    }
    run.items.push(item);
  }
  return rows;
}

function Conversation({
  dealId,
  timeline,
  hasThread,
  fromEmail,
  toEmail,
  onSent,
}: {
  dealId: string;
  timeline: DealTimelineItem[];
  /** Whether a thread exists to reply into. Without one there is no subject to
   *  inherit, and the composer asks for one. */
  hasThread: boolean;
  fromEmail?: string;
  toEmail: string;
  onSent: () => void;
}) {
  const [body, setBody] = useState('');
  const [subject, setSubject] = useState('');
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  const rows = useMemo(() => buildRows(timeline), [timeline]);

  const toBottom = useCallback(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  // Follow the conversation down, but only while you are actually at the bottom
  // — scrolling up to re-read the rate card must not be yanked away when a new
  // reply lands or a placement edit reloads the deal. Before paint, so a new
  // message never flashes the top of the thread on its way down.
  useLayoutEffect(() => {
    if (pinned.current) toBottom();
  }, [rows, toBottom]);

  // OPENING THE DEAL LANDS ON THE NEWEST MESSAGE, and that takes a second effect.
  //
  // The pane's height is measured after mount (useAvailableHeight), so on the
  // render that first shows a conversation the box can still be auto-height: it
  // is not scrollable, and the effect above sets scrollTop on an element with
  // nowhere to scroll — a silent no-op. The measured height then arrives, the
  // box becomes scrollable, and it does so at scrollTop 0: you open a
  // negotiation at the FIRST message, months back, with the answer you came to
  // read below the fold.
  //
  // Whether it happens is a RACE — the measurement lands in a layout effect and
  // the scroll in the child's, so which wins depends on how the deal fetch and
  // the commit interleave. It reliably loses on the deployed console and
  // reliably wins against a localhost API, which is exactly the kind of bug that
  // cannot be fixed by reordering the effects.
  //
  // So watch the box itself. Its border box changes when the height lands (and
  // on any window resize), which is exactly when the earlier scroll needs
  // redoing; it does NOT change when the content inside grows, so expanding a
  // long message still leaves you reading its top rather than snapping you to
  // the end of it.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const obs = new ResizeObserver(() => {
      if (pinned.current) toBottom();
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, [toBottom]);

  // A different deal is a different conversation: start it at the bottom even
  // if you had scrolled up in the last one (this pane is reused, not remounted).
  useLayoutEffect(() => {
    pinned.current = true;
    toBottom();
  }, [dealId, toBottom]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (el) pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  };

  // What the reply will actually go out as — derived exactly as the server does
  // it, and shown rather than offered for editing.
  const replyingUnder = useMemo(() => {
    for (let i = timeline.length - 1; i >= 0; i--) {
      const item = timeline[i]!;
      const s = item.kind === 'sent' ? item.outreach.subject : item.reply.subject;
      if (s?.trim()) return /^re:/i.test(s.trim()) ? s.trim() : `Re: ${s.trim()}`;
    }
    return undefined;
  }, [timeline]);

  const send = async () => {
    setBusy(true);
    try {
      await api.sendDealMessage(dealId, {
        body,
        // Only ever sent for the first message on a deal with no conversation.
        ...(hasThread || !subject.trim() ? {} : { subject: subject.trim() }),
      });
      // Cleared only on success — a failed send must not eat what you wrote.
      setBody('');
      pinned.current = true;
      toaster.create({ type: 'success', title: 'Message sent' });
      onSent();
    } catch (e) {
      toastError('Could not send', e);
    } finally {
      setBusy(false);
    }
  };

  const canSend = Boolean(body.trim()) && (hasThread || Boolean(subject.trim()));

  return (
    <Panel
      display="flex"
      flexDirection="column"
      flex="1"
      minW="0"
      minH="0"
      h={{ base: '34rem', lg: 'auto' }}
    >
      <Box ref={scrollRef} onScroll={onScroll} flex="1" minH="0" overflowY="auto" bg="bg.subtle" px={4} py={4}>
        {rows.length === 0 ? (
          <Text fontSize="sm" color="fg.subtle" textAlign="center" pt={8}>
            Nothing yet — your first message will start the thread.
          </Text>
        ) : (
          <VStack align="stretch" gap={3}>
            {rows.map((row) =>
              row.kind === 'day' ? (
                <DayDivider key={row.key} at={row.at} />
              ) : (
                <MessageRun key={row.key} run={row} onRetry={setBody} />
              ),
            )}
          </VStack>
        )}
      </Box>

      <Composer
        body={body}
        setBody={setBody}
        subject={subject}
        setSubject={setSubject}
        needsSubject={!hasThread}
        replyingUnder={replyingUnder}
        fromEmail={fromEmail}
        toEmail={toEmail}
        busy={busy}
        canSend={canSend}
        onSend={send}
      />
    </Panel>
  );
}

function DayDivider({ at }: { at: string }) {
  return (
    <HStack justify="center" py={1}>
      <Text
        fontSize="2xs"
        color="fg.muted"
        bg="bg.panel"
        borderWidth="1px"
        borderColor="border"
        rounded="full"
        px={2.5}
        py={0.5}
        fontWeight="medium"
      >
        {fmtDay(at)}
      </Text>
    </HStack>
  );
}

function MessageRun({ run, onRetry }: { run: Run; onRetry: (body: string) => void }) {
  const ours = run.side === 'ours';
  const last = run.items[run.items.length - 1]!;
  const align = ours ? 'flex-end' : 'flex-start';

  return (
    <VStack align={align} gap={0.5} w="full">
      {run.caption && (
        <Text fontSize="2xs" color="fg.muted" px={2} mb={0.5}>
          {run.caption}
        </Text>
      )}
      {run.items.map((item, i) => (
        <Bubble
          key={itemId(item)}
          item={item}
          side={run.side}
          tail={i === run.items.length - 1}
          onRetry={onRetry}
        />
      ))}
      <HStack gap={1.5} px={2} pt={0.5}>
        <Text fontSize="2xs" color="fg.subtle">
          {fmtTime(last.at)}
        </Text>
        {last.kind === 'sent' && <SendState status={last.outreach.status} />}
      </HStack>
    </VStack>
  );
}

/** The delivery tick under our own last bubble. Nothing at all for a plain sent
 *  message would be quieter, but a reserved-and-never-sent outreach is exactly
 *  the state worth seeing. */
function SendState({ status }: { status: string }) {
  if (status === 'sent')
    return <CheckIcon boxSize={3} color="fg.subtle" aria-label="sent" />;
  if (status === 'failed')
    return (
      <Text fontSize="2xs" color="red.fg" fontWeight="medium">
        not sent
      </Text>
    );
  return (
    <Text fontSize="2xs" color="fg.subtle">
      sending…
    </Text>
  );
}

function Bubble({
  item,
  side,
  tail,
  onRetry,
}: {
  item: DealTimelineItem;
  side: Side;
  /** The last bubble of a run gets the squared corner, so a run reads as one
   *  block with a single point of origin. */
  tail: boolean;
  onRetry: (body: string) => void;
}) {
  const ours = side === 'ours';
  const failed = item.kind === 'sent' && item.outreach.status === 'failed';
  const text = item.kind === 'sent' ? item.outreach.body : item.reply.text;

  return (
    <Box
      maxW={{ base: '88%', md: '76%' }}
      alignSelf={ours ? 'flex-end' : 'flex-start'}
      bg={failed ? 'red.subtle' : ours ? 'brand.solid' : 'bg.panel'}
      color={failed ? 'red.fg' : ours ? 'white' : 'fg'}
      borderWidth="1px"
      borderColor={failed ? 'red.muted' : ours ? 'brand.solid' : 'border'}
      rounded="2xl"
      borderBottomRightRadius={tail && ours ? 'sm' : undefined}
      borderBottomLeftRadius={tail && !ours ? 'sm' : undefined}
      px={3.5}
      py={2.5}
      boxShadow="xs"
    >
      <MessageBody text={text} inverted={ours && !failed} />
      {item.kind === 'received' && <Attachments attachments={item.reply.attachments} compact />}
      {failed && item.kind === 'sent' && (
        <HStack mt={2} gap={2} align="center" wrap="wrap">
          <AlertTriangleIcon boxSize={3.5} />
          <Text fontSize="xs" flex="1" minW="8rem">
            {item.outreach.error ?? 'the send failed'}
          </Text>
          <Button size="2xs" variant="subtle" colorPalette="red" onClick={() => onRetry(item.outreach.body)}>
            Put back in the composer
          </Button>
        </HStack>
      )}
    </Box>
  );
}

/**
 * One message's text: the part they wrote, with the thread they quoted back
 * folded away, and a long body clamped.
 *
 * Both matter for the same reason. Publishers answer with the whole rate card
 * (the imediaone reply is a table of 18 sites) under four rounds of quoted
 * history, and one such message used to fill the entire window.
 */
function MessageBody({ text, inverted }: { text: string; inverted?: boolean }) {
  const { body, quoted } = useMemo(() => splitQuoted(text), [text]);
  const [expanded, setExpanded] = useState(false);
  const [showQuote, setShowQuote] = useState(false);
  const long = body.length > 700;
  const clamped = long && !expanded;

  const linkProps = {
    size: '2xs' as const,
    variant: 'plain' as const,
    px: 0,
    h: 'auto',
    minW: 0,
    color: inverted ? 'whiteAlpha.900' : 'brand.fg',
    _hover: { textDecoration: 'underline' },
  };

  return (
    <Box>
      <Box
        // A mask fades the text itself, so it works on the brand bubble and the
        // white one without either knowing the other's background colour.
        maxH={clamped ? '11rem' : undefined}
        overflow="hidden"
        css={
          clamped
            ? {
                maskImage: 'linear-gradient(to bottom, #000 65%, transparent 100%)',
                WebkitMaskImage: 'linear-gradient(to bottom, #000 65%, transparent 100%)',
              }
            : undefined
        }
      >
        <Text fontSize="sm" whiteSpace="pre-wrap" wordBreak="break-word" lineHeight="1.55">
          {body}
        </Text>
      </Box>

      <HStack gap={3} mt={long || quoted ? 1.5 : 0}>
        {long && (
          <Button {...linkProps} onClick={() => setExpanded((v) => !v)}>
            {expanded ? 'Show less' : 'Show full message'}
          </Button>
        )}
        {quoted && (
          <Button {...linkProps} onClick={() => setShowQuote((v) => !v)} title="Quoted thread">
            {showQuote ? 'Hide quoted' : '··· quoted thread'}
          </Button>
        )}
      </HStack>

      {quoted && showQuote && (
        <Box
          mt={2}
          pl={2.5}
          borderLeftWidth="2px"
          borderColor={inverted ? 'whiteAlpha.500' : 'border'}
          opacity={0.75}
        >
          <Text fontSize="xs" whiteSpace="pre-wrap" wordBreak="break-word">
            {quoted}
          </Text>
        </Box>
      )}
    </Box>
  );
}


function Composer({
  body,
  setBody,
  subject,
  setSubject,
  needsSubject,
  replyingUnder,
  fromEmail,
  toEmail,
  busy,
  canSend,
  onSend,
}: {
  body: string;
  setBody: (v: string) => void;
  subject: string;
  setSubject: (v: string) => void;
  needsSubject: boolean;
  replyingUnder?: string;
  fromEmail?: string;
  toEmail: string;
  busy: boolean;
  canSend: boolean;
  onSend: () => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);

  // Grow with the message, up to a point — a composer that eats the whole pane
  // is as bad as one you can only see three lines of.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [body]);

  return (
    <VStack align="stretch" gap={2} borderTopWidth="1px" borderColor="border" p={3} flexShrink={0}>
      <HStack fontSize="2xs" color="fg.subtle" gap={1.5} wrap="wrap">
        <Text>{fromEmail ?? 'this deal’s mailbox'}</Text>
        <Text>→</Text>
        <Text>{toEmail}</Text>
        {replyingUnder && !needsSubject && (
          <>
            <Text>·</Text>
            {/* Shown, not editable: the headers thread the message either way,
                but changing the line splits the conversation Gmail shows them. */}
            <Text truncate maxW="20rem" title={replyingUnder}>
              {replyingUnder}
            </Text>
          </>
        )}
      </HStack>

      {needsSubject && (
        <Input
          size="sm"
          placeholder="Subject — this deal has no thread yet, so the first message needs one"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
        />
      )}

      <HStack align="end" gap={2}>
        <Textarea
          ref={ref}
          size="sm"
          rows={2}
          resize="none"
          overflowY="auto"
          placeholder="Write a reply…"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && canSend && !busy) {
              e.preventDefault();
              onSend();
            }
          }}
        />
        <Button size="sm" colorPalette="brand" loading={busy} disabled={!canSend} onClick={onSend}>
          <SendIcon boxSize={3.5} /> Send
        </Button>
      </HStack>
      <Text fontSize="2xs" color="fg.subtle">
        ⌘↵ to send.{' '}
        {needsSubject
          ? 'Opens the conversation, and holds it from the first message.'
          : 'Goes out as a reply in the existing thread, and keeps the conversation held.'}
      </Text>
    </VStack>
  );
}

// ---------------------------------------------------------------------------
// The rail: what we know about the deal, at a glance
// ---------------------------------------------------------------------------

function DealRail({
  dealId,
  note,
  closedNotice,
  placements,
  onChange,
}: {
  dealId: string;
  note?: string;
  closedNotice?: string;
  placements: Placement[];
  onChange: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [newDomain, setNewDomain] = useState('');
  const [editing, setEditing] = useState<Placement | null>(null);
  const [draftNote, setDraftNote] = useState(note ?? '');

  useEffect(() => setDraftNote(note ?? ''), [note]);

  const add = async () => {
    if (!newDomain.trim()) return;
    try {
      await api.addDealDomains(dealId, [newDomain.trim()]);
      setNewDomain('');
      setAdding(false);
      onChange();
    } catch (e) {
      toastError('Could not add the site', e);
    }
  };

  const saveNote = async () => {
    if (draftNote === (note ?? '')) return;
    try {
      await api.patchDeal(dealId, { note: draftNote });
      onChange();
    } catch (e) {
      toastError('Could not save the note', e);
    }
  };

  // The open editor must follow the deal as it reloads, or saving one field and
  // then reloading would leave the dialog showing a stale object.
  const open = editing ? (placements.find((p) => p.id === editing.id) ?? null) : null;

  return (
    <Box
      w={{ base: 'full', lg: '20rem' }}
      flexShrink={0}
      overflowY={{ base: 'visible', lg: 'auto' }}
      minH="0"
    >
      <VStack align="stretch" gap={3}>
        {closedNotice && (
          <Box bg="bg.muted" rounded="md" px={3} py={2}>
            <Text fontSize="2xs" color="fg.muted">
              {closedNotice}
            </Text>
          </Box>
        )}

        <Panel p={3}>
          <HStack justify="space-between" mb={placements.length || adding ? 3 : 0}>
            <Heading size="xs" color="fg.muted" textTransform="uppercase" letterSpacing="wider">
              Posts
            </Heading>
            <Button size="2xs" variant="ghost" onClick={() => setAdding((v) => !v)} aria-label="Add a site">
              <PlusIcon boxSize={3.5} />
            </Button>
          </HStack>

          {adding && (
            <HStack gap={2} mb={3}>
              <Input
                size="xs"
                autoFocus
                placeholder="site.com"
                value={newDomain}
                onChange={(e) => setNewDomain(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && add()}
              />
              <Button size="xs" variant="subtle" onClick={add} disabled={!newDomain.trim()}>
                Add
              </Button>
            </HStack>
          )}

          {placements.length === 0 ? (
            <Text fontSize="xs" color="fg.subtle" pt={2}>
              No site on this deal yet. Add the domain you're buying a post on.
            </Text>
          ) : (
            <VStack align="stretch" gap={2}>
              {placements.map((p) => (
                <PlacementSummary key={p.id} placement={p} onOpen={() => setEditing(p)} />
              ))}
            </VStack>
          )}
        </Panel>

        <Panel p={3}>
          <Heading size="xs" color="fg.muted" textTransform="uppercase" letterSpacing="wider" mb={2}>
            Note
          </Heading>
          <Textarea
            size="sm"
            rows={3}
            placeholder="Anything about this negotiation worth remembering."
            value={draftNote}
            onChange={(e) => setDraftNote(e.target.value)}
            onBlur={saveNote}
          />
        </Panel>
      </VStack>

      {open && (
        <PlacementEditor
          key={open.id}
          placement={open}
          onChanged={onChange}
          onClose={() => setEditing(null)}
        />
      )}
    </Box>
  );
}

/** What a post looks like when you are not editing it: the four facts you check
 *  mid-negotiation, and nothing else. */
function PlacementSummary({ placement: p, onOpen }: { placement: Placement; onOpen: () => void }) {
  const paid = Boolean(p.paidAt);
  const live = Boolean(p.liveAt || p.publishedUrl);
  const price = p.agreedPrice?.raw?.trim();
  const content = p.contentText?.trim()
    ? `text · ${p.contentText.trim().length.toLocaleString()} chars`
    : p.contentUrl?.trim()
      ? 'linked doc'
      : 'no text yet';

  return (
    <Box
      as="button"
      textAlign="left"
      w="full"
      borderWidth="1px"
      borderColor="border"
      rounded="lg"
      p={2.5}
      cursor="pointer"
      _hover={{ bg: 'bg.subtle', borderColor: 'brand.emphasized' }}
      onClick={onOpen}
    >
      <HStack justify="space-between" gap={2} mb={1}>
        <Text fontWeight="semibold" fontSize="sm" truncate>
          {p.domain}
        </Text>
        <HStack gap={1} flexShrink={0}>
          {paid && (
            <Badge size="xs" colorPalette="green" variant="subtle">
              paid
            </Badge>
          )}
          {live && (
            <Badge size="xs" colorPalette="blue" variant="subtle">
              live
            </Badge>
          )}
          {!paid && !live && (
            <Badge size="xs" colorPalette="gray" variant="subtle">
              draft
            </Badge>
          )}
        </HStack>
      </HStack>
      <Text fontSize="xs" color={price ? 'fg' : 'fg.subtle'}>
        {price ? `${price}${p.paymentMethod ? ` · ${p.paymentMethod}` : ''}` : 'no price agreed yet'}
      </Text>
      <Text fontSize="2xs" color="fg.muted">
        {content}
        {paid && ` · paid ${fmtShortDate(p.paidAt)}`}
        {p.liveAt && ` · live ${fmtShortDate(p.liveAt)}`}
      </Text>
    </Box>
  );
}

/**
 * The full post record, opened on demand.
 *
 * Every field saves itself when you leave it — there is no Save button to forget,
 * and nothing here is a multi-field transaction. The draft is seeded once and
 * never re-synced from the server while the dialog is open, so a reload provoked
 * by saving one field cannot wipe what you are typing into the next.
 */
function PlacementEditor({
  placement,
  onChanged,
  onClose,
}: {
  placement: Placement;
  onChanged: () => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(placement);
  const saved = useRef<Placement>(placement);
  const [flash, setFlash] = useState(false);
  const confirm = useConfirm();

  const set = <K extends keyof Placement>(key: K, value: Placement[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  const commit = async (key: keyof Placement) => {
    const next = draft[key];
    const before = saved.current[key];
    const same =
      key === 'agreedPrice'
        ? (draft.agreedPrice?.raw ?? '') === (saved.current.agreedPrice?.raw ?? '')
        : (next ?? '') === (before ?? '');
    if (same) return;
    try {
      await api.patchPlacement(placement.id, {
        [key]: key === 'agreedPrice' ? (draft.agreedPrice?.raw ?? '') : ((next as string) ?? ''),
      });
      saved.current = { ...saved.current, [key]: next };
      setFlash(true);
      window.setTimeout(() => setFlash(false), 1200);
      onChanged();
    } catch (e) {
      toastError('Could not save', e);
    }
  };

  const remove = async () => {
    const ok = await confirm({
      title: `Remove ${placement.domain}?`,
      description: 'The post text and any links recorded for this site are deleted.',
      confirmLabel: 'Remove',
      destructive: true,
    });
    if (!ok) return;
    try {
      await api.deletePlacement(placement.id);
      onClose();
      onChanged();
    } catch (e) {
      toastError('Could not remove the site', e);
    }
  };

  return (
    <Dialog.Root open onOpenChange={(e) => !e.open && onClose()} size="lg" placement="center" scrollBehavior="inside">
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content rounded="xl">
            <Dialog.Header>
              <HStack gap={2} flex="1">
                <Dialog.Title>{placement.domain}</Dialog.Title>
                {flash && (
                  <Text fontSize="2xs" color="green.fg">
                    saved
                  </Text>
                )}
              </HStack>
              <Dialog.CloseTrigger asChild>
                <CloseButton size="sm" />
              </Dialog.CloseTrigger>
            </Dialog.Header>

            <Dialog.Body>
              <VStack align="stretch" gap={3}>
                <Field.Root>
                  <Field.Label fontSize="xs">Post text</Field.Label>
                  <Textarea
                    size="sm"
                    rows={6}
                    placeholder="Paste the post here, or leave blank and use a link below."
                    value={draft.contentText ?? ''}
                    onChange={(e) => set('contentText', e.target.value)}
                    onBlur={() => commit('contentText')}
                  />
                </Field.Root>

                <HStack gap={3} wrap="wrap" align="end">
                  <Field.Root flex="1" minW="14rem">
                    <Field.Label fontSize="xs">…or a link to the text</Field.Label>
                    <Input
                      size="sm"
                      placeholder="https://docs.google.com/…"
                      value={draft.contentUrl ?? ''}
                      onChange={(e) => set('contentUrl', e.target.value)}
                      onBlur={() => commit('contentUrl')}
                    />
                  </Field.Root>
                  <Field.Root flex="1" minW="14rem">
                    <Field.Label fontSize="xs">Published post</Field.Label>
                    <Input
                      size="sm"
                      placeholder="https://site.com/the-post"
                      value={draft.publishedUrl ?? ''}
                      onChange={(e) => set('publishedUrl', e.target.value)}
                      onBlur={() => commit('publishedUrl')}
                    />
                  </Field.Root>
                </HStack>

                <HStack gap={3} wrap="wrap" align="end">
                  <Field.Root w="9rem">
                    <Field.Label fontSize="xs">Agreed price</Field.Label>
                    <Input
                      size="sm"
                      placeholder="120 EUR"
                      value={draft.agreedPrice?.raw ?? ''}
                      onChange={(e) => set('agreedPrice', { raw: e.target.value })}
                      onBlur={() => commit('agreedPrice')}
                    />
                  </Field.Root>
                  <Field.Root w="9rem">
                    <Field.Label fontSize="xs">Paid via</Field.Label>
                    <Input
                      size="sm"
                      placeholder="wise / paypal"
                      value={draft.paymentMethod ?? ''}
                      onChange={(e) => set('paymentMethod', e.target.value)}
                      onBlur={() => commit('paymentMethod')}
                    />
                  </Field.Root>
                  <Field.Root w="9rem">
                    <Field.Label fontSize="xs">Paid on</Field.Label>
                    <Input
                      size="sm"
                      type="date"
                      value={toDateInput(draft.paidAt)}
                      onChange={(e) => set('paidAt', fromDateInput(e.target.value))}
                      onBlur={() => commit('paidAt')}
                    />
                  </Field.Root>
                  <Field.Root w="9rem">
                    <Field.Label fontSize="xs">Live on</Field.Label>
                    <Input
                      size="sm"
                      type="date"
                      value={toDateInput(draft.liveAt)}
                      onChange={(e) => set('liveAt', fromDateInput(e.target.value))}
                      onBlur={() => commit('liveAt')}
                    />
                  </Field.Root>
                </HStack>

                <Field.Root>
                  <Field.Label fontSize="xs">Note</Field.Label>
                  <Input
                    size="sm"
                    placeholder="anything worth remembering about this one"
                    value={draft.note ?? ''}
                    onChange={(e) => set('note', e.target.value)}
                    onBlur={() => commit('note')}
                  />
                </Field.Root>

                <Text fontSize="xs" color="fg.subtle">
                  Every field saves when you leave it. Paid and live are independent — set them in
                  whichever order they happen. The agreed price stays here and never touches the
                  price history.
                </Text>
              </VStack>
            </Dialog.Body>

            <Dialog.Footer>
              <Button size="xs" variant="ghost" colorPalette="red" mr="auto" onClick={remove}>
                <TrashIcon boxSize={3.5} /> Remove site
              </Button>
              <Button size="sm" variant="subtle" onClick={onClose}>
                Done
              </Button>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
