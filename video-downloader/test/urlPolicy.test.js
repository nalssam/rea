import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createUrlPolicy, MAX_URL_LENGTH } from '../src/urlPolicy.js';

const policy = createUrlPolicy();
const code = (fn) => {
  try {
    fn();
  } catch (error) {
    return error.code;
  }
  return 'accepted';
};

test('allows the supported hosts and detects the platform', () => {
  const cases = [
    ['https://www.youtube.com/watch?v=abc', 'youtube'],
    ['https://youtube.com/shorts/abc', 'youtube'],
    ['https://m.youtube.com/watch?v=abc', 'youtube'],
    ['https://music.youtube.com/watch?v=abc', 'youtube'],
    ['https://youtu.be/abc', 'youtube'],
    ['https://www.youtube-nocookie.com/embed/abc', 'youtube'],
    ['https://www.instagram.com/reel/abc/', 'instagram'],
    ['https://instagram.com/p/abc/', 'instagram'],
    ['https://www.threads.net/@user/post/abc', 'threads'],
    ['https://www.threads.com/@user/post/abc', 'threads'],
    ['https://www.facebook.com/watch/?v=123', 'facebook'],
    ['https://m.facebook.com/story.php?story_fbid=1', 'facebook'],
    ['https://fb.watch/abc/', 'facebook'],
    ['HTTPS://WWW.YouTube.COM/watch?v=abc', 'youtube'],
  ];
  for (const [url, platform] of cases) {
    assert.equal(policy.check(url).platform, platform, url);
  }
});

test('rejects suffix and prefix tricks', () => {
  for (const url of [
    'https://evilyoutube.com/watch?v=abc',
    'https://youtube.com.evil.com/watch?v=abc',
    'https://youtube.com.evil/watch',
    'https://notinstagram.com/p/abc',
    'https://fb.watch.evil.org/abc',
    'https://xyoutu.be/abc',
    'https://youtube.co/watch',
    'https://example.com/?u=https://youtube.com/watch',
    'https://example.com/youtube.com/watch',
    'https://youtube.com@evil.com/watch',
  ]) {
    assert.notEqual(code(() => policy.check(url)), 'accepted', url);
  }
  assert.equal(code(() => policy.check('https://evilyoutube.com/watch?v=abc')), 'unsupported_site');
  assert.equal(code(() => policy.check('https://youtube.com.evil.com/watch?v=abc')), 'unsupported_site');
});

test('rejects http, other schemes, credentials, ports and IP literals', () => {
  assert.equal(code(() => policy.check('http://www.youtube.com/watch?v=abc')), 'invalid_url');
  assert.equal(code(() => policy.check('ftp://youtube.com/x')), 'invalid_url');
  assert.equal(code(() => policy.check('file:///etc/passwd')), 'invalid_url');
  assert.equal(code(() => policy.check('javascript:alert(1)')), 'invalid_url');
  assert.equal(code(() => policy.check('https://user:pw@www.youtube.com/watch?v=abc')), 'invalid_url');
  assert.equal(code(() => policy.check('https://user@www.youtube.com/watch?v=abc')), 'invalid_url');
  assert.equal(code(() => policy.check('https://www.youtube.com:8443/watch?v=abc')), 'unsupported_site');
  for (const url of [
    'https://127.0.0.1/x',
    'https://2130706433/x',
    'https://0x7f.0.0.1/x',
    'https://[::1]/x',
    'https://[::ffff:127.0.0.1]/x',
    'https://169.254.169.254/latest/meta-data',
  ]) {
    assert.equal(code(() => policy.check(url)), 'invalid_url', url);
  }
  assert.equal(code(() => policy.check('https://localhost/x')), 'unsupported_site');
  assert.equal(code(() => policy.check('https://youtube.com./watch')), 'invalid_url');
});

test('rejects malformed input and over-long URLs', () => {
  for (const value of [undefined, null, 42, {}, '', '   ', 'not a url', 'youtube.com/watch?v=abc', 'https://', 'https://www.youtube.com/watch?v=a b', 'https://www.youtube.com/\nwatch']) {
    assert.equal(code(() => policy.check(value)), 'invalid_url', String(value));
  }
  const long = `https://www.youtube.com/watch?v=${'a'.repeat(MAX_URL_LENGTH)}`;
  assert.equal(code(() => policy.check(long)), 'invalid_url');
});

test('normalizes: lower-cases the host, drops the fragment and share-tracking parameters', () => {
  assert.equal(policy.check('  https://YouTu.be/abc?si=XYZ&t=10#frag ').url, 'https://youtu.be/abc?t=10');
  assert.equal(
    policy.check('https://www.youtube.com/watch?v=abc&feature=share&utm_source=x').url,
    policy.check('https://www.youtube.com/watch?v=abc').url,
  );
  assert.equal(policy.check('https://www.instagram.com/reel/abc/?igsh=zzz').url, 'https://www.instagram.com/reel/abc/');
});

test('EXTRA_ALLOWED_HOSTS permits exact hosts (optionally with port, also over http)', () => {
  const extra = createUrlPolicy({ extraAllowedHosts: ['127.0.0.1:8080', 'media.example.org'] });
  assert.deepEqual(extra.check('http://127.0.0.1:8080/a.mp4'), { url: 'http://127.0.0.1:8080/a.mp4', platform: 'other', shortlink: false });
  assert.deepEqual(extra.extraHosts(), ['127.0.0.1:8080', 'media.example.org']);
  assert.equal(extra.allowsExtraEndpoint('127.0.0.1', 8080), true);
  assert.equal(extra.allowsExtraEndpoint('127.0.0.1', 8081), false);
  assert.equal(extra.allowsExtraEndpoint('media.example.org', 443), true);
  assert.equal(extra.allowsExtraEndpoint('media.example.org', 80), true);
  assert.equal(extra.allowsExtraEndpoint('media.example.org', 8443), false);
  assert.equal(extra.allowsExtraEndpoint('sub.media.example.org', 443), false);
  assert.equal(code(() => extra.check('http://127.0.0.1:8081/a.mp4')), 'invalid_url');
  assert.equal(code(() => extra.check('http://127.0.0.1/a.mp4')), 'invalid_url');
  assert.equal(extra.check('https://media.example.org/a.mp4').platform, 'other');
  assert.equal(extra.check('http://media.example.org/a.mp4').platform, 'other');
  assert.equal(code(() => extra.check('https://sub.media.example.org/a.mp4')), 'unsupported_site');
  assert.equal(code(() => extra.check('https://media.example.org:444/a.mp4')), 'unsupported_site');
  assert.equal(code(() => extra.check('https://u:p@media.example.org/a.mp4')), 'invalid_url');
  assert.equal(extra.check('https://www.youtube.com/watch?v=abc').platform, 'youtube');
  assert.throws(() => createUrlPolicy({ extraAllowedHosts: ['bad host/path'] }));
});

test('share short links are marked: only they need redirect following', () => {
  const shortlink = (url) => policy.check(url).shortlink;
  assert.equal(shortlink('https://fb.watch/abc123/'), true);
  assert.equal(shortlink('https://www.facebook.com/share/v/1AbCdEf/'), true);
  assert.equal(shortlink('https://www.facebook.com/share/r/1AbCdEf/'), true);
  assert.equal(shortlink('https://www.instagram.com/share/reel/abc'), true);
  assert.equal(shortlink('https://www.facebook.com/watch/?v=123'), false);
  assert.equal(shortlink('https://l.facebook.com/l.php?u=https%3A%2F%2Fevil.example'), false, 'a redirector is not a share link');
  assert.equal(shortlink('https://www.instagram.com/reel/abc/'), false);
  assert.equal(shortlink('https://youtu.be/abc'), false);
  assert.equal(shortlink('https://www.youtube.com/share/x'), false);
  assert.equal(shortlink('https://www.threads.net/@a/post/b'), false);
});
