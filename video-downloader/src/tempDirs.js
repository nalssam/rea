// Owner of every temp directory this process creates. A directory stays tracked
// until its removal has actually succeeded, so failed cleanups are retried.

import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const TEMP_PREFIX = 'moabatgi-';
const OWN_NAME_RE = /^moabatgi-[A-Za-z0-9]{6}$/; // exactly what mkdtemp(TEMP_PREFIX) produces

export function createTempDirs({ root = tmpdir(), removeDir = (dir) => rm(dir, { recursive: true, force: true }) } = {}) {
  const live = new Set(); // in use by a job
  const doomed = new Set(); // released, removal pending or failed

  async function attempt(dir) {
    try {
      await removeDir(dir);
      doomed.delete(dir);
      return true;
    } catch {
      return false; // still in `doomed`; retried by the next sweep
    }
  }

  return {
    async create() {
      const dir = await mkdtemp(join(root, TEMP_PREFIX));
      live.add(dir);
      return dir;
    },
    /** Releases a directory and tries to delete it. Resolves to whether it is gone. */
    async remove(dir) {
      if (!live.delete(dir) && !doomed.has(dir)) return true;
      doomed.add(dir);
      return attempt(dir);
    },
    async retryFailed() {
      await Promise.all([...doomed].map(attempt));
    },
    /**
     * Startup cleanup of directories a previous process could not remove (SIGKILL, power loss).
     * Only untracked directories older than `maxAgeMs` are touched, so a second instance that
     * shares the temp root keeps its live downloads.
     */
    async sweepStale(maxAgeMs, now = Date.now()) {
      let removed = 0;
      let names = [];
      try {
        names = await readdir(root);
      } catch {
        return removed;
      }
      for (const name of names) {
        if (!OWN_NAME_RE.test(name)) continue;
        const dir = join(root, name);
        if (live.has(dir) || doomed.has(dir)) continue;
        try {
          const info = await stat(dir);
          if (!info.isDirectory() || now - info.mtimeMs < maxAgeMs) continue;
          await removeDir(dir);
          removed += 1;
        } catch {
          /* not ours to insist on */
        }
      }
      return removed;
    },
    /** Synchronous last-resort cleanup for shutdown. */
    removeAllSync() {
      for (const dir of [...live, ...doomed]) {
        try {
          rmSync(dir, { recursive: true, force: true });
          live.delete(dir);
          doomed.delete(dir);
        } catch {
          /* nothing more we can do while exiting */
        }
      }
    },
    /** Every directory still owned (in use or awaiting removal). */
    paths() {
      return [...live, ...doomed];
    },
    get tracked() {
      return live.size + doomed.size;
    },
    get pendingRemoval() {
      return doomed.size;
    },
  };
}
