import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Standard list-fetch state shared by the data views: fetches on mount and
 * whenever `tick` (the SSE change counter) bumps, exposes `loading`/`error`,
 * and returns `reload` for refetching after a mutation.
 *
 * `fetcher` must be stable (wrap in `useCallback`) — its identity drives refetch.
 * It receives an AbortSignal so superseded requests can stop transferring data.
 */
export function useResource<T>(fetcher: (signal: AbortSignal) => Promise<T[]>, tick: number) {
  const [rows, setRows] = useState<T[]>([]);
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
      .then((r) => {
        if (request !== sequence.current) return;
        setRows(r);
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

  return { rows, loading, error, reload };
}
