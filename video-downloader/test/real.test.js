// Opt-in end-to-end test against the REAL yt-dlp + ffmpeg (generic extractor, local file server).
// Run with: REAL_YTDLP=1 npm test

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { startApp, until } from './helpers.js';

const enabled = process.env.REAL_YTDLP === '1';
const sha = (buf) => createHash('sha256').update(buf).digest('hex');

test('real yt-dlp: downloads a tiny mp4 (and mp3) from a local server and cleans up', { skip: !enabled && 'set REAL_YTDLP=1 to run', timeout: 120_000 }, async (t) => {
  const work = mkdtempSync(join(tmpdir(), 'moabatgi-test-real-'));
  const source = join(work, 'tiny clip.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '2',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', source]);
  const original = readFileSync(source);

  const media = createServer((req, res) => {
    const path = req.url.split('?')[0];
    if (path === '/big.mp4') {
      // Announces 3 MB; used to check the real tool's size refusal.
      const big = Buffer.concat([original, Buffer.alloc(3 * 1024 * 1024 - original.length)]);
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': big.length });
      res.end(req.method === 'HEAD' ? undefined : big);
      return;
    }
    if (path !== '/clip.mp4') {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': original.length });
    res.end(req.method === 'HEAD' ? undefined : original);
  });
  await new Promise((resolve) => media.listen(0, '127.0.0.1', resolve));
  const mediaHost = `127.0.0.1:${media.address().port}`;
  const mediaUrl = `http://${mediaHost}/clip.mp4`;

  const ctx = await startApp({ YTDLP_PATH: process.env.YTDLP_PATH || 'yt-dlp', EXTRA_ALLOWED_HOSTS: mediaHost, DELIVERED_GRACE_SECONDS: '0' });
  t.after(async () => {
    await ctx.stop();
    await new Promise((resolve) => media.close(resolve));
    rmSync(work, { recursive: true, force: true });
  });

  // The allowance is exact: another port on the same host stays forbidden.
  assert.equal((await ctx.api('POST', '/api/info', { url: 'http://127.0.0.1:1/clip.mp4' })).json.error.code, 'invalid_url');

  const info = await ctx.api('POST', '/api/info', { url: mediaUrl });
  assert.equal(info.status, 200, JSON.stringify(info.json));
  assert.equal(info.json.platform, 'other');
  assert.equal(info.json.title, 'clip');
  assert.equal(info.json.audio, true);
  assert.ok(Array.isArray(info.json.heights));

  // --- video
  const video = await ctx.api('POST', '/api/jobs', { url: mediaUrl, format: 'video', height: 360 });
  assert.equal(video.status, 202);
  const ready = await ctx.waitFor(video.json.id, ['ready', 'error'], 60_000);
  assert.equal(ready.status, 'ready', JSON.stringify(ready));
  assert.equal(ready.filename, 'clip.mp4');
  assert.equal(ready.sizeBytes, original.length);
  const created = ctx.app.tempDirs.paths();
  assert.equal(created.length, 1, 'exactly one job directory exists while the file waits');
  assert.ok(created[0].startsWith(tmpdir()) && existsSync(created[0]));

  const res = await fetch(`${ctx.base}/api/jobs/${video.json.id}/file`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'video/mp4');
  assert.equal(Number(res.headers.get('content-length')), original.length);
  const delivered = Buffer.from(await res.arrayBuffer());
  assert.equal(sha(delivered), sha(original), 'delivered bytes are exactly the source file');
  assert.equal(delivered.subarray(4, 8).toString('latin1'), 'ftyp');

  await until(() => !existsSync(created[0]), 5000, 'job temp dir must be gone after delivery');
  assert.equal((await ctx.api('GET', `/api/jobs/${video.json.id}`)).json.status, 'expired');

  // --- audio (real ffmpeg conversion)
  const audio = await ctx.api('POST', '/api/jobs', { url: mediaUrl, format: 'audio' });
  const audioReady = await ctx.waitFor(audio.json.id, ['ready', 'error'], 60_000);
  assert.equal(audioReady.status, 'ready', JSON.stringify(audioReady));
  assert.equal(audioReady.filename, 'clip.mp3');
  const mp3 = await fetch(`${ctx.base}/api/jobs/${audio.json.id}/file`);
  assert.equal(mp3.headers.get('content-type'), 'audio/mpeg');
  const mp3Bytes = Buffer.from(await mp3.arrayBuffer());
  assert.equal(mp3Bytes.length, audioReady.sizeBytes);
  assert.ok(mp3Bytes.subarray(0, 3).toString('latin1') === 'ID3' || (mp3Bytes[0] === 0xff && (mp3Bytes[1] & 0xe0) === 0xe0), 'looks like an MP3');

  // --- size limit is enforced by the real tool
  const limited = await startApp({ YTDLP_PATH: process.env.YTDLP_PATH || 'yt-dlp', EXTRA_ALLOWED_HOSTS: mediaHost, MAX_FILE_MB: '1' });
  t.after(() => limited.stop());
  const big = await limited.api('POST', '/api/jobs', { url: `http://${mediaHost}/big.mp4`, format: 'video' });
  const refused = await limited.waitFor(big.json.id, ['ready', 'error'], 60_000);
  assert.equal(refused.status, 'error', JSON.stringify(refused));
  assert.equal(refused.error.code, 'too_large');

  // --- a missing file is an extraction failure, not a crash
  const missing = await ctx.api('POST', '/api/info', { url: `http://${mediaHost}/missing.mp4` });
  assert.equal(missing.status, 502);
  assert.equal(missing.json.error.code, 'extract_failed');

  await until(() => ctx.app.tempDirs.tracked === 0 && limited.app.tempDirs.tracked === 0, 5000, 'no job temp dirs may remain');
});

/** Serves `routes` (path -> handler) on a loopback port and counts every request. */
async function origin(routes) {
  const hits = [];
  const server = createServer((req, res) => {
    const path = req.url.split('?')[0];
    hits.push(`${req.method} ${path}`);
    const route = routes[path];
    if (!route) {
      res.writeHead(404).end();
      return;
    }
    route(req, res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, hits, host: `127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}

const sendBytes = (type, bytes) => (req, res) => {
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': bytes.length });
  res.end(req.method === 'HEAD' ? undefined : bytes);
};

test('real yt-dlp: redirects and embeds cannot reach a host that was not allowed (SSRF)', { skip: !enabled && 'set REAL_YTDLP=1 to run', timeout: 120_000 }, async (t) => {
  const work = mkdtempSync(join(tmpdir(), 'moabatgi-test-ssrf-'));
  const source = join(work, 'internal.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=5', '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', source]);
  const secret = readFileSync(source);

  // "Internal" service: reachable from the server, never allowed by the operator.
  const internal = await origin({ '/internal.mp4': sendBytes('video/mp4', secret), '/admin': sendBytes('text/html', Buffer.from('<h1>admin</h1>')) });
  const redirect = (to) => (req, res) => res.writeHead(302, { Location: to }).end();
  const allowed = await origin({
    '/redir-html': redirect(`http://${internal.host}/admin`),
    '/redir-vid': redirect(`http://${internal.host}/internal.mp4`),
    '/embed': sendBytes('text/html', Buffer.from(`<html><head><title>x</title><meta property="og:video" content="http://${internal.host}/internal.mp4"></head><body><video src="http://${internal.host}/internal.mp4"></video></body></html>`)),
    '/ok.mp4': sendBytes('video/mp4', secret),
  });
  const ctx = await startApp({ YTDLP_PATH: process.env.YTDLP_PATH || 'yt-dlp', EXTRA_ALLOWED_HOSTS: allowed.host });
  t.after(async () => {
    await ctx.stop();
    await allowed.close();
    await internal.close();
    rmSync(work, { recursive: true, force: true });
  });

  // Sanity: the allowed origin itself works through the guard.
  const fine = await ctx.api('POST', '/api/info', { url: `http://${allowed.host}/ok.mp4` });
  assert.equal(fine.status, 200, JSON.stringify(fine.json));

  for (const path of ['/redir-html', '/redir-vid', '/embed']) {
    const info = await ctx.api('POST', '/api/info', { url: `http://${allowed.host}${path}` });
    // An embed is only listed by the lookup (nothing is fetched from it); redirects must fail outright.
    if (path !== '/embed') assert.equal(info.json.error?.code, 'extract_failed', `${path}: ${JSON.stringify(info.json)}`);
    const job = await ctx.api('POST', '/api/jobs', { url: `http://${allowed.host}${path}`, format: 'video' });
    const done = await ctx.waitFor(job.json.id, ['ready', 'error'], 60_000);
    assert.equal(done.status, 'error', `${path}: the internal file must not be downloadable`);
  }
  assert.ok(allowed.hits.length >= 3, 'the allowed origin was contacted');
  assert.deepEqual(internal.hits, [], 'the internal service never saw a request');
  await until(() => ctx.app.tempDirs.tracked === 0, 5000);
});

test('real yt-dlp: portrait video is capped on its short side (Shorts/Reels)', { skip: !enabled && 'set REAL_YTDLP=1 to run', timeout: 180_000 }, async (t) => {
  const work = mkdtempSync(join(tmpdir(), 'moabatgi-test-portrait-'));
  const ladder = [[480, 854], [720, 1280], [1080, 1920]];
  const files = {};
  const variants = [];
  for (const [w, h] of ladder) {
    const name = `v${w}`;
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc=size=${w}x${h}:rate=5`, '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '2',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod',
      '-hls_segment_filename', join(work, `${name}_%d.ts`), join(work, `${name}.m3u8`)]);
    variants.push(`#EXT-X-STREAM-INF:BANDWIDTH=${w * 1000},RESOLUTION=${w}x${h},CODECS="avc1.42c01e,mp4a.40.2"\n${name}.m3u8`);
  }
  const master = (lines) => Buffer.from(`#EXTM3U\n#EXT-X-VERSION:3\n${lines.join('\n')}\n`);
  const media = createServer((req, res) => {
    const name = req.url.split('?')[0].slice(1);
    let body;
    if (name === 'shorts.m3u8') body = master(variants);
    else if (name === 'reel.m3u8') body = master([variants[2]]); // a single 1080x1920 rendition
    else if (/^v\d+(_\d+\.ts|\.m3u8)$/.test(name) && existsSync(join(work, name))) body = files[name] ??= readFileSync(join(work, name));
    if (!body) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'Content-Type': name.endsWith('.ts') ? 'video/mp2t' : 'application/vnd.apple.mpegurl', 'Content-Length': body.length });
    res.end(req.method === 'HEAD' ? undefined : body);
  });
  await new Promise((resolve) => media.listen(0, '127.0.0.1', resolve));
  const host = `127.0.0.1:${media.address().port}`;
  const ctx = await startApp({ YTDLP_PATH: process.env.YTDLP_PATH || 'yt-dlp', EXTRA_ALLOWED_HOSTS: host, DELIVERED_GRACE_SECONDS: '0' });
  t.after(async () => {
    await ctx.stop();
    await new Promise((resolve) => media.close(resolve));
    rmSync(work, { recursive: true, force: true });
  });

  const probe = (file) => execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,width,height', '-of', 'csv=p=0', file]).toString().trim();
  async function download(name, height) {
    const job = await ctx.api('POST', '/api/jobs', { url: `http://${host}/${name}`, format: 'video', ...(height ? { height } : {}) });
    const done = await ctx.waitFor(job.json.id, ['ready', 'error'], 90_000);
    assert.equal(done.status, 'ready', `${name}@${height}: ${JSON.stringify(done)}`);
    const out = join(work, `${job.json.id}.mp4`);
    const res = await fetch(`${ctx.base}/api/jobs/${job.json.id}/file`);
    writeFileSync(out, Buffer.from(await res.arrayBuffer()));
    return probe(out);
  }

  const shorts = await ctx.api('POST', '/api/info', { url: `http://${host}/shorts.m3u8` });
  assert.deepEqual(shorts.json.heights, [1080, 720, 480], JSON.stringify(shorts.json));
  assert.equal(await download('shorts.m3u8', null), 'h264,1080,1920', 'best = the 1080p rendition, not the smallest');
  assert.equal(await download('shorts.m3u8', 1080), 'h264,1080,1920');
  assert.equal(await download('shorts.m3u8', 720), 'h264,720,1280');
  assert.equal(await download('shorts.m3u8', 480), 'h264,480,854');

  const reel = await ctx.api('POST', '/api/info', { url: `http://${host}/reel.m3u8` });
  assert.deepEqual(reel.json.heights, [1080], 'a lone 1080x1920 rendition is offered as 1080p');
  assert.equal(await download('reel.m3u8', null), 'h264,1080,1920');
});
