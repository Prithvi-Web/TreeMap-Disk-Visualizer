import { execFile } from 'child_process';
import { promises as fsp } from 'fs';
import path from 'path';
import type { GitRecoverability } from './recoverabilityTypes';

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
 * Every invocation uses `execFile` with an argv array, `--porcelain`/`-z`
 * forms only, a timeout, and `-C <sanitized repo root>`. **No argument is ever
 * derived from user input other than the already-sanitized path**, and paths
 * reach `check-ignore` on stdin rather than as arguments, so a path beginning
 * with `-` cannot become a flag.
 *
 * A repository whose `git` invocation fails is reported unavailable **for that
 * repository**, never for the provider — one broken repo must not blank the
 * column for every other.
 */

const GIT_TIMEOUT_MS = 10_000;
const MAX_BUFFER = 8 * 1024 * 1024;

function git(
  args: string[],
  opts: { stdin?: string; exitOneIsEmpty?: boolean } = {},
): Promise<{ ok: true; stdout: string } | { ok: false; error: string }> {
  const { stdin, exitOneIsEmpty = false } = opts;
  return new Promise((resolve) => {
    const child = execFile(
      'git',
      args,
      { timeout: GIT_TIMEOUT_MS, maxBuffer: MAX_BUFFER, windowsHide: true },
      (err, stdout) => {
        if (err) {
          // `check-ignore` exits 1 to mean "nothing matched" — a normal answer.
          //
          // **Scoped to that one command on purpose.** Applying it everywhere
          // made a `git status` that exits 1 read as a clean, empty worktree:
          // no dirty files, nothing untracked, and with a remote and ahead=0
          // that produces `fullyPushed: true` and a confident "deleting this
          // costs one git clone" for a repo whose state was never actually
          // read. A failure must look like a failure.
          const code = (err as { code?: unknown }).code;
          if (exitOneIsEmpty && code === 1 && typeof stdout === 'string') { resolve({ ok: true, stdout }); return; }
          resolve({ ok: false, error: err instanceof Error ? err.message.split('\n')[0] : String(err) });
          return;
        }
        resolve({ ok: true, stdout: stdout ?? '' });
      },
    );
    if (stdin !== undefined) {
      child.stdin?.on('error', () => { /* git exited early; the callback reports it */ });
      child.stdin?.end(stdin);
    }
  });
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

/** Everything one repository can say, read in a single pass. */
export async function readRepoState(repoRoot: string): Promise<GitRecoverability | { error: string }> {
  const remotes = await git(['-C', repoRoot, 'remote']);
  if (!remotes.ok) return { error: remotes.error };
  const hasRemote = remotes.stdout.trim().length > 0;

  const status = await git(['-C', repoRoot, 'status', '--porcelain=v1', '-z', '--untracked-files=normal']);
  if (!status.ok) return { error: status.error };
  const { dirtyFiles, untracked } = parsePorcelainStatus(status.stdout);

  // Untracked bytes are deliberately not stat'd here: the caller already holds
  // the scan's own sizes, and a second stat of every untracked file in a large
  // repo is exactly the kind of cost §2.5 budgets against. The count travels
  // instead, and the composite reports bytes only where the scan supplies them.
  let ahead: number | null = null;
  const revlist = await git(['-C', repoRoot, 'rev-list', '--left-right', '--count', '@{upstream}...HEAD']);
  if (revlist.ok) {
    const counts = parseAheadBehind(revlist.stdout);
    ahead = counts ? counts.ahead : null;
  }

  return {
    kind: 'git',
    repoRoot,
    hasRemote,
    ahead,
    dirtyFiles,
    untrackedFiles: untracked.length,
    untrackedBytes: 0,
    // Every clause matters. No remote: nothing to clone from. ahead null: no
    // upstream, so "pushed" is not even defined. Anything dirty or untracked:
    // the worktree holds content the remote has never seen.
    fullyPushed: hasRemote && ahead === 0 && dirtyFiles === 0 && untracked.length === 0,
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
export async function ignoredPaths(repoRoot: string, paths: string[]): Promise<Set<string> | null> {
  if (paths.length === 0) return new Set();
  const result = await git(
    ['-C', repoRoot, 'check-ignore', '-z', '--stdin'],
    { stdin: paths.join('\0') + '\0', exitOneIsEmpty: true },
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
