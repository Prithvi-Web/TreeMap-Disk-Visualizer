import { promises as fsp } from 'fs';
import path from 'path';
import type { GitRecoverability } from './recoverabilityTypes';
import { runGit, userExcludesArgs, vetRepository, type GitCall, type VettedRepo, type VetOptions } from './gitSafe';

/**
 * "Does a copy of this exist in a git remote?" (v4 §1.2a)
 *
 * This is the distinction the whole feature exists to draw, and no other disk
 * tool draws it:
 *
 *   4.2 GB, fully pushed to origin, nothing uncommitted
 *       → deleting costs one `git clone`
 *   4.2 GB, three uncommitted files
 *       → deleting is permanent
 *
 * Same size, same folder, categorically different objects.
 *
 * ── The hole in the obvious design, found by testing it ──
 *
 * `fullyPushed` as specified is: a remote exists, `ahead === 0`,
 * `dirtyFiles === 0`, `untrackedBytes === 0`. But **`git status --porcelain`
 * does not list ignored files**. A repository containing `node_modules/` and
 * `build/` behind a `.gitignore` reports *completely clean* — verified
 * directly — so `fullyPushed` comes back true, and the UI would then tell the
 * user that deleting their 4 GB `node_modules` "costs one git clone". It is
 * not in the remote at all.
 *
 * That is a false "you can get it back", which is the same class of error as a
 * false "this is backed up". So every path is additionally run through
 * `git check-ignore`, batched per repository over stdin, and an ignored path
 * is reported with `pathTracked: false` — git proves nothing about it. Such a
 * file may well be regenerable, but that is the reclaim score's `regenerable`
 * component saying so for its own reasons, not git claiming a remote copy it
 * does not have.
 *
 * ── Safety ──
 *
 * Every invocation goes through gitSafe.ts: an argv array, `--porcelain`/`-z`
 * forms only, a timeout, `-C <sanitized repo root>`, GIT_HARDENING and an
 * environment built from scratch. **No argument is ever derived from user
 * input other than the already-sanitized path**, and paths reach
 * `check-ignore` on stdin rather than as arguments, so a path beginning with
 * `-` cannot become a flag.
 *
 * **Nothing that reads the work tree runs before the repository is vetted**
 * (FG4, gitSafe.vetRepository): a repository's own settings can name programs
 * for `status` to start, and TreeMap reads repositories under folders someone
 * else may have filled. A repository that fails the vetting is `unknown`, with
 * the reason, and nothing else is asked of it. `status` never recurses into a
 * submodule (`--ignore-submodules=dirty`), so a clean repository holding one
 * is `unknown` too — its contents were not read. The user's own ignore file
 * is passed explicitly, since the user's settings are not read by the calls.
 *
 * A repository whose `git` invocation fails is reported unavailable **for that
 * repository**, never for the provider — one broken repo must not blank the
 * column for every other.
 */

/** git in the vetted repository at `root`, never looking above it. */
function git(root: string, args: string[], opts: GitCall = {}) {
  return runGit(['-C', root, ...args], { ...opts, repoRoot: root });
}

/**
 * The repository root containing `p`, or null when it is not in a work tree.
 *
 * A filesystem ancestor walk rather than `git rev-parse --show-toplevel`, and
 * the difference is not cosmetic: `rev-parse` is a subprocess, and asking it
 * once per directory cost **1.4 ms per path** measured over a real repo — a
 * 2,000-path batch spread across a few hundred folders would have spent most
 * of a second spawning git before doing any work, blowing §2.5's 400 ms
 * budget on process startup alone.
 *
 * Looking for a `.git` entry is exactly what git itself does to find the root.
 * `.git` may be a **file** rather than a directory — that is how linked
 * worktrees and submodules point at their real gitdir — so presence is what is
 * checked, not type.
 *
 * `cache` memoises every directory visited on the way up, so the second file
 * in a folder, and every sibling folder under an already-resolved root, costs
 * nothing.
 */
export async function repoRootFor(p: string, cache?: Map<string, string | null>): Promise<string | null> {
  // A relative or empty path would walk up from the SERVER's own working
  // directory and, in a checkout, attribute this repository's state to the
  // user's file. Callers are sanitised to absolute, but this is exported.
  if (!path.isAbsolute(p)) return null;

  const memo = cache ?? new Map<string, string | null>();
  const chain: string[] = [];

  // Start at `p` itself when it is a directory, not at its parent.
  //
  // Starting at `path.dirname(p)` unconditionally meant the repository FOLDER
  // — "4.2 GB, fully pushed to origin", the example this whole module exists
  // for — reported no git information at all, because the walk began one level
  // above its own `.git`. A treemap asks about folders far more often than
  // about the files inside them.
  let dir = path.dirname(p);
  try {
    if ((await fsp.stat(p)).isDirectory()) dir = p;
  } catch {
    // Gone or unreadable; the parent walk is still the right answer.
  }

  for (;;) {
    const hit = memo.get(dir);
    if (hit !== undefined) {
      for (const d of chain) memo.set(d, hit);
      return hit;
    }
    chain.push(dir);

    let found = false;
    try {
      await fsp.access(path.join(dir, '.git'));
      found = true;
    } catch {
      found = false;
    }
    if (found) {
      for (const d of chain) memo.set(d, dir);
      return dir;
    }

    const parent = path.dirname(dir);
    // path.dirname('/') === '/', and likewise for a Windows drive root — the
    // fixed point is the only reliable way to know the walk is finished.
    if (parent === dir) {
      for (const d of chain) memo.set(d, null);
      return null;
    }
    dir = parent;
  }
}

/**
 * Parse `git status --porcelain=v1 -z` into counts.
 *
 * NUL-separated because a filename may contain a newline, and splitting on
 * newlines would then invent extra entries. Each record is
 * `XY<space><path>`; rename records carry a second NUL-terminated path, which
 * is skipped rather than counted twice.
 */
export function parsePorcelainStatus(stdout: string): { dirtyFiles: number; untracked: string[] } {
  const records = stdout.split('\0').filter((r) => r.length > 0);
  let dirtyFiles = 0;
  const untracked: string[] = [];
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (record.length < 4) continue;
    const x = record[0];
    const y = record[1];
    const file = record.slice(3);
    if (x === '?' && y === '?') { untracked.push(file); continue; }
    dirtyFiles++;
    // A rename/copy record is followed by its origin path as a separate
    // NUL-terminated field. Consume it so it is not read as another change.
    if (x === 'R' || x === 'C') i++;
  }
  return { dirtyFiles, untracked };
}

/**
 * Parse `git rev-list --left-right --count @{upstream}...HEAD`, which prints
 * `behind<TAB>ahead`. Returns null when there is no upstream at all.
 */
export function parseAheadBehind(stdout: string): { behind: number; ahead: number } | null {
  const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(stdout);
  if (!m) return null;
  return { behind: Number(m[1]), ahead: Number(m[2]) };
}

/** How a caller hands over a repository it has already vetted, or says how to vet one. */
export interface RepoReadOptions extends VetOptions {
  vetted?: VettedRepo;
}

/** A repository's state; or why git could not read it (`error`); or why it was not read, or cannot be vouched for (`unknown`). */
export type RepoState = GitRecoverability | { error: string } | { unknown: string };

/** The vetted repository at `root`: the one handed over, or vetted here. */
async function vetted(root: string, opts: RepoReadOptions): Promise<{ repo: VettedRepo } | { error: string } | { unknown: string }> {
  if (opts.vetted) return { repo: opts.vetted };
  const vetting = await vetRepository(root, opts);
  if (vetting.ok) return { repo: vetting.repo };
  return vetting.kind === 'error' ? { error: vetting.reason } : { unknown: vetting.reason };
}

/** The gitlink mode, at the start of an `ls-files --stage -z` record: a submodule or a nested repository. */
const GITLINK = '160000 ';

/**
 * Whether the index of `root` holds a gitlink: a submodule, registered or not. Read as a
 * stream and stopped at the first one, so a large index costs no memory; null when git fails.
 */
async function holdsGitlink(root: string): Promise<boolean | null> {
  let head = '';
  let found = false;
  const onStdout = (chunk: string): boolean => {
    let i = 0;
    while (i < chunk.length) {
      const nul = chunk.indexOf('\0', i);
      const end = nul === -1 ? chunk.length : nul;
      if (head.length < GITLINK.length) head += chunk.slice(i, Math.min(end, i + GITLINK.length - head.length));
      if (head === GITLINK) found = true;
      if (found || nul === -1) break;
      head = '';
      i = nul + 1;
    }
    return found;
  };
  const run = await git(root, ['ls-files', '--stage', '-z'], { onStdout });
  return run.ok ? found : null;
}

/**
 * Everything one repository can say, read in a single pass — after it is
 * vetted, and never before.
 */
export async function readRepoState(repoRoot: string, opts: RepoReadOptions = {}): Promise<RepoState> {
  const vet = await vetted(repoRoot, opts);
  if (!('repo' in vet)) return vet;
  const root = vet.repo.root;
  const remotes = await git(root, ['remote']);
  if (!remotes.ok) return { error: remotes.error };
  const hasRemote = remotes.stdout.trim().length > 0;

  const status = await runGit(
    [...(await userExcludesArgs()), '-C', root, 'status', '--porcelain=v1', '-z', '--untracked-files=normal', '--ignore-submodules=dirty'],
    { repoRoot: root },
  );
  if (!status.ok) return { error: status.error };
  const { dirtyFiles, untracked } = parsePorcelainStatus(status.stdout);

  // Untracked bytes are deliberately not stat'd here: the caller already holds
  // the scan's own sizes, and a second stat of every untracked file in a large
  // repo is exactly the kind of cost §2.5 budgets against. The count travels
  // instead, and the composite reports bytes only where the scan supplies them.
  //
  // "Pushed" is measured against a remote-tracking branch only: an upstream
  // that is another local branch (`branch.<name>.remote = .`) has ahead 0 while
  // nothing ever left this machine, so there `ahead` stays null (FG4 review).
  let ahead: number | null = null;
  const upstream = await git(root, ['rev-parse', '--symbolic-full-name', '@{upstream}']);
  if (upstream.ok && upstream.stdout.startsWith('refs/remotes/')) {
    const revlist = await git(root, ['rev-list', '--left-right', '--count', '@{upstream}...HEAD']);
    if (revlist.ok) {
      const counts = parseAheadBehind(revlist.stdout);
      ahead = counts ? counts.ahead : null;
    }
  }

  // Every clause matters. No remote: nothing to clone from. ahead null: no
  // upstream, so "pushed" is not even defined. Anything dirty or untracked:
  // the worktree holds content the remote has never seen.
  const fullyPushed = hasRemote && ahead === 0 && dirtyFiles === 0 && untracked.length === 0;
  if (fullyPushed) {
    // `status` did not look inside submodules (it would run git in each, under
    // settings nobody vetted), so a clean answer does not cover them: a clone
    // brings a submodule back only if its own commits were pushed too.
    const gitlink = await holdsGitlink(root);
    if (gitlink === null) return { error: 'git could not list the files it tracks' };
    if (gitlink) {
      return { unknown: `${root} holds a submodule or another project inside it, which TreeMap does not look into, so whether everything here is pushed is unknown.` };
    }
  }

  return {
    kind: 'git',
    repoRoot,
    hasRemote,
    ahead,
    dirtyFiles,
    untrackedFiles: untracked.length,
    untrackedBytes: 0,
    fullyPushed,
    pathTracked: true,
  };
}

/**
 * Which of `paths` git ignores, asked in one batched call per repository.
 *
 * Paths go in on stdin (`-z`, NUL-separated) rather than as arguments: it
 * keeps one invocation per repo regardless of batch size, and a path
 * beginning with `-` cannot be read as a flag.
 */
export async function ignoredPaths(repoRoot: string, paths: string[], opts: RepoReadOptions = {}): Promise<Set<string> | null> {
  if (paths.length === 0) return new Set();
  const vet = await vetted(repoRoot, opts);
  // Refused or unreadable: unknown, exactly as a failed check-ignore is.
  if (!('repo' in vet)) return null;
  const root = vet.repo.root;
  const result = await runGit(
    [...(await userExcludesArgs()), '-C', root, 'check-ignore', '-z', '--stdin'],
    { repoRoot: root, stdin: paths.join('\0') + '\0', exitOneIsEmpty: true },
  );
  // A FAILURE IS NOT "nothing is ignored".
  //
  // Returning an empty set here made every path look tracked, which turned a
  // clean pushed repo into `fullyPushed` + `pathTracked` — i.e. a confident
  // "deleting this costs one git clone" for a 4 GB node_modules the remote has
  // never held. That is the exact outcome the check-ignore pass exists to
  // prevent, reintroduced by its own error path. Null means "unknown", and the
  // caller reports the repo as unavailable rather than guessing.
  if (!result.ok) return null;
  return new Set(result.stdout.split('\0').filter((p) => p.length > 0));
}
