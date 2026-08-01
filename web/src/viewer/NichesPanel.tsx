import { Box, HStack, Input, InputGroup, Text, VStack } from '@chakra-ui/react';
import { useMemo, useState } from 'react';
import { SearchIcon } from '../components/icons';
import type { Tier } from '../types';
import type { Classification } from './classification';
import { Mono, Rule, Segmented } from './ui';

/**
 * Where the viewer's owner decides which niches are sensitive.
 *
 * The list is grouped by the three states rather than sorted by them, because
 * the states are not degrees of the same thing: "unclassified" is a to-do,
 * the other two are answers. Unclassified sits first under its own heading so
 * a niche that turns up in a new reply is impossible to miss.
 *
 * Nothing here is sent back to the pipeline; it only changes what HE sees.
 */

const SECTIONS: { tier: Tier; heading: string; note?: string }[] = [
  {
    tier: 'unknown',
    heading: 'needs a call',
    note: 'Shown as “unknown niche” everywhere, and left out of inferred prices, until you rule on them.',
  },
  { tier: 'sens', heading: 'sensitive' },
  { tier: 'reg', heading: 'regular' },
];

const TIER_CHOICES = [
  { value: 'reg' as const, label: 'regular', title: 'Ordinary rates' },
  { value: 'sens' as const, label: 'sensitive', activeBg: 'orange.500', title: 'Priced as a sensitive niche' },
  // "Unset" is the absence of an answer, so it never fills with ink — a row
  // waiting on a decision has to look different from one that has had it.
  {
    value: 'unknown' as const,
    label: 'unset',
    activeBg: 'bg.muted',
    activeFg: 'fg.muted',
    title: 'Back to undecided',
  },
];

const FILTERS = [
  { value: 'all' as const, label: 'all' },
  { value: 'unknown' as const, label: 'unset' },
  { value: 'sens' as const, label: 'sensitive' },
  { value: 'reg' as const, label: 'regular' },
];

export function NichesPanel({
  niches,
  classification,
  onChange,
}: {
  /** Every niche key present in the data, with its display label. */
  niches: { key: string; label: string }[];
  classification: Classification;
  onChange: (next: Classification) => void;
}) {
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'all' | Tier>('all');

  const { grouped, totals } = useMemo(() => {
    const q = search.trim().toLowerCase();
    const byTier: Record<Tier, { key: string; label: string; tier: Tier }[]> = { unknown: [], sens: [], reg: [] };
    const count: Record<Tier, number> = { unknown: 0, sens: 0, reg: 0 };
    for (const n of niches) {
      const known = classification[n.key];
      const tier: Tier = known === undefined ? 'unknown' : known ? 'sens' : 'reg';
      count[tier] += 1;
      if (q && !n.label.toLowerCase().includes(q) && !n.key.toLowerCase().includes(q)) continue;
      if (filter !== 'all' && filter !== tier) continue;
      byTier[tier].push({ ...n, tier });
    }
    for (const list of Object.values(byTier)) list.sort((a, b) => a.label.localeCompare(b.label));
    return { grouped: byTier, totals: count };
  }, [niches, classification, search, filter]);

  const shown = grouped.unknown.length + grouped.sens.length + grouped.reg.length;

  const set = (key: string, tier: Tier) => {
    const next = { ...classification };
    // Back to unset means REMOVING the key — an absent answer and a "no"
    // answer have to stay distinguishable.
    if (tier === 'unknown') delete next[key];
    else next[key] = tier === 'sens';
    onChange(next);
  };

  return (
    // Narrower than the data tabs on purpose: this is a list of decisions, and
    // a decision reads badly with a metre of empty paper between the question
    // and the answer.
    <Box pt={6} maxW="4xl">
      <Text color="fg.muted" fontSize="sm" maxW="2xl" lineHeight="1.7" mb={5}>
        Which niches count as sensitive is your call. It’s saved to your account and drives the tier filters, the
        inferred prices on the Sites tab, and every export.
      </Text>

      <HStack gap={4} mb={4} flexWrap="wrap">
        <Mono flexShrink={0}>
          <Text as="span" color={totals.unknown > 0 ? 'orange.600' : 'fg.muted'} fontWeight="600">
            {totals.unknown} unset
          </Text>
          {' · '}
          {totals.sens} sensitive {' · '} {totals.reg} regular
        </Mono>
        <Rule display={{ base: 'none', md: 'block' }} />
      </HStack>

      <HStack gap={3} mb={5} flexWrap="wrap">
        <InputGroup startElement={<SearchIcon boxSize={3.5} color="fg.subtle" />} maxW="60">
          <Input
            size="sm"
            placeholder="Find a niche…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            bg="bg.panel"
          />
        </InputGroup>
        <Segmented value={filter} options={FILTERS} onChange={setFilter} ariaLabel="Filter niches by state" />
      </HStack>

      {shown === 0 ? (
        <Box borderWidth="1px" borderColor="border" rounded="l3" bg="bg.panel" py={14} textAlign="center">
          <Mono color="fg.subtle">no match</Mono>
          <Text fontSize="sm" color="fg.muted" mt={2}>
            Nothing here matches “{search || FILTERS.find((f) => f.value === filter)?.label}”.
          </Text>
        </Box>
      ) : (
        <VStack align="stretch" gap={7}>
          {SECTIONS.map(({ tier, heading, note }) => {
            const rows = grouped[tier];
            if (rows.length === 0) return null;
            return (
              <Box key={tier}>
                <HStack gap={3} mb={note ? 2 : 3} align="center">
                  <Mono color={tier === 'unknown' ? 'orange.600' : 'fg'} fontWeight="600" flexShrink={0}>
                    {heading}
                  </Mono>
                  <Mono color="fg.subtle" flexShrink={0}>
                    {rows.length}
                  </Mono>
                  <Rule />
                </HStack>
                {note && (
                  <Text fontSize="xs" color="fg.subtle" mb={3}>
                    {note}
                  </Text>
                )}

                <VStack
                  align="stretch"
                  gap={0}
                  borderWidth="1px"
                  borderColor={tier === 'unknown' ? 'orange.200' : 'border'}
                  rounded="l3"
                  overflow="hidden"
                  bg="bg.panel"
                >
                  {rows.map((n, i) => (
                    <HStack
                      key={n.key}
                      px={4}
                      py={2.5}
                      gap={4}
                      flexWrap="wrap"
                      borderTopWidth={i === 0 ? undefined : '1px'}
                      borderColor="border.muted"
                      _hover={{ bg: 'bg.subtle' }}
                      transition="background 0.1s"
                    >
                      {/* Below ~430px the control drops to its own line rather
                          than pushing the page wider than the screen. */}
                      <Box flex="1" minW="160px">
                        <Text fontWeight="500" fontSize="sm" truncate>
                          {n.label || n.key}
                        </Text>
                        {n.label && n.label.toLowerCase() !== n.key && (
                          <Text fontFamily="mono" fontSize="11px" color="fg.subtle" truncate>
                            {n.key}
                          </Text>
                        )}
                      </Box>
                      <Segmented
                        value={n.tier}
                        options={TIER_CHOICES}
                        onChange={(t) => set(n.key, t)}
                        ariaLabel={`Sensitivity for ${n.label || n.key}`}
                      />
                    </HStack>
                  ))}
                </VStack>
              </Box>
            );
          })}
        </VStack>
      )}
    </Box>
  );
}
