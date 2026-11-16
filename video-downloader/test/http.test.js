import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { after, before, describe, test } from 'node:test';
import { isAlive, rawGet, sleep, startApp, until, yt } from './helpers.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const dirOf = (argv) => argv[argv.indexOf('--paths') + 1];

describe('HTTP API with a fake yt-dlp', () => {
  let ctx;
  before(async () => {
    ctx = await startApp({ SITE_NAME: '테스트받기', MAX_HEIGHT: '1080', DAILY_PER_IP: '1000', DELIVERED_GRACE_SECONDS: '0' });
  });
  after(() => ctx.stop());

  test('GET /api/config and /api/status follow the contract', async () => {
    const config = await ctx.api('GET', '/api/config');
    assert.equal(config.status, 200);
    assert.equal(config.json.siteName, '테스트받기');
    assert.deepEqual(config.json.platforms.map((p) => p.id), ['youtube', 'instagram', 'threads', 'facebook']);
    assert.deepEqual(config.json.platforms.filter((p) => p.experimental).map((p) => p.id), ['threads']);
    assert.deepEqual(config.json.extraHosts, []);
    assert.deepEqual(config.json.limits, { maxBatch: 20, maxHeight: 1080, maxFileMB: 500, dailyPerIp: 1000, maxConcurrent: 3, jobTtlSeconds: 900 });
    const status = await ctx.api('GET', '/api/status');
    assert.deepEqual(Object.keys(status.json).sort(), ['active', 'dailyPerIp', 'ipToday', 'maxConcurrent', 'queued']);
    assert.equal(status.json.maxConcurrent, 3);
  });

  test('security headers everywhere, no CORS headers', async () => {
    for (const path of ['/', '/app.js', '/api/config', '/api/nope', '/missing.html']) {
      const res = await ctx.api('GET', path, undefined, { origin: 'https://evil.example' });
      assert.match(res.headers.get('content-security-policy'), /^default-src 'self'; img-src 'self' https: data:/, path);
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff', path);
      assert.equal(res.headers.get('referrer-policy'), 'no-referrer', path);
      assert.equal(res.headers.get('access-control-allow-origin'), null, path);
    }
    const preflight = await ctx.api('OPTIONS', '/api/jobs', undefined, { origin: 'https://evil.example', 'access-control-request-method': 'POST' });
    assert.equal(preflight.status, 405);
    assert.equal(preflight.headers.get('access-control-allow-origin'), null);
  });

  test('static files: content types, index, and no path traversal', async () => {
    const index = await ctx.api('GET', '/');
    assert.equal(index.status, 200);
    assert.equal(index.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.match(index.text, /<title>test<\/title>/);
    assert.equal((await ctx.api('GET', '/app.js')).headers.get('content-type'), 'text/javascript; charset=utf-8');
    assert.equal((await ctx.api('POST', '/app.js', {})).status, 405);

    for (const path of ['/../secret.txt', '/..%2fsecret.txt', '/%2e%2e/secret.txt', '/..%5csecret.txt', '/a/../../secret.txt', '//secret.txt', '/%00', '/.env', '/%E0%A4%A']) {
      const res = await rawGet(ctx.base, path);
      assert.ok(res.status === 404 || res.status === 400, `${path} -> ${res.status}`);
      assert.ok(!res.body.includes('outside the public root'), path);
      assert.equal(res.headers['content-type'], 'application/json; charset=utf-8');
    }
  });

  test('POST /api/info returns normalized facts and caches by normalized URL', async () => {
    const before = ctx.argvLog().length;
    const res = await ctx.api('POST', '/api/info', { url: yt('ok', '&si=TRACK#t=1') });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, {
      url: yt('ok'),
      platform: 'youtube',
      title: 'Fake Video Title',
      uploader: 'Fake Uploader',
      durationSeconds: 62,
      thumbnail: 'https://i.example.com/thumb.jpg',
      heights: [1080, 720, 360],
      audio: true,
    });
    const again = await ctx.api('POST', '/api/info', { url: yt('ok', '&feature=share') });
    assert.deepEqual(again.json, res.json);
    const calls = ctx.argvLog().slice(before);
    assert.equal(calls.length, 1, 'second lookup is served from the cache');
    assert.deepEqual(calls[0].slice(-2), ['--', yt('ok')]);
    assert.ok(calls[0].includes('--no-playlist') && calls[0].includes('--ignore-config'));

    const playlist = await ctx.api('POST', '/api/info', { url: yt('playlist') });
    assert.equal(playlist.json.title, 'Fake playlist');
  });

  test('info and job requests reject bad input with coded Korean errors', async () => {
    const cases = [
      [{ url: 'https://evilyoutube.com/watch?v=1' }, 400, 'unsupported_site'],
      [{ url: 'https://youtube.com.evil.com/watch?v=1' }, 400, 'unsupported_site'],
      [{ url: 'http://www.youtube.com/watch?v=1' }, 400, 'invalid_url'],
      [{ url: 'https://127.0.0.1/a.mp4' }, 400, 'invalid_url'],
      [{ url: 'https://a:b@youtube.com/watch?v=1' }, 400, 'invalid_url'],
      [{ url: 'nonsense' }, 400, 'invalid_url'],
      [{}, 400, 'invalid_url'],
      ['{not json', 400, 'bad_request'],
      ['[1,2]', 400, 'bad_request'],
      [{ url: yt('ok'), pad: 'x'.repeat(9000) }, 413, 'bad_request'],
    ];
    for (const path of ['/api/info', '/api/jobs']) {
      for (const [body, status, code] of cases) {
        const payload = path === '/api/jobs' && typeof body === 'object' ? { format: 'video', ...body } : body;
        const res = await ctx.api('POST', path, payload);
        assert.equal(res.status, status, `${path} ${JSON.stringify(body).slice(0, 60)}`);
        assert.equal(res.json.error.code, code);
        assert.match(res.json.error.message, /[가-힣]/);
      }
    }
    assert.equal((await ctx.api('POST', '/api/jobs', { url: yt('ok'), format: 'gif' })).json.error.code, 'bad_request');
    assert.equal((await ctx.api('POST', '/api/jobs', { url: yt('ok'), format: 'video', height: '720' })).json.error.code, 'bad_request');
    assert.equal((await ctx.api('GET', '/api/info')).status, 405);
    assert.equal((await ctx.api('GET', '/api/unknown')).json.error.code, 'not_found');
  });

  test('extraction failure maps to extract_failed without leaking yt-dlp output', async () => {
    const res = await ctx.api('POST', '/api/info', { url: yt('fail') });
    assert.equal(res.status, 502);
    assert.equal(res.json.error.code, 'extract_failed');
    assert.ok(!/Private video|ERROR|youtube/i.test(res.json.error.message));
  });

  test('video job: queued -> ready, file delivered once, temp dir removed afterwards', async () => {
    const before = ctx.argvLog().length;
    const created = await ctx.api('POST', '/api/jobs', { url: yt('unicode', '&si=x'), format: 'video', height: 2160 });
    assert.equal(created.status, 202);
    assert.equal(created.json.status, 'queued');
    assert.match(created.json.id, UUID);
    assert.deepEqual(Object.keys(created.json).sort(), ['id', 'status']);

    const ready = await ctx.waitFor(created.json.id, 'ready');
    assert.deepEqual(ready, { id: created.json.id, status: 'ready', progress: 100, queuePosition: null, filename: '한글 제목 테스트 1 🎬.mp4', sizeBytes: ready.sizeBytes, error: null });

    const argv = ctx.argvLog().slice(before).at(-1);
    assert.deepEqual(argv.slice(-2), ['--', yt('unicode')]);
    assert.ok(argv[argv.indexOf('--format') + 1].includes('[height<=1080]'), 'requested 2160 is capped by MAX_HEIGHT');
    assert.ok(!argv[argv.indexOf('--format') + 1].includes('2160'));
    const dir = dirOf(argv);
    assert.ok(existsSync(dir));

    const res = await fetch(`${ctx.base}/api/jobs/${created.json.id}/file`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'video/mp4');
    const body = Buffer.from(await res.arrayBuffer());
    assert.equal(Number(res.headers.get('content-length')), body.length);
    assert.equal(body.length, ready.sizeBytes);
    assert.match(body.toString(), /^FAKE-VIDEO\|/);
    const disposition = res.headers.get('content-disposition');
    assert.match(disposition, /^attachment; filename="[\x20-\x7e]+\.mp4"; filename\*=UTF-8''/);
    assert.equal(decodeURIComponent(disposition.split("filename*=UTF-8''")[1]), '한글 제목 테스트 1 🎬.mp4');

    await until(() => !existsSync(dir), 3000, 'temp dir should be removed after delivery');
    assert.equal((await ctx.api('GET', `/api/jobs/${created.json.id}`)).json.status, 'expired');
    const second = await ctx.api('GET', `/api/jobs/${created.json.id}/file`);
    assert.equal(second.status, 410);
    assert.equal(second.json.error.code, 'not_found');
  });

  test('audio job delivers an mp3', async () => {
    const created = await ctx.api('POST', '/api/jobs', { url: yt('ok'), format: 'audio', height: 720 });
    const ready = await ctx.waitFor(created.json.id, 'ready');
    assert.equal(ready.filename, 'Fake Video Title.mp3');
    const argv = ctx.argvLog().at(-1);
    assert.ok(argv.includes('--extract-audio') && argv[argv.indexOf('--audio-format') + 1] === 'mp3');
    const res = await fetch(`${ctx.base}/api/jobs/${created.json.id}/file`);
    assert.equal(res.headers.get('content-type'), 'audio/mpeg');
    assert.match(await res.text(), /^FAKE-AUDIO\|/);
  });

  test('failed, oversized and file-less downloads end in error and leave no temp dir', async () => {
    for (const [scenario, code] of [['fail', 'extract_failed'], ['big', 'too_large'], ['nofile', 'extract_failed']]) {
      const created = await ctx.api('POST', '/api/jobs', { url: yt(scenario), format: 'video' });
      const done = await ctx.waitFor(created.json.id, 'error');
      assert.equal(done.error.code, code, scenario);
      assert.match(done.error.message, /[가-힣]/);
      assert.equal(done.filename, null);
      const file = await ctx.api('GET', `/api/jobs/${created.json.id}/file`);
      assert.equal(file.status, 410, scenario);
      const dir = dirOf(ctx.argvLog().at(-1));
      await until(() => !existsSync(dir), 3000, `${scenario}: temp dir should be removed`);
    }
    await until(() => ctx.app.tempDirs.tracked === 0);
  });

  test('unknown and malformed job ids are not found', async () => {
    for (const id of ['00000000-0000-4000-8000-000000000000', 'abc', '..%2f..%2fetc']) {
      for (const [method, suffix] of [['GET', ''], ['GET', '/file'], ['DELETE', '']]) {
        const res = await ctx.api(method, `/api/jobs/${id}${suffix}`);
        assert.equal(res.status, 404, `${method} ${id}${suffix}`);
        assert.equal(res.json.error.code, 'not_found');
      }
    }
  });
});

describe('queue, cancel and process cleanup', () => {
  test('respects MAX_CONCURRENT, reports queue positions, and cancel kills the process tree', async (t) => {
    const ctx = await startApp({ MAX_CONCURRENT: '2' });
    t.after(() => ctx.stop());
    const ids = [];
    for (let i = 0; i < 4; i += 1) {
      ids.push((await ctx.api('POST', '/api/jobs', { url: yt('hang', `&n=${i}`), format: 'video', height: 360 })).json.id);
    }
    await until(() => ctx.pids().length === 4, 5000, 'two fake processes (each with a grandchild) should be running');
    const status = (await ctx.api('GET', '/api/status')).json;
    assert.deepEqual([status.active, status.queued, status.ipToday], [2, 2, 4]);
    const views = await Promise.all(ids.map(async (id) => (await ctx.api('GET', `/api/jobs/${id}`)).json));
    assert.deepEqual(views.map((v) => v.status), ['downloading', 'downloading', 'queued', 'queued']);
    assert.deepEqual(views.map((v) => v.queuePosition), [null, null, 1, 2]);
    assert.equal(views[0].progress, 21, '42% of the first of two parts');
    assert.equal(views[2].progress, null);
    assert.equal((await ctx.api('GET', `/api/jobs/${ids[0]}/file`)).json.error.code, 'not_ready');
    assert.equal((await ctx.api('GET', `/api/jobs/${ids[2]}/file`)).status, 409);

    const firstPids = ctx.pids();
    const firstDirs = ctx.argvLog().map(dirOf);
    assert.ok(firstPids.every(isAlive));
    assert.ok(firstDirs.every((d) => existsSync(d)));

    // Cancel a queued job, then both running ones.
    assert.equal((await ctx.api('DELETE', `/api/jobs/${ids[3]}`)).status, 204);
    assert.equal((await ctx.api('GET', `/api/jobs/${ids[3]}`)).json.status, 'canceled');
    assert.equal((await ctx.api('DELETE', `/api/jobs/${ids[0]}`)).status, 204);
    assert.equal((await ctx.api('DELETE', `/api/jobs/${ids[1]}`)).status, 204);
    assert.equal((await ctx.api('DELETE', `/api/jobs/${ids[1]}`)).status, 204, 'idempotent');
    assert.equal((await ctx.api('GET', `/api/jobs/${ids[0]}`)).json.status, 'canceled');
    await until(() => firstPids.every((pid) => !isAlive(pid)), 5000, 'yt-dlp and its children must be killed');
    await until(() => firstDirs.every((d) => !existsSync(d)), 5000, 'temp dirs (with partial files) must be removed');

    // The freed slot goes to the remaining queued job.
    await until(async () => (await ctx.api('GET', `/api/jobs/${ids[2]}`)).json.status === 'downloading');
    assert.deepEqual((await ctx.api('GET', '/api/status')).json.queued, 0);
  });

  test('graceful shutdown kills children and removes temp dirs', async () => {
    const ctx = await startApp({ MAX_CONCURRENT: '2' });
    await ctx.api('POST', '/api/jobs', { url: yt('hang'), format: 'audio' });
    await until(() => ctx.pids().length === 2);
    const pids = ctx.pids();
    const dirs = ctx.argvLog().map(dirOf);
    assert.ok(dirs.every((d) => existsSync(d)));
    await ctx.app.close();
    await until(() => pids.every((pid) => !isAlive(pid)), 5000, 'children must be dead after close()');
    assert.ok(dirs.every((d) => !existsSync(d)));
    assert.equal(ctx.app.tempDirs.tracked, 0);
    await ctx.stop();
  });

  test('hard wall-clock timeout kills a hanging download and a hanging info lookup', async (t) => {
    const ctx = await startApp({ DOWNLOAD_TIMEOUT_SECONDS: '1', INFO_TIMEOUT_SECONDS: '1' });
    t.after(() => ctx.stop());
    const created = await ctx.api('POST', '/api/jobs', { url: yt('hang'), format: 'video' });
    const done = await ctx.waitFor(created.json.id, 'error', 6000);
    assert.equal(done.error.code, 'extract_failed');
    const info = await ctx.api('POST', '/api/info', { url: yt('infohang') });
    assert.equal(info.status, 504);
    assert.equal(info.json.error.code, 'extract_failed');
    await until(() => ctx.pids().every((pid) => !isAlive(pid)), 5000, 'timed-out process trees must be gone');
    await until(() => ctx.app.tempDirs.tracked === 0);
  });

  test('TTL cleanup expires an unclaimed file and removes its temp dir', async (t) => {
    const ctx = await startApp({ JOB_TTL_SECONDS: '2' });
    t.after(() => ctx.stop());
    const created = await ctx.api('POST', '/api/jobs', { url: yt('ok'), format: 'video' });
    await ctx.waitFor(created.json.id, 'ready');
    const dir = dirOf(ctx.argvLog().at(-1));
    assert.ok(existsSync(dir));
    await ctx.waitFor(created.json.id, 'expired', 5000);
    // The status flips first; the directory removal is asynchronous and follows right after.
    await until(() => !existsSync(dir), 5000, 'expired temp dir must be removed');
    assert.equal((await ctx.api('GET', `/api/jobs/${created.json.id}/file`)).status, 410);
    await until(async () => (await ctx.api('GET', `/api/jobs/${created.json.id}`)).status === 404, 5000, 'finished jobs are eventually forgotten');
  });
});

describe('limits', () => {
  test('batch_limit and busy', async (t) => {
    const ctx = await startApp({ MAX_BATCH: '2', MAX_CONCURRENT: '1', MAX_QUEUED: '1' });
    t.after(() => ctx.stop());
    const post = (headers) => ctx.api('POST', '/api/jobs', { url: yt('hang'), format: 'video' }, headers);
    assert.equal((await post()).status, 202);
    await until(() => ctx.pids().length === 2);
    assert.equal((await post()).status, 202); // queued
    const third = await post();
    assert.equal(third.status, 429);
    assert.equal(third.json.error.code, 'batch_limit');
    assert.equal((await ctx.api('GET', '/api/status')).json.ipToday, 2, 'refused jobs do not use up the daily allowance');
  });

  test('busy when the global queue is full (other client)', async (t) => {
    const ctx = await startApp({ MAX_CONCURRENT: '1', MAX_QUEUED: '1', TRUST_PROXY: '1' });
    t.after(() => ctx.stop());
    const post = (ip) => ctx.api('POST', '/api/jobs', { url: yt('hang'), format: 'video' }, { 'x-forwarded-for': ip });
    assert.equal((await post('10.0.0.1')).status, 202);
    await until(() => ctx.pids().length === 2);
    assert.equal((await post('10.0.0.1')).status, 202);
    const res = await post('10.0.0.2');
    assert.equal(res.status, 503);
    assert.equal(res.json.error.code, 'busy');
  });

  test('daily_limit per client IP with reset at Seoul midnight; X-Forwarded-For only with TRUST_PROXY=1', async (t) => {
    let nowMs = Date.parse('2026-03-01T23:50:00+09:00');
    const ctx = await startApp({ DAILY_PER_IP: '2', TRUST_PROXY: '1' }, { now: () => nowMs });
    t.after(() => ctx.stop());
    // The proxy appends the address it saw; anything to the left was sent by the client itself.
    let spoof = 0;
    const post = (ip) => ctx.api('POST', '/api/jobs', { url: yt('ok'), format: 'audio' }, { 'x-forwarded-for': `9.9.9.${(spoof += 1)}, ${ip}` });
    const today = async (ip) => (await ctx.api('GET', '/api/status', undefined, { 'x-forwarded-for': ip })).json.ipToday;

    assert.equal((await post('203.0.113.5')).status, 202);
    assert.equal((await post('203.0.113.5')).status, 202);
    const refused = await post('203.0.113.5');
    assert.equal(refused.status, 429);
    assert.equal(refused.json.error.code, 'daily_limit');
    assert.equal(await today('203.0.113.5'), 2);
    assert.equal(await today('203.0.113.6'), 0);
    assert.equal((await post('203.0.113.6')).status, 202, 'another IP has its own allowance');

    nowMs = Date.parse('2026-03-02T00:00:01+09:00');
    assert.equal(await today('203.0.113.5'), 0);
    assert.equal((await post('203.0.113.5')).status, 202);

    const untrusted = await startApp({ DAILY_PER_IP: '1' });
    t.after(() => untrusted.stop());
    const direct = (ip) => untrusted.api('POST', '/api/jobs', { url: yt('ok'), format: 'audio' }, { 'x-forwarded-for': ip });
    assert.equal((await direct('1.1.1.1')).status, 202);
    assert.equal((await direct('2.2.2.2')).json.error.code, 'daily_limit', 'the header is ignored without TRUST_PROXY');

    // Two proxies in front (e.g. CDN + nginx): the client is the second entry from the right.
    const twoHops = await startApp({ DAILY_PER_IP: '1', TRUST_PROXY: '2' });
    t.after(() => twoHops.stop());
    const viaCdn = (ip) => twoHops.api('POST', '/api/jobs', { url: yt('ok'), format: 'audio' }, { 'x-forwarded-for': `6.6.6.6, ${ip}, 172.16.0.9` });
    assert.equal((await viaCdn('203.0.113.7')).status, 202);
    assert.equal((await viaCdn('203.0.113.7')).json.error.code, 'daily_limit');
    assert.equal((await viaCdn('203.0.113.8')).status, 202);
    await sleep(50);
  });
});

describe('abuse resistance (review findings)', () => {
  test('state-changing requests from another site are refused before anything happens', async (t) => {
    const ctx = await startApp();
    t.after(() => ctx.stop());
    const body = JSON.stringify({ url: yt('ok'), format: 'video' });
    const post = (path, headers) => fetch(ctx.base + path, { method: 'POST', body, headers });
    const host = new URL(ctx.base).host;

    // What <form> / fetch(no-cors) can send without a preflight.
    for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x']) {
      for (const path of ['/api/jobs', '/api/info']) {
        const res = await post(path, { 'content-type': type });
        assert.equal(res.status, 415, `${path} ${type}`);
        assert.equal((await res.json()).error.code, 'bad_request');
      }
    }
    const noType = await fetch(`${ctx.base}/api/jobs`, { method: 'POST', body: new Blob([body]) });
    assert.equal(noType.status, 415);

    const json = { 'content-type': 'application/json' };
    for (const headers of [
      { ...json, origin: 'https://evil.example' },
      { ...json, origin: 'null' },
      { ...json, origin: `http://${host}`, 'sec-fetch-site': 'cross-site' },
      { ...json, 'sec-fetch-site': 'same-site' },
    ]) {
      const res = await post('/api/jobs', headers);
      assert.equal(res.status, 403, JSON.stringify(headers));
      const error = (await res.json()).error;
      assert.equal(error.code, 'bad_request');
      assert.match(error.message, /[가-힣]/);
      assert.equal((await post('/api/info', headers)).status, 403);
    }
    assert.equal(ctx.argvLog().length, 0, 'yt-dlp was never started');
    assert.equal((await ctx.api('GET', '/api/status')).json.ipToday, 0, 'no daily use was spent');

    // The site's own page (and non-browser clients) still work.
    const own = await post('/api/jobs', { ...json, origin: `http://${host}`, 'sec-fetch-site': 'same-origin' });
    assert.equal(own.status, 202);
    const id = (await own.json()).id;
    assert.equal((await post('/api/jobs', { ...json, origin: `http://${host}` })).status, 202);
    assert.equal((await post('/api/jobs', { 'content-type': 'application/json; charset=utf-8' })).status, 202);
    const crossDelete = await fetch(`${ctx.base}/api/jobs/${id}`, { method: 'DELETE', headers: { origin: 'https://evil.example' } });
    assert.equal(crossDelete.status, 403);
    assert.notEqual((await ctx.api('GET', `/api/jobs/${id}`)).json.status, 'canceled');
  });

  test('a client that closes the connection right after the body still counts as delivered', async (t) => {
    const ctx = await startApp({ DELIVERED_GRACE_SECONDS: '0', DAILY_PER_IP: '1000' });
    t.after(() => ctx.stop());
    for (let i = 0; i < 12; i += 1) {
      const created = await ctx.api('POST', '/api/jobs', { url: yt('ok', `&n=${i}`), format: 'video' });
      const ready = await ctx.waitFor(created.json.id, 'ready');
      const res = await fetch(`${ctx.base}/api/jobs/${created.json.id}/file`, { headers: { connection: 'close' } });
      assert.equal((await res.arrayBuffer()).byteLength, ready.sizeBytes);
      await ctx.waitFor(created.json.id, 'expired', 3000);
    }
    await until(() => ctx.app.tempDirs.tracked === 0, 3000, 'no delivered file may stay behind');
  });

  test('a delivered file can be fetched again during the grace period and frees its batch slot', async (t) => {
    const ctx = await startApp({ MAX_BATCH: '1' }); // default grace
    t.after(() => ctx.stop());
    const created = await ctx.api('POST', '/api/jobs', { url: yt('ok'), format: 'video' });
    await ctx.waitFor(created.json.id, 'ready');
    const blocked = await ctx.api('POST', '/api/jobs', { url: yt('ok', '&n=2'), format: 'video' });
    assert.equal(blocked.json.error.code, 'batch_limit', 'an unclaimed finished file keeps its slot (it occupies disk)');
    for (let i = 0; i < 2; i += 1) {
      const res = await fetch(`${ctx.base}/api/jobs/${created.json.id}/file`);
      assert.equal(res.status, 200, `attempt ${i + 1}`);
      assert.match(await res.text(), /^FAKE-VIDEO/);
    }
    await until(async () => (await ctx.api('POST', '/api/jobs', { url: yt('ok', '&n=3'), format: 'video' })).status === 202, 2000, 'delivery frees the slot');
    assert.equal((await ctx.api('GET', `/api/jobs/${created.json.id}`)).json.status, 'ready');
  });

  test('one client cannot occupy the whole info lookup capacity', async (t) => {
    const ctx = await startApp({ TRUST_PROXY: '1', INFO_TIMEOUT_SECONDS: '30' });
    t.after(() => ctx.stop());
    const lookups = [];
    const controllers = [];
    for (let i = 0; i < 4; i += 1) {
      const controller = new AbortController();
      controllers.push(controller);
      lookups.push(fetch(`${ctx.base}/api/info`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.1' },
        body: JSON.stringify({ url: yt('infohang', `&x=${i}`) }),
        signal: controller.signal,
      }).catch(() => null));
    }
    await until(() => ctx.pids().length === 4, 5000, 'two lookups run (each with a grandchild), two wait');
    const fifth = await ctx.api('POST', '/api/info', { url: yt('infohang', '&x=5') }, { 'x-forwarded-for': '198.51.100.1' });
    assert.equal(fifth.status, 429);
    assert.equal(fifth.json.error.code, 'busy');
    assert.equal(ctx.argvLog().length, 2);

    // Another client is not shut out: it waits its turn instead of being refused.
    const other = ctx.api('POST', '/api/info', { url: yt('ok') }, { 'x-forwarded-for': '198.51.100.2' });
    const hung = ctx.pids();
    // When the first client goes away, its lookups are killed instead of running for nobody.
    for (const controller of controllers) controller.abort();
    await Promise.all(lookups);
    await until(() => hung.every((pid) => !isAlive(pid)), 5000, 'abandoned lookups must be killed');
    const res = await other;
    assert.equal(res.status, 200);
    assert.equal(res.json.title, 'Fake Video Title');
    assert.equal(ctx.argvLog().length, 3, 'the two lookups that were still waiting never started a process');
    const again = await ctx.api('POST', '/api/info', { url: yt('ok', '&x=9') }, { 'x-forwarded-for': '198.51.100.1' });
    assert.equal(again.status, 200, 'the slots of the first client are free again');
  });

  test('shutdown with lookups waiting for a slot leaves no orphan process', async () => {
    const ctx = await startApp({ INFO_CONCURRENCY: '2', INFO_PER_IP_CONCURRENT: '10' });
    const pending = [];
    for (let i = 0; i < 6; i += 1) pending.push(ctx.api('POST', '/api/info', { url: yt('infohang', `&y=${i}`) }).catch(() => null));
    await until(() => ctx.pids().length === 4);
    await ctx.app.close();
    await Promise.all(pending);
    await sleep(300); // a late spawn would show up by now
    assert.equal(ctx.argvLog().length, 2, 'waiting lookups must not start after shutdown');
    await until(() => ctx.pids().every((pid) => !isAlive(pid)), 5000, 'every process tree must be dead');
    assert.equal(ctx.app.ytdlp.running, 0);
    await ctx.stop();
  });

  test('EXTRA_ALLOWED_HOSTS are announced to the page', async (t) => {
    const ctx = await startApp({ EXTRA_ALLOWED_HOSTS: '127.0.0.1:3414, Media.Example.org' });
    t.after(() => ctx.stop());
    assert.deepEqual((await ctx.api('GET', '/api/config')).json.extraHosts, ['127.0.0.1:3414', 'media.example.org']);
  });
});
