// Snapshot publisher — uploads the built snapshot to Firebase Cloud Storage.
//
// This is the ONLY thing that leaves the machine. It is one-way and read-only
// by construction: nothing in the viewer can write back here, and no credential,
// mailbox or send capability is ever part of a snapshot.
//
// Change detection is done against the REMOTE manifest, not a local state file.
// A local file would drift the first time a bucket is wiped or a snapshot is
// published from somewhere else, and the failure mode (viewer silently frozen on
// stale data) is invisible. Reading the manifest costs one small GET.
//
// Ordering matters: data files first, manifest LAST. The viewer keys everything
// off the manifest, so a crash halfway through leaves it reading the previous,
// wholly consistent snapshot rather than a half-updated one.

import { gzipSync } from 'node:zlib';
import { applicationDefault, cert, deleteApp, initializeApp, type App } from 'firebase-admin/app';
import { getStorage } from 'firebase-admin/storage';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { describeError } from '../lib/errors';
import { logger } from '../lib/logger';
import type { Clock } from '../lib/clock';
import type { Store } from '../ports/store';
import { buildSnapshot } from './snapshot';

export interface PublishConfig {
  /** Cloud Storage bucket, e.g. "adscout-viewer.firebasestorage.app". */
  bucket: string;
  /** Path to the service-account JSON. Never committed — see .env.example. */
  credentialsPath: string;
  /** Object-name prefix inside the bucket. */
  prefix: string;
  /** Idle gap before a change-triggered publish fires. */
  debounceMs: number;
}

export interface PublishReport {
  uploaded: number;
  deleted: number;
  unchanged: number;
  bytes: number;
  builtAt: string;
}

/**
 * Read publish settings from the environment. Returns null when publishing is
 * not configured, which is the normal state for a machine that only runs the
 * pipeline — an unconfigured publisher is a no-op, never an error.
 */
export function loadPublishConfig(env: NodeJS.ProcessEnv = process.env): PublishConfig | null {
  let bucket = env.SNAPSHOT_BUCKET?.trim();
  if (bucket?.startsWith('gs://')) {
    bucket = bucket.slice(5);
  }
  if (bucket?.endsWith('/')) {
    bucket = bucket.slice(0, -1);
  }
  if (!bucket) return null;
  const credentialsPath = env.SNAPSHOT_CREDENTIALS?.trim();
  const debounce = Number(env.SNAPSHOT_DEBOUNCE_MS ?? 60_000);
  return {
    bucket,
    credentialsPath: credentialsPath || '',
    prefix: env.SNAPSHOT_PREFIX?.trim() || 'snapshot',
    debounceMs: Number.isFinite(debounce) ? debounce : 60_000,
  };
}

/** Is publishing switched on? Configured AND not explicitly disabled. */
export function publishEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (/^(0|false|no|off)$/i.test((env.SNAPSHOT_PUBLISH ?? '').trim())) return false;
  return loadPublishConfig(env) != null;
}

export class SnapshotPublisher {
  private app?: App;
  private timer?: ReturnType<typeof setTimeout>;
  /** In-flight publish, so overlapping triggers queue instead of racing. */
  private running?: Promise<PublishReport>;
  /** A change that arrived mid-publish — publish again once this one lands. */
  private dirty = false;
  private stopped = false;

  constructor(
    private readonly store: Store,
    private readonly clock: Clock,
    private readonly config: PublishConfig,
  ) {}

  /** Build and upload everything that changed. Serialized: a concurrent call
   *  joins the run already in flight rather than starting a second one. */
  publishNow(): Promise<PublishReport> {
    if (this.running) {
      this.dirty = true;
      return this.running;
    }
    this.running = this.run().finally(() => {
      this.running = undefined;
      // Changes landed while we were uploading — go again, debounced.
      if (this.dirty && !this.stopped) {
        this.dirty = false;
        this.schedule();
      }
    });
    return this.running;
  }

  /**
   * Subscribe to the store's change feed and publish after `debounceMs` of
   * quiet. Every write goes through the store, so this covers a poll cycle, a
   * fetch, an AI extraction and a hand-edit alike — without threading a publish
   * call through each pass.
   *
   * Returns an unsubscribe function.
   */
  attach(): () => void {
    const unsubscribe = this.store.subscribe(() => this.schedule());
    return () => {
      unsubscribe();
      this.stop();
    };
  }

  /** Arm the debounce timer. Repeated calls push the deadline out, so a burst of
   *  writes (one poll cycle storing 40 replies) publishes once at the end. */
  schedule(): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.publishNow().catch((err) => {
        // Never let a publish failure touch the pipeline: the local store is the
        // source of truth and the next change re-triggers this anyway.
        logger.error('snapshot publish failed', { ...describeError(err) });
      });
    }, this.config.debounceMs);
    // Don't hold the process open just to publish.
    (this.timer as { unref?: () => void }).unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.app) {
      void deleteApp(this.app).catch(() => {});
      this.app = undefined;
    }
  }

  private async bucket() {
    if (!this.app) {
      if (this.config.credentialsPath && existsSync(this.config.credentialsPath)) {
        const raw = await readFile(this.config.credentialsPath, 'utf8');
        this.app = initializeApp(
          { credential: cert(JSON.parse(raw) as Record<string, string>), storageBucket: this.config.bucket },
          `snapshot-${Date.now()}`,
        );
      } else {
        const isEmulator = Boolean(process.env.FIREBASE_STORAGE_EMULATOR_HOST || process.env.STORAGE_EMULATOR_HOST);
        const projectId = process.env.GCP_PROJECT || process.env.FIREBASE_PROJECT || 'postwormhole';
        this.app = initializeApp(
          {
            storageBucket: this.config.bucket,
            projectId,
            ...(isEmulator ? {} : { credential: applicationDefault() }),
          },
          `snapshot-${Date.now()}`,
        );
      }
    }
    return getStorage(this.app).bucket(this.config.bucket);
  }

  private objectName(path: string): string {
    return `${this.config.prefix}/${path}`;
  }

  /** Upload one JSON file, gzipped. Returns the compressed byte count.
   *  Stored gzipped and served transcoded: responses.json is ~2 MB of JSON that
   *  compresses to a quarter of that, and the viewer fetches it on every load.
   *  `no-cache` because paths are stable — freshness beats a saved round-trip on
   *  files this small. */
  private async put(
    bucket: Awaited<ReturnType<SnapshotPublisher['bucket']>>,
    path: string,
    body: string,
  ): Promise<number> {
    const gz = gzipSync(body);
    await withRetry(() =>
      bucket.file(this.objectName(path)).save(gz, {
        contentType: 'application/json',
        metadata: { contentEncoding: 'gzip', cacheControl: 'no-cache' },
        resumable: false,
      }),
    );
    return gz.byteLength;
  }

  private async run(): Promise<PublishReport> {
    const started = Date.now();
    const bucket = await this.bucket();
    const snapshot = await buildSnapshot(this.store, this.clock);

    // What is already up there. Absent on a first publish (or after the bucket
    // was cleared), in which case everything uploads.
    let previous: Record<string, string> = {};
    try {
      const [buf] = await withRetry(() => bucket.file(this.objectName('files.json')).download());
      previous = JSON.parse(buf.toString('utf8')) as Record<string, string>;
    } catch {
      previous = {};
    }

    const changed = snapshot.files.filter((f) => previous[f.path] !== f.hash);
    let bytes = 0;
    // Modest concurrency: enough to keep the link busy, low enough that a poll
    // cycle's worth of new replies doesn't open hundreds of sockets at once.
    for (const group of chunk(changed, 8)) {
      await Promise.all(
        group.map(async (f) => {
          bytes += await this.put(bucket, f.path, f.body);
        }),
      );
    }

    // The visibility switch: every data file above is uploaded by now, so this
    // is the point where the viewer starts seeing the new snapshot. A crash
    // before here leaves it on the previous, wholly consistent one.
    await this.put(bucket, 'manifest.json', JSON.stringify(snapshot.manifest));
    // The change detector, written after the manifest on purpose: a crash
    // between the two makes the next run re-upload everything (idempotent and
    // harmless), which is the safe direction to fail in.
    await this.put(bucket, 'files.json', JSON.stringify(snapshot.fileHashes));

    // Files that existed in the previous snapshot and don't any more (a deleted
    // reply, a domain that lost its last record). Deleted only after the new
    // manifest is live, so a viewer mid-load never chases a vanished file.
    const live = new Set(snapshot.files.map((f) => f.path));
    const gone = Object.keys(previous).filter((p) => !live.has(p));
    for (const group of chunk(gone, 12)) {
      await Promise.all(
        group.map((p) =>
          withRetry(() => bucket.file(this.objectName(p)).delete({ ignoreNotFound: true })),
        ),
      );
    }

    const report: PublishReport = {
      uploaded: changed.length,
      deleted: gone.length,
      unchanged: snapshot.files.length - changed.length,
      bytes,
      builtAt: snapshot.manifest.builtAt,
    };
    logger.info('snapshot published', { ...report, ms: Date.now() - started });
    return report;
  }
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function withRetry<T>(fn: () => Promise<T>, retries = 3, delayMs = 500): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < retries - 1) {
        await new Promise((r) => setTimeout(r, delayMs * (i + 1)));
      }
    }
  }
  throw lastErr;
}
