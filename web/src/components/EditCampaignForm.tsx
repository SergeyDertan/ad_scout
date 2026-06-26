import { Button, Field, Heading, HStack, Input, SimpleGrid, Text } from '@chakra-ui/react';
import { useState } from 'react';
import { api } from '../api';
import type { Campaign } from '../types';
import { Panel } from './Panel';
import { toaster, toastError } from './Toaster';

export function EditCampaignForm({
  campaign,
  onClose,
  onSaved,
}: {
  campaign: Campaign;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(campaign.name);
  const [url, setUrl] = useState(campaign.advertised.url);
  const [description, setDescription] = useState(campaign.advertised.description);
  const [topic, setTopic] = useState(campaign.topic);
  const [format, setFormat] = useState(campaign.format);
  const [busy, setBusy] = useState(false);

  const valid = name.trim() !== '' && url.trim() !== '';

  const submit = async () => {
    if (!valid) return;
    setBusy(true);
    try {
      await api.patchCampaign(campaign.id, {
        name: name.trim(),
        advertised: { url: url.trim(), description: description.trim() },
        topic: topic.trim(),
        format: format.trim(),
      });
      toaster.create({ type: 'success', title: 'Campaign updated' });
      onSaved();
      onClose();
    } catch (e) {
      toastError('Could not update campaign', e);
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
      <HStack mb={4} align="baseline">
        <Heading size="sm">Edit campaign</Heading>
        <Text color="fg.muted" fontSize="sm">— {campaign.name}</Text>
      </HStack>

      <SimpleGrid columns={{ base: 1, md: 2 }} gap={4}>
        <Field.Root required gridColumn={{ md: 'span 2' }}>
          <Field.Label>
            Campaign name <Field.RequiredIndicator />
          </Field.Label>
          <Input
            placeholder="Casino Q3 Outreach"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
        </Field.Root>
        <Field.Root required>
          <Field.Label>
            Advertised URL <Field.RequiredIndicator />
          </Field.Label>
          <Input
            placeholder="casinoslists.com"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
        </Field.Root>
        <Field.Root>
          <Field.Label>Description</Field.Label>
          <Input
            placeholder="premium casino reviews and listings"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field.Root>
        <Field.Root>
          <Field.Label>Topic</Field.Label>
          <Input
            placeholder="casino"
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
          />
        </Field.Root>
        <Field.Root>
          <Field.Label>Format</Field.Label>
          <Input
            placeholder="article"
            value={format}
            onChange={(e) => setFormat(e.target.value)}
          />
        </Field.Root>
      </SimpleGrid>

      <HStack mt={5} justify="flex-end">
        <Button variant="ghost" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button colorPalette="brand" onClick={submit} loading={busy} disabled={!valid}>
          Save
        </Button>
      </HStack>
    </Panel>
  );
}
