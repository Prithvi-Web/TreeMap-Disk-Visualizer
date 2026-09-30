import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { fileTempDir, isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-gitRecoverability-data-');
process.env.TREEMAP_NO_GDU = '1';

import { GIT_HARDENING, gitEnvironment, resetGitSafeForTests, vetRepository } from '../src/services/gitSafe';
import { ignoredPaths, readRepoState } from '../src/services/gitRecoverability';
import { recoverabilityProvider } from '../src/services/facts/recoverabilityProvider';
import { capabilityState, invalidateCapabilities } from '../src/platform/capabilities';
import { createScanRecord } from '../src/services/diskScanner';
import type { GitRecoverability } from '../src/services/recoverabilityTypes';
import { commandsOf, recordGit, subcommand, type RecordedGit, type ScriptedAnswer } from './fixtures/gitRecorder';

/**
 * FG4 — git is never run in a repository TreeMap has not vetted, and every call is hardened.
 *
 * Two kinds of test, and the line between them is the point:
 *  - **The recorder** (tests/fixtures/gitRecorder.ts) stands in for starting git. It answers
 *    `rev-parse` and `config --list` from text, so a repository can be "refused" without one
 *    ever being planted; what TreeMap then asks for is recorded, and nothing starts. A missing
 *    vetting shows here as a recorded `status`, never as an execution.
 *  - **Real git** only on repositories made here with plain, default settings, in a clean
 *    environment: to show that pushed / not pushed / unknown still answer as before, and that a
 *    `.git` file, a `commondir` and a linked `.git` are judged by where they lead — cases that
 *    run nothing whatever git makes of them.
 */

/* ══════════════════ Fixtures ══════════════════ */

/**
 * A new folder, spelled as gitSafe resolves it: by the native realpath, which on the Windows
 * runner expands the 8.3 `RUNNER~1` of its temp folder that the JS realpath keeps (FG4c).
 */
function tmp(prefix: string): string {
  return fs.realpathSync.native(fileTempDir(prefix));
}

/**
 * Git for building fixtures: no system or global settings, so every repository here is plain.
 * Built from this process's environment, so a child carries the test runner's guard like every
 * other (childEnvCarriesGuard.test.ts), with every GIT_* variable taken out — one set by a git
 * hook running the tests would send `git init` somewhere else entirely.
 */
const FIXTURE_HOME = tmp('treemap-gitrec-fixture-home-');
const FIXTURE_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  ...Object.fromEntries(Object.keys(process.env).filter((name) => /^GIT_/i.test(name)).map((name) => [name, undefined])),
  HOME: FIXTURE_HOME, XDG_CONFIG_HOME: FIXTURE_HOME, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(FIXTURE_HOME, 'none'),
};
function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=t@example.invalid', '-c', 'init.defaultBranch=main', ...args],
    { cwd, env: FIXTURE_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** A plain repository with one commit, pushed to its own bare origin. */
function pushedRepo(dir: string, name: string): string {
  const origin = path.join(dir, `${name}-origin.git`);
  git(dir, ['init', '-q', '--bare', origin]);
  const repo = path.join(dir, name);
  fs.mkdirSync(repo);
  git(repo, ['init', '-q']);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-qm', 'init']);
  git(repo, ['remote', 'add', 'origin', origin]);
  git(repo, ['push', '-q', '-u', 'origin', 'main']);
  return repo;
}

/** A folder holding an empty `.git` folder, for the recorder: paths resolve, nothing is a repository. */
function fakeRepo(): string {
  const root = tmp('treemap-gitrec-fake-');
  fs.mkdirSync(path.join(root, '.git'));
  return root;
}

/** The settings a plain clone has, in the format `git config --list --show-origin --no-includes -z` prints. */
function plainListing(extra: [string, string][] = []): string {
  const entries: [string, string][] = [
    ['core.repositoryformatversion', '0'], ['core.filemode', 'true'], ['core.bare', 'false'], ['core.logallrefupdates', 'true'],
    ['remote.origin.url', '/somewhere/origin.git'], ['remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*'],
    ['branch.main.remote', 'origin'], ['branch.main.merge', 'refs/heads/main'], ...extra,
  ];
  return entries.map(([k, v]) => `file:.git/config\0${k}\n${v}\0`).join('');
}

/**
 * The recorder, answering as a clean, fully pushed repository at `root` would, with `config`
 * holding `listing`. Anything it was not scripted for fails loudly.
 */
function scriptedRepo(root: string, listing: string, overrides: Record<string, ScriptedAnswer> = {}) {
  return recordGit((sub) => {
    const cmd = sub[0] ?? '';
    if (cmd === 'config' && sub.includes('--global')) return overrides.global ?? { code: 1 };
    if (overrides[cmd]) return overrides[cmd];
    switch (cmd) {
      case 'rev-parse':
        if (sub.includes('--symbolic-full-name')) return { stdout: 'refs/remotes/origin/main\n' };
        return { stdout: `${root}\n${path.join(root, '.git')}\n.git\n` };
      case 'config': return { stdout: listing };
      case 'remote': return { stdout: 'origin\n' };
      case 'status': return { stdout: '' };
      case 'rev-list': return { stdout: '0\t0\n' };
      case 'ls-files': return { stdout: '100644 0123456789012345678901234567890123456789 0\ta.txt\0' };
      case 'check-ignore': return { code: 1 };
      case '--version': return { stdout: 'git version 2.50.1\n' };
      default: return { code: 128, stderr: `fatal: the recorder was not scripted for ${sub.join(' ')}` };
    }
  });
}

/**
 * The only commands a refused repository may see: the vetting's two reads (and, for the provider,
 * the machine-wide probe of whether git is installed). Anything else is a command run on it.
 */
const VETTING_ONLY = new Set(['rev-parse', 'config']);

function assertNoWorktreeCommand(calls: RecordedGit[], what: string, alsoAllowed: string[] = []): void {
  const ran = calls.map((c) => subcommand(c.args));
  const beyond = ran.filter((sub) => {
    if (alsoAllowed.includes(sub[0] ?? '')) return false;
    if (sub[0] === 'config') return !(sub.includes('--list') || sub.includes('--global'));
    if (sub[0] === 'rev-parse') return !sub.includes('--show-toplevel');
    return !VETTING_ONLY.has(sub[0] ?? '');
  });
  assert.deepEqual(beyond, [], `${what}: a command ran on a refused repository: ${JSON.stringify(ran)}`);
}

const REFUSED = plainListing([['filter.x.clean', 'some-program %f']]);

/* ══════════════════ Refused: nothing that reads the work tree ever runs ══════════════════ */

test('a refused repository is unknown, with the reason, and nothing past the vetting runs', async () => {
  const root = fakeRepo();
  const rec = scriptedRepo(root, REFUSED);
  try {
    const state = await readRepoState(root);
    assertNoWorktreeCommand(rec.calls, 'readRepoState');
    assert.deepEqual(commandsOf(rec.calls), ['rev-parse', 'config']);
    assert.ok('unknown' in state, `unknown, not read: ${JSON.stringify(state)}`);
    assert.match(state.unknown, /filter\.x\.clean/, 'the setting is named');
  } finally {
    rec.restore();
  }
});

test('asking which paths are ignored in a refused repository runs nothing past the vetting', async () => {
  const root = fakeRepo();
  const rec = scriptedRepo(root, REFUSED);
  try {
    const ignored = await ignoredPaths(root, [path.join(root, 'a.txt')]);
    assertNoWorktreeCommand(rec.calls, 'ignoredPaths');
    assert.equal(ignored, null, 'unknown, never "nothing is ignored"');
  } finally {
    rec.restore();
  }
});

test('the recoverability fact names the refusal for that repository and runs nothing in it', async () => {
  const root = fakeRepo();
  const file = path.join(root, 'a.txt');
  fs.writeFileSync(file, 'a');
  const rec = scriptedRepo(root, REFUSED);
  try {
    const batch = await recoverabilityProvider.compute('no-scan', [file], new AbortController().signal);
    assertNoWorktreeCommand(rec.calls, 'recoverabilityProvider', ['--version']);
    const fact = batch.values.get(file);
    assert.ok(fact, 'the path is answered, with what could not be known');
    assert.equal(fact.git, null, 'no git verdict was made');
    const gitProblem = fact.unavailable.find((u) => u.signal === 'git');
    assert.ok(gitProblem, `git named as unavailable: ${JSON.stringify(fact.unavailable)}`);
    assert.match(gitProblem.reason, /filter\.x\.clean/);
  } finally {
    rec.restore();
  }
});

/* ══════════════════ Every call site: the flags and the environment ══════════════════ */

test('every git call reading a repository carries the flags, the environment from scratch and the user\'s excludes', async () => {
  // The home folder is this test's own, so the excludes file expected below does not depend on
  // how the shell running the tests spells its home: cmd and PowerShell set USERPROFILE and no
  // HOME, and some containers set neither (FG4c).
  const home = tmp('treemap-gitrec-callhome-');
  const saved = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
  process.env.HOME = home;
  delete process.env.XDG_CONFIG_HOME;
  resetGitSafeForTests();
  const root = fakeRepo();
  const rec = scriptedRepo(root, plainListing());
  let state: Awaited<ReturnType<typeof readRepoState>>;
  let ignored: Set<string> | null;
  try {
    const vetted = await vetRepository(root);
    assert.ok(vetted.ok);
    state = await readRepoState(root, { vetted: vetted.repo });
    ignored = await ignoredPaths(root, [path.join(root, 'a.txt')], { vetted: vetted.repo });
  } finally {
    rec.restore();
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    resetGitSafeForTests();
  }
  assert.ok(!('unknown' in state) && !('error' in state), JSON.stringify(state));
  assert.equal((state as GitRecoverability).fullyPushed, true);
  assert.deepEqual([...(ignored ?? ['failed'])], []);

  const cmds = commandsOf(rec.calls);
  for (const expected of ['rev-parse', 'config', 'remote', 'status', 'rev-list', 'ls-files', 'check-ignore']) {
    assert.ok(cmds.includes(expected), `${expected} was asked: ${cmds.join(', ')}`);
  }
  // The user's settings name no excludes file (the recorder answers the --global read with exit
  // 1), so it is git's own default under their home.
  const excludes = path.join(home, '.config', 'git', 'ignore');
  for (const call of rec.calls) {
    const sub = subcommand(call.args);
    assert.deepEqual(call.args.slice(0, GIT_HARDENING.length), [...GIT_HARDENING], `flags first: ${sub.join(' ')}`);
    if (sub.includes('--global')) continue; // the one read of the user's own settings, tested in gitSafe.test.ts
    const { GIT_CEILING_DIRECTORIES, ...env } = call.env;
    assert.deepEqual(env, gitEnvironment(), `the environment from scratch: ${sub.join(' ')}`);
    assert.equal(GIT_CEILING_DIRECTORIES, path.dirname(root), `git never looks above the repository: ${sub.join(' ')}`);
    assert.ok(!call.cwd.startsWith(root), 'started outside the repository');
    const rest = call.args.slice(GIT_HARDENING.length);
    assert.equal(rest[rest.indexOf('-C') + 1], root, `-C names the vetted root: ${sub.join(' ')}`);
    if (sub[0] === 'status' || sub[0] === 'check-ignore') {
      assert.ok(rest.includes(`core.excludesFile=${excludes}`), `the user's excludes file, passed explicitly: ${rest.join(' ')}`);
    }
  }
  const status = subcommand(rec.calls.find((c) => subcommand(c.args)[0] === 'status')!.args);
  assert.ok(status.includes('--ignore-submodules=dirty'), `status never recurses into a submodule: ${status.join(' ')}`);
});

test('the probe for whether git is installed is hardened like every other call', async () => {
  invalidateCapabilities();
  const rec = recordGit((sub) => (sub[0] === '--version' ? { stdout: 'git version 2.50.1\n' } : { code: 128 }));
  let state;
  try {
    state = await capabilityState('gitStatus');
  } finally {
    rec.restore();
    invalidateCapabilities();
  }
  assert.equal(state.available, true);
  const probes = rec.calls.filter((c) => subcommand(c.args)[0] === '--version');
  assert.equal(probes.length, 1, `git was probed once, through the runner: ${JSON.stringify(rec.calls.map((c) => c.args))}`);
  assert.deepEqual(probes[0].args, [...GIT_HARDENING, '--version']);
  assert.deepEqual(probes[0].env, gitEnvironment());
});

test('a clean repository with a submodule or nested project is unknown, with the reason', async () => {
  const root = fakeRepo();
  const gitlink = '100644 0123456789012345678901234567890123456789 0\ta.txt\x00160000 1123456789012345678901234567890123456789 0\tlib\0';
  const rec = scriptedRepo(root, plainListing(), { 'ls-files': { stdout: gitlink } });
  try {
    const state = await readRepoState(root);
    assert.ok('unknown' in state, `not claimed as pushed: ${JSON.stringify(state)}`);
    assert.match(state.unknown, /submodule/);
  } finally {
    rec.restore();
  }
});

test('a submodule marker split across chunks is still seen', async () => {
  const root = fakeRepo();
  const chunks = ['100644 0123456789012345678901234567890123456789 0\ta.txt\x00160', '00', '0 1123456789012345678901234567890123456789 0\tlib\0'];
  const rec = scriptedRepo(root, plainListing(), { 'ls-files': { chunks } });
  try {
    const state = await readRepoState(root);
    assert.ok('unknown' in state, JSON.stringify(state));
  } finally {
    rec.restore();
  }
  const plain = scriptedRepo(root, plainListing(), { 'ls-files': { chunks: ['100644 0123456789012345678901234567890123456789 0\ta.txt\0', '100644 1123456789012345678901234567890123456789 0\t160000 lib\0'] } });
  try {
    const state = await readRepoState(root);
    assert.equal((state as GitRecoverability).fullyPushed, true, `a name that merely contains the marker is not one: ${JSON.stringify(state)}`);
  } finally {
    plain.restore();
  }
});

/* ══════════════════ Real git, plain repositories ══════════════════ */

test('pushed, not pushed and a submodule still answer correctly with real git', async () => {
  const dir = tmp('treemap-gitrec-real-');
  const pushed = pushedRepo(dir, 'pushed');
  const state = await readRepoState(pushed);
  assert.ok(!('unknown' in state) && !('error' in state), JSON.stringify(state));
  assert.equal((state as GitRecoverability).fullyPushed, true);

  const ahead = pushedRepo(dir, 'ahead');
  fs.writeFileSync(path.join(ahead, 'b.txt'), 'b');
  git(ahead, ['add', '-A']);
  git(ahead, ['commit', '-qm', 'second']);
  const aheadState = await readRepoState(ahead);
  assert.equal((aheadState as GitRecoverability).ahead, 1);
  assert.equal((aheadState as GitRecoverability).fullyPushed, false);

  // A superproject whose own files are all pushed, with a submodule it does not look inside.
  const lib = pushedRepo(dir, 'lib');
  const sup = pushedRepo(dir, 'super');
  git(sup, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', lib, 'lib']);
  git(sup, ['commit', '-qm', 'lib']);
  git(sup, ['push', '-q', 'origin', 'main']);
  fs.appendFileSync(path.join(sup, 'lib', 'a.txt'), 'changed inside the submodule');
  const supState = await readRepoState(sup);
  assert.ok('unknown' in supState, `a submodule makes "fully pushed" unknown: ${JSON.stringify(supState)}`);
  assert.match(supState.unknown, /submodule/);
});

test("the user's own global excludes file still decides what counts as untracked", async () => {
  const dir = tmp('treemap-gitrec-excl-');
  const repo = pushedRepo(dir, 'repo');
  fs.writeFileSync(path.join(repo, 'build.log'), 'x');
  const home = tmp('treemap-gitrec-home-');
  fs.writeFileSync(path.join(home, '.gitconfig'), '[core]\n\texcludesFile = ~/global-ignore\n');
  fs.writeFileSync(path.join(home, 'global-ignore'), '*.log\n');
  const saved = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
  process.env.HOME = home;
  delete process.env.XDG_CONFIG_HOME;
  resetGitSafeForTests();
  try {
    const state = await readRepoState(repo);
    assert.equal((state as GitRecoverability).untrackedFiles, 0, 'build.log is ignored by the user\'s own file, as git itself would say');
    const ignored = await ignoredPaths(repo, [path.join(repo, 'build.log')]);
    assert.ok(ignored?.has(path.join(repo, 'build.log')), 'check-ignore agrees');
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    resetGitSafeForTests();
  }
  const bare = tmp('treemap-gitrec-nohome-');
  process.env.HOME = bare;
  resetGitSafeForTests();
  try {
    const state = await readRepoState(repo);
    assert.equal((state as GitRecoverability).untrackedFiles, 1, 'and without it, build.log is untracked');
  } finally {
    if (saved.HOME === undefined) delete process.env.HOME; else process.env.HOME = saved.HOME;
    if (saved.XDG_CONFIG_HOME !== undefined) process.env.XDG_CONFIG_HOME = saved.XDG_CONFIG_HOME;
    resetGitSafeForTests();
  }
});

/* ══════════════════ Real git, redirects that run nothing ══════════════════ */

test('a .git FILE pointing at another repository is read only when a scan covers that repository', async () => {
  const dir = tmp('treemap-gitrec-gitfile-');
  const victim = pushedRepo(dir, 'victim');
  const planted = path.join(dir, 'planted');
  fs.mkdirSync(planted);
  fs.writeFileSync(path.join(planted, '.git'), `gitdir: ${path.join(victim, '.git')}\n`);
  const refused = await readRepoState(planted, { insideScannedRoot: (p) => p.startsWith(planted) });
  assert.ok('unknown' in refused, JSON.stringify(refused));
  assert.match(refused.unknown, /outside every folder you scanned/);
  const read = await readRepoState(planted, { insideScannedRoot: (p) => p.startsWith(dir) });
  assert.ok('kind' in read && read.kind === 'git', `inside a scanned folder the same layout is read: ${JSON.stringify(read)}`);
  assert.equal(read.dirtyFiles, 1, "the planted folder's work tree lacks a.txt, and git says so");
});

test('a .git folder whose commondir points elsewhere is refused unless a scan covers it', async () => {
  const dir = tmp('treemap-gitrec-commondir-');
  const victim = pushedRepo(dir, 'victim');
  const planted = path.join(dir, 'planted');
  fs.mkdirSync(path.join(planted, '.git'), { recursive: true });
  fs.writeFileSync(path.join(planted, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  fs.writeFileSync(path.join(planted, '.git', 'commondir'), `${path.join(victim, '.git')}\n`);
  const vetting = await vetRepository(planted, { insideScannedRoot: (p) => p.startsWith(planted) });
  assert.equal(vetting.ok, false, JSON.stringify(vetting));
  assert.equal(!vetting.ok && vetting.kind, 'refused');
  const state = await readRepoState(planted, { insideScannedRoot: (p) => p.startsWith(planted) });
  assert.ok('unknown' in state, JSON.stringify(state));
});

test('a .git that is a link to another repository is refused unless a scan covers where it leads', async (t) => {
  const dir = tmp('treemap-gitrec-link-');
  const victim = pushedRepo(dir, 'victim');
  const planted = path.join(dir, 'planted');
  fs.mkdirSync(planted);
  try {
    fs.symlinkSync(path.join(victim, '.git'), path.join(planted, '.git'), 'dir');
  } catch {
    t.skip('this system cannot make a link here');
    return;
  }
  const state = await readRepoState(planted, { insideScannedRoot: (p) => p.startsWith(planted) });
  assert.ok('unknown' in state, JSON.stringify(state));
  assert.match(state.unknown, /outside every folder you scanned/);
});

test('an upstream that is another local branch is not a remote, so nothing reads as pushed', async () => {
  const dir = tmp('treemap-gitrec-localup-');
  const repo = pushedRepo(dir, 'repo');
  git(repo, ['branch', 'other']);
  git(repo, ['config', 'branch.main.remote', '.']);
  git(repo, ['config', 'branch.main.merge', 'refs/heads/other']);
  const state = await readRepoState(repo);
  assert.ok('kind' in state, JSON.stringify(state));
  assert.equal(state.ahead, null, 'no remote-tracking upstream: "pushed" is not defined');
  assert.equal(state.fullyPushed, false);
});

/* ══════════════════ Where .git points, read before git is started ══════════════════ */

function recordNothingExpected() {
  return recordGit((sub) => ({ code: 128, stderr: `the recorder: no git call was expected (${sub.join(' ')})` }));
}

test('a .git file naming a folder outside every scan is refused before git is started', async () => {
  const root = tmp('treemap-gitrec-pointer-');
  const elsewhere = tmp('treemap-gitrec-elsewhere-');
  fs.writeFileSync(path.join(root, '.git'), `gitdir: ${elsewhere}\n`);
  const rec = recordNothingExpected();
  try {
    const vetting = await vetRepository(root, { insideScannedRoot: (p) => p.startsWith(root) });
    assert.equal(!vetting.ok && vetting.kind, 'refused');
    assert.match(!vetting.ok ? vetting.reason : '', /outside every folder you scanned/);
  } finally {
    rec.restore();
  }
  assert.deepEqual(rec.calls, [], 'git was never started');
});

test('a .git file or commondir naming a network share is refused before git is started', async () => {
  for (const share of ['//fileserver/share/repo.git', '\\\\fileserver\\share\\repo.git']) {
    const root = tmp('treemap-gitrec-unc-');
    fs.writeFileSync(path.join(root, '.git'), `gitdir: ${share}\n`);
    const withCommon = tmp('treemap-gitrec-unc-common-');
    fs.mkdirSync(path.join(withCommon, '.git'));
    fs.writeFileSync(path.join(withCommon, '.git', 'commondir'), `${share}\n`);
    const rec = recordNothingExpected();
    try {
      for (const r of [root, withCommon]) {
        const vetting = await vetRepository(r, { insideScannedRoot: () => true });
        assert.equal(!vetting.ok && vetting.kind, 'refused', `${r}: ${JSON.stringify(vetting)}`);
        assert.match(!vetting.ok ? vetting.reason : '', /network share/);
      }
    } finally {
      rec.restore();
    }
    assert.deepEqual(rec.calls, [], `git was never started for ${share}`);
  }
});

test('a commondir in the folder a .git file names is followed one level, as git does', async () => {
  const root = tmp('treemap-gitrec-wt-');
  const admin = tmp('treemap-gitrec-admin-');
  const elsewhere = tmp('treemap-gitrec-common-');
  fs.writeFileSync(path.join(root, '.git'), `gitdir: ${admin}\n`);
  fs.writeFileSync(path.join(admin, 'commondir'), `${elsewhere}\n`);
  const rec = recordNothingExpected();
  try {
    const vetting = await vetRepository(root, { insideScannedRoot: (p) => p.startsWith(root) || p.startsWith(admin) });
    assert.equal(!vetting.ok && vetting.kind, 'refused');
    assert.ok((!vetting.ok ? vetting.reason : '').includes(elsewhere), 'the common dir is the one named');
  } finally {
    rec.restore();
  }
  assert.deepEqual(rec.calls, []);
});

test('a .git file naming a folder inside a scan goes on to git\'s own answer', async () => {
  const root = tmp('treemap-gitrec-inside-');
  const admin = path.join(root, 'admin');
  fs.mkdirSync(admin);
  fs.writeFileSync(path.join(root, '.git'), 'gitdir: admin\n');
  const rec = recordGit((sub) => (sub[0] === 'rev-parse' ? { stdout: `${root}\n${admin}\n${admin}\n` } : { stdout: plainListing() }));
  try {
    const vetting = await vetRepository(root, { insideScannedRoot: (p) => p.startsWith(root) });
    assert.equal(vetting.ok, true, JSON.stringify(vetting));
  } finally {
    rec.restore();
  }
  assert.deepEqual(commandsOf(rec.calls), ['rev-parse', 'config']);
});

/* ══════════════════ Through the provider, against the scans themselves (review #17) ══════════════════ */

/**
 * The reclaim score's hover path reaches git through the recoverability provider, which judges a
 * redirect against the scans this server holds (insideAnyScanRoot). These go through it with
 * real scan records, not a predicate the test writes.
 */
test('through the provider, a .git file naming a folder no scan covers leaves git unknown, and git is not started', async () => {
  const scanned = tmp('treemap-gitrec-prov-');
  createScanRecord(scanned);
  const unscanned = tmp('treemap-gitrec-prov-unscanned-');
  const project = path.join(scanned, 'project');
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, '.git'), `gitdir: ${unscanned}\n`);
  const file = path.join(project, 'a.txt');
  fs.writeFileSync(file, 'a');
  const rec = scriptedRepo(project, plainListing());
  try {
    const batch = await recoverabilityProvider.compute('no-scan', [file], new AbortController().signal);
    assert.deepEqual(commandsOf(rec.calls).filter((c) => c !== '--version'), [], 'refused before git: not even the vetting ran');
    const fact = batch.values.get(file);
    assert.ok(fact, 'the path is answered, with what could not be known');
    assert.equal(fact.git, null);
    const gitProblem = fact.unavailable.find((u) => u.signal === 'git');
    assert.match(gitProblem?.reason ?? '', /outside every folder you scanned/, JSON.stringify(fact.unavailable));
  } finally {
    rec.restore();
  }
});

test('through the provider, the same redirect into a scanned folder is read', async () => {
  const scanned = tmp('treemap-gitrec-prov-in-');
  createScanRecord(scanned);
  const admin = tmp('treemap-gitrec-prov-admin-');
  createScanRecord(admin);
  const project = path.join(scanned, 'project');
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, '.git'), `gitdir: ${admin}\n`);
  const file = path.join(project, 'a.txt');
  fs.writeFileSync(file, 'a');
  const rec = recordGit((sub) => {
    if (sub[0] === '--version') return { stdout: 'git version 2.50.1\n' };
    if (sub[0] === 'config' && sub.includes('--global')) return { code: 1 };
    if (sub[0] === 'rev-parse' && sub.includes('--show-toplevel')) return { stdout: `${project}\n${admin}\n${admin}\n` };
    if (sub[0] === 'rev-parse') return { stdout: 'refs/remotes/origin/main\n' };
    if (sub[0] === 'config') return { stdout: plainListing() };
    if (sub[0] === 'remote') return { stdout: 'origin\n' };
    if (sub[0] === 'status') return { stdout: '' };
    if (sub[0] === 'rev-list') return { stdout: '0\t0\n' };
    if (sub[0] === 'ls-files') return { stdout: '100644 0123456789012345678901234567890123456789 0\ta.txt\0' };
    if (sub[0] === 'check-ignore') return { code: 1 };
    return { code: 128, stderr: `fatal: the recorder was not scripted for ${sub.join(' ')}` };
  });
  try {
    const batch = await recoverabilityProvider.compute('no-scan', [file], new AbortController().signal);
    const fact = batch.values.get(file);
    assert.ok(fact?.git, `git answered for a redirect a scan covers: ${JSON.stringify(fact?.unavailable)}`);
    assert.equal(fact.git.fullyPushed, true);
  } finally {
    rec.restore();
  }
});

/* ══════════════════ Real git: layouts ordinary commands make are read (review #15, #20) ══════════════════ */

test('a recursive clone and a submodule checkout are read, not refused for the settings git wrote', async () => {
  const dir = tmp('treemap-gitrec-recursive-');
  const plain = pushedRepo(dir, 'plain');
  // `clone --recurse-submodules` writes submodule.active=. whether or not there are submodules.
  git(dir, ['clone', '-q', '--recurse-submodules', plain, 'recursive']);
  const recursive = path.join(dir, 'recursive');
  assert.match(git(recursive, ['config', '--local', '--list']), /^submodule\.active=/m, 'the setting the clone wrote');
  const clone = await vetRepository(recursive, { insideScannedRoot: (p) => p.startsWith(dir) });
  assert.equal(clone.ok, true, `a recursive clone: ${JSON.stringify(clone)}`);

  // A submodule's own settings name its work tree (core.worktree), which is the checkout itself.
  const lib = pushedRepo(dir, 'lib');
  const sup = pushedRepo(dir, 'super');
  git(sup, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', lib, 'lib']);
  const checkout = path.join(sup, 'lib');
  assert.match(git(checkout, ['config', '--local', '--list']), /^core\.worktree=/m, 'the setting the submodule has');
  const sub = await vetRepository(checkout, { insideScannedRoot: (p) => p.startsWith(dir) });
  assert.equal(sub.ok, true, `a submodule checkout whose git data a scan covers: ${JSON.stringify(sub)}`);
  const state = await readRepoState(checkout, { vetted: sub.ok ? sub.repo : undefined });
  assert.ok('kind' in state, `and it is read: ${JSON.stringify(state)}`);
});
