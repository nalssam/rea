// Runs the real entry point (server.js) as a child process to check its exit paths.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createTempDirs } from '../src/tempDirs.js';
import { FAKE_YTDLP, isAlive, until, yt } from './helpers.js';

const SERVER = fileURLToPath(new URL('../server.js', import.meta.url));

async function startServer(scratch) {
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, YTDLP_PATH: FAKE_YTDLP, PORT: '0', HOST: '127.0.0.1', FAKE_PID_DIR: join(scratch, 'pids'), FAKE_ARGV_LOG: join(scratch, 'argv.log'), TMPDIR: join(scratch, 'tmp') },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  let out = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => (out += chunk));
  await until(() => /http:\/\/127\.0\.0\.1:\d+/.test(out), 10_000, 'server did not start');
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  return { child, base: /http:\/\/127\.0\.0\.1:\d+/.exec(out)[0], exited };
}

for (const signal of ['SIGHUP', 'SIGQUIT', 'SIGTERM']) {
  test(`${signal} stops the server without orphaned downloads or temp dirs`, async (t) => {
    const scratch = mkdtempSync(join(tmpdir(), 'moabatgi-test-server-'));
    mkdirSync(join(scratch, 'tmp'));
    t.after(() => rmSync(scratch, { recursive: true, force: true }));
    const { child, base, exited } = await startServer(scratch);
    t.after(() => child.kill('SIGKILL'));

    const post = (v) => fetch(`${base}/api/jobs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: yt(v), format: 'video' }) });
    const ready = await (await post('ok')).json();
    assert.equal((await post('hang')).status, 202);
    const pidFiles = () => (existsSync(join(scratch, 'pids')) ? readdirSync(join(scratch, 'pids')) : []);
    const pids = () => pidFiles().flatMap((f) => JSON.parse(readFileSync(join(scratch, 'pids', f), 'utf8')).pids);
    await until(() => pids().length === 2, 10_000, 'the hanging download (with its grandchild) should be running');
    await until(async () => (await (await fetch(`${base}/api/jobs/${ready.id}`)).json()).status === 'ready', 10_000);
    assert.equal(readdirSync(join(scratch, 'tmp')).length, 2, 'one temp dir per job');

    const running = pids();
    child.kill(signal);
    assert.deepEqual(await exited, { code: 0, signal: null }, 'clean exit through the shutdown path');
    await until(() => running.every((pid) => !isAlive(pid)), 5000, 'yt-dlp process groups must not outlive the server');
    assert.deepEqual(readdirSync(join(scratch, 'tmp')), [], 'temp dirs are removed');
  });
}

test('startup sweep removes only old, untracked directories of our own naming', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'moabatgi-test-sweep-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const old = new Date(Date.now() - 3_600_000);
  const make = (name, aged) => {
    mkdirSync(join(root, name));
    if (aged) utimesSync(join(root, name), old, old);
  };
  make('moabatgi-Ab12Cd', true); // stale leftover
  make('moabatgi-Zz99Yy', false); // fresh: maybe another instance's live download
  make('moabatgi-test-keepme', true); // not our naming pattern
  make('unrelated', true);
  const dirs = createTempDirs({ root });
  const mine = await dirs.create();
  utimesSync(mine, old, old);

  assert.equal(await dirs.sweepStale(1_800_000), 1);
  assert.deepEqual(readdirSync(root).sort(), ['moabatgi-Zz99Yy', 'moabatgi-test-keepme', mine.split('/').at(-1), 'unrelated'].sort());
  dirs.removeAllSync();
});
