import {
  Box,
  Button,
  Field,
  Heading,
  HStack,
  Input,
  SimpleGrid,
  Text,
} from '@chakra-ui/react';
import { useState } from 'react';
import { api } from '../api';
import type { NewAccount } from '../types';

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
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const set = <K extends keyof NewAccount>(k: K, v: NewAccount[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.createAccount({
        email: form.email.trim(),
        senderName: form.senderName.trim(),
        providerType: form.providerType,
        credentialRef: form.credentialRef?.trim() || undefined,
        maxDailyLimit: Number(form.maxDailyLimit) || 40,
        signature: form.signature?.trim() || undefined,
      });
      onCreated();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const valid = form.email.trim() !== '' && form.senderName.trim() !== '';

  return (
    <Box borderWidth="1px" borderColor="border" rounded="lg" bg="bg.subtle" p={5} mb={4}>
      <Heading size="sm" mb={3}>
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
          <Field.HelperText>Name of the .env var holding the secret — never the secret itself.</Field.HelperText>
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

      {error && (
        <Text color="red.400" fontSize="sm" mt={3}>
          {error}
        </Text>
      )}

      <HStack mt={4} justify="flex-end">
        <Button variant="ghost" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button colorPalette="blue" onClick={submit} loading={busy} disabled={!valid}>
          Add account
        </Button>
      </HStack>
    </Box>
  );
}
