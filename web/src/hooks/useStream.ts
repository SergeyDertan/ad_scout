import { useEffect, useRef, useState } from 'react';

export type LiveState = 'connecting' | 'live' | 'reconnecting';

/**
 * Subscribe to the server's SSE change feed (`/api/stream`). Calls `onChange`
 * (debounced) whenever the store emits, and reports connection liveness.
 */
export function useStream(onChange: () => void): LiveState {
  const [state, setState] = useState<LiveState>('connecting');
  const cb = useRef(onChange);
  cb.current = onChange;

  useEffect(() => {
    const es = new EventSource('/api/stream');
    let timer: ReturnType<typeof setTimeout> | undefined;

    es.onopen = () => setState('live');
    es.onerror = () => setState('reconnecting');
    es.addEventListener('change', () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => cb.current(), 150);
    });

    return () => {
      if (timer) clearTimeout(timer);
      es.close();
    };
  }, []);

  return state;
}
