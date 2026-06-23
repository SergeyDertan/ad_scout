import { useCallback, useEffect, useState } from 'react';

/**
 * Standard list-fetch state shared by the data views: fetches on mount and
 * whenever `tick` (the SSE change counter) bumps, exposes `loading`/`error`,
 * and returns `reload` for refetching after a mutation.
 *
 * `fetcher` must be stable (wrap in `useCallback`) — its identity drives refetch.
 */
export function useResource<T>(fetcher: () => Promise<T[]>, tick: number) {
  const [rows, setRows] = useState<T[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    setLoading(true);
    fetcher()
      .then((r) => {
        setRows(r);
        setError(null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [fetcher]);

  useEffect(() => {
    reload();
  }, [reload, tick]);

  return { rows, loading, error, reload };
}
