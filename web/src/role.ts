import { createContext, useContext } from 'react';

/** `null` = this instance has no authentication, or the role is not known yet.
 *  Both mean "behave exactly as the console always has" — a local operator. */
export type Role = 'admin' | 'manager' | null;

export const RoleContext = createContext<Role>(null);

export function useRole(): Role {
  return useContext(RoleContext);
}

/**
 * True only for a signed-in manager. An open instance and an admin both read
 * false, so every `if (isManager)` below is additive: nothing changes for the
 * operator, on a laptop or on the server.
 *
 * This hides controls a manager's requests would only 403 on. It is NOT the
 * security boundary — `mayAccess()` in src/server/auth.ts is, and it does not
 * trust the client for anything.
 */
export function useIsManager(): boolean {
  return useContext(RoleContext) === 'manager';
}
