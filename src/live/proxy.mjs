import http from 'node:http';
import net from 'node:net';

/**
 * A reverse proxy for one side (base or head). It forwards everything to the app server, and on the
 * way back:
 * - injects the runup agent as the first script of every HTML page,
 * - drops X-Frame-Options and the CSP `frame-ancestors` directive so the compare page can frame it
 *   (local proxy only; the app is unchanged),
 * - rewrites redirects that point at the upstream origin.
 * WebSocket upgrades (HMR) are piped through untouched apart from Host/Origin.
 */

export const AGENT_PATH = '/__runup/agent.js';

export function stripFrameAncestors(csp) {
  const kept = csp
    .split(';')
    .map((d) => d.trim())
    .filter((d) => d && !/^frame-ancestors\b/i.test(d));
  return kept.join('; ');
}

/** True when the CSP would block an inline script without a nonce. */
export function blocksInline(csp) {
  if (!csp) return false;
  const directives = Object.fromEntries(
    csp.split(';').map((d) => d.trim().split(/\s+/)).filter((d) => d[0]).map(([name, ...values]) => [name.toLowerCase(), values]),
  );
  const values = directives['script-src-elem'] ?? directives['script-src'] ?? directives['default-src'];
  if (!values) return false;
  // A nonce or hash turns 'unsafe-inline' off.
  return !values.includes("'unsafe-inline'") || values.some((v) => /^'(nonce|sha256|sha384|sha512)-/.test(v));
}

export function cspNonce(csp) {
  const m = /script-src[^;]*'nonce-([^']+)'/i.exec(csp ?? '');
  return m ? m[1] : null;
}

/**
 * Put the agent at the end of <head>. React 19 hydrates <head> by position, so a script at the start would
 * be paired with the app's own first script (a hydration mismatch); trailing extra nodes are skipped.
 */
export function injectAgent(html, tag) {
  const close = /<\/head\s*>/i.exec(html);
  if (close) return html.slice(0, close.index) + tag + html.slice(close.index);
  const head = /<head(\s[^>]*)?>/i.exec(html);
  if (head) return html.slice(0, head.index + head[0].length) + tag + html.slice(head.index + head[0].length);
  const doctype = /<!doctype[^>]*>/i.exec(html);
  if (doctype) return html.slice(0, doctype.index + doctype[0].length) + tag + html.slice(doctype.index + doctype[0].length);
  return tag + html;
}

/** Replace the proxy's origin with the upstream origin in Origin/Referer, so dev servers see same-origin requests. */
function upstreamHeaders(headers, { target, proxyOrigin, userAgent }) {
  const out = { ...headers };
  out.host = target.host;
  if (proxyOrigin) {
    for (const h of ['origin', 'referer']) {
      if (typeof out[h] === 'string' && out[h].startsWith(proxyOrigin)) out[h] = target.origin + out[h].slice(proxyOrigin.length);
    }
  }
  if (userAgent) out['user-agent'] = userAgent;
  out['x-forwarded-host'] = headers.host ?? '';
  out['x-forwarded-proto'] = 'http';
  return out;
}

/**
 * @param {object} args
 * @param {'base'|'head'} args.side
 * @param {string} args.target   upstream origin, e.g. http://127.0.0.1:3001
 * @param {(req: http.IncomingMessage) => string} args.agentScript  JS source of the agent for this side and request (served at AGENT_PATH)
 * @param {() => string|undefined} [args.userAgent] current user agent override
 */
export function createSideProxy({ side, target: targetUrl, agentScript, userAgent = () => undefined }) {
  const target = new URL(targetUrl);

  function handleRequest(req, res) {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === AGENT_PATH) {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
      res.end(agentScript(req));
      return;
    }
    const proxyOrigin = req.headers.host ? `http://${req.headers.host}` : null;
    const headers = upstreamHeaders(req.headers, { target, proxyOrigin, userAgent: userAgent() });
    // Identity encoding lets us rewrite HTML without a decompress/recompress round trip; it is all local.
    headers['accept-encoding'] = 'identity';
    const upstream = http.request(
      { host: target.hostname, port: target.port, method: req.method, path: req.url, headers },
      (up) => {
        const out = { ...up.headers };
        delete out['x-frame-options'];
        for (const h of ['content-security-policy']) {
          if (out[h]) {
            const v = stripFrameAncestors(String(out[h]));
            if (v) out[h] = v;
            else delete out[h];
          }
        }
        if (out.location) {
          const loc = new URL(out.location, target.origin);
          if (loc.origin === target.origin) out.location = loc.pathname + loc.search + loc.hash;
        }
        const type = String(up.headers['content-type'] ?? '');
        const isHtml = type.includes('text/html') && req.method !== 'HEAD' && ![204, 304].includes(up.statusCode);
        if (!isHtml) {
          res.writeHead(up.statusCode, out);
          up.pipe(res);
          return;
        }
        const chunks = [];
        up.on('data', (c) => chunks.push(c));
        up.on('end', () => {
          const csp = out['content-security-policy'];
          const nonce = cspNonce(csp);
          const nonceAttr = nonce ? ` nonce="${nonce}"` : '';
          // Inline, so it runs before any app script can (no fetch for async chunks to overtake). A strict CSP
          // without a nonce only allows same-origin files, so fall back to the served agent there.
          const tag = blocksInline(csp) && !nonce
            ? `<script src="${AGENT_PATH}?side=${side}" data-runup-agent></script>`
            : `<script data-runup-agent${nonceAttr}>${agentScript(req).replace(/<\/(script)/gi, '<\\/$1')}</script>`;
          const body = Buffer.from(injectAgent(Buffer.concat(chunks).toString('utf8'), tag));
          delete out['content-length'];
          delete out['content-encoding'];
          delete out['transfer-encoding'];
          out['content-length'] = String(body.length);
          res.writeHead(up.statusCode, out);
          res.end(body);
        });
        up.on('error', () => res.destroy());
      },
    );
    upstream.on('error', (err) => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
      res.end(`runup live: ${side} server did not answer (${err.code ?? err.message})`);
    });
    req.pipe(upstream);
  }

  function handleUpgrade(req, socket, head) {
    const proxyOrigin = req.headers.host ? `http://${req.headers.host}` : null;
    const up = net.connect(Number(target.port), target.hostname, () => {
      const headers = upstreamHeaders(req.headers, { target, proxyOrigin });
      delete headers['x-forwarded-host'];
      delete headers['x-forwarded-proto'];
      let raw = `${req.method} ${req.url} HTTP/1.1\r\n`;
      for (const [k, v] of Object.entries(headers)) for (const val of [].concat(v)) raw += `${k}: ${val}\r\n`;
      up.write(`${raw}\r\n`);
      if (head?.length) up.write(head);
      socket.pipe(up).pipe(socket);
    });
    const close = () => {
      socket.destroy();
      up.destroy();
    };
    // Either end going away (error or a clean close) tears down the other, so no socket is left open.
    for (const s of [up, socket]) {
      s.on('error', close);
      s.on('close', close);
    }
  }

  return { handleRequest, handleUpgrade };
}
