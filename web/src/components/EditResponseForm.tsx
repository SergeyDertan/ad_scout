import {
  Box,
  Button,
  Checkbox,
  Heading,
  HStack,
  IconButton,
  Input,
  NativeSelect,
  Text,
  VStack,
} from '@chakra-ui/react';
import { useState } from 'react';
import { api } from '../api';
import { type ResponseRow } from '../types';
import { Panel } from './Panel';
import { toaster, toastError } from './Toaster';
import { PlusIcon, TrashIcon } from './icons';

interface OfferRow {
  category: string; // '' for a new offer — server derives it from the label
  label: string;
  sensitive: boolean;
  canPost: string;
  priceRaw: string;
  /** The site this price is for; '' = the contacted site. One reply often prices
   *  a whole portfolio, and this is what keeps those rows distinct — the server
   *  cell key is website|niche|special, so blanking it MERGES rows and
   *  silently drops every domain but the first. */
  website: string;
  /** The placement duration this price buys, in the publisher's own words ('' =
   *  none stated). Also part of the server cell key (website|niche|special|term),
   *  so blanking it merges a publisher's monthly and yearly rates into one row. */
  termRaw: string;
  /** Promo flags. Not editable here, but they also scope the server cell key, so
   *  they must round-trip or a special collapses into the standing price. */
  isSpecial?: boolean;
  specialUntil?: string;
}

function toRows(row: ResponseRow): OfferRow[] {
  return (row.parsed?.offers ?? []).map((o) => ({
    category: o.category,
    label: o.label,
    sensitive: o.sensitive,
    canPost: o.canPost,
    priceRaw: o.price?.raw ?? '',
    website: o.website ?? '',
    termRaw: o.term?.raw ?? '',
    ...(o.isSpecial ? { isSpecial: true } : {}),
    ...(o.specialUntil ? { specialUntil: o.specialUntil } : {}),
  }));
}

/** Human correction of an AI-extracted reply: edit the niche offers + willingness
 *  + price, then save. Saving clears the review flag on the reply. */
export function EditResponseForm({
  row,
  onClose,
  onSaved,
}: {
  row: ResponseRow;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [offers, setOffers] = useState<OfferRow[]>(toRows(row));
  const [optOut, setOptOut] = useState(Boolean(row.parsed?.optOut));
  const [busy, setBusy] = useState(false);

  const update = (i: number, patch: Partial<OfferRow>) =>
    setOffers((prev) => prev.map((o, j) => (j === i ? { ...o, ...patch } : o)));
  const remove = (i: number) => setOffers((prev) => prev.filter((_, j) => j !== i));
  const add = () =>
    setOffers((prev) => [
      ...prev,
      { category: '', label: '', sensitive: false, canPost: 'yes', priceRaw: '', website: '', termRaw: '' },
    ]);

  const valid = offers.every((o) => o.label.trim() !== '');

  const submit = async () => {
    if (!valid) return;
    setBusy(true);
    try {
      await api.patchReply(row.id, {
        optOut,
        offers: offers.map((o) => ({
          category: o.category,
          label: o.label.trim(),
          sensitive: o.sensitive,
          canPost: o.canPost,
          priceRaw: o.priceRaw.trim(),
          website: o.website.trim(),
          termRaw: o.termRaw.trim(),
          ...(o.isSpecial ? { isSpecial: true } : {}),
          ...(o.specialUntil ? { specialUntil: o.specialUntil } : {}),
        })),
      });
      toaster.create({ type: 'success', title: 'Response updated' });
      onSaved();
      onClose();
    } catch (e) {
      toastError('Could not update response', e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel p={5} mb={4}>
      <HStack mb={1} align="baseline">
        <Heading size="sm">Edit response</Heading>
        <Text color="fg.muted" fontSize="sm">
          — {row.fromAddress}
        </Text>
      </HStack>
      {row.review && row.review.length > 0 && (
        <VStack align="start" gap={0.5} mb={3} mt={2}>
          {row.review.map((r, i) => (
            <Text key={i} fontSize="xs" color="orange.fg">
              • {r}
            </Text>
          ))}
        </VStack>
      )}

      <VStack align="stretch" gap={2} mt={3}>
        <HStack fontSize="xs" color="fg.muted" fontWeight="medium" px={1}>
          <Box flex="1">Niche</Box>
          <Box flex="1">Site</Box>
          <Box w="20">Sensitive</Box>
          <Box w="28">Willing</Box>
          <Box w="32">Price</Box>
          <Box w="28">Term</Box>
          <Box w="8" />
        </HStack>

        {offers.map((o, i) => (
          <HStack key={i} gap={2}>
            <Input
              flex="1"
              size="sm"
              placeholder="casino, regular, …"
              value={o.label}
              onChange={(e) => update(i, { label: e.target.value })}
            />
            <Input
              flex="1"
              size="sm"
              placeholder={row.website ?? 'this site'}
              value={o.website}
              onChange={(e) => update(i, { website: e.target.value })}
            />
            <Box w="20" textAlign="center">
              <Checkbox.Root
                checked={o.sensitive}
                onCheckedChange={(d) => update(i, { sensitive: Boolean(d.checked) })}
              >
                <Checkbox.HiddenInput />
                <Checkbox.Control />
              </Checkbox.Root>
            </Box>
            <NativeSelect.Root size="sm" w="28">
              <NativeSelect.Field value={o.canPost} onChange={(e) => update(i, { canPost: e.target.value })}>
                <option value="yes">yes</option>
                <option value="maybe">maybe</option>
                <option value="no">no</option>
              </NativeSelect.Field>
              <NativeSelect.Indicator />
            </NativeSelect.Root>
            <Input
              w="32"
              size="sm"
              placeholder="$150"
              value={o.priceRaw}
              onChange={(e) => update(i, { priceRaw: e.target.value })}
            />
            <Input
              w="28"
              size="sm"
              placeholder="1 month"
              title="How long this price buys the placement for. Leave blank for a normal one-off post."
              value={o.termRaw}
              onChange={(e) => update(i, { termRaw: e.target.value })}
            />
            <IconButton aria-label="Remove offer" size="sm" variant="ghost" onClick={() => remove(i)}>
              <TrashIcon boxSize={4} />
            </IconButton>
          </HStack>
        ))}

        <Button size="sm" variant="ghost" alignSelf="start" onClick={add}>
          <PlusIcon boxSize={4} /> Add niche
        </Button>
      </VStack>

      <HStack mt={4} justify="space-between">
        <Checkbox.Root checked={optOut} onCheckedChange={(d) => setOptOut(Boolean(d.checked))}>
          <Checkbox.HiddenInput />
          <Checkbox.Control />
          <Checkbox.Label fontSize="sm">Opted out / do not contact</Checkbox.Label>
        </Checkbox.Root>
        <HStack>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button colorPalette="brand" onClick={submit} loading={busy} disabled={!valid}>
            Save
          </Button>
        </HStack>
      </HStack>
    </Panel>
  );
}
