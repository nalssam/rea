// Owner of "where may yt-dlp connect". The URL policy only sees the link a user submits;
// yt-dlp then follows redirects, embeds and CDN URLs on its own. Every child is therefore
// started with --proxy pointing at this loopback forward proxy, which refuses any
// destination that is not on the public internet (SSRF guard) and pins the address it
// checked, so a DNS answer cannot change between the check and the connection.

import { lookup as dnsLookup } from 'node:dns/promises';
import { createServer, request as httpRequest } from 'node:http';
import { BlockList, connect as netConnect, isIP } from 'node:net';

const IDLE_TIMEOUT_MS = 120_000;
const CONNECT_TIMEOUT_MS = 20_000;
const MAX_UPSTREAM_HEAD = 16 * 1024;

const HOP_HEADERS = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

function buildBlockList() {
  const list = new BlockList();
  const v4 = [
    ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
    ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
    ['224.0.0.0', 4], ['240.0.0.0', 4],
  ];
  const v6 = [['::', 127], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['2001:db8::', 32], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]];
  for (const [net, prefix] of v4) list.addSubnet(net, prefix, 'ipv4');
  for (const [net, prefix] of v6) list.addSubnet(net, prefix, 'ipv6');
  return list;
}

const NON_PUBLIC = buildBlockList();

/** True for loopback, private, link-local, CGNAT, multicast, documentation and reserved addresses. */
export function isNonPublicAddress(address) {
  const family = isIP(address);
  if (family === 4) return NON_PUBLIC.check(address, 'ipv4');
  if (family === 6) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
    if (mapped) return NON_PUBLIC.check(mapped[1], 'ipv4');
    return NON_PUBLIC.check(address, 'ipv6'); // BlockList also applies IPv4 rules to hex-form mapped addresses
  }
  return true; // not an address at all: never treat the unknown as public
}

function parseUpstream(raw, name) {
  if (!raw) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} 값이 올바른 프록시 주소가 아닙니다.`);
  }
  if (url.protocol !== 'http:') {
    throw new Error(`${name}: 내장 송신 보호(EGRESS_GUARD)는 http:// 형식의 상위 프록시만 지원합니다. 다른 형식을 쓰려면 EGRESS_GUARD=0 으로 끄고 네트워크 수준에서 직접 차단해 주세요.`);
  }
  const auth = url.username ? `Basic ${Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString('base64')}` : null;
  return { host: url.hostname.replace(/^\[|\]$/g, ''), port: Number(url.port || 80), auth };
}

/**
 * @param {object} options
 * @param {(hostname: string, port: number) => boolean} options.allowsExtraEndpoint operator allowlist (may be private)
 * @param {{ http?: string|null, https?: string|null }} [options.upstream] proxies the deployment itself must use
 * @param {(hostname: string) => Promise<Array<{address: string}>>} [options.resolve]
 */
export function createEgressGuard({ allowsExtraEndpoint, upstream = {}, resolve = (hostname) => dnsLookup(hostname, { all: true }), debug = false }) {
  const upstreamHttp = parseUpstream(upstream.http, 'HTTP_PROXY');
  const upstreamHttps = parseUpstream(upstream.https, 'HTTPS_PROXY');
  const sockets = new Set();

  /**
   * Decides one destination. `via` is the upstream proxy to use, or null to connect to `address`.
   * @returns {Promise<{ allowed: false, reason: string } | { allowed: true, address: string|null, via: object|null }>}
   */
  async function decide(rawHost, port, scheme) {
    const urlHost = rawHost.toLowerCase();
    const host = urlHost.replace(/^\[|\]$/g, '').replace(/\.$/, '');
    if (host === '' || !Number.isInteger(port) || port < 1 || port > 65535) return { allowed: false, reason: 'malformed destination' };
    const extra = allowsExtraEndpoint(urlHost, port);
    if (!extra && port !== 80 && port !== 443) return { allowed: false, reason: 'port not allowed' };

    let addresses;
    if (isIP(host) !== 0) {
      addresses = [host];
    } else {
      try {
        addresses = (await resolve(host)).map((entry) => entry.address);
      } catch {
        addresses = [];
      }
    }
    if (extra) {
      // Operator-approved endpoints are reached directly, wherever they are.
      return addresses.length > 0 ? { allowed: true, address: addresses[0], via: null } : { allowed: false, reason: 'unresolvable' };
    }
    if (addresses.some(isNonPublicAddress)) return { allowed: false, reason: 'non-public address' };
    const via = scheme === 'https' ? upstreamHttps : upstreamHttp;
    if (via) return { allowed: true, address: null, via }; // the upstream proxy resolves and connects
    if (addresses.length === 0) return { allowed: false, reason: 'unresolvable' };
    return { allowed: true, address: addresses[0], via: null };
  }

  function track(socket) {
    sockets.add(socket);
    socket.setTimeout(IDLE_TIMEOUT_MS, () => socket.destroy());
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => socket.destroy());
  }

  function deny(reason, target) {
    if (debug) console.error(`[egress] denied ${target}: ${reason}`);
  }

  // ------------------------------------------------------------ CONNECT (https)

  function openTunnel(decision, host, port) {
    return new Promise((resolveTunnel, reject) => {
      const direct = decision.via === null;
      const socket = netConnect(direct ? { host: decision.address, port } : { host: decision.via.host, port: decision.via.port });
      const timer = setTimeout(() => socket.destroy(new Error('connect timeout')), CONNECT_TIMEOUT_MS);
      socket.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      socket.once('connect', () => {
        if (direct) {
          clearTimeout(timer);
          resolveTunnel({ socket, head: Buffer.alloc(0) });
          return;
        }
        const authority = host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`;
        socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${decision.via.auth ? `Proxy-Authorization: ${decision.via.auth}\r\n` : ''}\r\n`);
        let buffered = Buffer.alloc(0);
        const onData = (chunk) => {
          buffered = Buffer.concat([buffered, chunk]);
          const end = buffered.indexOf('\r\n\r\n');
          if (end < 0) {
            if (buffered.length > MAX_UPSTREAM_HEAD) socket.destroy(new Error('upstream proxy response too large'));
            return;
          }
          socket.off('data', onData);
          clearTimeout(timer);
          const status = /^HTTP\/1\.[01] (\d{3})/.exec(buffered.subarray(0, end).toString('latin1'))?.[1];
          if (status !== '200') {
            socket.destroy();
            reject(Object.assign(new Error(`upstream proxy refused the tunnel (${status ?? 'no status'})`), { upstreamStatus: Number(status) || 502 }));
            return;
          }
          resolveTunnel({ socket, head: buffered.subarray(end + 4) });
        };
        socket.on('data', onData);
      });
    });
  }

  async function handleConnect(req, client, head) {
    const match = /^(\[[^\]]+\]|[^:]+):(\d{1,5})$/.exec(req.url ?? '');
    const refuse = (status, text) => client.end(`HTTP/1.1 ${status} ${text}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
    if (!match) return refuse(400, 'Bad Request');
    const [, rawHost, portText] = match;
    const port = Number(portText);
    const decision = await decide(rawHost, port, 'https');
    if (!decision.allowed) {
      deny(decision.reason, req.url);
      return refuse(403, 'Forbidden');
    }
    try {
      const { socket: remote, head: remoteHead } = await openTunnel(decision, rawHost.replace(/^\[|\]$/g, ''), port);
      track(remote);
      if (client.destroyed) return remote.destroy();
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (remoteHead.length > 0) client.write(remoteHead);
      if (head.length > 0) remote.write(head);
      remote.pipe(client);
      client.pipe(remote);
      remote.on('close', () => client.destroy());
      client.on('close', () => remote.destroy());
    } catch (error) {
      deny(error.message, req.url);
      refuse(error.upstreamStatus === 403 ? 403 : 502, error.upstreamStatus === 403 ? 'Forbidden' : 'Bad Gateway');
    }
  }

  // ------------------------------------------------------------ plain http

  async function handleRequest(req, res) {
    const fail = (status) => {
      if (res.headersSent) return res.destroy();
      res.writeHead(status, { 'Content-Length': 0, Connection: 'close' });
      res.end();
    };
    let url;
    try {
      url = new URL(req.url ?? '');
    } catch {
      return fail(400);
    }
    if (url.protocol !== 'http:' || url.username !== '' || url.password !== '') return fail(400);
    const port = Number(url.port || 80);
    const decision = await decide(url.hostname, port, 'http');
    if (!decision.allowed) {
      deny(decision.reason, url.host);
      return fail(403);
    }
    const headers = {};
    for (const [name, value] of Object.entries(req.headers)) if (!HOP_HEADERS.has(name)) headers[name] = value;
    headers.host = url.host;
    const direct = decision.via === null;
    if (!direct && decision.via.auth) headers['proxy-authorization'] = decision.via.auth;
    const outbound = httpRequest({
      host: direct ? decision.address : decision.via.host,
      port: direct ? port : decision.via.port,
      method: req.method,
      path: direct ? `${url.pathname}${url.search}` : url.href,
      headers,
      agent: false,
      timeout: IDLE_TIMEOUT_MS,
    });
    outbound.on('timeout', () => outbound.destroy(new Error('timeout')));
    outbound.on('error', () => fail(502));
    outbound.on('response', (upstreamRes) => {
      const responseHeaders = {};
      for (const [name, value] of Object.entries(upstreamRes.headers)) if (!HOP_HEADERS.has(name)) responseHeaders[name] = value;
      res.writeHead(upstreamRes.statusCode ?? 502, responseHeaders);
      upstreamRes.pipe(res);
      upstreamRes.on('error', () => res.destroy());
    });
    res.on('close', () => outbound.destroy());
    req.pipe(outbound);
  }

  const server = createServer((req, res) => {
    handleRequest(req, res).catch(() => res.destroy());
  });
  server.on('connect', (req, client, head) => {
    handleConnect(req, client, head).catch(() => client.destroy());
  });
  server.on('connection', track);
  server.on('clientError', (error, socket) => socket.destroy());
  const listening = new Promise((resolveUrl, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolveUrl(`http://127.0.0.1:${server.address().port}`));
  });
  listening.catch(() => {}); // reported to whoever asks for the URL
  server.unref();

  return {
    decide,
    /** Resolves to the proxy URL once the loopback port is bound. */
    url: () => listening,
    close() {
      server.close();
      for (const socket of sockets) socket.destroy();
    },
  };
}
