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
import { POST_TYPE_LABELS, type ResponseRow } from '../types';
import { Panel } from './Panel';
import { toaster, toastError } from './Toaster';
import { PlusIcon, TrashIcon } from './icons';

interface OfferRow {
  postType: string; // product ladder: guest_post | link_insertion | banner
  category: string; // '' for a new offer — server derives it from the label
  label: string;
  sensitive: boolean;
  canPost: string;
  priceRaw: string;
  /** The site this price is for; '' = the contacted site. One reply often prices
   *  a whole portfolio, and this is what keeps those rows distinct — the server
   *  cell key is website|postType|niche|special, so blanking it MERGES rows and
   *  silently drops every domain but the first. */
  website: string;
  /** Promo flags. Not editable here, but they also scope the server cell key, so
   *  they must round-trip or a special collapses into the standing price. */
  isSpecial?: boolean;
  specialUntil?: string;
}

function toRows(row: ResponseRow): OfferRow[] {
  return (row.parsed?.offers ?? []).map((o) => ({
    postType: o.postType || 'guest_post',
    category: o.category,
    label: o.label,
    sensitive: o.sensitive,
    canPost: o.canPost,
    priceRaw: o.price?.raw ?? '',
    website: o.website ?? '',
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
      { postType: 'guest_post', category: '', label: '', sensitive: false, canPost: 'yes', priceRaw: '', website: '' },
    ]);

  const valid = offers.every((o) => o.label.trim() !== '');

  const submit = async () => {
    if (!valid) return;
    setBusy(true);
    try {
      await api.patchReply(row.id, {
        optOut,
        offers: offers.map((o) => ({
          postType: o.postType,
          category: o.category,
          label: o.label.trim(),
          sensitive: o.sensitive,
          canPost: o.canPost,
          priceRaw: o.priceRaw.trim(),
          website: o.website.trim(),
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
          <Box w="36">Product</Box>
          <Box flex="1">Niche</Box>
          <Box flex="1">Site</Box>
          <Box w="20">Sensitive</Box>
          <Box w="28">Willing</Box>
          <Box w="32">Price</Box>
          <Box w="8" />
        </HStack>

        {offers.map((o, i) => (
          <HStack key={i} gap={2}>
            <NativeSelect.Root size="sm" w="36">
              <NativeSelect.Field value={o.postType} onChange={(e) => update(i, { postType: e.target.value })}>
                {Object.entries(POST_TYPE_LABELS).map(([key, label]) => (
                  <option key={key} value={key}>{label}</option>
                ))}
              </NativeSelect.Field>
              <NativeSelect.Indicator />
            </NativeSelect.Root>
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
