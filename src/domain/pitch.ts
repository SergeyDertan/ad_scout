// Resolve the pitch profile for an outreach: a batch may override the advertised
// site per import; topic/format/subject always come from the global defaults.

import type { Batch, PitchProfile } from './types';

/** How the outreach that produced a reply framed its question — which decides how
 *  the extractor reads a niche-less flat price:
 *   - 'casino': we asked specifically about casino (the historical "first" batch),
 *     so a bare price IS the casino price.
 *   - 'broad': we asked for the standard/regular guest-post rate + grey niches
 *     (every other batch, and all new ones), so a bare price is REGULAR. */
export type PitchStyle = 'casino' | 'broad';

/** The one historical batch ("first") whose message asked specifically about
 *  casino. Every other batch — and all new batches — used/uses the broad ask, so
 *  the extractor defaults to 'broad'. Add ids here only for casino-specific sends. */
export const CASINO_PITCH_BATCH_IDS = new Set<string>([
  'batch_b4fb1635-a367-4cf9-a302-538db038a270',
]);

/** The pitch style for a reply, from the batch its target belongs to. */
export function pitchStyleForBatch(batchId?: string): PitchStyle {
  return batchId != null && CASINO_PITCH_BATCH_IDS.has(batchId) ? 'casino' : 'broad';
}

export function resolveProfile(
  batch: Pick<Batch, 'advertised'> | undefined,
  defaults: PitchProfile,
): PitchProfile {
  return {
    advertised: batch?.advertised ?? defaults.advertised,
    topic: defaults.topic,
    format: defaults.format,
    ...(defaults.subjectTemplate ? { subjectTemplate: defaults.subjectTemplate } : {}),
  };
}
