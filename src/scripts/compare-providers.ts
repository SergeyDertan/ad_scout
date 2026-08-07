// Re-run stored, already-extracted replies through a DIFFERENT LLM provider and
// diff the result against what is in the DB. Writes nothing back — it is a
// read-only bake-off used to decide whether a provider is trustworthy before
// pointing the live poll pass at it.
//
//     STORE=pouchdb tsx src/scripts/compare-providers.ts [options]
//
//   --provider K    provider to test (default 'antigravity'); any LlmProviderKind
//   --model M       override that provider's model (e.g. gemini-3.1-pro-high)
//   --n N           replies to sample (default 5)
//   --bucket B      'mixed' (default) | 'priced' | 'research' | 'empty'
//   --style S       'any' (default) | 'broad' | 'casino' — the pitch style, i.e.
//                   which of the two system prompts the reply is extracted under
//   --any-prompt    compare against stale baselines too (see below)
//   --out DIR       where to write the per-reply JSON + summary (default ./logs/compare)
//
// The pitch style is NOT a choice here: it is derived per reply exactly as the
// live pipeline derives it (pitchStyleForBatch(target.batchId) — the historical
// casino batch vs everything else), so each reply is re-run under the same
// prompt VARIANT that produced its stored result.
//
// The prompt TEXT still drifts as the rules are edited. A reply whose stored
// result predates the current text would diff for that reason alone, so by
// default only replies whose stored promptHash equals today's fingerprint are
// sampled. --any-prompt lifts that, and then a diff means nothing on its own.
//
// Email bodies and full results go to DIR, never to stdout: the console gets a
// one-line-per-reply verdict table only.

import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig, type LlmProviderKind } from '../config';
import { buildStore, buildLlm } from '../lib/factory';
import { Extractor, promptFingerprint } from '../services/extractor';
import { normalizeDomain } from '../domain/domain';
import { pitchStyleForBatch, type PitchStyle } from '../domain/pitch';
import { senderSiteDomain } from '../domain/reply-matching';
import type { OutreachResult, PostOffer, Reply, Target } from '../domain/types';

const URL_RE = /https?:\/\/[^\s<>()]+/gi;

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}

/** A reply's comparable "shape": one line per priced cell, provider-independent. */
function cells(result: OutreachResult | undefined): Map<string, string> {
  const m = new Map<string, string>();
  for (const o of result?.offers ?? []) m.set(cellKey(o), cellValue(o));
  return m;
}
const cellKey = (o: PostOffer) => `${o.category}@${o.term?.key ?? 'none'}${o.website ? `#${o.website}` : ''}`;
const cellValue = (o: PostOffer) =>
  `${o.canPost}/${o.price?.amount ?? '-'}${o.price?.currency ?? o.price?.currencyRaw ?? ''}`;

interface Diff {
  same: string[];
  changed: { cell: string; stored: string; fresh: string }[];
  onlyStored: string[];
  onlyFresh: string[];
  intent: { stored?: string; fresh?: string };
  canPost: { stored?: string; fresh?: string };
  optOut: { stored?: boolean; fresh?: boolean };
}

function diff(stored: OutreachResult | undefined, fresh: OutreachResult): Diff {
  const a = cells(stored);
  const b = cells(fresh);
  const d: Diff = {
    same: [],
    changed: [],
    onlyStored: [],
    onlyFresh: [],
    intent: { stored: stored?.intent, fresh: fresh.intent },
    canPost: { stored: stored?.canPost, fresh: fresh.canPost },
    optOut: { stored: stored?.optOut, fresh: fresh.optOut },
  };
  for (const [k, v] of a) {
    if (!b.has(k)) d.onlyStored.push(`${k}=${v}`);
    else if (b.get(k) !== v) d.changed.push({ cell: k, stored: v, fresh: b.get(k)! });
    else d.same.push(`${k}=${v}`);
  }
  for (const [k, v] of b) if (!a.has(k)) d.onlyFresh.push(`${k}=${v}`);
  return d;
}

/** Perfect agreement on the parts that end up in a PriceRecord. */
function isMatch(d: Diff): boolean {
  return (
    d.changed.length === 0 &&
    d.onlyStored.length === 0 &&
    d.onlyFresh.length === 0 &&
    d.intent.stored === d.intent.fresh &&
    d.canPost.stored === d.canPost.fresh &&
    d.optOut.stored === d.optOut.fresh
  );
}

function hasResearch(r: Reply): boolean {
  return (r.attachments?.length ?? 0) > 0 || URL_RE.test(r.text);
}

/** Deterministic 0..1 from an id, so a given --n always samples the same replies. */
function stableRank(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return ((h >>> 0) % 100000) / 100000;
}

async function main() {
  const kind = (arg('--provider') ?? 'antigravity') as LlmProviderKind;
  const n = Number(arg('--n') ?? 5);
  const bucket = arg('--bucket') ?? 'mixed';
  const outDir = arg('--out') ?? './logs/compare';
  const config = loadConfig();
  const overrideModel = arg('--model');
  if (overrideModel) {
    // Providers read their model from config at construction; patch before build.
    const slot = ({ antigravity: 'antigravity', 'claude-code': 'claudeCode', claude: 'claude', openai: 'openai', ollama: 'ollama' } as const)[
      kind as 'antigravity' | 'claude-code' | 'claude' | 'openai' | 'ollama'
    ];
    if (slot) (config as unknown as Record<string, { model: string }>)[slot].model = overrideModel;
  }

  const store = buildStore(config);
  const llm = buildLlm({ ...config, llm: kind });
  const extractor = new Extractor(llm);
  await mkdir(outDir, { recursive: true });

  const replies = await store.listReplies();
  const targets = await store.listTargets();
  const byTarget = new Map<string, Target>(targets.map((t) => [t.id, t]));
  const niches = await store.listNiches();

  const styleFilter = arg('--style') ?? 'any';
  const anyPrompt = process.argv.includes('--any-prompt');
  const currentHash: Record<PitchStyle, string> = {
    broad: promptFingerprint('broad').hash,
    casino: promptFingerprint('casino').hash,
  };
  const styleOf = (r: Reply): PitchStyle =>
    pitchStyleForBatch(r.targetId ? byTarget.get(r.targetId)?.batchId : undefined);

  // Only replies the current pipeline actually extracted — those have a stored
  // result to diff against — and, unless --any-prompt, only those whose stored
  // result came from the prompt text in the tree right now.
  const done = replies
    .filter((r) => r.extractionStatus === 'done' && r.parsed)
    .filter((r) => styleFilter === 'any' || styleOf(r) === styleFilter)
    .filter((r) => anyPrompt || r.extraction?.promptHash === currentHash[styleOf(r)]);
  const priced = done.filter((r) => (r.parsed!.offers ?? []).some((o) => o.price?.amount != null) && !hasResearch(r));
  const research = done.filter((r) => hasResearch(r));
  const empty = done.filter((r) => (r.parsed!.offers ?? []).length === 0);

  const pick = (pool: Reply[], k: number) =>
    [...pool].sort((x, y) => stableRank(x.id) - stableRank(y.id)).slice(0, k);

  const only = arg('--reply');
  let sample: Reply[];
  if (only) sample = done.filter((r) => r.id === only || r.id.includes(only));
  else if (bucket === 'priced') sample = pick(priced, n);
  else if (bucket === 'research') sample = pick(research, n);
  else if (bucket === 'empty') sample = pick(empty, n);
  else {
    // mixed: round-robin the three buckets so one run covers prices, research
    // and declines rather than N variations of the easy case.
    const pools = [pick(priced, n), pick(research, n), pick(empty, n)];
    const seen = new Set<string>();
    sample = [];
    for (let i = 0; sample.length < n && i < n; i++) {
      for (const p of pools) {
        const r = p[i];
        if (r && !seen.has(r.id) && sample.length < n) { seen.add(r.id); sample.push(r); }
      }
    }
  }

  const styleCount = (s: PitchStyle) => done.filter((r) => styleOf(r) === s).length;
  console.log(
    `testing ${llm.name} (${llm.model ?? 'n/a'}) against stored results\n` +
      `baseline: ${anyPrompt ? 'ANY prompt (diffs include prompt drift!)' : 'current prompt only'}, style=${styleFilter}\n` +
      `corpus: ${done.length} eligible (${priced.length} priced, ${research.length} research, ${empty.length} no-offer; ` +
      `${styleCount('broad')} broad, ${styleCount('casino')} casino)\n` +
      `sampling ${sample.length} (bucket=${bucket}) → ${outDir}\n`,
  );

  const rows: Record<string, unknown>[] = [];
  for (const reply of sample) {
    const target = reply.targetId ? byTarget.get(reply.targetId) : undefined;
    const pitchStyle = pitchStyleForBatch(target?.batchId);
    const ownDomain = target ? normalizeDomain(target.websiteUrl) || undefined : senderSiteDomain(reply.fromAddress);

    const t0 = Date.now();
    let fresh: OutreachResult | undefined;
    let review: string[] = [];
    let error: string | undefined;
    try {
      const outcome = await extractor.extract(config.pitch, reply.text, niches, reply.attachments ?? [], {
        pitchStyle,
        ...(ownDomain ? { siteDomain: ownDomain } : {}),
      });
      fresh = outcome.result;
      review = outcome.review;
    } catch (err) {
      error = (err as Error).message;
    }
    const elapsedMs = Date.now() - t0;

    const d = fresh ? diff(reply.parsed, fresh) : undefined;
    const verdict = error ? 'ERROR' : isMatch(d!) ? 'match' : 'DIFF';
    rows.push({
      replyId: reply.id,
      domain: ownDomain ?? '(none)',
      pitchStyle,
      promptCurrent: reply.extraction?.promptHash === currentHash[pitchStyle],
      research: hasResearch(reply),
      elapsedMs,
      verdict,
      ...(error ? { error } : {}),
      ...(d ? { changed: d.changed.length, onlyStored: d.onlyStored.length, onlyFresh: d.onlyFresh.length } : {}),
    });

    await writeFile(
      join(outDir, `${reply.id}.json`),
      JSON.stringify(
        {
          reply: {
            id: reply.id,
            from: reply.fromAddress,
            subject: reply.subject,
            domain: ownDomain,
            pitchStyle,
            attachments: (reply.attachments ?? []).map((a) => ({ filename: a.filename, mimeType: a.mimeType })),
            text: reply.text,
          },
          storedExtraction: reply.extraction,
          stored: reply.parsed,
          fresh,
          freshProvider: { name: llm.name, model: llm.model },
          freshReview: review,
          elapsedMs,
          diff: d,
          error,
        },
        null,
        2,
      ),
      'utf8',
    );

    console.log(
      `${verdict.padEnd(6)} ${reply.id}  ${(ownDomain ?? '-').padEnd(28)} ${String(elapsedMs).padStart(7)}ms` +
        (d ? `  same=${d.same.length} changed=${d.changed.length} -old=${d.onlyStored.length} +new=${d.onlyFresh.length}` : `  ${error}`),
    );
  }

  const matches = rows.filter((r) => r.verdict === 'match').length;
  const errors = rows.filter((r) => r.verdict === 'ERROR').length;
  await writeFile(
    join(outDir, 'summary.json'),
    JSON.stringify({ provider: llm.name, model: llm.model, bucket, rows }, null, 2),
    'utf8',
  );
  console.log(`\n${matches}/${rows.length} exact match, ${errors} error(s). Details: ${outDir}/`);

  await store.close?.();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
