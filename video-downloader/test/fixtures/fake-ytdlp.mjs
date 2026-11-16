#!/usr/bin/env node
// Test double for yt-dlp. Behaviour is chosen by the `v` query parameter of the URL:
//   ok | unicode | audioonly | fail | big | hang | infohang | playlist | nofile
// It understands only the flags the server actually passes.

import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
if (process.env.FAKE_ARGV_LOG) appendFileSync(process.env.FAKE_ARGV_LOG, `${JSON.stringify(argv)}\n`);

const dashDash = argv.indexOf('--');
const url = new URL(argv[dashDash + 1]);
const scenario = url.searchParams.get('v') ?? 'ok';
const opt = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 && i < dashDash ? argv[i + 1] : null;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = (line) => process.stdout.write(`${line}\n`);

function recordPids(extra = []) {
  const dir = process.env.FAKE_PID_DIR;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${process.pid}.json`), JSON.stringify({ pids: [process.pid, ...extra], url: url.href }));
}

function hangForever() {
  // A grandchild proves that the whole process group is killed, not just this process.
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  recordPids([child.pid]);
  setInterval(() => {}, 1000);
}

const TITLES = { unicode: '한글/제목: "테스트" <1>? 🎬', ok: 'Fake Video Title' };
const title = TITLES[scenario] ?? `Fake ${scenario}`;

if (scenario === 'fail') {
  process.stderr.write('WARNING: something harmless\n');
  process.stderr.write('ERROR: [youtube] abc: Private video. Sign in if you\'ve been granted access to this video\n');
  process.exit(1);
}

if (argv.includes('--dump-single-json')) {
  if (scenario === 'infohang') {
    hangForever();
  } else {
    const entry = {
      id: 'abc',
      title,
      uploader: 'Fake Uploader',
      duration: 62.4,
      thumbnail: 'https://i.example.com/thumb.jpg',
      formats: [
        { format_id: '140', ext: 'm4a', vcodec: 'none', acodec: 'mp4a.40.2' },
        { format_id: '18', ext: 'mp4', height: 360, vcodec: 'avc1.42001E', acodec: 'mp4a.40.2' },
        { format_id: '136', ext: 'mp4', height: 720, vcodec: 'avc1.4d401f', acodec: 'none' },
        { format_id: '137', ext: 'mp4', height: 1080, vcodec: 'avc1.640028', acodec: 'none' },
        { format_id: '313', ext: 'webm', height: 2160, vcodec: 'vp9', acodec: 'none' },
      ],
    };
    out(JSON.stringify(scenario === 'playlist' ? { _type: 'playlist', entries: [entry] } : entry));
  }
} else {
  const dir = opt('--paths');
  const audio = argv.includes('--extract-audio');
  const formatSelector = opt('--format');
  if (scenario === 'big') {
    out('[download] File is larger than max-filesize (999999999 bytes > 1048576 bytes). Aborting.');
    process.exit(0);
  }
  out('[youtube] Extracting URL: (fake)');
  out(`MOA|meta|${JSON.stringify({ title, format_id: audio ? '140' : '137+140' })}`);
  if (scenario === 'hang') {
    out('MOA|dl|downloading|420|1000|NA');
    writeFileSync(join(dir, 'media.f137.mp4.part'), 'partial');
    hangForever();
  } else {
    const parts = audio ? 1 : 2;
    for (let part = 0; part < parts; part += 1) {
      for (const done of [250, 500, 1000]) {
        out(`MOA|dl|downloading|${done}|1000|NA`);
        await sleep(15);
      }
      out('MOA|dl|finished|1000|1000|NA');
    }
    out(`MOA|pp|started|${audio ? 'ExtractAudio' : 'Merger'}`);
    await sleep(40);
    out(`MOA|pp|finished|${audio ? 'ExtractAudio' : 'Merger'}`);
    const file = join(dir, audio ? 'media.mp3' : 'media.mp4');
    if (scenario !== 'nofile') {
      writeFileSync(file, `FAKE-${audio ? 'AUDIO' : 'VIDEO'}|${formatSelector}|${url.href}`);
      out('MOA|pp|started|MoveFiles');
      out('MOA|pp|finished|MoveFiles');
      out(`MOA|file|${JSON.stringify(file)}`);
    }
  }
}
