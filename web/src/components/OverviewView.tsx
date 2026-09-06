// The screen you land on. It answers "what is the state of the operation right
// now?" — and it is the only place the funnel statistics live.
//
// They used to be a collapsible block reprinted above five different tabs, with
// a remembered collapsed flag because a screen of numbers is noise when you came
// to Targets to find one row. Given a page of their own they need no toggle, and
// the batch filter here no longer skews the counts in the nav rail.

import {
  Box,
  Flex,
  Heading,
  HStack,
  NativeSelect,
  SimpleGrid,
  Stack,
  Text,
} from '@chakra-ui/react';
import { useEffect, useState, type ComponentType } from 'react';
import type { IconProps } from '@chakra-ui/react';
import { api } from '../api';
import type { Account, BatchRow, DealRow, Status } from '../types';
import { Panel } from './Panel';
import { StatCards } from './StatCards';
import { StatusBadge } from './StatusBadge';
import { pct } from './engagement';
import {
  AlertTriangleIcon,
  CheckIcon,
  ClockIcon,
  MegaphoneIcon,
  SendIcon,
} from './icons';

/** A deal is "in flight" until it is done or closed — the two terminal states. */
const OPEN_DEAL_STATUSES = new Set(['negotiation', 'fulfilment']);

function batchLabel(b: BatchRow): string {
  return b.name?.trim() || `batch ${b.id.replace(/^batch_/, '').slice(0, 8)}`;
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <Text
      fontSize="sm"
      fontWeight="semibold"
      color="fg.muted"
      textTransform="uppercase"
      letterSpacing="wider"
    >
      {children}
    </Text>
  );
}

function PanelHeader({
  icon: IconEl,
  title,
  aside,
}: {
  icon: ComponentType<IconProps>;
  title: string;
  aside?: React.ReactNode;
}) {
  return (
    <HStack justify="space-between" gap={3} px={4} pt={3.5} pb={2.5}>
      <HStack gap={2} minW={0}>
        <IconEl boxSize={4} color="fg.muted" />
        <Heading as="h2" size="sm" letterSpacing="tight">
          {title}
        </Heading>
      </HStack>
      {aside}
    </HStack>
  );
}

/** A row of the "quiet" kind: label on the left, value right-aligned. */
function Row({
  label,
  value,
  sub,
  onClick,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  sub?: React.ReactNode;
  onClick?: () => void;
}) {
  return (
    <HStack
      as={onClick ? 'button' : 'div'}
      onClick={onClick}
      w="full"
      textAlign="left"
      align="center"
      gap={3}
      px={4}
      py={2.5}
      borderTopWidth="1px"
      borderColor="border"
      cursor={onClick ? 'pointer' : undefined}
      _hover={onClick ? { bg: 'bg.muted' } : undefined}
    >
      <Box minW={0} flex="1">
        <Text fontSize="sm" fontWeight="medium" truncate>
          {label}
        </Text>
        {sub ? (
          <Text fontSize="xs" color="fg.muted" truncate>
            {sub}
          </Text>
        ) : null}
      </Box>
      <Box flexShrink={0}>{value}</Box>
    </HStack>
  );
}

/** Today's sending capacity, per mailbox. `state` is server-derived, so this is
 *  the same arithmetic the limiter itself uses rather than a second guess. */
function SendingPanel({ accounts, status }: { accounts: Account[]; status: Status | null }) {
  const active = accounts.filter((a) => a.status === 'active');
  const sent = active.reduce((n, a) => n + (a.state?.sentToday ?? 0), 0);
  const capacity = active.reduce((n, a) => n + (a.state?.limit ?? 0), 0);
  const open = status?.windowActive ?? false;
  const w = status?.sendWindow;

  return (
    <Panel>
      <PanelHeader
        icon={SendIcon}
        title="Sending today"
        aside={
          <HStack gap={1.5} flexShrink={0}>
            <ClockIcon boxSize={3.5} color={open ? 'green.fg' : 'fg.subtle'} />
            <Text fontSize="xs" color="fg.muted">
              {w ? `${w.startHour}:00–${w.endHour}:00` : '—'} · {open ? 'open' : 'closed'}
            </Text>
          </HStack>
        }
      />

      <Box px={4} pb={3}>
        <HStack justify="space-between" align="baseline" mb={1.5}>
          <Text fontSize="2xl" fontWeight="bold" lineHeight="1.1">
            {sent}
            <Text as="span" fontSize="md" fontWeight="medium" color="fg.muted">
              {' '}
              / {capacity}
            </Text>
          </Text>
          <Text fontSize="xs" color="fg.muted">
            {pct(sent, capacity)} of today's capacity
          </Text>
        </HStack>
        <Flex h={2} rounded="full" overflow="hidden" bg="bg.muted">
          <Box w={capacity > 0 ? `${Math.min(100, (sent / capacity) * 100)}%` : '0%'} bg="blue.solid" />
        </Flex>
      </Box>

      {accounts.map((a) => {
        const st = a.state;
        return (
          <Row
            key={a.id}
            label={a.email}
            sub={
              a.status !== 'active'
                ? a.lastError || 'paused'
                : st?.warming
                  ? `warming up — ${st.limit} of ${st.rampTarget}/day`
                  : undefined
            }
            value={
              a.status !== 'active' ? (
                <StatusBadge value={a.status} />
              ) : (
                <Text fontSize="sm" fontVariantNumeric="tabular-nums">
                  <Text as="span" fontWeight="semibold">
                    {st?.sentToday ?? 0}
                  </Text>
                  <Text as="span" color="fg.muted">
                    {' '}
                    / {st?.limit ?? a.maxDailyLimit}
                  </Text>
                </Text>
              )
            }
          />
        );
      })}
    </Panel>
  );
}

/** Open negotiations, newest first. Publishers waiting on a human. */
function DealsPanel({ deals, onOpenDeal }: { deals: DealRow[]; onOpenDeal: (id: string) => void }) {
  const open = deals
    .filter((d) => OPEN_DEAL_STATUSES.has(d.status))
    .sort((a, b) => b.openedAt.localeCompare(a.openedAt));

  return (
    <Panel>
      <PanelHeader
        icon={MegaphoneIcon}
        title="Deals in flight"
        aside={
          <Text fontSize="xs" color="fg.muted">
            {open.length} open of {deals.length}
          </Text>
        }
      />
      {open.length === 0 ? (
        <Text fontSize="sm" color="fg.muted" px={4} pb={3.5}>
          No open negotiations.
        </Text>
      ) : (
        open.slice(0, 8).map((d) => (
          <Row
            key={d.id}
            onClick={() => onOpenDeal(d.id)}
            label={d.domains[0] ?? d.counterpartyEmail}
            sub={
              d.placementCount > 0
                ? `${d.placementCount} placement${d.placementCount === 1 ? '' : 's'} · ${d.paidCount} paid · ${d.liveCount} live`
                : d.counterpartyEmail
            }
            value={<StatusBadge value={d.status} />}
          />
        ))
      )}
    </Panel>
  );
}

/** Only things a person can act on, and only when there is something to say.
 *  An empty list here is the good outcome, so it says so rather than vanishing. */
function AttentionPanel({
  accounts,
  status,
  onNavigate,
}: {
  accounts: Account[];
  status: Status | null;
  onNavigate: (tab: string) => void;
}) {
  const paused = accounts.filter((a) => a.status !== 'active');
  const erroring = accounts.filter((a) => a.status === 'active' && a.lastError);
  const disconnected = accounts.filter(
    (a) => a.providerType === 'gmail-api' && !a.oauthConnected,
  );
  const pendingAi = status?.pendingExtraction ?? 0;
  const needsReview = status?.targets.byStatus.needs_review ?? 0;

  const items: { key: string; label: string; sub: string; count: number; tab: string }[] = [
    {
      key: 'oauth',
      label: 'Mailboxes not connected',
      sub: 'a gmail-api account without OAuth cannot send or poll',
      count: disconnected.length,
      tab: 'accounts',
    },
    {
      key: 'paused',
      label: 'Mailboxes paused',
      sub: paused.map((a) => a.email).join(', '),
      count: paused.length,
      tab: 'accounts',
    },
    {
      key: 'error',
      label: 'Mailboxes reporting an error',
      sub: erroring[0]?.lastError ?? '',
      count: erroring.length,
      tab: 'accounts',
    },
    {
      key: 'ai',
      label: 'Replies awaiting extraction',
      sub: 'queued for the model, or failed and retryable',
      count: pendingAi,
      tab: 'responses',
    },
    {
      key: 'review',
      label: 'Targets needing review',
      sub: 'the model could not finish these on its own',
      count: needsReview,
      tab: 'targets',
    },
  ].filter((i) => i.count > 0);

  return (
    <Panel>
      <PanelHeader icon={AlertTriangleIcon} title="Needs attention" />
      {items.length === 0 ? (
        <HStack px={4} pb={3.5} gap={2} color="fg.muted">
          <CheckIcon boxSize={4} color="green.fg" />
          <Text fontSize="sm">Nothing is waiting on you.</Text>
        </HStack>
      ) : (
        items.map((i) => (
          <Row
            key={i.key}
            onClick={() => onNavigate(i.tab)}
            label={i.label}
            sub={i.sub || undefined}
            value={
              <Text fontSize="sm" fontWeight="bold" fontVariantNumeric="tabular-nums">
                {i.count}
              </Text>
            }
          />
        ))
      )}
    </Panel>
  );
}

export function OverviewView({
  tick,
  onNavigate,
  onOpenDeal,
}: {
  /** Bumped by the live stream whenever anything this screen shows changed. */
  tick: number;
  onNavigate: (tab: string) => void;
  onOpenDeal: (id: string) => void;
}) {
  const [status, setStatus] = useState<Status | null>(null);
  const [batches, setBatches] = useState<BatchRow[]>([]);
  const [batch, setBatch] = useState('');
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [deals, setDeals] = useState<DealRow[]>([]);

  // The funnel is the one thing the batch filter applies to — it is a question
  // about one import ("did that list of 400 work?"), while capacity, deals and
  // the attention list are about the whole operation.
  useEffect(() => {
    api.status(batch || undefined).then(setStatus).catch(() => {});
  }, [batch, tick]);

  useEffect(() => {
    api.listBatches().then(setBatches).catch(() => {});
    api.listAccounts().then(setAccounts).catch(() => {});
    api.listDeals().then(setDeals).catch(() => {});
  }, [tick]);

  // A deleted batch must not stay selected in the filter.
  useEffect(() => {
    if (batch && !batches.some((b) => b.id === batch)) setBatch('');
  }, [batches, batch]);

  return (
    <Stack gap={6}>
      <Box>
        <Flex align="center" justify="space-between" gap={3} mb={3} flexWrap="wrap">
          <SectionTitle>
            {(() => {
              const b = batches.find((x) => x.id === batch);
              return b ? `Statistics · ${batchLabel(b)}` : 'Statistics · all batches';
            })()}
          </SectionTitle>
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
            <NativeSelect.Root size="sm" width="48" variant="plain">
              <NativeSelect.Field
                value={batch}
                onChange={(e) => setBatch(e.target.value)}
                fontWeight="medium"
                aria-label="Filter statistics by batch"
              >
                <option value="">all batches</option>
                {batches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {batchLabel(b)}
                  </option>
                ))}
              </NativeSelect.Field>
              <NativeSelect.Indicator />
            </NativeSelect.Root>
          </HStack>
        </Flex>
        <StatCards status={status} />
      </Box>

      <SimpleGrid columns={{ base: 1, lg: 2 }} gap={4} alignItems="start">
        <SendingPanel accounts={accounts} status={status} />
        <Stack gap={4}>
          <DealsPanel deals={deals} onOpenDeal={onOpenDeal} />
          <AttentionPanel accounts={accounts} status={status} onNavigate={onNavigate} />
        </Stack>
      </SimpleGrid>
    </Stack>
  );
}
