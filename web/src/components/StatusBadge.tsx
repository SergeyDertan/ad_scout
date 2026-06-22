import { Badge } from '@chakra-ui/react';

// Maps a domain status string to a Chakra colorPalette.
const PALETTE: Record<string, string> = {
  // good
  active: 'green',
  replied: 'green',
  done: 'green',
  threadId: 'green',
  // bad
  paused: 'red',
  bounced: 'red',
  excluded: 'red',
  failed: 'red',
  unmatched: 'red',
  // warn / in-flight
  contacted: 'orange',
  reserved: 'orange',
  warming: 'orange',
  cooldown: 'orange',
  needs_review: 'orange',
  opt_out: 'orange',
  fromAddress: 'blue',
  // neutral
  pending: 'gray',
  manual: 'gray',
};

export function StatusBadge({ value }: { value?: string | null }) {
  if (!value) return null;
  return (
    <Badge colorPalette={PALETTE[value] ?? 'gray'} variant="subtle" textTransform="none">
      {value}
    </Badge>
  );
}
