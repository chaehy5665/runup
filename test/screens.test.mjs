import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { planCuts, statesFor } from '../src/capture.mjs';
import { DEFAULTS, mergeConfig, validate } from '../src/config.mjs';
import { buildScreens, expandRoute, parseAuthorList, pathMatchesRoute, routeGlob } from '../src/screens.mjs';

const config = (extra = {}) => mergeConfig(DEFAULTS, extra);
const discovered = (routes, { useDefault = false, unmapped = [], pages = [] } = {}) => ({
  routes: new Map(Object.entries(routes).map(([r, files]) => [r, new Set(files)])),
  useDefault,
  unmapped,
  pages,
});

describe('expandRoute', () => {
  it('fills params and caps the number of paths', () => {
    assert.deepEqual(expandRoute('/[locale]/post/[id]', { params: { locale: ['ko', 'en'], id: ['1', '2'] }, maxPathsPerRoute: 3 }).paths, [
      '/ko/post/1',
      '/ko/post/2',
      '/en/post/1',
    ]);
  });
  it('prefers explicit paths', () => {
    assert.deepEqual(expandRoute('/[id]', { paths: { '/[id]': ['/abc'] } }).paths, ['/abc']);
  });
  it('handles catch-all and optional catch-all', () => {
    assert.deepEqual(expandRoute('/docs/[...slug]', { params: { slug: ['a/b'] } }).paths, ['/docs/a/b']);
    assert.deepEqual(expandRoute('/docs/[[...slug]]', {}).paths, ['/docs']);
  });
  it('reports missing params', () => {
    assert.deepEqual(expandRoute('/[locale]/x/[id]', { params: { locale: 'ko' } }), { paths: [], missing: ['id'] });
  });
});

describe('pathMatchesRoute', () => {
  it('matches dynamic segments', () => {
    assert.ok(pathMatchesRoute('/ko/post/1', '/[locale]/post/[id]'));
    assert.ok(!pathMatchesRoute('/ko/post', '/[locale]/post/[id]'));
    assert.ok(pathMatchesRoute('/docs', '/docs/[[...slug]]'));
    assert.ok(pathMatchesRoute('/docs/a/b', '/docs/[...slug]'));
    assert.ok(pathMatchesRoute('/', '/'));
    assert.ok(pathMatchesRoute('/ko?x=1', '/[locale]'));
  });
});

describe('routeGlob', () => {
  it('keeps [param] and (group) literal', () => {
    const match = routeGlob(['/[locale]/dashboard/**', '/(shop)/*']);
    assert.ok(match('/[locale]/dashboard'));
    assert.ok(match('/[locale]/dashboard/settings'));
    assert.ok(match('/(shop)/cart'));
    assert.ok(!match('/l/dashboard'));
    assert.ok(!match('/[locale]/post/[slug]'));
  });
  it('excludes screens by a glob over their route', () => {
    const { screens, skipped } = buildScreens({
      discovered: discovered({ '/[locale]/dashboard/[id]': ['a'], '/[locale]': ['b'] }),
      config: config({ params: { locale: ['en'], id: ['1'] }, exclude: ['/[locale]/dashboard/**'] }),
    });
    assert.deepEqual(screens.map((s) => s.path), ['/en']);
    assert.equal(skipped[0].path, '/en/dashboard/1');
  });
});

describe('parseAuthorList', () => {
  it('reads lines, commas and bullets', () => {
    assert.deepEqual(parseAuthorList('- /a\n* `/b`\n/c, /d\nnot a path\n# /e'), ['/a', '/b', '/c', '/d']);
  });
  it('reads only the runup block of a PR body', () => {
    const body = 'Changes /x\n\n```runup\n/ko/post/[id]\n- [x] /ko\n```\n\n```sh\n/nope\n```';
    assert.deepEqual(parseAuthorList(body, { requireFence: true }), ['/ko/post/[id]', '/ko']);
  });
  it('returns nothing for a PR body without a runup block', () => {
    assert.deepEqual(parseAuthorList('fixes /a and /b', { requireFence: true }), []);
  });
});

describe('buildScreens', () => {
  it('combines diff, author and default screens', () => {
    const { screens } = buildScreens({
      discovered: discovered({ '/[locale]/post/[id]': ['post.tsx'] }, { useDefault: true, unmapped: ['next.config.ts'] }),
      author: ['/ko/about'],
      config: config({ params: { locale: ['ko'], id: ['7'] }, defaultScreens: ['/ko'] }),
    });
    const byPath = Object.fromEntries(screens.map((s) => [s.path, s]));
    assert.deepEqual(Object.keys(byPath).sort(), ['/ko', '/ko/about', '/ko/post/7']);
    assert.deepEqual(byPath['/ko/post/7'].sources, ['diff']);
    assert.deepEqual(byPath['/ko/post/7'].reasons, ['post.tsx']);
    assert.deepEqual(byPath['/ko'].reasons, ['next.config.ts']);
    assert.equal(byPath['/ko/about'].expected, true);
    assert.equal(byPath['/ko/post/7'].expected, false);
  });

  it('matches author route patterns and globs as expected', () => {
    const { screens } = buildScreens({
      discovered: discovered({ '/[locale]/post/[id]': ['a'], '/[locale]/settings': ['b'] }),
      author: ['/[locale]/post/[id]', '/ko/set*'],
      config: config({ params: { locale: ['ko'], id: ['7'] } }),
    });
    assert.ok(screens.every((s) => s.expected === true));
    assert.equal(screens.length, 2);
  });

  it('leaves expected null without an author list', () => {
    const { screens } = buildScreens({ discovered: discovered({ '/': ['x'] }), config: config() });
    assert.equal(screens[0].expected, null);
  });

  it('skips routes without sample params and excluded screens', () => {
    const { screens, skipped } = buildScreens({
      discovered: discovered({ '/[id]': ['x'], '/admin': ['y'], '/': ['z'] }),
      config: config({ exclude: ['/admin'] }),
    });
    assert.deepEqual(screens.map((s) => s.path), ['/']);
    assert.deepEqual(skipped.map((s) => s.reason.split(' ')[0]).sort(), ['excluded', 'no']);
  });

  it('falls back to the default set when the diff maps to nothing', () => {
    const { screens } = buildScreens({ discovered: discovered({}), config: config({ defaultScreens: ['/', '/about'] }) });
    assert.deepEqual(screens.map((s) => s.path), ['/', '/about']);
    assert.ok(screens.every((s) => s.sources[0] === 'default'));
  });
});

describe('planCuts', () => {
  it('multiplies widths × schemes and devices × browsers × schemes', () => {
    const cfg = config({
      states: [{ name: 'default' }, { name: 'menu', routes: ['/'] }],
      capture: { widths: [390, 1280], colorSchemes: ['light', 'dark'] },
      devices: { profiles: ['iPhone 15', 'Pixel 7'], browsers: ['chromium', 'webkit'], colorSchemes: ['light'] },
    });
    const screens = [{ path: '/', route: '/' }, { path: '/about', route: '/about' }];
    const cuts = planCuts(screens, cfg);
    // per screen-state: 2 widths × 2 schemes + 2 devices × 2 browsers × 1 scheme = 8
    assert.equal(cuts.length, 8 * 3);
    assert.equal(new Set(cuts.map((c) => c.id)).size, cuts.length);
    assert.equal(planCuts(screens, cfg, { devices: false }).length, 4 * 3);
  });
  it('applies route-filtered states only where they match', () => {
    const states = [{ name: 'default' }, { name: 'open', routes: ['/[locale]/post/[id]'] }];
    assert.deepEqual(statesFor({ path: '/ko/post/1', route: '/[locale]/post/[id]' }, states).map((s) => s.name), ['default', 'open']);
    assert.deepEqual(statesFor({ path: '/ko', route: '/[locale]' }, states).map((s) => s.name), ['default']);
  });
});

describe('config', () => {
  it('deep-merges user values over defaults', () => {
    const c = config({ capture: { widths: [320] } });
    assert.deepEqual(c.capture.widths, [320]);
    assert.deepEqual(c.capture.colorSchemes, ['light', 'dark']);
  });
  it('rejects invalid values', () => {
    assert.throws(() => validate(config({ devices: { browsers: ['edge'] } })), /unknown browser/);
    assert.throws(() => validate(config({ states: [{ name: 'a' }, { name: 'a' }] })), /unique/);
  });
});
