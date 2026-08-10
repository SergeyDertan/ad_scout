// Extract replies for a hub running on ANOTHER machine, using THIS machine's
// Claude Code subscription. No database, no mailbox, no .env beyond the model:
// the hub sends everything an extraction needs and stores everything it produces.
//
//     REMOTE_HUB_URL=https://xxxx.ngrok-free.app \
//     REMOTE_TOKEN=<the hub's token> \
//     CLAUDE_CODE_MODEL=claude-sonnet-5 pnpm remote:worker
//
//   --concurrency N  replies in the model at once (default 1). One call takes
//                    minutes; raise it to keep a fast machine busy.
//   --id NAME        how this worker shows up in the hub's log (default: hostname).
//   --once           take one reply, report it, exit. Handy for a first test.
//
// Requires `claude` on PATH and `claude login` — the same setup the local
// claude-code provider needs (adapters/llm/claude-code.provider.ts).
//
// Nothing here is lost on a crash or Ctrl-C: the hub holds a lease per reply and
// re-queues anything a worker doesn't report back, so the reply stays 'pending'
// in the database until someone actually extracts it.

import 'dotenv/config';
import { hostname } from 'node:os';
import { loadConfig } from '../config';
import { UsageLimitError } from '../lib/errors';
import { buildLlm } from '../lib/factory';
import { extractReplyCore } from '../pipeline/extract-core';
import type { RemoteJob } from '../server/remote-hub';
import { Extractor } from '../services/extractor';

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i === -1 || i + 1 >= process.argv.length ? undefined : process.argv[i + 1];
}

function numArg(flag: string): number | undefined {
  const v = arg(flag);
  const n = v == null ? NaN : Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function fmtMs(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
}

function log(msg: string): void {
  console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);
}

const hubUrl = (process.env.REMOTE_HUB_URL ?? '').replace(/\/+$/, '');
const token = process.env.REMOTE_TOKEN?.trim() ?? '';
const workerId = arg('--id') ?? hostname().replace(/\.local$/, '');
const concurrency = Math.max(1, numArg('--concurrency') ?? 1);
const once = process.argv.includes('--once');

async function hubFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${hubUrl}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      // ngrok's free tier serves a browser interstitial to anything that looks
      // like a browser; this header opts an API client out of it.
      'ngrok-skip-browser-warning': 'true',
      ...init.headers,
    },
  });
}

// A usage limit belongs to the MACHINE, not to one reply — every lane parks.
let parkedUntil = 0;
let stopping = false;

/** The hub's failure backstop tripped. Not a transport problem — retrying it is
 *  pointless, so the worker exits instead of hammering a hub that has given up. */
class HubStoppedError extends Error {}

async function claim(): Promise<RemoteJob | undefined> {
  const res = await hubFetch('/work/claim', {
    method: 'POST',
    body: JSON.stringify({ workerId, model: llm.model ?? llm.name }),
  });
  if (res.status === 204) return undefined; // long-poll expired, nothing pending
  if (res.status === 503) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; stopped?: boolean };
    if (body.stopped) throw new HubStoppedError(body.error ?? 'hub stopped handing out work');
  }
  if (!res.ok) throw new Error(`claim failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as { job?: RemoteJob };
  return body.job;
}

async function reportResult(job: RemoteJob, extracted: unknown): Promise<string> {
  const res = await hubFetch(`/work/${job.id}/result`, {
    method: 'POST',
    body: JSON.stringify({ extracted }),
  });
  const body = (await res.json().catch(() => ({}))) as { outcome?: string; offers?: number; error?: string };
  if (!res.ok) throw new Error(`hub rejected the result: HTTP ${res.status} ${body.error ?? ''}`);
  return body.outcome === 'ignored'
    ? 'stored as spam (sender ignored)'
    : `stored · ${body.offers ?? 0} offer(s)`;
}

async function reportError(job: RemoteJob, err: unknown): Promise<void> {
  const usageLimit = err instanceof UsageLimitError;
  await hubFetch(`/work/${job.id}/error`, {
    method: 'POST',
    body: JSON.stringify({
      message: err instanceof Error ? err.message : String(err),
      ...(usageLimit ? { usageLimit: true } : {}),
      ...(usageLimit && err.resetAt ? { resetAt: err.resetAt.toISOString() } : {}),
    }),
  }).catch(() => {
    // The hub is unreachable; its lease will expire and re-queue the reply on its
    // own, so there is nothing to recover here — don't mask the original error.
  });
}

const config = loadConfig({
  ...process.env,
  // A worker exists to run the model, so claude-code is the default here rather
  // than the global 'dummy'. Override with LLM_PROVIDER to bake off another one.
  LLM_PROVIDER: process.env.LLM_PROVIDER ?? 'claude-code',
});
const llm = buildLlm(config);
const extractor = new Extractor(llm);

/** Run one job to completion, keeping the terminal (and the hub's lease) alive. */
async function work(job: RemoteJob): Promise<void> {
  const t0 = Date.now();
  log(`▶ ${job.site} — extracting (attempt ${job.attempt}/${job.attempts})…`);

  // A single extraction is minutes of silence: a linked price sheet, several
  // model turns. Print progress so the terminal shows the run is alive, and
  // hold the lease so the hub doesn't hand the reply to someone else.
  const ticker = setInterval(() => log(`  … still on ${job.site} (${fmtMs(Date.now() - t0)})`), 30_000);
  const heartbeat = setInterval(() => {
    void hubFetch(`/work/${job.id}/heartbeat`, { method: 'POST' })
      .then((res) => {
        if (res.status === 409) log(`  ! lease on ${job.site} was lost — the hub re-queued it; this result will be discarded`);
      })
      .catch(() => {});
  }, 60_000);

  try {
    const extracted = await extractReplyCore(extractor, job.input);
    const offers = extracted.outcome.result.offers.length;
    const status = await reportResult(job, extracted);
    log(`✓ ${job.site} — ${offers} offer(s) in ${fmtMs(Date.now() - t0)} · ${status}`);
  } catch (err) {
    if (err instanceof UsageLimitError) {
      // Park every lane until the window reopens. The reply is untouched and
      // stays pending on the hub — another machine can take it meanwhile.
      const resumeAt = err.resetAt ? err.resetAt.getTime() + 60_000 : Date.now() + 60 * 60_000;
      parkedUntil = Math.max(parkedUntil, resumeAt);
      await reportError(job, err);
      log(
        `⏸ usage limit reached — ${job.site} handed back to the hub. ` +
          `Sleeping ${fmtMs(resumeAt - Date.now())}${err.resetAt ? ` (resumes ${err.resetAt.toLocaleTimeString()})` : ''}.`,
      );
      return;
    }
    await reportError(job, err);
    log(`✗ ${job.site} — ${err instanceof Error ? err.message.slice(0, 200) : String(err)} (${fmtMs(Date.now() - t0)})`);
  } finally {
    clearInterval(ticker);
    clearInterval(heartbeat);
  }
}

/** One lane: claim → work → repeat. Several run in parallel under --concurrency. */
async function lane(): Promise<void> {
  while (!stopping) {
    if (parkedUntil > Date.now()) {
      await new Promise((r) => setTimeout(r, Math.min(60_000, parkedUntil - Date.now())));
      continue;
    }
    let job: RemoteJob | undefined;
    try {
      job = await claim();
    } catch (err) {
      if (err instanceof HubStoppedError) {
        log(`■ ${err.message}`);
        stopping = true; // stop the other lanes too
        return;
      }
      // Tunnel blip, hub restarted, laptop asleep — back off and keep trying
      // rather than exit; an unattended worker should survive the network.
      log(`… hub unreachable (${err instanceof Error ? err.message.slice(0, 120) : String(err)}) — retrying in 15s`);
      await new Promise((r) => setTimeout(r, 15_000));
      continue;
    }
    if (!job) continue; // the claim long-polled and found nothing
    await work(job);
    if (once) return;
  }
}

async function main(): Promise<void> {
  if (!hubUrl) throw new Error('set REMOTE_HUB_URL to the hub\'s public URL (the one ngrok printed)');
  if (!token) throw new Error('set REMOTE_TOKEN to the token the hub printed at startup');

  // Verify the URL and token before doing anything slow — a typo here otherwise
  // shows up minutes later as a discarded extraction.
  let pending: number;
  try {
    const res = await hubFetch('/status');
    if (res.status === 401) throw new Error('REMOTE_TOKEN does not match the hub');
    if (!res.ok) throw new Error(`hub answered HTTP ${res.status}`);
    ({ pending } = (await res.json()) as { pending: number });
  } catch (err) {
    throw new Error(`cannot reach the hub at ${hubUrl}: ${err instanceof Error ? err.message : String(err)}`);
  }

  console.log(`\nAdScout remote worker "${workerId}" → ${hubUrl}`);
  console.log(`  provider=${llm.name}  model=${llm.model ?? 'n/a'}  concurrency=${concurrency}`);
  if (llm.name === 'dummy') {
    console.log('  WARNING: the dummy provider returns canned results — set LLM_PROVIDER=claude-code for real work.');
  }
  console.log(`  hub has ${pending} reply(ies) pending\n`);

  const stop = (): void => {
    if (stopping) {
      console.log('\nforcing exit — in-flight replies stay pending on the hub.');
      process.exit(130);
    }
    stopping = true;
    console.log('\nstopping after the current reply… (Ctrl-C again to force)');
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  await Promise.all(Array.from({ length: concurrency }, lane));
  console.log('worker stopped.');
}

main().catch((err) => {
  console.error(`remote:worker failed — ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
