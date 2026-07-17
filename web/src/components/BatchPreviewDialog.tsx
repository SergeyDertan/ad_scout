import {
  Box,
  CloseButton,
  Dialog,
  Field,
  HStack,
  Input,
  Portal,
  Spinner,
  Text,
} from '@chakra-ui/react';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { BatchRow } from '../types';

interface Preview {
  subject: string;
  body: string;
  senderName: string;
  senderEmail: string;
}

/** Renders the outreach email a batch's targets would receive — the batch's
 *  advertised override (if any) is applied on top of the global pitch profile. */
export function BatchPreviewDialog({ batch, onClose }: { batch: BatchRow; onClose: () => void }) {
  const [websiteUrl, setWebsiteUrl] = useState('example.com');
  const [contactName, setContactName] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const label = batch.name?.trim() || `batch ${batch.id.replace(/^batch_/, '').slice(0, 8)}`;

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      setLoading(true);
      setError(null);
      try {
        const result = await api.previewEmail({
          websiteUrl: websiteUrl.trim() || 'example.com',
          contactName: contactName.trim() || undefined,
          ...(batch.advertised ? { advertised: batch.advertised } : {}),
        });
        setPreview(result);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    }, 350);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [batch.advertised, websiteUrl, contactName]);

  return (
    <Dialog.Root open onOpenChange={(e) => { if (!e.open) onClose(); }} size="xl" placement="center" scrollBehavior="inside">
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content rounded="xl" maxW="720px">
            <Dialog.Header>
              <Dialog.Title>Email preview</Dialog.Title>
              <Text fontSize="xs" color="fg.muted">
                {label}
                {batch.advertised ? ` · advertising ${batch.advertised.url}` : ' · global advertised default'}
              </Text>
              <Dialog.CloseTrigger asChild>
                <CloseButton size="sm" />
              </Dialog.CloseTrigger>
            </Dialog.Header>

            <Dialog.Body>
              <HStack mb={5} gap={4} flexWrap={{ base: 'wrap', md: 'nowrap' }}>
                <Field.Root flex="1">
                  <Field.Label fontSize="xs" color="fg.muted">Target website</Field.Label>
                  <Input
                    size="sm"
                    placeholder="egamersworld.com"
                    value={websiteUrl}
                    onChange={(e) => setWebsiteUrl(e.target.value)}
                    autoFocus
                  />
                </Field.Root>
                <Field.Root flex="1">
                  <Field.Label fontSize="xs" color="fg.muted">Contact name (optional)</Field.Label>
                  <Input
                    size="sm"
                    placeholder="fallback: site domain"
                    value={contactName}
                    onChange={(e) => setContactName(e.target.value)}
                  />
                </Field.Root>
              </HStack>

              {error && (
                <Text color="red.fg" fontSize="sm" mb={3}>
                  {error}
                </Text>
              )}

              {preview ? (
                <Box
                  bg="bg.subtle"
                  borderWidth="1px"
                  borderColor="border"
                  rounded="lg"
                  overflow="hidden"
                  opacity={loading ? 0.6 : 1}
                  transition="opacity 0.15s"
                >
                  <Box px={4} py={3} borderBottomWidth="1px" borderColor="border" bg="bg.muted">
                    <HStack gap={2} mb={1}>
                      <Text fontSize="xs" color="fg.subtle" minW="48px">From</Text>
                      <Text fontSize="xs" color="fg">
                        {preview.senderName} &lt;{preview.senderEmail}&gt;
                      </Text>
                    </HStack>
                    <HStack gap={2}>
                      <Text fontSize="xs" color="fg.subtle" minW="48px">Subject</Text>
                      <Text fontSize="xs" fontWeight="semibold" color="fg">
                        {preview.subject}
                      </Text>
                    </HStack>
                  </Box>
                  <Box px={4} py={4}>
                    <Text as="pre" fontSize="sm" whiteSpace="pre-wrap" fontFamily="inherit" lineHeight="1.7" color="fg">
                      {preview.body}
                    </Text>
                  </Box>
                </Box>
              ) : loading ? (
                <Box py={8} display="flex" justifyContent="center">
                  <Spinner color="brand.solid" />
                </Box>
              ) : null}
            </Dialog.Body>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
