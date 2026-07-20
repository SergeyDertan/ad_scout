import { Fragment } from 'react';
import {
  Badge,
  Box,
  Button,
  CloseButton,
  Dialog,
  Heading,
  HStack,
  Link,
  Portal,
  SimpleGrid,
  Table,
  Text,
  VStack,
  Wrap,
} from '@chakra-ui/react';
import {
  formatPrice,
  invertedPriceOffers,
  offerCellKey,
  offerSite,
  postTypeLabel,
  type EmailAttachment,
  type PostOffer,
  type ResponseRow,
} from '../types';
import { StatusBadge } from './StatusBadge';
import { ThreadTimeline } from './ThreadPanel';
import { AlertTriangleIcon } from './icons';

const INTENT_LABELS: Record<string, string> = {
  holding: 'holding — no answer yet',
  auto_reply: 'auto-reply',
  question: 'asked a question',
  decline: 'declined',
  answer: 'answered',
};

/** One labelled row in the summary grid. */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Box>
      <Text fontSize="2xs" color="fg.muted" fontWeight="semibold" textTransform="uppercase" letterSpacing="wider" mb={1}>
        {label}
      </Text>
      <Box fontSize="sm">{children}</Box>
    </Box>
  );
}

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

/** Offers sorted by product, then regular before sensitive, then niche — so the
 *  two axes read clearly (all guest posts, then links…). */
function sortOffers(offers: PostOffer[]): PostOffer[] {
  return [...offers].sort((a, b) =>
    (a.postType || 'guest_post').localeCompare(b.postType || 'guest_post') ||
    Number(a.sensitive) - Number(b.sensitive) ||
    a.category.localeCompare(b.category),
  );
}

/**
 * Split offers into per-site rate cards. A single reply often prices a whole
 * portfolio — the contacted site, plus other domains the owner tags via
 * `offer.website` — and without this split the modal shows a stack of
 * indistinguishable "Guest post / Regular" rows at different prices.
 *
 * The contacted site sorts first (untagged offers belong to it); the rest
 * follow alphabetically.
 */
function groupOffersBySite(offers: PostOffer[], contactedSite?: string): { site: string; offers: PostOffer[] }[] {
  const bySite = new Map<string, PostOffer[]>();
  for (const o of offers) {
    const site = offerSite(o);
    (bySite.get(site) ?? bySite.set(site, []).get(site)!).push(o);
  }
  return [...bySite.entries()]
    .map(([site, group]) => ({
      // Untagged offers are the contacted site's own prices.
      site: site || contactedSite?.trim().toLowerCase() || 'this site',
      isOwn: site === '',
      offers: sortOffers(group),
    }))
    .sort((a, b) => Number(b.isOwn) - Number(a.isOwn) || a.site.localeCompare(b.site))
    .map(({ site, offers: group }) => ({ site, offers: group }));
}

/** Every AI-extracted offer (product × niche) with its price, flagging inverted
 *  price order. Grouped by site, since one reply can price several domains. */
function OffersTable({ offers, contactedSite }: { offers?: PostOffer[]; contactedSite?: string }) {
  if (!offers || offers.length === 0) return <Text color="fg.subtle" fontSize="sm">No priced offers.</Text>;
  const inverted = invertedPriceOffers(offers);
  const groups = groupOffersBySite(offers, contactedSite);
  const multiSite = groups.length > 1;
  return (
    <Box borderWidth="1px" borderColor="border" rounded="lg" overflow="hidden">
      <Table.Root size="sm" variant="line">
        <Table.Header>
          <Table.Row bg="bg.subtle">
            <Table.ColumnHeader>Product</Table.ColumnHeader>
            <Table.ColumnHeader>Niche</Table.ColumnHeader>
            <Table.ColumnHeader>Sensitive</Table.ColumnHeader>
            <Table.ColumnHeader>Can post</Table.ColumnHeader>
            <Table.ColumnHeader textAlign="end">Price</Table.ColumnHeader>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {groups.map(({ site, offers: group }, gi) => (
            <Fragment key={site}>
              {multiSite && (
                <Table.Row bg="bg.muted">
                  <Table.Cell colSpan={5} py={1.5} borderTopWidth={gi === 0 ? undefined : '1px'} borderColor="border">
                    <HStack gap={2}>
                      <Text fontSize="xs" fontWeight="bold">{site}</Text>
                      {gi === 0 && (
                        <Badge size="xs" colorPalette="blue" variant="subtle">contacted site</Badge>
                      )}
                    </HStack>
                  </Table.Cell>
                </Table.Row>
              )}
              {group.map((o) => {
                const flagged = inverted.has(offerCellKey(o));
                return (
                  <Table.Row key={offerCellKey(o)} bg={flagged ? 'red.subtle' : undefined}>
                    <Table.Cell color="fg.muted">{postTypeLabel(o.postType)}</Table.Cell>
                    <Table.Cell fontWeight="medium">{o.label}</Table.Cell>
                    <Table.Cell>
                      {o.sensitive ? (
                        <Badge size="xs" colorPalette="orange" variant="subtle">sensitive</Badge>
                      ) : (
                        <Text color="fg.subtle">—</Text>
                      )}
                    </Table.Cell>
                    <Table.Cell><StatusBadge value={o.canPost} /></Table.Cell>
                    <Table.Cell textAlign="end" fontWeight="semibold" color={flagged ? 'red.fg' : 'fg'}>
                      {formatPrice(o.price)}
                    </Table.Cell>
                  </Table.Row>
                );
              })}
            </Fragment>
          ))}
        </Table.Body>
      </Table.Root>
      {inverted.size > 0 && (
        <HStack gap={1} color="red.fg" fontSize="xs" fontWeight="semibold" px={3} py={2} bg="red.subtle">
          <AlertTriangleIcon boxSize={3.5} />
          <Text>A regular post is priced above a sensitive one — likely an extraction error, verify against the source.</Text>
        </HStack>
      )}
    </Box>
  );
}

/** Downloadable attachment chips (built from the base64 the reply carries). */
function Attachments({ attachments }: { attachments?: EmailAttachment[] }) {
  if (!attachments || attachments.length === 0) return null;
  return (
    <Section title={`Attachments (${attachments.length})`}>
      <Wrap gap={2}>
        {attachments.map((a, i) => (
          <Link
            key={`${a.filename}-${i}`}
            href={`data:${a.mimeType};base64,${a.contentBase64}`}
            download={a.filename}
            fontSize="xs"
            bg="bg.muted"
            rounded="md"
            px={2.5}
            py={1.5}
            _hover={{ bg: 'bg.subtle', textDecoration: 'none' }}
          >
            <Text as="span" fontWeight="medium">{a.filename}</Text>
            <Text as="span" color="fg.subtle" ml={2}>
              {a.mimeType} · {(a.size / 1024).toFixed(1)} KB
            </Text>
          </Link>
        ))}
      </Wrap>
    </Section>
  );
}

export function ResponseDetailModal({
  row,
  onClose,
  onEdit,
}: {
  row: ResponseRow;
  onClose: () => void;
  onEdit: () => void;
}) {
  const p = row.parsed;
  const reviewReasons = row.review ?? [];

  return (
    <Dialog.Root open onOpenChange={(e) => { if (!e.open) onClose(); }} size="xl" placement="center" scrollBehavior="inside">
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content rounded="xl" maxW="900px">
            <Dialog.Header>
              <VStack align="flex-start" gap={1} flex="1">
                <HStack gap={2} flexWrap="wrap">
                  <Dialog.Title>{row.fromAddress}</Dialog.Title>
                  <StatusBadge value={row.matchMethod} />
                </HStack>
                <Text fontSize="xs" color="fg.muted">
                  {row.website ?? 'no linked website'}
                  {row.batchName ? ` · ${row.batchName}` : ''}
                  {row.receivedAt ? ` · ${new Date(row.receivedAt).toLocaleString()}` : ''}
                </Text>
              </VStack>
            </Dialog.Header>

            <Dialog.Body>
              <VStack align="stretch" gap={5}>
                {/* AI decision */}
                <Section title="AI decision">
                  <SimpleGrid columns={{ base: 2, md: 4 }} gap={4}>
                    <Field label="Extraction">
                      <StatusBadge value={row.extractionStatus} />
                    </Field>
                    <Field label="Can post">
                      {p?.canPost ? <StatusBadge value={p.canPost} /> : <Text color="fg.subtle">—</Text>}
                    </Field>
                    <Field label="Requested niche">
                      {p?.requestedCategory ?? <Text as="span" color="fg.subtle">—</Text>}
                    </Field>
                    <Field label="Intent">
                      {p?.intent ? (INTENT_LABELS[p.intent] ?? p.intent) : <Text as="span" color="fg.subtle">—</Text>}
                    </Field>
                  </SimpleGrid>

                  {p?.optOut && (
                    <Badge mt={3} colorPalette="red" variant="subtle">opted out / unsubscribe</Badge>
                  )}

                  {p?.reasoning && (
                    <Text mt={3} fontSize="sm" color="fg.muted" fontStyle="italic">
                      {p.reasoning}
                    </Text>
                  )}

                  {reviewReasons.length > 0 && (
                    <Box mt={3} bg="orange.subtle" color="orange.fg" rounded="lg" px={3} py={2}>
                      <HStack gap={1.5} mb={1} fontWeight="semibold" fontSize="xs">
                        <AlertTriangleIcon boxSize={3.5} />
                        <Text>Needs review</Text>
                      </HStack>
                      <VStack align="stretch" gap={0.5}>
                        {reviewReasons.map((r, i) => (
                          <Text key={i} fontSize="xs">• {r}</Text>
                        ))}
                      </VStack>
                    </Box>
                  )}
                </Section>

                {/* Prices */}
                <Section title="Niche prices">
                  <OffersTable offers={p?.offers} contactedSite={row.website ?? undefined} />
                </Section>

                <Attachments attachments={row.attachments} />

                {/* Full thread */}
                <Section title="Email thread">
                  {row.targetId ? (
                    <ThreadTimeline targetId={row.targetId} />
                  ) : (
                    <Box>
                      <Text fontSize="xs" color="fg.muted" mb={2}>
                        This reply isn’t linked to a target, so there’s no send history. Raw message:
                      </Text>
                      <Box bg="bg.subtle" borderWidth="1px" borderColor="border" rounded="lg" p={3}>
                        <Text as="pre" fontSize="xs" whiteSpace="pre-wrap" fontFamily="inherit" lineHeight="1.6">
                          {row.text ?? '(no body)'}
                        </Text>
                      </Box>
                    </Box>
                  )}
                </Section>
              </VStack>
            </Dialog.Body>

            <Dialog.Footer gap={2}>
              <Button variant="outline" onClick={onClose}>Close</Button>
              <Button colorPalette="brand" onClick={onEdit}>Edit extraction</Button>
            </Dialog.Footer>

            <Dialog.CloseTrigger asChild>
              <CloseButton size="sm" />
            </Dialog.CloseTrigger>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
