import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { freePort, log, portInUse, sh, sleep } from './util.mjs';

/**
 * Prepare and start one app server inside a worktree.
 * Every command runs with PORT, RUNUP_SIDE (base|head), RUNUP_REPO (the main checkout) and
 * RUNUP_WORKTREE set, so config commands can do things like `cp -al "$RUNUP_REPO/node_modules" .`.
 */
export async function startServer({ side, dir, repo, server, logDir, skipSetup = false }) {
  await fsp.mkdir(logDir, { recursive: true });
  const logFile = path.join(logDir, `${side}.log`);
  const logStream = fs.createWriteStream(logFile, { flags: 'a' });
  logStream.on('error', () => {});

  const wanted = server.ports?.[side] ?? 'auto';
  const port = wanted === 'auto' ? await freePort() : Number(wanted);
  if (await portInUse(port, server.host)) {
    throw new Error(`${side}: port ${port} is already in use (set server.ports.${side} or stop what is using it)`);
  }
  const env = {
    ...process.env,
    ...server.env,
    PORT: String(port),
    RUNUP_SIDE: side,
    RUNUP_REPO: repo,
    RUNUP_WORKTREE: dir,
  };

  const notes = [];
  if (!skipSetup) {
    for (const rel of server.copy ?? []) {
      const from = path.join(repo, rel);
      const to = path.join(dir, rel);
      try {
        await fsp.access(from);
      } catch {
        log(`${side}: copy: ${rel} is not in ${repo}, skipped`);
        notes.push(`${side}: server.copy skipped ${rel} (not found in ${repo})`);
        continue;
      }
      try {
        await fsp.mkdir(path.dirname(to), { recursive: true });
        await fsp.cp(from, to, { recursive: true });
      } catch (err) {
        throw new Error(`${side}: could not copy ${rel} from the repo: ${err.message}`, { cause: err });
      }
    }
    for (const command of [].concat(server.setup ?? [])) {
      log(`${side}: setup: ${command}`);
      logStream.write(`\n$ ${command}\n`);
      await sh(command, { cwd: dir, env, log: logStream }).catch((err) => {
        throw new Error(`${side}: ${err.message} (see ${logFile})`, { cause: err });
      });
    }
  }
  if (server.seed) {
    log(`${side}: seed: ${server.seed}`);
    logStream.write(`\n$ ${server.seed}\n`);
    await sh(server.seed, { cwd: dir, env, log: logStream });
  }

  if (!server.start) throw new Error('server.start is not set in the runup config');
  log(`${side}: start on port ${port}: ${server.start}`);
  logStream.write(`\n$ ${server.start}\n`);
  const child = spawn(server.start, { cwd: dir, env, shell: true, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(logStream, { end: false });
  child.stderr.pipe(logStream, { end: false });
  let exited = null;
  child.on('exit', (code, signal) => {
    exited = signal ?? `exit ${code}`;
  });

  const url = `http://${server.host}:${port}`;
  const handle = {
    side,
    port,
    url,
    logFile,
    notes,
    async stop() {
      if (exited == null) {
        try {
          process.kill(-child.pid, 'SIGTERM');
        } catch {
          // already gone
        }
        for (let i = 0; i < 50 && exited == null; i++) await sleep(100);
        if (exited == null) {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {
            // already gone
          }
        }
      }
      logStream.end();
    },
  };

  const deadline = Date.now() + server.timeoutMs;
  const readyUrl = new URL(server.ready ?? '/', url).href;
  while (Date.now() < deadline) {
    if (exited != null) {
      await handle.stop();
      throw new Error(`${side}: server exited (${exited}) before it was ready. Last log lines:\n${await tail(logFile)}`);
    }
    try {
      const res = await fetch(readyUrl, { redirect: 'manual', signal: AbortSignal.timeout(30_000) });
      if (res.status < 500) {
        log(`${side}: ready at ${url} (${res.status})`);
        return handle;
      }
    } catch {
      // not up yet
    }
    await sleep(500);
  }
  await handle.stop();
  throw new Error(`${side}: server did not answer ${readyUrl} within ${server.timeoutMs} ms. Last log lines:\n${await tail(logFile)}`);
}

async function tail(file, lines = 20) {
  try {
    return (await fsp.readFile(file, 'utf8')).split('\n').slice(-lines).join('\n');
  } catch {
    return '(no log)';
  }
}

/** Ask the server for each path once so dev servers compile before the first screenshot. */
export async function warmUp(url, paths) {
  for (const p of paths) {
    try {
      await fetch(new URL(p, url), { signal: AbortSignal.timeout(120_000) });
    } catch {
      // capture will report the failure
    }
  }
}
