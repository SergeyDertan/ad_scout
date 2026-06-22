// Pure account-selection helper: round-robin assignment of work items to
// accounts that still have daily capacity (overview.md §8). No I/O.

export interface Capacity {
  accountId: string;
  remaining: number;
}

export interface Assignment<T> {
  item: T;
  accountId: string;
}

/**
 * Assign items to accounts round-robin, skipping accounts at their limit.
 * Returns at most `sum(remaining)` assignments; leftover items are dropped
 * (they'll be picked up on the next pass).
 */
export function assignRoundRobin<T>(items: T[], caps: Capacity[]): Assignment<T>[] {
  const budget = caps.map((c) => ({ accountId: c.accountId, left: Math.max(0, c.remaining) }));
  const out: Assignment<T>[] = [];
  let cursor = 0;

  for (const item of items) {
    if (budget.every((b) => b.left <= 0)) break;
    // advance to the next account with capacity
    let tries = 0;
    while (budget[cursor % budget.length].left <= 0 && tries < budget.length) {
      cursor++;
      tries++;
    }
    const slot = budget[cursor % budget.length];
    if (slot.left <= 0) break;
    out.push({ item, accountId: slot.accountId });
    slot.left--;
    cursor++;
  }
  return out;
}
