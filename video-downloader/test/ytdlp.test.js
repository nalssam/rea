import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../src/config.js';
import { buildDownloadArgs, buildInfoArgs, classifyFailure, createProgressTracker, extractorSpec, parseDownloadLine, parseInfo, videoFormatSelector } from '../src/ytdlp.js';

const config = loadConfig({ MAX_HEIGHT: '1080', MAX_FILE_MB: '500' });
const at = (args, flag) => args[args.indexOf(flag) + 1];

test('argv: safety flags are present and the URL is the only thing after "--"', () => {
  const url = 'https://www.youtube.com/watch?v=abc';
  for (const args of [buildInfoArgs(config, { url, platform: 'youtube' }), buildDownloadArgs(config, { url, platform: 'youtube', format: 'video', height: 720, dir: '/tmp/x' })]) {
    assert.deepEqual(args.slice(-2), ['--', url]);
    assert.equal(args.filter((a) => a === '--').length, 1);
    for (const flag of ['--ignore-config', '--no-playlist', '--no-exec', '--no-cache-dir', '--no-plugin-dirs', '--socket-timeout']) {
      assert.ok(args.includes(flag), flag);
    }
    assert.ok(args.every((a) => typeof a === 'string'));
  }
});

test('argv: video is capped by requested height and MAX_HEIGHT and merged to mp4', () => {
  const base = { url: 'https://youtu.be/a', platform: 'youtube', dir: '/tmp/x' };
  const v720 = buildDownloadArgs(config, { ...base, format: 'video', height: 720 });
  assert.equal(at(v720, '--format'), videoFormatSelector(720));
  assert.equal(at(v720, '--merge-output-format'), 'mp4');
  assert.equal(at(v720, '--max-filesize'), '500M');
  assert.equal(at(v720, '--paths'), '/tmp/x');
  assert.ok(!v720.includes('--extract-audio'));
  assert.equal(at(buildDownloadArgs(config, { ...base, format: 'video', height: 2160 }), '--format'), videoFormatSelector(1080));
  assert.equal(at(buildDownloadArgs(config, { ...base, format: 'video', height: null }), '--format'), videoFormatSelector(1080));
  const selector = videoFormatSelector(480);
  assert.ok(selector.startsWith('bv*[aspect_ratio>=?1][height<=480][vcodec^=avc1]+ba[acodec^=mp4a]/bv*[aspect_ratio<1][width<=480][vcodec^=avc1]+ba[acodec^=mp4a]/'));
  for (const alternative of selector.split('/')) {
    assert.match(alternative, /\[aspect_ratio>=\?1\]\[height<=\??480\]|\[aspect_ratio<1\]\[width<=480\]/, `capped on the short side: ${alternative}`);
  }

  const audio = buildDownloadArgs(config, { ...base, format: 'audio' });
  assert.ok(audio.includes('--extract-audio'));
  assert.equal(at(audio, '--audio-format'), 'mp3');
  assert.ok(!audio.includes('--merge-output-format'));
});

test('parses machine-readable progress lines and ignores everything else', () => {
  assert.deepEqual(parseDownloadLine('MOA|dl|downloading|1024|29731|NA'), { type: 'dl', status: 'downloading', downloaded: 1024, total: 29731 });
  assert.deepEqual(parseDownloadLine('MOA|dl|downloading|10|NA|200.5'), { type: 'dl', status: 'downloading', downloaded: 10, total: 200.5 });
  assert.deepEqual(parseDownloadLine('MOA|dl|downloading|NA|NA|NA'), { type: 'dl', status: 'downloading', downloaded: null, total: null });
  assert.deepEqual(parseDownloadLine('MOA|pp|started|Merger'), { type: 'pp', status: 'started', name: 'Merger' });
  assert.deepEqual(parseDownloadLine('MOA|meta|{"title": "a|b", "format_id": "137+140"}'), { type: 'meta', title: 'a|b', parts: 2 });
  assert.deepEqual(parseDownloadLine('MOA|file|"/tmp/x/media.mp4"'), { type: 'file', path: '/tmp/x/media.mp4' });
  assert.deepEqual(parseDownloadLine('[download] File is larger than max-filesize (2 bytes > 1 bytes). Aborting.'), { type: 'too_large' });
  assert.equal(parseDownloadLine('[youtube] Extracting URL'), null);
  assert.deepEqual(parseDownloadLine('[download] Some title does not pass filter (!is_live), skipping ..'), { type: 'filtered' });
  assert.equal(parseDownloadLine('MOA|meta|{broken'), null);
  assert.equal(parseDownloadLine('MOA|unknown|x'), null);
});

test('progress tracker: two parts share 0..99, conversions switch to processing', () => {
  const tracker = createProgressTracker();
  const feed = (line) => tracker.feed(parseDownloadLine(line));
  feed('MOA|meta|{"title": "T", "format_id": "137+140"}');
  feed('MOA|dl|downloading|500|1000|NA');
  assert.equal(tracker.state.progress, 25);
  feed('MOA|dl|finished|1000|1000|NA');
  assert.equal(tracker.state.progress, 50);
  feed('MOA|dl|downloading|100|1000|NA');
  assert.equal(tracker.state.progress, 55);
  feed('MOA|dl|finished|1000|1000|NA');
  assert.equal(tracker.state.progress, 99, 'never 100 before the file is ready');
  assert.equal(tracker.state.bytes, 2000);
  assert.equal(tracker.state.status, 'downloading');
  feed('MOA|pp|started|MoveFiles');
  assert.equal(tracker.state.status, 'downloading');
  feed('MOA|pp|started|Merger');
  assert.equal(tracker.state.status, 'processing');
  feed('MOA|file|"/tmp/x/media.mp4"');
  assert.equal(tracker.state.filePath, '/tmp/x/media.mp4');
  assert.equal(tracker.state.title, 'T');
});

test('progress tracker: unknown totals give null progress', () => {
  const tracker = createProgressTracker();
  tracker.feed(parseDownloadLine('MOA|dl|downloading|500|NA|NA'));
  assert.equal(tracker.state.progress, null);
  assert.equal(tracker.state.bytes, 500);
});

test('parseInfo: heights are unique, descending, capped; thumbnails must be https', () => {
  const info = parseInfo(
    {
      title: '  Title  ',
      channel: 'Chan',
      duration: 61.6,
      thumbnail: 'http://insecure.example/t.jpg',
      formats: [
        { height: 2160, vcodec: 'vp9' },
        { height: 1080, vcodec: 'avc1' },
        { height: 1080, vcodec: 'vp9' },
        { height: 360, vcodec: 'avc1' },
        { height: 720, vcodec: 'avc1' },
        { height: null, vcodec: 'none' },
        { height: 480, vcodec: 'none' },
      ],
    },
    1080,
  );
  assert.deepEqual(info, { title: 'Title', uploader: 'Chan', durationSeconds: 62, thumbnail: null, heights: [1080, 720, 360], audio: true });
  assert.deepEqual(parseInfo({ title: 'x', formats: [{ height: 720, vcodec: 'avc1' }] }, 480).heights, []);
  // Portrait video: the "p" value is the short side, so a 1080x1920 Reel is offered as 1080p.
  const portrait = [[480, 854], [720, 1280], [1080, 1920], [2160, 3840]].map(([width, height]) => ({ width, height, vcodec: 'avc1' }));
  assert.deepEqual(parseInfo({ formats: portrait }, 1080).heights, [1080, 720, 480]);
  assert.deepEqual(parseInfo({ width: 1080, height: 1920 }, 1080).heights, [1080], 'single-format entry');
  assert.deepEqual(parseInfo({ formats: [{ width: 1920, height: 1080, vcodec: 'avc1' }] }, 1080).heights, [1080]);
  assert.equal(parseInfo({ thumbnail: 'https://i.example/t.jpg' }, 1080).thumbnail, 'https://i.example/t.jpg');
  assert.equal(parseInfo({}, 1080).title, '제목 없음');
  assert.equal(parseInfo({}, 1080).durationSeconds, null);
  assert.equal(parseInfo({ _type: 'playlist', entries: [{ title: 'first' }] }, 1080).title, 'first');
  assert.throws(() => parseInfo({ entries: [] }, 1080), { code: 'extract_failed' });
  assert.throws(() => parseInfo({ is_live: true }, 1080), { code: 'extract_failed' });
  assert.throws(() => parseInfo(null, 1080), { code: 'extract_failed' });
});

test('classifyFailure never exposes raw yt-dlp text', () => {
  const secret = 'ERROR: [youtube] SECRETID: Private video. Sign in';
  const error = classifyFailure({ errorLines: [secret] });
  assert.equal(error.code, 'extract_failed');
  assert.ok(!error.message.includes('SECRETID'));
  const bot = classifyFailure({ errorLines: ['ERROR: [youtube] x: Sign in to confirm you’re not a bot. Use --cookies'] });
  assert.equal(bot.status, 503);
  assert.match(bot.message, /차단/);
  assert.equal(classifyFailure({ tooLarge: true }).code, 'too_large');
  assert.equal(classifyFailure({ timedOut: true }).status, 504);
  assert.equal(classifyFailure({ errorLines: ['ERROR: weird'] }).code, 'extract_failed');
});

test('remote text inside a line can never fake a size or live-stream refusal', () => {
  // Reported by review: an uploader-controlled title used to fail the job as too_large / live.
  const hostile = ['Why my file is larger than max-filesize allows', 'this does not pass filter (!is_live), skipping ..'];
  for (const title of hostile) {
    const tracker = createProgressTracker();
    for (const line of [
      `MOA|meta|${JSON.stringify({ title, format_id: '18' })}`,
      `[info] abc: ${title}`,
      `[download] Destination: ${title}`,
      `${title}`,
    ]) {
      tracker.feed(parseDownloadLine(line));
    }
    assert.equal(tracker.state.tooLarge, false, title);
    assert.equal(tracker.state.title, title);
  }
  const filtered = createProgressTracker();
  filtered.feed(parseDownloadLine('[info] x: File is larger than max-filesize (2 bytes > 1 bytes). Aborting.'));
  assert.equal(filtered.state.tooLarge, false, 'only the exact [download] notice counts');
});

test('extractors are limited per platform; the generic one only where nothing else can work', () => {
  assert.equal(extractorSpec({ platform: 'youtube' }), 'youtube.*');
  assert.equal(extractorSpec({ platform: 'instagram' }), 'instagram.*');
  assert.equal(extractorSpec({ platform: 'facebook' }), 'facebook.*');
  assert.equal(extractorSpec({ platform: 'facebook', shortlink: true }), 'facebook.*,generic');
  assert.equal(extractorSpec({ platform: 'instagram', shortlink: true }), 'instagram.*,generic');
  assert.equal(extractorSpec({ platform: 'threads' }), 'generic');
  assert.equal(extractorSpec({ platform: 'other' }), null);
  assert.throws(() => extractorSpec({ platform: 'vimeo' }), TypeError, 'an unknown platform never falls back to "everything"');

  const target = { url: 'https://www.youtube.com/watch?v=abc', platform: 'youtube' };
  const info = buildInfoArgs(config, target, 'http://127.0.0.1:9');
  assert.equal(at(info, '--use-extractors'), 'youtube.*');
  assert.equal(at(info, '--proxy'), 'http://127.0.0.1:9');
  const download = buildDownloadArgs(config, { ...target, format: 'audio', dir: '/tmp/x' }, 'http://127.0.0.1:9');
  assert.equal(at(download, '--use-extractors'), 'youtube.*');
  assert.equal(at(download, '--proxy'), 'http://127.0.0.1:9');
  assert.ok(!buildInfoArgs(config, { url: 'http://media.test/a.mp4', platform: 'other' }).includes('--use-extractors'));
  assert.ok(!buildInfoArgs(config, target).includes('--proxy'), 'no proxy flag when the guard is off');
});

test('the server\'s own Node binary is the default JS runtime for yt-dlp', () => {
  const args = (env) => buildInfoArgs(loadConfig(env, { execPath: '/opt/node/bin/node' }), { url: 'https://youtu.be/a', platform: 'youtube' });
  assert.equal(at(args({}), '--js-runtimes'), 'node:/opt/node/bin/node');
  assert.ok(args({}).includes('--no-js-runtimes'));
  assert.equal(at(args({ YTDLP_JS_RUNTIMES: 'deno:/usr/bin/deno' }), '--js-runtimes'), 'deno:/usr/bin/deno');
  assert.ok(!args({ YTDLP_JS_RUNTIMES: 'auto' }).includes('--js-runtimes'));
});

test('a Threads failure says that Threads support is experimental', () => {
  const lines = ['ERROR: Unsupported URL: https://www.threads.net/@a/post/b'];
  assert.match(classifyFailure({ errorLines: lines, platform: 'threads' }).message, /Threads/);
  assert.doesNotMatch(classifyFailure({ errorLines: lines, platform: 'facebook' }).message, /Threads/);
  assert.equal(classifyFailure({ errorLines: ['ERROR: No suitable extractor found for URL https://l.facebook.com/l.php'], platform: 'facebook' }).message, classifyFailure({ errorLines: lines }).message);
});
