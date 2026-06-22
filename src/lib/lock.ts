// Single-instance guard (overview.md §8). fs-based, no external dependency.
// Writes a lock file containing this process's pid; a stale lock (dead pid) is
// reclaimed. There is no concurrency within the agent, so this only guards
// against a second process starting.

import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

export interface Lock {
  release(): void;
}

export class LockHeldError extends Error {
  constructor(public readonly byPid: number) {
    super(`agent already running (pid ${byPid})`);
    this.name = 'LockHeldError';
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 = existence check
    return true;
  } catch {
    return false;
  }
}

export function acquireLock(lockPath: string): Lock {
  mkdirSync(dirname(lockPath), { recursive: true });

  if (existsSync(lockPath)) {
    const raw = readFileSync(lockPath, 'utf8').trim();
    const pid = Number(raw);
    if (Number.isInteger(pid) && pid > 0 && pidAlive(pid)) {
      throw new LockHeldError(pid);
    }
    // stale lock — reclaim
    rmSync(lockPath, { force: true });
  }

  writeFileSync(lockPath, String(process.pid), { flag: 'w' });

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try {
      rmSync(lockPath, { force: true });
    } catch {
      /* ignore */
    }
  };
  process.once('exit', release);
  return { release };
}
