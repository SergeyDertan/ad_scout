import { Button, Field, Heading, HStack, Input, SimpleGrid } from '@chakra-ui/react';
import { useState } from 'react';
import { api } from '../api';
import type { NewAccount } from '../types';
import { Panel } from './Panel';
import { toaster, toastError } from './Toaster';

const EMPTY: NewAccount = {
  email: '',
  senderName: '',
  providerType: 'gmail-api',
  credentialRef: '',
  maxDailyLimit: 40,
  signature: '',
};

export function AddAccountForm({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [form, setForm] = useState<NewAccount>(EMPTY);
  const [busy, setBusy] = useState(false);

  const set = <K extends keyof NewAccount>(k: K, v: NewAccount[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  const valid = form.email.trim() !== '' && form.senderName.trim() !== '';

  const submit = async () => {
    if (!valid) return;
    setBusy(true);
    try {
      await api.createAccount({
        email: form.email.trim(),
        senderName: form.senderName.trim(),
        providerType: form.providerType,
        credentialRef: form.credentialRef?.trim() || undefined,
        maxDailyLimit: Number(form.maxDailyLimit) || 40,
        signature: form.signature?.trim() || undefined,
      });
      toaster.create({ type: 'success', title: `Added ${form.email.trim()}` });
      onCreated();
      onClose();
    } catch (e) {
      toastError('Could not add account', e);
    } finally {
      setBusy(false);
    }
  };

  // Enter submits from any single-line field.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  };

  return (
    <Panel p={5} mb={4} onKeyDown={onKeyDown}>
      <Heading size="sm" mb={4}>
        Add Gmail account
      </Heading>
      <SimpleGrid columns={{ base: 1, md: 2 }} gap={4}>
        <Field.Root required>
          <Field.Label>
            Email <Field.RequiredIndicator />
          </Field.Label>
          <Input
            type="email"
            placeholder="outreach@gmail.com"
            value={form.email}
            onChange={(e) => set('email', e.target.value)}
            autoFocus
          />
        </Field.Root>
        <Field.Root required>
          <Field.Label>
            Sender name <Field.RequiredIndicator />
          </Field.Label>
          <Input
            placeholder="Vlad"
            value={form.senderName}
            onChange={(e) => set('senderName', e.target.value)}
          />
        </Field.Root>
        <Field.Root>
          <Field.Label>Credential ref (env var)</Field.Label>
          <Input
            placeholder="auto: GMAIL_OUTREACH"
            value={form.credentialRef}
            onChange={(e) => set('credentialRef', e.target.value)}
          />
          <Field.HelperText>
            Name of the .env var holding the secret — never the secret itself.
          </Field.HelperText>
        </Field.Root>
        <Field.Root>
          <Field.Label>Max daily limit</Field.Label>
          <Input
            type="number"
            value={form.maxDailyLimit}
            onChange={(e) => set('maxDailyLimit', Number(e.target.value))}
          />
        </Field.Root>
        <Field.Root gridColumn={{ md: 'span 2' }}>
          <Field.Label>Signature</Field.Label>
          <Input
            placeholder="— Vlad, AdScout"
            value={form.signature}
            onChange={(e) => set('signature', e.target.value)}
          />
        </Field.Root>
      </SimpleGrid>

      <HStack mt={5} justify="flex-end">
        <Button variant="ghost" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button colorPalette="brand" onClick={submit} loading={busy} disabled={!valid}>
          Add account
        </Button>
      </HStack>
    </Panel>
  );
}
