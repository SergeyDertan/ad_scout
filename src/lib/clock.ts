// A Clock seam so pipeline code is testable with a fixed time.
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

/** Fixed clock for tests. */
export function fixedClock(at: Date): Clock {
  return { now: () => at };
}
