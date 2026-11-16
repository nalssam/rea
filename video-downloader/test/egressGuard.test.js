import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { connect } from 'node:net';
import { test } from 'node:test';
import { createEgressGuard, isNonPublicAddress } from '../src/egressGuard.js';
import { createUrlPolicy } from '../src/urlPolicy.js';

test('non-public addresses are recognised in every spelling', () => {
  for (const address of ['127.0.0.1', '127.8.9.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0',
    '224.0.0.1', '255.255.255.255', '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '64:ff9b::7f00:1', 'not-an-ip', '']) {
    assert.equal(isNonPublicAddress(address), true, address);
  }
  for (const address of ['8.8.8.8', '142.250.0.1', '172.32.0.1', '100.63.255.255', '2606:4700:4700::1111', '::ffff:8.8.8.8']) {
    assert.equal(isNonPublicAddress(address), false, address);
  }
});

function guardWith({ extra = [], names = {}, upstream } = {}) {
  const policy = createUrlPolicy({ extraAllowedHosts: extra });
  return createEgressGuard({
    allowsExtraEndpoint: policy.allowsExtraEndpoint,
    upstream,
    resolve: async (hostname) => {
      if (!(hostname in names)) throw new Error('ENOTFOUND');
      return names[hostname].map((address) => ({ address }));
    },
  });
}

test('decide: public destinations on web ports only; operator extras are exact', async (t) => {
  const guard = guardWith({
    extra: ['127.0.0.1:8080', 'intranet.test'],
    names: { 'cdn.test': ['93.184.216.34'], 'rebind.test': ['93.184.216.34', '127.0.0.1'], 'meta.test': ['169.254.169.254'], 'intranet.test': ['10.0.0.5'] },
  });
  t.after(() => guard.close());
  const verdict = async (host, port, scheme = 'https') => (await guard.decide(host, port, scheme)).allowed;

  assert.deepEqual(await guard.decide('cdn.test', 443, 'https'), { allowed: true, address: '93.184.216.34', via: null }, 'the checked address is the one connected to');
  assert.equal(await verdict('CDN.test.', 80, 'http'), true);
  assert.equal(await verdict('cdn.test', 8443), false, 'no arbitrary ports');
  assert.equal(await verdict('cdn.test', 22), false);
  assert.equal(await verdict('rebind.test', 443), false, 'one private answer is enough to refuse');
  assert.equal(await verdict('meta.test', 80, 'http'), false);
  assert.equal(await verdict('unknown.test', 443), false, 'unresolvable is not public');
  for (const host of ['127.0.0.1', '169.254.169.254', '10.0.0.1', '[::1]', '[::ffff:127.0.0.1]', 'localhost']) {
    assert.equal(await verdict(host, 80, 'http'), false, host);
    assert.equal(await verdict(host, 443), false, host);
  }
  assert.equal(await verdict('8.8.8.8', 443), true);

  assert.deepEqual(await guard.decide('127.0.0.1', 8080, 'http'), { allowed: true, address: '127.0.0.1', via: null });
  assert.equal(await verdict('127.0.0.1', 8081, 'http'), false, 'another port of an allowed host stays closed');
  assert.deepEqual(await guard.decide('intranet.test', 443, 'https'), { allowed: true, address: '10.0.0.5', via: null });
  assert.equal(await verdict('intranet.test', 8443), false);
});

test('decide: with an upstream proxy, checks still run and private targets are never forwarded', async (t) => {
  const guard = guardWith({ names: { 'cdn.test': ['93.184.216.34'], 'meta.test': ['169.254.169.254'] }, upstream: { https: 'http://user:pw@127.0.0.1:3128', http: null } });
  t.after(() => guard.close());
  const viaProxy = await guard.decide('cdn.test', 443, 'https');
  assert.equal(viaProxy.allowed, true);
  assert.deepEqual(viaProxy.via, { host: '127.0.0.1', port: 3128, auth: `Basic ${Buffer.from('user:pw').toString('base64')}` });
  assert.equal((await guard.decide('only-upstream-knows.test', 443, 'https')).allowed, true, 'names only the upstream can resolve are its responsibility');
  assert.equal((await guard.decide('only-upstream-knows.test', 80, 'http')).allowed, false, 'no upstream for plain http: must resolve here');
  assert.equal((await guard.decide('meta.test', 443, 'https')).allowed, false);
  assert.equal((await guard.decide('127.0.0.1', 443, 'https')).allowed, false);
  assert.throws(() => guardWith({ upstream: { https: 'socks5://127.0.0.1:1080' } }), /EGRESS_GUARD/);
});

test('the proxy forwards allowed requests and answers 403 for everything else', async (t) => {
  const hits = [];
  const target = createServer((req, res) => {
    hits.push(`${req.method} ${req.url} host=${req.headers.host}`);
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('hello');
  });
  await new Promise((resolve) => target.listen(0, '127.0.0.1', resolve));
  const allowedPort = target.address().port;
  const secret = createServer((req, res) => {
    hits.push('SECRET');
    res.end('secret');
  });
  await new Promise((resolve) => secret.listen(0, '127.0.0.1', resolve));
  const secretPort = secret.address().port;

  const guard = guardWith({ extra: [`127.0.0.1:${allowedPort}`] });
  const proxy = new URL(await guard.url());
  t.after(() => {
    guard.close();
    target.close();
    secret.close();
  });

  const viaProxy = (url) => new Promise((resolve, reject) => {
    const req = request({ host: proxy.hostname, port: proxy.port, method: 'GET', path: url, headers: { host: new URL(url).host, 'proxy-connection': 'keep-alive' } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
  const tunnel = (authority) => new Promise((resolve, reject) => {
    const socket = connect(Number(proxy.port), proxy.hostname, () => socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`));
    let data = '';
    socket.on('data', (chunk) => {
      data += chunk;
      if (data.includes('\r\n\r\n')) {
        const status = Number(data.slice(9, 12));
        if (status !== 200) {
          socket.destroy();
          resolve({ status });
          return;
        }
        socket.removeAllListeners('data');
        let reply = '';
        socket.on('data', (c) => {
          reply += c;
          if (reply.includes('hello')) {
            socket.destroy();
            resolve({ status, reply });
          }
        });
        socket.write(`GET /tunnelled HTTP/1.1\r\nHost: ${authority}\r\nConnection: close\r\n\r\n`);
      }
    });
    socket.on('error', reject);
  });

  assert.deepEqual(await viaProxy(`http://127.0.0.1:${allowedPort}/a?b=1`), { status: 200, body: 'hello' });
  assert.equal((await viaProxy(`http://127.0.0.1:${secretPort}/admin`)).status, 403);
  assert.equal((await viaProxy('http://169.254.169.254/latest/meta-data/')).status, 403);
  assert.equal((await viaProxy(`http://localhost:${secretPort}/`)).status, 403);
  assert.equal((await tunnel(`127.0.0.1:${allowedPort}`)).status, 200, 'CONNECT to an allowed endpoint is tunnelled');
  assert.equal((await tunnel(`127.0.0.1:${secretPort}`)).status, 403);
  assert.equal((await tunnel('[::1]:443')).status, 403);
  assert.equal((await tunnel('10.0.0.1:443')).status, 403);
  assert.deepEqual(hits, [`GET /a?b=1 host=127.0.0.1:${allowedPort}`, `GET /tunnelled host=127.0.0.1:${allowedPort}`]);
});
