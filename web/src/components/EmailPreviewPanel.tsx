import {
  Box,
  Button,
  Field,
  Heading,
  HStack,
  Input,
  Spinner,
  Text,
} from '@chakra-ui/react';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { Campaign } from '../types';
import { Panel } from './Panel';

interface Preview {
  subject: string;
  body: string;
  senderName: string;
  senderEmail: string;
}

export function EmailPreviewPanel({
  campaign,
  onClose,
}: {
  campaign: Campaign;
  onClose: () => void;
}) {
  const [websiteUrl, setWebsiteUrl] = useState('example.com');
  const [contactName, setContactName] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      setLoading(true);
      setError(null);
      try {
        const result = await api.previewEmail(campaign.id, {
          websiteUrl: websiteUrl.trim() || 'example.com',
          contactName: contactName.trim() || undefined,
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
  }, [campaign.id, websiteUrl, contactName]);

  return (
    <Panel p={5} mb={4}>
      <HStack mb={4} align="baseline" justify="space-between">
        <HStack align="baseline">
          <Heading size="sm">Email preview</Heading>
          <Text color="fg.muted" fontSize="sm">
            — {campaign.name}
          </Text>
        </HStack>
        <Button size="xs" variant="ghost" onClick={onClose}>
          Close
        </Button>
      </HStack>

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
          {/* Email chrome */}
          <Box px={4} py={3} borderBottomWidth="1px" borderColor="border" bg="bg.muted">
            <HStack gap={2} mb={1}>
              <Text fontSize="xs" color="fg.subtle" minW="40px">From</Text>
              <Text fontSize="xs" color="fg">
                {preview.senderName} &lt;{preview.senderEmail}&gt;
              </Text>
            </HStack>
            <HStack gap={2}>
              <Text fontSize="xs" color="fg.subtle" minW="40px">Subject</Text>
              <Text fontSize="xs" fontWeight="semibold" color="fg">
                {preview.subject}
              </Text>
            </HStack>
          </Box>

          {/* Body */}
          <Box px={4} py={4}>
            <Text
              as="pre"
              fontSize="sm"
              whiteSpace="pre-wrap"
              fontFamily="inherit"
              lineHeight="1.7"
              color="fg"
            >
              {preview.body}
            </Text>
          </Box>
        </Box>
      ) : loading ? (
        <Box py={8} display="flex" justifyContent="center">
          <Spinner color="brand.solid" />
        </Box>
      ) : null}
    </Panel>
  );
}
