import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { after, before, describe, it } from 'node:test';
import { blocksInline, createSideProxy, cspNonce, injectAgent, stripFrameAncestors } from '../src/live/proxy.mjs';

describe('proxy helpers', () => {
  it('drops only the frame-ancestors directive', () => {
    assert.equal(stripFrameAncestors("default-src 'self'; frame-ancestors 'none'; img-src *"), "default-src 'self'; img-src *");
    assert.equal(stripFrameAncestors("frame-ancestors 'self'"), '');
  });
  it('finds a script nonce', () => {
    assert.equal(cspNonce("script-src 'self' 'nonce-abc123' 'strict-dynamic'"), 'abc123');
    assert.equal(cspNonce("default-src 'self'"), null);
  });
  it('tells when a CSP blocks inline scripts', () => {
    assert.equal(blocksInline(undefined), false);
    assert.equal(blocksInline("img-src *"), false);
    assert.equal(blocksInline("default-src 'self'"), true);
    assert.equal(blocksInline("default-src 'self' 'unsafe-inline'"), false);
    assert.equal(blocksInline("script-src 'self' 'unsafe-inline' 'nonce-a'"), true);
  });
  it('injects the agent at the end of head, else after the doctype', () => {
    assert.equal(injectAgent('<html><head lang="x"><title>t</title></head></html>', '<s>'), '<html><head lang="x"><title>t</title><s></head></html>');
    assert.equal(injectAgent('<html><head><title>t</title></HEAD ></html>', '<s>'), '<html><head><title>t</title><s></HEAD ></html>');
    assert.equal(injectAgent('<!doctype html><p>hi', '<s>'), '<!doctype html><s><p>hi');
    assert.equal(injectAgent('<p>hi', '<s>'), '<s><p>hi');
  });
});

describe('side proxy', { timeout: 20_000 }, () => {
  const upgraded = new Set();
  let upstream;
  let proxy;
  const seen = [];

  before(async () => {
    upstream = http.createServer((req, res) => {
      seen.push({ url: req.url, host: req.headers.host, origin: req.headers.origin, ua: req.headers['user-agent'] });
      if (req.url === '/redirect') {
        res.writeHead(307, { location: `http://127.0.0.1:${upstream.address().port}/next?x=1` });
        return res.end();
      }
      if (req.url === '/data.json') {
        res.writeHead(200, { 'content-type': 'application/json', 'x-frame-options': 'DENY' });
        return res.end('{"ok":true}');
      }
      const html = '<!doctype html><html><head></head></html>';
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'x-frame-options': 'SAMEORIGIN', 'content-security-policy': "frame-ancestors 'none'; script-src 'self' 'nonce-n1'", 'content-length': String(Buffer.byteLength(html)) });
      res.end(html);
    });
    upstream.on('upgrade', (req, socket) => {
      upgraded.add(socket);
      seen.push({ upgrade: req.url, host: req.headers.host, origin: req.headers.origin });
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
      socket.on('data', (d) => socket.write(Buffer.concat([Buffer.from('echo:'), d])));
    });
    await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
    const side = createSideProxy({ side: 'head', target: `http://127.0.0.1:${upstream.address().port}`, agentScript: () => 'AGENT', userAgent: () => 'TestUA/1' });
    proxy = http.createServer(side.handleRequest);
    proxy.on('upgrade', side.handleUpgrade);
    await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
  });
  after(async () => {
    for (const s of upgraded) s.destroy();
    proxy.closeAllConnections();
    upstream.closeAllConnections();
    await new Promise((r) => proxy.close(r));
    await new Promise((r) => upstream.close(r));
  });

  const get = (path, headers = {}) =>
    new Promise((resolve, reject) => {
      http
        .get({ host: '127.0.0.1', port: proxy.address().port, path, headers: { host: `head.localhost:${proxy.address().port}`, ...headers } }, (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
        })
        .on('error', reject);
    });

  it('inlines the agent with the page nonce and fixes the length', async () => {
    const res = await get('/page', { origin: `http://head.localhost:${proxy.address().port}` });
    assert.equal(res.body, '<!doctype html><html><head><script data-runup-agent nonce="n1">AGENT</script></head></html>');
    assert.equal(Number(res.headers['content-length']), Buffer.byteLength(res.body));
    assert.equal(res.headers['x-frame-options'], undefined);
    assert.equal(res.headers['content-security-policy'], "script-src 'self' 'nonce-n1'");
    const req = seen.at(-1);
    assert.equal(req.host, `127.0.0.1:${upstream.address().port}`);
    assert.equal(req.origin, `http://127.0.0.1:${upstream.address().port}`);
    assert.equal(req.ua, 'TestUA/1');
  });

  it('serves the agent script itself', async () => {
    const res = await get('/__runup/agent.js?side=head');
    assert.equal(res.body, 'AGENT');
  });

  it('passes non-HTML through and rewrites upstream redirects', async () => {
    const json = await get('/data.json');
    assert.equal(json.body, '{"ok":true}');
    assert.equal(json.headers['x-frame-options'], undefined);
    const redirect = await get('/redirect');
    assert.equal(redirect.status, 307);
    assert.equal(redirect.headers.location, '/next?x=1');
  });

  it('pipes WebSocket upgrades (HMR) with the upstream Host and Origin', async () => {
    const port = proxy.address().port;
    const reply = await new Promise((resolve, reject) => {
      const s = net.connect(port, '127.0.0.1', () => {
        s.write(`GET /_next/webpack-hmr HTTP/1.1\r\nHost: head.localhost:${port}\r\nOrigin: http://head.localhost:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`);
      });
      let buf = '';
      s.on('data', (d) => {
        buf += d;
        if (buf.includes('\r\n\r\n') && !buf.includes('echo:')) s.write('ping');
        if (buf.includes('echo:ping')) {
          s.destroy();
          resolve(buf);
        }
      });
      s.on('error', reject);
    });
    assert.match(reply, /^HTTP\/1\.1 101/);
    const up = seen.find((x) => x.upgrade);
    assert.equal(up.upgrade, '/_next/webpack-hmr');
    assert.equal(up.host, `127.0.0.1:${upstream.address().port}`);
    assert.equal(up.origin, `http://127.0.0.1:${upstream.address().port}`);
  });
});
