import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { git } from './util.mjs';

/**
 * A read-only view of a source tree: a list of repo-relative POSIX paths and a way to read them.
 * Route discovery works on trees so it can look at a git commit without checking it out.
 */

const SKIP_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'build', 'out', 'coverage']);

/** Tree backed by a directory on disk (used by tests and by `--plan` on a checkout). */
export async function treeFromDir(root) {
  const files = [];
  async function walk(dir) {
    for (const entry of await fs.readdir(path.join(root, dir), { withFileTypes: true })) {
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await walk(rel);
      } else if (entry.isFile()) {
        files.push(rel);
      }
    }
  }
  await walk('');
  files.sort();
  return {
    files,
    async read(rel) {
      try {
        return await fs.readFile(path.join(root, rel), 'utf8');
      } catch {
        return null;
      }
    },
  };
}

/** Tree backed by a git commit. Reads all requested blobs through one `git cat-file --batch`. */
export async function treeFromGit(repo, sha) {
  const out = await git(repo, 'ls-tree', '-r', '-z', '--format=%(objectname) %(path)', sha);
  const blobs = new Map();
  for (const line of out.split('\0')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    blobs.set(line.slice(space + 1), line.slice(0, space));
  }
  const files = [...blobs.keys()].sort();
  const cache = new Map();
  return {
    files,
    /** Prefetch many files in one git process; `read` then serves from the cache. */
    async preload(paths) {
      const wanted = paths.filter((p) => blobs.has(p) && !cache.has(p));
      if (!wanted.length) return;
      const contents = await catFileBatch(repo, wanted.map((p) => blobs.get(p)));
      wanted.forEach((p, i) => cache.set(p, contents[i]));
    },
    async read(rel) {
      if (!blobs.has(rel)) return null;
      if (!cache.has(rel)) await this.preload([rel]);
      return cache.get(rel);
    },
  };
}

function catFileBatch(repo, objects) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['cat-file', '--batch'], { cwd: repo });
    const chunks = [];
    child.stdout.on('data', (c) => chunks.push(c));
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code !== 0) return reject(new Error(`git cat-file exited ${code}`));
      const buf = Buffer.concat(chunks);
      const results = [];
      let pos = 0;
      for (let i = 0; i < objects.length; i++) {
        const nl = buf.indexOf(0x0a, pos);
        const header = buf.subarray(pos, nl).toString();
        const size = Number(header.split(' ')[2]);
        if (header.endsWith('missing') || Number.isNaN(size)) {
          results.push(null);
          pos = nl + 1;
          continue;
        }
        results.push(buf.subarray(nl + 1, nl + 1 + size).toString('utf8'));
        pos = nl + 1 + size + 1;
      }
      resolve(results);
    });
    child.stdin.end(objects.join('\n') + '\n');
  });
}
