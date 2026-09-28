import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const CONFIG_NAMES = ['runup.config.mjs', 'runup.config.js', 'runup.config.json'];

export const DEFAULTS = {
  framework: 'next-app',
  appDir: undefined, // auto: src/app or app
  pageExtensions: ['tsx', 'ts', 'jsx', 'js', 'mdx'],
  params: {},
  paths: {},
  maxPathsPerRoute: 3,
  maxScreens: 40,
  defaultScreens: ['/'],
  ignore: [],
  impact: [],
  exclude: [],
  states: [{ name: 'default' }],
  server: {
    setup: [],
    copy: [],
    seed: null,
    start: null,
    ports: { base: 'auto', head: 'auto' },
    host: '127.0.0.1',
    ready: '/',
    timeoutMs: 180_000,
    env: {},
    worktreeDir: null, // default: <repo parent>/.runup-worktrees/<repo name>
  },
  capture: {
    widths: [390, 768, 1280],
    height: 900,
    colorSchemes: ['light', 'dark'],
    schemeInit: {},
    fullPage: true,
    maxHeight: 10_000,
    deviceScaleFactor: 1,
    timezoneId: 'UTC',
    locale: undefined,
    mask: ['iframe', 'video', '[data-runup-mask]'],
    hide: [],
    css: '',
    freezeTime: '2026-01-01T09:00:00Z',
    waitUntil: 'load',
    networkIdleMs: 5_000,
    settleMs: 300,
    imagesTimeoutMs: 10_000,
    navigationTimeoutMs: 60_000,
    concurrency: 2,
    warmup: true,
  },
  devices: {
    enabled: true,
    profiles: ['iPhone 15', 'Pixel 7', 'iPad (gen 7)'],
    browsers: ['chromium', 'webkit'],
    colorSchemes: null, // null: same as capture.colorSchemes
  },
  compare: {
    threshold: 0.1,
    minDiffPixels: 0,
    minDiffRatio: 0,
    retakes: 1,
  },
  outDir: '.runup',
};

function isPlainObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

export function mergeConfig(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over ?? {})) {
    if (v === undefined) continue;
    out[k] = isPlainObject(v) && isPlainObject(base[k]) ? mergeConfig(base[k], v) : v;
  }
  return out;
}

export async function findConfig(root) {
  for (const name of CONFIG_NAMES) {
    const p = path.join(root, name);
    try {
      await fs.access(p);
      return p;
    } catch {
      // try next
    }
  }
  return null;
}

export async function loadConfig(root, explicitPath) {
  const file = explicitPath ? path.resolve(explicitPath) : await findConfig(root);
  let user = {};
  if (file) {
    if (file.endsWith('.json')) user = JSON.parse(await fs.readFile(file, 'utf8'));
    else user = (await import(`${pathToFileURL(file).href}?t=${Date.now()}`)).default ?? {};
  }
  const config = mergeConfig(DEFAULTS, user);
  validate(config);
  return { config, file };
}

export function validate(config) {
  const errors = [];
  if (config.framework !== 'next-app') errors.push(`framework "${config.framework}" is not supported (only "next-app")`);
  if (!Array.isArray(config.defaultScreens) || !config.defaultScreens.length) errors.push('defaultScreens must be a non-empty array of paths');
  if (!config.capture.widths?.length) errors.push('capture.widths must not be empty');
  if (!config.capture.colorSchemes?.length) errors.push('capture.colorSchemes must not be empty');
  for (const s of config.states) if (!s?.name) errors.push('every state needs a name');
  const names = config.states.map((s) => s.name);
  if (new Set(names).size !== names.length) errors.push('state names must be unique');
  for (const b of config.devices.browsers) if (!['chromium', 'webkit', 'firefox'].includes(b)) errors.push(`unknown browser "${b}"`);
  if (errors.length) throw new Error(`invalid runup config:\n  - ${errors.join('\n  - ')}`);
}
