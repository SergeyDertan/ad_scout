// One-off read-only inspector: dump everything the pipeline knows about a reply
// — the raw email, the target it matched and how, the stored extraction and its
// provenance, every price record that traces back to it, and the links in its
// body. Writes nothing.
//
//     STORE=pouchdb tsx src/scripts/inspect-reply.ts <from-address or reply-id substring>
//
// The needle matches either the sender address or the reply id, so both
// "editor@site.com" and "c3087003" find their reply.

import 'dotenv/config';
import { loadConfig } from '../config';
import { buildStore } from '../lib/factory';
import { normalizeDomain } from '../domain/domain';
import { resolveLinkedDoc } from '../services/linked-docs';

async function main() {
  const needle = (process.argv[2] ?? '').toLowerCase();
  if (!needle) throw new Error('usage: tsx src/scripts/inspect-reply.ts <from-address or reply-id substring>');

  const store = buildStore(loadConfig());
  const replies = (await store.listReplies()).filter(
    (r) => r.fromAddress.toLowerCase().includes(needle) || r.id.toLowerCase().includes(needle),
  );
  console.log(`found ${replies.length} reply doc(s) matching "${needle}"\n`);

  const targets = await store.listTargets();
  const priceRecords = await store.listPriceRecords();

  for (const r of replies) {
    const target = r.targetId ? targets.find((t) => t.id === r.targetId) : undefined;
    console.log('='.repeat(80));
    console.log(`replyId=${r.id}  emailId=${r.emailId}`);
    console.log(`from=${r.fromAddress}  received=${r.receivedAt}  match=${r.matchMethod}  target=${r.targetId ?? '—'}`);
    console.log(`subject=${r.subject ?? '—'}  account=${r.accountId ?? '—'}`);
    console.log(`extraction=${r.extractionStatus}  review=${JSON.stringify(r.review ?? null)}`);
    console.log(`attachments=${(r.attachments ?? []).map((a) => `${a.filename}(${a.mimeType})`).join(', ') || 'none'}`);

    console.log('\n--- TARGET ---');
    console.log(
      target
        ? `${target.websiteUrl} (domain=${normalizeDomain(target.websiteUrl)}) status=${target.status} batch=${target.batchId ?? '—'}`
        : '(none — domain is inferred from the sender)',
    );

    console.log('\n--- PROVENANCE ---');
    console.log(r.extraction ? JSON.stringify(r.extraction) : '(none)');

    console.log('\n--- LINKS ---');
    const urls = new Set(r.text.match(/https?:\/\/[^\s<>()\]]+/gi) ?? []);
    if (!urls.size) console.log('(none)');
    for (const u of urls) {
      const doc = resolveLinkedDoc(u);
      console.log(`  ${doc ? `[${doc.kind}]` : '[web page]'} ${u.slice(0, 140)}`);
      if (doc) console.log(`      → downloads ${doc.url}`);
    }

    console.log('\n--- RAW TEXT ---');
    console.log(r.text);

    console.log('\n--- PARSED ---');
    console.log(JSON.stringify(r.parsed, null, 2));

    console.log('\n--- PRICE RECORDS FROM THIS REPLY ---');
    const mine = priceRecords.filter((p) => p.replyId === r.id);
    if (!mine.length) console.log('(none)');
    for (const p of mine) {
      const cells = p.offers.map(
        (o) => `${o.category}@${o.term?.key ?? '?'}=${o.canPost}/${o.price?.amount ?? '-'}${o.price?.currency ?? ''}`,
      );
      console.log(`  ${p.domain} [${p.attribution}] ${cells.join(' ') || '(no priced cells)'}`);
    }
    console.log();
  }

  await store.close?.();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
