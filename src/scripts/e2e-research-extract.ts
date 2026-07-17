// Manual end-to-end harness for the claude-code research paths (link WebFetch +
// attachment Read). Not part of `pnpm test` — it hits the network and shells out
// to the real `claude` CLI. Run with:
//
//   CLAUDE_CODE_MODEL=sonnet tsx src/scripts/e2e-research-extract.ts
//
// Files it reads come from E2E_DIR (defaults to the scratchpad path below).

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ClaudeCodeLlmProvider } from '../adapters/llm/claude-code.provider';
import { Extractor } from '../services/extractor';
import type { EmailAttachment, PitchProfile } from '../domain/types';

const E2E_DIR =
  process.env.E2E_DIR ??
  '/private/tmp/claude-501/-Users-sergiibilak-Work-Projects-ad-scout/db2135e3-6e12-46e9-8125-a6f014890dab/scratchpad/e2e';

const PDF_URL =
  'https://partner.inkl.com/hubfs/inkl%20Information/inkl%20Guidelines%20for%202026.pdf';

const profile: PitchProfile = {
  advertised: { url: 'https://our-casino-brand.example', description: 'iGaming brand' },
  topic: 'casino',
  format: 'guest post',
};

async function loadAttachment(file: string, mimeType: string): Promise<EmailAttachment> {
  const buf = await readFile(join(E2E_DIR, file));
  return { filename: file, mimeType, size: buf.length, contentBase64: buf.toString('base64') };
}

function report(label: string, result: Awaited<ReturnType<Extractor['extract']>>): void {
  console.log(`\n================  ${label}  ================`);
  console.log('offers:');
  for (const o of result.result.offers) {
    console.log(`  - ${o.category}: canPost=${o.canPost} price=${JSON.stringify(o.price?.raw ?? '')}`);
  }
  console.log('reasoning:', result.result.reasoning);
  if (result.discovered.length) console.log('discovered niches:', result.discovered.map((n) => n.key).join(', '));
}

async function main() {
  const model = process.env.CLAUDE_CODE_MODEL ?? 'sonnet';
  const llm = new ClaudeCodeLlmProvider({ model, timeoutMs: 300_000 });
  const extractor = new Extractor(llm);
  console.log(`provider=${llm.name} model=${model} supportsResearch=${llm.supportsResearch}`);

  const xlsx = await loadAttachment(
    'price-list.xlsx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  );
  const pdf = await loadAttachment('guidelines.pdf', 'application/pdf');

  // --- Scenario 1: attachment Read (deterministic xlsx: casino $100 / regular $50)
  const t1 = Date.now();
  const r1 = await extractor.extract(
    profile,
    'Hi! Thanks for reaching out. Our rates are in the attached spreadsheet — see the price list. Turnaround is 3 business days.',
    [],
    [xlsx],
  );
  console.log(`\n[scenario 1 took ${Date.now() - t1}ms]`);
  report('SCENARIO 1 — xlsx attachment (expect casino $100, regular $50)', r1);

  // --- Scenario 2: link WebFetch
  const t2 = Date.now();
  const r2 = await extractor.extract(
    profile,
    `Hello, we'd be happy to feature your casino brand. All our publishing details, guidelines and pricing are here: ${PDF_URL} — please have a look.`,
    [],
    [],
  );
  console.log(`\n[scenario 2 took ${Date.now() - t2}ms]`);
  report('SCENARIO 2 — link WebFetch (fetches the inkl guidelines PDF)', r2);

  // --- Scenario 3: PDF attachment Read
  const t3 = Date.now();
  const r3 = await extractor.extract(
    profile,
    'Hi, our full guidelines are in the attached PDF. Let me know if you have questions.',
    [],
    [pdf],
  );
  console.log(`\n[scenario 3 took ${Date.now() - t3}ms]`);
  report('SCENARIO 3 — pdf attachment Read', r3);
}

main().catch((err) => {
  console.error('E2E FAILED:', err);
  process.exit(1);
});
