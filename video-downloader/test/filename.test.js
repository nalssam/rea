import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildFilename, contentDisposition, mediaContentType, sanitizeBasename } from '../src/filename.js';

test('removes path separators, control characters and reserved characters', () => {
  assert.equal(sanitizeBasename('a/b\\c:d*e?f"g<h>i|j'), 'a b c d e f g h i j');
  assert.equal(sanitizeBasename('line1\nline2\ttab\u0000nul‮rtl'), 'line1 line2 tab nul rtl');
  assert.equal(sanitizeBasename('../../etc/passwd'), 'etc passwd');
  assert.equal(sanitizeBasename('  ..hidden..  '), 'hidden');
  for (const name of ['../../x', 'a/b', 'c\\d', '..']) {
    const out = sanitizeBasename(name);
    assert.ok(!/[\\/]/.test(out) && !out.startsWith('.'), out);
  }
});

test('keeps Korean text and emoji, and falls back when nothing is left', () => {
  assert.equal(sanitizeBasename('한글 제목 🎬 (공식)'), '한글 제목 🎬 (공식)');
  assert.equal(sanitizeBasename(''), 'video');
  assert.equal(sanitizeBasename('///'), 'video');
  assert.equal(sanitizeBasename(undefined), 'video');
  assert.equal(sanitizeBasename('CON'), 'video');
});

test('trims long titles by code point without splitting surrogate pairs', () => {
  const out = sanitizeBasename('🎬'.repeat(500));
  assert.equal(Array.from(out).length, 120);
  assert.ok(!/[\ud800-\udbff]$/.test(out));
  assert.equal(buildFilename('가'.repeat(300), 'mp4'), `${'가'.repeat(120)}.mp4`);
});

test('buildFilename appends a clean extension', () => {
  assert.equal(buildFilename('My: Video', 'mp4'), 'My Video.mp4');
  assert.equal(buildFilename('노래', 'MP3'), '노래.mp3');
  assert.equal(buildFilename(null, 'mp4'), 'video.mp4');
});

test('Content-Disposition carries an ASCII fallback and RFC 5987 filename*', () => {
  const header = contentDisposition('한글 제목 "a" (1).mp4');
  assert.match(header, /^attachment; filename="[\x20-\x7e]+\.mp4"; filename\*=UTF-8''[A-Za-z0-9%._~!-]+$/);
  const encoded = header.split("filename*=UTF-8''")[1];
  assert.equal(decodeURIComponent(encoded), '한글 제목 "a" (1).mp4');
  assert.ok(!header.slice(header.indexOf('filename="') + 10, header.indexOf('";')).includes('"'));
  assert.equal(contentDisposition('한글.mp3').split(';')[1].trim(), 'filename="download.mp3"');
  assert.equal(contentDisposition('plain name.mp4'), `attachment; filename="plain name.mp4"; filename*=UTF-8''plain%20name.mp4`);
});

test('content types', () => {
  assert.equal(mediaContentType('mp4'), 'video/mp4');
  assert.equal(mediaContentType('mp3'), 'audio/mpeg');
  assert.equal(mediaContentType('xyz'), 'application/octet-stream');
});
