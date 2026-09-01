// Shared vocabulary and visuals for the engagement funnel.
//
// Two places draw this funnel — the global roll-up above the tabs (StatCards)
// and the per-account expansion in AccountsView. The bucket labels, colours and
// explanations live here so the two can never tell different stories about the
// same number.

import { Box, Circle, Flex, HStack, Text, Wrap } from '@chakra-ui/react';
import type { Engagement, Outcomes } from '../types';

/** One row of meaning per bucket: label, dot colour, plain explanation. */
export const META: Record<keyof Engagement, { label: string; palette: string; desc: string }> = {
  queued: { label: 'Queued', palette: 'gray', desc: 'Not emailed yet (pending or reserved).' },
  contacted: { label: 'Awaiting', palette: 'blue', desc: 'Emailed — still waiting for any reply.' },
  replied: {
    label: 'Replied',
    palette: 'green',
    desc: 'Everyone who wrote back — answered, acknowledged, declined, other or opted-out.',
  },
  answered: { label: 'Answered', palette: 'green', desc: 'Substantive reply — pricing or willingness to post.' },
  acknowledged: {
    label: 'Acknowledged',
    palette: 'cyan',
    desc: 'Auto-reply or “we’ll get back to you” — no real info yet.',
  },
  declined: { label: 'Declined', palette: 'orange', desc: 'Replied to say they’re not interested.' },
  other: { label: 'Other', palette: 'teal', desc: 'Replied with a question or something off-topic.' },
  optedOut: { label: 'Opted out', palette: 'purple', desc: 'Asked to stop / unsubscribed — now suppressed.' },
  bounced: { label: 'Bounced', palette: 'red', desc: 'Delivery failed — the address bounced.' },
  excluded: { label: 'Excluded', palette: 'pink', desc: 'Suppressed without replying.' },
};

// Segments in the proportional bar = everyone whose email was delivered (Awaiting
// + everyone who replied). Bounces/excluded stay out of the denominator and
// appear only in the legend/detail.
export const DELIVERED_KEYS: (keyof Engagement)[] = [
  'answered',
  'acknowledged',
  'declined',
  'other',
  'optedOut',
  'contacted',
];

// Legend + detail order (funnel, most → least engaged). 'replied' is a subtotal
// header for the four reply buckets; the detail view indents its children.
export const DETAIL_ROWS: { key: keyof Engagement; indent?: boolean }[] = [
  { key: 'queued' },
  { key: 'contacted' },
  { key: 'replied' },
  { key: 'answered', indent: true },
  { key: 'acknowledged', indent: true },
  { key: 'declined', indent: true },
  { key: 'other', indent: true },
  { key: 'optedOut', indent: true },
  { key: 'bounced' },
  { key: 'excluded' },
];

export const LEGEND_KEYS: (keyof Engagement)[] = [
  'answered',
  'acknowledged',
  'declined',
  'other',
  'optedOut',
  'contacted',
  'queued',
  'bounced',
  'excluded',
];

export function pct(n: number, base: number): string {
  return base > 0 ? `${Math.round((n / base) * 100)}%` : '0%';
}

/** Everyone whose email was delivered — the bar's denominator. */
export function deliveredCount(eng: Engagement): number {
  return DELIVERED_KEYS.reduce((sum, k) => sum + eng[k], 0);
}

/** Proportional bar over the delivered targets. */
export function EngagementBar({ eng, h = 2 }: { eng: Engagement; h?: number | string }) {
  const delivered = deliveredCount(eng);
  return (
    <Flex h={h} rounded="full" overflow="hidden" bg="bg.muted">
      {delivered === 0
        ? null
        : DELIVERED_KEYS.filter((k) => eng[k] > 0).map((k) => (
            <Box
              key={k}
              w={`${(eng[k] / delivered) * 100}%`}
              bg={`${META[k].palette}.solid`}
              title={`${META[k].label}: ${eng[k]}`}
            />
          ))}
    </Flex>
  );
}

/** Compact dot legend — only the buckets that actually have something in them. */
export function EngagementLegend({ eng, size = 'sm' }: { eng: Engagement; size?: 'sm' | 'xs' }) {
  return (
    <Wrap columnGap={4} rowGap={1.5}>
      {LEGEND_KEYS.filter((k) => eng[k] > 0).map((k) => (
        <HStack key={k} gap={1.5}>
          <Circle size="2" bg={`${META[k].palette}.solid`} />
          <Text fontSize={size} color="fg.muted">
            {META[k].label}
          </Text>
          <Text fontSize={size} fontWeight="semibold">
            {eng[k]}
          </Text>
        </HStack>
      ))}
    </Wrap>
  );
}

/** The explained, indented breakdown. `total` is the percentage base. */
export function EngagementDetailRows({ eng, total }: { eng: Engagement; total: number }) {
  return (
    <>
      {DETAIL_ROWS.filter((r) => eng[r.key] > 0 || r.key === 'replied').map(({ key, indent }) => {
        const m = META[key];
        const header = key === 'replied';
        return (
          <HStack key={key} align="baseline" py={1.5} pl={indent ? 5 : 0} gap={2}>
            <Circle size="2" bg={`${m.palette}.solid`} flexShrink={0} alignSelf="flex-start" mt="0.45em" />
            <Text fontSize="sm" fontWeight={header ? 'bold' : 'medium'} minW="7.5rem">
              {m.label}
            </Text>
            <Text fontSize="xs" color="fg.muted" flex="1" minW={0} display={{ base: 'none', sm: 'block' }}>
              {m.desc}
            </Text>
            <Text fontSize="sm" fontWeight="semibold" textAlign="right" minW="3rem">
              {eng[key]}
            </Text>
            <Text fontSize="xs" color="fg.muted" textAlign="right" minW="3rem">
              {pct(eng[key], total)}
            </Text>
          </HStack>
        );
      })}
    </>
  );
}

/** Commercial outcomes, as a share of everyone who replied. */
export function OutcomeRows({ outcomes, replied }: { outcomes: Outcomes; replied: number }) {
  const rows = [
    { label: 'Priced', value: outcomes.priced, desc: 'Quoted at least one price.' },
    { label: 'Posting available', value: outcomes.postingYes, desc: 'Said yes to posting for ≥1 niche.' },
    { label: 'Posting declined', value: outcomes.postingNo, desc: 'Said no to posting.' },
  ];
  return (
    <>
      <Text
        fontSize="xs"
        color="fg.muted"
        fontWeight="medium"
        textTransform="uppercase"
        letterSpacing="wider"
        mb={1}
      >
        Outcomes (of {replied} replied)
      </Text>
      {rows.map((r) => (
        <HStack key={r.label} align="baseline" py={1.5} gap={2}>
          <Text fontSize="sm" fontWeight="medium" minW="9.5rem">
            {r.label}
          </Text>
          <Text fontSize="xs" color="fg.muted" flex="1" minW={0} display={{ base: 'none', sm: 'block' }}>
            {r.desc}
          </Text>
          <Text fontSize="sm" fontWeight="semibold" textAlign="right" minW="3rem">
            {r.value}
          </Text>
          <Text fontSize="xs" color="fg.muted" textAlign="right" minW="3rem">
            {pct(r.value, replied)}
          </Text>
        </HStack>
      ))}
    </>
  );
}
