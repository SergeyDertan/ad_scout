// One-off tool: sample N pending replies from the store and run extraction
// against them WITHOUT writing anything back — lets you eyeball a new LLM
// provider's output (e.g. LLM_PROVIDER=claude-code) on real emails before
// trusting it in the live poll/fetch pass.
//
//     pnpm sample:extract [N=3]

import 'dotenv/config';
import { loadConfig } from '../config';
import { buildStore, buildLlm } from '../lib/factory';
import { Extractor } from '../services/extractor';

async function main() {
  const n = Number(process.argv[2] ?? 3);
  const config = loadConfig();
  const store = buildStore(config);
  const llm = buildLlm(config);
  const extractor = new Extractor(llm);

  const replies = (await store.listReplies()).filter(
    (r) => r.extractionStatus === 'pending' || r.extractionStatus === 'failed',
  );
  const sample = replies.slice(0, n);
  console.log(
    `provider=${llm.name} topic="${config.pitch.topic}" sampling ${sample.length}/${replies.length} pending replies\n`,
  );

  for (const reply of sample) {
    const t0 = Date.now();
    console.log(`--- ${reply.id} ---`);
    console.log('text:', reply.text.slice(0, 200).replace(/\s+/g, ' '));
    try {
      const knownNiches = await store.listNiches();
      const { result, discovered } = await extractor.extract(config.pitch, reply.text, knownNiches);
      if (discovered.length) console.log('would-learn niches:', discovered.map((n) => n.key).join(', '));
      console.log(`result (${Date.now() - t0}ms):`, JSON.stringify(result, null, 2));
    } catch (err) {
      console.log(`FAILED (${Date.now() - t0}ms):`, err);
    }
    console.log();
  }

  await store.close?.();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
