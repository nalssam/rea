/* 모아받기 frontend — vanilla JS, no dependencies.
 *
 * Sections:
 *   1. Theme bootstrap (runs immediately, before first paint)
 *   2. Pure logic (no DOM): URL extraction, normalization, dedup key, host check,
 *      height selection, formatting. Exposed on globalThis.MoaLogic for tests.
 *   3. API client
 *   4. App state + rendering + behaviour (runs on DOMContentLoaded)
 */
'use strict';

/* ───────────────────────── 1. Theme bootstrap ───────────────────────── */

const THEME_KEY = 'moa.theme';
const FORMAT_KEY = 'moa.format';
const LIST_KEY = 'moa.list';

function storageGet(key) {
  try { return window.localStorage.getItem(key); } catch { return null; }
}
function storageSet(key, value) {
  try { window.localStorage.setItem(key, value); } catch { /* private mode etc. */ }
}

// The link list survives an accidental reload (this tab only).
function sessionGet(key) {
  try { return window.sessionStorage.getItem(key); } catch { return null; }
}
function sessionSet(key, value) {
  try { window.sessionStorage.setItem(key, value); } catch { /* private mode etc. */ }
}

if (typeof document !== 'undefined') {
  const stored = storageGet(THEME_KEY);
  if (stored === 'light' || stored === 'dark') {
    document.documentElement.setAttribute('data-theme', stored);
  }
}

/* ───────────────────────── 2. Pure logic ───────────────────────── */

const PLATFORMS = [
  { id: 'youtube', name: 'YouTube', hosts: ['youtube.com', 'youtu.be', 'youtube-nocookie.com'] },
  { id: 'instagram', name: 'Instagram', hosts: ['instagram.com'] },
  { id: 'threads', name: 'Threads', hosts: ['threads.net', 'threads.com'], experimental: true },
  { id: 'facebook', name: 'Facebook', hosts: ['facebook.com', 'fb.watch'] },
];

const TRACKING_PARAMS = new Set([
  'si', 'feature', 'igshid', 'igsh', 'fbclid', 'mibextid', 'ref', 'share', 'pp', 'app',
  'xmt', 'slof', 'rdid', 'share_url', 'img_index',
]);

/** Pull every http(s) URL out of free-form pasted text. Order preserved, raw strings. */
function extractUrls(text) {
  if (typeof text !== 'string' || !text) return [];
  const out = [];
  // Split so that URLs glued together ("https://a…https://b") or comma-joined are separated.
  const pieces = text.split(/(?=https?:\/\/)/i);
  for (const piece of pieces) {
    const m = /^https?:\/\/[^\s<>"'`\\^{}|]+/i.exec(piece);
    if (!m) continue;
    const cleaned = trimUrlTail(m[0]);
    if (cleaned.length > 'https://'.length) out.push(cleaned);
  }
  return out;
}

/**
 * Remove what belongs to the surrounding sentence, not the URL: punctuation, and Korean
 * particles/words glued to the link without a space ("https://youtu.be/ID이랑").
 * Hangul inside a URL (followed by more URL characters) is left alone.
 */
function trimUrlTail(url) {
  let s = url;
  for (;;) {
    const hangulTail = /[\u1100-\u11FF\u3131-\u318E\uAC00-\uD7A3]+$/.exec(s);
    if (hangulTail) { s = s.slice(0, hangulTail.index); continue; }
    const last = s[s.length - 1];
    if (/[.,;:!?'"*~…»”’、。，]/.test(last)) { s = s.slice(0, -1); continue; }
    if (last === ')' && count(s, '(') < count(s, ')')) { s = s.slice(0, -1); continue; }
    if (last === ']' && count(s, '[') < count(s, ']')) { s = s.slice(0, -1); continue; }
    if (last === '>') { s = s.slice(0, -1); continue; }
    return s;
  }
}
function count(s, ch) {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s[i] === ch) n++;
  return n;
}

function isIpLiteral(hostname) {
  return hostname.startsWith('[') || /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || /^0x[0-9a-f]+$/i.test(hostname) || /^\d+$/.test(hostname);
}

/** Platform id for a hostname, or null. Exact host or true subdomain only. */
function detectPlatform(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/\.$/, '');
  for (const p of PLATFORMS) {
    for (const base of p.hosts) {
      if (host === base || host.endsWith('.' + base)) return p.id;
    }
  }
  return null;
}

function platformName(id) {
  const p = PLATFORMS.find((x) => x.id === id);
  return p ? p.name : '영상';
}

/**
 * Client-side mirror of the server URL policy (the server stays authoritative).
 * extraHosts: optional list of "host" or "host:port" strings additionally allowed.
 * Returns { ok:true, url, key, platform } or { ok:false, reason:'invalid'|'unsupported'|'too_long' }.
 */
function normalizeUrl(raw, extraHosts) {
  const text = String(raw || '').trim();
  if (!text) return { ok: false, reason: 'invalid' };
  if (text.length > 2048) return { ok: false, reason: 'too_long' };
  let u;
  try { u = new URL(text); } catch { return { ok: false, reason: 'invalid' }; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { ok: false, reason: 'invalid' };
  if (u.username || u.password) return { ok: false, reason: 'invalid' };
  if (!u.hostname) return { ok: false, reason: 'invalid' };

  // Entries are "host" (default web port) or "host:port", exactly as the server reports them.
  const extras = Array.isArray(extraHosts) ? extraHosts.map((h) => String(h).toLowerCase()) : [];
  const port = u.port || (u.protocol === 'https:' ? '443' : '80');
  const isExtra = extras.includes(u.hostname + ':' + port) || (!u.port && extras.includes(u.hostname));
  let platform = null;
  if (!isIpLiteral(u.hostname)) platform = detectPlatform(u.hostname);
  if (!platform && !isExtra) return { ok: false, reason: 'unsupported' };
  if (platform && !isExtra) {
    if (u.port) return { ok: false, reason: 'unsupported' };
    u.protocol = 'https:'; // known sites are always reachable over https
  }
  u.hash = '';
  return { ok: true, url: u.href, key: dedupKey(u, platform), platform: platform || 'other' };
}

/** Stable identity for "the same video" so re-pasting a link in another shape is a duplicate. */
function dedupKey(u, platform) {
  const host = u.hostname.toLowerCase().replace(/^(www|m|mobile|web|music)\./, '');
  const path = u.pathname.replace(/\/+$/, '');
  if (platform === 'youtube') {
    let id = null;
    if (host === 'youtu.be') id = path.split('/')[1] || null;
    else if (path === '/watch') id = u.searchParams.get('v');
    else {
      const m = /^\/(shorts|embed|live|v)\/([^/]+)/.exec(path);
      if (m) id = m[2];
    }
    if (id) return 'youtube:' + id; // `list`, `index`, `t` only describe how the video was reached
  }
  const params = [];
  for (const [k, v] of u.searchParams) {
    const lk = k.toLowerCase();
    if (lk.startsWith('utm_') || TRACKING_PARAMS.has(lk)) continue;
    // No video id was found above (playlist, channel …): `list` is what identifies the content.
    if (platform === 'youtube' && (lk === 't' || lk === 'start')) continue;
    params.push(k + '=' + v);
  }
  params.sort();
  const base = platform === 'threads' ? 'threads' : platform === 'facebook' && host === 'facebook.com' ? 'facebook.com' : host;
  return base + (u.port ? ':' + u.port : '') + path + (params.length ? '?' + params.join('&') : '');
}

/**
 * Nearest available height not above the wanted one.
 * wanted: number or 'best'. Falls back to the smallest available when all are above.
 * Returns null when no heights are known.
 */
function pickHeight(heights, wanted) {
  const list = (Array.isArray(heights) ? heights : [])
    .filter((h) => Number.isInteger(h) && h > 0)
    .sort((a, b) => b - a);
  if (!list.length) return null;
  if (wanted === 'best' || wanted == null) return list[0];
  const want = Number(wanted);
  if (!Number.isFinite(want)) return list[0];
  for (const h of list) if (h <= want) return h;
  return list[list.length - 1];
}

/** Map a global choice ('best' | number | 'audio') onto what one video offers. */
function resolveChoice(heights, globalChoice) {
  if (globalChoice === 'audio') return { format: 'audio', height: null };
  return { format: 'video', height: pickHeight(heights, globalChoice) };
}

function choiceToValue(choice) {
  if (choice.format === 'audio') return 'a';
  return choice.height ? 'v:' + choice.height : 'v:best';
}
function valueToChoice(value) {
  if (value === 'a') return { format: 'audio', height: null };
  const h = Number(String(value).slice(2));
  return { format: 'video', height: Number.isInteger(h) && h > 0 ? h : null };
}

function formatDuration(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return '';
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  if (h > 0) return h + ':' + String(m).padStart(2, '0') + ':' + ss;
  return m + ':' + ss;
}

function formatBytes(bytes) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return bytes + 'B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(bytes < 10240 ? 1 : 0) + 'KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / 1048576).toFixed(bytes < 10485760 ? 1 : 0) + 'MB';
  return (bytes / 1073741824).toFixed(2) + 'GB';
}

function formatTtl(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return '–';
  if (seconds < 90) return Math.round(seconds) + '초';
  if (seconds < 5400) return Math.round(seconds / 60) + '분';
  return Math.round(seconds / 3600) + '시간';
}

/** Short, human-readable form of a URL for display. */
function displayUrl(url) {
  try {
    const u = new URL(url);
    const tail = (u.pathname === '/' ? '' : u.pathname) + u.search;
    return u.host.replace(/^www\./, '') + (tail.length > 34 ? tail.slice(0, 33) + '…' : tail);
  } catch {
    return String(url).slice(0, 60);
  }
}

function httpsOrNull(url) {
  if (typeof url !== 'string') return null;
  try { return new URL(url).protocol === 'https:' ? url : null; } catch { return null; }
}

globalThis.MoaLogic = {
  extractUrls, trimUrlTail, normalizeUrl, dedupKey, detectPlatform, pickHeight, resolveChoice,
  choiceToValue, valueToChoice, formatDuration, formatBytes, formatTtl, displayUrl, httpsOrNull,
};

/* ───────────────────────── 3. API client ───────────────────────── */

/** Always resolves: { ok, status, data } or { ok:false, status, code, message }. */
async function api(method, path, body) {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
      credentials: 'same-origin',
    });
  } catch {
    return { ok: false, status: 0, code: 'network', message: '서버에 연결하지 못했어요. 잠시 후 다시 시도해 주세요.' };
  }
  let data = null;
  if (res.status !== 204) {
    try { data = await res.json(); } catch { data = null; }
  }
  if (res.ok) return { ok: true, status: res.status, data };
  const err = data && data.error && typeof data.error === 'object' ? data.error : {};
  return {
    ok: false,
    status: res.status,
    code: typeof err.code === 'string' ? err.code : 'http_' + res.status,
    message: typeof err.message === 'string' && err.message ? err.message : '요청을 처리하지 못했어요. (' + res.status + ')',
  };
}

/* ───────────────────────── 4. App ───────────────────────── */

const INFO_CONCURRENCY = 3;
const CREATE_CONCURRENCY = 2;
const POLL_MS = 1000;
const POLL_MAX_MS = 8000;
const SAVE_STAGGER_MS = 800;
const IN_FLIGHT = new Set(['creating', 'queued', 'downloading', 'processing']);
const STARTABLE = new Set(['idle', 'failed', 'canceled']);

function startApp() {
  const $ = (id) => document.getElementById(id);
  const el = {
    composer: $('composer'), input: $('composer-input'), feedback: $('composer-feedback'),
    rejected: $('rejected'), rejectedList: $('rejected-list'), rejectedCount: $('rejected-count'), rejectedClear: $('rejected-clear'),
    cards: $('cards'), empty: $('empty'), listCount: $('list-count'), summary: $('summary'),
    globalFormat: $('global-format'), clearAll: $('clear-all'), cancelAll: $('cancel-all'),
    downloadAll: $('download-all'), downloadAllLabel: $('download-all-label'),
    themeToggle: $('theme-toggle'), themeLabel: $('theme-toggle-label'),
    stActive: $('st-active'), stMax: $('st-max'), stQueued: $('st-queued'), stToday: $('st-today'), stDaily: $('st-daily'),
    stActiveBar: $('st-active-bar'), stTodayBar: $('st-today-bar'), statusNote: $('status-note'), liveDot: $('live-dot'),
    lmBatch: $('lm-batch'), lmHeight: $('lm-height'), lmSize: $('lm-size'), lmDaily: $('lm-daily'), lmTtl: $('lm-ttl'),
    platforms: $('platforms'),
  };

  const announcer = document.createElement('p');
  announcer.className = 'sr-only';
  announcer.setAttribute('role', 'status');
  announcer.setAttribute('aria-live', 'polite');
  document.body.appendChild(announcer);
  function announce(text) { announcer.textContent = text; }

  const state = {
    config: {
      siteName: '모아받기',
      platforms: PLATFORMS.map((p) => ({ id: p.id, name: p.name, experimental: p.experimental === true })),
      limits: { maxBatch: 20, maxHeight: 1080, maxFileMB: 500, dailyPerIp: 50, maxConcurrent: 3, jobTtlSeconds: 900 },
      extraHosts: [],
    },
    items: [],          // cards, in display order
    rejected: [],       // { text, reason }
    globalChoice: 'best',
    seq: 0,
    infoActive: 0,
    createActive: 0,
    createQueue: [],
    saveQueue: [],
    saving: false,
  };

  /* ── small DOM helpers ── */
  function h(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const ICONS = {
    x: 'M6 6l12 12M18 6 6 18',
    down: 'M12 4v11m0 0-4.500-4.500M12 15l4.500-4.500M5 19.500h14',
    retry: 'M19 12a7 7 0 1 1-2.200-5.100M19 4.500v4h-4',
    stop: 'M7.500 7.500h9v9h-9z',
    check: 'M5 12.500l4.500 4.500L19 7.500',
    film: 'M4 6.500h16v11H4zM10 9.800v4.400l3.800-2.200z',
  };
  function icon(name) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    svg.setAttribute('class', 'ico');
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', ICONS[name]);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '2');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(path);
    return svg;
  }
  function setButton(btn, iconName, label) {
    btn.replaceChildren(icon(iconName), h('span', null, label));
  }

  /* ── theme ── */
  function currentTheme() {
    const forced = document.documentElement.getAttribute('data-theme');
    if (forced === 'light' || forced === 'dark') return forced;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  function syncThemeToggle() {
    const dark = currentTheme() === 'dark';
    el.themeToggle.setAttribute('aria-pressed', String(dark));
    el.themeLabel.textContent = dark ? '밝은 화면' : '어두운 화면';
    el.themeToggle.setAttribute('aria-label', dark ? '밝은 화면으로 바꾸기' : '어두운 화면으로 바꾸기');
  }
  el.themeToggle.addEventListener('click', () => {
    const next = currentTheme() === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    storageSet(THEME_KEY, next);
    syncThemeToggle();
  });
  if (window.matchMedia) {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    if (mq.addEventListener) mq.addEventListener('change', syncThemeToggle);
  }
  syncThemeToggle();

  /* ── config + limits panel ── */
  function applyConfig() {
    const { siteName, limits, platforms } = state.config;
    for (const node of document.querySelectorAll('[data-site-name]')) node.textContent = siteName;
    document.title = siteName + ' — 여러 영상 링크를 모아 한 번에 저장';
    el.lmBatch.textContent = limits.maxBatch + '개';
    el.lmHeight.textContent = limits.maxHeight + 'p';
    el.lmSize.textContent = limits.maxFileMB >= 1024 ? (limits.maxFileMB / 1024).toFixed(1).replace(/\.0$/, '') + 'GB까지' : limits.maxFileMB + 'MB까지';
    el.lmDaily.textContent = limits.dailyPerIp + '회';
    el.lmTtl.textContent = formatTtl(limits.jobTtlSeconds);
    el.stMax.textContent = String(limits.maxConcurrent);
    el.stDaily.textContent = String(limits.dailyPerIp);
    el.platforms.replaceChildren(...platforms.map((p) => {
      const li = h('li', 'badge', p.experimental ? p.name + ' · 시험 지원' : p.name);
      if (p.experimental) li.title = p.name + ' 링크는 아직 안정적으로 받아지지 않을 수 있어요.';
      li.dataset.platform = p.id;
      return li;
    }));
    buildGlobalFormat();
  }

  function buildGlobalFormat() {
    const max = state.config.limits.maxHeight;
    const options = [['best', '최고 화질']];
    for (const hgt of [2160, 1440, 1080, 720, 480, 360]) if (hgt <= max) options.push([String(hgt), hgt + 'p']);
    options.push(['audio', 'MP3 (음원)']);
    el.globalFormat.replaceChildren(...options.map(([value, label]) => {
      const o = h('option', null, label);
      o.value = value;
      return o;
    }));
    const stored = storageGet(FORMAT_KEY);
    if (stored && options.some(([v]) => v === stored)) state.globalChoice = stored === 'best' || stored === 'audio' ? stored : Number(stored);
    el.globalFormat.value = String(state.globalChoice);
    if (el.globalFormat.selectedIndex < 0) { el.globalFormat.selectedIndex = 0; state.globalChoice = 'best'; }
  }

  el.globalFormat.addEventListener('change', () => {
    const v = el.globalFormat.value;
    state.globalChoice = v === 'best' || v === 'audio' ? v : Number(v);
    storageSet(FORMAT_KEY, v);
    for (const item of state.items) {
      if (!item.info || IN_FLIGHT.has(item.phase)) continue;
      item.choice = resolveChoice(item.info.heights, state.globalChoice);
      renderCard(item);
    }
  });

  /* ── status panel ── */
  let statusTimer = null;
  let statusFailures = 0;
  async function refreshStatus() {
    clearTimeout(statusTimer);
    if (!document.hidden) {
      const r = await api('GET', '/api/status');
      if (r.ok && r.data) {
        statusFailures = 0;
        const s = r.data;
        const max = Number(s.maxConcurrent) || state.config.limits.maxConcurrent;
        const daily = Number(s.dailyPerIp) || state.config.limits.dailyPerIp;
        el.stActive.textContent = String(s.active ?? 0);
        el.stMax.textContent = String(max);
        el.stQueued.textContent = String(s.queued ?? 0);
        el.stToday.textContent = String(s.ipToday ?? 0);
        el.stDaily.textContent = String(daily);
        el.stActiveBar.style.width = Math.min(100, ((s.active || 0) / max) * 100) + '%';
        el.stTodayBar.style.width = Math.min(100, ((s.ipToday || 0) / daily) * 100) + '%';
        const left = Math.max(0, daily - (s.ipToday || 0));
        el.statusNote.textContent = left === 0 ? '오늘 횟수를 모두 사용했어요. 자정(한국 시간)에 초기화됩니다.' : '오늘 ' + left + '회 더 받을 수 있어요.';
        el.liveDot.dataset.state = (s.active || 0) > 0 ? 'busy' : 'ok';
      } else {
        statusFailures++;
        el.liveDot.dataset.state = 'down';
        el.statusNote.textContent = '상태를 불러오지 못했어요.';
      }
    }
    const busy = state.items.some((i) => IN_FLIGHT.has(i.phase));
    const base = busy ? 2000 : 5000;
    statusTimer = setTimeout(refreshStatus, Math.min(30000, base * Math.pow(2, Math.min(statusFailures, 3))));
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshStatus(); });

  /* ── composer: paste / Enter / 추가 ── */
  const REASONS = {
    invalid: '올바른 링크가 아니에요',
    too_long: '링크가 너무 길어요',
    unsupported: '지원하지 않는 사이트예요',
  };

  function addFromText(text) {
    const urls = extractUrls(text);
    if (!urls.length) {
      setFeedback(text.trim() ? '링크를 찾지 못했어요. http(s)로 시작하는 주소를 붙여넣어 주세요.' : '', 'warn');
      return 0;
    }
    const max = state.config.limits.maxBatch;
    let added = 0, dup = 0, rejected = 0, firstDup = null;
    const seen = new Set(state.items.map((i) => i.key));
    for (const raw of urls) {
      const n = normalizeUrl(raw, state.config.extraHosts);
      if (!n.ok) { pushRejected(raw, REASONS[n.reason] || REASONS.invalid); rejected++; continue; }
      if (seen.has(n.key)) {
        dup++;
        if (!firstDup) firstDup = state.items.find((i) => i.key === n.key) || null;
        continue;
      }
      if (state.items.length >= max) {
        pushRejected(raw, '한 번에 최대 ' + max + '개까지 모을 수 있어요');
        rejected++;
        continue;
      }
      seen.add(n.key);
      addItem(n);
      added++;
    }
    const parts = [];
    if (added) parts.push(added + '개를 목록에 추가했어요');
    if (dup) parts.push('이미 있는 링크 ' + dup + '개는 건너뛰었어요');
    if (rejected) parts.push(rejected + '개는 추가하지 못했어요');
    setFeedback(parts.join(' · '), rejected || (!added && dup) ? 'warn' : 'ok');
    if (firstDup) flashCard(firstDup);
    renderRejected();
    renderChrome();
    pumpInfo();
    return added;
  }

  function setFeedback(text, tone) {
    el.feedback.textContent = text;
    el.feedback.dataset.tone = tone || 'ok';
  }

  function pushRejected(text, reason) {
    if (state.rejected.some((r) => r.text === text)) return;
    state.rejected.unshift({ text, reason });
    if (state.rejected.length > 30) state.rejected.length = 30;
  }

  function renderRejected() {
    el.rejected.hidden = state.rejected.length === 0;
    el.rejectedCount.textContent = state.rejected.length ? String(state.rejected.length) : '';
    el.rejectedList.replaceChildren(...state.rejected.map((r) => {
      const li = h('li', 'rejected-item');
      const url = h('span', 'rejected-url', r.text);
      url.title = r.text;
      const reason = h('span', 'rejected-reason', r.reason);
      const close = h('button', 'icon-btn icon-btn-sm');
      close.type = 'button';
      close.setAttribute('aria-label', '이 항목 지우기');
      close.appendChild(icon('x'));
      close.addEventListener('click', () => {
        state.rejected = state.rejected.filter((x) => x !== r);
        renderRejected();
      });
      li.append(url, reason, close);
      return li;
    }));
  }
  el.rejectedClear.addEventListener('click', () => { state.rejected = []; renderRejected(); el.input.focus(); });

  function submitComposer() {
    const text = el.input.value;
    const hadUrls = extractUrls(text).length > 0;
    addFromText(text);
    if (hadUrls) el.input.value = '';
    el.input.focus();
  }
  el.composer.addEventListener('submit', (e) => { e.preventDefault(); submitComposer(); });
  el.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submitComposer(); }
  });
  el.input.addEventListener('paste', (e) => {
    const pasted = e.clipboardData ? e.clipboardData.getData('text') : '';
    if (!pasted || !extractUrls(pasted).length) return; // let plain text land in the box
    e.preventDefault();
    // Links already typed into the box are taken along; any other typed text (a half-typed
    // address, a note) stays where it is.
    const existing = el.input.value;
    if (extractUrls(existing).length) {
      el.input.value = '';
      addFromText(existing + '\n' + pasted);
    } else {
      addFromText(pasted);
    }
    el.input.focus();
  });
  // Dropping a link onto the box behaves like a paste.
  el.input.addEventListener('drop', (e) => {
    const text = e.dataTransfer ? (e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text')) : '';
    if (!text || !extractUrls(text).length) return;
    e.preventDefault();
    addFromText(text);
    el.input.focus();
  });

  /* ── items ── */
  function persistList() {
    sessionSet(LIST_KEY, JSON.stringify(state.items.map((i) => ({ url: i.url, done: i.phase === 'saved' }))));
  }

  /** After a reload: bring the cards back. Jobs are not resumed; finished ones stay marked. */
  function restoreList() {
    let saved;
    try { saved = JSON.parse(sessionGet(LIST_KEY) || '[]'); } catch { saved = []; }
    if (!Array.isArray(saved) || !saved.length || state.items.length) return;
    const seen = new Set();
    for (const entry of saved.slice(0, state.config.limits.maxBatch)) {
      if (!entry || typeof entry.url !== 'string') continue;
      const n = normalizeUrl(entry.url, state.config.extraHosts);
      if (!n.ok || seen.has(n.key)) continue;
      seen.add(n.key);
      addItem(n, { restoredDone: entry.done === true });
    }
    if (state.items.length) {
      setFeedback('이전에 모아 둔 링크 ' + state.items.length + '개를 다시 불러왔어요.', 'ok');
      renderChrome();
      pumpInfo();
    }
  }

  function addItem(n, options) {
    const item = {
      uid: ++state.seq,
      url: n.url, key: n.key, platform: n.platform,
      phase: 'waiting',      // waiting|analyzing|infoError|idle|creating|queued|downloading|processing|saving|saved|failed|canceled
      info: null,
      choice: null,
      message: '',
      job: null,             // { id, progress, queuePosition, filename, sizeBytes }
      attempted: false,
      restoredDone: Boolean(options && options.restoredDone),
      removed: false,
      cancelRequested: false,
      runToken: 0,
      dom: null,
    };
    state.items.push(item);
    item.dom = buildCard(item);
    el.cards.appendChild(item.dom.root);
    renderCard(item);
    persistList();
  }

  function removeItem(item) {
    item.removed = true;
    item.runToken++;
    // Also drop a finished file nobody will fetch: it would keep one of this visitor's slots.
    if (item.job && (IN_FLIGHT.has(item.phase) || item.phase === 'saving')) api('DELETE', '/api/jobs/' + encodeURIComponent(item.job.id));
    state.createQueue = state.createQueue.filter((i) => i !== item);
    state.saveQueue = state.saveQueue.filter((i) => i !== item);
    state.items = state.items.filter((i) => i !== item);
    item.dom.root.remove();
    persistList();
    renderChrome();
    pumpInfo();
  }

  function flashCard(item) {
    const root = item.dom.root;
    root.classList.remove('flash');
    void root.offsetWidth;
    root.classList.add('flash');
    if (root.scrollIntoView) root.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  /* ── analysis (POST /api/info), bounded concurrency ── */
  function pumpInfo() {
    while (state.infoActive < INFO_CONCURRENCY) {
      const item = state.items.find((i) => i.phase === 'waiting');
      if (!item) return;
      runInfo(item);
    }
  }

  async function runInfo(item) {
    state.infoActive++;
    item.phase = 'analyzing';
    item.message = '';
    renderCard(item);
    const r = await api('POST', '/api/info', { url: item.url });
    state.infoActive--;
    if (!item.removed) {
      if (r.ok && r.data) {
        const d = r.data;
        item.info = {
          url: typeof d.url === 'string' && d.url ? d.url : item.url,
          platform: typeof d.platform === 'string' ? d.platform : item.platform,
          title: typeof d.title === 'string' && d.title.trim() ? d.title.trim() : '제목 없는 영상',
          uploader: typeof d.uploader === 'string' ? d.uploader.trim() : '',
          durationSeconds: typeof d.durationSeconds === 'number' ? d.durationSeconds : null,
          thumbnail: httpsOrNull(d.thumbnail),
          heights: (Array.isArray(d.heights) ? d.heights : []).filter((x) => Number.isInteger(x) && x > 0).sort((a, b) => b - a),
        };
        item.platform = item.info.platform;
        item.choice = resolveChoice(item.info.heights, state.globalChoice);
        if (item.restoredDone) {
          // Saved before the reload: keep it out of "모두 받기" (it can still be fetched again).
          item.restoredDone = false;
          item.attempted = true;
          item.phase = 'saved';
        } else {
          item.phase = 'idle';
        }
      } else {
        item.phase = 'infoError';
        item.message = r.message;
      }
      renderCard(item);
      renderChrome();
    }
    pumpInfo();
  }

  /* ── jobs ── */
  function startJob(item) {
    if (!item.info || !STARTABLE.has(item.phase) && item.phase !== 'saved' && item.phase !== 'saving') return;
    item.runToken++;
    item.phase = 'creating';
    item.message = '';
    item.job = null;
    item.jobChoice = choiceToValue(item.choice);
    item.attempted = true;
    item.cancelRequested = false;
    state.saveQueue = state.saveQueue.filter((i) => i !== item);
    if (!state.createQueue.includes(item)) state.createQueue.push(item);
    renderCard(item);
    renderChrome();
    pumpCreate();
  }

  function pumpCreate() {
    while (state.createActive < CREATE_CONCURRENCY && state.createQueue.length) {
      const item = state.createQueue.shift();
      if (item.removed || item.phase !== 'creating') continue;
      createJob(item);
    }
  }

  async function createJob(item) {
    state.createActive++;
    const token = item.runToken;
    const body = { url: item.info.url, format: item.choice.format };
    if (item.choice.format === 'video' && item.choice.height) body.height = item.choice.height;
    const r = await api('POST', '/api/jobs', body);
    state.createActive--;
    pumpCreate();
    if (r.ok && r.data && typeof r.data.id === 'string') {
      // The card may have been removed or canceled while the request was in the air.
      if (item.removed || token !== item.runToken || item.cancelRequested) {
        api('DELETE', '/api/jobs/' + encodeURIComponent(r.data.id));
        return;
      }
      item.job = { id: r.data.id, progress: null, queuePosition: null, filename: null, sizeBytes: null };
      item.phase = 'queued';
      renderCard(item);
      renderChrome();
      schedulePoll(item, token, 300, 0);
      refreshStatus();
    } else if (!item.removed && token === item.runToken) {
      fail(item, r.message);
    }
  }

  function fail(item, message) {
    item.phase = 'failed';
    item.message = message || '다운로드하지 못했어요.';
    renderCard(item);
    renderChrome();
    announce('실패: ' + (item.info ? item.info.title : item.url));
  }

  function schedulePoll(item, token, delay, failures) {
    setTimeout(() => pollJob(item, token, failures), delay);
  }

  async function pollJob(item, token, failures) {
    if (item.removed || token !== item.runToken || !item.job || !IN_FLIGHT.has(item.phase)) return;
    const r = await api('GET', '/api/jobs/' + encodeURIComponent(item.job.id));
    if (item.removed || token !== item.runToken || !IN_FLIGHT.has(item.phase)) return;
    if (!r.ok) {
      if (r.code === 'not_found' || r.status === 404) { fail(item, '작업을 찾을 수 없어요. 다시 받아 주세요.'); return; }
      const n = failures + 1;
      if (n >= 8) { fail(item, r.message); return; }
      item.message = '연결이 불안정해요. 다시 확인하는 중…';
      renderCard(item);
      schedulePoll(item, token, Math.min(POLL_MAX_MS, POLL_MS * Math.pow(1.7, n)), n);
      return;
    }
    const j = r.data || {};
    item.message = '';
    item.job.progress = typeof j.progress === 'number' ? Math.max(0, Math.min(100, j.progress)) : null;
    item.job.queuePosition = typeof j.queuePosition === 'number' ? j.queuePosition : null;
    item.job.filename = typeof j.filename === 'string' ? j.filename : null;
    item.job.sizeBytes = typeof j.sizeBytes === 'number' ? j.sizeBytes : null;
    switch (j.status) {
      case 'queued': case 'downloading': case 'processing':
        item.phase = j.status;
        renderCard(item);
        schedulePoll(item, token, POLL_MS, 0);
        return;
      case 'ready':
        item.phase = 'saving';
        renderCard(item);
        renderChrome();
        state.saveQueue.push(item);
        pumpSave();
        return;
      case 'canceled':
        item.phase = 'canceled';
        renderCard(item);
        renderChrome();
        return;
      case 'expired':
        fail(item, '보관 시간이 지나 파일이 지워졌어요. 다시 받아 주세요.');
        return;
      default: {
        const e = j.error;
        fail(item, typeof e === 'string' ? e : e && typeof e.message === 'string' ? e.message : '');
      }
    }
  }

  /* ── saving: one browser download at a time, staggered ── */
  async function pumpSave() {
    if (state.saving) return;
    state.saving = true;
    while (state.saveQueue.length) {
      const item = state.saveQueue.shift();
      if (item.removed || item.phase !== 'saving') continue;
      triggerSave(item);
      await new Promise((resolve) => setTimeout(resolve, SAVE_STAGGER_MS));
    }
    state.saving = false;
  }

  function fileHref(item) {
    return '/api/jobs/' + encodeURIComponent(item.job.id) + '/file';
  }

  function triggerSave(item) {
    const a = document.createElement('a');
    a.href = fileHref(item);
    a.download = item.job.filename || '';
    a.rel = 'noopener';
    a.hidden = true;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => a.remove(), 2000);
    item.phase = 'saved';
    persistList();
    renderCard(item);
    renderChrome();
    announce('저장 완료: ' + (item.info ? item.info.title : ''));
    refreshStatus();
  }

  /** Manual "저장": the server deletes a file once sent, so check before pointing the browser at it. */
  async function manualSave(item) {
    if (item.phase === 'saving') {
      state.saveQueue = state.saveQueue.filter((i) => i !== item);
      triggerSave(item);
      return;
    }
    if (!item.job) { startJob(item); return; } // restored after a reload: nothing on the server
    const token = item.runToken;
    item.dom.main.disabled = true;
    const r = await api('GET', '/api/jobs/' + encodeURIComponent(item.job.id));
    if (item.removed || token !== item.runToken) return;
    item.dom.main.disabled = false;
    if (r.ok && r.data && r.data.status === 'ready') triggerSave(item);
    else startJob(item); // already sent/expired → fetch it again
  }

  function cancelItem(item) {
    if (!IN_FLIGHT.has(item.phase)) return;
    item.cancelRequested = true;
    item.runToken++;
    state.createQueue = state.createQueue.filter((i) => i !== item);
    if (item.job) api('DELETE', '/api/jobs/' + encodeURIComponent(item.job.id)).then(refreshStatus);
    item.phase = 'canceled';
    item.message = '';
    renderCard(item);
    renderChrome();
  }

  /* ── card DOM ── */
  function buildCard(item) {
    const root = h('li', 'card');
    const thumb = h('div', 'card-thumb');
    const ph = h('div', 'thumb-ph');
    ph.appendChild(icon('film'));
    const dur = h('span', 'thumb-dur');
    dur.hidden = true;
    thumb.append(ph, dur);

    const body = h('div', 'card-body');
    const top = h('div', 'card-top');
    const badge = h('span', 'badge');
    const link = h('span', 'card-link', displayUrl(item.url));
    link.title = item.url;
    top.append(badge, link);
    const title = h('h3', 'card-title');
    const meta = h('p', 'card-meta');
    const statusRow = h('div', 'card-status');
    const statusText = h('span', 'status-text');
    const progress = h('div', 'progress');
    progress.setAttribute('role', 'progressbar');
    progress.setAttribute('aria-valuemin', '0');
    progress.setAttribute('aria-valuemax', '100');
    const bar = h('span', 'progress-bar');
    progress.appendChild(bar);
    statusRow.append(statusText, progress);
    body.append(top, title, meta, statusRow);

    const actions = h('div', 'card-actions');
    const selectId = 'fmt-' + item.uid;
    const label = h('label', 'sr-only', '저장 형식');
    label.htmlFor = selectId;
    const select = h('select', 'select select-sm');
    select.id = selectId;
    select.addEventListener('change', () => {
      item.choice = valueToChoice(select.value);
      // A finished card holds the file of its previous format; another format needs a new download.
      if ((item.phase === 'saved' || item.phase === 'saving') && item.jobChoice !== select.value) {
        if (item.job) api('DELETE', '/api/jobs/' + encodeURIComponent(item.job.id));
        state.saveQueue = state.saveQueue.filter((i) => i !== item);
        item.runToken++;
        item.job = null;
        item.message = '';
        item.phase = 'idle';
        persistList();
      }
      renderCard(item);
      renderChrome();
    });
    const main = h('button', 'btn btn-sm card-main');
    main.type = 'button';
    main.addEventListener('click', () => onMain(item));
    const save = h('a', 'btn btn-sm btn-save');
    save.hidden = true;
    save.setAttribute('role', 'button');
    save.addEventListener('keydown', (e) => {
      if (e.key === ' ' || e.key === 'Spacebar') { e.preventDefault(); manualSave(item); }
    });
    save.addEventListener('click', (e) => { e.preventDefault(); manualSave(item); });
    const remove = h('button', 'icon-btn icon-btn-sm card-remove');
    remove.type = 'button';
    remove.appendChild(icon('x'));
    remove.addEventListener('click', () => {
      const next = root.nextElementSibling || root.previousElementSibling;
      removeItem(item);
      const target = next && next.querySelector('.card-remove');
      (target || el.input).focus();
    });
    actions.append(label, select, main, save, remove);

    root.append(thumb, body, actions);
    return { root, thumb, ph, dur, badge, title, meta, statusText, progress, bar, select, main, save, remove, img: null, optionsKey: null };
  }

  function onMain(item) {
    switch (item.phase) {
      case 'infoError':
        item.phase = 'waiting';
        renderCard(item);
        pumpInfo();
        break;
      case 'idle': case 'failed': case 'canceled':
        startJob(item);
        break;
      case 'creating': case 'queued': case 'downloading': case 'processing':
        cancelItem(item);
        break;
      default:
    }
  }

  function statusFor(item) {
    const job = item.job;
    switch (item.phase) {
      case 'waiting': return '분석 대기 중';
      case 'analyzing': return '영상 정보 확인 중…';
      case 'infoError': return item.message || '영상 정보를 가져오지 못했어요.';
      case 'idle': return '';
      case 'creating': return '요청 중…';
      case 'queued':
        if (item.message) return item.message;
        return job && job.queuePosition != null ? '대기 중 ' + job.queuePosition + '번째' : '대기 중';
      case 'downloading':
        if (item.message) return item.message;
        return job && job.progress != null ? '다운로드 중 ' + Math.round(job.progress) + '%' : '다운로드 중';
      case 'processing': return item.message || '변환 중';
      case 'saving': return '저장 준비됨';
      case 'saved': {
        const size = job ? formatBytes(job.sizeBytes) : '';
        return '저장 완료' + (size ? ' · ' + size : '');
      }
      case 'failed': return '실패 · ' + (item.message || '다운로드하지 못했어요.');
      case 'canceled': return '취소됨';
      default: return '';
    }
  }

  function renderCard(item) {
    const d = item.dom;
    const info = item.info;
    const phase = item.phase;
    const inFlight = IN_FLIGHT.has(phase);
    d.root.dataset.state = phase;
    d.root.setAttribute('aria-busy', String(phase === 'analyzing' || phase === 'waiting' || inFlight));

    d.badge.textContent = platformName(item.platform);
    d.badge.dataset.platform = item.platform;

    // title / meta (skeleton until analyzed)
    if (info) {
      d.title.textContent = info.title;
      d.title.title = info.title;
      d.title.classList.remove('skeleton');
      const bits = [];
      if (info.uploader) bits.push(info.uploader);
      if (item.choice) bits.push(item.choice.format === 'audio' ? 'MP3' : 'MP4' + (item.choice.height ? ' ' + item.choice.height + 'p' : ''));
      d.meta.textContent = bits.join(' · ');
      d.meta.classList.remove('skeleton');
    } else if (phase === 'infoError') {
      d.title.textContent = '정보를 확인하지 못한 링크';
      d.title.classList.remove('skeleton');
      d.meta.textContent = '';
      d.meta.classList.remove('skeleton');
    } else {
      d.title.textContent = '';
      d.title.classList.add('skeleton');
      d.meta.textContent = '';
      d.meta.classList.add('skeleton');
    }

    // thumbnail
    d.thumb.classList.toggle('skeleton', !info && phase !== 'infoError');
    if (info && info.thumbnail && !d.img) {
      const img = document.createElement('img');
      img.alt = '';
      img.decoding = 'async';
      img.loading = 'lazy';
      img.referrerPolicy = 'no-referrer';
      img.addEventListener('error', () => { img.remove(); d.thumb.classList.remove('has-img'); });
      img.addEventListener('load', () => d.thumb.classList.add('has-img'));
      img.src = info.thumbnail;
      d.thumb.insertBefore(img, d.ph);
      d.img = img;
    }
    const dur = info ? formatDuration(info.durationSeconds) : '';
    d.dur.textContent = dur;
    d.dur.hidden = !dur;

    // status + progress
    const text = statusFor(item);
    d.statusText.textContent = text;
    const showBar = inFlight || phase === 'saving' || phase === 'saved';
    d.progress.hidden = !showBar;
    let pct = null;
    if (phase === 'downloading' && item.job && item.job.progress != null) pct = item.job.progress;
    else if (phase === 'saving' || phase === 'saved') pct = 100;
    d.progress.classList.toggle('indeterminate', showBar && pct == null);
    d.bar.style.width = pct == null ? '' : pct + '%';
    if (pct == null) d.progress.removeAttribute('aria-valuenow');
    else d.progress.setAttribute('aria-valuenow', String(Math.round(pct)));
    d.progress.setAttribute('aria-label', text || '진행 상태');

    // format select
    if (info) {
      const key = info.heights.join(',');
      if (d.optionsKey !== key) {
        const opts = info.heights.length
          ? info.heights.map((hgt) => ['v:' + hgt, 'MP4 · ' + hgt + 'p'])
          : [['v:best', 'MP4 · 최고 화질']];
        opts.push(['a', 'MP3 · 음원']);
        d.select.replaceChildren(...opts.map(([value, label]) => {
          const o = h('option', null, label);
          o.value = value;
          return o;
        }));
        d.optionsKey = key;
      }
      d.select.value = choiceToValue(item.choice);
    }
    d.select.hidden = !info;
    d.select.disabled = inFlight;

    // main action
    const titleForLabel = info ? info.title : displayUrl(item.url);
    // "받기/취소" and "저장" are two elements that take turns; keyboard focus must follow the swap.
    const active = document.activeElement;
    const hadFocus = active === d.main || active === d.save;
    d.main.hidden = false;
    d.save.hidden = true;
    d.main.disabled = false;
    d.main.className = 'btn btn-sm card-main';
    switch (phase) {
      case 'waiting': case 'analyzing':
        setButton(d.main, 'down', '받기');
        d.main.disabled = true;
        break;
      case 'infoError':
        setButton(d.main, 'retry', '다시 시도');
        break;
      case 'idle':
        setButton(d.main, 'down', '받기');
        d.main.classList.add('btn-ink');
        break;
      case 'creating': case 'queued': case 'downloading': case 'processing':
        setButton(d.main, 'stop', '취소');
        break;
      case 'failed': case 'canceled':
        setButton(d.main, 'retry', '다시 받기');
        break;
      case 'saving': case 'saved':
        d.main.hidden = true;
        d.save.hidden = false;
        if (item.job) d.save.href = fileHref(item);
        else d.save.href = '#';
        d.save.replaceChildren(icon('down'), h('span', null, phase === 'saved' ? '다시 저장' : '저장'));
        d.save.classList.toggle('btn-ink', phase === 'saving');
        d.save.setAttribute('aria-label', titleForLabel + ' 저장');
        break;
      default:
    }
    if (hadFocus) {
      const visible = d.main.hidden ? d.save : d.main;
      if (document.activeElement !== visible) visible.focus({ preventScroll: true });
    }
    d.main.setAttribute('aria-label', d.main.textContent + ': ' + titleForLabel);
    d.remove.setAttribute('aria-label', '목록에서 빼기: ' + titleForLabel);
    d.remove.title = '목록에서 빼기';
  }

  /* ── toolbar / summary ── */
  function renderChrome() {
    const items = state.items;
    const startable = items.filter((i) => i.info && STARTABLE.has(i.phase)).length;
    const inFlight = items.filter((i) => IN_FLIGHT.has(i.phase)).length;
    el.listCount.textContent = String(items.length);
    el.empty.hidden = items.length > 0;
    el.cards.hidden = items.length === 0;
    el.downloadAllLabel.textContent = '모두 받기 (' + startable + ')';
    el.downloadAll.disabled = startable === 0;
    el.clearAll.disabled = items.length === 0;
    el.cancelAll.hidden = inFlight === 0;

    const attempted = items.filter((i) => i.attempted);
    if (!attempted.length) {
      el.summary.textContent = '';
    } else {
      const done = attempted.filter((i) => i.phase === 'saved').length;
      const failed = attempted.filter((i) => i.phase === 'failed').length;
      const canceled = attempted.filter((i) => i.phase === 'canceled').length;
      let text = done + '/' + attempted.length + ' 완료';
      if (failed) text += ' · ' + failed + ' 실패';
      if (canceled) text += ' · ' + canceled + ' 취소';
      el.summary.textContent = text;
      el.summary.dataset.state = inFlight ? 'busy' : failed ? 'warn' : 'done';
    }
  }

  el.downloadAll.addEventListener('click', () => {
    for (const item of state.items.slice()) {
      if (item.info && STARTABLE.has(item.phase)) startJob(item);
    }
  });
  el.cancelAll.addEventListener('click', () => {
    for (const item of state.items.slice()) cancelItem(item);
    el.downloadAll.focus();
  });
  el.clearAll.addEventListener('click', () => {
    for (const item of state.items.slice()) removeItem(item);
    setFeedback('목록을 비웠어요.', 'ok');
    el.input.focus();
  });

  // Leaving (or reloading) cancels downloads in progress and still costs their daily uses: ask first.
  window.addEventListener('beforeunload', (e) => {
    if (!state.items.some((i) => IN_FLIGHT.has(i.phase) || i.phase === 'saving')) return;
    e.preventDefault();
    e.returnValue = '';
  });

  // Best effort: free server slots (and unsaved files) when the tab goes away mid-download.
  window.addEventListener('pagehide', () => {
    for (const item of state.items) {
      if (item.job && (IN_FLIGHT.has(item.phase) || item.phase === 'saving')) {
        try { fetch('/api/jobs/' + encodeURIComponent(item.job.id), { method: 'DELETE', keepalive: true }); } catch { /* ignore */ }
      }
    }
  });

  /* ── boot ── */
  applyConfig();
  renderChrome();
  renderRejected();
  api('GET', '/api/config').then((r) => {
    if (r.ok && r.data) {
      const c = r.data;
      const limits = c.limits && typeof c.limits === 'object' ? c.limits : {};
      const merged = { ...state.config.limits };
      for (const k of Object.keys(merged)) if (typeof limits[k] === 'number' && limits[k] > 0) merged[k] = limits[k];
      state.config = {
        siteName: typeof c.siteName === 'string' && c.siteName.trim() ? c.siteName.trim() : state.config.siteName,
        platforms: Array.isArray(c.platforms) && c.platforms.length
          ? c.platforms.filter((p) => p && typeof p.id === 'string' && typeof p.name === 'string').map((p) => ({ id: p.id, name: p.name, experimental: p.experimental === true }))
          : state.config.platforms,
        limits: merged,
        // EXTRA_ALLOWED_HOSTS of a self-hosted server ("host" or "host:port").
        extraHosts: Array.isArray(c.extraHosts) ? c.extraHosts.filter((x) => typeof x === 'string') : [],
      };
      applyConfig();
    }
    restoreList(); // needs the server's limits and extra hosts to judge the stored links
  });
  refreshStatus();
  el.input.focus({ preventScroll: true });
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startApp);
  else startApp();
}
