// Single owner of "which URLs may be handed to yt-dlp" and of platform detection.
// Everything downstream works with the normalized URL string returned here.

import { isIP } from 'node:net';
import { AppError } from './errors.js';

export const MAX_URL_LENGTH = 2048;

export const PLATFORMS = Object.freeze([
  Object.freeze({ id: 'youtube', name: 'YouTube', domains: ['youtube.com', 'youtu.be', 'youtube-nocookie.com'] }),
  Object.freeze({ id: 'instagram', name: 'Instagram', domains: ['instagram.com'] }),
  // yt-dlp has no dedicated Threads extractor; links go through its generic one and often fail.
  Object.freeze({ id: 'threads', name: 'Threads', domains: ['threads.net', 'threads.com'], experimental: true }),
  Object.freeze({ id: 'facebook', name: 'Facebook', domains: ['facebook.com', 'fb.watch'] }),
]);

// Query parameters that only carry share/tracking state and never select content.
const TRACKING_PARAMS = new Set(['si', 'feature', 'pp', 'igsh', 'igshid', 'fbclid', 'mibextid', 'xmt']);

function matchPlatform(host) {
  for (const platform of PLATFORMS) {
    for (const domain of platform.domains) {
      // Exact domain or a real subdomain (label boundary) – never a bare suffix.
      if (host === domain || host.endsWith(`.${domain}`)) return platform.id;
    }
  }
  return null;
}

/**
 * Share short links (fb.watch/…, facebook.com/share/…, instagram.com/share/…) carry no content
 * id; they only redirect to the real post, so they need redirect-following downstream.
 */
function isShortlink(platform, url) {
  if (platform === 'facebook') return url.hostname === 'fb.watch' || url.pathname.startsWith('/share/');
  if (platform === 'instagram') return url.pathname.startsWith('/share/');
  return false;
}

function parseExtraHosts(entries) {
  const out = [];
  for (const entry of entries) {
    let parsed;
    try {
      parsed = new URL(`http://${entry}`);
    } catch {
      throw new Error(`EXTRA_ALLOWED_HOSTS 항목이 올바르지 않습니다: ${entry}`);
    }
    if (parsed.pathname !== '/' || parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error(`EXTRA_ALLOWED_HOSTS 항목은 host 또는 host:port 형식이어야 합니다: ${entry}`);
    }
    // Explicit port in the entry (":80" is kept apart from "no port").
    const explicitPort = /:(\d+)$/.exec(entry.replace(/^\[.*\]/, ''))?.[1] ?? null;
    out.push({ hostname: parsed.hostname, port: explicitPort === null ? null : String(Number(explicitPort)) });
  }
  return out;
}

function effectivePort(url) {
  if (url.port !== '') return url.port;
  return url.protocol === 'https:' ? '443' : '80';
}

export function createUrlPolicy({ extraAllowedHosts = [] } = {}) {
  const extras = parseExtraHosts(extraAllowedHosts);

  function matchExtra(url) {
    return extras.some((extra) => {
      if (extra.hostname !== url.hostname) return false;
      if (extra.port === null) return url.port === '';
      return extra.port === effectivePort(url);
    });
  }

  /**
   * @param {unknown} raw
   * @returns {{ url: string, platform: string, shortlink: boolean }}
   * @throws {AppError} invalid_url | unsupported_site
   */
  function check(raw) {
    if (typeof raw !== 'string') throw new AppError('invalid_url');
    const text = raw.trim();
    if (text === '' || text.length > MAX_URL_LENGTH) throw new AppError('invalid_url');
    // Control characters / whitespace are silently stripped by the URL parser; refuse them instead.
    if (/[\u0000-\u0020\u007f]/.test(text)) throw new AppError('invalid_url');

    let url;
    try {
      url = new URL(text);
    } catch {
      throw new AppError('invalid_url');
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new AppError('invalid_url');
    if (url.username !== '' || url.password !== '') {
      throw new AppError('invalid_url', '아이디나 비밀번호가 들어 있는 링크는 사용할 수 없습니다.');
    }

    const host = url.hostname; // already lower-cased / IDNA-normalized by the parser
    if (host === '' || host.endsWith('.')) throw new AppError('invalid_url');

    const extra = matchExtra(url);
    if (!extra) {
      // The parser has already canonicalized exotic IPv4 spellings (0x7f.1, 2130706433 ...).
      if (host.startsWith('[') || isIP(host) !== 0) {
        throw new AppError('invalid_url', 'IP 주소로 된 링크는 사용할 수 없습니다.');
      }
      if (url.protocol !== 'https:') {
        throw new AppError('invalid_url', 'https:// 로 시작하는 링크만 사용할 수 있습니다.');
      }
      if (url.port !== '') throw new AppError('unsupported_site');
    }

    const platform = extra ? 'other' : matchPlatform(host);
    if (platform === null) throw new AppError('unsupported_site');

    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (TRACKING_PARAMS.has(key) || key.startsWith('utm_')) url.searchParams.delete(key);
    }
    const normalized = url.toString();
    if (normalized.length > MAX_URL_LENGTH) throw new AppError('invalid_url');
    return { url: normalized, platform, shortlink: isShortlink(platform, url) };
  }

  /**
   * Whether the operator explicitly allowed this network endpoint (EXTRA_ALLOWED_HOSTS).
   * An entry without a port covers the default web ports only.
   */
  function allowsExtraEndpoint(hostname, port) {
    return extras.some((extra) => extra.hostname === hostname && (extra.port === null ? port === 80 || port === 443 : extra.port === String(port)));
  }

  return {
    check,
    allowsExtraEndpoint,
    /** Canonical "host" / "host:port" strings of EXTRA_ALLOWED_HOSTS, for the page's pre-check. */
    extraHosts: () => extras.map((extra) => (extra.port === null ? extra.hostname : `${extra.hostname}:${extra.port}`)),
  };
}

export function publicPlatforms() {
  return PLATFORMS.map(({ id, name, experimental = false }) => ({ id, name, experimental }));
}
