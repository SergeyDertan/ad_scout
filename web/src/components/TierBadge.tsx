import { Badge } from '@chakra-ui/react';
import { tierOf, type Tier } from '../types';

/**
 * The sensitivity marker next to a niche.
 *
 * Regular posts get no badge — they are the default and badging them would be
 * noise. 'unknown' only ever appears in the shared viewer, where it means "its
 * owner hasn't classified this niche yet", NOT "we don't know": it's a prompt to
 * go and rule on it, so it is deliberately visible rather than silent.
 */
export function TierBadge({ of }: { of: { sensitive: boolean; tier?: Tier } }) {
  const tier = tierOf(of);
  if (tier === 'reg') return null;
  if (tier === 'unknown') {
    return (
      <Badge colorPalette="gray" variant="surface" size="sm" title="Not yet classified — set it under Niches">
        unknown niche
      </Badge>
    );
  }
  return <Badge colorPalette="orange" variant="surface" size="sm">sensitive</Badge>;
}
