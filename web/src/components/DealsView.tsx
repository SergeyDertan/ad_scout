// The Deals workspace: every human-operated negotiation, its correspondence, and
// the posts being bought. Nothing here is inferred — every field is one a person
// typed, and the agreed price is deliberately never fed back into the price
// history (a negotiated figure is not the publisher's standing rate).

import {
  Badge,
  Box,
  Button,
  Field,
  HStack,
  Heading,
  Input,
  NativeSelect,
  Table,
  Text,
  Textarea,
  VStack,
} from '@chakra-ui/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { Account, DealDetail, DealRow, DealStatus, Placement } from '../types';
import { DataPanel } from './DataPanel';
import { Empty } from './Empty';
import { Panel } from './Panel';
import { useConfirm } from './Confirm';
import { useResource } from '../hooks/useResource';
import { toaster, toastError } from './Toaster';
import { MegaphoneIcon, SendIcon, TrashIcon } from './icons';

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
            description="Open one when a publisher agrees to publish — from here, or from a target's thread."
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
          If this webmaster already has an open deal on the same thread, you'll be taken to it rather
          than opening a second one.
        </Text>
      </VStack>
    </Panel>
  );
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

  const { deal, accountEmail, placements, timeline } = detail;

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
    <Box pt={4}>
      <HStack justify="space-between" mb={4} wrap="wrap" gap={3}>
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

      {(deal.status === 'done' || deal.status === 'closed') && (
        <Box mb={4} px={3} py={2} bg="bg.muted" rounded="md">
          <Text fontSize="xs" color="fg.muted">
            This deal is finished, so its threads are no longer held — a new reply from{' '}
            {deal.counterpartyEmail} will be extracted as a normal price message again.
          </Text>
        </Box>
      )}

      <VStack align="stretch" gap={4}>
        <PlacementsPanel dealId={deal.id} placements={placements} onChange={load} />
        <ConversationPanel
          dealId={deal.id}
          timeline={timeline}
          fromEmail={accountEmail}
          onSent={load}
        />
      </VStack>
    </Box>
  );
}

function PlacementsPanel({
  dealId,
  placements,
  onChange,
}: {
  dealId: string;
  placements: Placement[];
  onChange: () => void;
}) {
  const [newDomain, setNewDomain] = useState('');
  const confirm = useConfirm();

  const add = async () => {
    if (!newDomain.trim()) return;
    try {
      await api.addDealDomains(dealId, [newDomain.trim()]);
      setNewDomain('');
      onChange();
    } catch (e) {
      toastError('Could not add the site', e);
    }
  };

  const remove = async (p: Placement) => {
    const ok = await confirm({
      title: `Remove ${p.domain}?`,
      description: 'The post text and any links recorded for this site are deleted.',
      confirmLabel: 'Remove',
      destructive: true,
    });
    if (!ok) return;
    try {
      await api.deletePlacement(p.id);
      onChange();
    } catch (e) {
      toastError('Could not remove the site', e);
    }
  };

  return (
    <Panel p={4}>
      <HStack justify="space-between" mb={3}>
        <Heading size="sm">Posts</Heading>
        <HStack gap={2}>
          <Input
            size="xs"
            w="12rem"
            placeholder="add a site…"
            value={newDomain}
            onChange={(e) => setNewDomain(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && add()}
          />
          <Button size="xs" variant="subtle" onClick={add} disabled={!newDomain.trim()}>
            Add
          </Button>
        </HStack>
      </HStack>

      {placements.length === 0 ? (
        <Text fontSize="sm" color="fg.subtle">
          No site on this deal yet. Add the domain you're buying a post on.
        </Text>
      ) : (
        <VStack align="stretch" gap={4}>
          {placements.map((p) => (
            <PlacementCard key={p.id} placement={p} onChange={onChange} onRemove={() => remove(p)} />
          ))}
        </VStack>
      )}
    </Panel>
  );
}

function PlacementCard({
  placement,
  onChange,
  onRemove,
}: {
  placement: Placement;
  onChange: () => void;
  onRemove: () => void;
}) {
  const [draft, setDraft] = useState(placement);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setDraft(placement);
    setDirty(false);
  }, [placement]);

  const set = <K extends keyof Placement>(key: K, value: Placement[K]) => {
    setDraft((d) => ({ ...d, [key]: value }));
    setDirty(true);
  };

  const save = async () => {
    setBusy(true);
    try {
      await api.patchPlacement(placement.id, {
        contentText: draft.contentText ?? '',
        contentUrl: draft.contentUrl ?? '',
        publishedUrl: draft.publishedUrl ?? '',
        paymentMethod: draft.paymentMethod ?? '',
        note: draft.note ?? '',
        paidAt: draft.paidAt ?? '',
        liveAt: draft.liveAt ?? '',
        agreedPrice: draft.agreedPrice?.raw ?? '',
      });
      setDirty(false);
      onChange();
    } catch (e) {
      toastError('Could not save', e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Box borderWidth="1px" borderColor="border" rounded="lg" p={3}>
      <HStack justify="space-between" mb={3}>
        <HStack gap={2}>
          <Text fontWeight="semibold">{placement.domain}</Text>
          {placement.paidAt && (
            <Badge size="sm" colorPalette="green" variant="subtle">
              paid
            </Badge>
          )}
          {(placement.liveAt || placement.publishedUrl) && (
            <Badge size="sm" colorPalette="blue" variant="subtle">
              live
            </Badge>
          )}
        </HStack>
        <HStack gap={2}>
          {dirty && (
            <Button size="xs" colorPalette="brand" loading={busy} onClick={save}>
              Save
            </Button>
          )}
          <Button size="xs" variant="ghost" colorPalette="red" onClick={onRemove}>
            <TrashIcon boxSize={3.5} />
          </Button>
        </HStack>
      </HStack>

      <VStack align="stretch" gap={3}>
        <Field.Root>
          <Field.Label fontSize="xs">Post text</Field.Label>
          <Textarea
            size="sm"
            rows={4}
            placeholder="Paste the post here, or leave blank and use a link below."
            value={draft.contentText ?? ''}
            onChange={(e) => set('contentText', e.target.value)}
          />
        </Field.Root>

        <HStack gap={3} wrap="wrap" align="end">
          <Field.Root flex="1" minW="16rem">
            <Field.Label fontSize="xs">…or a link to the text</Field.Label>
            <Input
              size="sm"
              placeholder="https://docs.google.com/…"
              value={draft.contentUrl ?? ''}
              onChange={(e) => set('contentUrl', e.target.value)}
            />
          </Field.Root>
          <Field.Root flex="1" minW="16rem">
            <Field.Label fontSize="xs">Published post</Field.Label>
            <Input
              size="sm"
              placeholder="https://site.com/the-post"
              value={draft.publishedUrl ?? ''}
              onChange={(e) => set('publishedUrl', e.target.value)}
            />
          </Field.Root>
        </HStack>

        <HStack gap={3} wrap="wrap" align="end">
          <Field.Root w="10rem">
            <Field.Label fontSize="xs">Agreed price</Field.Label>
            <Input
              size="sm"
              placeholder="120 EUR"
              value={draft.agreedPrice?.raw ?? ''}
              onChange={(e) => set('agreedPrice', { raw: e.target.value })}
            />
          </Field.Root>
          <Field.Root w="10rem">
            <Field.Label fontSize="xs">Paid via</Field.Label>
            <Input
              size="sm"
              placeholder="wise / paypal"
              value={draft.paymentMethod ?? ''}
              onChange={(e) => set('paymentMethod', e.target.value)}
            />
          </Field.Root>
          <Field.Root w="10rem">
            <Field.Label fontSize="xs">Paid on</Field.Label>
            <Input
              size="sm"
              type="date"
              value={toDateInput(draft.paidAt)}
              onChange={(e) => set('paidAt', fromDateInput(e.target.value))}
            />
          </Field.Root>
          <Field.Root w="10rem">
            <Field.Label fontSize="xs">Live on</Field.Label>
            <Input
              size="sm"
              type="date"
              value={toDateInput(draft.liveAt)}
              onChange={(e) => set('liveAt', fromDateInput(e.target.value))}
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
          />
        </Field.Root>
      </VStack>

      <Text fontSize="xs" color="fg.subtle" mt={2}>
        Paid and live are independent — set them in whichever order they happen. The agreed price
        stays here and never touches the price history.
      </Text>
    </Box>
  );
}

/**
 * One message's text, clamped when it is long.
 *
 * Publishers answer with whole rate cards — the imediaone reply is a table of 18
 * sites — and a single one of those fills the entire conversation window, which
 * defeats the point of pinning it to the newest message. Long bodies start
 * collapsed; short ones render whole with no control to click.
 */
function MessageBody({ text, muted }: { text: string; muted?: boolean }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 600;
  return (
    <Box>
      <Box maxH={long && !open ? '8rem' : undefined} overflow="hidden">
        <Text fontSize="sm" whiteSpace="pre-wrap" color={muted ? 'fg.muted' : undefined}>
          {text}
        </Text>
      </Box>
      {long && (
        <Button
          size="xs"
          variant="plain"
          px={0}
          h="auto"
          mt={1}
          colorPalette="brand"
          onClick={() => setOpen((v) => !v)}
        >
          {open ? 'Show less' : 'Show more'}
        </Button>
      )}
    </Box>
  );
}

function ConversationPanel({
  dealId,
  timeline,
  fromEmail,
  onSent,
}: {
  dealId: string;
  timeline: DealDetail['timeline'];
  fromEmail?: string;
  onSent: () => void;
}) {
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Pin the window to the newest message — the one you are replying to. Jumping
  // to the bottom on every change also covers the case that matters most: you
  // send, the timeline reloads, and your own message should be what you see.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [timeline]);

  // Default the subject to a reply on the newest message in the conversation.
  useEffect(() => {
    if (subject) return;
    const last = [...timeline].reverse()[0];
    const prior =
      last?.kind === 'sent' ? last.outreach.subject : last?.kind === 'received' ? last.reply.subject : '';
    if (prior) setSubject(prior.startsWith('Re: ') ? prior : `Re: ${prior}`);
  }, [timeline, subject]);

  const send = async () => {
    setBusy(true);
    try {
      await api.sendDealMessage(dealId, { subject: subject.trim(), body });
      setBody('');
      toaster.create({ type: 'success', title: 'Message sent' });
      onSent();
    } catch (e) {
      toastError('Could not send', e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel p={4}>
      <Heading size="sm" mb={3}>
        Conversation
      </Heading>

      <VStack
        ref={scrollRef}
        align="stretch"
        gap={3}
        mb={4}
        h="26rem"
        overflowY="auto"
        bg="bg.subtle"
        borderWidth="1px"
        borderColor="border"
        rounded="lg"
        p={3}
      >
        {timeline.length === 0 && (
          <Text fontSize="sm" color="fg.subtle">
            Nothing yet — your first message will start the thread.
          </Text>
        )}
        {timeline.map((item) =>
          item.kind === 'sent' ? (
            <Box
              key={item.outreach.id}
              bg="brand.subtle"
              borderWidth="1px"
              borderColor="brand.muted"
              rounded="lg"
              p={3}
              ml={8}
            >
              <HStack mb={1} justify="space-between" gap={2} wrap="wrap">
                <Badge size="sm" colorPalette="brand" variant="subtle">
                  {item.outreach.kind === 'manual'
                    ? 'You'
                    : item.outreach.kind === 'followup'
                      ? `Follow-up #${item.outreach.sequenceNo}`
                      : 'Initial pitch'}
                </Badge>
                <Text fontSize="xs" color="fg.muted">
                  {fmtDate(item.at)}
                </Text>
              </HStack>
              <Text fontSize="sm" fontWeight="medium">
                {item.outreach.subject}
              </Text>
              <Text fontSize="xs" color="fg.muted" mb={1}>
                from {fromEmail ?? 'an unknown mailbox'}
              </Text>
              <MessageBody text={item.outreach.body} muted />
              {item.outreach.status === 'failed' && (
                <Text fontSize="xs" color="red.fg" mt={1}>
                  Failed to send: {item.outreach.error}
                </Text>
              )}
            </Box>
          ) : (
            <Box key={item.reply.id} borderWidth="1px" borderColor="border" rounded="lg" p={3} mr={8}>
              <HStack mb={1} justify="space-between" gap={2} wrap="wrap">
                <Badge size="sm" variant="subtle">
                  {item.reply.fromAddress}
                </Badge>
                <Text fontSize="xs" color="fg.muted">
                  {fmtDate(item.at)}
                </Text>
              </HStack>
              <MessageBody text={item.reply.text} />
            </Box>
          ),
        )}
      </VStack>

      <VStack align="stretch" gap={2} borderTopWidth="1px" borderColor="border" pt={3}>
        <Field.Root>
          <Field.Label fontSize="xs">Subject</Field.Label>
          <Input size="sm" value={subject} onChange={(e) => setSubject(e.target.value)} />
        </Field.Root>
        <Textarea
          size="sm"
          rows={5}
          placeholder="Write your message…"
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
        <HStack justify="space-between">
          <Text fontSize="xs" color="fg.subtle">
            Sends from {fromEmail ?? 'this deal\u2019s mailbox'} as a reply in the existing thread,
            and keeps the conversation held.
          </Text>
          <Button
            size="sm"
            colorPalette="brand"
            loading={busy}
            disabled={!subject.trim() || !body.trim()}
            onClick={send}
          >
            <SendIcon boxSize={3.5} /> Send
          </Button>
        </HStack>
      </VStack>
    </Panel>
  );
}
