import {
  Box,
  Button,
  Checkbox,
  Field,
  Heading,
  HStack,
  IconButton,
  Input,
  NativeSelect,
  Text,
  VStack,
} from '@chakra-ui/react';
import { useState } from 'react';
import { api } from '../api';
import type { Campaign, InquiryField, InquiryFieldType } from '../types';
import { Panel } from './Panel';
import { PlusIcon, TrashIcon } from './icons';
import { toaster, toastError } from './Toaster';

const FIELD_TYPES: { value: InquiryFieldType; label: string }[] = [
  { value: 'price', label: 'price' },
  { value: 'boolean', label: 'boolean' },
  { value: 'text', label: 'text' },
  { value: 'list', label: 'list' },
  { value: 'enum', label: 'enum' },
];

function emptyField(): InquiryField {
  return { key: '', question: '', type: 'text' };
}

export function InquiryFieldsEditor({
  campaign,
  onClose,
  onSaved,
}: {
  campaign: Campaign;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [fields, setFields] = useState<InquiryField[]>(
    campaign.inquiryFields.length > 0 ? campaign.inquiryFields : [],
  );
  const [busy, setBusy] = useState(false);

  const update = (i: number, patch: Partial<InquiryField>) =>
    setFields((fs) => fs.map((f, idx) => (idx === i ? { ...f, ...patch } : f)));

  const remove = (i: number) => setFields((fs) => fs.filter((_, idx) => idx !== i));

  const add = () => setFields((fs) => [...fs, emptyField()]);

  const save = async () => {
    const invalid = fields.find((f) => !f.key.trim() || !f.question.trim());
    if (invalid) {
      toaster.create({ type: 'error', title: 'Each field needs a key and a question' });
      return;
    }
    setBusy(true);
    try {
      await api.patchCampaign(campaign.id, {
        inquiryFields: fields.map((f) => ({
          key: f.key.trim(),
          question: f.question.trim(),
          type: f.type,
          enumValues:
            f.type === 'enum' && f.enumValues?.length
              ? f.enumValues.map((v) => v.trim()).filter(Boolean)
              : undefined,
          required: f.required || undefined,
        })),
      });
      toaster.create({ type: 'success', title: `Fields saved for "${campaign.name}"` });
      onSaved();
      onClose();
    } catch (e) {
      toastError('Could not save fields', e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel p={5} mb={4}>
      <HStack mb={4} align="baseline">
        <Heading size="sm">Inquiry fields</Heading>
        <Text color="fg.muted" fontSize="sm">
          — {campaign.name}
        </Text>
      </HStack>

      <VStack gap={3} align="stretch">
        {fields.length === 0 && (
          <Text color="fg.muted" fontSize="sm">
            No fields yet. Add one below — they drive both the email body and reply extraction.
          </Text>
        )}

        {fields.map((f, i) => (
          <Box key={i} bg="bg.subtle" rounded="lg" p={3}>
            <HStack gap={2} align="flex-start" flexWrap={{ base: 'wrap', md: 'nowrap' }}>
              <Field.Root minW="0" flexShrink={0} w={{ base: 'full', md: '130px' }}>
                <Field.Label fontSize="xs" color="fg.muted">Key</Field.Label>
                <Input
                  size="sm"
                  placeholder="price"
                  value={f.key}
                  onChange={(e) => update(i, { key: e.target.value })}
                  fontFamily="mono"
                />
              </Field.Root>

              <Field.Root flex="1" minW="0">
                <Field.Label fontSize="xs" color="fg.muted">Question</Field.Label>
                <Input
                  size="sm"
                  placeholder="What is the price for a sponsored article?"
                  value={f.question}
                  onChange={(e) => update(i, { question: e.target.value })}
                />
              </Field.Root>

              <Field.Root flexShrink={0} w={{ base: 'full', md: '110px' }}>
                <Field.Label fontSize="xs" color="fg.muted">Type</Field.Label>
                <NativeSelect.Root size="sm">
                  <NativeSelect.Field
                    value={f.type}
                    onChange={(e) =>
                      update(i, { type: e.target.value as InquiryFieldType, enumValues: undefined })
                    }
                  >
                    {FIELD_TYPES.map((t) => (
                      <option key={t.value} value={t.value}>
                        {t.label}
                      </option>
                    ))}
                  </NativeSelect.Field>
                  <NativeSelect.Indicator />
                </NativeSelect.Root>
              </Field.Root>

              <Box pt={{ base: 0, md: 5 }} flexShrink={0}>
                <Checkbox.Root
                  size="sm"
                  checked={f.required ?? false}
                  onCheckedChange={(e) => update(i, { required: !!e.checked })}
                >
                  <Checkbox.HiddenInput />
                  <Checkbox.Control />
                  <Checkbox.Label fontSize="xs" color="fg.muted">
                    Required
                  </Checkbox.Label>
                </Checkbox.Root>
              </Box>

              <Box pt={{ base: 0, md: 5 }} flexShrink={0}>
                <IconButton
                  size="sm"
                  variant="ghost"
                  colorPalette="red"
                  aria-label="Remove field"
                  onClick={() => remove(i)}
                >
                  <TrashIcon />
                </IconButton>
              </Box>
            </HStack>

            {f.type === 'enum' && (
              <Field.Root mt={2}>
                <Field.Label fontSize="xs" color="fg.muted">
                  Enum values (comma-separated)
                </Field.Label>
                <Input
                  size="sm"
                  placeholder="Option A, Option B, Option C"
                  value={f.enumValues?.join(', ') ?? ''}
                  onChange={(e) =>
                    update(i, { enumValues: e.target.value.split(',').map((v) => v.trim()) })
                  }
                />
              </Field.Root>
            )}
          </Box>
        ))}
      </VStack>

      <Button size="sm" variant="outline" mt={3} onClick={add}>
        <PlusIcon />
        Add field
      </Button>

      <HStack mt={5} justify="flex-end">
        <Button variant="ghost" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button colorPalette="brand" onClick={save} loading={busy}>
          Save fields
        </Button>
      </HStack>
    </Panel>
  );
}
