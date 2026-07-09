// One-off read-only inspector: find the reply(ies) for a given from-address and
// dump the raw text + parsed offers + fields. Not written to disk state.
import 'dotenv/config';
import { loadConfig } from '../config';
import { buildStore } from '../lib/factory';

async function main() {
  const needle = (process.argv[2] ?? '').toLowerCase();
  if (!needle) throw new Error('usage: tsx src/scripts/inspect-reply.ts <from-address substring>');

  const store = buildStore(loadConfig());
  const replies = (await store.listReplies()).filter((r) =>
    r.fromAddress.toLowerCase().includes(needle),
  );
  console.log(`found ${replies.length} reply doc(s) matching "${needle}"\n`);

  for (const r of replies) {
    console.log('='.repeat(80));
    console.log(`replyId=${r.id}  emailId=${r.emailId}`);
    console.log(`from=${r.fromAddress}  received=${r.receivedAt}  match=${r.matchMethod}  target=${r.targetId ?? '—'}`);
    console.log(`extraction=${r.extractionStatus}  review=${JSON.stringify(r.review ?? null)}`);
    console.log(`attachments=${(r.attachments ?? []).map((a) => `${a.filename}(${a.mimeType})`).join(', ') || 'none'}`);
    console.log('\n--- RAW TEXT ---');
    console.log(r.text);
    console.log('\n--- PARSED ---');
    console.log(JSON.stringify(r.parsed, null, 2));
  }

  await store.close?.();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
