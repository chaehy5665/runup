import fs from 'node:fs/promises';
import path from 'node:path';
import { captureAll, planCuts } from './capture.mjs';
import { compareCuts } from './results.mjs';
import { loadConfig } from './config.mjs';
import { discoverNextApp } from './discover/next-app.mjs';
import { addWorktree, changedFiles, removeWorktree, repoRoot, resolveRef } from './git.mjs';
import { renderHtml } from './report/html.mjs';
import { buildReport } from './report/json.mjs';
import { buildScreens, parseAuthorList } from './screens.mjs';
import { startServer, warmUp } from './server.mjs';
import { treeFromGit } from './tree.mjs';
import { log, run as exec } from './util.mjs';

/** Everything up to the screen list: no servers, no browsers. */
export async function plan(opts) {
  const root = await repoRoot(opts.cwd ?? process.cwd());
  const { config, file: configFile } = await loadConfig(root, opts.config);
  const baseSha = await resolveRef(root, opts.base);
  const headSha = await resolveRef(root, opts.head);
  const changed = await changedFiles(root, baseSha, headSha);
  const [headTree, baseTree] = await Promise.all([treeFromGit(root, headSha), treeFromGit(root, baseSha)]);
  const discovered = await discoverNextApp({ head: headTree, base: baseTree, changed, config });
  const author = await readAuthorList(root, opts);
  const { screens, skipped } = buildScreens({ discovered, author: author.screens, config });
  return { root, config, configFile, baseSha, headSha, changed, discovered, author, screens, skipped };
}

async function readAuthorList(root, opts) {
  const screens = [];
  const sources = [];
  for (const e of opts.expect ?? []) screens.push(...parseAuthorList(e));
  if (opts.expect?.length) sources.push('--expect');
  if (opts.expectFile) {
    screens.push(...parseAuthorList(await fs.readFile(path.resolve(opts.cwd ?? '.', opts.expectFile), 'utf8')));
    sources.push(opts.expectFile);
  }
  if (opts.pr) {
    const body = await exec('gh', ['pr', 'view', String(opts.pr), '--json', 'body', '--jq', '.body'], { cwd: root });
    screens.push(...parseAuthorList(body, { requireFence: true }));
    sources.push(`PR #${opts.pr}`);
  }
  return { screens: [...new Set(screens)], sources };
}

export async function runup(opts) {
  const p = await plan(opts);
  const { root, config, baseSha, headSha, screens } = p;
  const short = (s) => s.slice(0, 7);
  const outRoot = path.resolve(root, opts.out ?? config.outDir);
  const reportDir = path.join(outRoot, `${short(baseSha)}-${short(headSha)}`);
  await fs.rm(reportDir, { recursive: true, force: true });
  await fs.mkdir(reportDir, { recursive: true });

  log(`base ${opts.base} (${short(baseSha)}) → head ${opts.head} (${short(headSha)}): ${p.changed.length} changed files, ${screens.length} screens`);
  for (const s of screens) log(`  ${s.path}  [${s.sources.join('+')}]`);
  for (const s of p.skipped) log(`  skip ${s.path ?? s.route}: ${s.reason}`);

  const cuts = planCuts(screens, config, { devices: opts.devices !== false });
  log(`${cuts.length} cuts planned`);

  const servers = [];
  const worktrees = [];
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    await Promise.all(servers.map((s) => s.stop()));
    if (!opts.keepWorktrees) await Promise.all(worktrees.map((w) => removeWorktree(root, w)));
  };
  const onSignal = () => {
    log('interrupted, cleaning up');
    cleanup().finally(() => process.exit(130));
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  const started = Date.now();
  try {
    let baseUrl = opts.baseUrl;
    let headUrl = opts.headUrl;
    if (!baseUrl || !headUrl) {
      const wtRoot = config.server.worktreeDir
        ? path.resolve(root, config.server.worktreeDir)
        : path.join(path.dirname(root), '.runup-worktrees', path.basename(root));
      const sides = [
        ['base', baseSha, baseUrl],
        ['head', headSha, headUrl],
      ].filter(([, , url]) => !url);
      const handles = await Promise.all(
        sides.map(async ([side, sha]) => {
          const dir = path.join(wtRoot, `${side}-${short(sha)}`);
          const wt = await addWorktree(root, dir, sha);
          worktrees.push(dir);
          if (wt.reused) log(`${side}: reusing kept worktree ${dir} (setup skipped)`);
          const handle = await startServer({ side, dir, repo: root, server: config.server, logDir: path.join(reportDir, 'logs'), skipSetup: wt.reused });
          servers.push(handle);
          return handle;
        }),
      );
      for (const h of handles) {
        if (h.side === 'base') baseUrl = h.url;
        else headUrl = h.url;
      }
    }

    if (config.capture.warmup) {
      log('warming up routes');
      await Promise.all([warmUp(baseUrl, screens.map((s) => s.path)), warmUp(headUrl, screens.map((s) => s.path))]);
    }

    let lastPct = -1;
    await captureAll({
      cuts,
      config,
      baseUrl,
      headUrl,
      onProgress: (done, total) => {
        const pct = Math.floor((done / total) * 10) * 10;
        if (pct !== lastPct) {
          lastPct = pct;
          log(`captured ${done}/${total}`);
        }
      },
    });
  } finally {
    await cleanup();
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }

  await compareCuts(cuts, { reportDir, compare: config.compare, keepAll: opts.keepAll });
  const serverNotes = servers.flatMap((s) => s.notes);
  const report = buildReport({ ...p, opts, cuts, reportDir, serverNotes, durationMs: Date.now() - started });
  const jsonPath = path.join(reportDir, 'report.json');
  const htmlPath = path.join(reportDir, 'index.html');
  await fs.writeFile(jsonPath, JSON.stringify(report, null, 2));
  await fs.writeFile(htmlPath, renderHtml(report));
  log(`report: ${htmlPath}`);
  return { report, htmlPath, jsonPath };
}
