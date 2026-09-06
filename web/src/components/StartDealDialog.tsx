// Opening a deal ON A CONVERSATION THAT ALREADY EXISTS.
//
// The Deals page could only ever open a deal from scratch: type the address,
// type the site, pick a mailbox. But the case that actually happens is the
// opposite one — a publisher has just answered with prices and you want to
// negotiate in THAT thread, with everything already known about them filled in.
//
// The server has always supported this (openDeal adopts the threads it finds
// with that address on that mailbox, and returns the existing deal rather than
// opening a second one). Only the button was missing.

import {
  Box,
  Button,
  CloseButton,
  Dialog,
  Field,
  HStack,
  Input,
  NativeSelect,
  Portal,
  Text,
  Textarea,
  VStack,
} from '@chakra-ui/react';
import { useEffect, useState } from 'react';
import { api } from '../api';
import type { Account } from '../types';
import { toaster, toastError } from './Toaster';

export interface StartDealSeed {
  /** Who we would be negotiating with — the address that answered. */
  counterpartyEmail: string;
  /** Our mailbox the message landed in, when it is known. A thread id belongs
   *  to ONE mailbox, so this is not a nicety: sending from another account
   *  would silently start a conversation the publisher sees as unrelated. */
  accountId?: string;
  accountEmail?: string;
  /** The site under discussion, prefilled as the first placement. */
  website?: string;
  /** The conversation to continue. Absent ⇒ the server finds it by address. */
  threadId?: string;
}

/** Bare host, so `https://site.com/blog/` becomes the domain a placement wants. */
function toDomain(website?: string): string {
  if (!website) return '';
  const raw = website.trim();
  if (!raw) return '';
  try {
    return new URL(raw.includes('://') ? raw : `https://${raw}`).hostname.replace(/^www\./, '');
  } catch {
    return raw.replace(/^www\./, '');
  }
}

export function StartDealDialog({
  seed,
  onClose,
  onOpened,
}: {
  seed: StartDealSeed;
  onClose: () => void;
  /** The deal that now holds this thread — existing or brand new. */
  onOpened: (dealId: string) => void;
}) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [accountId, setAccountId] = useState(seed.accountId ?? '');
  const [domains, setDomains] = useState(toDomain(seed.website));
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .listAccounts()
      .then((rows) => {
        setAccounts(rows);
        // Fall back to the mailbox named by the seed, then to the first one —
        // never to "none", which the server would refuse.
        setAccountId((cur) => cur || seed.accountId || rows[0]?.id || '');
      })
      .catch(() => setAccounts([]));
  }, [seed.accountId]);

  const submit = async () => {
    setBusy(true);
    try {
      const deal = await api.openDeal({
        counterpartyEmail: seed.counterpartyEmail,
        accountId,
        ...(seed.threadId ? { threadIds: [seed.threadId] } : {}),
        domains: domains.split(/[,\s]+/).map((d) => d.trim()).filter(Boolean),
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      toaster.create({ type: 'success', title: 'Deal open on this thread' });
      onOpened(deal.id);
    } catch (e) {
      toastError('Could not open the deal', e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog.Root open onOpenChange={(e) => { if (!e.open) onClose(); }} placement="center" size="md">
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content rounded="xl">
            <Dialog.Header>
              <VStack align="flex-start" gap={0.5}>
                <Dialog.Title>Start a deal on this thread</Dialog.Title>
                <Text fontSize="xs" color="fg.muted">
                  Your next message continues the existing conversation — no new thread.
                </Text>
              </VStack>
              <Dialog.CloseTrigger asChild>
                <CloseButton size="sm" />
              </Dialog.CloseTrigger>
            </Dialog.Header>

            <Dialog.Body>
              <VStack align="stretch" gap={4}>
                <Box bg="bg.subtle" borderWidth="1px" borderColor="border" rounded="lg" px={3} py={2.5}>
                  <HStack justify="space-between" gap={3} wrap="wrap">
                    <Text fontSize="xs" color="fg.muted">
                      With
                    </Text>
                    <Text fontSize="sm" fontWeight="medium">
                      {seed.counterpartyEmail}
                    </Text>
                  </HStack>
                  <HStack justify="space-between" gap={3} wrap="wrap" mt={1}>
                    <Text fontSize="xs" color="fg.muted">
                      Thread
                    </Text>
                    <Text fontSize="xs" color={seed.threadId ? 'fg' : 'fg.subtle'}>
                      {seed.threadId ?? 'found by address on the mailbox below'}
                    </Text>
                  </HStack>
                </Box>

                <Field.Root>
                  <Field.Label>Our mailbox</Field.Label>
                  <NativeSelect.Root size="sm">
                    <NativeSelect.Field value={accountId} onChange={(e) => setAccountId(e.target.value)}>
                      {accounts.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.email}
                        </option>
                      ))}
                    </NativeSelect.Field>
                    <NativeSelect.Indicator />
                  </NativeSelect.Root>
                  <Field.HelperText>
                    {seed.accountEmail
                      ? `They replied to ${seed.accountEmail} — the thread lives in that mailbox.`
                      : 'A thread belongs to one mailbox; pick the one this conversation is in.'}
                  </Field.HelperText>
                </Field.Root>

                <Field.Root>
                  <Field.Label>Site(s) being bought</Field.Label>
                  <Input
                    size="sm"
                    placeholder="site.com, othersite.com"
                    value={domains}
                    onChange={(e) => setDomains(e.target.value)}
                  />
                  <Field.HelperText>Each becomes a draft post you can price and mark paid.</Field.HelperText>
                </Field.Root>

                <Field.Root>
                  <Field.Label>Note (optional)</Field.Label>
                  <Textarea
                    size="sm"
                    rows={2}
                    placeholder="What you agreed so far, what to watch for…"
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                  />
                </Field.Root>

                <Text fontSize="xs" color="fg.muted">
                  While the deal is open this thread is held: replies are stored and labelled{' '}
                  <b>AS/Deal</b>, and never sent to the extractor — nothing said mid-negotiation can
                  rewrite a price. If a deal is already open on it you'll be taken there instead.
                </Text>
              </VStack>
            </Dialog.Body>

            <Dialog.Footer>
              <Button size="sm" variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <Button size="sm" colorPalette="brand" loading={busy} disabled={!accountId} onClick={submit}>
                Open deal
              </Button>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
