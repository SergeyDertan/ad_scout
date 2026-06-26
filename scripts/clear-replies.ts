import PouchDB from 'pouchdb';
import { loadConfig } from '../src/config';

const config = loadConfig();
const db = new PouchDB(config.pouchDir);

const res = await db.allDocs({
  include_docs: true,
  startkey: 'reply:',
  endkey: 'reply:￿',
});

if (res.rows.length === 0) {
  console.log('No reply documents found.');
  await db.close();
  process.exit(0);
}

await db.bulkDocs(res.rows.map((r: any) => ({ ...r.doc, _deleted: true })));
console.log(`Deleted ${res.rows.length} reply document(s).`);
await db.close();
