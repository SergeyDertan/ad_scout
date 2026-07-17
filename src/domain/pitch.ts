// Resolve the pitch profile for an outreach: a batch may override the advertised
// site per import; topic/format/subject always come from the global defaults.

import type { Batch, PitchProfile } from './types';

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
