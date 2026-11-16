// Reads every setting from an env-like object exactly once. Other modules take
// the resulting plain object and never look at process.env themselves.

function int(env, name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`환경 변수 ${name} 값이 올바르지 않습니다: ${JSON.stringify(raw)} (${min}~${max} 사이의 정수)`);
  }
  return value;
}

function list(raw) {
  return String(raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** TRUST_PROXY: number of reverse proxies in front of the app ("0" = none, "1" = one, ...). */
function proxyHops(env) {
  const raw = env.TRUST_PROXY;
  if (raw === undefined || raw === '') return 0;
  return int(env, 'TRUST_PROXY', 0, { min: 0, max: 10 });
}

/**
 * yt-dlp needs a JavaScript runtime for YouTube. The server itself runs on Node, so that
 * binary is the default; "auto" leaves the choice to yt-dlp.
 */
function jsRuntimes(env, execPath) {
  const raw = (env.YTDLP_JS_RUNTIMES ?? '').trim();
  if (raw === '') return execPath ? [`node:${execPath}`] : [];
  if (raw === 'auto') return [];
  return list(raw);
}

export function loadConfig(env = process.env, { execPath = process.execPath } = {}) {
  const jobTtlSeconds = int(env, 'JOB_TTL_SECONDS', 900);
  const maxFileMB = int(env, 'MAX_FILE_MB', 500);
  const maxStoredMB = int(env, 'MAX_STORED_MB', Math.max(3000, maxFileMB * 2));
  if (maxStoredMB < maxFileMB) {
    throw new Error(`환경 변수 MAX_STORED_MB(${maxStoredMB})는 MAX_FILE_MB(${maxFileMB}) 이상이어야 합니다.`);
  }
  return Object.freeze({
    siteName: (env.SITE_NAME ?? '').trim() || '모아받기',
    port: int(env, 'PORT', 3000, { min: 0, max: 65535 }),
    host: (env.HOST ?? '').trim() || '0.0.0.0',
    // Client IP = the entry this many places from the right of X-Forwarded-For (0 = ignore the header).
    trustedProxyHops: proxyHops(env),
    ytdlpPath: (env.YTDLP_PATH ?? '').trim() || 'yt-dlp',
    // Passed to yt-dlp as --js-runtimes (e.g. "node" or "deno:/usr/bin/deno"). Empty = yt-dlp default.
    ytdlpJsRuntimes: Object.freeze(jsRuntimes(env, execPath)),
    // Built-in SSRF guard for everything yt-dlp fetches (see egressGuard.js).
    egressGuard: env.EGRESS_GUARD !== '0',
    upstreamProxy: Object.freeze({
      http: (env.HTTP_PROXY ?? env.http_proxy ?? '').trim() || null,
      https: (env.HTTPS_PROXY ?? env.https_proxy ?? '').trim() || null,
    }),
    extraAllowedHosts: Object.freeze(list(env.EXTRA_ALLOWED_HOSTS)),
    maxBatch: int(env, 'MAX_BATCH', 20),
    maxHeight: int(env, 'MAX_HEIGHT', 1080, { min: 144 }),
    maxFileMB,
    // Disk budget for finished files plus the worst case of the running downloads.
    maxStoredMB,
    // After a complete send the file stays this long so an interrupted browser save can retry.
    deliveredGraceSeconds: int(env, 'DELIVERED_GRACE_SECONDS', 60, { min: 0 }),
    // A file response slower than this on average is cut off (slow readers pin disk space).
    fileMinKBps: int(env, 'FILE_MIN_KBPS', 64),
    maxStreamsPerJob: 2,
    dailyPerIp: int(env, 'DAILY_PER_IP', 50),
    maxConcurrent: int(env, 'MAX_CONCURRENT', 3),
    maxQueued: int(env, 'MAX_QUEUED', 100),
    jobTtlSeconds,
    infoConcurrency: int(env, 'INFO_CONCURRENCY', 2),
    infoMaxWaiting: int(env, 'INFO_MAX_WAITING', 40, { min: 0 }),
    infoCacheSeconds: int(env, 'INFO_CACHE_SECONDS', 300, { min: 0 }),
    infoPerMinute: int(env, 'INFO_PER_MINUTE', 60),
    // One client may hold at most this many lookups (running or waiting) at a time.
    infoPerIpConcurrent: int(env, 'INFO_PER_IP_CONCURRENT', 4),
    infoTimeoutSeconds: int(env, 'INFO_TIMEOUT_SECONDS', 45),
    downloadTimeoutSeconds: int(env, 'DOWNLOAD_TIMEOUT_SECONDS', 1200),
    socketTimeoutSeconds: int(env, 'SOCKET_TIMEOUT_SECONDS', 20),
    maxBodyBytes: 8 * 1024,
    debug: env.DEBUG === '1',
  });
}
