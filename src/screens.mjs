import picomatch from 'picomatch';

/**
 * Turn route patterns (`/[locale]/blog/[slug]`) into concrete paths to open, and combine the three
 * sources of screens: the diff, the PR author's list, and the config's default set.
 */

const DYNAMIC = /^\[(\[)?(\.\.\.)?([^\]]+)\]?\]$/;

export function isPattern(route) {
  return route.split('/').some((s) => DYNAMIC.test(s));
}

/** Concrete paths for a route pattern, from `config.paths[route]` or the cartesian product of `config.params`. */
export function expandRoute(route, { params = {}, paths = {}, maxPathsPerRoute = 3 } = {}) {
  if (paths[route]) return { paths: [].concat(paths[route]).slice(0, maxPathsPerRoute), missing: [] };
  let results = [''];
  const missing = [];
  for (const seg of route.split('/').filter(Boolean)) {
    const m = seg.match(DYNAMIC);
    if (!m) {
      results = results.map((r) => `${r}/${seg}`);
      continue;
    }
    const [, optional, , name] = m;
    const values = params[name] != null ? [].concat(params[name]) : optional ? [''] : null;
    if (!values) {
      missing.push(name);
      continue;
    }
    results = results.flatMap((r) => values.map((v) => (v === '' ? r : `${r}/${String(v).replace(/^\/+/, '')}`)));
  }
  if (missing.length) return { paths: [], missing };
  return { paths: [...new Set(results.map((r) => r || '/'))].slice(0, maxPathsPerRoute), missing };
}

/** Does a concrete path belong to a route pattern? */
export function pathMatchesRoute(p, route) {
  const segs = route.split('/').filter(Boolean);
  const re = segs
    .map((s) => {
      const m = s.match(DYNAMIC);
      if (!m) return `/${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`;
      if (m[2]) return m[1] ? '(?:/.*)?' : '/.+';
      return '/[^/]+';
    })
    .join('');
  return new RegExp(`^${re || '/'}/?$`).test(p.split(/[?#]/)[0]);
}

/**
 * Parse an author's screen list. Accepts:
 * - one entry per line or comma-separated
 * - a PR body with a fenced ```runup block (only that block is read; `requireFence` for PR bodies)
 * Lines starting with `#` and list bullets are handled.
 */
export function parseAuthorList(text, { requireFence = false } = {}) {
  if (!text) return [];
  const fence = text.match(/```runup[^\n]*\n([\s\S]*?)```/);
  if (!fence && requireFence) return [];
  const body = fence ? fence[1] : text;
  return [
    ...new Set(
      body
        .split(/[\n,]/)
        .map((l) => l.replace(/^\s*[-*]\s*(\[[ x]\]\s*)?/i, '').replace(/`/g, '').trim())
        .filter((l) => l.startsWith('/')),
    ),
  ];
}

export const isGlob = (s) => /[*?{]/.test(s);

/** Glob matcher where `[param]` and `(group)` stay literal, so globs can be written over route patterns. */
export function routeGlob(globs) {
  const list = [].concat(globs);
  if (!list.length) return () => false;
  return picomatch(list.map((g) => g.replace(/[[\]()]/g, '\\$&')));
}

function makeMatcher(list) {
  const globs = list.filter(isGlob);
  const glob = routeGlob(globs);
  const plain = list.filter((e) => !globs.includes(e));
  return (screen) =>
    glob(screen.path) ||
    (screen.route && glob(screen.route)) ||
    plain.some((e) => e === screen.path || e === screen.route || (isPattern(e) && pathMatchesRoute(screen.path, e)));
}

/**
 * Build the screen list.
 * @returns {{screens: object[], skipped: object[]}}
 */
export function buildScreens({ discovered, author = [], config }) {
  const byPath = new Map();
  const skipped = [];
  const excluded = makeMatcher(config.exclude ?? []);

  const add = (p, { route = null, source, reasons = [] }) => {
    const key = p.split('#')[0] || '/';
    let screen = byPath.get(key);
    if (!screen) {
      screen = { path: key, route, sources: new Set(), reasons: new Set() };
      byPath.set(key, screen);
    }
    if (route && !screen.route) screen.route = route;
    screen.sources.add(source);
    reasons.forEach((r) => screen.reasons.add(r));
  };

  const addRoute = (route, source, reasons) => {
    if (!route.startsWith('/')) return;
    if (!isPattern(route)) return add(route, { route, source, reasons });
    const { paths, missing } = expandRoute(route, config);
    if (!paths.length) skipped.push({ route, source, reason: `no sample value for ${missing.map((m) => `[${m}]`).join(', ')} (set params or paths in the config)`, files: [...reasons] });
    for (const p of paths) add(p, { route, source, reasons });
  };

  for (const [route, files] of discovered.routes) addRoute(route, 'diff', [...files]);
  for (const entry of author) {
    if (isGlob(entry)) {
      // A glob only widens what counts as expected; it does not add screens by itself.
      continue;
    }
    addRoute(entry, 'author', []);
  }
  if (discovered.useDefault || byPath.size === 0) {
    const reasons = discovered.unmapped.length ? discovered.unmapped : [];
    for (const d of config.defaultScreens) addRoute(d, 'default', reasons);
  }

  // Map concrete paths back to the route that serves them, for paths that came in without one.
  for (const screen of byPath.values()) {
    if (screen.route) continue;
    const page = discovered.pages.find((pg) => pathMatchesRoute(screen.path, pg.route));
    if (page) screen.route = page.route;
  }

  const isExpected = makeMatcher(author);
  const screens = [];
  for (const screen of byPath.values()) {
    if (excluded(screen)) {
      skipped.push({ route: screen.route, path: screen.path, source: [...screen.sources].join('+'), reason: 'excluded by config', files: [...screen.reasons] });
      continue;
    }
    screens.push({
      path: screen.path,
      route: screen.route,
      sources: [...screen.sources].sort(),
      reasons: [...screen.reasons].sort(),
      expected: author.length ? isExpected(screen) : null,
    });
  }
  const priority = (s) => (s.sources.includes('author') ? 0 : s.sources.includes('diff') ? 1 : 2);
  screens.sort((a, b) => priority(a) - priority(b) || a.path.localeCompare(b.path));
  const limit = config.maxScreens ?? 40;
  if (screens.length > limit) {
    for (const s of screens.splice(limit)) skipped.push({ route: s.route, path: s.path, source: s.sources.join('+'), reason: `over maxScreens (${limit})`, files: s.reasons });
  }
  return { screens, skipped };
}
