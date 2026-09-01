import { Box, Flex, HStack, SimpleGrid, Square, Stack, Text } from '@chakra-ui/react';
import { useState, type ComponentType } from 'react';
import type { Status } from '../types';
import type { IconProps } from '@chakra-ui/react';
import { ChevronDownIcon, InboxIcon, RefreshIcon, SendIcon, TagIcon, UsersIcon } from './icons';
import {
  deliveredCount,
  pct,
  EngagementBar,
  EngagementDetailRows,
  EngagementLegend,
  OutcomeRows,
} from './engagement';

type IconCmp = ComponentType<IconProps>;

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

function EngagementPanel({ status }: { status: Status }) {
  const [open, setOpen] = useState(false);
  const eng = status.engagement!;
  const total = status.targets.total;
  const out = status.outcomes;
  const contacted = deliveredCount(eng);

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

      <Box mb={3}>
        <EngagementBar eng={eng} />
      </Box>

      <EngagementLegend eng={eng} />

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
          <EngagementDetailRows eng={eng} total={total} />
          {out ? (
            <Box mt={2} pt={2} borderTopWidth="1px" borderColor="border">
              <OutcomeRows outcomes={out} replied={eng.replied} />
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
