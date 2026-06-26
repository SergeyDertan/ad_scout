import { Badge, Box, Button, Flex, HStack, Table, Text } from '@chakra-ui/react';
import { useCallback, useState } from 'react';
import { api } from '../api';
import type { Campaign } from '../types';
import { DataPanel } from './DataPanel';
import { Empty } from './Empty';
import { AddCampaignForm } from './AddCampaignForm';
import { EditCampaignForm } from './EditCampaignForm';
import { InquiryFieldsEditor } from './InquiryFieldsEditor';
import { EmailPreviewPanel } from './EmailPreviewPanel';
import { MegaphoneIcon, PlusIcon, TrashIcon } from './icons';
import { useResource } from '../hooks/useResource';
import { useConfirm } from './Confirm';
import { toaster, toastError } from './Toaster';

type Mode =
  | 'add'
  | { editId: string }
  | { editBasicId: string }
  | { previewId: string }
  | null;

function byMode<K extends string>(mode: Mode, key: K, id: string): boolean {
  return mode !== null && typeof mode === 'object' && key in mode && (mode as Record<string, string>)[key] === id;
}

export function CampaignsView({ tick }: { tick: number }) {
  const [mode, setMode] = useState<Mode>(null);
  const confirm = useConfirm();
  const {
    rows: campaigns,
    loading,
    error,
    reload,
  } = useResource(useCallback(() => api.listCampaigns(), []), tick);

  const find = (id: string) => campaigns.find((c) => c.id === id) ?? null;

  const editingCampaign   = mode !== null && typeof mode === 'object' && 'editId'      in mode ? find(mode.editId)      : null;
  const editBasicCampaign = mode !== null && typeof mode === 'object' && 'editBasicId' in mode ? find(mode.editBasicId) : null;
  const previewCampaign   = mode !== null && typeof mode === 'object' && 'previewId'   in mode ? find(mode.previewId)   : null;

  const close = () => setMode(null);

  const remove = async (c: Campaign) => {
    const ok = await confirm({
      title: 'Delete campaign?',
      description: <>Delete <b>{c.name}</b>? Targets assigned to it are not deleted but will need reassigning.</>,
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!ok) return;
    try {
      await api.deleteCampaign(c.id);
      toaster.create({ type: 'success', title: `Deleted "${c.name}"` });
      reload();
      close();
    } catch (e) {
      toastError('Could not delete campaign', e);
    }
  };

  return (
    <Box pt={4}>
      <Flex mb={4} align="center" gap={3}>
        <Text color="fg.muted" fontSize="sm" maxW="60ch">
          Campaigns define what you're advertising and the questions asked of every site. Targets
          must belong to a campaign.
        </Text>
        <Box flex="1" />
        <Button
          size="sm"
          colorPalette="brand"
          variant={mode === 'add' ? 'outline' : 'solid'}
          onClick={() => setMode((m) => (m === 'add' ? null : 'add'))}
        >
          {mode === 'add' ? 'Close' : <><PlusIcon /> New campaign</>}
        </Button>
      </Flex>

      {mode === 'add'    && <AddCampaignForm onClose={close} onCreated={reload} />}
      {editBasicCampaign && <EditCampaignForm campaign={editBasicCampaign} onClose={close} onSaved={reload} />}
      {editingCampaign   && <InquiryFieldsEditor campaign={editingCampaign} onClose={close} onSaved={reload} />}
      {previewCampaign   && <EmailPreviewPanel campaign={previewCampaign} onClose={close} />}

      {error && <Text color="red.fg" fontSize="sm" mb={3}>{error}</Text>}

      <DataPanel
        loading={loading}
        isEmpty={campaigns.length === 0}
        empty={
          <Empty
            icon={MegaphoneIcon}
            title="No campaigns yet"
            description="Create a campaign before adding targets — it defines what you're advertising."
          >
            <Button size="sm" colorPalette="brand" mt={2} onClick={() => setMode('add')}>
              <PlusIcon /> New campaign
            </Button>
          </Empty>
        }
      >
        <Table.Root size="md" variant="line" interactive>
          <Table.Header>
            <Table.Row bg="bg.subtle">
              <Table.ColumnHeader>Name</Table.ColumnHeader>
              <Table.ColumnHeader>Advertised URL</Table.ColumnHeader>
              <Table.ColumnHeader>Topic</Table.ColumnHeader>
              <Table.ColumnHeader>Format</Table.ColumnHeader>
              <Table.ColumnHeader>Fields</Table.ColumnHeader>
              <Table.ColumnHeader textAlign="end">Actions</Table.ColumnHeader>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {campaigns.map((c) => {
              const isEditingBasic = byMode(mode, 'editBasicId', c.id);
              const isEditingFields = byMode(mode, 'editId', c.id);
              const isPreviewing = byMode(mode, 'previewId', c.id);
              const isActive = isEditingBasic || isEditingFields || isPreviewing;
              return (
                <Table.Row key={c.id} bg={isActive ? 'bg.muted' : undefined}>
                  <Table.Cell>
                    <Text fontWeight="semibold">{c.name}</Text>
                    <Text color="fg.muted" fontSize="xs">{c.id}</Text>
                  </Table.Cell>
                  <Table.Cell>
                    <Text fontSize="sm">{c.advertised.url}</Text>
                    {c.advertised.description && (
                      <Text color="fg.muted" fontSize="xs">{c.advertised.description}</Text>
                    )}
                  </Table.Cell>
                  <Table.Cell color="fg.muted">{c.topic || '—'}</Table.Cell>
                  <Table.Cell color="fg.muted">{c.format || '—'}</Table.Cell>
                  <Table.Cell>
                    <HStack gap={2}>
                      {c.inquiryFields.length > 0 && (
                        <Badge
                          size="sm"
                          rounded="full"
                          colorPalette={isEditingFields ? 'brand' : 'gray'}
                          variant={isEditingFields ? 'solid' : 'subtle'}
                        >
                          {c.inquiryFields.length}
                        </Badge>
                      )}
                      <Button
                        size="xs"
                        variant={isEditingFields ? 'solid' : 'outline'}
                        colorPalette={isEditingFields ? 'brand' : 'gray'}
                        onClick={() => setMode(isEditingFields ? null : { editId: c.id })}
                      >
                        {isEditingFields ? 'Close' : c.inquiryFields.length === 0 ? '+ Add fields' : 'Fields'}
                      </Button>
                    </HStack>
                  </Table.Cell>
                  <Table.Cell>
                    <HStack justify="flex-end" gap={2}>
                      <Button
                        size="xs"
                        variant={isEditingBasic ? 'solid' : 'outline'}
                        colorPalette={isEditingBasic ? 'brand' : 'gray'}
                        onClick={() => setMode(isEditingBasic ? null : { editBasicId: c.id })}
                      >
                        {isEditingBasic ? 'Close' : 'Edit'}
                      </Button>
                      <Button
                        size="xs"
                        variant={isPreviewing ? 'solid' : 'outline'}
                        colorPalette={isPreviewing ? 'brand' : 'gray'}
                        onClick={() => setMode(isPreviewing ? null : { previewId: c.id })}
                      >
                        {isPreviewing ? 'Close' : 'Preview'}
                      </Button>
                      <Button
                        size="xs"
                        variant="ghost"
                        colorPalette="red"
                        onClick={() => remove(c)}
                      >
                        <TrashIcon />
                      </Button>
                    </HStack>
                  </Table.Cell>
                </Table.Row>
              );
            })}
          </Table.Body>
        </Table.Root>
      </DataPanel>
    </Box>
  );
}
