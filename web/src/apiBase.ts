// Where the API lives, and how a request proves who is asking.
//
// Both were hardcoded: every call was `fetch('/api' + path)` with no credential,
// which is exactly right for a console served from the same origin by the very
// process that holds the data. It stops being right the moment the app is hosted
// somewhere else (Firebase) and talks to a VPS, which is what the admin build does.
//
// Kept in its own module because `useStream` needs the same two things and must
// not import the whole api surface to get them.

/**
 * Origin of the API, e.g. "https://adscout.example.com". Empty = same origin,
 * which is the operator console served by `pnpm serve` and the `pnpm web:dev`
 * proxy — so the default build behaves exactly as before.
 */
export const API_ORIGIN: string = (import.meta.env.VITE_API_ORIGIN as string | undefined)?.replace(/\/$/, '') ?? '';

export function apiUrl(path: string): string {
  return `${API_ORIGIN}/api${path}`;
}

type TokenProvider = () => Promise<string | null>;

let tokenProvider: TokenProvider | null = null;

/**
 * Teach the client how to get a bearer token. The admin build calls this once
 * with `() => user.getIdToken()`; the operator build never calls it and sends no
 * Authorization header, which a server without ADMIN_EMAILS does not want anyway.
 *
 * It is a PROVIDER, not a token, on purpose: ID tokens last an hour, and the
 * Firebase SDK refreshes them transparently when asked. Caching the string at
 * sign-in would work for an hour and then log the admin out mid-session.
 */
export function setTokenProvider(fn: TokenProvider | null): void {
  tokenProvider = fn;
}

export async function authHeaders(): Promise<Record<string, string>> {
  if (!tokenProvider) return {};
  const token = await tokenProvider();
  return token ? { Authorization: `Bearer ${token}` } : {};
}
