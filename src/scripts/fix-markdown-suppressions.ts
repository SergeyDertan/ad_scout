// One-time repair for suppressions whose email was stored as a markdown autolink
// — `[admin@site.com](mailto:admin@site.com)` — instead of the bare address.
//
// Root cause (now fixed in detectBounce/normalizeEmail): some providers hand us
// the bounce (DSN) body already rendered to markdown, so the recipient-extraction
// regex captured the whole `[x](mailto:x)` wrapper and suppressed it verbatim.
// Every corrupted row is a `bounce`.
//
// This peels the bare address out, re-adds a clean suppression (idempotent — most
// already have a clean twin from a later bounce), and deletes the malformed doc.
//
//     pnpm fix:markdown-suppressions          # dry run — prints, writes nothing
//     pnpm fix:markdown-suppressions --apply   # persist

import 'dotenv/config';
import { loadConfig } from '../config';
import { buildStore } from '../lib/factory';
import { normalizeEmail } from '../domain/reply-matching';

const MALFORMED = /[[\]()]|mailto:/i;

async function main() {
  const apply = process.argv.includes('--apply');
  const store = buildStore(loadConfig());

  const all = await store.listSuppressions();
  const bad = all.filter((s) => MALFORMED.test(s.email));
  const cleanEmails = new Set(all.filter((s) => !MALFORMED.test(s.email)).map((s) => s.email));

  console.log(`${apply ? 'APPLY' : 'DRY RUN'} — ${all.length} suppressions, ${bad.length} malformed\n`);

  let repaired = 0;
  let deletedOnly = 0;
  for (const s of bad) {
    const clean = normalizeEmail(s.email);
    if (!clean || MALFORMED.test(clean)) {
      console.log(`  SKIP (could not recover an address): ${JSON.stringify(s.email)}`);
      continue;
    }
    const hasTwin = cleanEmails.has(clean);
    console.log(
      `  ${JSON.stringify(s.email)}\n    -> ${clean}  [${s.reason}]  ${hasTwin ? '(clean twin exists — delete malformed only)' : '(re-add clean)'}`,
    );
    if (apply) {
      if (!hasTwin) {
        await store.addSuppression({ id: clean, email: clean, reason: s.reason, at: s.at });
        cleanEmails.add(clean);
      }
      await store.removeSuppression(s.email);
    }
    hasTwin ? deletedOnly++ : repaired++;
  }

  console.log(
    `\n${apply ? 'Done' : 'Would'}: re-add ${repaired} clean, delete ${repaired + deletedOnly} malformed.`,
  );
}

main().then(() => process.exit(0));
