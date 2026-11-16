import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/httpApp.js';

export const FAKE_YTDLP = fileURLToPath(new URL('./fixtures/fake-ytdlp.mjs', import.meta.url));

/** Starts the real HTTP app on an ephemeral port with the fake yt-dlp (unless overridden). */
export async function startApp(env = {}, options = {}) {
  const scratch = mkdtempSync(join(tmpdir(), 'moabatgi-test-'));
  const publicDir = join(scratch, 'public');
  const argvLog = join(scratch, 'argv.log');
  const pidDir = join(scratch, 'pids');
  mkdirSync(publicDir);
  writeFileSync(join(publicDir, 'index.html'), '<!doctype html><title>test</title>');
  writeFileSync(join(publicDir, 'app.js'), 'console.log(1);');
  writeFileSync(join(scratch, 'secret.txt'), 'outside the public root');
  // The fake reads these from the environment it inherits from this test process.
  process.env.FAKE_ARGV_LOG = argvLog;
  process.env.FAKE_PID_DIR = pidDir;

  const config = loadConfig({ YTDLP_PATH: FAKE_YTDLP, PORT: '0', HOST: '127.0.0.1', ...env });
  const app = createApp(config, { publicDir, ...options });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;

  async function api(method, path, body, headers = {}) {
    const res = await fetch(base + path, {
      method,
      headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try {
      json = text === '' ? null : JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { status: res.status, headers: res.headers, json, text };
  }

  return {
    app,
    base,
    api,
    scratch,
    argvLog() {
      try {
        return readFileSync(argvLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
      } catch {
        return [];
      }
    },
    pids() {
      try {
        return readdirSync(pidDir).flatMap((f) => JSON.parse(readFileSync(join(pidDir, f), 'utf8')).pids);
      } catch {
        return [];
      }
    },
    async waitFor(id, wanted, timeoutMs = 10_000) {
      const targets = Array.isArray(wanted) ? wanted : [wanted];
      const deadline = Date.now() + timeoutMs;
      let last;
      while (Date.now() < deadline) {
        last = (await api('GET', `/api/jobs/${id}`)).json;
        if (last && targets.includes(last.status)) return last;
        await sleep(25);
      }
      throw new Error(`job ${id} never reached ${targets.join('/')}; last = ${JSON.stringify(last)}`);
    },
    async stop() {
      await app.close();
      rmSync(scratch, { recursive: true, force: true });
    },
  };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function until(predicate, timeoutMs = 5000, message = 'condition not met in time') {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(20);
  }
  throw new Error(message);
}

export function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Sends a request whose path is NOT normalized by a URL parser (for traversal tests). */
export function rawGet(base, rawPath) {
  const { hostname, port } = new URL(base);
  return new Promise((resolve, reject) => {
    const req = request({ hostname, port, path: rawPath, method: 'GET' }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

export const yt = (v, extra = '') => `https://www.youtube.com/watch?v=${v}${extra}`;
