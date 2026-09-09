import { useCallback, useEffect, useRef, useState } from 'react';
import type { PageEnvelope } from '../types';

/** Shared abort + last-request-wins state machine for list and page requests. */
function useLoadable<T>(fetcher: (signal: AbortSignal) => Promise<T>, tick: number, initial: T) {
  const [data, setData] = useState<T>(initial);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const sequence = useRef(0);
  const active = useRef<AbortController | null>(null);

  const reload = useCallback(() => {
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    const request = ++sequence.current;
    setLoading(true);
    setError(null);
    fetcher(controller.signal)
      .then((result) => {
        if (request !== sequence.current) return;
        setData(result);
        setError(null);
      })
      .catch((e) => {
        if (request !== sequence.current || (e as { name?: string })?.name === 'AbortError') return;
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (request !== sequence.current) return;
        if (active.current === controller) active.current = null;
        setLoading(false);
      });
  }, [fetcher]);

  useEffect(() => {
    reload();
    return () => {
      active.current?.abort();
      active.current = null;
      sequence.current++;
    };
  }, [reload, tick]);

  return { data, loading, error, reload };
}

/**
 * Standard unpaged list state. Kept for small reference collections and for
 * screens not migrated to the bounded page contract yet.
 */
export function useResource<T>(fetcher: (signal: AbortSignal) => Promise<T[]>, tick: number) {
  const { data, ...state } = useLoadable(fetcher, tick, [] as T[]);
  return { rows: data, ...state };
}

/** Bounded list state: one server page is retained in browser memory. */
export function usePagedResource<T, F>(
  fetcher: (signal: AbortSignal) => Promise<PageEnvelope<T, F>>,
  tick: number,
) {
  const { data, ...state } = useLoadable<PageEnvelope<T, F> | null>(fetcher, tick, null);
  return { result: data, ...state };
}
