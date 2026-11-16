// HTTP adapter: routing, request parsing, static files and response headers.
// All product rules live in the modules it composes.

import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { AppError } from './errors.js';
import { contentDisposition } from './filename.js';
import { createJobManager } from './jobs.js';
import { createEgressGuard } from './egressGuard.js';
import { createDailyLimiter, createInFlightLimiter, createWindowLimiter } from './rateLimit.js';
import { createSemaphore } from './semaphore.js';
import { createTempDirs } from './tempDirs.js';
import { createUrlPolicy, publicPlatforms } from './urlPolicy.js';
import { createYtdlp } from './ytdlp.js';

const DEFAULT_PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const INFO_CACHE_MAX = 500;

const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
};

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' https: data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
};

export function createApp(config, { now = Date.now, publicDir = DEFAULT_PUBLIC_DIR } = {}) {
  const urlPolicy = createUrlPolicy({ extraAllowedHosts: config.extraAllowedHosts });
  const egress = config.egressGuard
    ? createEgressGuard({ allowsExtraEndpoint: urlPolicy.allowsExtraEndpoint, upstream: config.upstreamProxy, debug: config.debug })
    : null;
  const ytdlp = createYtdlp(config, { proxyUrl: async () => (egress ? egress.url() : null) });
  const tempDirs = createTempDirs();
  const jobs = createJobManager({ config, startDownload: ytdlp.startDownload, tempDirs, now });
  const daily = createDailyLimiter({ limit: config.dailyPerIp, now });
  const infoRate = createWindowLimiter({ limit: config.infoPerMinute, windowMs: 60_000, now });
  const infoPerIp = createInFlightLimiter({ limit: config.infoPerIpConcurrent });
  const infoSlots = createSemaphore({ limit: config.infoConcurrency, maxWaiting: config.infoMaxWaiting });
  const infoCache = new Map(); // normalized URL -> { expires, value }
  const infoInFlight = new Map(); // normalized URL -> { promise, controller, requesters }
  const publicRoot = resolve(publicDir);

  // ------------------------------------------------------------ helpers

  function clientIp(req) {
    if (config.trustedProxyHops > 0) {
      // Each trusted proxy appends the address it saw, so the client is counted from the right.
      // Entries further left are whatever the client chose to send and are never trusted.
      const header = req.headers['x-forwarded-for'];
      const entries = (Array.isArray(header) ? header.join(',') : header ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      const entry = entries[entries.length - config.trustedProxyHops];
      if (entry !== undefined && entry.length <= 64) return entry;
    }
    return req.socket.remoteAddress ?? 'unknown';
  }

  /**
   * State-changing API calls must come from this site's own page. Without this, any web page
   * could make its visitors' browsers start downloads here (spending their daily quota and
   * this server's capacity), because a form/no-cors POST needs no CORS permission.
   */
  function assertSameSite(req) {
    const forbidden = () => new AppError('bad_request', '다른 사이트에서 보낸 요청은 받을 수 없습니다.', 403);
    const fetchSite = req.headers['sec-fetch-site'];
    if (fetchSite !== undefined) {
      // Set by the browser itself; page scripts cannot forge it.
      if (fetchSite !== 'same-origin' && fetchSite !== 'none') throw forbidden();
      return;
    }
    const origin = req.headers.origin;
    if (origin === undefined) return; // not a browser (curl, tests): nothing to protect
    let originHost;
    try {
      originHost = new URL(origin).host;
    } catch {
      throw forbidden(); // includes the opaque origin "null"
    }
    const hosts = [req.headers.host];
    if (config.trustedProxyHops > 0) hosts.push(req.headers['x-forwarded-host']);
    if (!hosts.includes(originHost)) throw forbidden();
  }

  function assertJsonContentType(req) {
    // Not a CORS "simple" content type, so cross-site pages cannot send it without a preflight.
    const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    if (type !== 'application/json') {
      throw new AppError('bad_request', 'Content-Type 은 application/json 이어야 합니다.', 415);
    }
  }

  function sendJson(res, status, body, extraHeaders = {}) {
    const payload = Buffer.from(JSON.stringify(body));
    res.writeHead(status, {
      ...SECURITY_HEADERS,
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': payload.length,
      'Cache-Control': 'no-store',
      ...extraHeaders,
    });
    res.end(payload);
  }

  function sendError(res, error) {
    const appError = error instanceof AppError ? error : null;
    if (!appError) {
      if (config.debug) console.error('[http] unexpected error', error);
      sendJson(res, 500, { error: new AppError('internal').toJSON() });
      return;
    }
    sendJson(res, appError.status, { error: appError.toJSON() });
  }

  function readJsonBody(req) {
    return new Promise((resolveBody, reject) => {
      try {
        assertJsonContentType(req);
      } catch (error) {
        req.resume();
        reject(error);
        return;
      }
      const declared = Number(req.headers['content-length']);
      if (Number.isFinite(declared) && declared > config.maxBodyBytes) {
        req.resume();
        reject(new AppError('bad_request', '요청 본문이 너무 큽니다.', 413));
        return;
      }
      const chunks = [];
      let size = 0;
      let failed = false;
      req.on('data', (chunk) => {
        if (failed) return;
        size += chunk.length;
        if (size > config.maxBodyBytes) {
          failed = true;
          chunks.length = 0;
          reject(new AppError('bad_request', '요청 본문이 너무 큽니다.', 413));
          return;
        }
        chunks.push(chunk);
      });
      req.on('error', () => reject(new AppError('bad_request')));
      req.on('end', () => {
        if (failed) return;
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new Error('not an object');
          resolveBody(body);
        } catch {
          reject(new AppError('bad_request', 'JSON 형식이 올바르지 않습니다.'));
        }
      });
    });
  }

  // ------------------------------------------------------------ info

  /**
   * Joins (or starts) the lookup for a checked URL. Identical concurrent lookups share one
   * yt-dlp run; when every requester has gone away the run is killed instead of finishing
   * for nobody.
   * @returns {{ promise: Promise<object>, leave(): void }}
   */
  function joinLookup(target) {
    const { url } = target;
    const cached = infoCache.get(url);
    if (cached && cached.expires > now()) return { promise: Promise.resolve(cached.value), leave() {} };
    if (cached) infoCache.delete(url);

    let entry = infoInFlight.get(url);
    if (!entry) {
      const controller = new AbortController();
      entry = { controller, requesters: 0, promise: null };
      const own = entry;
      entry.promise = infoSlots
        .run(() => ytdlp.fetchInfo(target, { signal: controller.signal }))
        .then((value) => {
          if (config.infoCacheSeconds > 0) {
            if (infoCache.size >= INFO_CACHE_MAX) infoCache.delete(infoCache.keys().next().value);
            infoCache.set(url, { expires: now() + config.infoCacheSeconds * 1000, value });
          }
          return value;
        })
        .finally(() => {
          own.settled = true;
          if (infoInFlight.get(url) === own) infoInFlight.delete(url);
        });
      entry.promise.catch(() => {}); // an abandoned lookup has nobody left to report to
      infoInFlight.set(url, entry);
    }
    const joined = entry;
    joined.requesters += 1;
    let left = false;
    return {
      promise: joined.promise,
      leave() {
        if (left) return;
        left = true;
        joined.requesters -= 1;
        if (joined.requesters === 0 && !joined.settled) {
          if (infoInFlight.get(url) === joined) infoInFlight.delete(url);
          joined.controller.abort();
        }
      },
    };
  }

  // ------------------------------------------------------------ API handlers

  function handleConfig(res) {
    sendJson(res, 200, {
      siteName: config.siteName,
      platforms: publicPlatforms(),
      // Hosts added with EXTRA_ALLOWED_HOSTS, so the page's pre-check agrees with the server.
      extraHosts: urlPolicy.extraHosts(),
      limits: {
        maxBatch: config.maxBatch,
        maxHeight: config.maxHeight,
        maxFileMB: config.maxFileMB,
        dailyPerIp: config.dailyPerIp,
        maxConcurrent: config.maxConcurrent,
        jobTtlSeconds: config.jobTtlSeconds,
      },
    });
  }

  function handleStatus(req, res) {
    const { active, queued } = jobs.stats();
    sendJson(res, 200, {
      active,
      queued,
      maxConcurrent: config.maxConcurrent,
      ipToday: daily.used(clientIp(req)),
      dailyPerIp: config.dailyPerIp,
    });
  }

  async function handleInfo(req, res) {
    const body = await readJsonBody(req);
    const target = urlPolicy.check(body.url);
    const ip = clientIp(req);
    // One client may only occupy a small share of the lookup slots and waiting line.
    const release = infoPerIp.tryAcquire(ip);
    if (!release) throw new AppError('busy', '한 번에 확인할 수 있는 링크 수를 넘었습니다. 잠시 후 다시 시도해 주세요.', 429);
    let lookup = null;
    const onClose = () => lookup?.leave();
    try {
      if (!infoRate.tryConsume(ip)) throw new AppError('busy', '요청이 너무 잦습니다. 잠시 후 다시 시도해 주세요.', 429);
      lookup = joinLookup(target);
      res.on('close', onClose);
      const info = await lookup.promise;
      sendJson(res, 200, { url: target.url, platform: target.platform, ...info });
    } finally {
      res.off('close', onClose);
      lookup?.leave();
      release();
    }
  }

  async function handleCreateJob(req, res) {
    const body = await readJsonBody(req);
    if (body.format !== 'video' && body.format !== 'audio') {
      throw new AppError('bad_request', 'format 은 "video" 또는 "audio" 여야 합니다.');
    }
    let height = null;
    if (body.format === 'video' && body.height !== undefined && body.height !== null) {
      if (!Number.isInteger(body.height) || body.height < 1 || body.height > 10_000) {
        throw new AppError('bad_request', 'height 값이 올바르지 않습니다.');
      }
      height = body.height;
    }
    const { url, platform, shortlink } = urlPolicy.check(body.url);
    const ip = clientIp(req);
    jobs.assertCanCreate(ip); // before spending one of today's uses
    if (!daily.tryConsume(ip)) {
      throw new AppError('daily_limit', `오늘 받을 수 있는 횟수(${config.dailyPerIp}회)를 모두 사용했습니다. 내일(한국 시간 자정 이후) 다시 이용해 주세요.`);
    }
    const cachedTitle = infoCache.get(url)?.value.title ?? null;
    const job = jobs.create({ ip, url, platform, shortlink, format: body.format, height, title: cachedTitle });
    sendJson(res, 202, { id: job.id, status: 'queued' });
  }

  function handleFile(req, res, id) {
    const file = jobs.openFile(id);
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': file.contentType,
      'Content-Length': file.sizeBytes,
      'Content-Disposition': contentDisposition(file.filename),
      'Cache-Control': 'no-store',
    });
    const source = createReadStream(file.path);
    // A reader slower than the minimum average rate is cut off: an open response pins the
    // file's disk space even after the job has expired.
    const deadlineMs = 30_000 + Math.ceil(file.sizeBytes / (config.fileMinKBps * 1024)) * 1000;
    const deadline = setTimeout(() => res.destroy(), deadlineMs);
    file.onRevoke(() => res.destroy());
    let handedOver = 0;
    source.on('data', (chunk) => (handedOver += chunk.length));
    pipeline(source, res, () => {
      clearTimeout(deadline);
      // "Delivered" = every byte was handed to the connection. The pipeline's error is not
      // used: a client that closes as soon as it has the last byte (Connection: close, HTTP/1.0
      // proxies) reports a premature close although it holds the whole file. The opposite
      // mistake (bytes still in a socket buffer when the client gave up) is covered by the
      // grace period during which a delivered file can be fetched again.
      file.release(handedOver === file.sizeBytes).catch(() => {});
    });
  }

  // ------------------------------------------------------------ static files

  async function handleStatic(req, res, pathname) {
    let decoded;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      throw new AppError('bad_request');
    }
    if (decoded.includes('\0') || decoded.includes('\\')) throw new AppError('not_found');
    const relative = decoded.endsWith('/') ? `${decoded}index.html` : decoded;
    const target = resolve(join(publicRoot, relative));
    if (target !== publicRoot && !target.startsWith(publicRoot + sep)) throw new AppError('not_found');
    if (relative.split('/').some((segment) => segment.startsWith('.'))) throw new AppError('not_found');

    let real;
    let info;
    try {
      real = await realpath(target);
      const realRoot = await realpath(publicRoot);
      if (real !== realRoot && !real.startsWith(realRoot + sep)) throw new Error('escapes root');
      info = await stat(real);
      if (!info.isFile()) throw new Error('not a file');
    } catch {
      throw new AppError('not_found', '페이지를 찾을 수 없습니다.');
    }
    const headers = {
      ...SECURITY_HEADERS,
      'Content-Type': STATIC_TYPES[extname(real).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': info.size,
      'Cache-Control': 'no-cache',
      'Last-Modified': info.mtime.toUTCString(),
    };
    const since = Date.parse(req.headers['if-modified-since'] ?? '');
    if (Number.isFinite(since) && Math.floor(info.mtimeMs / 1000) * 1000 <= since) {
      delete headers['Content-Length'];
      res.writeHead(304, headers);
      res.end();
      return;
    }
    res.writeHead(200, headers);
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    pipeline(createReadStream(real), res, () => {});
  }

  // ------------------------------------------------------------ router

  function methodNotAllowed(allow) {
    const error = new AppError('bad_request', '허용되지 않는 요청 방식입니다.', 405);
    error.allow = allow;
    return error;
  }

  async function route(req, res) {
    // Only the path matters. It is taken literally (no URL resolution), so "//host/x" or
    // "/a/../b" can never be reinterpreted as something else before the checks below.
    const pathname = (req.url ?? '/').split('?')[0];
    if (!pathname.startsWith('/')) throw new AppError('bad_request');
    const method = req.method ?? 'GET';

    if (pathname.startsWith('/api/')) {
      if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') assertSameSite(req);
      if (pathname === '/api/config') {
        if (method !== 'GET') throw methodNotAllowed('GET');
        return handleConfig(res);
      }
      if (pathname === '/api/status') {
        if (method !== 'GET') throw methodNotAllowed('GET');
        return handleStatus(req, res);
      }
      if (pathname === '/api/info') {
        if (method !== 'POST') throw methodNotAllowed('POST');
        return handleInfo(req, res);
      }
      if (pathname === '/api/jobs') {
        if (method !== 'POST') throw methodNotAllowed('POST');
        return handleCreateJob(req, res);
      }
      const match = /^\/api\/jobs\/([^/]+)(\/file)?$/.exec(pathname);
      if (match) {
        const id = match[1];
        if (!UUID_RE.test(id)) throw new AppError('not_found');
        if (match[2]) {
          if (method !== 'GET') throw methodNotAllowed('GET');
          return handleFile(req, res, id);
        }
        if (method === 'GET') return sendJson(res, 200, jobs.view(jobs.get(id)));
        if (method === 'DELETE') {
          await jobs.cancel(id);
          res.writeHead(204, { ...SECURITY_HEADERS, 'Cache-Control': 'no-store' });
          return res.end();
        }
        throw methodNotAllowed('GET, DELETE');
      }
      throw new AppError('not_found');
    }

    if (method !== 'GET' && method !== 'HEAD') throw methodNotAllowed('GET, HEAD');
    return handleStatic(req, res, pathname);
  }

  function handler(req, res) {
    route(req, res).catch((error) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (error instanceof AppError && error.allow) res.setHeader('Allow', error.allow);
      // A rejected body may still be arriving; do not keep the connection for it.
      if (error instanceof AppError && error.status === 413) res.setHeader('Connection', 'close');
      sendError(res, error);
    });
  }

  const server = createServer(handler);
  server.headersTimeout = 15_000;
  server.requestTimeout = 30_000;

  /** Synchronous core of every exit path: no new children, kill the running ones, remove temp dirs. */
  function closeSync() {
    jobs.stop();
    infoSlots.close();
    ytdlp.shutdown();
    tempDirs.removeAllSync();
  }

  let closing = null;
  /** Graceful shutdown: stop accepting work, kill child process trees, remove temp dirs. */
  function close() {
    closing ??= (async () => {
      jobs.stop();
      infoSlots.close(); // lookups still waiting for a slot must not start a child any more
      ytdlp.shutdown();
      await new Promise((done) => {
        server.close(() => done());
        server.closeAllConnections?.();
      });
      // Give killed children a moment to release their files, then remove everything we own.
      const deadline = Date.now() + 3000;
      while (ytdlp.running > 0 && Date.now() < deadline) {
        ytdlp.shutdown();
        await new Promise((r) => setTimeout(r, 25));
      }
      tempDirs.removeAllSync();
      egress?.close();
    })();
    return closing;
  }

  return { server, handler, close, closeSync, jobs, tempDirs, ytdlp, egress };
}
