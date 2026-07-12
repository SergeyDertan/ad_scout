// Minimal structured logger. Console output is human-friendly; when file logging
// is enabled (see enableFileLogging), every line is ALSO appended to a daily
// JSONL file so overnight/asleep failures survive a closed terminal or restart.
import { appendFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

type Level = 'debug' | 'info' | 'warn' | 'error';

function p2(n: number): string {
  return String(n).padStart(2, '0');
}

// Local-time stamp, no year, no seconds: "MM-DD HH:MM" (getHours/getMinutes are
// local, so this follows the machine's timezone).
function timestamp(): string {
  const d = new Date();
  return `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

function emit(level: Level, msg: string, meta?: Record<string, unknown>): void {
  const line = `${timestamp()} [${level.toUpperCase()}] ${msg}`;
  const args = meta ? [line, meta] : [line];
  if (level === 'error') console.error(...args);
  else if (level === 'warn') console.warn(...args);
  else console.log(...args);
  writeFile(level, msg, meta);
}

export const logger = {
  debug: (msg: string, meta?: Record<string, unknown>) => emit('debug', msg, meta),
  info: (msg: string, meta?: Record<string, unknown>) => emit('info', msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>) => emit('warn', msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => emit('error', msg, meta),
};

// ----- JSONL file sink -------------------------------------------------------
// Opt-in (serve.ts calls enableFileLogging at boot; tests never do, so they stay
// filesystem-free). Synchronous appends keep it crash-safe with no flush/stream
// lifecycle to manage — log volume here is low (network passes, dripped sends).

let fileDir: string | null = null;
let retentionDays = 14;
let lastCleanupDate = '';

export interface FileLoggingOptions {
  dir?: string;
  retentionDays?: number;
}

/** Start teeing every log line to `<dir>/adscout-YYYY-MM-DD.log` as JSONL. */
export function enableFileLogging(opts: FileLoggingOptions = {}): string | null {
  const dir = opts.dir ?? process.env.LOG_DIR ?? './logs';
  retentionDays = opts.retentionDays ?? Number(process.env.LOG_RETENTION_DAYS ?? 14);
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    fileDir = null; // can't create the dir — stay console-only rather than crash
    return null;
  }
  fileDir = dir;
  cleanup();
  return dir;
}

/** Stop writing to a file (console logging continues). */
export function disableFileLogging(): void {
  fileDir = null;
}

/** Full-precision local timestamp for the file: "YYYY-MM-DD HH:MM:SS.mmm". */
function fileTimestamp(d: Date): string {
  const date = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
  const time = `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
  return `${date} ${time}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

function localDate(d: Date): string {
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}

function writeFile(level: Level, msg: string, meta?: Record<string, unknown>): void {
  if (!fileDir) return;
  try {
    const now = new Date();
    // Core fields first; meta merged in without ever clobbering them.
    const rec: Record<string, unknown> = { ts: fileTimestamp(now), level, msg };
    if (meta) {
      for (const [k, v] of Object.entries(meta)) if (!(k in rec)) rec[k] = v;
    }
    let line: string;
    try {
      line = JSON.stringify(rec);
    } catch {
      // Circular/BigInt/etc. in meta — never drop the line, just the bad meta.
      line = JSON.stringify({ ts: fileTimestamp(now), level, msg, metaError: 'unserializable' });
    }
    const date = localDate(now);
    appendFileSync(join(fileDir, `adscout-${date}.log`), line + '\n');
    if (date !== lastCleanupDate) {
      lastCleanupDate = date; // prune once per day, on the first write of a new day
      cleanup();
    }
  } catch {
    // Logging must never take the app down.
  }
}

function cleanup(): void {
  if (!fileDir || !Number.isFinite(retentionDays) || retentionDays <= 0) return;
  const cutoff = Date.now() - retentionDays * 86_400_000;
  try {
    for (const f of readdirSync(fileDir)) {
      if (!/^adscout-\d{4}-\d{2}-\d{2}\.log$/.test(f)) continue;
      const path = join(fileDir, f);
      try {
        if (statSync(path).mtimeMs < cutoff) unlinkSync(path);
      } catch {
        // A file we can't stat/remove shouldn't abort the sweep.
      }
    }
  } catch {
    // Directory vanished mid-sweep, etc. — ignore.
  }
}
