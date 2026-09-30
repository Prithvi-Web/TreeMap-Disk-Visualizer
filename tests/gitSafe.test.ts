import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { fileTempDir, isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-gitSafe-data-');

import {
  GIT_HARDENING, GIT_INHERITED_ENV, configKeyRefusal, gitEnvironment, parseConfigList, resetGitSafeForTests, runGit,
  userExcludesArgs, userExcludesFile, vetRepository,
} from '../src/services/gitSafe';
import { commandsOf, recordGit, type RecordedGit } from './fixtures/gitRecorder';

/**
 * FG4 — every git call TreeMap makes, and the vetting before any of them reads a work tree.
 *
 * A repository's own `.git/config` can name programs for git to run (`core.fsmonitor`,
 * `filter.<x>.clean`, hooks…), and TreeMap asks git about repositories it finds under folders
 * someone else may have filled. **Nothing here plants such a repository.** The vetting is proven
 * on text written in the output format of `git config --list --show-origin --no-includes -z`,
 * and the calls on a recorder that answers from a script and starts nothing
 * (tests/fixtures/gitRecorder.ts). The one real git call in this file reads a `.gitconfig` that
 * holds nothing but an excludes path.
 */

const ROOTS: string[] = [];
/**
 * A new folder, spelled as the code under test resolves it: by the native realpath. The JS one
 * keeps a spelling the file system only aliases — the Windows runner's temp folder is
 * `C:\Users\RUNNER~1\…`, an 8.3 name for `runneradmin` — so a test that compared its own
 * spelling with gitSafe's failed there however right the code was (FG4c).
 */
function tmp(prefix: string): string {
  const dir = fs.realpathSync.native(fileTempDir(prefix));
  ROOTS.push(dir);
  return dir;
}

/** A folder holding an empty `.git` folder: enough for paths to resolve, no repository at all. */
function fakeRepo(): string {
  const root = tmp('treemap-gitsafe-repo-');
  fs.mkdirSync(path.join(root, '.git'));
  return root;
}

/** The pairs GIT_HARDENING sets, as `key=value`. */
function hardeningPairs(): string[] {
  const out: string[] = [];
  for (let i = 0; i < GIT_HARDENING.length; i += 2) {
    assert.equal(GIT_HARDENING[i], '-c', `GIT_HARDENING is -c pairs only: ${JSON.stringify(GIT_HARDENING)}`);
    out.push(GIT_HARDENING[i + 1]);
  }
  return out;
}

/** The config listing of a plain repository, as `git config --list --show-origin --no-includes -z` prints it. */
function listing(...entries: [string, string | null][]): string {
  const plain: [string, string | null][] = [
    ['core.repositoryformatversion', '0'], ['core.filemode', 'true'], ['core.bare', 'false'],
    ['core.logallrefupdates', 'true'], ['core.ignorecase', 'true'], ['core.precomposeunicode', 'true'],
  ];
  const ours = hardeningPairs().map((pair) => {
    const eq = pair.indexOf('=');
    return `command line:\0${pair.slice(0, eq).toLowerCase()}\n${pair.slice(eq + 1)}\0`;
  });
  return [...plain, ...entries].map(([k, v]) => `file:.git/config\0${k}${v === null ? '' : `\n${v}`}\0`).join('') + ours.join('');
}

/* ══════════════════ The flags and the environment ══════════════════ */

test('every git call switches off what git would start by itself', () => {
  const pairs = hardeningPairs();
  const byKey = new Map(pairs.map((p) => [p.slice(0, p.indexOf('=')).toLowerCase(), p.slice(p.indexOf('=') + 1)]));
  assert.equal(byKey.get('core.fsmonitor'), 'false', 'no file-system monitor command');
  assert.equal(byKey.get('core.pager'), 'cat', 'no pager');
  assert.equal(byKey.get('core.untrackedcache'), 'false', 'the untracked cache neither read nor written');
  assert.equal(byKey.get('credential.helper'), '', 'the helper list emptied');
  assert.equal(byKey.get('protocol.allow'), 'never', 'no transport at all, so no remote helper and no fetch');
  const hooks = byKey.get('core.hookspath');
  assert.ok(hooks, 'hooks pointed away from the repository');
  if (process.platform === 'win32') {
    assert.equal(fs.existsSync(hooks), false, `a folder no one made: ${hooks}`);
    assert.ok(hooks.startsWith(os.tmpdir()), 'under the user\'s own temp folder, whose name no one can guess');
  } else {
    assert.equal(hooks, '/dev/null', 'a device, under which no hook can exist');
  }
});

/**
 * Every name gitEnvironment may copy from the caller, on any platform: what finding git on PATH,
 * running it and giving it a temp folder needs, and nothing git reads for settings or behaviour.
 */
const STARTING_GIT: ReadonlySet<string> = new Set(['PATH', 'TMPDIR', 'PATHEXT', 'SystemRoot', 'windir', 'ComSpec', 'TEMP', 'TMP']);

test('the environment is built from scratch: nothing git reads is inherited', () => {
  const hostile: NodeJS.ProcessEnv = {
    PATH: '/usr/bin:/bin', TMPDIR: '/tmp/x', HOME: '/home/someone', XDG_CONFIG_HOME: '/home/someone/.config', USERPROFILE: 'C:\\Users\\someone',
    // What Windows needs to find and start git; on POSIX none of these may pass.
    PATHEXT: '.COM;.EXE;.BAT', SystemRoot: 'C:\\Windows', windir: 'C:\\Windows', ComSpec: 'C:\\Windows\\system32\\cmd.exe',
    TEMP: 'C:\\Temp', TMP: 'C:\\Temp',
    GIT_DIR: '/elsewhere/.git', GIT_WORK_TREE: '/elsewhere', GIT_CONFIG_PARAMETERS: "'core.fsmonitor=prog'",
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.fsmonitor', GIT_CONFIG_VALUE_0: 'prog', GIT_CONFIG_GLOBAL: '/x', GIT_CONFIG_SYSTEM: '/y',
    GIT_EXEC_PATH: '/x', GIT_SSH_COMMAND: 'prog', GIT_EXTERNAL_DIFF: 'prog', GIT_PAGER: 'prog', GIT_EDITOR: 'prog', GIT_ASKPASS: 'prog',
    GIT_INDEX_FILE: '/x', GIT_OBJECT_DIRECTORY: '/x', GIT_ALTERNATE_OBJECT_DIRECTORIES: '/x', GIT_TRACE: '/x', GIT_OPTIONAL_LOCKS: '1',
    PAGER: 'prog', EDITOR: 'prog', SSH_ASKPASS: 'prog', LD_PRELOAD: '/x.so', DYLD_INSERT_LIBRARIES: '/x.dylib', NODE_OPTIONS: '--x',
  };
  const env = gitEnvironment(hostile);
  // The inherited names come from gitSafe itself, not restated per platform here: the Windows leg
  // once expected none and failed on the PATH git needs (FG4c). What keeps the list honest is
  // that every name on it is one git needs to be found and started.
  assert.ok(GIT_INHERITED_ENV.includes('PATH'), 'git is found on PATH');
  for (const name of GIT_INHERITED_ENV) {
    assert.ok(STARTING_GIT.has(name), `${name} is inherited only because finding and starting git needs it`);
    assert.equal(env[name], hostile[name], `${name} is what finding and starting git needs`);
  }
  assert.equal(env.GIT_CONFIG_NOSYSTEM, '1', 'no system config');
  assert.equal(env.GIT_CONFIG_GLOBAL, process.platform === 'win32' ? env.GIT_CONFIG_GLOBAL : '/dev/null', 'no global config');
  assert.notEqual(env.GIT_CONFIG_GLOBAL, hostile.GIT_CONFIG_GLOBAL);
  assert.equal(env.GIT_OPTIONAL_LOCKS, '0', 'status never rewrites the index (and so never fires a hook for it)');
  assert.equal(env.GIT_TERMINAL_PROMPT, '0');
  assert.equal(env.GIT_ASKPASS, '');
  assert.equal(env.SSH_ASKPASS, '');
  assert.equal(env.GIT_NO_LAZY_FETCH, '1', 'a partial clone never fetches what it is missing');
  assert.notEqual(env.HOME, hostile.HOME, "the user's HOME is not where git looks for settings");
  assert.notEqual(env.XDG_CONFIG_HOME, hostile.XDG_CONFIG_HOME);
  assert.equal(env.HOME, env.XDG_CONFIG_HOME, 'both point at the same nowhere');
  const allowed = new Set([...GIT_INHERITED_ENV, 'HOME', 'XDG_CONFIG_HOME', 'GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL', 'GIT_ATTR_NOSYSTEM',
    'GIT_OPTIONAL_LOCKS', 'GIT_TERMINAL_PROMPT', 'GIT_ASKPASS', 'SSH_ASKPASS', 'GIT_NO_LAZY_FETCH']);
  const extra = Object.keys(env).filter((k) => !allowed.has(k));
  assert.deepEqual(extra, [], 'nothing else reaches git');
});

test('a call through the runner carries the flags and the environment, and runs outside the repository', async () => {
  const root = fakeRepo();
  const saved = { GIT_DIR: process.env.GIT_DIR, GIT_CONFIG_PARAMETERS: process.env.GIT_CONFIG_PARAMETERS };
  process.env.GIT_DIR = path.join(root, 'elsewhere');
  process.env.GIT_CONFIG_PARAMETERS = "'core.fsmonitor=prog'";
  const rec = recordGit(() => ({ stdout: 'origin\n' }));
  try {
    const run = await runGit(['-C', root, 'remote'], { repoRoot: root });
    assert.deepEqual(run, { ok: true, stdout: 'origin\n', stderr: '' });
  } finally {
    rec.restore();
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
  assert.equal(rec.calls.length, 1);
  const [call] = rec.calls;
  assert.deepEqual(call.args.slice(0, GIT_HARDENING.length), [...GIT_HARDENING], 'the flags come first');
  assert.deepEqual(call.args.slice(GIT_HARDENING.length), ['-C', root, 'remote']);
  const { GIT_CEILING_DIRECTORIES, ...rest } = call.env;
  assert.deepEqual(rest, gitEnvironment(), 'the environment from scratch, not this process\'s GIT_DIR or GIT_CONFIG_PARAMETERS');
  assert.equal(GIT_CEILING_DIRECTORIES, path.dirname(root), 'git never looks above the repository it was asked about');
  assert.ok(!call.cwd.startsWith(root), 'git starts outside the repository and is taken there by -C');
  const expectedCwd = process.platform === 'win32' ? (process.env.SystemRoot || process.env.windir) : os.tmpdir();
  assert.equal(call.cwd, expectedCwd, 'on Windows, where a program is looked for in the working folder first, a folder only administrators write');
});

test('a failing git is a failure: exit 1 only answers for check-ignore, and too much output is refused', async () => {
  const rec = recordGit(() => ({ code: 1, stdout: '', stderr: 'fatal: something\n' }));
  try {
    assert.deepEqual(await runGit(['status']), { ok: false, error: 'fatal: something' });
    assert.deepEqual(await runGit(['check-ignore'], { exitOneIsEmpty: true }), { ok: true, stdout: '', stderr: 'fatal: something\n' });
  } finally {
    rec.restore();
  }
  const big = recordGit(() => ({ stdout: 'x'.repeat(64) }));
  try {
    const run = await runGit(['status'], { maxBuffer: 16 });
    assert.equal(run.ok, false);
    assert.match(!run.ok ? run.error : '', /more than 16 characters/);
  } finally {
    big.restore();
  }
});

/* ══════════════════ Reading the settings: git's own parser, on text ══════════════════ */

test('the -z listing is read record by record, a key without a value included', () => {
  assert.deepEqual(parseConfigList(''), []);
  assert.deepEqual(
    parseConfigList('file:.git/config\0core.bare\nfalse\0command line:\0core.fsmonitor\nfalse\0file:.git/config\0core.ignorecase\0'),
    [
      { origin: 'file:.git/config', key: 'core.bare', value: 'false' },
      { origin: 'command line:', key: 'core.fsmonitor', value: 'false' },
      { origin: 'file:.git/config', key: 'core.ignorecase', value: null },
    ],
  );
  assert.deepEqual(parseConfigList('file:x\0user.name\nline one\nline two\0'), [{ origin: 'file:x', key: 'user.name', value: 'line one\nline two' }],
    'a value may hold newlines; the key ends at the first');
  assert.equal(parseConfigList('file:.git/config\0core.bare\nfalse'), null, 'a listing cut short is not read at all');
  assert.equal(parseConfigList('file:.git/config\0core.bare\nfalse\0file:.git/config\0'), null, 'an origin without its record is not read');
});

test('settings git init, clone (a recursive one too), husky, VS Code, gh and submodules write are allowed', () => {
  const allowed: [string, string | null][] = [
    ['core.repositoryformatversion', '0'], ['core.filemode', 'true'], ['core.bare', 'false'], ['core.logallrefupdates', 'true'],
    ['core.ignorecase', 'true'], ['core.precomposeunicode', 'true'], ['core.symlinks', 'false'], ['core.autocrlf', 'input'],
    ['core.bare', null], ['core.sparsecheckout', 'true'], ['extensions.objectformat', 'sha256'], ['extensions.worktreeconfig', 'true'],
    ['remote.origin.url', 'git@example.invalid:me/repo.git'], ['remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*'],
    ['branch.main.remote', 'origin'], ['branch.main.merge', 'refs/heads/main'], ['branch.feature/x.vscode-merge-base', 'origin/main'],
    ['user.name', 'Someone'], ['user.email', 'someone@example.invalid'], ['user.signingkey', 'ABC'], ['commit.gpgsign', 'true'],
    ['submodule.lib.url', '../lib'], ['submodule.lib.active', 'true'], ['submodule.lib.update', 'rebase'],
    ['lfs.repositoryformatversion', '0'], ['pull.rebase', 'true'], ['init.defaultbranch', 'main'],
    // `git clone --recurse-submodules` writes the flat form, with or without submodules (review #15, #12).
    ['submodule.active', '.'],
    // Every submodule checkout's own settings: its work tree, which git's answer must still place in
    // the folder itself (vetRepository's toplevel check; review #20).
    ['core.worktree', '../../../lib'],
    // Written by ordinary tools into a repository's own settings, and read by no command that starts
    // a program (review #21): gh's default remote, a fork's push remote, the rest inert switches.
    ['remote.upstream.gh-resolved', 'base'], ['remote.pushdefault', 'origin'], ['branch.autosetupmerge', 'true'],
    ['branch.autosetuprebase', 'always'], ['core.sharedrepository', 'group'], ['gpg.format', 'ssh'], ['merge.conflictstyle', 'zdiff3'],
    ['rerere.enabled', 'true'], ['rerere.autoupdate', 'true'], ['diff.renames', 'copies'], ['status.showuntrackedfiles', 'all'],
    ['lfs.url', 'https://example.invalid/lfs'], ['advice.detachedhead', 'false'], ['advice.statushints', 'false'],
    // Set on the command line by every call, which wins over the repository's own value.
    ['core.hookspath', '.husky/_'], ['core.untrackedcache', 'true'], ['core.fsmonitor', 'true'], ['core.fsmonitor', 'false'],
    // git prints section and key in lower case; a caller may not.
    ['Core.Bare', 'false'], ['REMOTE.Origin.URL', 'x'],
  ];
  for (const [key, value] of allowed) {
    assert.equal(configKeyRefusal(key, value), null, `${key}=${String(value)} is allowed`);
  }
});

test('anything that can start a program or read another file is refused', () => {
  const refused: [string, string | null][] = [
    ['core.fsmonitor', 'some-program'], ['core.fsmonitor', './watch'], ['filter.x.clean', 'prog %f'], ['filter.x.smudge', 'prog'],
    ['filter.x.process', 'prog'], ['filter.x.required', 'true'], ['filter.lfs.process', 'git-lfs filter-process'],
    ['diff.external', 'prog'], ['diff.x.textconv', 'prog'], ['diff.x.command', 'prog'], ['merge.x.driver', 'prog'],
    ['core.sshcommand', 'prog'], ['core.editor', 'prog'], ['core.pager', 'prog'], ['core.askpass', 'prog'], ['core.gitproxy', 'prog'],
    ['core.alternaterefscommand', 'prog'], ['core.attributesfile', '/elsewhere'],
    // Near names of the inert ones allowed above: only those exact keys are.
    ['remote.origin.gh-resolved.x', 'y'], ['submodule.active.x', 'y'], ['gpg.x509.program', 'prog'], ['gpg.ssh.allowedsignersfile', '/x'],
    ['remote.origin.gh-command', 'prog'], ['merge.tool', 'prog'], ['mergetool.x.cmd', 'prog'], ['difftool.x.cmd', 'prog'],
    ['include.path', '/elsewhere/config'], ['includeif.gitdir:/x/.path', '/elsewhere/config'], ['includeIf.onbranch:main.path', 'x'],
    ['credential.helper', 'prog'], ['credential.https://example.invalid.helper', 'prog'], ['gpg.program', 'prog'],
    ['gpg.ssh.program', 'prog'], ['alias.st', '!prog'], ['sequence.editor', 'prog'], ['pager.log', 'prog'],
    ['protocol.file.allow', 'always'], ['protocol.allow', 'always'], ['remote.origin.uploadpack', 'prog'], ['remote.origin.receivepack', 'prog'],
    ['remote.origin.vcs', 'x'], ['url.ext::prog.insteadof', 'https://'], ['submodule.lib.update', '!prog'],
    ['gc.recentobjectshook', 'prog'], ['uploadpack.packobjectshook', 'prog'], ['interactive.difffilter', 'prog'],
    ['http.proxy', 'http://example.invalid'], ['FILTER.X.Clean', 'prog'], ['somenewsection.key', 'x'], ['core', 'x'],
    // A partial clone fetches what it lacks on demand, which git before 2.44 cannot be told not to.
    ['extensions.partialclone', 'origin'], ['remote.origin.promisor', 'true'], ['remote.origin.partialclonefilter', 'blob:none'],
  ];
  for (const [key, value] of refused) {
    const reason = configKeyRefusal(key, value);
    assert.ok(reason, `${key}=${String(value)} is refused`);
  }
  assert.match(configKeyRefusal('include.path', 'x')!, /another file/, 'an include is refused for what it is');
  assert.match(configKeyRefusal('filter.x.clean', 'prog')!, /start a program/);
});

/* ══════════════════ Vetting a repository (the recorder answers; nothing starts) ══════════════════ */

/** The recorder scripted as a repository at `root` would answer: `rev-parse` then `config --list`. */
function scripted(root: string, config: string, where?: { top?: string; gitDir?: string; common?: string }) {
  return recordGit((sub) => {
    if (sub[0] === 'rev-parse') {
      return { stdout: `${where?.top ?? root}\n${where?.gitDir ?? path.join(root, '.git')}\n${where?.common ?? '.git'}\n` };
    }
    if (sub[0] === 'config') return { stdout: config };
    return { code: 128, stderr: `fatal: the recorder was not scripted for ${sub.join(' ')}` };
  });
}

async function vet(root: string, config: string, where?: Parameters<typeof scripted>[2], insideScannedRoot?: (p: string) => boolean) {
  const rec = scripted(root, config, where);
  try {
    return { result: await vetRepository(root, insideScannedRoot ? { insideScannedRoot } : {}), calls: rec.calls };
  } finally {
    rec.restore();
  }
}

function assertOnlyReads(calls: RecordedGit[]): void {
  assert.deepEqual(commandsOf(calls), ['rev-parse', 'config'], 'vetting asks where the repository is and what it sets, nothing more');
  const config = calls[1].args.slice(GIT_HARDENING.length);
  assert.ok(config.includes('--no-includes') && config.includes('--show-origin') && config.includes('-z') && config.includes('--list'),
    `git's own parser, includes not followed: ${config.join(' ')}`);
}

test('a plain repository passes, and its git dir is where it says', async () => {
  const root = fakeRepo();
  const { result, calls } = await vet(root, listing(['user.name', 'Someone'], ['remote.origin.url', 'x']));
  assert.deepEqual(result, { ok: true, repo: { root, gitDir: path.join(root, '.git'), commonDir: path.join(root, '.git') } });
  assertOnlyReads(calls);
});

test('a setting that can start a program refuses the repository, naming it', async () => {
  const root = fakeRepo();
  const { result, calls } = await vet(root, listing(['filter.x.clean', 'some-program %f']));
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.kind, 'refused');
  assert.match(!result.ok ? result.reason : '', /filter\.x\.clean/);
  assertOnlyReads(calls);
});

test('an include is refused rather than followed', async () => {
  const root = fakeRepo();
  const { result } = await vet(root, listing(['include.path', '../../elsewhere']));
  assert.equal(!result.ok && result.kind, 'refused');
  assert.match(!result.ok ? result.reason : '', /include\.path/);
});

test('only the flags TreeMap set itself pass as command-line settings', async () => {
  const root = fakeRepo();
  const foreign = `${listing()}command line:\0filter.x.clean\nsome-program\0`;
  const { result } = await vet(root, foreign);
  assert.equal(!result.ok && result.kind, 'refused', 'a command-line setting TreeMap did not pass is vetted like any other');
});

test('a listing that cannot be read refuses the repository', async () => {
  const root = fakeRepo();
  const { result } = await vet(root, 'file:.git/config\0core.bare\nfalse');
  assert.equal(!result.ok && result.kind, 'refused');
});

test('a folder git does not treat as a project of its own is refused', async () => {
  const root = fakeRepo();
  const parent = path.dirname(root);
  const { result } = await vet(root, listing(), { top: parent, gitDir: path.join(root, '.git') });
  assert.equal(!result.ok && result.kind, 'refused');
});

test('git data kept elsewhere is refused unless a scan covers where it is', async () => {
  // Git keeps its data elsewhere only where the repository says so — a `.git` file, a `commondir` —
  // and git's answer must be the folder TreeMap read there (FG4d, review #1).
  const elsewhere = fakeRepo();
  const gitDir = path.join(elsewhere, '.git');
  const pointing = (): string => {
    const root = tmp('treemap-gitsafe-repo-');
    fs.writeFileSync(path.join(root, '.git'), `gitdir: ${gitDir}\n`);
    return root;
  };
  const outsideRoot = pointing();
  const outside = await vet(outsideRoot, listing(), { gitDir, common: gitDir }, () => false);
  assert.equal(!outside.result.ok && outside.result.kind, 'refused', 'a .git file or link pointing outside every scan');
  assert.match(!outside.result.ok ? outside.result.reason : '', /outside every folder you scanned/);
  const defaultRoot = pointing();
  const byDefault = await vet(defaultRoot, listing(), { gitDir, common: gitDir });
  assert.equal(byDefault.result.ok, false, 'with no way to tell, a redirect is refused');
  const insideRoot = pointing();
  const inside = await vet(insideRoot, listing(), { gitDir, common: gitDir }, (p) => p.startsWith(elsewhere));
  assert.equal(inside.result.ok, true, `the same redirect inside a scanned folder is read: ${JSON.stringify(inside.result)}`);

  const commonRoot = fakeRepo();
  fs.writeFileSync(path.join(commonRoot, '.git', 'commondir'), `${gitDir}\n`);
  const common = await vet(commonRoot, listing(), { common: gitDir }, () => false);
  assert.equal(!common.result.ok && common.result.kind, 'refused', 'a commondir pointing outside every scan');

  // The git dir alone elsewhere, its common dir the repository's own (review #18): each is judged.
  const aloneRoot = pointing();
  const gitDirOnly = await vet(aloneRoot, listing(), { gitDir }, (p) => p.startsWith(aloneRoot));
  assert.equal(!gitDirOnly.result.ok && gitDirOnly.result.kind, 'refused', `a git dir outside every scan: ${JSON.stringify(gitDirOnly.result)}`);
  assert.ok((!gitDirOnly.result.ok ? gitDirOnly.result.reason : '').includes(gitDir));

  // Git answering a place the repository never named is refused whatever a scan covers.
  const plain = fakeRepo();
  const unnamed = await vet(plain, listing(), { gitDir, common: gitDir }, () => true);
  assert.equal(!unnamed.result.ok && unnamed.result.kind, 'refused', JSON.stringify(unnamed.result));
  assert.match(!unnamed.result.ok ? unnamed.result.reason : '', /not where TreeMap read ahead/);
});

test('a work tree kept elsewhere (core.worktree) is refused by where git says the project is', async () => {
  // core.worktree cannot start a program, so the setting itself passes (every submodule checkout
  // has one, review #20); what it could do — make git read another folder as this project — is
  // what the toplevel check refuses, and rev-parse runs before the settings are listed at all.
  const root = fakeRepo();
  const elsewhere = tmp('treemap-gitsafe-worktree-');
  const moved = await vet(root, listing(['core.worktree', elsewhere]), { top: elsewhere });
  assert.equal(!moved.result.ok && moved.result.kind, 'refused', JSON.stringify(moved.result));
  assert.match(!moved.result.ok ? moved.result.reason : '', /as this project's folder/);
  const own = await vet(root, listing(['core.worktree', root]));
  assert.equal(own.result.ok, true, `a work tree that is the folder itself: ${JSON.stringify(own.result)}`);
});

test('git failing to answer is an error for that repository, not a refusal', async () => {
  const root = fakeRepo();
  const rec = recordGit(() => ({ code: 128, stderr: 'fatal: not a git repository (or any of the parent directories): .git\n' }));
  try {
    const result = await vetRepository(root);
    assert.deepEqual(result, { ok: false, kind: 'error', reason: 'fatal: not a git repository (or any of the parent directories): .git' });
    assert.deepEqual(commandsOf(rec.calls), ['rev-parse']);
  } finally {
    rec.restore();
  }
});

test('a repository another account owns says so, and why a safe.directory exception cannot help', async () => {
  // Git refuses a repository owned by another account unless the user's own settings list it
  // under safe.directory — settings no TreeMap call reads (review #22). Git's hint to add one
  // would mislead here, so it is not passed on.
  const root = fakeRepo();
  const stderr = `fatal: detected dubious ownership in repository at '${root}'\nTo add an exception for this directory, call:\n\n\tgit config --global --add safe.directory ${root}\n`;
  const rec = recordGit(() => ({ code: 128, stderr }));
  try {
    const result = await vetRepository(root);
    assert.equal(!result.ok && result.kind, 'error', 'git could not answer: an error for that repository');
    const reason = !result.ok ? result.reason : '';
    assert.match(reason, /another account/);
    assert.match(reason, /safe\.directory/);
    assert.match(reason, /does not use your Git settings/);
    assert.doesNotMatch(reason, /git config --global/, 'no advice that cannot work');
  } finally {
    rec.restore();
  }
});

/* ══════════════════ The user's own ignore file, passed explicitly ══════════════════ */

test('the user\'s global excludes file is read from their own settings, and defaulted as git does', async () => {
  resetGitSafeForTests();
  const home = tmp('treemap-gitsafe-home-');
  const rec = recordGit((sub) => (sub.includes('--global') ? { stdout: `${path.join(home, 'my-ignore')}\n` } : { code: 1 }));
  try {
    assert.equal(await userExcludesFile({ HOME: home, PATH: process.env.PATH }), path.join(home, 'my-ignore'));
  } finally {
    rec.restore();
  }
  assert.equal(rec.calls.length, 1);
  const [call] = rec.calls;
  assert.deepEqual(call.args.slice(0, GIT_HARDENING.length), [...GIT_HARDENING]);
  assert.deepEqual(call.args.slice(GIT_HARDENING.length), ['config', '--global', '--path', '--get', 'core.excludesFile']);
  assert.equal(call.env.HOME, home, 'the one call that reads the user\'s own settings sees their HOME');
  assert.equal(call.env.GIT_CONFIG_GLOBAL, undefined);
  assert.equal(call.env.GIT_CONFIG_NOSYSTEM, '1');

  const none = recordGit(() => ({ code: 1 }));
  try {
    assert.equal(await userExcludesFile({ HOME: home }), path.join(home, '.config', 'git', 'ignore'), 'unset: git\'s own default');
    assert.equal(await userExcludesFile({ HOME: home, XDG_CONFIG_HOME: path.join(home, 'xdg') }), path.join(home, 'xdg', 'git', 'ignore'));
  } finally {
    none.restore();
  }
});

test('real git reads the excludes path from a plain .gitconfig, ~ expanded', async () => {
  resetGitSafeForTests();
  const home = tmp('treemap-gitsafe-realhome-');
  fs.writeFileSync(path.join(home, '.gitconfig'), '[core]\n\texcludesFile = ~/my-ignore\n');
  // What finding and starting git needs, as production passes it (on Windows, PATHEXT and
  // SystemRoot too); HOME is the one read of the user's own settings.
  const base: NodeJS.ProcessEnv = { HOME: home };
  for (const name of GIT_INHERITED_ENV) if (process.env[name] !== undefined) base[name] = process.env[name];
  // Git for Windows expands `~/` with forward slashes (C:/Users/…/my-ignore), and reads either
  // spelling back; the file named is what counts.
  assert.equal(path.resolve(await userExcludesFile(base)), path.join(home, 'my-ignore'));
});

test('an excludes file that cannot be worked out passes nothing, and is tried again next time', async () => {
  resetGitSafeForTests();
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, homedir: os.homedir };
  delete process.env.HOME;
  delete process.env.USERPROFILE;
  (os as { homedir: () => string }).homedir = () => { throw new Error('no home folder for this uid'); };
  try {
    assert.deepEqual(await userExcludesArgs(), [], 'nothing passed, and no rejection for every repository after');
  } finally {
    (os as { homedir: () => string }).homedir = saved.homedir;
    if (saved.HOME !== undefined) process.env.HOME = saved.HOME;
    if (saved.USERPROFILE !== undefined) process.env.USERPROFILE = saved.USERPROFILE;
  }
  const rec = recordGit(() => ({ code: 1 }));
  try {
    const args = await userExcludesArgs();
    assert.equal(args[0], '-c', `the failure was not kept: ${JSON.stringify(args)}`);
  } finally {
    rec.restore();
    resetGitSafeForTests();
  }
});

/* ══════════════════ gitSafe is the only place git starts (review #14) ══════════════════ */

/**
 * A call that starts git by name: a child_process call (`spawn`, `execFile`, `fork`…, and `exec`
 * with shell text that begins with git), a wrapper that runs a command by name (`run…`,
 * `exec…`, `spawn…`), or `commandExists('git')` — the probe FG4 replaced. Read on the source as
 * written, comments included: a comment that reads like one is reworded rather than let through.
 */
const STARTS_GIT = /\b(?:spawn\w*|exec\w*|fork|run\w*|commandExists)\s*\(\s*(['"`])\s*git(?:\.exe)?(?:\1|\s)/g;

function sourcesUnder(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourcesUnder(full);
    return /\.ts$/.test(entry.name) ? [full] : [];
  });
}

test('the scan for a git start finds each way one is written, and nothing else', () => {
  const found = (text: string): number => [...text.matchAll(STARTS_GIT)].length;
  for (const start of ["spawn('git', args)", 'cp.spawnSync("git", [])', "execFile('git', ['status'])", 'execFileSync(`git`, [])',
    "exec('git status')", "execSync(' git gc')", "fork('git')", "runJson('git', ['x'])", "commandExists('git', ['--version'])",
    "execFile('git.exe', [])"]) {
    assert.equal(found(start), 1, `seen: ${start}`);
  }
  for (const other of ["runGit(['--version'])", "unavailable('git')", "path.join(root, '.git')", "spawn('gitk')", "exec('digit')",
    "capabilityState('gitStatus')", "execFile('/usr/bin/cat', ['git'])"]) {
    assert.equal(found(other), 0, `not a git start: ${other}`);
  }
});

test('gitSafe.ts is the only place in src/ that starts git, so every call is hardened and vetted', () => {
  const src = path.join(__dirname, '..', 'src');
  const gitSafe = path.join(src, 'services', 'gitSafe.ts');
  assert.equal([...fs.readFileSync(gitSafe, 'utf8').matchAll(STARTS_GIT)].length, 1, 'gitSafe starts git in exactly one place (realSpawn)');
  const elsewhere = sourcesUnder(src).filter((file) => file !== gitSafe).flatMap((file) => {
    const text = fs.readFileSync(file, 'utf8');
    return [...text.matchAll(STARTS_GIT)].map((m) => {
      const line = text.slice(0, m.index).split('\n').length;
      return `${path.relative(src, file).split(path.sep).join('/')}:${String(line)}: ${m[0]}`;
    });
  });
  assert.deepEqual(elsewhere, [], 'git is started only through gitSafe (runGit / runGitInvocation), never by name elsewhere');
});
