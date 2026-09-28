/**
 * Which Host names `runup live` answers, and which origin the compare page runs on.
 *
 * Only loopback names are served. Anything else (a DNS-rebound `base.attacker.example`, a LAN address) gets
 * 421, because the proxy rewrites Host and Origin to the upstream values and would otherwise carry that
 * request past the dev server's own host and origin checks. The port is not checked: an SSH tunnel may
 * forward a different local port, and a rebound name is rejected by its name alone.
 */

const UI_NAMES = ['localhost', '127.0.0.1'];
const SIDE_NAMES = { 'base.localhost': 'base', 'head.localhost': 'head' };

function parseHost(host) {
  const m = /^([a-z0-9.-]+)(?::(\d{1,5}))?$/i.exec(typeof host === 'string' ? host : '');
  return m ? { name: m[1].toLowerCase(), port: m[2] ?? '' } : null;
}

/**
 * What a request with this Host header reaches: 'ui', 'base', 'head', or null (refuse it).
 * With `hosts: 'ports'` every server takes only the plain loopback names; the caller knows which side it is.
 */
export function classifyHost(host, hosts = 'subdomain') {
  const h = parseHost(host);
  if (!h) return null;
  if (UI_NAMES.includes(h.name)) return 'ui';
  if (hosts !== 'ports' && SIDE_NAMES[h.name]) return SIDE_NAMES[h.name];
  return null;
}

/**
 * The origins the compare page can have, seen from a pane whose request carried `host`.
 * One port: the compare page shares the pane's port. Split ports: it is on `uiPort`.
 * Both loopback names are listed, since the page may be opened as either.
 */
export function compareOrigins(host, { hosts = 'subdomain', uiPort }) {
  const h = parseHost(host);
  const port = hosts === 'ports' ? String(uiPort) : h?.port ?? '';
  const suffix = port && port !== '80' ? `:${port}` : '';
  return UI_NAMES.map((name) => `http://${name}${suffix}`);
}
