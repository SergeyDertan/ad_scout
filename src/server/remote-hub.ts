// Remote extraction hub — hands unextracted replies to workers on OTHER machines
// and writes back what they return.
//
// Why: extraction runs on a Claude Code subscription (see adapters/llm/
// claude-code.provider.ts), and one machine's usage window is the bottleneck on
// a large re-extract. A second logged-in machine doubles the throughput without
// touching per-token API billing. The database stays here; only the work travels.
//
//     HOST                                  WORKER (other machine)
//     ────                                  ──────────────────────
//     pnpm remote:hub          ── ngrok ──▶ pnpm remote:worker
//       POST /work/claim  ─────────────────▶ claims one reply
//         { input: ExtractInput }             extractReplyCore(…)  ← same code
//       POST /work/:id/result ◀───────────── { extracted: ExtractedReply }
//         persistExtraction(…)  ← same code
//
// The split is poll-pass's own seam: extract (slow, writes nothing) then persist
// (fast, every write). The worker runs the first half against its own `claude`
// CLI; this file runs the second half, so a remotely extracted reply lands in the
// store through the identical code path a local run uses — same rollup, same
// price records, same provenance.
//
// SERIALIZED WRITES: every persist goes through one Mutex. PouchDB's put() reads
// a doc's current _rev and writes it back, so two extractions landing at once —
// on a shared target, a niche both just learned, the one prompt-snapshot doc —
// would read the same _rev and one write would be rejected with a 409. The model
// calls are what we parallelize (they happen on the workers); the writes are
// milliseconds each and stay one-at-a-time.
//
// TRUST: a worker is another machine of yours behind a shared token, not a public
// endpoint. Bodies are size-capped and structurally validated so a worker running
// an old commit fails loudly instead of writing a half-shaped result, but this is
// not an adversarial boundary — do not expose the hub without REMOTE_TOKEN set.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { LABELS } from '../domain/labels';
import { emailToDomains } from '../domain/reply-matching';
import type { Reply, Target } from '../domain/types';
import { describeError } from '../lib/errors';
import { logger } from '../lib/logger';
import { Mutex } from '../lib/mutex';
import type { ExtractInput, ExtractedReply } from '../pipeline/extract-core';
import { applyLabel, persistExtraction, type PollDeps } from '../pipeline/poll-pass';

/** One unit of work: everything the worker needs, and nothing it doesn't. */
export interface RemoteJob {
  /** The reply id — also the job id the worker reports back against. */
  id: string;
  /** Human label for the worker's log line (contacted site, or the sender). */
  site: string;
  /** Which try this is, and how many the hub will allow before giving up. */
  attempt: number;
  attempts: number;
  /** How long the hub holds this reply for the worker before re-offering it. */
  leaseMs: number;
  input: ExtractInput;
}

/** What the hub reports as it goes, for the CLI's progress output. */
export type HubEvent =
  | { kind: 'claimed'; replyId: string; site: string; workerId: string; model: string; attempt: number; pending: number }
  | { kind: 'done'; replyId: string; site: string; workerId: string; outcome: 'done' | 'ignored'; offers: number; ms: number }
  | { kind: 'failed'; replyId: string; site: string; workerId: string; message: string; attempt: number; givingUp: boolean }
  | { kind: 'limit'; replyId: string; workerId: string; resetAt?: string }
  | { kind: 'expired'; replyId: string; site: string; workerId: string }
  | { kind: 'aborted'; replyId: string; site: string; failedReplies: number };

export interface RemoteHubOptions {
  /** Shared secret every request must carry as `Authorization: Bearer …`. */
  token: string;
  /** How long a claimed reply is held before another worker may take it.
   *  Must outlast a slow extraction (linked sheets, multi-turn research). */
  leaseMs?: number;
  /** Tries per reply before it is marked 'failed'. Mirrors ExtractOptions.attemptsPerReply. */
  attempts?: number;
  /**
   * How many replies may burn every attempt before the hub STOPS handing out
   * work. Default 1, matching extractPendingReplies: a reply that failed every
   * try, spaced out, is not a transient failure, and the rest of the queue would
   * meet the same thing — that is exactly how an unrecognized usage limit once
   * burned hundreds of good replies. Raise it if you would rather a single bad
   * worker not halt a multi-machine run.
   */
  maxFailed?: number;
  /** How long a claim request is held open when there is no work (long-poll). */
  claimWaitMs?: number;
  /** Reject bodies larger than this. Attachments ride along as base64. */
  maxBodyBytes?: number;
  /** Progress sink for the CLI. */
  onEvent?: (ev: HubEvent) => void;
  /**
   * Serializes this hub's writes. Pass the SAME Mutex the pipeline passes use
   * when the dashboard runs in this process: a manual "Run now" and an incoming
   * remote result would otherwise write the store concurrently, which is exactly
   * the _rev race this lock exists to prevent. Defaults to a private one.
   */
  writeLock?: Mutex;
}

export interface RemoteHub {
  server: Server;
  /** Live counters for the CLI's periodic progress line. */
  stats(): HubStats;
  /** Replies still needing extraction, as of the last store read. */
  pendingCount(): Promise<number>;
}

export interface HubStats {
  claimed: number;
  done: number;
  ignored: number;
  failed: number;
  retried: number;
  limits: number;
  /** True once the failure backstop stopped the run — see maxFailed. */
  aborted: boolean;
  inFlight: { replyId: string; site: string; workerId: string; sinceMs: number }[];
  workers: { id: string; model: string; done: number; failed: number; lastSeenMs: number }[];
}

interface Lease {
  replyId: string;
  site: string;
  workerId: string;
  claimedAt: number;
  expiresAt: number;
}

interface WorkerInfo {
  id: string;
  model: string;
  done: number;
  failed: number;
  lastSeenAt: number;
}

const DEFAULTS = {
  // A single extraction can legitimately run minutes (JSON_TIMEOUT_MS is 5 min,
  // plus the worker's own retries), so a lease has to be generous — re-offering a
  // reply that is merely slow would have two machines burning quota on it at once.
  leaseMs: 20 * 60_000,
  attempts: 3,
  // 1 = local parity: extractPendingReplies stops the whole run the first time a
  // reply burns every attempt.
  maxFailed: 1,
  claimWaitMs: 20_000,
  maxBodyBytes: 96 * 1024 * 1024,
};

/** A reply the hub still owes an extraction. Mirrors extractPendingReplies. */
function isPending(r: Reply): boolean {
  return r.extractionStatus === 'pending' || r.extractionStatus === 'failed';
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

/** Constant-time bearer check — a length-independent compare would leak the token
 *  one byte at a time to anything that finds the tunnel. */
function authorized(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization ?? '';
  const presented = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const encoder = new TextEncoder();
  const a = encoder.encode(presented);
  const b = encoder.encode(token);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

async function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const c of req) {
    const buf = c as Uint8Array;
    size += buf.length;
    if (size > maxBytes) throw new Error(`body exceeds ${maxBytes} bytes`);
    chunks.push(buf);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Structurally validate what a worker posted back before it reaches the store.
 * Returns the typed value, or a message naming the first thing that is wrong.
 *
 * This is a version-skew guard, not a security boundary: the worker already ran
 * assembleResult() (it runs the same extractor we do), so the shape is ours. What
 * it catches is a worker on an older commit, a truncated body, or a crash that
 * posted something empty — each of which would otherwise persist as a real
 * extraction and quietly wipe a reply's offers.
 */
function parseExtractedReply(value: unknown): ExtractedReply | string {
  if (!isRecord(value)) return 'not an object';
  const { outcome, ownDomain, guessedDomain, senderSiteRejected } = value;
  if (!isRecord(outcome)) return 'outcome missing';
  if (typeof outcome.isSpam !== 'boolean') return 'outcome.isSpam must be a boolean';
  if (!Array.isArray(outcome.review)) return 'outcome.review must be an array';
  if (!Array.isArray(outcome.discovered)) return 'outcome.discovered must be an array';

  const result = outcome.result;
  if (!isRecord(result)) return 'outcome.result missing';
  if (!Array.isArray(result.offers)) return 'outcome.result.offers must be an array';
  if (typeof result.optOut !== 'boolean') return 'outcome.result.optOut must be a boolean';
  if (typeof result.canPost !== 'string') return 'outcome.result.canPost must be a string';

  // Provenance is the reason this project can audit a stored price. A result with
  // a blank/absent model or prompt hash is worse than no result: it looks like a
  // real extraction forever and can never be traced back to what produced it.
  const prov = outcome.provenance;
  if (!isRecord(prov)) return 'outcome.provenance missing';
  if (typeof prov.provider !== 'string' || !prov.provider) return 'outcome.provenance.provider missing';
  if (typeof prov.promptHash !== 'string' || !prov.promptHash) return 'outcome.provenance.promptHash missing';
  if (typeof prov.promptStyle !== 'string' || !prov.promptStyle) return 'outcome.provenance.promptStyle missing';

  const snap = outcome.promptSnapshot;
  if (!isRecord(snap)) return 'outcome.promptSnapshot missing';
  if (typeof snap.hash !== 'string' || !snap.hash) return 'outcome.promptSnapshot.hash missing';
  if (typeof snap.text !== 'string' || !snap.text) return 'outcome.promptSnapshot.text missing';
  if (snap.hash !== prov.promptHash) return 'promptSnapshot.hash does not match provenance.promptHash';

  if (typeof senderSiteRejected !== 'boolean') return 'senderSiteRejected must be a boolean';
  if (ownDomain !== undefined && typeof ownDomain !== 'string') return 'ownDomain must be a string';
  if (guessedDomain !== undefined && typeof guessedDomain !== 'string') return 'guessedDomain must be a string';

  return value as unknown as ExtractedReply;
}

/** What to call a reply in a log line. */
function labelFor(reply: Reply, target: Target | undefined): string {
  return target?.websiteUrl ?? `(no target) ${reply.fromAddress}`;
}

export function createRemoteHub(deps: PollDeps, opts: RemoteHubOptions): RemoteHub {
  const { store } = deps;
  if (!opts.token) throw new Error('remote hub refuses to start without a token');

  const leaseMs = opts.leaseMs ?? DEFAULTS.leaseMs;
  const attempts = opts.attempts ?? DEFAULTS.attempts;
  const maxFailed = Math.max(1, opts.maxFailed ?? DEFAULTS.maxFailed);
  const claimWaitMs = opts.claimWaitMs ?? DEFAULTS.claimWaitMs;
  const maxBodyBytes = opts.maxBodyBytes ?? DEFAULTS.maxBodyBytes;
  const emit = opts.onEvent ?? (() => {});

  // Every store write in this file runs inside this. See the header note.
  const writeLock = opts.writeLock ?? new Mutex();

  const leases = new Map<string, Lease>();
  const attemptsById = new Map<string, number>();
  /** Replies that burned every attempt this run — 'failed' in the store, so they
   *  would otherwise be re-offered forever by isPending(). */
  const exhausted = new Set<string>();
  const workers = new Map<string, WorkerInfo>();
  const stats = { claimed: 0, done: 0, ignored: 0, failed: 0, retried: 0, limits: 0 };
  /** Set by the failure backstop; no further work is handed out once true. */
  let aborted = false;

  // The pending queue is cached: listReplies() pulls every reply INCLUDING inline
  // attachment base64, so re-reading it on every claim would be the most expensive
  // thing the hub does. Refreshed on a TTL and whenever it runs dry.
  let queue: Reply[] = [];
  let queuedAt = 0;
  // The hub holds the process lock, so nothing else is writing replies while it
  // runs — a slightly stale queue can only be stale in ways the lease and
  // exhausted sets already filter out. Refreshed on this TTL or whenever it runs dry.
  const QUEUE_TTL_MS = 60_000;

  async function refreshQueue(): Promise<void> {
    queue = (await store.listReplies()).filter(isPending);
    queuedAt = Date.now();
  }

  function reapExpiredLeases(): void {
    const now = Date.now();
    for (const lease of [...leases.values()]) {
      if (lease.expiresAt > now) continue;
      leases.delete(lease.replyId);
      // Not an attempt: we never heard whether the model call succeeded. The
      // usual cause is a worker that lost its network or was Ctrl-C'd, and the
      // reply is still 'pending' in the store, so re-offering it is safe.
      emit({ kind: 'expired', replyId: lease.replyId, site: lease.site, workerId: lease.workerId });
      logger.warn('remote lease expired — reply re-queued', {
        replyId: lease.replyId,
        workerId: lease.workerId,
        heldMs: now - lease.claimedAt,
      });
    }
  }

  async function nextPending(): Promise<Reply | undefined> {
    reapExpiredLeases();
    if (queue.length === 0 || Date.now() - queuedAt > QUEUE_TTL_MS) await refreshQueue();
    return queue.find((r) => !leases.has(r.id) && !exhausted.has(r.id));
  }

  async function buildJob(reply: Reply, workerId: string, model: string): Promise<RemoteJob> {
    const target = reply.targetId ? await store.getTarget(reply.targetId) : undefined;
    const site = labelFor(reply, target);
    const attempt = (attemptsById.get(reply.id) ?? 0) + 1;

    leases.set(reply.id, {
      replyId: reply.id,
      site,
      workerId,
      claimedAt: Date.now(),
      expiresAt: Date.now() + leaseMs,
    });
    stats.claimed++;
    emit({
      kind: 'claimed',
      replyId: reply.id,
      site,
      workerId,
      model,
      attempt,
      pending: queue.filter((r) => !leases.has(r.id) && !exhausted.has(r.id)).length,
    });

    return {
      id: reply.id,
      site,
      attempt,
      attempts,
      leaseMs,
      input: {
        reply,
        ...(target ? { target } : {}),
        // Read per job rather than cached: a worker that just discovered a niche
        // should have it in the list the next reply is extracted against, exactly
        // as a local sequential run would.
        niches: await store.listNiches(),
        // The HOST's pitch, never the worker's env. See ExtractInput.
        pitch: deps.config.pitch,
      },
    };
  }

  /** The store's current copy of a reply. persistExtraction mutates the doc in
   *  place, so it must run against a fresh read, never the cached queue entry. */
  async function reload(replyId: string): Promise<Reply | undefined> {
    return (await store.listReplies()).find((r) => r.id === replyId);
  }

  /**
   * The write half, serialized. Mirrors extractPendingReplies' persist step —
   * including the mailbox label, so a remotely extracted reply ends up in the
   * same Gmail label as a locally extracted one (AS/Answered, AS/Declined, …).
   *
   * The label is applied AFTER the lock releases, exactly as the local path does
   * it after its persist section: it is a Gmail round-trip, and holding the one
   * write lock across it would stall every other worker's result behind network
   * latency for a step that is best-effort anyway.
   */
  async function persist(
    replyId: string,
    extracted: ExtractedReply,
  ): Promise<{ outcome: 'done' | 'ignored'; offers: number } | undefined> {
    const written = await writeLock.run(async () => {
      const reply = await reload(replyId);
      if (!reply) return undefined;
      const target = reply.targetId ? await store.getTarget(reply.targetId) : undefined;
      const emailDomainMap = emailToDomains(await store.listTargets());
      const result = await persistExtraction(deps, reply, target, emailDomainMap, extracted);
      await store.putReply(reply);

      const accountId = reply.accountId ?? target?.assignedAccountId;
      return {
        outcome: (result.kind === 'ignored' ? 'ignored' : 'done') as 'done' | 'ignored',
        offers: reply.parsed?.offers?.length ?? 0,
        emailId: reply.emailId,
        label: result.kind === 'ignored' ? LABELS.ignored : result.label,
        account: accountId ? await store.getAccount(accountId) : undefined,
      };
    });
    if (!written) return undefined;
    if (written.account) await applyLabel(deps, written.account, written.emailId, written.label);
    return { outcome: written.outcome, offers: written.offers };
  }

  /** Mark a reply 'failed' after it burned every attempt — and label it AS/Replied,
   *  the same provisional label a locally failed extraction leaves behind. */
  async function markFailed(replyId: string): Promise<void> {
    const written = await writeLock.run(async () => {
      const reply = await reload(replyId);
      if (!reply) return undefined;
      reply.extractionStatus = 'failed';
      await store.putReply(reply);
      const target = reply.targetId ? await store.getTarget(reply.targetId) : undefined;
      const accountId = reply.accountId ?? target?.assignedAccountId;
      return {
        emailId: reply.emailId,
        account: accountId ? await store.getAccount(accountId) : undefined,
      };
    });
    if (written?.account) await applyLabel(deps, written.account, written.emailId, LABELS.matched);
  }

  function forget(replyId: string): void {
    leases.delete(replyId);
    queue = queue.filter((r) => r.id !== replyId);
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      logger.error('remote hub request crashed', { ...describeError(err) });
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? 'GET';
    const url = new URL(req.url ?? '/', 'http://localhost');
    const seg = url.pathname.split('/').filter(Boolean);

    // Unauthenticated liveness ping — carries no data, and confirms the tunnel
    // reaches THIS process before you go hunting for a token problem.
    if (method === 'GET' && seg.length === 0) {
      sendJson(res, 200, { ok: true, service: 'adscout-remote-hub' });
      return;
    }

    if (!authorized(req, opts.token)) {
      sendJson(res, 401, { error: 'unauthorized — set REMOTE_TOKEN to the hub\'s token' });
      return;
    }

    // GET /status — counters for a worker or a human checking in.
    if (method === 'GET' && seg[0] === 'status') {
      reapExpiredLeases();
      sendJson(res, 200, { ...hubStats(), pending: (await nextPendingCount()) });
      return;
    }

    // POST /work/claim { workerId, model } → 200 { job } | 204 (nothing to do)
    if (method === 'POST' && seg[0] === 'work' && seg[1] === 'claim' && seg.length === 2) {
      const body = (await readJsonBody(req, 1024 * 64)) as { workerId?: string; model?: string };
      const workerId = typeof body.workerId === 'string' && body.workerId ? body.workerId : 'worker';
      const model = typeof body.model === 'string' ? body.model : 'unknown';
      const info = workers.get(workerId) ?? { id: workerId, model, done: 0, failed: 0, lastSeenAt: 0 };
      info.model = model;
      info.lastSeenAt = Date.now();
      workers.set(workerId, info);

      // The backstop tripped: tell the worker plainly instead of letting it sit
      // in a long-poll against a hub that will never hand out work again.
      if (aborted) {
        sendJson(res, 503, {
          error: `hub stopped: ${stats.failed} repl(y/ies) failed every attempt — check the logs and re-run`,
          stopped: true,
        });
        return;
      }

      // Long-poll: hold the request open rather than make the worker hammer the
      // tunnel. Claiming is serialized through the write lock too — two workers
      // asking at the same instant must not be handed the same reply.
      const deadline = Date.now() + claimWaitMs;
      for (;;) {
        const job = await writeLock.run(async () => {
          const reply = await nextPending();
          return reply ? await buildJob(reply, workerId, model) : undefined;
        });
        if (job) {
          sendJson(res, 200, { job });
          return;
        }
        if (Date.now() >= deadline || req.destroyed) {
          res.writeHead(204).end();
          return;
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
    }

    // POST /work/:id/heartbeat — extend the lease on a slow extraction.
    if (method === 'POST' && seg[0] === 'work' && seg[2] === 'heartbeat' && seg.length === 3) {
      const lease = leases.get(seg[1]!);
      if (!lease) {
        sendJson(res, 409, { error: 'lease lost — stop work, the reply was re-queued' });
        return;
      }
      lease.expiresAt = Date.now() + leaseMs;
      sendJson(res, 200, { ok: true, expiresInMs: leaseMs });
      return;
    }

    // POST /work/:id/result { extracted } — the whole point of the hub.
    if (method === 'POST' && seg[0] === 'work' && seg[2] === 'result' && seg.length === 3) {
      const replyId = seg[1]!;
      const lease = leases.get(replyId);
      if (!lease) {
        // Its lease expired and someone else may hold it now. Refusing the write
        // is the safe call: persisting twice would append the price history twice.
        sendJson(res, 409, { error: 'lease expired — result discarded, the reply was re-queued' });
        return;
      }
      const body = (await readJsonBody(req, maxBodyBytes)) as { extracted?: unknown };
      const parsed = parseExtractedReply(body.extracted);
      if (typeof parsed === 'string') {
        logger.error('remote worker posted an unusable result', { replyId, workerId: lease.workerId, reason: parsed });
        sendJson(res, 400, { error: `unusable result: ${parsed}` });
        return;
      }

      try {
        const stored = await persist(replyId, parsed);
        if (!stored) {
          forget(replyId);
          sendJson(res, 409, { error: 'reply no longer exists' });
          return;
        }
        const { outcome, offers } = stored;
        forget(replyId);
        attemptsById.delete(replyId);
        if (outcome === 'ignored') stats.ignored++;
        else stats.done++;
        const info = workers.get(lease.workerId);
        if (info) info.done++;
        emit({
          kind: 'done',
          replyId,
          site: lease.site,
          workerId: lease.workerId,
          outcome,
          offers,
          ms: Date.now() - lease.claimedAt,
        });
        sendJson(res, 200, { outcome, offers });
      } catch (err) {
        // The extraction was fine; WE failed to store it. Re-queue rather than
        // charge the worker an attempt — retrying costs another model call, but
        // silently dropping a good extraction costs the reply.
        forget(replyId);
        await refreshQueue();
        logger.error('remote result failed to persist', { replyId, ...describeError(err) });
        sendJson(res, 500, { error: 'failed to persist — reply re-queued' });
      }
      return;
    }

    // POST /work/:id/error { message, usageLimit?, resetAt? }
    if (method === 'POST' && seg[0] === 'work' && seg[2] === 'error' && seg.length === 3) {
      const replyId = seg[1]!;
      const lease = leases.get(replyId);
      const body = (await readJsonBody(req, 1024 * 64)) as {
        message?: string;
        usageLimit?: boolean;
        resetAt?: string;
      };
      const message = typeof body.message === 'string' ? body.message.slice(0, 500) : 'unknown error';

      if (!lease) {
        sendJson(res, 200, { status: 'ignored', note: 'lease already gone' });
        return;
      }
      leases.delete(replyId);

      // A usage limit is the WORKER's window closing, not this reply's fault: it
      // costs no attempt and the reply stays pending, exactly as a local run
      // leaves it (see extractPendingReplies' UsageLimitError branch). Another
      // worker — or this one after its reset — picks it straight back up.
      if (body.usageLimit) {
        stats.limits++;
        emit({ kind: 'limit', replyId, workerId: lease.workerId, ...(body.resetAt ? { resetAt: body.resetAt } : {}) });
        logger.warn('remote worker hit its usage limit', {
          replyId,
          workerId: lease.workerId,
          ...(body.resetAt ? { resetAt: body.resetAt } : {}),
        });
        sendJson(res, 200, { status: 'requeued' });
        return;
      }

      const attempt = (attemptsById.get(replyId) ?? 0) + 1;
      attemptsById.set(replyId, attempt);
      const info = workers.get(lease.workerId);
      if (info) info.failed++;
      const givingUp = attempt >= attempts;
      if (givingUp) {
        await markFailed(replyId);
        exhausted.add(replyId);
        forget(replyId);
        stats.failed++;
        // This reply got every attempt, spread over separate claims, and still
        // failed — so whatever is wrong is not transient and the rest of the
        // queue would meet it too. Stop handing out work rather than spend the
        // whole queue on it. The replies are left 'failed'; a later run re-picks
        // them, exactly as `reextract:stored --extract-only` does.
        if (!aborted && stats.failed >= maxFailed) {
          aborted = true;
          emit({ kind: 'aborted', replyId, site: lease.site, failedReplies: stats.failed });
          logger.error('remote hub aborted — a reply failed every attempt', {
            replyId,
            attempts,
            failedReplies: stats.failed,
          });
        }
      } else {
        stats.retried++;
      }
      emit({ kind: 'failed', replyId, site: lease.site, workerId: lease.workerId, message, attempt, givingUp });
      logger.error('remote extraction failed', { replyId, workerId: lease.workerId, attempt, attempts, givingUp, message });
      sendJson(res, 200, { status: givingUp ? 'failed' : 'requeued', attempt, attempts });
      return;
    }

    sendJson(res, 404, { error: 'not found' });
  }

  function hubStats(): HubStats {
    const now = Date.now();
    return {
      ...stats,
      aborted,
      inFlight: [...leases.values()].map((l) => ({
        replyId: l.replyId,
        site: l.site,
        workerId: l.workerId,
        sinceMs: now - l.claimedAt,
      })),
      workers: [...workers.values()].map((w) => ({
        id: w.id,
        model: w.model,
        done: w.done,
        failed: w.failed,
        lastSeenMs: now - w.lastSeenAt,
      })),
    };
  }

  async function nextPendingCount(): Promise<number> {
    if (queue.length === 0 || Date.now() - queuedAt > QUEUE_TTL_MS) await refreshQueue();
    return queue.filter((r) => !exhausted.has(r.id)).length;
  }

  return { server, stats: hubStats, pendingCount: nextPendingCount };
}
