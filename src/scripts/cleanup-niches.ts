// Cleanup the self-learned niche registry: remove entries that never should have
// been niches. Two classes the old prompt produced before the tighter minting
// rules landed:
//   - POST_TYPE  — a product masquerading as a niche (link_insertion,
//     sensitive_link_insertion, banner). We only buy guest posts, so these are
//     not niches and not offers either.
//   - COMPOSITE  — a mashup key naming several niches at once
//     (trading_vpn_finance, gaming="Prediction, Gaming-Related Posts").
//
// Deleting a niche is SAFE for existing replies: each stored PostOffer carries
// its own label/sensitive, so history is untouched — only future matching drops
// the junk key. Seed niches are never touched.
//
// Dry-run by default (prints the plan). Pass --apply to delete. Add
// --keys=a,b,c to force-delete specific keys the heuristics miss.
//
//     STORE=pouchdb npx tsx src/scripts/cleanup-niches.ts
//     STORE=pouchdb npx tsx src/scripts/cleanup-niches.ts --apply
//     STORE=pouchdb npx tsx src/scripts/cleanup-niches.ts --apply --keys=games

import 'dotenv/config';
import { loadConfig } from '../config';
import { buildStore } from '../lib/factory';
import {
  DEFAULT_NICHES,
  isNonGuestProduct,
  matchNiche,
  REGULAR_KEY,
  SENSITIVE_KEY,
} from '../domain/niches';
import type { Niche } from '../domain/types';

type Verdict = 'keep' | 'post_type' | 'composite' | 'forced';

const SEED_KEYS = new Set(DEFAULT_NICHES.map((n) => n.key));

/** A product we don't buy (link insertion / banner) mis-stored as a niche. */
function isPostTypeLike(n: Niche): boolean {
  return isNonGuestProduct(n.label) || isNonGuestProduct(n.key);
}

/** A mashup naming ≥2 distinct real niches (excludes the regular/sensitive umbrellas). */
function compositeReason(n: Niche, known: Niche[]): string | undefined {
  const parts = `${n.label} ${n.key}`
    .split(/[,/&_]|\band\b|\+/i)
    .map((s) => s.trim())
    .filter((s) => s.length > 1);
  const hits = new Set<string>();
  for (const p of parts) {
    const m = matchNiche(p, known);
    if (m && m.key !== REGULAR_KEY && m.key !== SENSITIVE_KEY) hits.add(m.key);
  }
  return hits.size >= 2 ? `names ${hits.size} niches: ${[...hits].join(', ')}` : undefined;
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const forced = new Set(
    (args.find((a) => a.startsWith('--keys='))?.slice('--keys='.length) ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

  const store = buildStore(loadConfig());
  const learned = (await store.listNiches()).filter((n) => !SEED_KEYS.has(n.key) || n.createdAt);
  const known = [...DEFAULT_NICHES, ...learned];

  const plan: { n: Niche; verdict: Verdict; reason: string }[] = [];
  for (const n of learned) {
    if (forced.has(n.key)) plan.push({ n, verdict: 'forced', reason: 'named on --keys' });
    else if (SEED_KEYS.has(n.key)) continue; // never delete a seed (even if overridden)
    else if (isPostTypeLike(n)) plan.push({ n, verdict: 'post_type', reason: 'a product we do not buy, not a niche' });
    else {
      const comp = compositeReason(n, known);
      if (comp) plan.push({ n, verdict: 'composite', reason: comp });
      else plan.push({ n, verdict: 'keep', reason: '' });
    }
  }

  const doomed = plan.filter((p) => p.verdict !== 'keep');
  console.log(`learned niches: ${learned.length}   flagged for removal: ${doomed.length}\n`);
  for (const p of plan) {
    const mark = p.verdict === 'keep' ? '  keep    ' : `  REMOVE  `;
    console.log(`${mark} ${p.n.key.padEnd(26)} ${p.verdict === 'keep' ? '' : `[${p.verdict}] ${p.reason}`}`);
  }

  if (!doomed.length) {
    console.log('\nNothing to clean up.');
  } else if (!apply) {
    console.log(`\nDRY RUN — re-run with --apply to delete the ${doomed.length} flagged niche(s).`);
  } else {
    for (const p of doomed) await store.deleteNiche(p.n.key);
    console.log(`\nDeleted ${doomed.length} niche(s).`);
  }

  await store.close?.();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
