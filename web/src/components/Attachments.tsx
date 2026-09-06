// The files a publisher sent, on every screen that shows their message.
//
// There were three copies of this — one in the deal timeline, one in the reply
// modal, one on a domain — and all three rendered a grey label so quiet that a
// rate card attached to a reply read as part of the body text. A rate card is
// often the ENTIRE answer, so it gets a real affordance: a clip, the file name,
// its size, and a border that says it can be clicked.

import { Box, Link, Text, Wrap } from '@chakra-ui/react';
import type { EmailAttachment } from '../types';
import { PaperclipIcon } from './icons';

/** Bytes, in the unit a person would say. Never "0 KB" for a real file. */
function fmtSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function Attachments({
  attachments,
  /** Rendered inside a message bubble, where the space above is already tight. */
  compact,
}: {
  attachments?: EmailAttachment[];
  compact?: boolean;
}) {
  if (!attachments || attachments.length === 0) return null;
  return (
    <Wrap gap={2} mt={compact ? 2 : 0}>
      {attachments.map((a, i) => (
        <Link
          key={`${a.filename}-${i}`}
          // A data: URL, because the bytes are already here — the reply carries
          // them base64, so there is nothing to ask the server for.
          href={`data:${a.mimeType};base64,${a.contentBase64}`}
          download={a.filename}
          title={`${a.filename} — ${a.mimeType}`}
          display="inline-flex"
          alignItems="center"
          gap={2}
          maxW="full"
          bg="bg.panel"
          color="fg"
          borderWidth="1px"
          borderColor="border"
          rounded="md"
          px={2.5}
          py={1.5}
          fontSize="xs"
          boxShadow="xs"
          _hover={{ bg: 'brand.subtle', borderColor: 'brand.muted', textDecoration: 'none' }}
        >
          <PaperclipIcon boxSize={3.5} color="fg.muted" flexShrink={0} />
          <Box minW={0}>
            <Text truncate fontWeight="medium">
              {a.filename}
            </Text>
            {!compact && (
              <Text color="fg.subtle" fontSize="2xs">
                {a.mimeType}
              </Text>
            )}
          </Box>
          <Text color="fg.subtle" flexShrink={0}>
            {fmtSize(a.size)}
          </Text>
        </Link>
      ))}
    </Wrap>
  );
}
