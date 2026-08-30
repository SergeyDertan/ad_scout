// A minimal History-API router.
//
// The app is one level deep — a tab, optionally with a record id — so a routing
// library would be more configuration than code. This is the whole thing: parse
// `location.pathname`, push on navigate, re-render on popstate. Real URLs (not
// hashes) so a deal can be bookmarked, shared, and survive a refresh; the server
// serves index.html for unknown paths to make that work (see serveStatic).

import { useCallback, useEffect, useState } from 'react';

export interface Route {
  /** First path segment — the tab id. Empty string at the root. */
  tab: string;
  /** Second segment, when there is one: a record id (e.g. /deals/<id>). */
  id?: string;
}

function parse(pathname: string): Route {
  const [tab = '', id] = pathname.split('/').filter(Boolean);
  return id ? { tab, id } : { tab };
}

export function toPath(tab: string, id?: string): string {
  return id ? `/${tab}/${id}` : `/${tab}`;
}

/**
 * The current route plus a `navigate`. `navigate` is a no-op when the target
 * path is already current, so re-selecting the open tab doesn't stack duplicate
 * history entries the user then has to press Back through.
 */
export function useRoute(fallbackTab: string): {
  route: Route;
  navigate: (tab: string, id?: string) => void;
} {
  const [route, setRoute] = useState<Route>(() => parse(window.location.pathname));

  useEffect(() => {
    const onPop = () => setRoute(parse(window.location.pathname));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // Land on the default tab, replacing the entry rather than pushing one — Back
  // from the first screen should leave the app, not bounce through "/".
  useEffect(() => {
    if (!route.tab) {
      window.history.replaceState(null, '', toPath(fallbackTab));
      setRoute({ tab: fallbackTab });
    }
  }, [route.tab, fallbackTab]);

  const navigate = useCallback((tab: string, id?: string) => {
    const path = toPath(tab, id);
    if (path === window.location.pathname) return;
    window.history.pushState(null, '', path);
    setRoute(parse(path));
  }, []);

  return { route: route.tab ? route : { tab: fallbackTab }, navigate };
}
