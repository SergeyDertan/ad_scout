import { Box, Flex, SimpleGrid, Square, Text } from '@chakra-ui/react';
import type { ComponentType } from 'react';
import type { Status } from '../types';
import type { IconProps } from '@chakra-ui/react';
import { CheckIcon, ClockIcon, SendIcon, UsersIcon } from './icons';

type IconCmp = ComponentType<IconProps>;

function StatCard({
  icon: IconEl,
  label,
  value,
  accent,
}: {
  icon: IconCmp;
  label: string;
  value: number | string;
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
      <Box>
        <Text fontSize="xs" color="fg.muted" fontWeight="medium" textTransform="uppercase" letterSpacing="wider">
          {label}
        </Text>
        <Text fontSize="2xl" fontWeight="bold" lineHeight="1.1">
          {value}
        </Text>
      </Box>
    </Flex>
  );
}

export function StatCards({ status }: { status: Status | null }) {
  const by = status?.targets.byStatus ?? {};
  const queued = (by.pending ?? 0) + (by.reserved ?? 0);

  return (
    <SimpleGrid columns={{ base: 2, md: 4 }} gap={3} mb={6}>
      <StatCard icon={UsersIcon} label="Accounts" value={status?.accounts ?? '—'} accent="brand" />
      <StatCard icon={ClockIcon} label="Queued" value={status ? queued : '—'} accent="orange" />
      <StatCard icon={SendIcon} label="Contacted" value={status ? (by.contacted ?? 0) : '—'} accent="blue" />
      <StatCard icon={CheckIcon} label="Replied" value={status ? (by.replied ?? 0) : '—'} accent="green" />
    </SimpleGrid>
  );
}
