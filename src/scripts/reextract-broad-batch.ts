// Re-extract every BROAD-batch reply (matched, already extracted, with ≥1 offer)
// through the current extractor, applying the batch-aware prompt fixes:
//   1. broad ask ⇒ a niche-less flat price is `regular`, not the pitch niche
//      (casino), unless the reply explicitly names casino/grey; and
//   2. additive surcharges ("casino €150 extra") become base + surcharge instead
//      of a bogus bare absolute.
// The historical casino-specific "first" batch is LEFT UNTOUCHED (its casino
// framing is correct — pitchStyleForBatch keeps those on the casino prompt).
//
// RESUMABLE + IDEMPOTENT: each processed reply id is appended to a progress file
// (.reextract-broad-progress.json) as we go. If the LLM usage limit is hit the run
// stops cleanly (exit 2) with progress saved; re-run to continue. Re-running after
// completion is a no-op.
//
//     STORE=pouchdb LLM_PROVIDER=claude-code pnpm reextract:broad-batch            # dry run
//     STORE=pouchdb LLM_PROVIDER=claude-code pnpm reextract:broad-batch --apply
//       [--limit N]   process at most N replies this run (pace the usage window)

import 'dotenv/config';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../config';
import { pitchStyleForBatch } from '../domain/pitch';
import { emailToDomains } from '../domain/reply-matching';
import type { PostOffer, Reply } from '../domain/types';
import { systemClock } from '../lib/clock';
import { UsageLimitError } from '../lib/errors';
import { buildAgent } from '../lib/factory';
import { ingestReply } from '../pipeline/poll-pass';

const PROGRESS_FILE = join(process.cwd(), '.reextract-broad-progress.json');

function loadDone(): Set<string> {
  if (!existsSync(PROGRESS_FILE)) return new Set();
  try {
    return new Set(JSON.parse(readFileSync(PROGRESS_FILE, 'utf8')) as string[]);
  } catch {
    return new Set();
  }
}
function saveDone(done: Set<string>): void {
  writeFileSync(PROGRESS_FILE, JSON.stringify([...done]));
}

const priced = (o: PostOffer) => o.price?.amount != null;
const ADDITIVE = /\bextra\b|surcharge/i;

/** A broad-batch reply KNOWN to be hit by one of the two bugs: a flat price
 *  narrowed to `casino` (priced casino, no priced regular), or a grey-niche flat
 *  surcharge ("… extra"/"surcharge") that was stored as a bare absolute. Default
 *  scope; `--all` re-extracts every broad-batch reply regardless. */
function isAffected(r: Reply): boolean {
  const offs = r.parsed?.offers ?? [];
  const casinoOnly =
    offs.some((o) => o.category === 'casino' && priced(o)) &&
    !offs.some((o) => o.category === 'regular' && priced(o));
  const surcharge = offs.some((o) => o.sensitive && priced(o) && ADDITIVE.test(o.price?.raw ?? ''));
  return casinoOnly || surcharge;
}
/** A compact "cat:amount" fingerprint of a reply's priced cells, for change logging. */
const fingerprint = (r: Reply) =>
  (r.parsed?.offers ?? [])
    .filter(priced)
    .map((o) => `${o.category}:${o.price!.amount}`)
    .sort()
    .join(' ') || '—';

function numArg(flag: string): number | undefined {
  const i = process.argv.indexOf(flag);
  if (i === -1 || i + 1 >= process.argv.length) return undefined;
  const n = Number(process.argv[i + 1]);
  return Number.isFinite(n) ? n : undefined;
}

async function main() {
  const apply = process.argv.includes('--apply');
  const all = process.argv.includes('--all');
  const limit = numArg('--limit');
  const config = loadConfig();
  const { store, email, extractor, llm } = buildAgent(config);
  const deps = { store, email, extractor, clock: systemClock, config };
  const done = loadDone();

  const targets = await store.listTargets();
  const targetById = new Map(targets.map((t) => [t.id, t]));
  const emailDomainMap = emailToDomains(targets);

  // Old price records per reply — deleted before re-ingest so the fresh records
  // replace the stale ones instead of piling up alongside them.
  const recsByReply = new Map<string, string[]>();
  for (const rec of await store.listPriceRecords()) {
    if (!rec.replyId) continue;
    const list = recsByReply.get(rec.replyId) ?? recsByReply.set(rec.replyId, []).get(rec.replyId)!;
    list.push(rec.id);
  }

  const replies = await store.listReplies();
  const targetSet = replies.filter((r) => {
    if (!r.targetId || done.has(r.id) || r.extractionStatus !== 'done') return false;
    if ((r.parsed?.offers?.length ?? 0) === 0) return false; // nothing to re-derive
    const t = targetById.get(r.targetId);
    if (!t || pitchStyleForBatch(t.batchId) !== 'broad') return false; // broad batches only
    return all || isAffected(r); // default: only known-affected replies
  });

  console.log(`${apply ? 'APPLY' : 'DRY RUN'}  store=${config.store} llm=${llm.name}  scope=${all ? 'ALL broad-batch' : 'affected only'}`);
  console.log(`already done: ${done.size}   to process: ${targetSet.length}${limit != null ? ` (capped at ${limit})` : ''}\n`);

  if (!apply) {
    for (const r of targetSet.slice(0, 40)) console.log(`  ${r.id.slice(0, 26)}  ${r.fromAddress.padEnd(32)} [${fingerprint(r)}]`);
    if (targetSet.length > 40) console.log(`  … and ${targetSet.length - 40} more`);
    console.log('\nnothing written — re-run with --apply');
    await store.close?.();
    return;
  }

  const work = limit != null ? targetSet.slice(0, limit) : targetSet;
  let changed = 0;
  let unchanged = 0;
  let i = 0;
  for (const reply of work) {
    i++;
    const target = targetById.get(reply.targetId!)!;
    const before = fingerprint(reply);
    try {
      for (const id of recsByReply.get(reply.id) ?? []) await store.deletePriceRecord(id);
      await ingestReply(deps, reply, target, emailDomainMap);
      await store.putReply(reply);
      done.add(reply.id);
      saveDone(done);
      const after = fingerprint(reply);
      if (after !== before) {
        changed++;
        console.log(`[${i}/${work.length}] ~ ${target.websiteUrl}\n      before: [${before}]\n      after:  [${after}]`);
      } else {
        unchanged++;
        console.log(`[${i}/${work.length}] = ${target.websiteUrl}  [${after}]`);
      }
    } catch (err) {
      if (err instanceof UsageLimitError) {
        const when = err.resetAt ? ` — resets ${err.resetAt.toLocaleString()}` : '';
        console.log(`\nSTOP: LLM usage limit${when}. Progress saved (${done.size} done). Re-run to resume.`);
        await store.close?.();
        process.exit(2);
      }
      console.log(`[${i}/${work.length}] FAIL ${target.websiteUrl} — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log(`\ndone: ${changed} changed, ${unchanged} unchanged, ${done.size} total processed.`);
  await store.close?.();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
