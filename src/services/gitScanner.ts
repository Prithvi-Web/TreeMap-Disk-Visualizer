import { execFile } from 'child_process';
import { promisify } from 'util';
import { sanitizePath } from '../utils/pathSanitizer';
import { insideAnyScanRoot } from '../middleware/pathGuard';
import { ScanStore, TreeSource, asStore, Flag } from './scanStore';

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

function dirChild(store: ScanStore, id: number, name: string): number {
  const hit = store.childByName(id, name);
  return hit;
}

function analyzeGitDir(store: ScanStore, gitId: number, repoPath: string): GitRepoInfo {
  const objects = dirChild(store, gitId, 'objects');
  const pack = objects !== -1 ? dirChild(store, objects, 'pack') : -1;
  const lfs = dirChild(store, gitId, 'lfs');
  const lfsObjects = lfs !== -1 ? dirChild(store, lfs, 'objects') : -1;
  const worktrees = dirChild(store, gitId, 'worktrees');

  let packBytes = 0;
  if (pack !== -1) {
    store.forEachChild(pack, (f) => {
      if (!store.isDir(f)) {
        const name = store.name(f);
        if (name.endsWith('.pack') || name.endsWith('.idx')) packBytes += store.size(f);
      }
    });
  }
  // Loose objects live in two-hex-char shard directories under objects/.
  let looseObjectBytes = 0;
  if (objects !== -1) {
    store.forEachChild(objects, (d) => {
      if (store.isDir(d) && /^[0-9a-f]{2}$/.test(store.name(d))) looseObjectBytes += store.size(d);
    });
  }
  const lfsBytes = lfsObjects !== -1 ? store.size(lfsObjects) : 0;
  let worktreeCount = 0;
  if (worktrees !== -1) {
    store.forEachChild(worktrees, (c) => {
      if (store.isDir(c)) worktreeCount++;
    });
  }

  return {
    repoPath,
    packBytes,
    looseObjectBytes,
    lfsBytes,
    worktreeCount,
    totalBytes: store.size(gitId),
    canGC: looseObjectBytes > 0,
  };
}

/** Find every git repo in the scan, annotating each repo root's gitRepo flag. */
export function findGitRepos(source: TreeSource): GitRepoInfo[] {
  const store = asStore(source);
  const repos: GitRepoInfo[] = [];
  const stack: { id: number; parent: number }[] = [{ id: store.rootId, parent: -1 }];
  while (stack.length) {
    const { id, parent } = stack.pop()!;
    if (store.isDir(id) && store.name(id) === '.git' && parent !== -1) {
      store.setFlag(parent, Flag.GitRepo, true);
      repos.push(analyzeGitDir(store, id, store.path(parent)));
      continue; // don't descend into .git itself
    }
    store.forEachChild(id, (c) => stack.push({ id: c, parent: id }));
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
