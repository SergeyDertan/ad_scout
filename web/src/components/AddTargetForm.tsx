import {
  Button,
  Field,
  Heading,
  HStack,
  Input,
  NativeSelect,
  SimpleGrid,
  Text,
  Textarea,
} from '@chakra-ui/react';
import { useEffect, useState } from 'react';
import { api } from '../api';
import type { Campaign, NewTarget } from '../types';
import { Panel } from './Panel';
import { toaster, toastError } from './Toaster';

const EMPTY: NewTarget = {
  websiteUrl: '',
  contactEmail: '',
  campaignId: '',
  contactName: '',
  notes: '',
};

export function AddTargetForm({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [form, setForm] = useState<NewTarget>(EMPTY);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .listCampaigns()
      .then((cs) => {
        setCampaigns(cs);
        setForm((f) => ({ ...f, campaignId: cs[0]?.id ?? '' }));
      })
      .catch((e) => toastError('Could not load campaigns', e));
  }, []);

  const set = <K extends keyof NewTarget>(k: K, v: NewTarget[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  const createDefaultCampaign = async () => {
    setBusy(true);
    try {
      const c = await api.createCampaign({
        name: 'Default campaign',
        advertised: { url: 'example.com', description: '' },
      });
      setCampaigns((cs) => [...cs, c]);
      setForm((f) => ({ ...f, campaignId: c.id }));
      toaster.create({ type: 'success', title: 'Default campaign created' });
    } catch (e) {
      toastError('Could not create campaign', e);
    } finally {
      setBusy(false);
    }
  };

  const valid =
    form.websiteUrl.trim() !== '' && form.contactEmail.trim() !== '' && campaigns.length > 0;

  const submit = async () => {
    if (!valid) return;
    setBusy(true);
    try {
      await api.createTarget({
        websiteUrl: form.websiteUrl.trim(),
        contactEmail: form.contactEmail.trim(),
        campaignId: form.campaignId || undefined,
        contactName: form.contactName?.trim() || undefined,
        notes: form.notes?.trim() || undefined,
      });
      toaster.create({ type: 'success', title: `Queued ${form.websiteUrl.trim()}` });
      onCreated();
      onClose();
    } catch (e) {
      toastError('Could not add target', e);
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey && (e.target as HTMLElement).tagName !== 'TEXTAREA') {
      e.preventDefault();
      void submit();
    }
  };

  return (
    <Panel p={5} mb={4} onKeyDown={onKeyDown}>
      <Heading size="sm" mb={4}>
        Add target to queue
      </Heading>

      {campaigns.length === 0 ? (
        <HStack>
          <Text color="fg.muted" fontSize="sm">
            No campaign exists yet — a target must belong to one.
          </Text>
          <Button size="sm" colorPalette="brand" onClick={createDefaultCampaign} loading={busy}>
            Create default campaign
          </Button>
        </HStack>
      ) : (
        <SimpleGrid columns={{ base: 1, md: 2 }} gap={4}>
          <Field.Root required>
            <Field.Label>
              Website <Field.RequiredIndicator />
            </Field.Label>
            <Input
              placeholder="egamersworld.com"
              value={form.websiteUrl}
              onChange={(e) => set('websiteUrl', e.target.value)}
              autoFocus
            />
          </Field.Root>
          <Field.Root required>
            <Field.Label>
              Contact email <Field.RequiredIndicator />
            </Field.Label>
            <Input
              type="email"
              placeholder="info@egamersworld.com"
              value={form.contactEmail}
              onChange={(e) => set('contactEmail', e.target.value)}
            />
          </Field.Root>
          <Field.Root>
            <Field.Label>Campaign</Field.Label>
            <NativeSelect.Root>
              <NativeSelect.Field
                value={form.campaignId}
                onChange={(e) => set('campaignId', e.target.value)}
              >
                {campaigns.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </NativeSelect.Field>
              <NativeSelect.Indicator />
            </NativeSelect.Root>
          </Field.Root>
          <Field.Root>
            <Field.Label>Contact name</Field.Label>
            <Input
              placeholder="Editor"
              value={form.contactName}
              onChange={(e) => set('contactName', e.target.value)}
            />
          </Field.Root>
          <Field.Root gridColumn={{ md: 'span 2' }}>
            <Field.Label>Notes</Field.Label>
            <Textarea
              rows={2}
              placeholder="Anything worth remembering about this target…"
              value={form.notes}
              onChange={(e) => set('notes', e.target.value)}
            />
          </Field.Root>
        </SimpleGrid>
      )}

      <HStack mt={5} justify="flex-end">
        <Button variant="ghost" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button colorPalette="brand" onClick={submit} loading={busy} disabled={!valid}>
          Add target
        </Button>
      </HStack>
    </Panel>
  );
}
