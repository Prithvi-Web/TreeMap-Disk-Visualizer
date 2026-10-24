import { promises as fsp } from 'fs';
import path from 'path';
import { listedFolderIsReal } from '../utils/listedFolder';
import { sanitizePath } from '../utils/pathSanitizer';
import { insideAnyScanRoot, withUnfinishedScan } from '../middleware/pathGuard';
import { ScanStore, TreeSource, asStore, Flag } from './scanStore';
import { RealMachineRefusal, refuseUnderTestRunner } from './realMachineGuard';
import { gitInvocation, runGitInvocation, vetRepository, type GitInvocation } from './gitSafe';

/**
 * Git-aware scanning (Feature 13). Surfaces actionable .git breakdown — pack
 * files, loose objects, LFS data — computed entirely from the already-scanned
 * tree (no extra fs walk), plus an opt-in `git gc` that is path-guarded and
 * restricted to repos inside a scanned root.
 *
 * The gc acts where git decides, not where the path says: a `.git` FILE
 * (`gitdir: …`), a `.git` link, a `commondir` or a link inside `.git` sends it
 * to another repository's objects, possibly outside every scan (T17a's FG4
 * finding: a planted file made `--prune=now` delete a victim's unreachable
 * commits). So gc runs only on a `.git` that is a real folder with no
 * `commondir` and no link or special file anywhere inside it, vetted like
 * every repository git reads (gitSafe.vetRepository), and told its git dir
 * outright (`--git-dir`). It prunes only what has been unreachable for two
 * weeks — git's own default — so the confirm's "without changing any commits"
 * stays true of work dropped recently.
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
      // Only when not set already: setFlag bumps the store's version, and a
      // read-only route must not make every cache of this scan — the cleanup
      // memo among them (U-16) — answer for a tree that did not change.
      if (!store.flag(parent, Flag.GitRepo)) store.setFlag(parent, Flag.GitRepo, true);
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
  /** Not run: its own checks refused it (FG4). Absent when git ran and failed. */
  refused?: boolean;
}

/** What git printed. */
export interface GitGcOutput {
  stdout: string;
  stderr: string;
}

/** What runGitGc hands its step: the repository, the git dir it resolved, and the whole invocation. */
export interface GitGcPlan {
  repo: string;
  gitDir: string;
  invocation: GitInvocation;
}

const GC_TIMEOUT_MS = 300_000;
/** A `.git` with more entries than this is not walked for links, and so not gc'd. */
const GC_WALK_LIMIT = 1_000_000;

/** The refusal the real gc makes under a test runner. */
function gcRefusal(repo: string): string {
  return `a test reached a real git gc, which prunes for good: ${repo} — use setGitGcStepForTests`;
}

/** Runs the planned `git gc`, for real: what has been unreachable for two weeks is gone for good. */
async function gcInRepo(plan: GitGcPlan): Promise<GitGcOutput> {
  // Under a test runner git gc never runs for real: a test stands in for this step
  // (setGitGcStepForTests; realMachineGuard.ts).
  refuseUnderTestRunner(gcRefusal(plan.repo));
  const run = await runGitInvocation(plan.invocation);
  if (!run.ok) throw new Error(run.error);
  return { stdout: run.stdout, stderr: run.stderr };
}

/** The step that runs git gc; a test replaces it (setGitGcStepForTests). */
let gcStep: (plan: GitGcPlan) => Promise<GitGcOutput> = gcInRepo;

/**
 * Test-only: run `step` in place of git gc, so a test can drive runGitGc
 * without pruning anything; null restores the real one, which refuses under a
 * test runner.
 */
export function setGitGcStepForTests(step: ((plan: GitGcPlan) => Promise<GitGcOutput>) | null): void {
  gcStep = step ?? gcInRepo;
}

/**
 * The first link, or special file, anywhere under `dir` (the folder itself excluded); null when
 * there is none; `limit` when there are more entries than that to look at. An entry the listing
 * calls a folder is asked again (`listedFolderIsReal`): on Windows Node 20's listing calls a link
 * to a folder, and a junction, a folder, and the walk would have gone through it.
 */
async function firstLinkInside(dir: string): Promise<string | null | 'limit'> {
  const pending = [dir];
  let seen = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    // Read as a stream, so a folder of millions of entries is never held whole.
    for await (const entry of await fsp.opendir(current)) {
      if (++seen > GC_WALK_LIMIT) return 'limit';
      const full = path.join(current, entry.name);
      if (entry.isDirectory() && (await listedFolderIsReal(full))) pending.push(full);
      else if (!entry.isFile()) return full;
    }
  }
  return null;
}

/** The refusal when the `.git` of `repo` could send gc anywhere but itself, or null. */
async function gitDirRefusal(repo: string): Promise<string | null> {
  const dotGit = path.join(repo, '.git');
  const st = await fsp.lstat(dotGit).catch(() => null);
  if (!st) return `${repo} has no .git folder.`;
  if (st.isSymbolicLink()) return `${dotGit} is a link, so its data may be anywhere; TreeMap runs git gc only on a .git folder that is really here.`;
  if (!st.isDirectory()) return `${dotGit} is a file pointing at a git folder elsewhere (a linked worktree or a submodule); run git gc in the repository it points to.`;
  const common = await fsp.lstat(path.join(dotGit, 'commondir')).then(() => true, () => false);
  if (common) return `${dotGit} shares its objects with another repository (it has a commondir), so git gc would prune that repository; TreeMap does not run it here.`;
  // gc repacks only this repository's own objects (`repack -l`) and drops the local copies the
  // other one also holds, so afterwards more of this history lives only there (FG4c).
  const borrows = await fsp.lstat(path.join(dotGit, 'objects', 'info', 'alternates')).then(() => true, () => false);
  if (borrows) return `${dotGit} borrows objects from another repository (objects/info/alternates), and git gc would leave it relying on that repository for more of its history; TreeMap does not run it here.`;
  const link = await firstLinkInside(dotGit);
  if (link === 'limit') return `${dotGit} holds more than ${GC_WALK_LIMIT.toLocaleString('en-US')} entries, too many to check for links; run git gc yourself.`;
  if (link !== null) return `${link} is a link or special file inside .git, which could send git gc to another repository's data; TreeMap does not run it here.`;
  return null;
}

/**
 * What runGitGc will run in `asked`, or why it will not run anything. The repository is judged
 * where it really is: a folder that is a link, or has one among its parents, is followed to its
 * real place, which must be inside a scanned folder too (FG4 review).
 */
async function planGitGc(asked: string): Promise<GitGcPlan | { refused: string }> {
  const repo = await fsp.realpath(asked).catch(() => null);
  if (!repo) return { refused: `${asked} could not be found.` };
  if (!insideAnyScanRoot(repo)) return { refused: `${asked} leads to ${repo}, outside every scanned folder, so TreeMap does not run git gc there.` };
  const layout = await gitDirRefusal(repo).catch((err: unknown) => `${repo}/.git could not be checked (${err instanceof Error ? err.message : String(err)}).`);
  if (layout) return { refused: layout };
  const vetting = await vetRepository(repo, { insideScannedRoot: insideAnyScanRoot });
  if (!vetting.ok) return { refused: vetting.reason };
  const gitDir = await fsp.realpath(path.join(repo, '.git'));
  if (vetting.repo.gitDir !== gitDir || vetting.repo.commonDir !== gitDir) {
    return { refused: `Git reports this repository's data at ${vetting.repo.commonDir}, not in its own .git folder, so TreeMap does not run git gc here.` };
  }
  const args = ['-C', repo, `--git-dir=${gitDir}`, 'gc', '--aggressive', '--prune=2.weeks.ago'];
  return { repo: asked, gitDir, invocation: gitInvocation(args, { timeoutMs: GC_TIMEOUT_MS }) };
}

/**
 * Run `git gc --aggressive --prune=2.weeks.ago` in a repo inside a scanned root, whose data is
 * really in its own `.git` folder and whose settings pass the vetting.
 */
export async function runGitGc(repoPath: unknown): Promise<GitGcResult> {
  let safe: string;
  try {
    safe = sanitizePath(repoPath);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Invalid path' };
  }
  if (!insideAnyScanRoot(safe)) {
    return { ok: false, error: withUnfinishedScan('Repository is outside every scanned root', safe) };
  }
  // Under a test runner the real gc refuses before anything reaches the machine, its own
  // checks included; a test that stood in for it goes on through them.
  if (gcStep === gcInRepo) refuseUnderTestRunner(gcRefusal(safe));
  try {
    const plan = await planGitGc(safe);
    if ('refused' in plan) return { ok: false, error: plan.refused, refused: true };
    const { stdout, stderr } = await gcStep(plan);
    return { ok: true, output: (stdout + stderr).trim() || 'Done.' };
  } catch (err) {
    // A test that reached a real git gc is a failure of the test, never git's answer.
    if (err instanceof RealMachineRefusal) throw err;
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
