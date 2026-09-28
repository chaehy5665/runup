import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DEFAULTS, mergeConfig } from '../src/config.mjs';
import { extractSpecifiers, parseJsonc } from '../src/discover/imports.mjs';
import { discoverNextApp, listPages, routeForDir } from '../src/discover/next-app.mjs';
import { treeFromDir } from '../src/tree.mjs';

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'next-app');
const config = mergeConfig(DEFAULTS, {});

async function discover(changed, { base, config: extra } = {}) {
  const head = await treeFromDir(fixture);
  return discoverNextApp({ head, base, changed, config: mergeConfig(config, extra ?? {}) });
}

const routesOf = (d) => [...d.routes.keys()].sort();
const kindOf = (d, file) => d.files.find((f) => f.file === file)?.kind;

describe('routeForDir', () => {
  it('drops route groups and parallel slots', () => {
    assert.equal(routeForDir(''), '/');
    assert.equal(routeForDir('[locale]/(shop)/products/[id]'), '/[locale]/products/[id]');
    assert.equal(routeForDir('dashboard/@team/members'), '/dashboard/members');
  });
  it('rejects private folders and intercepting routes', () => {
    assert.equal(routeForDir('_internal'), null);
    assert.equal(routeForDir('settings/@modal/(.)photo'), null);
    assert.equal(routeForDir('feed/(..)photo/[id]'), null);
    assert.equal(routeForDir('(...)login'), null);
  });
});

describe('listPages', () => {
  it('finds every screen in the fixture app', async () => {
    const tree = await treeFromDir(fixture);
    const routes = listPages(tree.files, { appDir: 'src/app', pageExtensions: config.pageExtensions }).map((p) => p.route).sort();
    assert.deepEqual(routes, ['/', '/[locale]/about', '/[locale]/docs/[[...slug]]', '/[locale]/products/[id]', '/[locale]/settings']);
  });
});

describe('discoverNextApp', () => {
  it('detects src/app', async () => {
    assert.equal((await discover([])).appDir, 'src/app');
  });

  it('maps a changed page to its route', async () => {
    const d = await discover(['src/app/[locale]/about/page.mdx']);
    assert.deepEqual(routesOf(d), ['/[locale]/about']);
    assert.equal(d.useDefault, false);
  });

  it('follows a component through the import graph (relative imports, type imports)', async () => {
    const d = await discover(['src/components/Button.tsx']);
    assert.deepEqual(routesOf(d), ['/']);
  });

  it('follows tsconfig path aliases into colocated private folders', async () => {
    const d = await discover(['src/lib/format.ts']);
    assert.deepEqual(routesOf(d), ['/[locale]/products/[id]']);
  });

  it('expands a root layout import to every page', async () => {
    const d = await discover(['src/components/Header.tsx']);
    assert.deepEqual(routesOf(d), ['/', '/[locale]/about', '/[locale]/docs/[[...slug]]', '/[locale]/products/[id]', '/[locale]/settings']);
  });

  it('scopes a group layout to the pages under it', async () => {
    const d = await discover(['src/app/[locale]/(shop)/layout.tsx']);
    assert.deepEqual(routesOf(d), ['/[locale]/products/[id]']);
  });

  it('treats global CSS imported by the root layout as affecting every page', async () => {
    const d = await discover(['src/app/globals.css']);
    assert.equal(routesOf(d).length, 5);
  });

  it('marks code reached only by route handlers as non-visual', async () => {
    const d = await discover(['src/lib/db.ts', 'src/app/api/health/route.ts']);
    assert.deepEqual(routesOf(d), []);
    assert.equal(kindOf(d, 'src/lib/db.ts'), 'nonVisual');
    assert.equal(kindOf(d, 'src/app/api/health/route.ts'), 'nonVisual');
    assert.equal(d.useDefault, false);
  });

  it('sends unmapped files to the default set', async () => {
    const d = await discover(['src/proxy.ts', 'src/components/Unused.tsx', 'package.json']);
    assert.deepEqual(d.unmapped.sort(), ['package.json', 'src/components/Unused.tsx', 'src/proxy.ts']);
    assert.equal(d.useDefault, true);
  });

  it('ignores docs and tests', async () => {
    const d = await discover(['README.md', 'tests/foo.test.ts', 'src/components/Button.test.tsx']);
    assert.ok(d.files.every((f) => f.kind === 'ignored'));
    assert.equal(d.useDefault, false);
  });

  it('applies impact rules before the graph', async () => {
    const d = await discover(['messages/ko.json', 'src/proxy.ts'], {
      config: { impact: [{ files: 'messages/**', screens: ['/ko'] }, { files: 'src/proxy.ts', screens: 'none' }] },
    });
    assert.deepEqual(routesOf(d), ['/ko']);
    assert.equal(d.useDefault, false);
  });

  it('uses the base tree for files deleted in head', async () => {
    const head = await treeFromDir(fixture);
    const base = {
      files: [...head.files, 'src/components/Old.tsx'],
      read: async (f) => (f === 'src/components/Old.tsx' ? 'export const Old = 1;' : f === 'src/app/page.tsx' ? "import { Old } from '@/components/Old';" : head.read(f)),
    };
    const d = await discover(['src/components/Old.tsx', 'src/app/page.tsx'], { base });
    assert.deepEqual(routesOf(d), ['/']);
    assert.equal(kindOf(d, 'src/components/Old.tsx'), 'routes');
  });
});

describe('import parsing', () => {
  it('extracts static, dynamic, re-export, require and CSS imports', () => {
    const src = `
      import a from './a';
      import type { B } from "./b";
      import {
        c,
        d,
      } from '@/c';
      export { e } from './e';
      export * from './f';
      import './side-effect.css';
      const g = await import('./g');
      const h = require('./h');
      @import url("./i.css");
    `;
    assert.deepEqual(extractSpecifiers(src).sort(), ['./a', './b', './e', './f', './g', './h', './i.css', './side-effect.css', '@/c'].sort());
  });
  it('parses JSONC with comments, trailing commas and slashes in strings', () => {
    assert.deepEqual(parseJsonc('{ // c\n "a": "http://x/*y*/", /* z */ "b": [1,2,], }'), { a: 'http://x/*y*/', b: [1, 2] });
  });
});
