// The page's pure logic (public/app.js exposes it as globalThis.MoaLogic; no DOM needed).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createUrlPolicy } from '../src/urlPolicy.js';

await import('../public/app.js');
const { extractUrls, normalizeUrl, pickHeight } = globalThis.MoaLogic;

test('extractUrls finds links inside free text, also when Korean text is glued to them', () => {
  assert.deepEqual(
    extractUrls('https://youtu.be/dQw4w9WgXcQ이랑 https://youtu.be/9bZkp7q19f0도 받아줘'),
    ['https://youtu.be/dQw4w9WgXcQ', 'https://youtu.be/9bZkp7q19f0'],
  );
  assert.deepEqual(extractUrls('이거(https://www.youtube.com/watch?v=abc_-123)입니다.그리고 https://fb.watch/xY1/요!'), ['https://www.youtube.com/watch?v=abc_-123', 'https://fb.watch/xY1/']);
  assert.deepEqual(extractUrls('a https://youtu.be/a,https://youtu.be/b\nhttps://youtu.be/c.'), ['https://youtu.be/a', 'https://youtu.be/b', 'https://youtu.be/c']);
  assert.deepEqual(extractUrls('https://www.threads.net/@사용자/post/Cabc'), ['https://www.threads.net/@사용자/post/Cabc'], 'Hangul inside the URL is kept');
  assert.deepEqual(extractUrls('youtube.com/watch?v=abc 그냥 글자'), []);
});

test('dedup key: same video in different shapes is one, different playlists are not', () => {
  const key = (url) => normalizeUrl(url).key;
  assert.equal(key('https://youtu.be/dQw4w9WgXcQ?t=10'), key('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLx&index=3'));
  assert.equal(key(extractUrls('https://youtu.be/dQw4w9WgXcQ이랑')[0]), key('https://m.youtube.com/watch?v=dQw4w9WgXcQ'));
  assert.notEqual(key('https://www.youtube.com/playlist?list=PLaaa'), key('https://www.youtube.com/playlist?list=PLbbb'));
  assert.equal(key('https://www.youtube.com/playlist?list=PLaaa&si=x'), key('https://www.youtube.com/playlist?list=PLaaa'));
});

test('the page pre-check agrees with the server policy, including EXTRA_ALLOWED_HOSTS', () => {
  const policy = createUrlPolicy({ extraAllowedHosts: ['127.0.0.1:3414', 'media.example.org'] });
  const extraHosts = policy.extraHosts();
  const serverAccepts = (url) => {
    try {
      policy.check(url);
      return true;
    } catch {
      return false;
    }
  };
  for (const url of [
    'http://127.0.0.1:3414/clip1.mp4',
    'http://127.0.0.1:3415/clip1.mp4',
    'http://127.0.0.1/clip1.mp4',
    'https://media.example.org/a.mp4',
    'http://media.example.org/a.mp4',
    'https://media.example.org:8443/a.mp4',
    'https://sub.media.example.org/a.mp4',
    'https://www.youtube.com/watch?v=abc',
    'https://evilyoutube.com/watch?v=abc',
    'https://youtube.com.evil.com/watch?v=abc',
    'https://vimeo.com/1',
    'https://www.instagram.com/reel/abc/',
    'https://www.threads.com/@a/post/b',
    'https://fb.watch/abc/',
  ]) {
    assert.equal(normalizeUrl(url, extraHosts).ok, serverAccepts(url), url);
  }
  assert.equal(normalizeUrl('http://127.0.0.1:3414/clip1.mp4', []).ok, false, 'unknown hosts stay rejected without the server list');
});

test('pickHeight falls back to the nearest quality not above the choice', () => {
  assert.equal(pickHeight([1080, 720, 480], 720), 720);
  assert.equal(pickHeight([1080, 480], 720), 480);
  assert.equal(pickHeight([1080], 720), 1080);
  assert.equal(pickHeight([], 720), null);
});
