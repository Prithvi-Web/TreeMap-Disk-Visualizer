import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describeMachine, type MachineRecord } from '../bench/lib/machine';

/**
 * The dirty check fails closed. `--record` trusts `machine.dirty` to say the
 * commit a baseline cites is the code measured, so a git that cannot answer
 * — or a user's config that hides untracked files — must read as dirty, with
 * the reason, never as a clean tree.
 *
 * Each case points the real `describeMachine()` at a throwaway repository
 * under the OS temp directory through `GIT_DIR` and `GIT_WORK_TREE`, which
 * git honours whatever directory it is started in. The repository's commit is
 * made with plumbing (`commit-tree`), so no hook of the user's ever runs.
 */

const IDENTITY = { GIT_AUTHOR_NAME: 'bench test', GIT_AUTHOR_EMAIL: 'bench@test.invalid', GIT_COMMITTER_NAME: 'bench test', GIT_COMMITTER_EMAIL: 'bench@test.invalid' };

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...IDENTITY } });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

/** A one-commit repository; returns its directory and the commit. */
function tempRepo(): { dir: string; head: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-bench-git-'));
  git(dir, 'init', '-q');
  fs.writeFileSync(path.join(dir, 'tracked.ts'), 'export {};\n');
  git(dir, 'add', 'tracked.ts');
  const tree = git(dir, 'write-tree');
  const head = git(dir, '-c', 'commit.gpgsign=false', 'commit-tree', tree, '-m', 'init');
  git(dir, 'update-ref', 'HEAD', head);
  return { dir, head };
}

/** `describeMachine()` with git pointed at another repository; the variables are restored whatever happens. */
async function machineWithGit(gitDir: string, workTree: string): Promise<MachineRecord> {
  const saved = { GIT_DIR: process.env.GIT_DIR, GIT_WORK_TREE: process.env.GIT_WORK_TREE };
  process.env.GIT_DIR = gitDir;
  process.env.GIT_WORK_TREE = workTree;
  try {
    return await describeMachine();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('a clean repository reads clean, with its commit and no reason (the control: the cases below cannot pass by calling everything dirty)', async () => {
  const { dir, head } = tempRepo();
  try {
    const m = await machineWithGit(path.join(dir, '.git'), dir);
    assert.equal(m.dirty, false);
    assert.equal(m.commit, head);
    assert.equal(m.dirtyReason, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an untracked file is dirty even when the user's status.showUntrackedFiles=no would hide it", async () => {
  const { dir, head } = tempRepo();
  try {
    git(dir, 'config', 'status.showUntrackedFiles', 'no');
    fs.writeFileSync(path.join(dir, 'measured.ts'), 'export const faster = true;\n');
    assert.equal(git(dir, 'status', '--porcelain'), '', 'the precondition: plain `git status --porcelain` hides the file');
    const m = await machineWithGit(path.join(dir, '.git'), dir);
    assert.equal(m.dirty, true, 'an untracked source file could have been measured');
    assert.equal(m.commit, `${head}-dirty`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a git status that fails reads as dirty with the reason, never as a clean tree', async () => {
  const { dir, head } = tempRepo();
  try {
    fs.writeFileSync(path.join(dir, '.git', 'index'), 'not an index'); // rev-parse still answers; status cannot
    const m = await machineWithGit(path.join(dir, '.git'), dir);
    assert.equal(m.dirty, true);
    assert.equal(m.commit, `${head}-dirty`, 'the commit is known; whether the tree matches it is not');
    assert.match(m.dirtyReason ?? '', /^git status failed: .*index/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a git that cannot name the commit reads as dirty with the reason, and the commit stays unknown', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-bench-git-none-'));
  try {
    const m = await machineWithGit(path.join(dir, 'no-such-repository'), dir);
    assert.equal(m.dirty, true, 'a tree nobody can name the commit of cannot be vouched for');
    assert.equal(m.commit, 'unknown');
    assert.match(m.dirtyReason ?? '', /^git rev-parse HEAD failed: .*not a git repository/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
