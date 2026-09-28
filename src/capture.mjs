/* global window, document -- functions passed to page.evaluate run in the browser */
import playwright from 'playwright';
import { comparePngs } from './compare.mjs';
import { isGlob, pathMatchesRoute, routeGlob } from './screens.mjs';
import { log, mapLimit, slug } from './util.mjs';

/**
 * Plan every cut: screen × state × (width × color scheme on desktop Chromium) plus
 * screen × state × (device profile × browser × color scheme).
 */
export function planCuts(screens, config, { devices = true } = {}) {
  const cuts = [];
  const { capture } = config;
  const deviceSchemes = config.devices.colorSchemes ?? capture.colorSchemes;
  for (const screen of screens) {
    for (const state of statesFor(screen, config.states)) {
      const base = { path: screen.path, state: state.name };
      for (const colorScheme of capture.colorSchemes) {
        for (const width of capture.widths) {
          cuts.push({ ...base, kind: 'viewport', browser: 'chromium', width, height: capture.height, colorScheme });
        }
      }
      if (devices && config.devices.enabled) {
        for (const device of config.devices.profiles) {
          for (const browser of config.devices.browsers) {
            for (const colorScheme of deviceSchemes) {
              cuts.push({ ...base, kind: 'device', browser, device, colorScheme });
            }
          }
        }
      }
    }
  }
  for (const cut of cuts) cut.id = cutId(cut);
  return cuts;
}

export function cutId(cut) {
  const where = cut.kind === 'viewport' ? `w${cut.width}` : `${slug(cut.device)}-${cut.browser}`;
  return [slug(cut.path), slug(cut.state), where, cut.colorScheme].join('__');
}

/** States that apply to a screen: those without `routes`, plus those whose `routes` match it. */
export function statesFor(screen, states) {
  return states.filter((s) => {
    if (!s.routes) return true;
    return [].concat(s.routes).some((r) => {
      if (!isGlob(r)) return r === screen.path || r === screen.route || pathMatchesRoute(screen.path, r);
      const match = routeGlob(r);
      return match(screen.path) || (screen.route != null && match(screen.route));
    });
  });
}

function contextKey(cut) {
  return [cut.browser, cut.kind === 'viewport' ? `w${cut.width}` : cut.device, cut.colorScheme].join('|');
}

function contextOptions(cut, config) {
  const { capture } = config;
  const common = {
    colorScheme: cut.colorScheme,
    reducedMotion: 'reduce',
    locale: capture.locale,
    timezoneId: capture.timezoneId ?? 'UTC',
    ignoreHTTPSErrors: true,
  };
  if (cut.kind === 'viewport') {
    return { ...common, viewport: { width: cut.width, height: cut.height }, deviceScaleFactor: capture.deviceScaleFactor ?? 1 };
  }
  const descriptor = playwright.devices[cut.device];
  if (!descriptor) throw new Error(`unknown Playwright device "${cut.device}"`);
  const { defaultBrowserType: _ignored, ...rest } = descriptor;
  if (cut.browser === 'firefox') delete rest.isMobile;
  return { ...rest, ...common };
}

async function applyStep(page, step) {
  if (step.click) return page.locator(step.click).first().click();
  if (step.hover) return page.locator(step.hover).first().hover();
  if (step.fill) return page.locator(step.fill[0]).first().fill(String(step.fill[1]));
  if (step.press) {
    if (Array.isArray(step.press)) return page.locator(step.press[0]).first().press(step.press[1]);
    return page.keyboard.press(step.press);
  }
  if (step.scroll) return page.locator(step.scroll).first().scrollIntoViewIfNeeded();
  if (step.waitFor) return page.locator(step.waitFor).first().waitFor({ state: 'visible' });
  if (step.wait) return page.waitForTimeout(step.wait);
  if (step.evaluate) return page.evaluate(step.evaluate);
  throw new Error(`unknown state step: ${JSON.stringify(step)}`);
}

function withQuery(p, query) {
  if (!query) return p;
  const q = typeof query === 'string' ? query.replace(/^\?/, '') : new URLSearchParams(query).toString();
  return p.includes('?') ? `${p}&${q}` : `${p}?${q}`;
}

async function shoot({ context, baseUrl, cut, state, config, side }) {
  const { capture } = config;
  const page = await context.newPage();
  try {
    page.setDefaultTimeout(capture.navigationTimeoutMs);
    if (state.localStorage) {
      await page.addInitScript((items) => {
        for (const [k, v] of Object.entries(items)) window.localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v));
      }, state.localStorage);
    }
    const url = new URL(withQuery(cut.path, state.query), baseUrl).href;
    await page.goto(url, { waitUntil: capture.waitUntil, timeout: capture.navigationTimeoutMs });
    await page.waitForLoadState('networkidle', { timeout: capture.networkIdleMs }).catch(() => {});
    await page.evaluate(() => document.fonts?.ready).catch(() => {});
    await page
      .waitForFunction(() => [...document.images].every((img) => img.complete), null, { timeout: capture.imagesTimeoutMs ?? 10_000 })
      .catch(() => {});
    for (const step of state.steps ?? []) await applyStep(page, step);
    if (typeof state.run === 'function') await state.run({ page, side, path: cut.path });
    if (capture.settleMs) await page.waitForTimeout(capture.settleMs);

    const hideCss = capture.hide.length ? `${capture.hide.join(', ')} { visibility: hidden !important; }` : '';
    const style = [
      '*, *::before, *::after { caret-color: transparent !important; }',
      hideCss,
      capture.css ?? '',
    ].join('\n');
    const mask = capture.mask.map((sel) => page.locator(sel));
    const shotOpts = { animations: 'disabled', caret: 'hide', mask, maskColor: '#FF00FF', style, fullPage: capture.fullPage };
    if (capture.fullPage && capture.maxHeight) {
      const size = await page.evaluate(() => ({
        w: document.documentElement.clientWidth,
        h: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0),
      }));
      if (size.h > capture.maxHeight) shotOpts.clip = { x: 0, y: 0, width: size.w, height: capture.maxHeight };
    }
    return await page.screenshot(shotOpts);
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * Take every planned cut on both servers. Base and head for the same cut are shot back to back in
 * identical contexts. Returns cuts with `before`/`after` buffers, or `skipped`/`error` set.
 */
export async function captureAll({ cuts, config, baseUrl, headUrl, onProgress = () => {} }) {
  const statesByName = new Map(config.states.map((s) => [s.name, s]));
  const browsers = new Map();
  const getBrowser = (name) => {
    if (!browsers.has(name)) {
      browsers.set(
        name,
        playwright[name].launch().then(
          (b) => b,
          (err) => {
            const lines = String(err.message).split('\n').map((l) => l.replace(/[║╔╗╚╝═]/g, '').trim()).filter(Boolean);
            const first = lines.find((l) => !/^browserType\.launch:?$/.test(l)) ?? 'launch failed';
            log(`${name}: cannot launch (${first.trim()}); its cuts are skipped`);
            return new Error(first.trim());
          },
        ),
      );
    }
    return browsers.get(name);
  };

  const groups = new Map();
  for (const cut of cuts) {
    const key = contextKey(cut);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(cut);
  }

  let done = 0;
  try {
    await mapLimit([...groups.values()], config.capture.concurrency, async (group) => {
      const first = group[0];
      const browser = await getBrowser(first.browser);
      if (browser instanceof Error) {
        for (const cut of group) cut.skipped = `${first.browser} unavailable: ${browser.message}`;
        done += group.length;
        onProgress(done, cuts.length);
        return;
      }
      let options;
      try {
        options = contextOptions(first, config);
      } catch (err) {
        for (const cut of group) cut.skipped = err.message;
        done += group.length;
        onProgress(done, cuts.length);
        return;
      }
      const contexts = {};
      for (const side of ['base', 'head']) {
        contexts[side] = await browser.newContext(options);
        if (config.capture.freezeTime) await contexts[side].clock.setFixedTime(new Date(config.capture.freezeTime));
        const init = config.capture.schemeInit?.[first.colorScheme];
        if (init) await contexts[side].addInitScript(init);
      }
      try {
        for (const cut of group) {
          const state = statesByName.get(cut.state);
          const take = async () => {
            delete cut.errors;
            for (const [side, url, key] of [['base', baseUrl, 'before'], ['head', headUrl, 'after']]) {
              try {
                cut[key] = await shoot({ context: contexts[side], baseUrl: url, cut, state, config, side });
              } catch (err) {
                cut[key] = undefined;
                cut.errors = { ...(cut.errors ?? {}), [side]: String(err.message).split('\n')[0] };
              }
            }
          };
          await take();
          // A difference can be a slow image or font on one side. Shoot both sides again; only a difference
          // that survives the retake counts. The first result is kept on the cut as `flaky` when it vanished.
          for (let i = 0; i < (config.compare.retakes ?? 0); i++) {
            if (!cut.before || !cut.after || !comparePngs(cut.before, cut.after, config.compare).changed) break;
            await take();
            const still = cut.before && cut.after && comparePngs(cut.before, cut.after, config.compare).changed;
            cut.retakes = i + 1;
            if (!still) cut.flaky = true;
          }
          done++;
          onProgress(done, cuts.length);
        }
      } finally {
        await contexts.base.close().catch(() => {});
        await contexts.head.close().catch(() => {});
      }
    });
  } finally {
    for (const b of browsers.values()) {
      const browser = await b;
      if (!(browser instanceof Error)) await browser.close().catch(() => {});
    }
  }
  return cuts;
}
