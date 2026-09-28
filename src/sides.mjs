import path from 'node:path';
import { addWorktree, removeWorktree } from './git.mjs';
import { startServer } from './server.mjs';
import { log } from './util.mjs';

/**
 * Start the base and head app servers, each in its own worktree (or use `baseUrl`/`headUrl` when given).
 * Used by both the report run and `runup live`. Call `cleanup()` when done; SIGINT/SIGTERM do it too.
 */
export async function startSides({ root, config, baseSha, headSha, opts = {}, logDir }) {
  const short = (s) => s.slice(0, 7);
  const servers = [];
  const worktrees = [];
  // Every caller (the run, a signal handler, `runup live`) waits for the same cleanup to finish.
  let cleaning = null;
  const cleanup = () =>
    (cleaning ??= (async () => {
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
      await Promise.all(servers.map((s) => s.stop()));
      if (!opts.keepWorktrees) await Promise.all(worktrees.map((w) => removeWorktree(root, w)));
    })());
  function onSignal() {
    log('interrupted, cleaning up');
    cleanup().finally(() => process.exit(130));
  }
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  const urls = { base: opts.baseUrl, head: opts.headUrl };
  try {
    const wtRoot = config.server.worktreeDir
      ? path.resolve(root, config.server.worktreeDir)
      : path.join(path.dirname(root), '.runup-worktrees', path.basename(root));
    const sides = [
      ['base', baseSha],
      ['head', headSha],
    ].filter(([side]) => !urls[side]);
    await Promise.all(
      sides.map(async ([side, sha]) => {
        const dir = path.join(wtRoot, `${side}-${short(sha)}`);
        const wt = await addWorktree(root, dir, sha);
        worktrees.push(dir);
        if (wt.reused) log(`${side}: reusing kept worktree ${dir} (setup skipped)`);
        const handle = await startServer({ side, dir, repo: root, server: config.server, logDir, skipSetup: wt.reused });
        servers.push(handle);
        urls[side] = handle.url;
      }),
    );
  } catch (err) {
    await cleanup();
    throw err;
  }
  return { baseUrl: urls.base, headUrl: urls.head, servers, cleanup };
}
