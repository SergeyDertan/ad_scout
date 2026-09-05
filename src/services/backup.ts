// Scheduled database backups: an hourly dump, pruned to hourly-for-today plus
// daily-for-two-weeks, mirrored to Cloud Storage.
//
// WHY IN-PROCESS. `pnpm data:dump` cannot run while the server is up — PouchDB
// is single-writer and the CLI would fail on the LevelDB lock. A cron job that
// stopped the service to take a backup would cost a restart (and its boot
// reconcile) every hour, with the tail risk of not coming back. This server
// already owns the store, so it can dump without contention.
//
// CONSISTENCY. The dump runs inside the same `passLock` the pipeline passes and
// the dashboard's write routes take, so no send, poll, extraction result or
// hand-edit can land midway through. Measured at ~1.7 s on a 7,900-document
// store, which is invisible against a scheduler that spaces sends minutes apart.
//
// FORMAT. Exactly what `pnpm data:load` reads — the same `dumpStore()` the CLI
// uses. A backup in a bespoke format is a backup with an untested restore path.
//
// NOT ENCRYPTED. The archive contains `Account.oauthTokens.refreshToken` for
// every mailbox. Bucket-side, storage.rules denies reads to every browser
// client everywhere, so the object is reachable only by the Admin SDK's service
// account. Treat that service-account JSON, and any local copy of these files,
// as mailbox credentials.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { App } from 'firebase-admin/app';
import type { Clock } from '../lib/clock';
import { describeError } from '../lib/errors';
import { logger } from '../lib/logger';
import type { Mutex } from '../lib/mutex';
import type { Store } from '../ports/store';
import { DOC_TYPES, describeSource, dumpStore, type DumpManifest } from './dump';

const execFileAsync = promisify(execFile);

const NAME_RE = /^adscout-(\d{4}-\d{2}-\d{2})T(\d{2})\.tar\.gz$/;

export interface BackupConfig {
  dir: string;
  /** Days of daily backups to keep. Today's hourlies are always kept in full. */
  keepDays: number;
  intervalMs: number;
  /** Cloud Storage bucket to mirror into. Absent ⇒ local backups only. */
  bucket?: string;
  prefix: string;
  credentialsPath?: string;
}

export function backupEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !/^(0|false|no|off)$/i.test((env.BACKUP ?? '').trim());
}

export function loadBackupConfig(env: NodeJS.ProcessEnv = process.env): BackupConfig {
  const num = (v: string | undefined, fallback: number): number => {
    const n = v == null ? NaN : Number(v);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  let bucket = env.BACKUP_BUCKET?.trim();
  if (bucket?.startsWith('gs://')) bucket = bucket.slice(5);
  if (bucket?.endsWith('/')) bucket = bucket.slice(0, -1);
  return {
    dir: env.BACKUP_DIR?.trim() || './backups',
    keepDays: num(env.BACKUP_KEEP_DAYS, 14),
    intervalMs: num(env.BACKUP_INTERVAL_MS, 60 * 60_000),
    ...(bucket ? { bucket } : {}),
    prefix: env.BACKUP_PREFIX?.trim() || 'backups',
    ...(env.BACKUP_CREDENTIALS?.trim() ? { credentialsPath: env.BACKUP_CREDENTIALS.trim() } : {}),
  };
}

/** Local-clock date and hour — the same clock the send window uses, so "day"
 *  means the operator's day and not UTC's. */
export function stampFor(at: Date): { date: string; hour: string } {
  const p = (n: number): string => String(n).padStart(2, '0');
  return {
    date: `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}`,
    hour: p(at.getHours()),
  };
}

export function archiveName(at: Date): string {
  const { date, hour } = stampFor(at);
  return `adscout-${date}T${hour}.tar.gz`;
}

/**
 * Which archives to delete, given everything present and "now".
 *
 * The whole retention policy, as one pure function:
 *   · today            → keep every hourly
 *   · any earlier day  → keep only that day's newest
 *   · older than keepDays → delete
 *
 * Expressed this way there is no separate "daily backup" job to keep in step
 * with the hourly one — the daily is simply the survivor of each past day.
 */
export function toDelete(names: string[], now: Date, keepDays: number): string[] {
  const today = stampFor(now).date;
  const cutoff = new Date(now.getTime());
  cutoff.setDate(cutoff.getDate() - keepDays);
  const cutoffDate = stampFor(cutoff).date;

  const newestByDate = new Map<string, string>();
  const parsed: { name: string; date: string; hour: string }[] = [];
  for (const name of names) {
    const m = NAME_RE.exec(name);
    if (!m) continue; // not ours — never delete what we did not create
    const [, date, hour] = m as unknown as [string, string, string];
    parsed.push({ name, date, hour });
    const best = newestByDate.get(date);
    if (!best || hour > best) newestByDate.set(date, hour);
  }

  const doomed: string[] = [];
  for (const { name, date, hour } of parsed) {
    if (date <= cutoffDate) {
      doomed.push(name);
      continue;
    }
    if (date === today) continue; // today keeps full hourly resolution
    if (hour !== newestByDate.get(date)) doomed.push(name);
  }
  return doomed;
}

/** The slice of the Cloud Storage bucket API this uses. Structural, so the
 *  mirror can be exercised in tests without firebase-admin or a network. */
export interface BackupBucket {
  upload(path: string, opts: { destination: string; metadata?: Record<string, unknown> }): Promise<unknown>;
  getFiles(opts: { prefix: string }): Promise<[BackupObject[]]>;
}

export interface BackupObject {
  name: string;
  delete(): Promise<unknown>;
}

export interface BackupReport {
  name: string;
  bytes: number;
  docs: number;
  ms: number;
  prunedLocal: number;
  mirrored: boolean;
  prunedRemote: number;
}

export class BackupService {
  private timer?: ReturnType<typeof setTimeout>;
  private app?: App;
  private stopped = false;
  /** In-flight run, so a slow backup cannot overlap the next tick. */
  private running?: Promise<BackupReport>;

  constructor(
    private readonly store: Store,
    private readonly storeKind: string,
    private readonly clock: Clock,
    private readonly config: BackupConfig,
    private readonly writeLock: Mutex,
    /** Injected in tests; production resolves one from firebase-admin lazily. */
    private readonly bucketOverride?: () => Promise<BackupBucket>,
  ) {}

  /**
   * Start the hourly loop, aligned to the top of the hour.
   *
   * Checks `tar` up front. It is present on any Debian/Ubuntu box, but if it is
   * not, every backup would fail an hour after boot with nobody watching — the
   * exact shape of failure a backup system must not have. Loud, and not fatal:
   * the server's job is sending mail, and it should not refuse to start over
   * this.
   */
  async start(): Promise<void> {
    try {
      await execFileAsync('tar', ['--version']);
    } catch {
      logger.error(
        'BACKUPS DISABLED: `tar` is not on PATH, so no archive can be written. ' +
          'Install it (apt-get install tar) and restart; until then the store has ' +
          'no scheduled copy.',
      );
      return;
    }
    this.scheduleNext();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.app) {
      void import('firebase-admin/app').then(({ deleteApp }) => deleteApp(this.app!).catch(() => {}));
      this.app = undefined;
    }
  }

  private scheduleNext(): void {
    if (this.stopped) return;
    // Aim at the next interval boundary rather than "now + interval", so the
    // archive names land on predictable hours and do not drift with restarts.
    const now = this.clock.now().getTime();
    const delay = this.config.intervalMs - (now % this.config.intervalMs);
    this.timer = setTimeout(() => {
      void this.run().finally(() => this.scheduleNext());
    }, delay);
    this.timer.unref?.();
  }

  /** Take a backup now. Overlapping calls share the in-flight run. */
  run(): Promise<BackupReport> {
    this.running ??= this.runOnce().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async runOnce(): Promise<BackupReport> {
    const startedAt = Date.now();
    const at = this.clock.now();
    const name = archiveName(at);
    const dir = this.config.dir;
    const staging = join(dir, `.staging-${name}`);
    const partial = join(dir, `${name}.partial`);
    const final = join(dir, name);

    await mkdir(dir, { recursive: true });
    await rm(staging, { recursive: true, force: true });

    let manifest: DumpManifest;
    try {
      // LOCKED: no pass, hub result or dashboard edit may land inside the dump.
      manifest = await this.writeLock.run(() =>
        dumpStore(this.store, staging, describeSource(this.storeKind)),
      );

      // Compression is pure CPU over files already on disk — no reason to hold
      // the store lock through it.
      const files = ['manifest.json', ...DOC_TYPES.map((t) => `${t.name}.ndjson`)];
      await execFileAsync('tar', ['-czf', partial, '-C', staging, ...files]);

      await this.verify(partial, manifest);
      // Rename last: a crash before this leaves a `.partial` nobody mistakes for
      // a good backup, never a truncated archive that looks complete.
      await rename(partial, final);
    } finally {
      await rm(staging, { recursive: true, force: true });
      await rm(partial, { force: true }).catch(() => {});
    }

    const { size } = await stat(final);
    const prunedLocal = await this.pruneLocal(at);
    const { mirrored, prunedRemote } = await this.mirror(final, name, at);

    const report: BackupReport = {
      name,
      bytes: size,
      docs: Object.values(manifest.counts).reduce((a, b) => a + b, 0),
      ms: Date.now() - startedAt,
      prunedLocal,
      mirrored,
      prunedRemote,
    };
    logger.info('backup', { ...report, kb: Math.round(size / 1024) });
    return report;
  }

  /**
   * Read the manifest back OUT of the finished archive and check the counts.
   * This is the difference between "a file exists" and "a file that restores":
   * it proves the gzip stream is intact, the tar is readable, and the archive
   * holds the document counts we believe it does.
   */
  private async verify(archive: string, expected: DumpManifest): Promise<void> {
    const { stdout } = await execFileAsync('tar', ['-xzOf', archive, 'manifest.json'], {
      maxBuffer: 4 * 1024 * 1024,
    });
    const got = JSON.parse(stdout) as DumpManifest;
    for (const [type, count] of Object.entries(expected.counts)) {
      if (got.counts[type] !== count) {
        throw new Error(`backup verification failed: ${type} is ${got.counts[type]}, expected ${count}`);
      }
    }
  }

  private async pruneLocal(now: Date): Promise<number> {
    const names = await readdir(this.config.dir);
    const doomed = toDelete(names, now, this.config.keepDays);
    for (const name of doomed) await rm(join(this.config.dir, name), { force: true });
    return doomed.length;
  }

  private async bucket(): Promise<BackupBucket> {
    if (this.bucketOverride) return this.bucketOverride();
    const { bucket, credentialsPath } = this.config;
    if (!this.app) {
      const [{ cert, applicationDefault, initializeApp }, { readFile }, { existsSync }] = await Promise.all([
        import('firebase-admin/app'),
        import('node:fs/promises'),
        import('node:fs'),
      ]);
      const credential =
        credentialsPath && existsSync(credentialsPath)
          ? cert(JSON.parse(await readFile(credentialsPath, 'utf8')) as Record<string, string>)
          : applicationDefault();
      this.app = initializeApp({ credential, storageBucket: bucket }, `backup-${Date.now()}`);
    }
    const { getStorage } = await import('firebase-admin/storage');
    return getStorage(this.app).bucket(bucket) as unknown as BackupBucket;
  }

  /** Upload, then apply the same retention rule to the bucket. A mirror failure
   *  is logged, never thrown: the local backup already succeeded, and losing the
   *  server over a Cloud Storage hiccup would be a worse outcome. */
  private async mirror(localPath: string, name: string, now: Date): Promise<{ mirrored: boolean; prunedRemote: number }> {
    if (!this.config.bucket) return { mirrored: false, prunedRemote: 0 };
    try {
      const bucket = await this.bucket();
      await bucket.upload(localPath, {
        destination: `${this.config.prefix}/${name}`,
        metadata: { contentType: 'application/gzip', cacheControl: 'no-store' },
      });
      const [files] = await bucket.getFiles({ prefix: `${this.config.prefix}/` });
      const basename = (n: string): string => n.split('/').pop() ?? '';
      const doomed = new Set(toDelete(files.map((f) => basename(f.name)), now, this.config.keepDays));
      let prunedRemote = 0;
      for (const f of files) {
        if (!doomed.has(basename(f.name))) continue;
        await f.delete();
        prunedRemote++;
      }
      return { mirrored: true, prunedRemote };
    } catch (err) {
      logger.error('backup mirror failed — the local copy is fine', { ...describeError(err) });
      return { mirrored: false, prunedRemote: 0 };
    }
  }
}
