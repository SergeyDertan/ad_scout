// Poll-cursor commit rules, shared by the fetch and poll passes.
//
// The gmail-api provider advances pollCursor.historyId INSIDE fetchReplies —
// before the caller has handled any of the messages it just returned. That
// ordering is deliberate (a message landing mid-pass is re-reported next time
// rather than skipped), but it means an interrupted pass leaves the cursor ahead
// of work that never happened: the unhandled remainder sits behind the cursor and
// no later pass can ask for it again. Gmail is the only copy of that mail, so
// those replies are lost for good — silently, with nothing in the logs.
//
// Hence a pass commits its cursor only when it actually finished the account:
//   finished        → advance lastPolledAt (historyId is already current)
//   aborted / threw → put historyId back where it was and leave lastPolledAt
//                     alone, so the next pass re-fetches the same window.
//                     Dedupe by emailId absorbs whatever was already handled.

import type { Clock } from '../lib/clock';
import type { Store } from '../ports/store';

/** Account finished cleanly — mark the mailbox polled as of now. */
export async function advanceCursor(store: Store, accountId: string, clock: Clock): Promise<void> {
  await store.updateAccount(accountId, (current) => ({
    ...current,
    pollCursor: {
      ...current.pollCursor,
      mailbox: 'INBOX',
      lastPolledAt: clock.now().toISOString(),
    },
  }));
}

/** Account was cut short — restore the historyId it had before fetchReplies ran.
 *  `historyId: undefined` means it had none (the search path), so the seed the
 *  provider just wrote is removed and the next pass searches by time again. */
export async function rewindCursor(
  store: Store,
  accountId: string,
  historyId: string | undefined,
): Promise<void> {
  await store.updateAccount(accountId, (current) => {
    const cursor = { ...current.pollCursor, mailbox: current.pollCursor?.mailbox ?? 'INBOX' };
    if (historyId === undefined) delete cursor.historyId;
    else cursor.historyId = historyId;
    return { ...current, pollCursor: cursor };
  });
}
