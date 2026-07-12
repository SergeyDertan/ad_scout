import { Badge, Circle } from '@chakra-ui/react';

// Maps a domain status string to a Chakra colorPalette.
const PALETTE: Record<string, string> = {
  // good
  active: 'green',
  replied: 'green',
  done: 'green',
  threadId: 'green',
  yes: 'green',
  // bad
  paused: 'red',
  bounced: 'red',
  excluded: 'red',
  failed: 'red',
  unmatched: 'red',
  no: 'red',
  // warn / in-flight
  maybe: 'orange',
  contacted: 'blue',
  reserved: 'orange',
  cooldown: 'orange',
  needs_review: 'orange',
  opt_out: 'orange',
  fromAddress: 'blue',
  // neutral
  pending: 'gray',
  skipped: 'gray',
  manual: 'gray',
};

export function StatusBadge({ value }: { value?: string | null }) {
  if (!value) return null;
  const palette = PALETTE[value] ?? 'gray';
  return (
    <Badge colorPalette={palette} variant="subtle" textTransform="none" gap={1.5} rounded="md">
      <Circle size="1.5" bg={`${palette}.solid`} />
      {value.replace(/_/g, ' ')}
    </Badge>
  );
}
