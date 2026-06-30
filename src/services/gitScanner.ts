import { execFile } from 'child_process';
import { promisify } from 'util';
import { FileNode } from '../models/types';
import { sanitizePath } from '../utils/pathSanitizer';
import { insideAnyScanRoot } from '../middleware/pathGuard';

const exec = promisify(execFile);

/**
 * Git-aware scanning (Feature 13). Surfaces actionable .git breakdown — pack
 * files, loose objects, LFS data — computed entirely from the already-scanned
 * tree (no extra fs walk), plus an opt-in `git gc` that is path-guarded and
 * restricted to repos inside a scanned root.
 */

export interface GitRepoInfo {
  repoPath: string;
  packBytes: number;
  looseObjectBytes: number;
  lfsBytes: number;
  worktreeCount: number;
  totalBytes: number;
  canGC: boolean;
}

function childByName(node: FileNode, name: string): FileNode | undefined {
  return node.children?.find((c) => c.name === name);
}

function analyzeGitDir(gitDir: FileNode, repoPath: string): GitRepoInfo {
  const objects = childByName(gitDir, 'objects');
  const pack = objects ? childByName(objects, 'pack') : undefined;
  const lfs = childByName(gitDir, 'lfs');
  const lfsObjects = lfs ? childByName(lfs, 'objects') : undefined;
  const worktrees = childByName(gitDir, 'worktrees');

  let packBytes = 0;
  if (pack?.children) {
    for (const f of pack.children) {
      if (f.type === 'file' && (f.name.endsWith('.pack') || f.name.endsWith('.idx'))) packBytes += f.size;
    }
  }
  // Loose objects live in two-hex-char shard directories under objects/.
  let looseObjectBytes = 0;
  if (objects?.children) {
    for (const d of objects.children) {
      if (d.type === 'dir' && /^[0-9a-f]{2}$/.test(d.name)) looseObjectBytes += d.size;
    }
  }
  const lfsBytes = lfsObjects ? lfsObjects.size : 0;
  const worktreeCount = worktrees?.children ? worktrees.children.filter((c) => c.type === 'dir').length : 0;

  return {
    repoPath,
    packBytes,
    looseObjectBytes,
    lfsBytes,
    worktreeCount,
    totalBytes: gitDir.size,
    canGC: looseObjectBytes > 0,
  };
}

/** Find every git repo in the scanned tree, annotating each repo root's FileNode. */
export function findGitRepos(root: FileNode): GitRepoInfo[] {
  const repos: GitRepoInfo[] = [];
  const stack: { node: FileNode; parent: FileNode | null }[] = [{ node: root, parent: null }];
  while (stack.length) {
    const { node, parent } = stack.pop()!;
    if (node.type === 'dir' && node.name === '.git' && parent) {
      parent.gitRepo = true;
      repos.push(analyzeGitDir(node, parent.path));
      continue; // don't descend into .git itself
    }
    if (node.children) {
      for (const c of node.children) stack.push({ node: c, parent: node });
    }
  }
  return repos.sort((a, b) => b.totalBytes - a.totalBytes);
}

export interface GitGcResult {
  ok: boolean;
  output?: string;
  error?: string;
}

/** Run `git gc --aggressive --prune=now` in a repo inside a scanned root. */
export async function runGitGc(repoPath: unknown): Promise<GitGcResult> {
  let safe: string;
  try {
    safe = sanitizePath(repoPath);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Invalid path' };
  }
  if (!insideAnyScanRoot(safe)) {
    return { ok: false, error: 'Repository is outside every scanned root' };
  }
  try {
    const { stdout, stderr } = await exec(
      'git',
      ['-C', safe, 'gc', '--aggressive', '--prune=now'],
      { timeout: 300000, maxBuffer: 8 * 1024 * 1024 }
    );
    return { ok: true, output: (stdout + stderr).trim() || 'Done.' };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
