// Derived: total remaining daily send quota across active accounts. Used by the
// drip scheduler to space sends across the send window.

import { remainingToday } from '../domain/limits';
import type { Config } from '../config';
import type { Store } from '../ports/store';

export async function totalRemainingToday(
  store: Store,
  config: Config,
  now: Date,
): Promise<number> {
  const accounts = (await store.listAccounts()).filter((a) => a.status === 'active');
  if (accounts.length === 0) return 0;
  const outreaches = await store.listOutreaches();
  return accounts.reduce(
    (sum, a) => sum + remainingToday(a, outreaches, now, config.warmup),
    0,
  );
}
