import { execFile, spawn } from 'node:child_process';
import net from 'node:net';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Run a command without a shell and return trimmed stdout. */
export async function run(cmd, args, { cwd, env, maxBuffer = 256 * 1024 * 1024 } = {}) {
  const { stdout } = await execFileAsync(cmd, args, { cwd, env, maxBuffer });
  return stdout.trimEnd();
}

export function git(cwd, ...args) {
  return run('git', args, { cwd });
}

/** Run a shell command, streaming output to `log` (a writable stream). Rejects on non-zero exit. */
export function sh(command, { cwd, env, log } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, { cwd, env, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
    if (log) {
      child.stdout.pipe(log, { end: false });
      child.stderr.pipe(log, { end: false });
    }
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`command failed (${signal ?? `exit ${code}`}): ${command}`));
    });
  });
}

export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

export function portInUse(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
  });
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Run async `fn` over `items` with at most `limit` in flight, preserving result order. */
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

export function slug(s) {
  return String(s)
    .replace(/^\/+/, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'root';
}

export function log(...args) {
  if (process.env.RUNUP_QUIET) return;
  console.error('[runup]', ...args);
}
