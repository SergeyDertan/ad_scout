// Structured error description for logging.
//
// Node's global `fetch` (undici) throws a bland `TypeError: fetch failed` for
// every transport-level failure — DNS lookup, connection reset, timeout, no
// route — and buries the real reason in `err.cause` (and sometimes `cause.cause`).
// Logging only `err.message` therefore erases the one detail that tells a
// laptop-asleep network drop (ENOTFOUND / ECONNRESET / ETIMEDOUT) apart from a
// genuine API/auth failure. `describeError` unwraps that chain into flat,
// loggable fields.

/**
 * The Claude Code CLI (subscription session) hit its usage/rate limit. Thrown by
 * the claude-code provider so the extraction driver can STOP cleanly — leaving
 * the current reply 'pending' to resume later — instead of burning through every
 * remaining reply marking it 'failed'. `resetAt` is the reset time when the CLI
 * reported one (it appends a unix epoch: "usage limit reached|<epoch>").
 */
export class UsageLimitError extends Error {
  readonly resetAt?: Date;
  constructor(message: string, resetAt?: Date) {
    super(message);
    this.name = 'UsageLimitError';
    if (resetAt) this.resetAt = resetAt;
  }
}

// What the CLI actually says when the subscription window is exhausted. Verified
// against logs/ — every real hit so far took one of these forms:
//
//   You've hit your session limit · resets 4:20pm (Europe/Kiev)
//   You've hit your monthly spend limit · raise it at claude.ai/settings/usage?…
//   Claude AI usage limit reached|1719763200
//
// The "hit your <window> limit" phrasing is the live one and matched NONE of the
// original patterns, so the driver read a real limit as an ordinary failure and
// marked every remaining reply 'failed' at ~700ms each. Keep the older forms too:
// this string is the CLI's, not an API contract, and it has already changed once.
const USAGE_LIMIT_RE =
  /\b(?:hit|reached|exceeded)\s+(?:your|the)\s+[\w\s-]{0,24}?limit\b|\busage limit reached\b|\brate limit\b|\blimit reached\b|\bexceed(?:ed)? your (?:usage|plan|account) limit\b/i;

/**
 * Detect a Claude Code usage/session-limit message in CLI output. Returns a typed
 * UsageLimitError (with the reset time when the CLI reported one) or undefined
 * when the text is an ordinary error. Never throws.
 *
 * Feed this the CLI's OWN output only. The `result` field of its JSON payload is
 * the right input; an execFile error `message` is not, because it echoes back the
 * whole prompt — a publisher writing "we've reached our limit" in the email being
 * extracted would otherwise stop the run.
 */
export function detectUsageLimit(text: string | undefined): UsageLimitError | undefined {
  if (!text) return undefined;
  if (!USAGE_LIMIT_RE.test(text)) return undefined;
  return new UsageLimitError(text.trim().slice(0, 200), parseResetAt(text));
}

/**
 * The reset moment named in a limit message, in either form the CLI uses: an
 * appended unix epoch ("…reached|1719763200") or a human wall-clock time
 * ("resets 4:20pm (Europe/Kiev)"). Undefined when it named none — a monthly
 * spend limit has no reset time at all. Never throws.
 */
function parseResetAt(text: string): Date | undefined {
  const epoch = text.match(/\|\s*(\d{10,13})\b/); // "…reached|1719763200"
  if (epoch) {
    const n = Number(epoch[1]);
    const d = new Date(n < 1e12 ? n * 1000 : n); // seconds vs milliseconds
    if (!Number.isNaN(d.getTime())) return d;
  }

  // "resets 4:20pm (Europe/Kiev)" / "resets 16:20" — a wall clock with no date,
  // so it means the NEXT time that clock reads it, in the zone the CLI named.
  const m = text.match(/resets?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s*\(([^)]+)\))?/i);
  if (!m) return undefined;
  let hour = Number(m[1]);
  const minute = m[2] ? Number(m[2]) : 0;
  const meridiem = m[3]?.toLowerCase();
  if (meridiem === 'pm' && hour < 12) hour += 12;
  if (meridiem === 'am' && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return undefined;
  return nextWallClock(hour, minute, m[4]);
}

/**
 * The next instant at which local time in `timeZone` reads `hour:minute`. Falls
 * back to the machine's own zone when the CLI named none, and returns undefined
 * for a zone Intl rejects.
 */
function nextWallClock(hour: number, minute: number, timeZone: string | undefined): Date | undefined {
  try {
    const tz = timeZone?.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone;
    const now = Date.now();
    // Wall-clock "now" in that zone, expressed as a UTC epoch so date arithmetic
    // works with plain UTC getters.
    const nowWall = now + zoneOffsetMs(tz, now);
    const d = new Date(nowWall);
    let targetWall = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hour, minute);
    if (targetWall <= nowWall) targetWall += 24 * 60 * 60 * 1000; // already past today
    // Undo the offset to get a real instant, then re-resolve once: the offset at
    // the target may differ from the offset now (a DST boundary in between).
    const approx = targetWall - zoneOffsetMs(tz, now);
    const exact = targetWall - zoneOffsetMs(tz, approx);
    return Number.isNaN(exact) ? undefined : new Date(exact);
  } catch {
    return undefined; // unknown zone name
  }
}

/** How far ahead of UTC `timeZone` is at instant `at`, in milliseconds. */
function zoneOffsetMs(timeZone: string, at: number): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(at));
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? '0');
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - at;
}

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
  /** Error subclass name, e.g. "TypeError", "UsageLimitError". Absent for thrown non-Errors. */
  name?: string;
  /** Stack of the outermost error — the only pointer back to the throwing line. */
  stack?: string;
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
  if (err instanceof Error) {
    detail.name = err.name;
    if (err.stack) detail.stack = err.stack;
  }

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
