import { Badge, Box, Button, Flex, HStack, Input, Table, Text } from '@chakra-ui/react';
import { useCallback, useState } from 'react';
import { api } from '../api';
import type { Account } from '../types';
import { StatusBadge } from './StatusBadge';
import { AddAccountForm } from './AddAccountForm';
import { DataPanel } from './DataPanel';
import { Empty } from './Empty';
import { useConfirm } from './Confirm';
import { toaster, toastError } from './Toaster';
import { useResource } from '../hooks/useResource';
import { ClockIcon, PauseIcon, PlayIcon, PlusIcon, TrashIcon, UsersIcon } from './icons';

export function AccountsView({ tick }: { tick: number }) {
  const [adding, setAdding] = useState(false);
  const confirm = useConfirm();
  const {
    rows: accounts,
    loading,
    error,
    reload: load,
  } = useResource(useCallback(() => api.listAccounts(), []), tick);

  // Only `active` accounts send. Anything else (warming / paused / cooldown)
  // gets a one-click "Activate"; an active account gets "Pause".
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
          warmup ramp toward max.
        </Text>
        <Box flex="1" />
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
      </Flex>

      {adding && <AddAccountForm onClose={() => setAdding(false)} onCreated={load} />}

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
            description="Add a Gmail account to start warming up and sending outreach."
          >
            <Button size="sm" colorPalette="brand" mt={2} onClick={() => setAdding(true)}>
              <PlusIcon />
              Add account
            </Button>
          </Empty>
        }
      >
        <Table.Root size="md" variant="line" interactive>
          <Table.Header>
            <Table.Row bg="bg.subtle">
              <Table.ColumnHeader>Account</Table.ColumnHeader>
              <Table.ColumnHeader>Status</Table.ColumnHeader>
              <Table.ColumnHeader>Provider</Table.ColumnHeader>
              <Table.ColumnHeader>Daily limit</Table.ColumnHeader>
              <Table.ColumnHeader textAlign="end">Actions</Table.ColumnHeader>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {accounts.map((a) => (
              <Table.Row key={a.id}>
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
                <Table.Cell>
                  <Input
                    size="sm"
                    type="number"
                    width="32"
                    defaultValue={a.dailyLimitOverride ?? ''}
                    placeholder={`ramp → ${a.maxDailyLimit}`}
                    onBlur={(e) => saveLimit(a, e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                    }}
                  />
                </Table.Cell>
                <Table.Cell>
                  <HStack justify="flex-end" gap={2}>
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
            ))}
          </Table.Body>
        </Table.Root>
      </DataPanel>
    </Box>
  );
}
