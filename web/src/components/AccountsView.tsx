import { Box, Button, Flex, HStack, Input, Spinner, Table, Text } from '@chakra-ui/react';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import type { Account } from '../types';
import { StatusBadge } from './StatusBadge';
import { AddAccountForm } from './AddAccountForm';

export function AccountsView({ tick }: { tick: number }) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    api
      .listAccounts()
      .then((a) => {
        setAccounts(a);
        setError(null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load, tick]);

  // Only `active` accounts send. Anything else (warming / paused / cooldown)
  // gets a one-click "Activate"; an active account gets "Pause".
  const setActive = async (a: Account, active: boolean) => {
    if (active) await api.resumeAccount(a.id);
    else await api.pauseAccount(a.id);
    load();
  };

  const remove = async (a: Account) => {
    if (!confirm(`Delete account ${a.email}? Queued/sent history is kept.`)) return;
    await api.deleteAccount(a.id);
    load();
  };

  const saveLimit = async (a: Account, raw: string) => {
    const v = raw.trim() === '' ? undefined : Number(raw);
    if (v !== undefined && !Number.isFinite(v)) return;
    await api.patchAccount(a.id, { dailyLimitOverride: v });
  };

  return (
    <Box pt={4}>
      <Flex mb={3} align="center">
        <Text color="fg.muted" fontSize="sm">
          Sending identities. Daily limit override is per account; blank uses the warmup ramp toward
          max.
        </Text>
        <Box flex="1" />
        <Button size="sm" colorPalette="blue" onClick={() => setAdding((v) => !v)}>
          {adding ? 'Close' : '+ Add Gmail account'}
        </Button>
      </Flex>

      {adding && <AddAccountForm onClose={() => setAdding(false)} onCreated={load} />}

      {error && (
        <Text color="red.400" fontSize="sm" mb={3}>
          {error}
        </Text>
      )}

      {loading && accounts.length === 0 ? (
        <Spinner />
      ) : (
        <Table.Root size="sm" variant="outline" interactive>
          <Table.Header>
            <Table.Row>
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
                  <Text fontWeight="medium">{a.senderName}</Text>
                  <Text color="fg.muted" fontSize="xs">
                    {a.email}
                  </Text>
                </Table.Cell>
                <Table.Cell>
                  <StatusBadge value={a.status} />
                  {a.lastError && (
                    <Text color="red.400" fontSize="xs" mt={1}>
                      {a.lastError}
                    </Text>
                  )}
                </Table.Cell>
                <Table.Cell color="fg.muted">{a.providerType}</Table.Cell>
                <Table.Cell>
                  <Input
                    size="sm"
                    type="number"
                    width="20"
                    defaultValue={a.dailyLimitOverride ?? ''}
                    placeholder={String(a.maxDailyLimit)}
                    onBlur={(e) => saveLimit(a, e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                    }}
                  />
                </Table.Cell>
                <Table.Cell>
                  <HStack justify="flex-end" gap={2}>
                    {a.status === 'active' ? (
                      <Button size="xs" variant="outline" onClick={() => setActive(a, false)}>
                        Pause
                      </Button>
                    ) : (
                      <Button
                        size="xs"
                        variant="outline"
                        colorPalette="green"
                        onClick={() => setActive(a, true)}
                      >
                        Activate
                      </Button>
                    )}
                    <Button
                      size="xs"
                      variant="outline"
                      colorPalette="red"
                      onClick={() => remove(a)}
                    >
                      Delete
                    </Button>
                  </HStack>
                </Table.Cell>
              </Table.Row>
            ))}
            {accounts.length === 0 && !loading && (
              <Table.Row>
                <Table.Cell colSpan={5}>
                  <Text color="fg.muted">No accounts — add a Gmail account to start sending.</Text>
                </Table.Cell>
              </Table.Row>
            )}
          </Table.Body>
        </Table.Root>
      )}
    </Box>
  );
}
