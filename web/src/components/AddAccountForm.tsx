import { Box, Button, Field, Heading, HStack, Input, SimpleGrid, Text } from '@chakra-ui/react';
import { useState } from 'react';
import { api } from '../api';
import type { NewAccount, ProviderType } from '../types';
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

  const setProvider = (p: ProviderType) => setForm((f) => ({ ...f, providerType: p }));

  const isGmail = form.providerType === 'gmail-api';
  const valid = form.email.trim() !== '' && form.senderName.trim() !== '';

  const openOAuth = async (accountId: string) => {
    try {
      const { authUrl } = await api.getOAuthUrl(accountId);
      window.open(authUrl, '_blank', 'noopener,noreferrer');
      toaster.create({
        type: 'success',
        title: 'Account added — authorize Gmail in the new tab',
        description: 'Return here after completing the Google sign-in.',
      });
    } catch {
      toaster.create({
        type: 'warning',
        title: 'Account added',
        description: 'Could not open OAuth URL. Use the "Connect Gmail" button in the accounts table.',
      });
    }
  };

  const submit = async () => {
    if (!valid) return;
    setBusy(true);
    try {
      const created = await api.createAccount({
        email: form.email.trim(),
        senderName: form.senderName.trim(),
        providerType: form.providerType,
        credentialRef: isGmail ? undefined : (form.credentialRef?.trim() || undefined),
        maxDailyLimit: Number(form.maxDailyLimit) || 40,
        signature: form.signature?.trim() || undefined,
      });
      onCreated();
      onClose();
      if (isGmail) {
        await openOAuth(created.id);
      } else {
        toaster.create({ type: 'success', title: `Added ${form.email.trim()}` });
      }
    } catch (e) {
      toastError('Could not add account', e);
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
        Add sending account
      </Heading>

      {/* Provider toggle */}
      <HStack mb={4} gap={0} borderWidth="1px" borderRadius="md" overflow="hidden" display="inline-flex">
        {(['gmail-api', 'smtp-imap'] as ProviderType[]).map((p) => (
          <Button
            key={p}
            size="sm"
            borderRadius={0}
            variant={form.providerType === p ? 'solid' : 'ghost'}
            colorPalette={form.providerType === p ? 'brand' : undefined}
            onClick={() => setProvider(p)}
          >
            {p === 'gmail-api' ? 'Gmail (OAuth)' : 'SMTP / IMAP'}
          </Button>
        ))}
      </HStack>

      {isGmail && (
        <Box mb={4} p={3} bg="blue.subtle" borderRadius="md" fontSize="sm" color="blue.fg">
          After adding, you'll be redirected to Google to authorize access. No app password needed.
        </Box>
      )}

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

        {!isGmail && (
          <Field.Root gridColumn={{ md: 'span 2' }}>
            <Field.Label>Credential ref (env var)</Field.Label>
            <Input
              placeholder="auto: GMAIL_OUTREACH"
              value={form.credentialRef}
              onChange={(e) => set('credentialRef', e.target.value)}
            />
            <Field.HelperText>
              Name of the .env var block holding the SMTP/IMAP credentials.
            </Field.HelperText>
          </Field.Root>
        )}

        <Field.Root>
          <Field.Label>Max daily limit</Field.Label>
          <Input
            type="number"
            value={form.maxDailyLimit}
            onChange={(e) => set('maxDailyLimit', Number(e.target.value))}
          />
        </Field.Root>
        <Field.Root>
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
          {isGmail ? 'Add & Connect Gmail' : 'Add account'}
        </Button>
      </HStack>
    </Panel>
  );
}
