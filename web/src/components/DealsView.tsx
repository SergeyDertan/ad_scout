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
  Checkbox,
  CloseButton,
  Dialog,
  Field,
  Flex,
  HStack,
  Heading,
  Input,
  Link,
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
import {
  AlertTriangleIcon,
  CheckIcon,
  ChevronDownIcon,
  ExternalLinkIcon,
  MegaphoneIcon,
  PencilIcon,
  PlusIcon,
  SearchIcon,
  SendIcon,
  TrashIcon,
} from './icons';

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

/** Today, as the stamp a ticked box writes. Midday UTC for the same reason
 *  fromDateInput uses it: the date must read the same either side of midnight
 *  in every timezone we might look at it from. */
function todayStamp(): string {
  return fromDateInput(new Date().toISOString().slice(0, 10))!;
}

/**
 * An absolute, safe href for a link somebody typed into a text box.
 *
 * These fields hold whatever was pasted — `site.com/the-post` at least as often
 * as a full URL — and a bare domain in an `href` is a RELATIVE path, so clicking
 * it would navigate inside the app instead of out to the post. Anything already
 * carrying a scheme that is not http(s) (`javascript:`, `data:`) gets no link at
 * all; it is text we can show but must never hand to the browser.
 */
function safeHref(url: string): string | undefined {
  const raw = url.trim();
  if (!raw) return undefined;
  if (/^https?:\/\//i.test(raw)) return raw;
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return undefined;
  return `https://${raw}`;
}

/** Google's own answer to "is this page indexed": a `site:` search for the exact
 *  URL. Empty when there is no published post to ask about yet. */
function indexCheckUrl(publishedUrl?: string): string | undefined {
  const bare = (publishedUrl ?? '').trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  if (!bare) return undefined;
  return `https://www.google.com/search?q=${encodeURIComponent(`site:${bare}`)}`;
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
  const [openId, setOpenId] = useState<string | null>(null);
  const [draftNote, setDraftNote] = useState(note ?? '');

  useEffect(() => setDraftNote(note ?? ''), [note]);

  // One post is not a choice — show it open, which is the whole deal on one
  // screen with nothing to click. Seeded once per deal (and once more when the
  // first site is added to an empty one), so collapsing it keeps it collapsed
  // through every reload the live stream provokes.
  const seededFor = useRef<string | null>(null);
  useEffect(() => {
    if (seededFor.current === dealId || placements.length === 0) return;
    seededFor.current = dealId;
    setOpenId(placements.length === 1 ? placements[0]!.id : null);
  }, [dealId, placements]);

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

  // An expanded post carries the fields the dialog used to hold, and 20rem is not
  // enough room for them — a price, a date and a URL end up one per line. The
  // rail borrows the width back from the conversation only while a post is open,
  // and gives it straight back when you collapse it.
  const expandedAny = placements.some((p) => p.id === openId);

  return (
    <Box
      w={{ base: 'full', lg: expandedAny ? '28rem' : '20rem' }}
      transition="width 150ms ease"
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
                <PlacementCard
                  key={p.id}
                  placement={p}
                  expanded={p.id === openId}
                  // One at a time: two open post records in a 28rem column is a
                  // scroll, and you are only ever working on one of them.
                  onToggle={() => setOpenId((cur) => (cur === p.id ? null : p.id))}
                  onChanged={onChange}
                />
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
    </Box>
  );
}


// ---------------------------------------------------------------------------
// One post, in the rail
// ---------------------------------------------------------------------------

/**
 * A post record: a summary line always, the full thing when you open it.
 *
 * This used to be a summary that opened a dialog. Fulfilment is not a form you
 * fill in once — it is three facts (paid, published, indexed) that arrive days
 * apart and get checked off one at a time, and putting them behind a modal meant
 * two clicks and a lost view of the conversation for every one of them. Only the
 * post text still opens a window, because it is the one field you touch once and
 * the one that genuinely needs the room.
 *
 * Every field saves itself when you leave it, and a checkbox the moment you tick
 * it — there is no Save button to forget. The draft is seeded once and is NOT
 * re-synced from the server while the card is open, so the reload that each save
 * provokes cannot wipe what you are typing into the next field; a collapsed card
 * takes the server's version freely, since nothing is being typed into it.
 */
function PlacementCard({
  placement,
  expanded,
  onToggle,
  onChanged,
}: {
  placement: Placement;
  expanded: boolean;
  onToggle: () => void;
  onChanged: () => void;
}) {
  const [draft, setDraft] = useState<Placement>(placement);
  const saved = useRef<Placement>(placement);
  const [flash, setFlash] = useState(false);
  const [textOpen, setTextOpen] = useState(false);
  const confirm = useConfirm();

  useEffect(() => {
    if (expanded) return;
    saved.current = placement;
    setDraft(placement);
  }, [expanded, placement]);

  const set = <K extends keyof Placement>(key: K, value: Placement[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  /**
   * Persist one field. The value is passed rather than read from `draft` so a
   * control with no blur to wait for — a checkbox, a date picker — can set and
   * save in the same breath without reading its own stale state.
   */
  const save = async <K extends keyof Placement>(key: K, value: Placement[K]): Promise<void> => {
    const same =
      key === 'agreedPrice'
        ? ((value as Placement['agreedPrice'])?.raw ?? '') === (saved.current.agreedPrice?.raw ?? '')
        : (value ?? '') === (saved.current[key] ?? '');
    if (same) return;
    try {
      await api.patchPlacement(placement.id, {
        // The server takes '' as "clear this", so an absent value must not be
        // dropped from the body — that would read as "leave it alone".
        [key]:
          key === 'agreedPrice'
            ? ((value as Placement['agreedPrice'])?.raw ?? '')
            : ((value as string | undefined) ?? ''),
      });
      saved.current = { ...saved.current, [key]: value };
      setFlash(true);
      window.setTimeout(() => setFlash(false), 1200);
      onChanged();
    } catch (e) {
      toastError('Could not save', e);
    }
  };

  /** Tick or untick a date-backed flag. Ticking stamps today; the date input
   *  beside it is there to correct the day when it was not today. */
  const setFlag = (key: 'paidAt' | 'liveAt' | 'indexedAt', on: boolean): void => {
    const at = on ? todayStamp() : undefined;
    set(key, at);
    void save(key, at);
  };
  const setFlagDate = (key: 'paidAt' | 'liveAt' | 'indexedAt', iso?: string): void => {
    set(key, iso);
    void save(key, iso);
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
      onChanged();
    } catch (e) {
      toastError('Could not remove the site', e);
    }
  };

  const closeText = () => {
    void save('contentText', draft.contentText);
    setTextOpen(false);
  };

  const paid = Boolean(draft.paidAt);
  // Strictly the date, not "there is a URL". The Published box is right here
  // showing its own state, and a badge that disagreed with the box beside it
  // would be the UI arguing with itself — which it did, for any post whose link
  // was pasted before the day was recorded.
  const live = Boolean(draft.liveAt);
  const indexed = Boolean(draft.indexedAt);
  const price = draft.agreedPrice?.raw?.trim();
  const chars = draft.contentText?.trim().length ?? 0;
  const checkUrl = indexCheckUrl(draft.publishedUrl);

  return (
    <Box borderWidth="1px" borderColor={expanded ? 'brand.emphasized' : 'border'} rounded="lg">
      {/* The summary line, and the control that opens the record. A button so it
          answers to the keyboard and announces its own state. */}
      <Box
        as="button"
        textAlign="left"
        w="full"
        p={2.5}
        cursor="pointer"
        rounded="lg"
        aria-expanded={expanded}
        _hover={{ bg: 'bg.subtle' }}
        onClick={onToggle}
      >
        <HStack justify="space-between" gap={2} mb={1}>
          <HStack gap={1.5} minW="0">
            <ChevronDownIcon
              boxSize={3.5}
              color="fg.muted"
              flexShrink={0}
              transform={expanded ? 'rotate(0deg)' : 'rotate(-90deg)'}
              transition="transform 120ms ease"
            />
            <Text fontWeight="semibold" fontSize="sm" truncate>
              {draft.domain}
            </Text>
          </HStack>
          <HStack gap={1} flexShrink={0}>
            {flash && (
              <Text fontSize="2xs" color="green.fg">
                saved
              </Text>
            )}
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
            {indexed && (
              <Badge size="xs" colorPalette="purple" variant="subtle">
                indexed
              </Badge>
            )}
            {!paid && !live && !indexed && (
              <Badge size="xs" colorPalette="gray" variant="subtle">
                draft
              </Badge>
            )}
          </HStack>
        </HStack>
        <Text fontSize="xs" color={price ? 'fg' : 'fg.subtle'}>
          {price
            ? `${price}${draft.paymentMethod ? ` · ${draft.paymentMethod}` : ''}`
            : 'no price agreed yet'}
        </Text>
        {!expanded && (
          <Text fontSize="2xs" color="fg.muted">
            {chars ? `text · ${chars.toLocaleString()} chars` : draft.contentUrl?.trim() ? 'linked doc' : 'no text yet'}
            {paid && ` · paid ${fmtShortDate(draft.paidAt)}`}
            {draft.liveAt && ` · live ${fmtShortDate(draft.liveAt)}`}
            {indexed && ` · indexed ${fmtShortDate(draft.indexedAt)}`}
          </Text>
        )}
      </Box>

      {expanded && (
        <VStack align="stretch" gap={3} px={2.5} pb={2.5}>
          {/* Fulfilment: three independent facts, in the order they normally
              happen — but any of them can be true first. */}
          <VStack align="stretch" gap={1.5} borderTopWidth="1px" borderColor="border" pt={2.5}>
            <FlagRow
              label="Paid"
              at={draft.paidAt}
              onToggle={(on) => setFlag('paidAt', on)}
              onDate={(iso) => setFlagDate('paidAt', iso)}
            />
            <FlagRow
              label="Published"
              at={draft.liveAt}
              onToggle={(on) => setFlag('liveAt', on)}
              onDate={(iso) => setFlagDate('liveAt', iso)}
            />
            <HStack justify="space-between" gap={2}>
              <Checkbox.Root
                size="sm"
                checked={indexed}
                onCheckedChange={(d) => setFlag('indexedAt', Boolean(d.checked))}
              >
                <Checkbox.HiddenInput aria-label="Indexed" />
                <Checkbox.Control />
                <Checkbox.Label fontSize="xs">
                  Indexed
                  {indexed && (
                    <Text as="span" color="fg.subtle" ml={1.5}>
                      {fmtShortDate(draft.indexedAt)}
                    </Text>
                  )}
                </Checkbox.Label>
              </Checkbox.Root>
              {/* Google's own answer, rather than ours. Nothing to check against
                  until there is a published URL to ask about. */}
              <Button
                size="2xs"
                variant="subtle"
                asChild={Boolean(checkUrl)}
                disabled={!checkUrl}
                title={checkUrl ? 'Search Google for this exact page' : 'Add the published post link first'}
              >
                {checkUrl ? (
                  <a href={checkUrl} target="_blank" rel="noreferrer noopener">
                    <SearchIcon boxSize={3} /> Check index
                  </a>
                ) : (
                  <span>
                    <SearchIcon boxSize={3} /> Check index
                  </span>
                )}
              </Button>
            </HStack>
          </VStack>

          <HStack gap={3} align="end">
            <Field.Root flex="1">
              <Field.Label fontSize="xs">Agreed price</Field.Label>
              <Input
                size="sm"
                placeholder="120 EUR"
                value={draft.agreedPrice?.raw ?? ''}
                onChange={(e) => set('agreedPrice', { raw: e.target.value })}
                onBlur={() => void save('agreedPrice', draft.agreedPrice)}
              />
            </Field.Root>
            <Field.Root flex="1">
              <Field.Label fontSize="xs">Paid via</Field.Label>
              <Input
                size="sm"
                placeholder="wise / paypal"
                value={draft.paymentMethod ?? ''}
                onChange={(e) => set('paymentMethod', e.target.value)}
                onBlur={() => void save('paymentMethod', draft.paymentMethod)}
              />
            </Field.Root>
          </HStack>

          <LinkField
            label="Published post"
            placeholder="https://site.com/the-post"
            value={draft.publishedUrl ?? ''}
            onChange={(v) => set('publishedUrl', v)}
            onCommit={(v) => void save('publishedUrl', v || undefined)}
          />

          <Field.Root>
            <Field.Label fontSize="xs">Post text</Field.Label>
            <HStack gap={2} w="full">
              <Button size="xs" variant="subtle" onClick={() => setTextOpen(true)}>
                <PencilIcon boxSize={3} /> {chars ? 'Edit text' : 'Write the post'}
              </Button>
              <Text fontSize="xs" color="fg.subtle" truncate>
                {chars ? `${chars.toLocaleString()} chars` : 'nothing written yet'}
              </Text>
            </HStack>
          </Field.Root>

          <LinkField
            label="…or a link to the text"
            placeholder="https://docs.google.com/…"
            value={draft.contentUrl ?? ''}
            onChange={(v) => set('contentUrl', v)}
            onCommit={(v) => void save('contentUrl', v || undefined)}
          />

          <Field.Root>
            <Field.Label fontSize="xs">Note</Field.Label>
            <Input
              size="sm"
              placeholder="anything worth remembering about this one"
              value={draft.note ?? ''}
              onChange={(e) => set('note', e.target.value)}
              onBlur={() => void save('note', draft.note)}
            />
          </Field.Root>

          <HStack justify="space-between" pt={1}>
            <Text fontSize="2xs" color="fg.subtle">
              Saves as you go. The agreed price stays here and never touches the price history.
            </Text>
            <Button
              size="2xs"
              variant="ghost"
              colorPalette="red"
              flexShrink={0}
              aria-label={`Remove ${draft.domain}`}
              onClick={remove}
            >
              <TrashIcon boxSize={3.5} />
            </Button>
          </HStack>
        </VStack>
      )}

      {textOpen && (
        <PostTextDialog
          domain={draft.domain}
          value={draft.contentText ?? ''}
          onChange={(v) => set('contentText', v)}
          onClose={closeText}
        />
      )}
    </Box>
  );
}

/** A checkbox backed by a date: ticked means the date is set. The date input
 *  appears only once it is, because an empty date input next to an unticked box
 *  is two controls asking the same question. */
function FlagRow({
  label,
  at,
  onToggle,
  onDate,
}: {
  label: string;
  at?: string;
  onToggle: (on: boolean) => void;
  onDate: (iso?: string) => void;
}) {
  return (
    <HStack justify="space-between" gap={2}>
      <Checkbox.Root size="sm" checked={Boolean(at)} onCheckedChange={(d) => onToggle(Boolean(d.checked))}>
        <Checkbox.HiddenInput aria-label={label} />
        <Checkbox.Control />
        <Checkbox.Label fontSize="xs">{label}</Checkbox.Label>
      </Checkbox.Root>
      {at && (
        <Input
          size="xs"
          type="date"
          w="9rem"
          aria-label={`${label} on`}
          value={toDateInput(at)}
          // A native date input only reports a whole valid date, so there is no
          // half-typed state to wait out — save on change, not on blur.
          onChange={(e) => onDate(fromDateInput(e.target.value))}
        />
      )}
    </HStack>
  );
}

/**
 * A URL field that is a link once it holds one.
 *
 * A published post is something you open far more often than you edit, and an
 * input box you have to select-and-copy out of is the wrong shape for that. Set
 * ⇒ an anchor plus a pencil; empty ⇒ straight back to the input, since there is
 * nothing to click and hiding the field behind a button would be a step for no
 * reason.
 */
function LinkField({
  label,
  placeholder,
  value,
  onChange,
  onCommit,
}: {
  label: string;
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
  onCommit: (v: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const href = safeHref(value);

  return (
    <Field.Root>
      <Field.Label fontSize="xs">{label}</Field.Label>
      {editing || !value.trim() ? (
        <Input
          size="sm"
          autoFocus={editing}
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
          onBlur={() => {
            setEditing(false);
            onCommit(value);
          }}
        />
      ) : (
        <HStack gap={1} w="full" minW="0">
          {href ? (
            <Link
              href={href}
              target="_blank"
              rel="noreferrer noopener"
              fontSize="sm"
              flex="1"
              minW="0"
              gap={1}
            >
              {/* The URL truncates; the icon must not, or a long link eats its
                  own "opens elsewhere" cue. */}
              <Text as="span" truncate minW="0">
                {value.trim()}
              </Text>
              <ExternalLinkIcon boxSize={3} flexShrink={0} />
            </Link>
          ) : (
            // Text we can show but must not hand to the browser — see safeHref.
            <Text fontSize="sm" color="fg.muted" flex="1" minW="0" truncate title="not a link we can open">
              {value.trim()}
            </Text>
          )}
          <Button
            size="2xs"
            variant="ghost"
            flexShrink={0}
            aria-label={`Edit ${label}`}
            onClick={() => setEditing(true)}
          >
            <PencilIcon boxSize={3} />
          </Button>
        </HStack>
      )}
    </Field.Root>
  );
}

/** The one field still worth a window. It is written once, it is long, and it is
 *  the only thing here that a 28rem rail genuinely cannot hold. */
function PostTextDialog({
  domain,
  value,
  onChange,
  onClose,
}: {
  domain: string;
  value: string;
  onChange: (v: string) => void;
  onClose: () => void;
}) {
  return (
    <Dialog.Root
      open
      onOpenChange={(e) => !e.open && onClose()}
      size="xl"
      placement="center"
      scrollBehavior="inside"
    >
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content rounded="xl">
            <Dialog.Header>
              <Dialog.Title>Post text · {domain}</Dialog.Title>
              <Dialog.CloseTrigger asChild>
                <CloseButton size="sm" />
              </Dialog.CloseTrigger>
            </Dialog.Header>
            <Dialog.Body>
              <Textarea
                autoFocus
                size="sm"
                rows={18}
                placeholder="Paste the post here, or close this and give a link to the text instead."
                value={value}
                onChange={(e) => onChange(e.target.value)}
              />
            </Dialog.Body>
            <Dialog.Footer>
              {/* Saved on close, not on blur: Escape and the X never blur the
                  textarea, and losing a pasted post to a stray keypress is not a
                  trade worth making for one fewer write. */}
              <Text fontSize="xs" color="fg.muted" mr="auto">
                {value.trim().length.toLocaleString()} chars · saved when you close this
              </Text>
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
