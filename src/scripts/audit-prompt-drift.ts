// Read-only audit: for every extracted reply, compare the pitch style + prompt
// hash the STORED result was produced under against what the code would use
// today. A comparison run is only meaningful where these agree.
import 'dotenv/config';
import { loadConfig } from '../config';
import { buildStore } from '../lib/factory';
import { pitchStyleForBatch } from '../domain/pitch';
import { promptFingerprint } from '../services/extractor';
import type { Target } from '../domain/types';

const config = loadConfig();
const store = buildStore(config);
const replies = (await store.listReplies()).filter((r) => r.extractionStatus === 'done' && r.parsed);
const targets = await store.listTargets();
const byId = new Map<string, Target>(targets.map((t) => [t.id, t]));

const now = { broad: promptFingerprint('broad').hash, casino: promptFingerprint('casino').hash };
console.log('current prompt hashes:', now);

const styleTally = new Map<string, number>();
const hashTally = new Map<string, number>();
let styleMismatch = 0;
for (const r of replies) {
  const target = r.targetId ? byId.get(r.targetId) : undefined;
  const wouldUse = pitchStyleForBatch(target?.batchId);
  const storedStyle = r.extraction?.promptStyle ?? '(none)';
  styleTally.set(`stored=${storedStyle} → today=${wouldUse}`, (styleTally.get(`stored=${storedStyle} → today=${wouldUse}`) ?? 0) + 1);
  if (storedStyle !== '(none)' && storedStyle !== wouldUse) styleMismatch++;
  const h = r.extraction?.promptHash ?? '(none)';
  const label = h === now.broad ? `${h} (=current broad)` : h === now.casino ? `${h} (=current casino)` : `${h} (STALE)`;
  hashTally.set(label, (hashTally.get(label) ?? 0) + 1);
}
console.log(`\n${replies.length} extracted replies`);
console.log('\nstyle:'); for (const [k, v] of styleTally) console.log(`  ${v.toString().padStart(5)}  ${k}`);
console.log('\nprompt hash of stored result:'); for (const [k, v] of [...hashTally].sort((a, b) => b[1] - a[1])) console.log(`  ${v.toString().padStart(5)}  ${k}`);
console.log(`\nstyle mismatches (stored vs today): ${styleMismatch}`);

const provTally = new Map<string, number>();
for (const r of replies) {
  const k = `${r.extraction?.provider ?? '?'}/${r.extraction?.model ?? '?'}`;
  provTally.set(k, (provTally.get(k) ?? 0) + 1);
}
console.log('\nstored by provider/model:'); for (const [k, v] of [...provTally].sort((a, b) => b[1] - a[1])) console.log(`  ${v.toString().padStart(5)}  ${k}`);
await store.close?.();
