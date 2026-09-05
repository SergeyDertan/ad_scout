import { Badge } from '@chakra-ui/react';
import { tierOf } from '../types';

/**
 * The sensitivity marker next to a niche.
 *
 * Regular posts get no badge — they are the default and badging them would be
 * noise.
 */
export function TierBadge({ of }: { of: { sensitive: boolean } }) {
  if (tierOf(of) === 'reg') return null;
  return <Badge colorPalette="orange" variant="surface" size="sm">sensitive</Badge>;
}
