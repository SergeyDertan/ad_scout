// Structured error description for logging.
//
// Node's global `fetch` (undici) throws a bland `TypeError: fetch failed` for
// every transport-level failure — DNS lookup, connection reset, timeout, no
// route — and buries the real reason in `err.cause` (and sometimes `cause.cause`).
// Logging only `err.message` therefore erases the one detail that tells a
// laptop-asleep network drop (ENOTFOUND / ECONNRESET / ETIMEDOUT) apart from a
// genuine API/auth failure. `describeError` unwraps that chain into flat,
// loggable fields.

interface ErrnoLike {
  message?: unknown;
  code?: unknown;
  errno?: unknown;
  syscall?: unknown;
  hostname?: unknown;
  address?: unknown;
  port?: unknown;
  cause?: unknown;
  errors?: unknown; // AggregateError
}

export interface ErrorDetail {
  /** Top-level message, e.g. "fetch failed". */
  error: string;
  /** Deepest OS/undici error code, e.g. "ENOTFOUND", "ECONNRESET", "UND_ERR_CONNECT_TIMEOUT". */
  code?: string;
  /** Failing syscall, e.g. "getaddrinfo", "connect". */
  syscall?: string;
  /** Host we failed to reach, when the cause carries it. */
  hostname?: string;
  /** Full "Message [CODE]" chain from outermost to root cause, joined by " <- ". */
  chain?: string;
  /**
   * True when the root cause is a network-transport failure (offline, DNS,
   * reset, timeout) rather than an application/API error. Handy for spotting
   * the "laptop was asleep" class of failures at a glance.
   */
  network?: boolean;
}

// undici / Node network-transport error codes: the machine couldn't reach the
// host, as opposed to the host answering with an error.
const NETWORK_CODES = new Set([
  'ENOTFOUND', // DNS lookup failed (offline / interface down)
  'EAI_AGAIN', // transient DNS failure
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENETDOWN',
  'EPIPE',
  'EAGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
]);

function asErrno(value: unknown): ErrnoLike | undefined {
  return value && typeof value === 'object' ? (value as ErrnoLike) : undefined;
}

function nextCause(node: ErrnoLike): unknown {
  // AggregateError (undici emits these when every connect attempt fails)
  // exposes sub-errors on `.errors`; fall back to the usual `.cause`.
  if (Array.isArray(node.errors) && node.errors.length > 0) return node.errors[0];
  return node.cause;
}

/**
 * Walk an error's `cause` / `errors` chain (bounded, cycle-safe) and flatten it
 * into loggable fields. Never throws.
 */
export function describeError(err: unknown): ErrorDetail {
  const rootMessage = err instanceof Error ? err.message : String(err);
  const detail: ErrorDetail = { error: rootMessage };

  const chain: string[] = [];
  const seen = new Set<unknown>();
  let node: ErrnoLike | undefined = asErrno(err) ?? { message: rootMessage };
  let depth = 0;

  while (node && !seen.has(node) && depth < 8) {
    seen.add(node);
    depth++;

    const message = typeof node.message === 'string' ? node.message : undefined;
    const code = typeof node.code === 'string' ? node.code : undefined;
    chain.push(code ? `${message ?? ''} [${code}]`.trim() : (message ?? ''));

    // Prefer the deepest layer's diagnostic fields — that's where the real
    // syscall/hostname/code live (the outer TypeError has none).
    if (code) detail.code = code;
    if (typeof node.syscall === 'string') detail.syscall = node.syscall;
    if (typeof node.hostname === 'string') detail.hostname = node.hostname;

    node = asErrno(nextCause(node));
  }

  if (chain.length > 1) detail.chain = chain.filter(Boolean).join(' <- ');
  if (detail.code && NETWORK_CODES.has(detail.code)) detail.network = true;

  return detail;
}
