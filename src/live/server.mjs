import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import playwright from 'playwright';
import { statesFor } from '../capture.mjs';
import { plan } from '../run.mjs';
import { warmUp } from '../server.mjs';
import { startSides } from '../sides.mjs';
import { log } from '../util.mjs';
import { classifyHost, compareOrigins } from './hosts.mjs';
import { createSideProxy } from './proxy.mjs';
import { renderUi } from './ui.mjs';

const agentFile = path.join(path.dirname(fileURLToPath(import.meta.url)), 'agent.js');

/** Device-size presets: phone, tablet, desktop, plus the config's widths and device profiles. */
export function buildPresets(config) {
  const presets = [];
  const add = (p) => {
    if (!presets.some((x) => x.id === p.id)) presets.push(p);
  };
  const device = (name, label) => {
    const d = playwright.devices[name];
    if (!d) return;
    add({
      id: `device:${name}`,
      label: label ? `${label} · ${name}` : name,
      width: d.viewport.width,
      height: d.viewport.height,
      dpr: d.deviceScaleFactor,
      userAgent: d.userAgent,
      cut: { kind: 'device', device: name },
    });
  };
  const widths = [...config.capture.widths].sort((a, b) => a - b);
  const desktop = widths[widths.length - 1];
  add({ id: `width:${desktop}`, label: `Desktop · ${desktop}px`, width: desktop, height: config.capture.height, dpr: config.capture.deviceScaleFactor ?? 1, cut: { kind: 'viewport', width: desktop } });
  device('iPhone 15', 'Phone');
  device('iPad (gen 7)', 'Tablet');
  for (const w of widths) add({ id: `width:${w}`, label: `${w}px`, width: w, height: config.capture.height, dpr: config.capture.deviceScaleFactor ?? 1, cut: { kind: 'viewport', width: w } });
  for (const name of config.devices.profiles) device(name);
  return presets;
}

function querySearch(query) {
  if (!query) return '';
  const q = typeof query === 'string' ? query.replace(/^\?/, '') : new URLSearchParams(query).toString();
  return q ? `?${q}` : '';
}

async function loadReport(file, baseSha, headSha) {
  try {
    const report = JSON.parse(await fs.readFile(file, 'utf8'));
    if (report.base?.sha !== baseSha || report.head?.sha !== headSha) {
      log(`live: ${file} is for other commits; diff boxes are off`);
      return null;
    }
    return report;
  } catch {
    return null;
  }
}

/**
 * Start `runup live`: both app servers, a proxy per side and the compare page, all behind one port.
 * Hosts `base.localhost:<port>` and `head.localhost:<port>` reach the two apps; `localhost` and `127.0.0.1`
 * get the compare page, and any other host is refused (see hosts.mjs). With `hosts: 'ports'` the sides
 * listen on <port>+1 and <port>+2 instead.
 */
export async function startLive(opts) {
  const p = await plan(opts);
  const { root, config, baseSha, headSha } = p;
  const live = { port: 4545, host: '127.0.0.1', hosts: 'subdomain', freezeClock: true, ...(config.live ?? {}) };
  const port = Number(opts.port ?? live.port);
  const hosts = opts.splitPorts ? 'ports' : live.hosts;
  const short = (s) => s.slice(0, 7);

  const outRoot = path.resolve(root, opts.out ?? config.outDir);
  const reportFile = opts.report
    ? (opts.report.endsWith('.json') ? path.resolve(opts.report) : path.join(path.resolve(opts.report), 'report.json'))
    : path.join(outRoot, `${short(baseSha)}-${short(headSha)}`, 'report.json');
  const report = await loadReport(reportFile, baseSha, headSha);

  const presets = buildPresets(config);
  let preset = presets[0];

  const screens = p.screens.map((s) => {
    const fromReport = report?.screens.find((r) => r.path === s.path);
    return {
      path: s.path,
      route: s.route,
      sources: s.sources,
      changed: fromReport ? fromReport.changed : null,
      unexpected: fromReport ? fromReport.unexpected : false,
      states: statesFor(s, config.states).map((st) => ({
        name: st.name,
        search: querySearch(st.query),
        steps: st.steps ?? [],
        partial: typeof st.run === 'function' || Boolean(st.localStorage),
        changed: report ? report.cuts.some((c) => c.path === s.path && c.state === st.name && c.changed) : null,
      })),
    };
  });
  const cuts = (report?.cuts ?? [])
    .filter((c) => c.changed && c.boxes?.length)
    .map((c) => ({
      path: c.path,
      state: c.state,
      kind: c.kind,
      width: c.width,
      device: c.device,
      colorScheme: c.colorScheme,
      diffRatio: c.diffRatio,
      boxes: c.boxes,
      scale: c.kind === 'device' ? (playwright.devices[c.device]?.deviceScaleFactor ?? 1) : (config.capture.deviceScaleFactor ?? 1),
    }));

  const logDir = path.join(outRoot, 'live-logs');
  await fs.mkdir(logDir, { recursive: true });
  const sides = await startSides({ root, config, baseSha, headSha, opts, logDir });
  const agentSource = await fs.readFile(agentFile, 'utf8');
  const freezeTime = live.freezeClock && !opts.realClock ? config.capture.freezeTime : null;

  // `parents` are the only origins the agent takes orders from and reports to: the compare page.
  const agentScript = (side) => (req) =>
    `window.__RUNUP__=${JSON.stringify({ side, parents: compareOrigins(req.headers.host, { hosts, uiPort: port }), freezeTime, dpr: preset.dpr, userAgent: preset.userAgent ?? null, labels: { separate: 'controlled separately · 따로 조작' } })};\n${agentSource}`;
  const proxies = {
    base: createSideProxy({ side: 'base', target: sides.baseUrl, agentScript: agentScript('base'), userAgent: () => preset.userAgent }),
    head: createSideProxy({ side: 'head', target: sides.headUrl, agentScript: agentScript('head'), userAgent: () => preset.userAgent }),
  };

  const state = () => ({
    base: { ref: opts.base, sha: baseSha },
    head: { ref: opts.head, sha: headSha },
    hosts,
    ports: { ui: port, base: port + 1, head: port + 2 },
    presets,
    preset: preset.id,
    screens,
    cuts,
    report: report ? { file: reportFile, generatedAt: report.generatedAt, summary: report.summary } : null,
    changedFiles: p.discovered.files.length,
    freezeTime,
    start: screens.find((s) => s.changed)?.path ?? screens[0]?.path ?? config.defaultScreens[0] ?? '/',
  });

  function uiHandler(req, res) {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/' || url.pathname === '/index.html') {
      // The panes may be framed by anything (the proxy drops their frame headers); the compare page may not.
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'content-security-policy': "frame-ancestors 'none'" });
      return res.end(renderUi());
    }
    if (url.pathname === '/__runup/state.json') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      return res.end(JSON.stringify(state()));
    }
    if (url.pathname === '/__runup/preset' && req.method === 'POST') {
      // Only the compare page changes the preset; a form posted from another site is refused.
      if (req.headers.origin && !compareOrigins(req.headers.host, { hosts, uiPort: port }).includes(req.headers.origin)) {
        res.writeHead(403, { 'content-type': 'text/plain' });
        return res.end('forbidden');
      }
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        let id;
        try {
          id = JSON.parse(body || '{}')?.id;
        } catch {
          id = undefined;
        }
        const next = presets.find((x) => x.id === id);
        if (next) preset = next;
        res.writeHead(next ? 200 : 400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ preset: preset.id }));
      });
      return undefined;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    return res.end('not found');
  }

  const refuse = (res) => {
    res.writeHead(421, { 'content-type': 'text/plain' });
    res.end('runup live answers only localhost, 127.0.0.1, base.localhost and head.localhost');
  };
  const refuseUpgrade = (socket) => {
    socket.end('HTTP/1.1 421 Misdirected Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  };
  // Split ports: each server takes only the plain loopback names.
  const onlyLoopback = (handler) => (req, res) => (classifyHost(req.headers.host, 'ports') === 'ui' ? handler(req, res) : refuse(res));
  const onlyLoopbackUpgrade = (handler) => (req, socket, head) =>
    classifyHost(req.headers.host, 'ports') === 'ui' ? handler(req, socket, head) : refuseUpgrade(socket);

  const servers = [];
  const listen = (handler, upgrade, p2) =>
    new Promise((resolve, reject) => {
      const srv = http.createServer(handler);
      if (upgrade) srv.on('upgrade', upgrade);
      srv.on('error', reject);
      srv.listen(p2, live.host, () => resolve(srv));
      servers.push(srv);
    });

  try {
    if (hosts === 'ports') {
      await listen(onlyLoopback(uiHandler), null, port);
      await listen(onlyLoopback(proxies.base.handleRequest), onlyLoopbackUpgrade(proxies.base.handleUpgrade), port + 1);
      await listen(onlyLoopback(proxies.head.handleRequest), onlyLoopbackUpgrade(proxies.head.handleUpgrade), port + 2);
    } else {
      await listen(
        (req, res) => {
          const to = classifyHost(req.headers.host);
          if (!to) return refuse(res);
          return to === 'ui' ? uiHandler(req, res) : proxies[to].handleRequest(req, res);
        },
        (req, socket, head) => {
          const to = classifyHost(req.headers.host);
          if (to === 'base' || to === 'head') proxies[to].handleUpgrade(req, socket, head);
          else if (to === 'ui') socket.destroy();
          else refuseUpgrade(socket);
        },
        port,
      );
    }
  } catch (err) {
    await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
    await sides.cleanup();
    throw new Error(`live: cannot listen on ${live.host}:${port} (${err.code ?? err.message}); pass --port`, { cause: err });
  }

  if (config.capture.warmup) await Promise.all([warmUp(sides.baseUrl, screens.map((s) => s.path)), warmUp(sides.headUrl, screens.map((s) => s.path))]);

  const url = `http://localhost:${port}/`;
  let closing = null;
  const close = () =>
    (closing ??= (async () => {
      for (const s of servers) s.closeAllConnections?.();
      await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
      await sides.cleanup();
    })());
  process.once('SIGINT', () => close().finally(() => process.exit(130)));
  process.once('SIGTERM', () => close().finally(() => process.exit(143)));
  return { url, port, hosts, close, state, report: Boolean(report) };
}
