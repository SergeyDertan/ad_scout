import {
  Box,
  Button,
  Flex,
  HStack,
  Link,
  NativeSelect,
  Table,
  Text,
} from '@chakra-ui/react';
import { useCallback, useState } from 'react';
import { api } from '../api';
import type { Target, TargetStatus } from '../types';
import { StatusBadge } from './StatusBadge';
import { AddTargetForm } from './AddTargetForm';
import { DataPanel } from './DataPanel';
import { Empty } from './Empty';
import { useConfirm } from './Confirm';
import { toaster, toastError } from './Toaster';
import { useResource } from '../hooks/useResource';
import { FilterIcon, PlusIcon, TargetIcon, TrashIcon } from './icons';

const STATUSES: (TargetStatus | '')[] = [
  '',
  'pending',
  'reserved',
  'contacted',
  'replied',
  'bounced',
  'needs_review',
  'excluded',
];

export function TargetsView({ tick }: { tick: number }) {
  const [filter, setFilter] = useState<TargetStatus | ''>('');
  const [adding, setAdding] = useState(false);
  const confirm = useConfirm();
  const {
    rows: targets,
    loading,
    error,
    reload: load,
  } = useResource(useCallback(() => api.listTargets(filter), [filter]), tick);

  const remove = async (t: Target) => {
    const ok = await confirm({
      title: 'Remove target?',
      description: (
        <>
          Remove <b>{t.websiteUrl}</b> from the outreach queue?
        </>
      ),
      confirmLabel: 'Remove',
      destructive: true,
    });
    if (!ok) return;
    try {
      await api.deleteTarget(t.id);
      toaster.create({ type: 'success', title: `Removed ${t.websiteUrl}` });
      load();
    } catch (e) {
      toastError('Could not remove target', e);
    }
  };

  return (
    <Box pt={4}>
      <Flex mb={4} align="center" gap={3} wrap="wrap">
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
          <Text color="fg.muted" fontSize="sm">
            Filter
          </Text>
          <NativeSelect.Root size="sm" width="36" variant="plain">
            <NativeSelect.Field
              value={filter}
              onChange={(e) => setFilter(e.target.value as TargetStatus | '')}
              fontWeight="medium"
            >
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s ? s.replace(/_/g, ' ') : 'all statuses'}
                </option>
              ))}
            </NativeSelect.Field>
            <NativeSelect.Indicator />
          </NativeSelect.Root>
        </HStack>
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
              Add target
            </>
          )}
        </Button>
      </Flex>

      {adding && <AddTargetForm onClose={() => setAdding(false)} onCreated={load} />}

      {error && (
        <Text color="red.fg" fontSize="sm" mb={3}>
          {error}
        </Text>
      )}

      <DataPanel
        loading={loading}
        isEmpty={targets.length === 0}
        empty={
          <Empty
            icon={TargetIcon}
            title={filter ? `No ${filter.replace(/_/g, ' ')} targets` : 'No targets queued'}
            description={
              filter
                ? 'Try a different status filter, or add a new target.'
                : 'Add a website to the outreach queue to begin contacting it.'
            }
          >
            {!filter && (
              <Button size="sm" colorPalette="brand" mt={2} onClick={() => setAdding(true)}>
                <PlusIcon />
                Add target
              </Button>
            )}
          </Empty>
        }
      >
        <Table.Root size="md" variant="line" interactive>
          <Table.Header>
            <Table.Row bg="bg.subtle">
              <Table.ColumnHeader>Website</Table.ColumnHeader>
              <Table.ColumnHeader>Contact</Table.ColumnHeader>
              <Table.ColumnHeader>Status</Table.ColumnHeader>
              <Table.ColumnHeader textAlign="center">Follow-ups</Table.ColumnHeader>
              <Table.ColumnHeader>Can post</Table.ColumnHeader>
              <Table.ColumnHeader textAlign="end">Actions</Table.ColumnHeader>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {targets.map((t) => (
              <Table.Row key={t.id}>
                <Table.Cell>
                  <Link
                    href={t.websiteUrl.startsWith('http') ? t.websiteUrl : `https://${t.websiteUrl}`}
                    target="_blank"
                    rel="noreferrer"
                    fontWeight="semibold"
                    color="fg"
                    _hover={{ color: 'brand.fg', textDecoration: 'underline' }}
                  >
                    {t.websiteUrl}
                  </Link>
                </Table.Cell>
                <Table.Cell color="fg.muted">{t.contactEmail}</Table.Cell>
                <Table.Cell>
                  <StatusBadge value={t.status} />
                </Table.Cell>
                <Table.Cell textAlign="center" color={t.followUpCount ? 'fg' : 'fg.subtle'}>
                  {t.followUpCount}
                </Table.Cell>
                <Table.Cell color="fg.muted">{t.result?.canPost ?? '—'}</Table.Cell>
                <Table.Cell>
                  <HStack justify="flex-end">
                    <Button
                      size="xs"
                      variant="ghost"
                      colorPalette="red"
                      onClick={() => remove(t)}
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
