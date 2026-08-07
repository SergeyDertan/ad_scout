// Read-only audit of two attribution risks:
//  (A) price records created from UNMATCHED replies, where the domain is guessed
//      from the sender's email domain — wrong whenever the sender is a network
//      selling posts on OTHER sites.
//  (B) replies linking a Google Sheet/Doc through a click tracker, which
//      resolveLinkedDoc cannot see, so the price list is silently never read.
import 'dotenv/config';
import { loadConfig } from '../config';
import { buildStore } from '../lib/factory';
import { resolveLinkedDoc } from '../services/linked-docs';

const config = loadConfig();
const store = buildStore(config);
const replies = await store.listReplies();
const byId = new Map(replies.map((r) => [r.id, r]));
const records = await store.listPriceRecords();

// --- A ---
const fromUnmatched = records.filter((p) => {
  const r = p.replyId ? byId.get(p.replyId) : undefined;
  return r && r.matchMethod === 'unmatched';
});
const pricedUnmatched = fromUnmatched.filter(
  (p) => p.attribution === 'sender' && p.offers.some((o) => o.price?.amount != null),
);
console.log(`A) price records: ${records.length} total, ${fromUnmatched.length} from unmatched replies ` +
  `(${pricedUnmatched.length} priced AND attributed to the SENDER's own domain)`);
console.log(`   distinct domains invented this way: ${new Set(pricedUnmatched.map((p) => p.domain)).size}`);
console.log('   sample (domain ← sender, #priced cells):');
for (const p of pricedUnmatched)
  console.log(`     ${p.domain.padEnd(34)} ← ${p.sourceEmail.padEnd(34)} ${p.offers.filter((o) => o.price?.amount != null).length}`);

// --- B ---
const URL_RE = /https?:\/\/[^\s<>()\]]+/gi;
let missed = 0; const missedReplies: string[] = [];
for (const r of replies) {
  const urls = r.text.match(URL_RE) ?? [];
  const hit = urls.some((u) => {
    const decoded = decodeURIComponent(u.replace(/%25/g, '%'));
    const looksGoogleDoc = /docs\.google\.com\/(spreadsheets|document|presentation)/i.test(decoded);
    return looksGoogleDoc && !resolveLinkedDoc(u);
  });
  if (hit) { missed++; missedReplies.push(r.id); }
}
console.log(`\nB) replies whose Google Sheet/Doc link is wrapped so resolveLinkedDoc misses it: ${missed}`);
console.log(`   of those, extracted with offers: ${missedReplies.filter((id) => (byId.get(id)!.parsed?.offers.length ?? 0) > 0).length}`);
console.log(`   of those, flagged for review: ${missedReplies.filter((id) => (byId.get(id)!.review?.length ?? 0) > 0).length}`);
await store.close?.();
