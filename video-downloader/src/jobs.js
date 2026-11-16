// Owner of job state, the FIFO download queue and each job's temp directory.

import { randomUUID } from 'node:crypto';
import { AppError } from './errors.js';
import { buildFilename, mediaContentType } from './filename.js';

const ACTIVE = new Set(['queued', 'downloading', 'processing']);

/**
 * @param {object} deps
 * @param {object} deps.config
 * @param {(spec: {url:string, platform:string, shortlink:boolean, format:string, height:number|null, dir:string}, hooks: {onUpdate: Function}) => {result: Promise<{filePath:string,sizeBytes:number,title:string|null,ext:string}>, cancel(): void}} deps.startDownload
 * @param {ReturnType<import('./tempDirs.js').createTempDirs>} deps.tempDirs
 */
export function createJobManager({ config, startDownload, tempDirs, now = Date.now }) {
  const jobs = new Map();
  const queue = []; // job ids, FIFO
  let running = 0;
  const ttlMs = config.jobTtlSeconds * 1000;
  const graceMs = config.deliveredGraceSeconds * 1000;
  const maxFileBytes = config.maxFileMB * 1024 * 1024;
  const maxStoredBytes = config.maxStoredMB * 1024 * 1024;

  /** A job is "unfinished" for its owner until its file has been handed over (or it failed). */
  function holdsSlot(job) {
    return ACTIVE.has(job.status) || (job.status === 'ready' && !job.delivered);
  }

  function countHeldFor(ip) {
    let n = 0;
    for (const job of jobs.values()) if (job.ip === ip && holdsSlot(job)) n += 1;
    return n;
  }

  function storedBytes() {
    let bytes = 0;
    for (const job of jobs.values()) if (job.filePath) bytes += job.sizeBytes ?? 0;
    return bytes;
  }

  /** Throws when `ip` may not add another job right now. Has no side effects. */
  function assertCanCreate(ip) {
    if (countHeldFor(ip) >= config.maxBatch) {
      throw new AppError('batch_limit', `한 번에 최대 ${config.maxBatch}개까지 받을 수 있습니다. 진행 중이거나 아직 저장하지 않은 파일을 정리한 뒤 다시 시도해 주세요.`);
    }
    if (queue.length >= config.maxQueued) throw new AppError('busy');
  }

  function create({ ip, url, platform, shortlink = false, format, height = null, title = null }) {
    assertCanCreate(ip);
    const job = {
      id: randomUUID(),
      ip,
      url,
      platform,
      shortlink,
      format,
      height,
      title,
      status: 'queued',
      progress: null,
      error: null,
      dir: null,
      filePath: null,
      filename: null,
      contentType: null,
      sizeBytes: null,
      cancelRun: null,
      canceled: false,
      finishedAt: null,
      delivered: false,
      deliveredAt: null,
      streams: 0, // file responses currently reading filePath
      revokers: new Set(), // abort callbacks of those responses
    };
    jobs.set(job.id, job);
    queue.push(job.id);
    pump();
    return job;
  }

  function finish(job, status, error = null) {
    job.status = status;
    job.error = error;
    job.finishedAt = now();
    job.cancelRun = null;
  }

  async function dropFiles(job) {
    job.filePath = null;
    // An open response would keep the unlinked file (and its disk space) alive.
    for (const revoke of [...job.revokers]) revoke();
    const dir = job.dir;
    if (dir) {
      job.dir = null;
      await tempDirs.remove(dir); // failures stay tracked by tempDirs and are retried by sweep()
    }
    pump(); // freed disk budget may let a queued job start
  }

  /** Disk budget: finished files plus the worst case of every running download must fit. */
  function hasDiskBudget() {
    const stored = storedBytes();
    if (running === 0 && stored === 0) return true;
    return stored + (running + 1) * maxFileBytes <= maxStoredBytes;
  }

  function pump() {
    while (running < config.maxConcurrent && queue.length > 0 && hasDiskBudget()) {
      const job = jobs.get(queue.shift());
      if (!job || job.status !== 'queued') continue;
      running += 1;
      job.status = 'downloading';
      job.progress = 0;
      execute(job).finally(() => {
        running -= 1;
        pump();
      });
    }
  }

  async function execute(job) {
    try {
      job.dir = await tempDirs.create();
      if (job.canceled) throw new AppError('extract_failed');
      const run = startDownload(
        { url: job.url, platform: job.platform, shortlink: job.shortlink, format: job.format, height: job.height, dir: job.dir },
        {
          onUpdate({ status, progress }) {
            if (job.canceled || !ACTIVE.has(job.status)) return;
            if (status === 'downloading' || status === 'processing') job.status = status;
            if (typeof progress === 'number') job.progress = Math.max(job.progress ?? 0, Math.min(100, progress));
          },
        },
      );
      job.cancelRun = run.cancel;
      const output = await run.result; // settles only after the process tree is gone
      if (job.canceled) throw new AppError('extract_failed');
      job.filePath = output.filePath;
      job.sizeBytes = output.sizeBytes;
      job.filename = buildFilename(output.title ?? job.title, output.ext);
      job.contentType = mediaContentType(output.ext);
      job.progress = 100;
      finish(job, 'ready');
    } catch (error) {
      if (job.canceled) {
        if (job.status !== 'canceled') finish(job, 'canceled');
      } else {
        const appError = error instanceof AppError ? error : new AppError('extract_failed');
        if (!(error instanceof AppError) && config.debug) console.error('[job] unexpected failure', error);
        finish(job, 'error', appError.toJSON());
      }
      await dropFiles(job);
    }
  }

  function view(job) {
    const index = job.status === 'queued' ? queue.indexOf(job.id) : -1;
    return {
      id: job.id,
      status: job.status,
      progress: job.status === 'queued' ? null : job.progress,
      queuePosition: index >= 0 ? index + 1 : null,
      filename: job.status === 'ready' ? job.filename : null,
      sizeBytes: job.status === 'ready' ? job.sizeBytes : null,
      error: job.error,
    };
  }

  function get(id) {
    const job = jobs.get(id);
    if (!job) throw new AppError('not_found');
    return job;
  }

  /** Cancels a job in any state. Idempotent for already finished jobs. */
  async function cancel(id) {
    const job = get(id);
    if (job.status === 'queued') {
      const index = queue.indexOf(job.id);
      if (index >= 0) queue.splice(index, 1);
      job.canceled = true;
      finish(job, 'canceled');
    } else if (job.status === 'downloading' || job.status === 'processing') {
      const cancelRun = job.cancelRun;
      job.canceled = true;
      finish(job, 'canceled');
      // execute() removes the temp dir once the killed process tree has really exited.
      if (cancelRun) cancelRun();
    } else if (job.status === 'ready') {
      job.canceled = true;
      finish(job, 'canceled');
      await dropFiles(job);
    }
  }

  async function expire(job) {
    finish(job, 'expired');
    await dropFiles(job);
  }

  /**
   * Hands out the finished file for streaming.
   * `release(delivered)` must be called exactly when the response ends. After a complete send
   * the file is kept for a short grace period (the server cannot see whether the browser really
   * stored it), then removed; it no longer counts against the owner's batch.
   */
  function openFile(id) {
    const job = get(id);
    if (ACTIVE.has(job.status)) throw new AppError('not_ready');
    if (job.status !== 'ready' || !job.filePath) {
      throw new AppError('not_found', '파일이 이미 전송되었거나 보관 시간이 지났습니다. 다시 받아 주세요.', 410);
    }
    if (job.streams >= config.maxStreamsPerJob) {
      throw new AppError('busy', '이 파일은 이미 전송 중입니다. 잠시 후 다시 시도해 주세요.', 429);
    }
    job.streams += 1;
    let revoke = null;
    let released = false;
    return {
      path: job.filePath,
      sizeBytes: job.sizeBytes,
      filename: job.filename,
      contentType: job.contentType,
      /** `fn` aborts the response when the file is taken away (cancel, expiry). */
      onRevoke(fn) {
        revoke = fn;
        job.revokers.add(fn);
      },
      async release(delivered) {
        if (released) return;
        released = true;
        job.streams -= 1;
        if (revoke) job.revokers.delete(revoke);
        if (!delivered || job.status !== 'ready') return;
        if (!job.delivered) {
          job.delivered = true;
          job.deliveredAt = now();
        }
        if (graceMs === 0 && job.streams === 0) await expire(job);
      },
    };
  }

  function fileExpiry(job) {
    const byTtl = job.finishedAt + ttlMs;
    return job.delivered ? Math.min(byTtl, job.deliveredAt + graceMs) : byTtl;
  }

  /** TTL cleanup: expire unclaimed files, forget old finished jobs, retry failed dir removals. */
  async function sweep() {
    const t = now();
    const work = [];
    for (const job of jobs.values()) {
      if (job.finishedAt === null) continue;
      if (job.status === 'ready') {
        // A response in progress keeps its file; the HTTP layer bounds how long that can take.
        if (t >= fileExpiry(job) && job.streams === 0) work.push(expire(job));
      } else if (t - job.finishedAt >= ttlMs && !job.dir) {
        jobs.delete(job.id);
      }
    }
    await Promise.all(work);
    await tempDirs.retryFailed();
  }

  const sweepEveryMs = Math.max(250, Math.min(30_000, Math.floor(Math.min(ttlMs, graceMs > 0 ? graceMs : ttlMs) / 4)));
  const timer = setInterval(() => {
    sweep().catch(() => {});
  }, sweepEveryMs);
  timer.unref();

  return {
    create,
    assertCanCreate,
    get,
    view,
    cancel,
    openFile,
    sweep,
    stats() {
      return { active: running, queued: queue.length, storedBytes: storedBytes() };
    },
    /** Stops everything; the caller kills child processes and removes temp dirs. */
    stop() {
      clearInterval(timer);
      queue.length = 0;
      for (const job of jobs.values()) {
        if (ACTIVE.has(job.status)) {
          const cancelRun = job.cancelRun;
          job.canceled = true;
          finish(job, 'canceled');
          if (cancelRun) cancelRun();
        }
      }
    },
  };
}
