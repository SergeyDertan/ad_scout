import { createContext, useContext } from 'react';

/**
 * Who is signed in, when anyone is.
 *
 * `null` on the local console, which has no authentication at all — every
 * consumer must render nothing rather than an empty account row. AuthGate is
 * the only provider; App reads it so the identity can live in the navigation
 * instead of in a strip of its own above the page.
 */
export interface Session {
  email: string | null;
  signOut: () => void;
}

export const SessionContext = createContext<Session | null>(null);

export function useSession(): Session | null {
  return useContext(SessionContext);
}
