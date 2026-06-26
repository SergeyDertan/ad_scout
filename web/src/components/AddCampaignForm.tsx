import { Button, Field, Heading, HStack, Input, SimpleGrid } from '@chakra-ui/react';
import { useState } from 'react';
import { api } from '../api';
import type { NewCampaign } from '../types';
import { Panel } from './Panel';
import { toaster, toastError } from './Toaster';

const EMPTY: NewCampaign = {
  name: '',
  advertised: { url: '', description: '' },
  topic: '',
  format: 'article',
};

export function AddCampaignForm({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const [form, setForm] = useState<NewCampaign>(EMPTY);
  const [busy, setBusy] = useState(false);

  const setTop = <K extends keyof NewCampaign>(k: K, v: NewCampaign[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  const setAdv = (k: 'url' | 'description', v: string) =>
    setForm((f) => ({ ...f, advertised: { ...f.advertised, [k]: v } }));

  const valid = form.name.trim() !== '' && form.advertised.url.trim() !== '';

  const submit = async () => {
    if (!valid) return;
    setBusy(true);
    try {
      await api.createCampaign({
        name: form.name.trim(),
        advertised: {
          url: form.advertised.url.trim(),
          description: form.advertised.description?.trim() || undefined,
        },
        topic: form.topic?.trim() || undefined,
        format: form.format?.trim() || undefined,
      });
      toaster.create({ type: 'success', title: `Campaign "${form.name.trim()}" created` });
      onCreated();
      onClose();
    } catch (e) {
      toastError('Could not create campaign', e);
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  };

  return (
    <Panel p={5} mb={4} onKeyDown={onKeyDown}>
      <Heading size="sm" mb={4}>
        New campaign
      </Heading>
      <SimpleGrid columns={{ base: 1, md: 2 }} gap={4}>
        <Field.Root required gridColumn={{ md: 'span 2' }}>
          <Field.Label>
            Campaign name <Field.RequiredIndicator />
          </Field.Label>
          <Input
            placeholder="Casino Q3 Outreach"
            value={form.name}
            onChange={(e) => setTop('name', e.target.value)}
            autoFocus
          />
        </Field.Root>
        <Field.Root required>
          <Field.Label>
            Advertised URL <Field.RequiredIndicator />
          </Field.Label>
          <Input
            placeholder="example.com"
            value={form.advertised.url}
            onChange={(e) => setAdv('url', e.target.value)}
          />
        </Field.Root>
        <Field.Root>
          <Field.Label>Description</Field.Label>
          <Input
            placeholder="What you're promoting"
            value={form.advertised.description}
            onChange={(e) => setAdv('description', e.target.value)}
          />
        </Field.Root>
        <Field.Root>
          <Field.Label>Topic</Field.Label>
          <Input
            placeholder="casino"
            value={form.topic}
            onChange={(e) => setTop('topic', e.target.value)}
          />
        </Field.Root>
        <Field.Root>
          <Field.Label>Format</Field.Label>
          <Input
            placeholder="article"
            value={form.format}
            onChange={(e) => setTop('format', e.target.value)}
          />
        </Field.Root>
      </SimpleGrid>

      <HStack mt={5} justify="flex-end">
        <Button variant="ghost" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button colorPalette="brand" onClick={submit} loading={busy} disabled={!valid}>
          Create campaign
        </Button>
      </HStack>
    </Panel>
  );
}
