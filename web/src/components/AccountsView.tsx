import { Badge, Box, Button, Flex, HStack, Input, SimpleGrid, Stack, Table, Text } from '@chakra-ui/react';
import { Fragment, useCallback, useState } from 'react';
import { api } from '../api';
import { useIsManager } from '../role';
import type { Account, AccountSendState, AccountStats } from '../types';
import { StatusBadge } from './StatusBadge';
import { AddAccountForm } from './AddAccountForm';
import { DataPanel } from './DataPanel';
import { Empty } from './Empty';
import { useConfirm } from './Confirm';
import { toaster, toastError } from './Toaster';
import { useResource } from '../hooks/useResource';
import { ChevronDownIcon, ClockIcon, PauseIcon, PlayIcon, PlusIcon, TrashIcon, UsersIcon } from './icons';
import { EngagementBar, EngagementDetailRows, OutcomeRows, pct } from './engagement';

function fmtGap(ms: number): string {
  if (ms < 90_000) return `${Math.round(ms / 1000)}s`;
  return `${Math.round(ms / 60_000)} min`;
}

/** Slim usage bar: `used` of `total`, tinted amber past 80%. */
function UsageBar({ used, total }: { used: number; total: number }) {
  const filled = total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0;
  return (
    <Box mt={1} h="4px" w="100%" maxW="120px" bg="bg.muted" borderRadius="full" overflow="hidden">
      <Box h="100%" w={`${filled}%`} bg={filled >= 80 ? 'orange.solid' : 'brand.solid'} />
    </Box>
  );
}

/** "Today" cell: sent-so-far, the cap it's counting against, and how much is left. */
function TodayCell({ s }: { s: AccountSendState }) {
  return (
    <Box>
      <Text fontWeight="semibold">
        {s.sentToday} <Text as="span" color="fg.muted" fontWeight="normal">sent today</Text>
      </Text>
      <UsageBar used={s.sentToday} total={s.limit} />
      <Text color="fg.muted" fontSize="xs" mt={1}>
        {s.remaining} of {s.limit} left today
      </Text>
    </Box>
  );
}

/** "Rate" cell: the live drip pacing + how many will realistically go out today. */
function RateCell({ s, active }: { s: AccountSendState; active: boolean }) {
  if (!s.windowActive) {
    return <Text color="fg.muted" fontSize="sm">window closed</Text>;
  }
  if (!active) {
    return <Text color="fg.muted" fontSize="sm">paused</Text>;
  }
  if (s.remaining <= 0) {
    return <Badge colorPalette="green" size="sm">daily limit reached</Badge>;
  }
  const short = s.projectedToday < s.sentToday + s.remaining;
  return (
    <Box>
      {s.gapMs != null && (
        <Text fontWeight="medium" fontSize="sm">
          ≈1 / {fmtGap(s.gapMs)}
          {s.perHour != null && (
            <Text as="span" color="fg.muted" fontWeight="normal"> · {s.perHour}/h</Text>
          )}
        </Text>
      )}
      <Text color={short ? 'orange.fg' : 'fg.muted'} fontSize="xs" mt={1}>
        {short ? `only ~${s.projectedToday} will send today` : `on track for ${s.projectedToday} today`}
      </Text>
    </Box>
  );
}

/** Explains the daily-limit cap in words: warming ramp, override, or maxed. */
function LimitHint({ s }: { s: AccountSendState }) {
  if (s.overridden) {
    return (
      <Text color="fg.muted" fontSize="xs" mt={1}>
        manual override · {s.limit}/day
      </Text>
    );
  }
  if (s.warming) {
    return (
      <HStack gap={1.5} mt={1}>
        <Badge colorPalette="orange" size="sm">warming</Badge>
        <Text color="fg.muted" fontSize="xs">
          day {s.ageDays}: {s.limit} → {s.rampTarget}
        </Text>
      </HStack>
    );
  }
  return (
    <Text color="fg.muted" fontSize="xs" mt={1}>
      at max · {s.limit}/day
    </Text>
  );
}

function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

/** "Results" cell: what this mailbox's outreach has actually produced, for its
 *  whole life — how many sites it opened, how many wrote back, how many bounced.
 *  Click to expand the full funnel below the row. */
function ResultsCell({ s, open }: { s: AccountStats; open: boolean }) {
  const eng = s.engagement;
  if (s.targetsContacted === 0) {
    return (
      <Text color="fg.muted" fontSize="sm">
        {s.messagesSent > 0 ? `${s.messagesSent} sent, no targets of its own` : 'nothing sent yet'}
      </Text>
    );
  }
  return (
    <Box>
      <HStack gap={1} whiteSpace="nowrap">
        <Text fontWeight="semibold">
          {s.targetsContacted} <Text as="span" color="fg.muted" fontWeight="normal">contacted</Text>
        </Text>
        <ChevronDownIcon
          boxSize={3.5}
          color="fg.muted"
          transform={open ? 'rotate(0deg)' : 'rotate(-90deg)'}
          transition="transform 0.15s"
        />
      </HStack>
      <Box mt={1} maxW="120px">
        <EngagementBar eng={eng} h="4px" />
      </Box>
      <HStack gap={1.5} mt={1} fontSize="xs" color="fg.muted" whiteSpace="nowrap">
        <Text>
          <Text as="span" fontWeight="semibold" color="fg">
            {eng.replied}
          </Text>{' '}
          replied · {pct(eng.replied, s.targetsContacted - eng.bounced)}
        </Text>
        {eng.bounced > 0 && (
          <>
            <Text>·</Text>
            <Text color="red.fg">
              {eng.bounced} bounced · {pct(eng.bounced, s.targetsContacted)}
            </Text>
          </>
        )}
      </HStack>
    </Box>
  );
}

/** One labelled number in the volume column. */
function VolumeRow({ label, value, desc }: { label: string; value: string | number; desc?: string }) {
  return (
    <HStack align="baseline" py={1.5} gap={2}>
      <Text fontSize="sm" fontWeight="medium" minW="9.5rem">
        {label}
      </Text>
      <Text fontSize="xs" color="fg.muted" flex="1" minW={0} display={{ base: 'none', sm: 'block' }}>
        {desc}
      </Text>
      <Text fontSize="sm" fontWeight="semibold" textAlign="right" minW="4rem">
        {value}
      </Text>
    </HStack>
  );
}

/**
 * The expanded per-account panel. Two columns, because they answer two different
 * questions and are counted on two different keys:
 *
 *   Volume — every message this mailbox put on the wire, follow-ups it took over
 *   for other mailboxes included. This is the deliverability side.
 *
 *   Results — the funnel over the targets this mailbox OWNS (the ones whose
 *   opening message it sent). Ownership is exclusive, so these columns across all
 *   accounts add back up to the totals at the top of the page.
 */
function AccountStatsDetail({ s }: { s: AccountStats }) {
  const eng = s.engagement;
  return (
    // The row this sits in is as wide as the (scrollable) table, so cap the
    // panel: a breakdown you have to scroll sideways to read is no breakdown.
    // Table cells inherit `white-space: nowrap` from Chakra's recipe, which the
    // explanatory text here needs undone or it runs straight over the counts.
    <Box px={2} py={2} maxW="1040px" whiteSpace="normal">
      <SimpleGrid columns={{ base: 1, xl: 2 }} gap={{ base: 6, xl: 8 }}>
        <Box>
          <Text fontSize="xs" color="fg.muted" fontWeight="medium" textTransform="uppercase" letterSpacing="wider" mb={1}>
            Messages sent ({s.messagesSent})
          </Text>
          <Stack gap={0}>
            <VolumeRow label="Opening messages" value={s.initials} desc="First contact with a new site." />
            <VolumeRow label="Follow-ups" value={s.followUps} desc="Chasers on a conversation that went quiet." />
            {s.manual > 0 && (
              <VolumeRow label="Deal messages" value={s.manual} desc="Written by hand from the Deals tab." />
            )}
            {s.reserved > 0 && (
              <VolumeRow label="In flight" value={s.reserved} desc="Drafted and holding a slot, not yet away." />
            )}
            {s.failed > 0 && (
              <VolumeRow label="Failed sends" value={s.failed} desc="Errored out — nothing was delivered." />
            )}
            <VolumeRow label="Last sent" value={s.lastSentAt ? fmtDateTime(s.lastSentAt) : '—'} />
          </Stack>
        </Box>

        <Box>
          <Text fontSize="xs" color="fg.muted" fontWeight="medium" textTransform="uppercase" letterSpacing="wider" mb={1}>
            Outreach results ({s.targetsContacted} contacted)
          </Text>
          <Stack gap={0}>
            <EngagementDetailRows eng={eng} total={s.targetsContacted} />
            {eng.replied > 0 && (
              <Box mt={2} pt={2} borderTopWidth="1px" borderColor="border">
                <OutcomeRows outcomes={s.outcomes} replied={eng.replied} />
              </Box>
            )}
          </Stack>
        </Box>
      </SimpleGrid>
    </Box>
  );
}

export function AccountsView({ tick }: { tick: number }) {
  // A manager reads this page but cannot change anything on it.
  const isManager = useIsManager();
  const [adding, setAdding] = useState(false);
  // Which accounts have their statistics panel open. A Set, not a single id:
  // comparing two mailboxes side by side is the whole point of the breakdown.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const confirm = useConfirm();
  const {
    rows: accounts,
    loading,
    error,
    reload: load,
  } = useResource(useCallback(() => api.listAccounts(), []), tick);

  // Only `active` accounts send. Anything else (paused / cooldown)
  // gets a one-click "Activate"; an active account gets "Pause".
  const toggleExpanded = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  const setActive = async (a: Account, active: boolean) => {
    try {
      if (active) await api.resumeAccount(a.id);
      else await api.pauseAccount(a.id);
      toaster.create({
        type: 'success',
        title: active ? `${a.senderName} activated` : `${a.senderName} paused`,
      });
      load();
    } catch (e) {
      toastError('Could not update account', e);
    }
  };

  const remove = async (a: Account) => {
    const ok = await confirm({
      title: 'Delete account?',
      description: (
        <>
          Delete <b>{a.email}</b>? Queued and sent history is kept.
        </>
      ),
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!ok) return;
    try {
      await api.deleteAccount(a.id);
      toaster.create({ type: 'success', title: `Deleted ${a.email}` });
      load();
    } catch (e) {
      toastError('Could not delete account', e);
    }
  };

  const connectGmail = async (a: Account) => {
    try {
      const { authUrl } = await api.getOAuthUrl(a.id);
      window.open(authUrl, '_blank', 'noopener,noreferrer');
      toaster.create({
        type: 'info',
        title: 'Opening Gmail authorization…',
        description: 'Reload accounts after completing the Google sign-in.',
      });
    } catch (e) {
      toastError('Could not get OAuth URL', e);
    }
  };

  const switchToOAuth = async (a: Account) => {
    try {
      await api.patchAccount(a.id, { providerType: 'gmail-api' });
      load();
      await connectGmail({ ...a, providerType: 'gmail-api' });
    } catch (e) {
      toastError('Could not switch to OAuth', e);
    }
  };

  const rollbackCursor = async (a: Account) => {
    try {
      await api.rollbackCursor(a.id);
      toaster.create({ type: 'success', title: `Cursor rolled back 24 h`, description: `${a.senderName} will re-poll the last day of mail` });
      load();
    } catch (e) {
      toastError('Could not roll back cursor', e);
    }
  };

  const saveLimit = async (a: Account, raw: string) => {
    const v = raw.trim() === '' ? undefined : Number(raw);
    if (v !== undefined && !Number.isFinite(v)) return;
    if (v === (a.dailyLimitOverride ?? undefined)) return; // no change
    try {
      await api.patchAccount(a.id, { dailyLimitOverride: v });
      toaster.create({
        type: 'success',
        title: 'Daily limit saved',
        description: v === undefined ? `${a.senderName}: back to warmup ramp` : `${a.senderName}: ${v}/day`,
      });
    } catch (e) {
      toastError('Could not save limit', e);
    }
  };

  return (
    <Box pt={4}>
      <Flex mb={4} align="center" gap={3}>
        <Text color="fg.muted" fontSize="sm" maxW="60ch">
          Sending identities. The daily-limit override is per account; leave it blank to follow the
          warmup ramp toward max. Click a mailbox's results to break down what its outreach produced.
        </Text>
        <Box flex="1" />
        {!isManager && (
          <Button
            size="sm"
            colorPalette="brand"
            variant={adding ? 'outline' : 'solid'}
            onClick={() => setAdding((v) => !v)}
          >
            {adding ? 'Close' : (
              <>
                <PlusIcon />
                Add account
              </>
            )}
          </Button>
        )}
      </Flex>

      {adding && !isManager && <AddAccountForm onClose={() => setAdding(false)} onCreated={load} />}

      {error && (
        <Text color="red.fg" fontSize="sm" mb={3}>
          {error}
        </Text>
      )}

      <DataPanel
        loading={loading}
        isEmpty={accounts.length === 0}
        empty={
          <Empty
            icon={UsersIcon}
            title="No sending accounts yet"
            description="Add a Gmail account, then activate it to start sending outreach."
          >
            {!isManager && (
              <Button size="sm" colorPalette="brand" mt={2} onClick={() => setAdding(true)}>
                <PlusIcon />
                Add account
              </Button>
            )}
          </Empty>
        }
      >
        {/* Eight columns don't fit 1100px on a laptop, and Panel clips its
            overflow — scroll the table rather than lose the Actions column. */}
        <Table.ScrollArea>
        <Table.Root size="md" variant="line" interactive minW="1180px">
          <Table.Header>
            <Table.Row bg="bg.subtle">
              <Table.ColumnHeader>Account</Table.ColumnHeader>
              <Table.ColumnHeader>Status</Table.ColumnHeader>
              <Table.ColumnHeader>Provider</Table.ColumnHeader>
              <Table.ColumnHeader>Today</Table.ColumnHeader>
              <Table.ColumnHeader>Rate</Table.ColumnHeader>
              <Table.ColumnHeader>Results</Table.ColumnHeader>
              <Table.ColumnHeader>Daily limit</Table.ColumnHeader>
              <Table.ColumnHeader textAlign="end">Actions</Table.ColumnHeader>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {accounts.map((a) => (
              <Fragment key={a.id}>
              <Table.Row>
                <Table.Cell>
                  <Text fontWeight="semibold">{a.senderName}</Text>
                  <Text color="fg.muted" fontSize="xs">
                    {a.email}
                  </Text>
                </Table.Cell>
                <Table.Cell>
                  <StatusBadge value={a.status} />
                  {a.lastError && (
                    <Text color="red.fg" fontSize="xs" mt={1}>
                      {a.lastError}
                    </Text>
                  )}
                </Table.Cell>
                <Table.Cell>
                  {a.providerType === 'gmail-api' ? (
                    a.oauthConnected ? (
                      <>
                        <Text color="fg.muted" fontSize="sm">gmail-api</Text>
                        <Badge colorPalette="green" size="sm" mt={0.5}>OAuth</Badge>
                      </>
                    ) : (
                      <>
                        <Text color="fg.muted" fontSize="sm">imap</Text>
                        <Badge colorPalette="gray" size="sm" mt={0.5}>upgrade available</Badge>
                      </>
                    )
                  ) : (
                    <Text color="fg.muted" fontSize="sm">imap</Text>
                  )}
                </Table.Cell>
                <Table.Cell>{a.state ? <TodayCell s={a.state} /> : null}</Table.Cell>
                <Table.Cell>
                  {a.state ? <RateCell s={a.state} active={a.status === 'active'} /> : null}
                </Table.Cell>
                <Table.Cell
                  onClick={a.stats ? () => toggleExpanded(a.id) : undefined}
                  cursor={a.stats ? 'pointer' : undefined}
                  title={a.stats ? 'Show the full breakdown for this mailbox' : undefined}
                >
                  {a.stats ? <ResultsCell s={a.stats} open={expanded.has(a.id)} /> : null}
                </Table.Cell>
                <Table.Cell>
                  <Input
                    size="sm"
                    type="number"
                    width="28"
                    readOnly={isManager}
                    defaultValue={a.dailyLimitOverride ?? ''}
                    placeholder={`ramp → ${a.maxDailyLimit}`}
                    onBlur={isManager ? undefined : (e) => saveLimit(a, e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                    }}
                  />
                  {a.state ? <LimitHint s={a.state} /> : null}
                </Table.Cell>
                <Table.Cell>
                  {/* Connect/pause/rollback/delete are all operator actions —
                      mayAccess() refuses every one of them for a manager. */}
                  <HStack justify="flex-end" gap={2} display={isManager ? 'none' : undefined}>
                    {a.providerType === 'smtp-imap' && (
                      <Button
                        size="xs"
                        colorPalette="blue"
                        variant="outline"
                        onClick={() => switchToOAuth(a)}
                      >
                        Switch to OAuth
                      </Button>
                    )}
                    {a.providerType === 'gmail-api' && !a.oauthConnected && (
                      <Button
                        size="xs"
                        colorPalette="blue"
                        variant="outline"
                        onClick={() => connectGmail(a)}
                      >
                        Upgrade to OAuth
                      </Button>
                    )}
                    {a.providerType === 'gmail-api' && a.oauthConnected && (
                      <Button
                        size="xs"
                        variant="ghost"
                        onClick={() => connectGmail(a)}
                        title="Re-run Google authorization (needed after a permission/scope change)"
                      >
                        Reconnect
                      </Button>
                    )}
                    {a.status === 'active' ? (
                      <Button size="xs" variant="outline" onClick={() => setActive(a, false)}>
                        <PauseIcon />
                        Pause
                      </Button>
                    ) : (
                      <Button
                        size="xs"
                        variant="outline"
                        colorPalette="green"
                        onClick={() => setActive(a, true)}
                      >
                        <PlayIcon />
                        Activate
                      </Button>
                    )}
                    <Button
                      size="xs"
                      variant="ghost"
                      colorPalette="orange"
                      title="Roll poll cursor back 24 h"
                      onClick={() => rollbackCursor(a)}
                    >
                      <ClockIcon />
                    </Button>
                    <Button
                      size="xs"
                      variant="ghost"
                      colorPalette="red"
                      onClick={() => remove(a)}
                    >
                      <TrashIcon />
                    </Button>
                  </HStack>
                </Table.Cell>
              </Table.Row>
              {a.stats && expanded.has(a.id) ? (
                <Table.Row bg="bg.subtle">
                  <Table.Cell colSpan={8} py={0}>
                    <AccountStatsDetail s={a.stats} />
                  </Table.Cell>
                </Table.Row>
              ) : null}
              </Fragment>
            ))}
          </Table.Body>
        </Table.Root>
        </Table.ScrollArea>
      </DataPanel>
    </Box>
  );
}
