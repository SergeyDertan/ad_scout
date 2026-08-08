import { Box, Circle, Flex, HStack, SimpleGrid, Square, Stack, Text, Wrap } from '@chakra-ui/react';
import { useState, type ComponentType } from 'react';
import type { Engagement, Status } from '../types';
import type { IconProps } from '@chakra-ui/react';
import { ChevronDownIcon, InboxIcon, RefreshIcon, SendIcon, TagIcon, UsersIcon } from './icons';

type IconCmp = ComponentType<IconProps>;

function pct(n: number, base: number): string {
  return base > 0 ? `${Math.round((n / base) * 100)}%` : '0%';
}

function StatCard({
  icon: IconEl,
  label,
  value,
  sub,
  accent,
}: {
  icon: IconCmp;
  label: string;
  value: number | string;
  sub?: string;
  accent: string;
}) {
  return (
    <Flex
      align="center"
      gap={3}
      bg="bg.panel"
      borderWidth="1px"
      borderColor="border"
      rounded="xl"
      boxShadow="xs"
      px={4}
      py={3}
    >
      <Square size={10} rounded="lg" bg={`${accent}.subtle`} color={`${accent}.fg`}>
        <IconEl boxSize={5} />
      </Square>
      <Box minW={0}>
        <Text fontSize="xs" color="fg.muted" fontWeight="medium" textTransform="uppercase" letterSpacing="wider">
          {label}
        </Text>
        <Text fontSize="2xl" fontWeight="bold" lineHeight="1.1">
          {value}
        </Text>
        {sub ? (
          <Text fontSize="xs" color="fg.muted" lineHeight="1.2" mt={0.5} truncate>
            {sub}
          </Text>
        ) : null}
      </Box>
    </Flex>
  );
}

// One row of meaning for every engagement bucket: label, dot colour, and a plain
// explanation surfaced in the expanded detail view.
const META: Record<keyof Engagement, { label: string; palette: string; desc: string }> = {
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

// Segments in the proportional bar = everyone whose email was delivered (Awaiting +
// everyone who replied). Reconciles exactly with the top cards; bounces/excluded
// stay out of the denominator and appear only in the legend/detail.
const DELIVERED_KEYS: (keyof Engagement)[] = [
  'answered',
  'acknowledged',
  'declined',
  'other',
  'optedOut',
  'contacted',
];

// Legend + detail order (funnel, most → least engaged). 'replied' is a subtotal
// header for the four reply buckets; the detail view indents its children.
const DETAIL_ROWS: { key: keyof Engagement; indent?: boolean }[] = [
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

const LEGEND_KEYS: (keyof Engagement)[] = [
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

function EngagementPanel({ status }: { status: Status }) {
  const [open, setOpen] = useState(false);
  const eng = status.engagement!;
  const total = status.targets.total;
  const out = status.outcomes;
  const contacted = DELIVERED_KEYS.reduce((sum, k) => sum + eng[k], 0);

  return (
    <Box bg="bg.panel" borderWidth="1px" borderColor="border" rounded="xl" boxShadow="xs" px={4} py={3} mb={6}>
      <HStack justify="space-between" mb={2.5}>
        <Text fontSize="xs" color="fg.muted" fontWeight="medium" textTransform="uppercase" letterSpacing="wider">
          Engagement
        </Text>
        <Text fontSize="xs" color="fg.muted">
          <Text as="span" fontWeight="bold" color="fg">
            {eng.replied}
          </Text>{' '}
          replied of {contacted} contacted
        </Text>
      </HStack>

      {/* Proportional bar of everyone whose email was delivered. */}
      <Flex h={2} rounded="full" overflow="hidden" bg="bg.muted" mb={3}>
        {contacted === 0
          ? null
          : DELIVERED_KEYS.filter((k) => eng[k] > 0).map((k) => (
              <Box
                key={k}
                w={`${(eng[k] / contacted) * 100}%`}
                bg={`${META[k].palette}.solid`}
                title={`${META[k].label}: ${eng[k]}`}
              />
            ))}
      </Flex>

      {/* Compact legend, always visible. */}
      <Wrap columnGap={4} rowGap={1.5}>
        {LEGEND_KEYS.filter((k) => eng[k] > 0).map((k) => (
          <HStack key={k} gap={1.5}>
            <Circle size="2" bg={`${META[k].palette}.solid`} />
            <Text fontSize="sm" color="fg.muted">
              {META[k].label}
            </Text>
            <Text fontSize="sm" fontWeight="semibold">
              {eng[k]}
            </Text>
          </HStack>
        ))}
      </Wrap>

      {/* Expandable, explained breakdown. */}
      <HStack
        as="button"
        onClick={() => setOpen((v) => !v)}
        mt={3}
        gap={1}
        color="fg.muted"
        _hover={{ color: 'fg' }}
        cursor="pointer"
      >
        <ChevronDownIcon
          boxSize={4}
          transform={open ? 'rotate(0deg)' : 'rotate(-90deg)'}
          transition="transform 0.15s"
        />
        <Text fontSize="xs" fontWeight="medium">
          {open ? 'Hide details' : 'Show details'}
        </Text>
      </HStack>

      {open ? (
        <Stack gap={0} mt={2} pt={2} borderTopWidth="1px" borderColor="border">
          {DETAIL_ROWS.filter((r) => eng[r.key] > 0 || r.key === 'replied').map(({ key, indent }) => {
            const m = META[key];
            const header = key === 'replied';
            return (
              <HStack key={key} align="baseline" py={1.5} pl={indent ? 5 : 0} gap={2}>
                <Circle size="2" bg={`${m.palette}.solid`} flexShrink={0} alignSelf="center" />
                <Text fontSize="sm" fontWeight={header ? 'bold' : 'medium'} minW="7.5rem">
                  {m.label}
                </Text>
                <Text fontSize="xs" color="fg.muted" flex="1" display={{ base: 'none', sm: 'block' }}>
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

          {out ? (
            <Box mt={2} pt={2} borderTopWidth="1px" borderColor="border">
              <Text fontSize="xs" color="fg.muted" fontWeight="medium" textTransform="uppercase" letterSpacing="wider" mb={1}>
                Outcomes (of {eng.replied} replied)
              </Text>
              {[
                { label: 'Priced', value: out.priced, desc: 'Quoted at least one price.' },
                { label: 'Posting available', value: out.postingYes, desc: 'Said yes to posting for ≥1 niche.' },
                { label: 'Posting declined', value: out.postingNo, desc: 'Said no to posting.' },
              ].map((r) => (
                <HStack key={r.label} align="baseline" py={1.5} gap={2}>
                  <Text fontSize="sm" fontWeight="medium" minW="9.5rem">
                    {r.label}
                  </Text>
                  <Text fontSize="xs" color="fg.muted" flex="1" display={{ base: 'none', sm: 'block' }}>
                    {r.desc}
                  </Text>
                  <Text fontSize="sm" fontWeight="semibold" textAlign="right" minW="3rem">
                    {r.value}
                  </Text>
                  <Text fontSize="xs" color="fg.muted" textAlign="right" minW="3rem">
                    {pct(r.value, eng.replied)}
                  </Text>
                </HStack>
              ))}
            </Box>
          ) : null}
        </Stack>
      ) : null}
    </Box>
  );
}

export function StatCards({ status }: { status: Status | null }) {
  const by = status?.targets.byStatus ?? {};
  const eng = status?.engagement;
  const out = status?.outcomes;

  const total = status?.targets.total ?? 0;
  const queued = eng ? eng.queued : (by.pending ?? 0) + (by.reserved ?? 0);
  const sent = total - queued;
  const replied = eng ? eng.replied : (by.replied ?? 0);

  return (
    <>
      <SimpleGrid columns={{ base: 2, md: 5 }} gap={3} mb={eng ? 3 : 6}>
        <StatCard icon={UsersIcon} label="Total" value={status ? total : '—'} accent="brand" />
        <StatCard
          icon={SendIcon}
          label="Sent"
          value={status ? sent : '—'}
          sub={status ? `${pct(sent, total)} of total · ${queued} queued` : undefined}
          accent="blue"
        />
        <StatCard
          icon={InboxIcon}
          label="Replied"
          value={status ? replied : '—'}
          sub={status ? `${pct(replied, sent)} of sent` : undefined}
          accent="green"
        />
        <StatCard
          icon={TagIcon}
          label="Priced"
          value={status ? (out ? out.priced : '—') : '—'}
          sub={out ? `${out.postingYes} can post · ${pct(out.priced, replied)} of replied` : undefined}
          accent="purple"
        />
        <StatCard
          icon={RefreshIcon}
          label="Pending AI"
          value={status ? (status.pendingExtraction ?? 0) : '—'}
          sub="replies awaiting extraction"
          accent="orange"
        />
      </SimpleGrid>
      {status && eng ? <EngagementPanel status={status} /> : null}
    </>
  );
}
