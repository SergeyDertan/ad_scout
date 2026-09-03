import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { MemoryStore } from '../adapters/store/memory.store';
import type { Batch, Reply, Target } from '../domain/types';
import { Mutex } from '../lib/mutex';
import {
  archiveName,
  BackupService,
  loadBackupConfig,
  toDelete,
  type BackupBucket,
  type BackupObject,
} from './backup';
import { DOC_TYPES } from './dump';

const execFileAsync = promisify(execFile);

/* ---------------- the retention rule, as a pure function ---------------- */

const NOW = new Date('2026-09-03T14:00:00'); // local clock, as the service uses

function names(...specs: string[]): string[] {
  return specs.map((s) => `adscout-${s}.tar.gz`);
}

test('today keeps every hourly', () => {
  const all = names('2026-09-03T09', '2026-09-03T10', '2026-09-03T11');
  assert.deepEqual(toDelete(all, NOW, 14), []);
});

test('an earlier day collapses to its newest archive', () => {
  const all = names('2026-09-02T03', '2026-09-02T11', '2026-09-02T23', '2026-09-03T09');
  // 23:00 is the survivor; 03 and 11 go.
  assert.deepEqual(toDelete(all, NOW, 14).sort(), names('2026-09-02T03', '2026-09-02T11').sort());
});

test('anything past the retention horizon goes, newest-of-day or not', () => {
  const all = names('2026-08-20T23', '2026-08-21T23', '2026-09-02T23');
  // keepDays=14 from 2026-09-03 ⇒ cutoff 2026-08-20; that day and older go.
  const doomed = toDelete(all, NOW, 14);
  assert.ok(doomed.includes('adscout-2026-08-20T23.tar.gz'));
  assert.ok(!doomed.includes('adscout-2026-09-02T23.tar.gz'));
});

test('files we did not create are never deleted', () => {
  const all = [...names('2026-09-02T03', '2026-09-02T23'), 'notes.txt', 'adscout-old.tar.gz', '.partial'];
  const doomed = toDelete(all, NOW, 14);
  assert.deepEqual(doomed, ['adscout-2026-09-02T03.tar.gz']);
});

test('steady state is hourly-for-today plus one per day', () => {
  const all: string[] = [];
  for (let d = 1; d <= 3; d++) {
    for (const h of ['02', '09', '17', '23']) all.push(`adscout-2026-09-0${d}T${h}.tar.gz`);
  }
  const kept = all.filter((n) => !toDelete(all, NOW, 14).includes(n));
  assert.deepEqual(kept.sort(), [
    'adscout-2026-09-01T23.tar.gz',
    'adscout-2026-09-02T23.tar.gz',
    'adscout-2026-09-03T02.tar.gz',
    'adscout-2026-09-03T09.tar.gz',
    'adscout-2026-09-03T17.tar.gz',
    'adscout-2026-09-03T23.tar.gz',
  ]);
});

test('the archive name uses the LOCAL clock, matching the send window', () => {
  assert.equal(archiveName(new Date('2026-09-03T14:05:00')), 'adscout-2026-09-03T14.tar.gz');
});

test('config defaults, and gs:// on the bucket is tolerated', () => {
  const c = loadBackupConfig({ BACKUP_BUCKET: 'gs://my-bucket/' } as NodeJS.ProcessEnv);
  assert.equal(c.bucket, 'my-bucket');
  assert.equal(c.keepDays, 14);
  assert.equal(c.prefix, 'backups');
  // Falls back to the snapshot publisher's bucket and credentials.
  const d = loadBackupConfig({ SNAPSHOT_BUCKET: 'shared', SNAPSHOT_CREDENTIALS: '/x.json' } as NodeJS.ProcessEnv);
  assert.equal(d.bucket, 'shared');
  assert.equal(d.credentialsPath, '/x.json');
});

/* ---------------- an actual backup, end to end ---------------- */

async function seeded(): Promise<MemoryStore> {
  const store = new MemoryStore();
  const batch: Batch = { id: 'b1', name: 'b', source: 'import', createdAt: '2026-05-01T00:00:00Z' };
  const target: Target = {
    id: 't1', batchId: 'b1', websiteUrl: 'site1.com', contactEmail: 'a@site1.com',
    status: 'contacted', followUpCount: 0, createdAt: '2026-06-01T00:00:00Z',
  };
  const reply: Reply = {
    id: 'r1', emailId: 'e1', rfcMessageId: '<e1@x>', fromAddress: 'a@site1.com', targetId: 't1',
    matchMethod: 'fromAddress', receivedAt: '2026-06-02T00:00:00Z',
    // A real reply body carries U+2028 (LINE SEPARATOR) — it arrives in HTML
    // mail. Written as an escape rather than a literal so it is VISIBLE here:
    // JSON.stringify leaves it raw, and a line-oriented reader would then split
    // this document in two. The archive must carry it escaped.
    text: 'Guest post\u2028is $500.',
    extractionStatus: 'done',
  };
  await Promise.all([store.putBatch(batch), store.putTarget(target), store.putReply(reply)]);
  return store;
}

test('a backup is a real archive that data:load could read, and it verifies itself', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'adscout-backup-'));
  try {
    const store = await seeded();
    const at = new Date('2026-09-03T14:00:00');
    const svc = new BackupService(
      store, 'memory', { now: () => at }, { dir, keepDays: 14, intervalMs: 3_600_000, prefix: 'backups' }, new Mutex(),
    );

    const report = await svc.run();
    assert.equal(report.name, 'adscout-2026-09-03T14.tar.gz');
    assert.equal(report.docs, 3);
    assert.ok(report.bytes > 0);
    assert.equal(report.mirrored, false);

    // No staging directory or .partial left behind.
    const left = await readdir(dir);
    assert.deepEqual(left, [report.name], `stray files: ${left.join(', ')}`);

    // The archive holds every type the loader expects, with a real manifest.
    const { stdout: listing } = await execFileAsync('tar', ['-tzf', join(dir, report.name)]);
    for (const spec of DOC_TYPES) assert.ok(listing.includes(`${spec.name}.ndjson`), spec.name);
    const { stdout: manifestJson } = await execFileAsync('tar', ['-xzOf', join(dir, report.name), 'manifest.json']);
    assert.equal((JSON.parse(manifestJson) as { counts: Record<string, number> }).counts.replies, 1);

    // U+2028 survived as an escape, so the NDJSON is still one line per doc.
    const { stdout: replies } = await execFileAsync('tar', ['-xzOf', join(dir, report.name), 'replies.ndjson']);
    assert.equal(replies.split('\n').filter((l) => l.trim()).length, 1);
    assert.ok(replies.includes('\\u2028'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the dump happens INSIDE the write lock', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'adscout-backup-'));
  try {
    const store = await seeded();
    const lock = new Mutex();
    const events: string[] = [];
    const realList = store.listReplies.bind(store);
    (store as unknown as { listReplies: typeof store.listReplies }).listReplies = async () => {
      events.push('dump:read');
      return realList();
    };

    const svc = new BackupService(
      store, 'memory', { now: () => new Date('2026-09-03T14:00:00') },
      { dir, keepDays: 14, intervalMs: 3_600_000, prefix: 'backups' }, lock,
    );

    // Hold the lock across an await, as a pipeline pass does.
    const pass = lock.run(async () => {
      events.push('pass:start');
      await new Promise((r) => setTimeout(r, 40));
      events.push('pass:end');
    });
    await Promise.all([pass, svc.run()]);

    const start = events.indexOf('pass:start');
    const end = events.indexOf('pass:end');
    assert.deepEqual(events.slice(start + 1, end), [], `backup read inside a held pass: ${events.join(',')}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the mirror uploads and applies the same retention to the bucket', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'adscout-backup-'));
  try {
    const store = await seeded();
    const uploaded: string[] = [];
    const deleted: string[] = [];
    const remote = ['2026-09-02T03', '2026-09-02T23', '2026-08-01T23'].map(
      (s): BackupObject => ({
        name: `backups/adscout-${s}.tar.gz`,
        delete: async () => void deleted.push(`adscout-${s}.tar.gz`),
      }),
    );
    const bucket: BackupBucket = {
      upload: async (_p, o) => void uploaded.push(o.destination),
      getFiles: async () => [remote],
    };

    const svc = new BackupService(
      store, 'memory', { now: () => new Date('2026-09-03T14:00:00') },
      { dir, keepDays: 14, intervalMs: 3_600_000, prefix: 'backups', bucket: 'b' }, new Mutex(),
      async () => bucket,
    );

    const report = await svc.run();
    assert.equal(report.mirrored, true);
    assert.deepEqual(uploaded, ['backups/adscout-2026-09-03T14.tar.gz']);
    // Yesterday collapses to its newest; the August archive is past the horizon.
    assert.deepEqual(deleted.sort(), ['adscout-2026-08-01T23.tar.gz', 'adscout-2026-09-02T03.tar.gz']);
    assert.equal(report.prunedRemote, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a mirror failure does not fail the backup — the local copy already exists', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'adscout-backup-'));
  try {
    const store = await seeded();
    const svc = new BackupService(
      store, 'memory', { now: () => new Date('2026-09-03T14:00:00') },
      { dir, keepDays: 14, intervalMs: 3_600_000, prefix: 'backups', bucket: 'b' }, new Mutex(),
      async () => { throw new Error('bucket unreachable'); },
    );
    const report = await svc.run();
    assert.equal(report.mirrored, false);
    assert.ok((await readdir(dir)).includes(report.name));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('pruning ignores a stray .partial and never deletes it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'adscout-backup-'));
  try {
    // A crash mid-backup leaves this; it must not be mistaken for a good archive.
    await writeFile(join(dir, 'adscout-2026-09-01T04.tar.gz.partial'), 'junk');
    await writeFile(join(dir, 'adscout-2026-09-01T04.tar.gz'), 'old');
    await writeFile(join(dir, 'adscout-2026-09-01T22.tar.gz'), 'newer');
    const store = await seeded();
    const svc = new BackupService(
      store, 'memory', { now: () => new Date('2026-09-03T14:00:00') },
      { dir, keepDays: 14, intervalMs: 3_600_000, prefix: 'backups' }, new Mutex(),
    );
    await svc.run();
    const left = (await readdir(dir)).sort();
    assert.deepEqual(left, [
      'adscout-2026-09-01T04.tar.gz.partial', // untouched: not ours to delete
      'adscout-2026-09-01T22.tar.gz',         // survivor of that day
      'adscout-2026-09-03T14.tar.gz',         // the one just taken
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('start() refuses to schedule when tar is unavailable, loudly', async () => {
  // A missing tar would otherwise surface as backups that simply never appear,
  // an hour after boot, with nothing pointing at the cause.
  const dir = await mkdtemp(join(tmpdir(), 'adscout-backup-'));
  const PATH = process.env.PATH;
  try {
    const svc = new BackupService(
      await seeded(), 'memory', { now: () => new Date('2026-09-03T14:00:00') },
      { dir, keepDays: 14, intervalMs: 3_600_000, prefix: 'backups' }, new Mutex(),
    );
    process.env.PATH = '/nonexistent';
    await svc.start();
    svc.stop();
    // Nothing scheduled, nothing written — and the error was logged, not thrown.
    assert.deepEqual(await readdir(dir), []);
  } finally {
    process.env.PATH = PATH;
    await rm(dir, { recursive: true, force: true });
  }
});
