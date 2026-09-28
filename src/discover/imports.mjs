import path from 'node:path';

/**
 * A light, regex-based import graph. It does not try to be a bundler: it resolves relative imports,
 * tsconfig/jsconfig `paths` aliases and `baseUrl`, and ignores bare package imports. That is enough to
 * answer "which pages can this changed component or stylesheet reach?".
 */

export const SOURCE_EXTENSIONS = ['.tsx', '.ts', '.jsx', '.js', '.mjs', '.cjs', '.mts', '.cts', '.mdx', '.css', '.scss', '.sass'];

const IMPORT_PATTERNS = [
  /\b(?:import|export)\s+(?:type\s+)?[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]/g,
  /\bimport\s*['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /@(?:import|use|forward)\s+(?:url\(\s*)?['"]([^'"]+)['"]/g,
];

export function extractSpecifiers(source) {
  const specs = new Set();
  for (const re of IMPORT_PATTERNS) {
    re.lastIndex = 0;
    for (const m of source.matchAll(re)) specs.add(m[1]);
  }
  return [...specs];
}

/** Strip // and /* *\/ comments and trailing commas from JSONC, leaving string contents alone. */
export function parseJsonc(text) {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === '\\') out += text[++i] ?? '';
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
      out += c;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++;
    } else {
      out += c;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

/** Read `paths`/`baseUrl` from the root tsconfig.json or jsconfig.json of a tree. */
export async function loadAliases(tree) {
  for (const name of ['tsconfig.json', 'jsconfig.json']) {
    const text = await tree.read(name);
    if (text == null) continue;
    try {
      const opts = parseJsonc(text).compilerOptions ?? {};
      const baseDir = path.posix.normalize(opts.baseUrl ?? '.');
      const paths = Object.entries(opts.paths ?? {}).map(([pattern, targets]) => ({ pattern, targets }));
      return { baseDir: baseDir === '.' ? '' : baseDir, paths, hasBaseUrl: opts.baseUrl != null };
    } catch {
      return { baseDir: '', paths: [], hasBaseUrl: false };
    }
  }
  return { baseDir: '', paths: [], hasBaseUrl: false };
}

function join(...parts) {
  const p = path.posix.normalize(path.posix.join(...parts));
  return p === '.' ? '' : p.replace(/^\.\//, '');
}

export function createResolver(fileSet, aliases) {
  function probe(target) {
    if (target.startsWith('..')) return null;
    const candidates = [target];
    for (const ext of SOURCE_EXTENSIONS) candidates.push(target + ext);
    for (const ext of SOURCE_EXTENSIONS) candidates.push(`${target}/index${ext}`);
    const jsLike = target.match(/^(.*)\.(js|jsx|mjs|cjs)$/);
    if (jsLike) for (const ext of ['.ts', '.tsx', '.mts', '.cts']) candidates.push(jsLike[1] + ext);
    return candidates.find((c) => fileSet.has(c)) ?? null;
  }

  return function resolve(fromFile, spec) {
    const clean = spec.split('?')[0];
    if (clean.startsWith('.')) return probe(join(path.posix.dirname(fromFile), clean));
    if (clean.startsWith('/')) return probe(clean.slice(1));
    for (const { pattern, targets } of aliases.paths) {
      const star = pattern.indexOf('*');
      let captured = null;
      if (star === -1) {
        if (clean === pattern) captured = '';
      } else {
        const prefix = pattern.slice(0, star);
        const suffix = pattern.slice(star + 1);
        if (clean.startsWith(prefix) && clean.endsWith(suffix) && clean.length >= prefix.length + suffix.length) {
          captured = clean.slice(prefix.length, clean.length - suffix.length);
        }
      }
      if (captured == null) continue;
      for (const t of targets) {
        const hit = probe(join(aliases.baseDir, t.replace('*', captured)));
        if (hit) return hit;
      }
    }
    if (aliases.hasBaseUrl) return probe(join(aliases.baseDir, clean));
    return null;
  };
}

/**
 * Build the reverse import graph of a tree: Map<file, Set<files that import it>>.
 * `include(file)` decides which files are parsed.
 */
export async function buildReverseGraph(tree, { include = () => true } = {}) {
  const sources = tree.files.filter((f) => SOURCE_EXTENSIONS.includes(path.posix.extname(f)) && include(f));
  if (tree.preload) await tree.preload(sources);
  const resolve = createResolver(new Set(tree.files), await loadAliases(tree));
  const reverse = new Map();
  for (const file of sources) {
    const text = await tree.read(file);
    if (text == null) continue;
    for (const spec of extractSpecifiers(text)) {
      const target = resolve(file, spec);
      if (!target || target === file) continue;
      if (!reverse.has(target)) reverse.set(target, new Set());
      reverse.get(target).add(file);
    }
  }
  return reverse;
}

/** Every file that transitively imports `start` (not including `start`). `stop(file)` ends a branch. */
export function importersOf(reverse, start, { stop = () => false } = {}) {
  const seen = new Set();
  const queue = [start];
  while (queue.length) {
    const cur = queue.shift();
    for (const importer of reverse.get(cur) ?? []) {
      if (seen.has(importer) || importer === start) continue;
      seen.add(importer);
      if (!stop(importer)) queue.push(importer);
    }
  }
  return seen;
}
