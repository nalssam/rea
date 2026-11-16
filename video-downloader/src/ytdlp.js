// Owner of everything yt-dlp: argv construction, process supervision, and the
// interpretation of its output. No other module parses yt-dlp text or JSON.

import { spawn } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { AppError } from './errors.js';

const PREFIX = 'MOA|';
const MAX_INFO_BYTES = 16 * 1024 * 1024;
const MAX_LINE_CHARS = 64 * 1024;
const MAX_TITLE_CHARS = 300;
const TOO_LARGE_RE = /^\[download\] File is larger than max-filesize \(\d+ bytes > \d+ bytes\)\. Aborting\.$/;
const FILTERED_RE = /^\[download\] .* does not pass filter \(!is_live\), skipping \.\.$/;

// ---------------------------------------------------------------- argv

// Which yt-dlp extractors may handle a link. Dedicated extractors only talk to their own
// site; the generic one fetches whatever a page redirects to or embeds, so it is enabled
// only where nothing else can work (share short links, Threads, operator-added hosts).
const EXTRACTORS = Object.freeze({
  youtube: 'youtube.*',
  instagram: 'instagram.*',
  facebook: 'facebook.*',
  threads: 'generic', // yt-dlp has no Threads extractor (as of 2026.10)
  other: null, // EXTRA_ALLOWED_HOSTS: operator's choice, all extractors
});

/** @returns {string|null} value for --use-extractors, or null for yt-dlp's default set */
export function extractorSpec({ platform, shortlink = false }) {
  if (!Object.hasOwn(EXTRACTORS, platform)) throw new TypeError(`unknown platform: ${platform}`);
  const base = EXTRACTORS[platform];
  if (base === null || base === 'generic') return base;
  return shortlink ? `${base},generic` : base;
}

function commonArgs(config, target, proxyUrl) {
  const extractors = extractorSpec(target);
  const args = [
    '--ignore-config',
    '--no-plugin-dirs',
    '--no-remote-components',
    '--no-cache-dir',
    '--no-cookies',
    '--no-cookies-from-browser',
    '--no-exec',
    '--no-playlist',
    '--playlist-items', '1',
    '--color', 'never',
    '--socket-timeout', String(config.socketTimeoutSeconds),
    '--retries', '3',
    '--fragment-retries', '3',
    '--extractor-retries', '2',
  ];
  if (extractors !== null) args.push('--use-extractors', extractors);
  // All traffic of the child goes through the egress guard (see egressGuard.js).
  if (proxyUrl) args.push('--proxy', proxyUrl);
  if (config.ytdlpJsRuntimes.length > 0) {
    args.push('--no-js-runtimes');
    for (const runtime of config.ytdlpJsRuntimes) args.push('--js-runtimes', runtime);
  }
  return args;
}

/** @param {{url: string, platform: string, shortlink?: boolean}} target facts from urlPolicy.check() */
export function buildInfoArgs(config, target, proxyUrl = null) {
  return [...commonArgs(config, target, proxyUrl), '--no-warnings', '--dump-single-json', '--', target.url];
}

export function effectiveHeight(config, requested) {
  return Number.isInteger(requested) && requested > 0 ? Math.min(requested, config.maxHeight) : config.maxHeight;
}

/**
 * The quality cap ("1080p") limits the SHORT side: height for landscape, width for portrait
 * (a 1080x1920 Reel is 1080p). yt-dlp filters cannot say "or", so every preference tier is
 * listed once per orientation; a video's formats share one orientation, so only one matches.
 */
export function videoFormatSelector(cap) {
  const landscape = `[aspect_ratio>=?1][height<=${cap}]`; // unknown ratio counts as landscape
  const portrait = `[aspect_ratio<1][width<=${cap}]`;
  const landscapeLoose = `[aspect_ratio>=?1][height<=?${cap}]`; // also accepts an unknown height
  const tiers = [
    (f) => `bv*${f}[vcodec^=avc1]+ba[acodec^=mp4a]`, // H.264 + AAC: plays everywhere
    (f) => `b${f}[vcodec^=avc1][acodec^=mp4a]`,
    (f) => `bv*${f}[ext=mp4]+ba[ext=m4a]`,
    (f) => `b${f}[ext=mp4]`,
  ];
  return [
    ...tiers.flatMap((tier) => [tier(landscape), tier(portrait)]),
    `bv*${landscapeLoose}+ba`,
    `bv*${portrait}+ba`,
    `b${landscapeLoose}`,
    `b${portrait}`,
  ].join('/');
}

/** The "p" number of a format: its short side when both sides are known, else its height. */
function qualityOf(format) {
  const { width, height } = format;
  if (!Number.isInteger(height) || height <= 0) return null;
  return Number.isInteger(width) && width > 0 ? Math.min(width, height) : height;
}

export function buildDownloadArgs(config, { url, platform, shortlink, format, height, dir }, proxyUrl = null) {
  const args = [
    ...commonArgs(config, { platform, shortlink }, proxyUrl),
    '--abort-on-error',
    '--no-mtime',
    '--match-filters', '!is_live',
    '--max-filesize', `${config.maxFileMB}M`,
    '--newline',
    '--progress-template', `download:${PREFIX}dl|%(progress.status)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s`,
    '--progress-template', `postprocess:${PREFIX}pp|%(progress.status)s|%(progress.postprocessor)s`,
    '--print', `before_dl:${PREFIX}meta|%(.{title,format_id})j`,
    '--print', `after_move:${PREFIX}file|%(filepath)j`,
    '--no-simulate',
    '--no-quiet',
    '--paths', dir,
    '--output', 'media.%(ext)s',
  ];
  if (format === 'audio') {
    args.push('--format', 'ba/b', '--extract-audio', '--audio-format', 'mp3', '--audio-quality', '2');
  } else {
    args.push(
      '--format', videoFormatSelector(effectiveHeight(config, height)),
      '--merge-output-format', 'mp4',
      '--remux-video', 'mp4',
    );
  }
  args.push('--', url);
  return args;
}

// ---------------------------------------------------------------- output parsing

function num(text) {
  if (text === undefined || text === 'NA' || text === '') return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

/** Interprets one stdout line of a download run. Returns null for lines we do not own. */
export function parseDownloadLine(line) {
  if (!line.startsWith(PREFIX)) {
    // yt-dlp's own notices, matched on their fixed frame only: remote text (titles) can appear
    // inside a line but never controls how it starts and ends.
    if (TOO_LARGE_RE.test(line)) return { type: 'too_large' };
    if (FILTERED_RE.test(line)) return { type: 'filtered' };
    return null;
  }
  const rest = line.slice(PREFIX.length);
  const bar = rest.indexOf('|');
  if (bar < 0) return null;
  const kind = rest.slice(0, bar);
  const payload = rest.slice(bar + 1);
  try {
    if (kind === 'dl') {
      const [status, downloaded, total, estimate] = payload.split('|');
      return { type: 'dl', status, downloaded: num(downloaded), total: num(total) ?? num(estimate) };
    }
    if (kind === 'pp') {
      const [status, name] = payload.split('|');
      return { type: 'pp', status, name: name ?? '' };
    }
    if (kind === 'meta') {
      const meta = JSON.parse(payload);
      const formatId = typeof meta.format_id === 'string' ? meta.format_id : '';
      return {
        type: 'meta',
        title: typeof meta.title === 'string' ? meta.title : null,
        parts: Math.max(1, formatId.split('+').length),
      };
    }
    if (kind === 'file') {
      const path = JSON.parse(payload);
      return typeof path === 'string' ? { type: 'file', path } : null;
    }
  } catch {
    return null;
  }
  return null;
}

/** Folds parsed download events into the job-facing status/progress. */
export function createProgressTracker() {
  const state = { status: 'downloading', progress: null, title: null, filePath: null, tooLarge: false, filtered: false, bytes: 0 };
  let parts = 1;
  let partsDone = 0;
  let bytesDone = 0;
  let current = 0;

  return {
    state,
    feed(event) {
      if (!event) return;
      switch (event.type) {
        case 'meta':
          state.title = event.title;
          parts = event.parts;
          break;
        case 'dl': {
          if (event.status === 'finished') {
            partsDone += 1;
            bytesDone += event.downloaded ?? current;
            current = 0;
          } else if (event.downloaded !== null) {
            current = event.downloaded;
          }
          state.bytes = bytesDone + current;
          parts = Math.max(parts, partsDone);
          const fraction = event.status === 'finished' || !event.total ? 0 : Math.min(1, (event.downloaded ?? 0) / event.total);
          const known = event.status === 'finished' || Boolean(event.total);
          if (known) {
            const pct = ((Math.min(partsDone, parts) + fraction) / parts) * 100;
            state.progress = Math.max(state.progress ?? 0, Math.min(99, Math.floor(pct)));
          }
          state.status = 'downloading';
          break;
        }
        case 'pp':
          // MoveFiles runs for every download; only real conversions count as "processing".
          if (event.status === 'started' && event.name !== 'MoveFiles') state.status = 'processing';
          break;
        case 'file':
          state.filePath = event.path;
          break;
        case 'too_large':
          state.tooLarge = true;
          break;
        case 'filtered':
          state.filtered = true;
          break;
      }
    },
  };
}

function clip(text, max) {
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : text;
}

/** Converts yt-dlp's --dump-single-json document into the /api/info facts. */
export function parseInfo(doc, maxHeight) {
  if (doc === null || typeof doc !== 'object') throw new AppError('extract_failed');
  let entry = doc;
  if (Array.isArray(doc.entries)) {
    entry = doc.entries.find((e) => e && typeof e === 'object');
    if (!entry) throw new AppError('extract_failed', '링크에서 받을 수 있는 영상을 찾지 못했습니다.');
  }
  if (entry.is_live === true) {
    throw new AppError('extract_failed', '실시간 방송은 받을 수 없습니다. 방송이 끝난 뒤 다시 시도해 주세요.');
  }
  const formats = Array.isArray(entry.formats) ? entry.formats : [];
  const heights = new Set();
  for (const f of formats) {
    if (!f || typeof f !== 'object' || f.vcodec === 'none') continue;
    const quality = qualityOf(f);
    if (quality !== null && quality <= maxHeight) heights.add(quality);
  }
  if (heights.size === 0) {
    const quality = qualityOf(entry);
    if (quality !== null && quality <= maxHeight) heights.add(quality);
  }
  const title = typeof entry.title === 'string' && entry.title.trim() !== '' ? entry.title.trim() : '제목 없음';
  const uploaderRaw = [entry.uploader, entry.channel, entry.uploader_id].find((v) => typeof v === 'string' && v.trim() !== '');
  const thumbnail = typeof entry.thumbnail === 'string' && /^https:\/\//i.test(entry.thumbnail) && entry.thumbnail.length <= 2048 ? entry.thumbnail : null;
  return {
    title: clip(title, MAX_TITLE_CHARS),
    uploader: uploaderRaw ? clip(uploaderRaw.trim(), 100) : '',
    durationSeconds: Number.isFinite(entry.duration) && entry.duration >= 0 ? Math.round(entry.duration) : null,
    thumbnail,
    heights: [...heights].sort((a, b) => b - a),
    audio: true,
  };
}

/** Maps a failed run to a user-facing error. Raw yt-dlp text never reaches the client. */
export function classifyFailure({ errorLines = [], timedOut = false, spawnError = null, tooLarge = false, filtered = false, platform = null }) {
  if (tooLarge) return new AppError('too_large');
  if (spawnError) return new AppError('extract_failed', '서버의 다운로드 도구를 실행하지 못했습니다. 관리자에게 문의해 주세요.', 500);
  if (timedOut) return new AppError('extract_failed', '시간이 너무 오래 걸려 중단했습니다. 잠시 후 다시 시도해 주세요.', 504);
  if (filtered) return new AppError('extract_failed', '실시간 방송은 받을 수 없습니다. 방송이 끝난 뒤 다시 시도해 주세요.');
  const text = errorLines.join('\n');
  if (/not a bot|too many requests|HTTP Error 429|rate[- ]limit/i.test(text)) {
    return new AppError('extract_failed', '해당 사이트가 이 서버의 요청을 일시적으로 차단했습니다(봇 확인). 잠시 후 다시 시도해 주세요.', 503);
  }
  if (/Unable to connect|Tunnel connection failed|timed out|Connection (reset|refused)|Name or service not known|getaddrinfo/i.test(text)) {
    return new AppError('extract_failed', '서버가 해당 사이트에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.', 504);
  }
  if (/private|log ?in|sign in|cookies|members[- ]only|age[- ]restricted|confirm your age/i.test(text)) {
    return new AppError('extract_failed', '비공개이거나 로그인이 필요한 콘텐츠라서 받을 수 없습니다.');
  }
  if (/Unsupported URL|No suitable extractor|no video|No media|There is no video/i.test(text)) {
    if (platform === 'threads') {
      return new AppError('extract_failed', 'Threads는 아직 시험 지원 단계라서 이 게시물의 영상을 찾지 못했습니다. 영상이 Instagram에도 올라와 있다면 그 링크를 사용해 보세요.');
    }
    return new AppError('extract_failed', '이 링크에서는 받을 수 있는 영상을 찾지 못했습니다.');
  }
  if (/unavailable|removed|deleted|does not exist|HTTP Error 404|not found/i.test(text)) {
    return new AppError('extract_failed', '영상을 찾을 수 없습니다. 삭제되었거나 주소가 바뀌었을 수 있습니다.');
  }
  if (/Requested format is not available/i.test(text)) {
    return new AppError('extract_failed', '선택한 형식으로는 받을 수 없습니다. 다른 화질을 선택해 보세요.');
  }
  return new AppError('extract_failed');
}

// ---------------------------------------------------------------- process supervision

function lineSplitter(onLine) {
  let buffer = '';
  return (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      // yt-dlp redraws status lines with a carriage return ("\r[download] ..."); like a
      // terminal, keep only what follows the last one.
      const raw = buffer.slice(0, index).replace(/\r$/, '');
      onLine(raw.slice(raw.lastIndexOf('\r') + 1));
      buffer = buffer.slice(index + 1);
    }
    if (buffer.length > MAX_LINE_CHARS) buffer = ''; // never let one endless line grow without bound
  };
}

/**
 * @param {object} config
 * @param {object} [deps]
 * @param {() => Promise<string|null>} [deps.proxyUrl] egress guard address handed to every child
 */
export function createYtdlp(config, { proxyUrl = async () => null } = {}) {
  const children = new Set();
  let closed = false;

  function killTree(child) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    try {
      process.kill(-child.pid, 'SIGKILL'); // the child leads its own process group (detached)
    } catch {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }
  }

  /**
   * Runs yt-dlp without a shell. Resolves (never rejects) once the process has closed.
   */
  function run(args, { timeoutMs, onStdout, onStderrLine }) {
    // After shutdown() nothing may be spawned any more: late callers (e.g. lookups that were
    // waiting for a slot) get a canceled outcome instead of an orphan process.
    if (closed) return { done: Promise.resolve({ code: null, timedOut: false, canceled: true, spawnError: null }), cancel() {} };
    let child;
    try {
      child = spawn(config.ytdlpPath, args, {
        shell: false,
        detached: true,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      return { done: Promise.resolve({ code: null, timedOut: false, canceled: false, spawnError: error }), cancel() {} };
    }
    children.add(child);
    let timedOut = false;
    let canceled = false;
    let spawnError = null;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', onStdout);
    child.stderr.on('data', lineSplitter(onStderrLine));

    const done = new Promise((resolvePromise) => {
      child.on('error', (error) => {
        spawnError = error;
        if (child.pid === undefined) finish(null);
      });
      child.on('close', (code) => finish(code));
      let finished = false;
      function finish(code) {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        children.delete(child);
        resolvePromise({ code, timedOut, canceled, spawnError });
      }
    });

    return {
      done,
      cancel() {
        canceled = true;
        killTree(child);
      },
    };
  }

  function errorCollector() {
    const lines = [];
    return {
      lines,
      push(line) {
        if (!line.startsWith('ERROR')) return;
        lines.push(line.slice(0, 500));
        if (lines.length > 5) lines.shift();
      },
    };
  }

  function debug(kind, errors) {
    if (config.debug && errors.lines.length > 0) console.error(`[yt-dlp ${kind}] ${errors.lines.at(-1)}`);
  }

  /** @returns {Promise<ReturnType<typeof parseInfo>>} */
  async function fetchInfo(target, { signal = null } = {}) {
    const errors = errorCollector();
    let json = '';
    let overflow = false;
    const proxy = await proxyUrl();
    if (signal?.aborted) throw new AppError('extract_failed', '취소되었습니다.');
    const proc = run(buildInfoArgs(config, target, proxy), {
      timeoutMs: config.infoTimeoutSeconds * 1000,
      onStdout(chunk) {
        if (overflow) return;
        json += chunk;
        if (json.length > MAX_INFO_BYTES) {
          overflow = true;
          json = '';
          proc.cancel();
        }
      },
      onStderrLine: errors.push,
    });
    const onAbort = () => proc.cancel();
    signal?.addEventListener('abort', onAbort, { once: true });
    const outcome = await proc.done;
    signal?.removeEventListener('abort', onAbort);
    if (outcome.canceled && !overflow) throw new AppError('extract_failed', '취소되었습니다.');
    if (outcome.code !== 0 || overflow) {
      debug('info', errors);
      throw classifyFailure({ errorLines: errors.lines, timedOut: outcome.timedOut, spawnError: outcome.spawnError, platform: target.platform });
    }
    let doc;
    try {
      doc = JSON.parse(json);
    } catch {
      throw new AppError('extract_failed');
    }
    return parseInfo(doc, config.maxHeight);
  }

  async function locateOutput(dir, reported) {
    const root = resolve(dir);
    const candidates = [];
    if (reported && dirname(resolve(reported)) === root) candidates.push(resolve(reported));
    if (candidates.length === 0) {
      const names = (await readdir(root)).filter((n) => n.startsWith('media.') && !/\.(part|ytdl|tmp)$/i.test(n));
      if (names.length === 1) candidates.push(join(root, names[0]));
    }
    for (const path of candidates) {
      try {
        const info = await stat(path);
        if (info.isFile() && info.size > 0) return { path, size: info.size };
      } catch {
        /* try the next candidate */
      }
    }
    return null;
  }

  /**
   * Starts a download into `dir`. `result` settles only after the process tree has exited,
   * so the caller may delete `dir` as soon as it settles.
   * @returns {{ result: Promise<{ filePath: string, sizeBytes: number, title: string|null, ext: string }>, cancel(): void }}
   */
  function startDownload({ url, platform, shortlink = false, format, height, dir }, { onUpdate = () => {} } = {}) {
    const maxBytes = config.maxFileMB * 1024 * 1024;
    const errors = errorCollector();
    const tracker = createProgressTracker();
    let proc = null;
    let canceled = false;

    const result = (async () => {
      const proxy = await proxyUrl();
      if (canceled) throw new AppError('extract_failed', '취소되었습니다.');
      proc = run(buildDownloadArgs(config, { url, platform, shortlink, format, height, dir }, proxy), {
        timeoutMs: config.downloadTimeoutSeconds * 1000,
        onStdout: lineSplitter((line) => {
          const event = parseDownloadLine(line);
          if (!event) return;
          tracker.feed(event);
          // --max-filesize only helps when the size is announced up front; enforce it on actual bytes too.
          if (tracker.state.bytes > maxBytes && !tracker.state.tooLarge) {
            tracker.state.tooLarge = true;
            proc.cancel();
          }
          onUpdate({ status: tracker.state.status, progress: tracker.state.progress });
        }),
        onStderrLine: errors.push,
      });
      const outcome = await proc.done;
      const state = tracker.state;
      if (outcome.canceled && !state.tooLarge) throw new AppError('extract_failed', '취소되었습니다.');
      if (outcome.code !== 0 || state.tooLarge || outcome.spawnError) {
        debug('download', errors);
        throw classifyFailure({ errorLines: errors.lines, timedOut: outcome.timedOut, spawnError: outcome.spawnError, tooLarge: state.tooLarge, filtered: state.filtered, platform });
      }
      const output = await locateOutput(dir, state.filePath);
      if (!output) throw classifyFailure({ errorLines: errors.lines, filtered: state.filtered, platform });
      if (output.size > maxBytes) throw new AppError('too_large');
      return {
        filePath: output.path,
        sizeBytes: output.size,
        title: state.title,
        ext: extname(output.path).slice(1).toLowerCase(),
      };
    })();

    return {
      result,
      cancel() {
        canceled = true;
        proc?.cancel();
      },
    };
  }

  return {
    fetchInfo,
    startDownload,
    /** Final: kills every process tree and refuses to start new ones. Safe to call repeatedly. */
    shutdown() {
      closed = true;
      for (const child of children) killTree(child);
    },
    get running() {
      return children.size;
    },
  };
}
