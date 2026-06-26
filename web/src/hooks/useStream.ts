import { useEffect, useRef, useState } from 'react';

export type LiveState = 'connecting' | 'live' | 'reconnecting';

export function useStream(onChange: (type?: string) => void): LiveState {
  const [state, setState] = useState<LiveState>('connecting');
  const cb = useRef(onChange);
  cb.current = onChange;

  useEffect(() => {
    const es = new EventSource('/api/stream');
    let timer: ReturnType<typeof setTimeout> | undefined;

    es.onopen = () => setState('live');
    es.onerror = () => setState('reconnecting');
    es.addEventListener('change', (e) => {
      const type = (() => {
        try { return (JSON.parse((e as MessageEvent).data) as { type?: string }).type; }
        catch { return undefined; }
      })();
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => cb.current(type), 150);
    });

    return () => {
      if (timer) clearTimeout(timer);
      es.close();
    };
  }, []);

  return state;
}
