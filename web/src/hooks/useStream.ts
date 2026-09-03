import { useEffect, useRef, useState } from 'react';
import { apiUrl, authHeaders } from '../apiBase';

export type LiveState = 'connecting' | 'live' | 'reconnecting';

/** Reconnect backoff: quick at first, capped, jittered so several open tabs do
 *  not all come back at the same instant after a restart. */
const RECONNECT_CAP_MS = 30_000;
function backoffMs(attempt: number): number {
  const base = Math.min(RECONNECT_CAP_MS, 500 * 2 ** (attempt - 1));
  return base / 2 + Math.random() * (base / 2);
}

/**
 * Live store-change feed.
 *
 * Uses fetch + a stream reader rather than the native EventSource, which cannot
 * set request headers — so under a bearer-authenticated API it would fail every
 * connection and the UI would simply stop updating, with no error a user sees.
 * Passing the token as a query parameter is the other obvious fix and is worse:
 * it lands in proxy and access logs. The frame parsing here is the same shape
 * `runPass` in api.ts already uses.
 *
 * EventSource's one real convenience — automatic reconnection — is replaced by
 * the loop below, which also recovers from a server restart and from a laptop
 * waking up.
 */
export function useStream(onChange: (type?: string) => void): LiveState {
  const [state, setState] = useState<LiveState>('connecting');
  const cb = useRef(onChange);
  cb.current = onChange;

  useEffect(() => {
    const ac = new AbortController();
    let debounce: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    let attempt = 0;

    /** Coalesce a burst of changes into one refresh, as the old 150 ms did. */
    const fire = (type?: string): void => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => cb.current(type), 150);
    };

    const readStream = async (body: ReadableStream<Uint8Array>): Promise<void> => {
      const reader = body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        buf += decoder.decode(value, { stream: true });
        const frames = buf.split('\n\n');
        buf = frames.pop() ?? ''; // keep the incomplete frame for the next chunk
        for (const frame of frames) {
          if (!frame.trim()) continue;
          let event = 'message';
          let data = '';
          for (const line of frame.split('\n')) {
            if (line.startsWith('event: ')) event = line.slice(7);
            else if (line.startsWith('data: ')) data = line.slice(6);
            // ':' lines are heartbeat comments — they keep the socket warm only.
          }
          if (event !== 'change') continue;
          let type: string | undefined;
          try {
            type = (JSON.parse(data) as { type?: string }).type;
          } catch {
            type = undefined;
          }
          fire(type);
        }
      }
    };

    const run = async (): Promise<void> => {
      while (!stopped) {
        try {
          const res = await fetch(apiUrl('/stream'), {
            headers: { Accept: 'text/event-stream', ...(await authHeaders()) },
            signal: ac.signal,
            // Long-lived response; never let a cache sit in front of it.
            cache: 'no-store',
          });
          if (!res.ok || !res.body) throw new Error(`stream: ${res.status}`);
          if (stopped) return;
          setState('live');
          attempt = 0;
          await readStream(res.body);
          // A clean end is still a disconnect (server restart, proxy idle
          // timeout) — fall through and reconnect.
        } catch {
          if (ac.signal.aborted || stopped) return;
        }
        if (stopped) return;
        setState('reconnecting');
        attempt++;
        await new Promise((r) => setTimeout(r, backoffMs(attempt)));
      }
    };

    void run();

    return () => {
      stopped = true;
      if (debounce) clearTimeout(debounce);
      ac.abort();
    };
  }, []);

  return state;
}
