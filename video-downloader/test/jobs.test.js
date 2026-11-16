import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadConfig } from '../src/config.js';
import { AppError } from '../src/errors.js';
import { createJobManager } from '../src/jobs.js';
import { createTempDirs } from '../src/tempDirs.js';
import { until } from './helpers.js';

/** A controllable stand-in for ytdlp.startDownload. */
function fakeDownloader() {
  const runs = [];
  return {
    runs,
    /** The run of job n. Jobs that start together create their temp dirs concurrently, so the order of `runs` is not theirs. */
    runOf: (n) => runs.find((r) => r.spec.url === `https://youtu.be/${n}`),
    startDownload(spec, hooks) {
      let settle;
      const result = new Promise((resolve, reject) => (settle = { resolve, reject }));
      const run = {
        spec,
        hooks,
        canceled: false,
        succeed(title = 'T') {
          const filePath = join(spec.dir, 'media.mp4');
          writeFileSync(filePath, 'data');
          settle.resolve({ filePath, sizeBytes: spec.fakeSize ?? 4, title, ext: 'mp4' });
        },
        fail(error) {
          settle.reject(error);
        },
      };
      runs.push(run);
      return {
        result,
        cancel() {
          run.canceled = true;
          settle.reject(new AppError('extract_failed'));
        },
      };
    },
  };
}

function setup(env = {}, tempOptions) {
  const config = loadConfig({ MAX_CONCURRENT: '2', DELIVERED_GRACE_SECONDS: '0', ...env });
  const downloader = fakeDownloader();
  const tempDirs = createTempDirs(tempOptions);
  let t = 1_000_000;
  const manager = createJobManager({ config, startDownload: downloader.startDownload, tempDirs, now: () => t });
  const add = (ip = 'ip1', n = 0) => manager.create({ ip, url: `https://youtu.be/${n}`, platform: 'youtube', format: 'video', height: 720 });
  return { manager, downloader, tempDirs, add, advance: (ms) => (t += ms), stop: () => (manager.stop(), tempDirs.removeAllSync()) };
}

test('runs at most MAX_CONCURRENT jobs, FIFO, and reports queue positions', async (t) => {
  const s = setup();
  t.after(s.stop);
  const jobs = [0, 1, 2, 3, 4].map((n) => s.add('ip1', n));
  await until(() => s.downloader.runs.length === 2);
  assert.deepEqual(s.manager.stats(), { active: 2, queued: 3, storedBytes: 0 });
  assert.deepEqual(jobs.map((j) => s.manager.view(j).status), ['downloading', 'downloading', 'queued', 'queued', 'queued']);
  assert.deepEqual(jobs.map((j) => s.manager.view(j).queuePosition), [null, null, 1, 2, 3]);
  assert.match(jobs[0].id, /^[0-9a-f-]{36}$/);

  s.downloader.runOf(1).succeed();
  await until(() => s.downloader.runs.length === 3);
  assert.equal(s.downloader.runs[2].spec.url, 'https://youtu.be/2', 'the oldest queued job starts next');
  assert.deepEqual(jobs.map((j) => s.manager.view(j).queuePosition), [null, null, null, 1, 2]);
  assert.equal(s.manager.stats().active, 2, 'never more than the limit');
  const ready = s.manager.view(jobs[1]);
  assert.equal(ready.status, 'ready');
  assert.equal(ready.progress, 100);
  assert.equal(ready.filename, 'T.mp4');
  assert.equal(ready.sizeBytes, 4);
});

test('progress updates flow into the job view', async (t) => {
  const s = setup();
  t.after(s.stop);
  const job = s.add();
  await until(() => s.downloader.runs.length === 1);
  s.downloader.runs[0].hooks.onUpdate({ status: 'downloading', progress: 42 });
  assert.deepEqual([s.manager.view(job).status, s.manager.view(job).progress], ['downloading', 42]);
  s.downloader.runs[0].hooks.onUpdate({ status: 'processing', progress: 99 });
  assert.equal(s.manager.view(job).status, 'processing');
});

test('cancel: queued jobs leave the queue, running jobs are killed and their dir removed', async (t) => {
  const s = setup();
  t.after(s.stop);
  const jobs = [0, 1, 2, 3].map((n) => s.add('ip1', n));
  await until(() => s.downloader.runs.length === 2);

  await s.manager.cancel(jobs[3].id); // queued
  assert.equal(s.manager.view(jobs[3]).status, 'canceled');
  assert.equal(s.manager.view(jobs[2]).queuePosition, 1);

  const dir = s.downloader.runOf(0).spec.dir;
  assert.ok(existsSync(dir));
  await s.manager.cancel(jobs[0].id); // running
  assert.equal(s.downloader.runOf(0).canceled, true);
  assert.equal(s.manager.view(jobs[0]).status, 'canceled');
  await until(() => !existsSync(dir));
  await until(() => s.downloader.runs.length === 3, 2000, 'the freed slot is reused');
  assert.equal(s.downloader.runs[2].spec.url, 'https://youtu.be/2');

  await s.manager.cancel(jobs[0].id); // idempotent
  assert.equal(s.manager.view(jobs[0]).status, 'canceled');
  await assert.rejects(s.manager.cancel('00000000-0000-4000-8000-000000000000'), { code: 'not_found' });
});

test('failures become an error state with a code, and the temp dir is removed', async (t) => {
  const s = setup();
  t.after(s.stop);
  const a = s.add('ip1', 0);
  const b = s.add('ip1', 1);
  await until(() => s.downloader.runs.length === 2);
  const dirs = s.downloader.runs.map((r) => r.spec.dir);
  s.downloader.runOf(0).fail(new AppError('too_large'));
  s.downloader.runOf(1).fail(new Error('boom'));
  await until(() => s.manager.view(a).status === 'error' && s.manager.view(b).status === 'error');
  assert.equal(s.manager.view(a).error.code, 'too_large');
  assert.equal(s.manager.view(b).error.code, 'extract_failed');
  await until(() => dirs.every((d) => !existsSync(d)));
  await until(() => s.tempDirs.tracked === 0);
});

test('per-IP batch limit counts jobs until their file is handed over; total queue is capped', async (t) => {
  const s = setup({ MAX_BATCH: '2', MAX_QUEUED: '1', MAX_CONCURRENT: '1' });
  t.after(s.stop);
  const first = s.add('ip1', 0);
  s.add('ip1', 1);
  assert.throws(() => s.add('ip1', 2), { code: 'batch_limit' });
  assert.throws(() => s.add('ip2', 3), { code: 'busy' }, 'queue (1 slot) is full');
  await until(() => s.downloader.runs.length === 1);
  s.downloader.runs[0].succeed();
  await until(() => s.downloader.runs.length === 2);
  // Reported by review: a finished but unclaimed file still occupies disk, so it keeps its slot.
  assert.equal(first.status, 'ready');
  assert.throws(() => s.add('ip1', 4), { code: 'batch_limit' }, 'an undelivered file still counts');
  await s.manager.openFile(first.id).release(true);
  assert.doesNotThrow(() => s.add('ip1', 4), 'handing the file over frees the batch slot');
});

test('file hand-out: not_ready while running, deleted after a complete delivery', async (t) => {
  const s = setup();
  t.after(s.stop);
  const job = s.add();
  assert.throws(() => s.manager.openFile(job.id), { code: 'not_ready' });
  await until(() => s.downloader.runs.length === 1);
  s.downloader.runs[0].succeed('제목');
  await until(() => s.manager.view(job).status === 'ready');

  const aborted = s.manager.openFile(job.id);
  await aborted.release(false);
  assert.equal(s.manager.view(job).status, 'ready', 'an aborted transfer keeps the file');
  assert.ok(existsSync(aborted.path));

  const file = s.manager.openFile(job.id);
  assert.equal(file.filename, '제목.mp4');
  assert.equal(file.contentType, 'video/mp4');
  await file.release(true);
  assert.equal(s.manager.view(job).status, 'expired');
  assert.ok(!existsSync(file.path));
  assert.equal(s.tempDirs.tracked, 0);
  assert.throws(() => s.manager.openFile(job.id), { code: 'not_found', status: 410 });
});

test('TTL sweep expires unclaimed files, then forgets finished jobs', async (t) => {
  const s = setup({ JOB_TTL_SECONDS: '60' });
  t.after(s.stop);
  const job = s.add();
  await until(() => s.downloader.runs.length === 1);
  const dir = s.downloader.runs[0].spec.dir;
  s.downloader.runs[0].succeed();
  await until(() => s.manager.view(job).status === 'ready');

  s.advance(59_000);
  await s.manager.sweep();
  assert.equal(s.manager.view(job).status, 'ready');
  s.advance(1_000);
  await s.manager.sweep();
  assert.equal(s.manager.view(job).status, 'expired');
  assert.ok(!existsSync(dir));
  s.advance(60_000);
  await s.manager.sweep();
  assert.throws(() => s.manager.get(job.id), { code: 'not_found' });
});

test('a temp dir whose removal failed stays tracked and is retried by the sweep', async (t) => {
  let failing = true;
  const s = setup({}, {
    removeDir: async (dir) => {
      if (failing) throw new Error('EBUSY');
      await rm(dir, { recursive: true, force: true });
    },
  });
  t.after(s.stop);
  const job = s.add();
  await until(() => s.downloader.runs.length === 1);
  const dir = s.downloader.runs[0].spec.dir;
  s.downloader.runs[0].fail(new AppError('extract_failed'));
  await until(() => s.manager.view(job).status === 'error');
  await until(() => s.tempDirs.pendingRemoval === 1);
  assert.ok(existsSync(dir), 'removal failed, directory is still there');
  assert.equal(s.tempDirs.tracked, 1, 'and it is still owned');

  await s.manager.sweep();
  assert.equal(s.tempDirs.tracked, 1, 'still failing');
  failing = false;
  await s.manager.sweep();
  assert.equal(s.tempDirs.tracked, 0);
  assert.ok(!existsSync(dir));
});

test('after a complete send the file stays for a grace period, then is removed', async (t) => {
  const s = setup({ DELIVERED_GRACE_SECONDS: '60', JOB_TTL_SECONDS: '900', MAX_BATCH: '1' });
  t.after(s.stop);
  const job = s.add();
  await until(() => s.downloader.runs.length === 1);
  s.downloader.runs[0].succeed();
  await until(() => s.manager.view(job).status === 'ready');

  const file = s.manager.openFile(job.id);
  await file.release(true);
  assert.equal(s.manager.view(job).status, 'ready', 'the browser may not have stored it: a retry must still work');
  assert.ok(existsSync(file.path));
  assert.doesNotThrow(() => s.add('ip1', 1), 'a delivered file no longer counts against the batch');
  const retry = s.manager.openFile(job.id);
  await retry.release(true);

  s.advance(59_000);
  await s.manager.sweep();
  assert.equal(s.manager.view(job).status, 'ready');
  s.advance(1_000);
  await s.manager.sweep();
  assert.equal(s.manager.view(job).status, 'expired', 'grace is counted from the first complete send');
  assert.ok(!existsSync(file.path));
});

test('file streams: at most two per job, kept alive across the TTL, aborted when the file is taken away', async (t) => {
  const s = setup({ JOB_TTL_SECONDS: '60' });
  t.after(s.stop);
  const job = s.add();
  await until(() => s.downloader.runs.length === 1);
  s.downloader.runs[0].succeed();
  await until(() => s.manager.view(job).status === 'ready');

  const a = s.manager.openFile(job.id);
  const b = s.manager.openFile(job.id);
  assert.throws(() => s.manager.openFile(job.id), { code: 'busy', status: 429 });
  await b.release(false);
  await b.release(false); // double release must not free a second slot
  const c = s.manager.openFile(job.id);
  assert.throws(() => s.manager.openFile(job.id), { code: 'busy' });
  await c.release(false);

  s.advance(61_000);
  await s.manager.sweep();
  assert.equal(s.manager.view(job).status, 'ready', 'a transfer in progress is not cut by the TTL');
  let aborted = 0;
  a.onRevoke(() => (aborted += 1));
  await s.manager.cancel(job.id);
  assert.equal(aborted, 1, 'canceling aborts the open response so the unlinked file is not pinned');
  assert.ok(!existsSync(a.path));
  await a.release(false);

  const other = s.add('ip1', 1);
  await until(() => s.downloader.runs.length === 2);
  s.downloader.runs[1].succeed();
  await until(() => s.manager.view(other).status === 'ready');
  const d = s.manager.openFile(other.id);
  await d.release(false);
  s.advance(61_000);
  await s.manager.sweep();
  assert.equal(s.manager.view(other).status, 'expired', 'without an open stream the TTL applies');
});

test('disk budget: finished files plus running downloads never exceed MAX_STORED_MB', async (t) => {
  const MB = 1024 * 1024;
  // 1 MB per file, 3 MB budget, 2 at a time.
  const config = loadConfig({ MAX_CONCURRENT: '2', MAX_FILE_MB: '1', MAX_STORED_MB: '3', DELIVERED_GRACE_SECONDS: '0' });
  const downloader = fakeDownloader();
  const tempDirs = createTempDirs();
  const manager = createJobManager({
    config,
    startDownload: (spec, hooks) => downloader.startDownload({ ...spec, fakeSize: MB }, hooks),
    tempDirs,
  });
  t.after(() => (manager.stop(), tempDirs.removeAllSync()));
  const jobs = [0, 1, 2, 3].map((n) => manager.create({ ip: `ip${n}`, url: `https://youtu.be/${n}`, platform: 'youtube', format: 'video' }));
  await until(() => downloader.runs.length === 2);
  downloader.runs[0].succeed();
  downloader.runs[1].succeed();
  await until(() => manager.view(jobs[1]).status === 'ready' && manager.view(jobs[0]).status === 'ready');
  // 2 MB stored + 1 running (worst case 1 MB) = 3 MB: exactly one more may run, not two.
  await until(() => downloader.runs.length === 3);
  assert.deepEqual(manager.stats(), { active: 1, queued: 1, storedBytes: 2 * MB });
  assert.equal(manager.view(jobs[3]).queuePosition, 1);
  downloader.runs[2].succeed();
  await until(() => manager.view(jobs[2]).status === 'ready');
  assert.equal(manager.stats().active, 0, '3 MB stored: the last job waits for space');
  assert.equal(manager.view(jobs[3]).status, 'queued');
  await manager.openFile(jobs[0].id).release(true); // delivered -> removed -> space again
  await until(() => downloader.runs.length === 4, 2000, 'freed space starts the waiting job');
  assert.throws(() => loadConfig({ MAX_FILE_MB: '500', MAX_STORED_MB: '100' }), /MAX_STORED_MB/);
});
