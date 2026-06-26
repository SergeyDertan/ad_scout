import PouchDB from 'pouchdb';
import { loadConfig } from '../src/config';

const config = loadConfig();
const db = new PouchDB(config.pouchDir);

const res = await db.allDocs({
  include_docs: true,
  startkey: 'account:',
  endkey: 'account:￿',
});

if (res.rows.length === 0) {
  console.log('No account documents found.');
  await db.close();
  process.exit(0);
}

const updated = res.rows.map((r: any) => {
  const { pollCursor, ...rest } = r.doc;
  return { ...rest };
});

await db.bulkDocs(updated);
console.log(`Reset pollCursor on ${updated.length} account(s).`);
await db.close();
