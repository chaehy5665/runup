import path from 'node:path';
import picomatch from 'picomatch';
import { buildReverseGraph, importersOf } from './imports.mjs';

/**
 * Changed files → affected screens for a Next.js App Router project.
 *
 * - `page.*` is a screen. Its route comes from the folder path, dropping route groups `(x)` and
 *   parallel-route slots `@x`. Private folders `_x` and intercepting routes `(.)x` are not screens.
 * - `layout`, `template`, `loading`, `error`, `not-found`, … affect every page at or under their folder.
 * - Any other source file (component, hook, stylesheet) is followed through the import graph to the pages
 *   and layouts that reach it. Files that only reach route handlers are non-visual.
 * - Files that match nothing are "unmapped" and send the run to the default screen set.
 */

export const SCOPED_FILES = ['layout', 'template', 'loading', 'error', 'global-error', 'not-found', 'forbidden', 'unauthorized', 'default'];
const NON_VISUAL_FILES = ['route', 'sitemap', 'robots', 'manifest', 'icon', 'apple-icon', 'opengraph-image', 'twitter-image'];

export const DEFAULT_IGNORE = [
  '**/*.md',
  '**/*.mdx.snap',
  '**/*.test.*',
  '**/*.spec.*',
  '**/__tests__/**',
  '**/__snapshots__/**',
  'test/**',
  'tests/**',
  'e2e/**',
  'docs/**',
  '.github/**',
  '.vscode/**',
  '**/.gitignore',
  'LICENSE',
  '**/*.lock',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
];

export function detectAppDir(files, pageExtensions) {
  const exts = pageExtensions.map((e) => `.${e}`);
  for (const dir of ['src/app', 'app']) {
    if (files.some((f) => f.startsWith(`${dir}/`) && path.posix.basename(f).startsWith('page.') && exts.includes(path.posix.extname(f)))) {
      return dir;
    }
  }
  return 'app';
}

/** Route pattern for a folder relative to the app dir, or null when the folder cannot be a screen. */
export function routeForDir(relDir) {
  const kept = [];
  for (const seg of relDir.split('/').filter(Boolean)) {
    if (seg.startsWith('_')) return null;
    if (/^\(\.{1,3}\)/.test(seg) || seg.startsWith('(..)')) return null;
    if (/^\(.+\)$/.test(seg)) continue;
    if (seg.startsWith('@')) continue;
    kept.push(seg);
  }
  return `/${kept.join('/')}`;
}

function fileKind(file, appDir, exts) {
  if (!file.startsWith(`${appDir}/`)) return null;
  const ext = path.posix.extname(file);
  const name = path.posix.basename(file, ext);
  const rel = path.posix.dirname(file.slice(appDir.length + 1));
  const relDir = rel === '.' ? '' : rel;
  const isPageExt = exts.includes(ext);
  if (name === 'page' && isPageExt) return { type: 'page', relDir };
  if (SCOPED_FILES.includes(name) && isPageExt) return { type: 'scoped', relDir };
  if (NON_VISUAL_FILES.includes(name)) return { type: 'nonVisual', relDir };
  return { type: 'other', relDir };
}

export function listPages(files, { appDir, pageExtensions }) {
  const exts = pageExtensions.map((e) => `.${e}`);
  const pages = [];
  for (const file of files) {
    const kind = fileKind(file, appDir, exts);
    if (kind?.type !== 'page') continue;
    const route = routeForDir(kind.relDir);
    if (route) pages.push({ file, relDir: kind.relDir, route });
  }
  return pages;
}

/** Folder that bounds a file's effect: its own folder, cut back to before the first private `_x` folder. */
function scopeDir(relDir) {
  const segs = relDir.split('/').filter(Boolean);
  const cut = segs.findIndex((s) => s.startsWith('_'));
  return (cut === -1 ? segs : segs.slice(0, cut)).join('/');
}

function pagesUnder(pages, relDir) {
  return pages.filter((p) => !relDir || p.relDir === relDir || p.relDir.startsWith(`${relDir}/`));
}

/** Classify every changed file against one tree. */
async function analyzeTree(tree, changedFiles, opts) {
  const { pageExtensions, isIgnored } = opts;
  const exts = pageExtensions.map((e) => `.${e}`);
  const appDir = opts.appDir ?? detectAppDir(tree.files, pageExtensions);
  const pages = listPages(tree.files, { appDir, pageExtensions });
  const fileSet = new Set(tree.files);
  const reverse = await buildReverseGraph(tree, { include: (f) => !isIgnored(f) });
  const kindOf = (f) => fileKind(f, appDir, exts);
  const isTerminal = (f) => ['page', 'scoped'].includes(kindOf(f)?.type);

  const results = new Map();
  for (const file of changedFiles) {
    const routes = new Set();
    const kind = kindOf(file);
    const addScope = (relDir) => pagesUnder(pages, relDir).forEach((p) => routes.add(p.route));

    if (kind?.type === 'page') {
      const route = routeForDir(kind.relDir);
      if (route) routes.add(route);
      else addScope(scopeDir(kind.relDir));
      results.set(file, { kind: 'routes', routes });
      continue;
    }
    if (kind?.type === 'scoped') {
      addScope(scopeDir(kind.relDir));
      results.set(file, { kind: routes.size ? 'routes' : 'unmapped', routes });
      continue;
    }
    if (kind?.type === 'nonVisual') {
      results.set(file, { kind: 'nonVisual', routes });
      continue;
    }
    if (!fileSet.has(file)) {
      // Deleted in this tree: we can only reason about it by folder when it lived under the app dir.
      if (kind) {
        addScope(scopeDir(kind.relDir));
        results.set(file, { kind: routes.size ? 'routes' : 'absent', routes });
      } else {
        results.set(file, { kind: 'absent', routes });
      }
      continue;
    }

    const reached = importersOf(reverse, file, { stop: isTerminal });
    let reachedHandler = false;
    for (const importer of reached) {
      const k = kindOf(importer);
      if (k?.type === 'page') {
        const route = routeForDir(k.relDir);
        if (route) routes.add(route);
      } else if (k?.type === 'scoped') {
        addScope(scopeDir(k.relDir));
      } else if (k?.type === 'nonVisual') {
        reachedHandler = true;
      }
    }
    if (!routes.size && kind?.type === 'other') addScope(scopeDir(kind.relDir));
    if (routes.size) results.set(file, { kind: 'routes', routes });
    else if (reachedHandler) results.set(file, { kind: 'nonVisual', routes });
    else results.set(file, { kind: 'unmapped', routes });
  }
  return { appDir, pages, results };
}

const RANK = { routes: 3, nonVisual: 2, unmapped: 1, absent: 0 };

/**
 * @param {object} args
 * @param {object} args.head  tree at the head commit
 * @param {object} [args.base] tree at the base commit (lets deleted files and removed imports count)
 * @param {string[]} args.changed changed repo-relative paths
 * @param {object} args.config resolved runup config
 * @returns {Promise<{appDir: string, pages: object[], files: object[], routes: Map<string, Set<string>>, unmapped: string[], useDefault: boolean, useAll: boolean}>}
 */
export async function discoverNextApp({ head, base, changed, config }) {
  const ignoreMatch = picomatch([...DEFAULT_IGNORE, ...(config.ignore ?? [])], { dot: true });
  const isIgnored = (f) => ignoreMatch(f);
  const rules = (config.impact ?? []).map((r) => ({ ...r, match: picomatch(r.files, { dot: true }) }));
  const opts = { appDir: config.appDir, pageExtensions: config.pageExtensions, isIgnored };

  const candidates = [];
  const files = [];
  const routes = new Map();
  const addRoute = (route, file) => {
    if (!routes.has(route)) routes.set(route, new Set());
    routes.get(route).add(file);
  };
  let useDefault = false;
  let useAll = false;

  for (const file of changed) {
    if (isIgnored(file)) {
      files.push({ file, kind: 'ignored', routes: [] });
      continue;
    }
    const rule = rules.find((r) => r.match(file));
    if (rule) {
      const screens = rule.screens ?? 'default';
      if (screens === 'all') useAll = true;
      else if (screens === 'default') useDefault = true;
      else if (screens === 'none') { /* explicitly non-visual */ }
      else for (const s of [].concat(screens)) addRoute(s, file);
      files.push({ file, kind: 'rule', screens, routes: Array.isArray(screens) ? screens : [] });
      continue;
    }
    candidates.push(file);
  }

  const headResult = await analyzeTree(head, candidates, opts);
  const baseResult = base ? await analyzeTree(base, candidates, { ...opts, appDir: opts.appDir ?? headResult.appDir }) : null;
  const unmapped = [];

  for (const file of candidates) {
    const h = headResult.results.get(file);
    const b = baseResult?.results.get(file);
    const merged = new Set([...(h?.routes ?? []), ...(b?.routes ?? [])]);
    const kind = [h?.kind, b?.kind].filter(Boolean).sort((x, y) => RANK[y] - RANK[x])[0] ?? 'unmapped';
    const finalKind = kind === 'absent' ? 'unmapped' : kind;
    for (const r of merged) addRoute(r, file);
    if (finalKind === 'unmapped') {
      unmapped.push(file);
      useDefault = true;
    }
    files.push({ file, kind: finalKind, routes: [...merged].sort() });
  }

  if (useAll) for (const p of headResult.pages) addRoute(p.route, '(impact rule: all)');

  files.sort((a, b) => a.file.localeCompare(b.file));
  return { appDir: headResult.appDir, pages: headResult.pages, files, routes, unmapped, useDefault, useAll };
}
