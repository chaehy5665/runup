import fs from 'node:fs/promises';
import path from 'node:path';
import { git } from './util.mjs';

export async function repoRoot(cwd) {
  return git(cwd, 'rev-parse', '--show-toplevel');
}

export async function resolveRef(repo, ref) {
  return git(repo, 'rev-parse', '--verify', `${ref}^{commit}`);
}

/**
 * Files changed between the merge base of base..head and head (what a PR shows).
 * Renames and copies report both sides so either can map to screens.
 */
export async function changedFiles(repo, baseSha, headSha) {
  const out = await git(repo, 'diff', '--name-status', '-z', '-M', `${baseSha}...${headSha}`);
  const parts = out.split('\0').filter(Boolean);
  const files = new Set();
  for (let i = 0; i < parts.length; ) {
    const status = parts[i++];
    if (status.startsWith('R') || status.startsWith('C')) {
      files.add(parts[i++]);
      files.add(parts[i++]);
    } else {
      files.add(parts[i++]);
    }
  }
  return [...files].sort();
}

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check out `sha` into `dir` as a detached worktree. If a kept worktree already sits there at the
 * same commit it is reused (returns `reused: true`, and setup can be skipped).
 */
export async function addWorktree(repo, dir, sha) {
  if (await exists(dir)) {
    try {
      const current = await git(dir, 'rev-parse', 'HEAD');
      if (current === sha) return { dir, reused: true };
    } catch {
      // not a worktree; fall through and let git complain
    }
    await removeWorktree(repo, dir);
  }
  await fs.mkdir(path.dirname(dir), { recursive: true });
  await git(repo, 'worktree', 'add', '--detach', '--force', dir, sha);
  return { dir, reused: false };
}

export async function removeWorktree(repo, dir) {
  try {
    await git(repo, 'worktree', 'remove', '--force', dir);
  } catch {
    await fs.rm(dir, { recursive: true, force: true });
    await git(repo, 'worktree', 'prune').catch(() => {});
  }
}
