// Everything about ONE extraction, in one place — the view you open when a price
// looks wrong and you need to know why. Four questions, in the order you ask them:
//   1. What arrived?      the email, and which mailbox/thread/ids it arrived under
//   2. What did we send?  the exact system prompt, and how the ask was framed
//   3. What ran it?       provider, model, prompt fingerprint, when — or a human
//   4. What came out?     the AI's explanation, the offers, the records written
// Sourced from GET /api/replies/:id/debug, which does the joining server-side.

import { useEffect, useState } from 'react';
import {
  Badge,
  Box,
  Clipboard,
  CloseButton,
  Dialog,
  Heading,
  HStack,
  IconButton,
  Portal,
  SimpleGrid,
  Spinner,
  Table,
  Text,
  VStack,
} from '@chakra-ui/react';
import { api } from '../api';
import {
  formatPrice,
  formatProvenance,
  formatTerm,
  type ExtractionDebug,
} from '../types';
import { AlertTriangleIcon } from './icons';

const fmtDateTime = (iso?: string) => (iso ? new Date(iso).toLocaleString() : '—');

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Box>
      <Heading size="xs" color="fg.muted" textTransform="uppercase" letterSpacing="wider" mb={2}>
        {title}
      </Heading>
      {children}
    </Box>
  );
}

/** A labelled value. `mono` for ids you may need to paste into a mail client. */
function Field({ label, value, mono }: { label: string; value?: string; mono?: boolean }) {
  return (
    <Box minW={0}>
      <Text fontSize="2xs" color="fg.muted" fontWeight="semibold" textTransform="uppercase" letterSpacing="wider" mb={0.5}>
        {label}
      </Text>
      {value ? (
        <HStack gap={1} align="start">
          <Text fontSize="sm" fontFamily={mono ? 'mono' : undefined} wordBreak="break-all">{value}</Text>
          {mono && (
            <Clipboard.Root value={value}>
              <Clipboard.Trigger asChild>
                <IconButton aria-label={`Copy ${label}`} size="2xs" variant="ghost">
                  <Clipboard.Indicator />
                </IconButton>
              </Clipboard.Trigger>
            </Clipboard.Root>
          )}
        </HStack>
      ) : (
        <Text fontSize="sm" color="fg.subtle">—</Text>
      )}
    </Box>
  );
}

/** Long text (the email body, the prompt) in a bounded scroll box. */
function Pre({ text, maxH = '260px' }: { text: string; maxH?: string }) {
  return (
    <Box bg="bg.subtle" borderWidth="1px" borderColor="border" rounded="md" p={3} maxH={maxH} overflowY="auto">
      <Text as="pre" fontSize="xs" whiteSpace="pre-wrap" fontFamily="mono" lineHeight="1.6">
        {text || '(empty)'}
      </Text>
    </Box>
  );
}

export function ExtractionDebugModal({ replyId, onClose }: { replyId: string; onClose: () => void }) {
  const [data, setData] = useState<ExtractionDebug | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setData(null);
    setError(null);
    api.getReplyDebug(replyId)
      .then((d) => live && setData(d))
      .catch((e) => live && setError(String(e)));
    return () => { live = false; };
  }, [replyId]);

  const reply = data?.reply;
  const parsed = reply?.parsed;
  const prov = reply?.extraction;

  return (
    <Dialog.Root open onOpenChange={(e) => { if (!e.open) onClose(); }} size="xl" placement="center" scrollBehavior="inside">
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content rounded="xl" maxW="960px">
            <Dialog.Header>
              <VStack align="start" gap={0.5}>
                <Dialog.Title>Extraction debug</Dialog.Title>
                <Text fontSize="sm" color="fg.muted">{reply?.fromAddress ?? replyId}</Text>
              </VStack>
              <Dialog.CloseTrigger asChild>
                <CloseButton size="sm" />
              </Dialog.CloseTrigger>
            </Dialog.Header>

            <Dialog.Body>
              {error && (
                <HStack color="red.fg" fontSize="sm" gap={2}>
                  <AlertTriangleIcon boxSize={4} />
                  <Text>{error}</Text>
                </HStack>
              )}
              {!data && !error && (
                <HStack gap={2} color="fg.muted" fontSize="sm"><Spinner size="sm" /><Text>Loading…</Text></HStack>
              )}

              {data && reply && (
                <VStack align="stretch" gap={5}>
                  {/* 1. What arrived */}
                  <Section title="Inbound email">
                    <SimpleGrid columns={{ base: 1, md: 3 }} gap={3} mb={3}>
                      <Field label="From" value={reply.fromAddress} />
                      <Field label="Mailbox (received in)" value={data.mailbox?.email} />
                      <Field label="Received" value={fmtDateTime(reply.receivedAt)} />
                      <Field label="Subject" value={reply.subject} />
                      <Field label="Matched by" value={reply.matchMethod} />
                      <Field label="Extraction status" value={reply.extractionStatus} />
                      <Field label="Email id" value={reply.emailId} mono />
                      <Field label="Thread id" value={reply.threadId} mono />
                      <Field label="Message-Id" value={reply.rfcMessageId} mono />
                    </SimpleGrid>
                    <Pre text={reply.text ?? ''} />
                    {reply.attachments && reply.attachments.length > 0 && (
                      <HStack gap={2} mt={2} flexWrap="wrap">
                        {reply.attachments.map((a, i) => (
                          <Badge key={`${a.filename}-${i}`} size="sm" variant="surface">
                            {a.filename} ({a.mimeType})
                          </Badge>
                        ))}
                      </HStack>
                    )}
                  </Section>

                  {/* Who we were writing to — the framing that decides how a
                      niche-less price is read. */}
                  <Section title="Outreach context">
                    <SimpleGrid columns={{ base: 1, md: 3 }} gap={3}>
                      <Field label="Site we contacted" value={data.target?.websiteUrl} />
                      <Field label="Contact" value={data.target?.contactEmail} />
                      <Field label="Target status" value={data.target?.status} />
                      <Field label="Batch" value={data.target?.batchName ?? data.target?.batchId} />
                      <Field
                        label="Pitch style"
                        value={
                          data.pitchStyle === 'casino'
                            ? 'casino — a bare price is the CASINO rate'
                            : 'broad — a bare price is the REGULAR rate'
                        }
                      />
                    </SimpleGrid>
                  </Section>

                  {/* 3. What ran it */}
                  <Section title="Extraction run">
                    <SimpleGrid columns={{ base: 1, md: 3 }} gap={3} mb={2}>
                      <Field label="Provider" value={prov?.provider} />
                      <Field label="Model" value={prov?.model} />
                      <Field label="Extracted at" value={fmtDateTime(prov?.extractedAt)} />
                      <Field label="Prompt fingerprint" value={prov?.promptHash} mono />
                      <Field label="Prompt variant" value={prov?.promptStyle} />
                    </SimpleGrid>
                    {prov?.editedByHuman && (
                      <HStack gap={2}>
                        <Badge size="sm" colorPalette="green" variant="subtle">edited by hand</Badge>
                        <Text fontSize="xs" color="fg.muted">
                          Corrected {fmtDateTime(prov.editedAt)} — the values below are a person's, not the model's.
                        </Text>
                      </HStack>
                    )}
                    {!prov && (
                      <Text fontSize="sm" color="fg.subtle">
                        No run recorded — this reply predates extraction provenance.
                      </Text>
                    )}
                  </Section>

                  {/* 2. What we sent it */}
                  <Section title="System prompt">
                    {data.prompt ? (
                      <>
                        <HStack gap={2} mb={2} fontSize="xs" color="fg.muted" flexWrap="wrap">
                          <Text>Archived as <Text as="span" fontFamily="mono">{data.prompt.hash}</Text></Text>
                          <Text>· variant {data.prompt.style}</Text>
                          <Text>· first used {fmtDateTime(data.prompt.firstSeenAt)}</Text>
                          <Clipboard.Root value={data.prompt.text}>
                            <Clipboard.Trigger asChild>
                              <IconButton aria-label="Copy prompt" size="2xs" variant="ghost">
                                <Clipboard.Indicator />
                              </IconButton>
                            </Clipboard.Trigger>
                          </Clipboard.Root>
                        </HStack>
                        <Pre text={data.prompt.text} maxH="320px" />
                      </>
                    ) : (
                      <Text fontSize="sm" color="fg.subtle">
                        {prov?.promptHash
                          ? `Prompt ${prov.promptHash} is not in the archive (it ran before prompts were archived).`
                          : 'No prompt recorded for this reply.'}
                      </Text>
                    )}
                  </Section>

                  {/* 4. What came out */}
                  <Section title="What the AI concluded">
                    <SimpleGrid columns={{ base: 1, md: 3 }} gap={3} mb={3}>
                      <Field label="Intent" value={parsed?.intent} />
                      <Field label="Can post" value={parsed?.canPost} />
                      <Field label="Opted out" value={parsed?.optOut ? 'yes' : 'no'} />
                    </SimpleGrid>
                    {parsed?.aiExplanation && (
                      <Box bg="bg.subtle" borderWidth="1px" borderColor="border" rounded="md" px={3} py={2} mb={3}>
                        <Text fontSize="xs" fontWeight="semibold" color="fg.muted" mb={1}>Why it read the reply this way</Text>
                        <Text fontSize="sm" lineHeight="1.6">{parsed.aiExplanation}</Text>
                      </Box>
                    )}
                    {parsed?.reasoning && (
                      <Text fontSize="sm" color="fg.muted" fontStyle="italic" mb={3}>{parsed.reasoning}</Text>
                    )}
                    {(parsed?.conditions || parsed?.notes) && (
                      <SimpleGrid columns={{ base: 1, md: 2 }} gap={3} mb={3}>
                        <Field label="Conditions" value={parsed?.conditions} />
                        <Field label="Notes" value={parsed?.notes} />
                      </SimpleGrid>
                    )}
                    {reply.review && reply.review.length > 0 && (
                      <Box bg="orange.subtle" color="orange.fg" rounded="md" px={3} py={2}>
                        <HStack gap={1.5} mb={1} fontWeight="semibold" fontSize="xs">
                          <AlertTriangleIcon boxSize={3.5} />
                          <Text>Flagged for review</Text>
                        </HStack>
                        <VStack align="stretch" gap={0.5}>
                          {reply.review.map((r, i) => <Text key={i} fontSize="xs">• {r}</Text>)}
                        </VStack>
                      </Box>
                    )}
                  </Section>

                  {/* The end of the chain: what actually got stored, per domain. */}
                  <Section title={`Price records written (${data.priceRecords.length})`}>
                    {data.priceRecords.length === 0 ? (
                      <Text fontSize="sm" color="fg.subtle">
                        None — this reply produced no stored prices.
                      </Text>
                    ) : (
                      <Box borderWidth="1px" borderColor="border" rounded="md" overflow="hidden">
                        <Table.Root size="sm" variant="line">
                          <Table.Header>
                            <Table.Row bg="bg.subtle">
                              <Table.ColumnHeader>Domain</Table.ColumnHeader>
                              <Table.ColumnHeader>Attributed</Table.ColumnHeader>
                              <Table.ColumnHeader>Niche</Table.ColumnHeader>
                              <Table.ColumnHeader>Price</Table.ColumnHeader>
                              <Table.ColumnHeader>Term</Table.ColumnHeader>
                            </Table.Row>
                          </Table.Header>
                          <Table.Body>
                            {data.priceRecords.flatMap((rec) =>
                              rec.offers.length === 0
                                ? [(
                                    <Table.Row key={rec.id}>
                                      <Table.Cell fontWeight="medium">{rec.domain}</Table.Cell>
                                      <Table.Cell>{rec.attribution}</Table.Cell>
                                      <Table.Cell colSpan={3} color="fg.subtle">
                                        can post, no price
                                      </Table.Cell>
                                    </Table.Row>
                                  )]
                                : rec.offers.map((o, i) => (
                                    <Table.Row key={`${rec.id}-${i}`}>
                                      <Table.Cell fontWeight="medium">{i === 0 ? rec.domain : ''}</Table.Cell>
                                      <Table.Cell>{i === 0 ? rec.attribution : ''}</Table.Cell>
                                      <Table.Cell>{o.label || o.category}</Table.Cell>
                                      <Table.Cell>{formatPrice(o.price)}</Table.Cell>
                                      <Table.Cell color="fg.muted">{formatTerm(o.term)}</Table.Cell>
                                    </Table.Row>
                                  )),
                            )}
                          </Table.Body>
                        </Table.Root>
                      </Box>
                    )}
                    <Text fontSize="xs" color="fg.subtle" mt={2}>{formatProvenance(prov)}</Text>
                  </Section>
                </VStack>
              )}
            </Dialog.Body>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
