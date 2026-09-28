/* global window, document, history, getComputedStyle -- functions passed to evaluate() run in the page */
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import playwright from 'playwright';
import { freePort } from '../../src/util.mjs';

const exec = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const example = path.resolve(here, '..', '..', 'examples', 'mini-app');
const git = (cwd, ...args) => exec('git', args, { cwd });

async function chromiumAvailable() {
  try {
    const b = await playwright.chromium.launch();
    await b.close();
    return true;
  } catch {
    return false;
  }
}

async function until(fn, { timeout = 10_000, message = 'condition' } = {}) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeout) {
    try {
      last = await fn();
      if (last) return last;
    } catch {
      // keep polling
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${message} (last: ${JSON.stringify(last)})`);
}

describe('runup live on the example app', { skip: !(await chromiumAvailable()) && 'Chromium is not installed' }, () => {
  let tmp;
  let live;
  let browser;
  let page;
  const frame = (side) => page.frames().find((f) => f.url().startsWith(`http://${side}.localhost:`));
  const logStatuses = () => page.$$eval('#log li', (lis) => lis.map((li) => `${li.querySelector('.what').textContent} ${li.querySelector('.chip').textContent}`));

  before(async () => {
    process.env.RUNUP_QUIET = '1';
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'runup-live-'));
    const repo = path.join(tmp, 'app');
    await fs.cp(example, repo, { recursive: true });
    const cfgPath = path.join(repo, 'runup.config.mjs');
    const cfg = await fs.readFile(cfgPath, 'utf8');
    await fs.writeFile(cfgPath, cfg.replace("start: 'node server.mjs',", `start: 'node server.mjs',\n    worktreeDir: ${JSON.stringify(path.join(tmp, 'worktrees'))},`));
    await git(repo, 'init', '-q', '-b', 'main');
    await git(repo, 'config', 'user.email', 'runup@example.com');
    await git(repo, 'config', 'user.name', 'runup');
    await git(repo, 'add', '-A');
    await git(repo, 'commit', '-q', '-m', 'base');
    await git(repo, 'checkout', '-q', '-b', 'feature');
    const contact = path.join(repo, 'app', 'contact', 'page.html');
    const html = (await fs.readFile(contact, 'utf8'))
      .replace('id="toggle"', 'id="toggle-details"') // same place, new id: mirrored by position
      .replace(' <button type="button" class="extra">Extra</button>', '') // gone in head: not found
      .replace('<h1>Contact</h1>', '<h1>Contact us</h1>');
    await fs.writeFile(contact, html);
    await git(repo, 'commit', '-q', '-am', 'head');

    // A report for the same commits turns on diff boxes in the live view.
    const bin = path.resolve(here, '..', '..', 'bin', 'runup.mjs');
    await exec(process.execPath, [bin, 'main', 'feature', '-C', repo, '-o', path.join(tmp, 'out'), '--no-devices'], { env: { ...process.env, RUNUP_QUIET: '1' }, timeout: 180_000 });

    const { startLive } = await import('../../src/live/server.mjs');
    live = await startLive({ base: 'main', head: 'feature', cwd: repo, port: await freePort(), out: path.join(tmp, 'out') });
    browser = await playwright.chromium.launch();
    page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    await page.goto(live.url);
    await until(() => frame('base') && frame('head'), { message: 'both panes' });
    await until(async () => (await frame('head').locator('h1').textContent()) === 'Contact us', { message: 'head contact page' });
    await until(async () => (await frame('base').locator('h1').textContent()) === 'Contact', { message: 'base contact page' });
  });

  after(async () => {
    await browser?.close();
    await live?.close();
    if (tmp) await fs.rm(tmp, { recursive: true, force: true });
  });

  it('opens the changed screen from the diff in both panes', async () => {
    const screens = await page.$$eval('#screens .path code', (els) => els.map((e) => e.textContent));
    assert.deepEqual(screens, ['/contact']);
    assert.equal(await page.locator('#pane-base .url').textContent(), '/contact');
    assert.equal(await page.locator('#pane-head .url').textContent(), '/contact');
  });

  it('draws the report diff boxes over the live panes', async () => {
    assert.ok(live.report);
    assert.ok(await page.locator('#boxes').isChecked());
    await until(async () => (await page.locator('#pane-head .boxes i').count()) > 0, { message: 'diff boxes' });
    assert.equal(await page.locator('#pane-base .boxes i').count(), await page.locator('#pane-head .boxes i').count());
    assert.match(await page.locator('#status').textContent(), /\d+ boxes/);
    // Boxes are in page coordinates: they move with the pane's own scroll.
    const top = () => page.locator('#pane-base .boxes i').first().evaluate((el) => parseFloat(el.style.top));
    const before = await top();
    await frame('base').evaluate(() => window.scrollTo(0, 100));
    await until(async () => Math.abs((await top()) - (before - 100)) < 0.5, { message: 'boxes follow scroll' });
    await frame('base').evaluate(() => window.scrollTo(0, 0));
    await until(async () => Math.abs((await top()) - before) < 0.5, { message: 'boxes back' });
    await page.locator('#boxes').uncheck();
    assert.ok(await page.locator('#pane-head .boxes').isHidden());
    await page.locator('#boxes').check();
  });

  it('frames pages that send X-Frame-Options and frame-ancestors, with the agent injected', async () => {
    // fetch() will not send a custom Host header, so use http.request.
    const res = await new Promise((resolve, reject) => {
      http
        .get({ host: '127.0.0.1', port: live.port, path: '/contact', headers: { host: `head.localhost:${live.port}` } }, (r) => {
          let body = '';
          r.on('data', (c) => (body += c));
          r.on('end', () => resolve({ headers: r.headers, body }));
        })
        .on('error', reject);
    });
    assert.equal(res.headers['x-frame-options'], undefined);
    assert.doesNotMatch(res.headers['content-security-policy'] ?? '', /frame-ancestors/);
    assert.match(res.headers['content-security-policy'] ?? '', /default-src 'self'/);
    // The example's CSP (default-src 'self' 'unsafe-inline') allows inline scripts: the agent is inlined at the end of <head>.
    assert.match(res.body, /<script data-runup-agent>window\.__RUNUP__=\{"side":"head"[\s\S]*<\/script>\s*<\/head>/);
  });

  it('mirrors typing into the other pane', async () => {
    await frame('base').locator('#name').pressSequentially('Ada', { delay: 30 });
    await until(async () => (await frame('head').locator('#name').inputValue()) === 'Ada', { message: 'head input' });
    assert.equal(await frame('head').locator('#echo').textContent(), 'Hello, Ada (hello).');
  });

  it('mirrors a select change', async () => {
    // selectOption() fires untrusted events, which the agent ignores by design; use the keyboard like a person.
    await frame('head').locator('#topic').focus();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await until(async () => (await frame('base').locator('#topic').inputValue()) === 'idea', { message: 'base select' });
    assert.equal(await frame('base').locator('#echo').textContent(), 'Hello, Ada (idea).');
  });

  it('falls back to the position when the element path is gone', async () => {
    await frame('base').locator('#toggle').click();
    await until(async () => !(await frame('head').locator('#details').isHidden()), { message: 'head details shown' });
    assert.ok(!(await frame('base').locator('#details').isHidden()));
    await until(async () => (await logStatuses()).some((s) => s.startsWith('click button "Show details"') && s.endsWith('by position')), { message: 'position status' });
  });

  it('mirrors a click on an icon inside a button as a click on the button', async () => {
    await frame('base').locator('#star svg path').click({ force: true });
    await until(async () => (await frame('head').locator('#stars').textContent()) === '1 stars', { message: 'head star count' });
    assert.equal(await frame('base').locator('#stars').textContent(), '1 stars');
    await until(async () => (await logStatuses()).some((s) => s.startsWith('click button "Star"') && s.endsWith('ok')), { message: 'star click ok' });
  });

  it('reports "not found" when the other side has no such element', async () => {
    await frame('base').locator('.extra').click();
    await until(async () => (await logStatuses()).some((s) => s.startsWith('click button "Extra"') && s.endsWith('not found')), { message: 'not found status' });
    assert.match(await page.locator('#pane-head .nf').textContent(), /1 not found/);
  });

  it('marks cross-origin iframes as controlled separately', async () => {
    await until(async () => /controlled separately/.test(await page.locator('#pane-head .frames').textContent()), { message: 'frames badge' });
    assert.equal(await frame('head').locator('[data-runup-overlay]', { hasText: 'controlled separately' }).textContent(), 'controlled separately · 따로 조작');
  });

  it('mirrors scrolling', async () => {
    const box = await page.locator('#pane-base .viewport').boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, 500);
    await until(async () => (await frame('base').evaluate(() => window.scrollY)) > 100, { message: 'base scrolled' });
    const target = await until(async () => {
      const [b, h] = await Promise.all([frame('base').evaluate(() => window.scrollY), frame('head').evaluate(() => window.scrollY)]);
      return b > 100 && Math.abs(b - h) <= 1 ? h : null;
    }, { message: 'head scrolled with base' });
    assert.ok(target > 100);
    await frame('head').evaluate(() => window.scrollTo(0, 0));
    await frame('base').evaluate(() => window.scrollTo(0, 0));
  });

  it('mirrors navigation through a link', async () => {
    await frame('head').locator('#about-link').click();
    await until(async () => frame('base')?.url().endsWith('/about') && frame('head')?.url().endsWith('/about'), { message: 'both on /about' });
    await until(async () => (await page.locator('#pane-base .url').textContent()) === '/about', { message: 'base url label' });
    assert.ok((await logStatuses()).some((s) => s.startsWith('click a "About us"') && s.endsWith('ok')));
  });

  it('moves both panes to a changed screen from the list', async () => {
    await page.locator('#screens button[data-path="/contact"][data-state="default"]').click();
    await until(async () => frame('base')?.url().endsWith('/contact') && frame('head')?.url().endsWith('/contact'), { message: 'both back on /contact' });
  });

  it('follows a route change the other side did not make, and flags one it cannot follow', async () => {
    // A client-side route change in head only (no click to mirror): base is sent to the same URL.
    await frame('head').locator('#name').click();
    await frame('head').evaluate(() => history.pushState({}, '', '/contact?step=2'));
    await until(() => frame('base')?.url().endsWith('/contact?step=2'), { message: 'base followed pushState' });
    // A URL only head has: base lands on a 404 page, which is still the same URL, so no "differs" there;
    // a redirect that only one side performs is what "route differs" catches, so fake one in base.
    await frame('base').locator('#name').click();
    await frame('base').evaluate(() => history.pushState({}, '', '/contact?from=base'));
    await until(() => frame('head')?.url().endsWith('/contact?from=base'), { message: 'head followed base' });
    await frame('head').evaluate(() => history.replaceState({}, '', '/contact?redirected=1'));
    await until(async () => (await page.locator('#pane-head .route').isVisible()) && /route differs/.test(await page.locator('#pane-head .route').textContent()), { message: 'route differs badge' });
  });

  it('switches to overlay with head over base at the chosen opacity', async () => {
    await page.click('#modeOverlay');
    assert.ok(await page.evaluate(() => document.body.classList.contains('overlay')));
    await page.locator('#opacity').fill('30');
    assert.equal(await page.locator('#frame-head').evaluate((f) => f.style.opacity), '0.3');
    await until(() => frame('base')?.url().includes('base.localhost'), { message: 'base under head' });
    const under = await page.locator('#frame-base-under').evaluate((f) => ({ src: f.src, visible: getComputedStyle(f).display !== 'none' }));
    assert.match(under.src, /^http:\/\/base\.localhost:/);
    assert.ok(under.visible);
    assert.ok(await page.locator('#pane-base').isHidden());
    await page.click('#modeSide');
    assert.ok(!(await page.evaluate(() => document.body.classList.contains('overlay'))));
    assert.equal(await page.locator('#frame-head').evaluate((f) => f.style.opacity), '1');
  });
});

describe('runup live from the CLI', { skip: !(await chromiumAvailable()) && 'Chromium is not installed' }, () => {
  it('stops both servers and removes the worktrees on Ctrl-C', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'runup-live-cli-'));
    try {
      const repo = path.join(tmp, 'app');
      await fs.cp(example, repo, { recursive: true });
      const cfgPath = path.join(repo, 'runup.config.mjs');
      await fs.writeFile(cfgPath, (await fs.readFile(cfgPath, 'utf8')).replace("start: 'node server.mjs',", `start: 'node server.mjs',\n    worktreeDir: ${JSON.stringify(path.join(tmp, 'worktrees'))},`));
      await git(repo, 'init', '-q', '-b', 'main');
      await git(repo, 'add', '-A');
      await git(repo, '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '-m', 'base');
      await git(repo, 'checkout', '-q', '-b', 'feature');
      await fs.appendFile(path.join(repo, 'app', 'page.html'), '<p>new</p>\n');
      await git(repo, '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '-am', 'head');

      const port = await freePort();
      const bin = path.resolve(here, '..', '..', 'bin', 'runup.mjs');
      const child = spawn(process.execPath, [bin, 'live', 'main', 'feature', '-C', repo, '--port', String(port)], { env: { ...process.env, RUNUP_QUIET: '1' } });
      let out = '';
      child.stdout.on('data', (d) => (out += d));
      await until(() => out.includes('Ctrl-C'), { timeout: 60_000, message: 'live ready' });
      assert.match(out, new RegExp(`ssh -L ${port}:127\\.0\\.0\\.1:${port}`));
      const { stdout: during } = await git(repo, 'worktree', 'list');
      assert.equal(during.trim().split('\n').length, 3);
      const exited = new Promise((r) => child.on('exit', (code) => r(code)));
      child.kill('SIGINT');
      assert.equal(await exited, 130);
      const { stdout: afterList } = await git(repo, 'worktree', 'list');
      assert.equal(afterList.trim().split('\n').length, 1);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});
