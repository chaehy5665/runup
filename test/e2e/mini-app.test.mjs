import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import playwright from 'playwright';

const exec = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const example = path.join(repoRoot, 'examples', 'mini-app');
const bin = path.join(repoRoot, 'bin', 'runup.mjs');

async function chromiumAvailable() {
  try {
    const b = await playwright.chromium.launch();
    await b.close();
    return true;
  } catch {
    return false;
  }
}

const git = (cwd, ...args) => exec('git', args, { cwd });

describe('runup end to end on the example app', { skip: !(await chromiumAvailable()) && 'Chromium is not installed (npx playwright install chromium)' }, () => {
  let tmp;
  let repo;
  let report;
  let reportDir;
  let stdout;

  before(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'runup-e2e-'));
    repo = path.join(tmp, 'app');
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
    const about = path.join(repo, 'app', '(marketing)', 'about', 'page.html');
    await fs.writeFile(about, (await fs.readFile(about, 'utf8')).replace('We make small things', 'We make <strong>tiny</strong> things'));
    const post = path.join(repo, 'app', 'blog', '[slug]', 'page.html');
    await fs.writeFile(post, (await fs.readFile(post, 'utf8')).replace('</article>', '  <p class="card">New footer note</p>\n</article>'));
    await fs.writeFile(path.join(repo, 'README.md'), '# docs only\n');
    await git(repo, 'add', '-A');
    await git(repo, 'commit', '-q', '-m', 'head');

    const res = await exec(process.execPath, [bin, 'main', 'feature', '-C', repo, '-o', path.join(tmp, 'out'), '-e', '/about', '-e', '/'], {
      env: { ...process.env, RUNUP_QUIET: '1' },
      timeout: 240_000,
    });
    stdout = res.stdout;
    reportDir = path.join(tmp, 'out', (await fs.readdir(path.join(tmp, 'out')))[0]);
    report = JSON.parse(await fs.readFile(path.join(reportDir, 'report.json'), 'utf8'));
  });

  after(async () => {
    if (tmp) await fs.rm(tmp, { recursive: true, force: true });
  });

  it('prints a one-line summary and the report paths', () => {
    assert.match(stdout, /2\/3 screens changed/);
    assert.match(stdout, /UNEXPECTED: \/blog\/hello/);
    assert.match(stdout, /index\.html/);
  });

  it('checks the changed screens plus the author list, and nothing else', () => {
    assert.deepEqual(report.screens.map((s) => s.path).sort(), ['/', '/about', '/blog/hello']);
    const about = report.screens.find((s) => s.path === '/about');
    assert.equal(about.route, '/about');
    assert.deepEqual(about.sources, ['author', 'diff']);
  });

  it('flags a changed screen the author did not list', () => {
    const post = report.screens.find((s) => s.path === '/blog/hello');
    assert.equal(post.changed, true);
    assert.equal(post.unexpected, true);
    assert.ok(report.warnings.some((w) => w.type === 'unexpected-change' && w.path === '/blog/hello'));
    assert.equal(report.summary.unexpectedScreens, 1);
  });

  it('reports the unchanged screen without images', () => {
    const home = report.screens.find((s) => s.path === '/');
    assert.equal(home.changed, false);
    for (const cut of report.cuts.filter((c) => c.path === '/')) {
      assert.equal(cut.status, 'unchanged');
      assert.equal(cut.images, null);
    }
  });

  it('masks the iframe so it never counts as a change', async () => {
    const cut = report.cuts.find((c) => c.path === '/blog/hello' && c.kind === 'viewport' && c.width === 1024 && c.colorScheme === 'light');
    assert.equal(cut.status, 'changed');
    assert.ok(cut.boxes.length >= 1);
  });

  it('shoots viewports and devices, and keeps images only for changed cuts', async () => {
    const aboutCuts = report.cuts.filter((c) => c.path === '/about');
    // 2 widths × 2 schemes + 2 devices × 1 browser × 1 scheme
    assert.equal(aboutCuts.length, 6);
    assert.ok(aboutCuts.some((c) => c.kind === 'device' && c.device === 'iPhone 15'));
    for (const cut of aboutCuts.filter((c) => c.changed)) {
      for (const rel of Object.values(cut.images)) await fs.access(path.join(reportDir, rel));
      assert.ok(cut.diffRatio > 0);
    }
  });

  it('records why each file mattered', () => {
    const readme = report.changedFiles.find((f) => f.file === 'README.md');
    assert.equal(readme.kind, 'ignored');
    const about = report.changedFiles.find((f) => f.file === 'app/(marketing)/about/page.html');
    assert.deepEqual(about.routes, ['/about']);
  });

  it('writes a static HTML report with sliders for changed cuts only', async () => {
    const html = await fs.readFile(path.join(reportDir, 'index.html'), 'utf8');
    assert.match(html, /Unexpected change/);
    assert.match(html, /class="slider"/);
    assert.doesNotMatch(html, /src="https?:/);
  });

  it('cleans up the worktrees', async () => {
    const { stdout: list } = await git(repo, 'worktree', 'list');
    assert.equal(list.trim().split('\n').length, 1);
  });
});
