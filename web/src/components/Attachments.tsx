// The files on a message, on every screen that shows one — in both directions.
//
// There were three copies of this — one in the deal timeline, one in the reply
// modal, one on a domain — and all three rendered a grey label so quiet that a
// rate card attached to a reply read as part of the body text. A rate card is
// often the ENTIRE answer, so it gets a real affordance: a clip, the file name,
// its size, and a border that says it can be clicked.
//
// An IMAGE gets more than that. A screenshot is not a document you open later,
// it is the message — of a broken layout, of a published post, of a payment
// confirmation — so it is shown, not named. Because this one component serves
// every screen, the previews arrive on publishers' screenshots at the same time
// as on ours.

import { Box, IconButton, Image, Link, Text, Wrap } from '@chakra-ui/react';
import { useState } from 'react';

import type { EmailAttachment } from '../types';
import { PaperclipIcon, XIcon } from './icons';

/** Bytes, in the unit a person would say. Never "0 KB" for a real file. */
function fmtSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The bytes are already here — the message carries them base64, so there is
 *  nothing to ask the server for. */
function dataUrl(a: EmailAttachment): string {
  return `data:${a.mimeType};base64,${a.contentBase64}`;
}

function isImage(a: EmailAttachment): boolean {
  return a.mimeType.startsWith('image/');
}

/** The frame every attachment sits in, whatever it holds. */
const TILE = {
  bg: 'bg.panel',
  color: 'fg',
  borderWidth: '1px',
  borderColor: 'border',
  rounded: 'md',
  boxShadow: 'xs',
  maxW: 'full',
  minW: 0,
} as const;

/** Name + size, the line under a preview and the whole of a document chip. */
function Caption({ a, showType }: { a: EmailAttachment; showType?: boolean }) {
  return (
    <>
      <Box minW={0}>
        <Text truncate fontWeight="medium">
          {a.filename}
        </Text>
        {showType && (
          <Text color="fg.subtle" fontSize="2xs">
            {a.mimeType}
          </Text>
        )}
      </Box>
      <Text color="fg.subtle" flexShrink={0}>
        {fmtSize(a.size)}
      </Text>
    </>
  );
}

/**
 * One attachment: a preview if it is an image we can actually render, a chip
 * otherwise.
 *
 * `broken` is not defensive noise. An image part can arrive truncated or with a
 * mimeType that lies, and a preview that fails silently leaves an empty box
 * where the message was — falling back to the chip keeps the file reachable.
 */
function Tile({ a, compact }: { a: EmailAttachment; compact?: boolean }) {
  const [broken, setBroken] = useState(false);

  if (isImage(a) && !broken) {
    return (
      <Box display="block" p={1} fontSize="xs" {...TILE}>
        <Image
          src={dataUrl(a)}
          alt={a.filename}
          onError={() => setBroken(true)}
          maxH={compact ? '11rem' : '15rem'}
          maxW="full"
          rounded="sm"
          objectFit="contain"
          bg="bg.subtle"
        />
        <Box display="flex" alignItems="center" gap={2} px={1.5} pt={1.5} pb={0.5}>
          <PaperclipIcon boxSize={3} color="fg.muted" flexShrink={0} />
          <Caption a={a} />
        </Box>
      </Box>
    );
  }

  return (
    <Box
      display="inline-flex"
      alignItems="center"
      gap={2}
      px={2.5}
      py={1.5}
      fontSize="xs"
      {...TILE}
    >
      <PaperclipIcon boxSize={3.5} color="fg.muted" flexShrink={0} />
      <Caption a={a} showType={!compact} />
    </Box>
  );
}

export function Attachments({
  attachments,
  /** Rendered inside a message bubble, where the space above is already tight. */
  compact,
  /** Given for files not yet sent: makes each tile removable instead of
   *  downloadable, which is what the composer wants. */
  onRemove,
}: {
  attachments?: EmailAttachment[];
  compact?: boolean;
  onRemove?: (index: number) => void;
}) {
  if (!attachments || attachments.length === 0) return null;
  return (
    <Wrap gap={2} mt={compact ? 2 : 0}>
      {attachments.map((a, i) =>
        onRemove ? (
          // A file still being composed has nothing to download — the gesture
          // that belongs on it is "not that one".
          <Box key={`${a.filename}-${i}`} position="relative">
            <Tile a={a} compact />
            <IconButton
              size="2xs"
              variant="outline"
              aria-label={`Remove ${a.filename}`}
              title={`Remove ${a.filename}`}
              onClick={() => onRemove(i)}
              position="absolute"
              top="-8px"
              insetEnd="-8px"
              bg="bg.panel"
              color="fg.muted"
              rounded="full"
              boxShadow="xs"
              _hover={{ color: 'red.fg', borderColor: 'red.muted' }}
            >
              <XIcon boxSize={3} />
            </IconButton>
          </Box>
        ) : (
          <Link
            key={`${a.filename}-${i}`}
            href={dataUrl(a)}
            download={a.filename}
            title={`${a.filename} — ${a.mimeType}`}
            maxW="full"
            minW={0}
            color="fg"
            _hover={{ textDecoration: 'none', opacity: 0.9 }}
          >
            <Tile a={a} compact={compact} />
          </Link>
        ),
      )}
    </Wrap>
  );
}
