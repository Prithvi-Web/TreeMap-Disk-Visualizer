import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import { fileTempDir, isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-gitPointers-data-');

import { vetRepository } from '../src/services/gitSafe';
import { readRepoState } from '../src/services/gitRecoverability';
import type { GitRecoverability } from '../src/services/recoverabilityTypes';
import { commandsOf, recordGit } from './fixtures/gitRecorder';

/**
 * FG4c — every file through which git follows a path is read by TreeMap before git starts.
 *
 * FG4 read where a `.git` link or file and a `commondir` point. Git also follows
 * `objects/info/alternates` (the object folders a repository borrows from, and theirs in turn)
 * and a link at the top of the git folder (a linked `objects`, `refs`, `config`…), during the
 * very first `rev-parse`, before any setting is vetted (review #1). And a pointer's `..` was
 * dropped by `path.resolve` before its links were followed, so `gitdir: a/../b` with `a` a link
 * elsewhere was judged as `<root>/b` (review #2).
 *
 * **Nothing here plants a repository that names a program.** The layouts are plain folders and
 * text files that only redirect (a `.git` file, a `commondir`, an `alternates` line, a link), and
 * git is the recorder (tests/fixtures/gitRecorder.ts), which starts nothing: a missing check
 * shows as a recorded argv. The one real-git test uses plain repositories made here.
 */

/** A new folder, spelled by the native realpath as gitSafe resolves (the Windows runner's temp is 8.3). */
function tmp(prefix: string): string {
  return fs.realpathSync.native(fileTempDir(prefix));
}

/** A folder holding a `.git` folder with an `objects/info` folder: paths resolve; no repository. */
function fakeRepo(): string {
  const root = tmp('treemap-gitptr-repo-');
  fs.mkdirSync(path.join(root, '.git', 'objects', 'info'), { recursive: true });
  return root;
}

/** The settings of a plain repository, as `git config --list --show-origin --no-includes -z` prints them. */
const PLAIN = 'file:.git/config\0core.repositoryformatversion\n0\0file:.git/config\0core.bare\nfalse\0';

/** The recorder, answering the vetting's two reads as the repository at `root` (its own .git) would. */
function answeringFor(root: string) {
  return recordGit((sub) => {
    if (sub[0] === 'rev-parse') return { stdout: `${root}\n${path.join(root, '.git')}\n.git\n` };
    if (sub[0] === 'config') return { stdout: PLAIN };
    return { code: 128, stderr: `the recorder: only the vetting was expected (${sub.join(' ')})` };
  });
}

/** Vets `root` with the recorder in place; answers the vetting and every git call it made. */
async function vetRecorded(root: string, inside: (p: string) => boolean) {
  const rec = answeringFor(root);
  try {
    return { vetting: await vetRepository(root, { insideScannedRoot: inside }), calls: rec.calls };
  } finally {
    rec.restore();
  }
}

const under = (...dirs: string[]) => (p: string): boolean => dirs.some((d) => p === d || p.startsWith(d + path.sep));

function alternates(root: string, text: string): void {
  fs.writeFileSync(path.join(root, '.git', 'objects', 'info', 'alternates'), text);
}

/* ══════════════════ objects/info/alternates (review #1) ══════════════════ */

test('an alternates line naming a folder outside every scan refuses the repository before git is started', async () => {
  const root = fakeRepo();
  const elsewhere = tmp('treemap-gitptr-elsewhere-');
  fs.mkdirSync(path.join(elsewhere, 'objects'));
  alternates(root, `${path.join(elsewhere, 'objects')}\n`);
  const { vetting, calls } = await vetRecorded(root, under(root));
  assert.equal(!vetting.ok && vetting.kind, 'refused', JSON.stringify(vetting));
  assert.match(!vetting.ok ? vetting.reason : '', /outside every folder you scanned/);
  assert.ok((!vetting.ok ? vetting.reason : '').includes(path.join(elsewhere, 'objects')), 'the borrowed folder is named');
  assert.deepEqual(calls, [], 'git was never started');
});

test('an alternates line naming a network share refuses the repository before git is started', async () => {
  for (const share of ['//fileserver/share/objects', '\\\\fileserver\\share\\objects']) {
    const root = fakeRepo();
    alternates(root, `# borrowed\n${share}\n`);
    const { vetting, calls } = await vetRecorded(root, () => true);
    assert.equal(!vetting.ok && vetting.kind, 'refused', `${share}: ${JSON.stringify(vetting)}`);
    assert.match(!vetting.ok ? vetting.reason : '', /network share/);
    assert.deepEqual(calls, [], `git was never started for ${share}`);
  }
});

test('a network share spelled with one separator of each kind is refused before anything is resolved', async () => {
  // FG4e, review L2: Windows reads `/\server\share` and `\/server/share` as UNC paths too, and
  // resolving one contacts the server. Any text that starts with two separators, of either kind,
  // is refused as it is written — through an alternates line, a .git file and a commondir.
  const promises = fs.promises as unknown as { realpath: (...args: unknown[]) => Promise<unknown> };
  const realpath = promises.realpath;
  const resolved: string[] = [];
  promises.realpath = async (...args: unknown[]) => {
    resolved.push(String(args[0]));
    return realpath.apply(fs.promises, args);
  };
  try {
    for (const share of ['/\\fileserver\\share\\objects', '\\/fileserver/share/objects']) {
      const viaAlternates = fakeRepo();
      alternates(viaAlternates, `${share}\n`);
      const viaGitFile = tmp('treemap-gitptr-unc-');
      fs.writeFileSync(path.join(viaGitFile, '.git'), `gitdir: ${share}\n`);
      const viaCommondir = tmp('treemap-gitptr-unc-common-');
      fs.mkdirSync(path.join(viaCommondir, '.git'));
      fs.writeFileSync(path.join(viaCommondir, '.git', 'commondir'), `${share}\n`);
      for (const [how, root] of [['alternates', viaAlternates], ['.git file', viaGitFile], ['commondir', viaCommondir]] as const) {
        const { vetting, calls } = await vetRecorded(root, () => true);
        assert.equal(!vetting.ok && vetting.kind, 'refused', `${how} ${share}: ${JSON.stringify(vetting)}`);
        assert.match(!vetting.ok ? vetting.reason : '', /network share/, `${how} ${share}`);
        assert.deepEqual(calls, [], `${how} ${share}: git was never started`);
      }
    }
  } finally {
    promises.realpath = realpath;
  }
  assert.deepEqual(resolved.filter((p) => p.includes('fileserver')), [], 'no spelling of the share was handed to the system to resolve');
});

test('a C-quoted alternates line is read as git reads it', async () => {
  const root = fakeRepo();
  const elsewhere = tmp('treemap-gitptr-quoted-');
  const odd = path.join(elsewhere, 'objects');
  fs.mkdirSync(odd);
  // Quoted as git quotes: backslashes escaped, and here the `j` as an octal escape (\152) — a name
  // Windows allows, unlike one holding a `"`.
  alternates(root, `"${odd.replace(/\\/g, '\\\\').replace('objects', 'ob\\152ects')}"\n`);
  const { vetting, calls } = await vetRecorded(root, under(root));
  assert.equal(!vetting.ok && vetting.kind, 'refused', JSON.stringify(vetting));
  assert.ok((!vetting.ok ? vetting.reason : '').includes(odd), `the unquoted folder is judged: ${!vetting.ok ? vetting.reason : ''}`);
  assert.deepEqual(calls, []);
});

test('comments and blank lines are skipped, and a relative line is read from the objects folder', async () => {
  const root = fakeRepo();
  // objects/../../shared/objects from <root>/.git/objects is <root>/shared/objects: inside the scan.
  fs.mkdirSync(path.join(root, 'shared', 'objects'), { recursive: true });
  alternates(root, '# a comment\n\n../../shared/objects\n');
  const inside = await vetRecorded(root, under(root));
  assert.equal(inside.vetting.ok, true, JSON.stringify(inside.vetting));
  assert.deepEqual(commandsOf(inside.calls), ['rev-parse', 'config'], 'a borrowed folder inside the scan goes on to the vetting');

  const outside = fakeRepo();
  const elsewhere = tmp('treemap-gitptr-rel-');
  fs.mkdirSync(path.join(elsewhere, 'objects'));
  alternates(outside, `${path.relative(path.join(outside, '.git', 'objects'), path.join(elsewhere, 'objects'))}\n`);
  const refused = await vetRecorded(outside, under(outside));
  assert.equal(!refused.vetting.ok && refused.vetting.kind, 'refused', 'a relative line leading out of the scan');
  assert.deepEqual(refused.calls, []);
});

test('an alternate folder\'s own alternates are followed, as git follows them', async () => {
  const root = fakeRepo();
  const lender = path.join(root, 'lender', 'objects');
  fs.mkdirSync(path.join(lender, 'info'), { recursive: true });
  const elsewhere = tmp('treemap-gitptr-deep-');
  fs.writeFileSync(path.join(lender, 'info', 'alternates'), `${elsewhere}\n`);
  alternates(root, `${lender}\n`);
  const { vetting, calls } = await vetRecorded(root, under(root));
  assert.equal(!vetting.ok && vetting.kind, 'refused', JSON.stringify(vetting));
  assert.ok((!vetting.ok ? vetting.reason : '').includes(elsewhere), 'the second-level folder is the one named');
  assert.deepEqual(calls, []);
});

test('the alternates of the common folder a linked worktree shares are read too', async () => {
  const root = tmp('treemap-gitptr-wt-');
  const common = path.join(root, 'main.git');
  const admin = path.join(common, 'worktrees', 'wt');
  fs.mkdirSync(admin, { recursive: true });
  fs.mkdirSync(path.join(common, 'objects', 'info'), { recursive: true });
  const work = path.join(root, 'wt');
  fs.mkdirSync(work);
  fs.writeFileSync(path.join(work, '.git'), `gitdir: ${admin}\n`);
  fs.writeFileSync(path.join(admin, 'commondir'), '../..\n');
  const elsewhere = tmp('treemap-gitptr-wt-elsewhere-');
  fs.writeFileSync(path.join(common, 'objects', 'info', 'alternates'), `${elsewhere}\n`);
  const rec = recordGit(() => ({ code: 128, stderr: 'the recorder: no git call was expected' }));
  try {
    const vetting = await vetRepository(work, { insideScannedRoot: under(root) });
    assert.equal(!vetting.ok && vetting.kind, 'refused', JSON.stringify(vetting));
    assert.ok((!vetting.ok ? vetting.reason : '').includes(elsewhere));
  } finally {
    rec.restore();
  }
  assert.deepEqual(rec.calls, []);
});

test('an alternates file that is a link is not followed: the repository is refused', async (t) => {
  const root = fakeRepo();
  const elsewhere = tmp('treemap-gitptr-altlink-');
  fs.writeFileSync(path.join(elsewhere, 'alternates'), '');
  try {
    fs.symlinkSync(path.join(elsewhere, 'alternates'), path.join(root, '.git', 'objects', 'info', 'alternates'), 'file');
  } catch {
    t.skip('this system cannot make a link here');
    return;
  }
  const { vetting, calls } = await vetRecorded(root, under(root));
  assert.equal(!vetting.ok && vetting.kind, 'refused', JSON.stringify(vetting));
  assert.deepEqual(calls, []);
});

test('real git: a repository borrowing objects from a folder the scan covers is read, and one outside is not', async () => {
  const dir = tmp('treemap-gitptr-real-');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...Object.fromEntries(Object.keys(process.env).filter((name) => /^GIT_/i.test(name)).map((name) => [name, undefined])),
    HOME: dir, XDG_CONFIG_HOME: dir, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(dir, 'none'),
  };
  const git = (cwd: string, args: string[]): string => execFileSync('git',
    ['-c', 'user.name=Test', '-c', 'user.email=t@example.invalid', '-c', 'init.defaultBranch=main', ...args],
    { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const lender = path.join(dir, 'lender');
  fs.mkdirSync(lender);
  git(lender, ['init', '-q']);
  fs.writeFileSync(path.join(lender, 'a.txt'), 'a');
  git(lender, ['add', '-A']);
  git(lender, ['commit', '-qm', 'init']);
  // `clone --shared` writes objects/info/alternates naming the lender's objects: an ordinary clone.
  git(dir, ['clone', '-q', '--shared', lender, 'borrower']);
  const borrower = path.join(dir, 'borrower');
  assert.ok(fs.existsSync(path.join(borrower, '.git', 'objects', 'info', 'alternates')), 'the clone borrows');

  const read = await readRepoState(borrower, { insideScannedRoot: under(dir) });
  assert.ok('kind' in read, `inside the scan it is read: ${JSON.stringify(read)}`);
  assert.equal((read as GitRecoverability).dirtyFiles, 0);
  const refused = await readRepoState(borrower, { insideScannedRoot: under(borrower) });
  assert.ok('unknown' in refused, JSON.stringify(refused));
  assert.ok(refused.unknown.includes(path.join(lender, '.git', 'objects')), refused.unknown);
});

/* ══════════════════ A link at the top of the git folder ══════════════════ */

test('a link at the top of the git folder is judged by where it leads', async (t) => {
  const root = fakeRepo();
  const elsewhere = tmp('treemap-gitptr-refs-');
  try {
    fs.symlinkSync(elsewhere, path.join(root, '.git', 'refs'), 'dir');
  } catch {
    t.skip('this system cannot make a link here');
    return;
  }
  const refused = await vetRecorded(root, under(root));
  assert.equal(!refused.vetting.ok && refused.vetting.kind, 'refused', JSON.stringify(refused.vetting));
  assert.ok((!refused.vetting.ok ? refused.vetting.reason : '').includes(elsewhere));
  assert.deepEqual(refused.calls, [], 'git was never started');

  const read = await vetRecorded(root, under(root, elsewhere));
  assert.equal(read.vetting.ok, true, `the same link into a scanned folder goes on: ${JSON.stringify(read.vetting)}`);
});

/* ══════════════════ A pointer's `..` after its links (review #2) ══════════════════ */

/** `<root>/a` a link to `<outside>/sub`, and `<outside>/b` a folder: `a/../b` leads to `<outside>/b`. */
function linkThenDotDot(t: { skip: (m: string) => void }): { root: string; outside: string } | null {
  const root = tmp('treemap-gitptr-dotdot-');
  const outside = tmp('treemap-gitptr-dotdot-out-');
  fs.mkdirSync(path.join(outside, 'sub'));
  fs.mkdirSync(path.join(outside, 'b'));
  try {
    fs.symlinkSync(path.join(outside, 'sub'), path.join(root, 'a'), 'dir');
  } catch {
    t.skip('this system cannot make a link here');
    return null;
  }
  return { root, outside };
}

test('a .git file naming `link/../x` is judged where the link leads, before git is started', async (t) => {
  // Windows resolves `..` in the text before it follows a link, as path.resolve does, so there
  // the pointer does lead inside the folder; the check is of the POSIX order.
  if (process.platform === 'win32') { t.skip('Windows applies .. before links'); return; }
  const layout = linkThenDotDot(t);
  if (!layout) return;
  const { root, outside } = layout;
  fs.writeFileSync(path.join(root, '.git'), 'gitdir: a/../b\n');
  const rec = recordGit(() => ({ code: 128, stderr: 'the recorder: no git call was expected' }));
  try {
    const vetting = await vetRepository(root, { insideScannedRoot: under(root) });
    assert.equal(!vetting.ok && vetting.kind, 'refused', JSON.stringify(vetting));
    assert.ok((!vetting.ok ? vetting.reason : '').includes(path.join(outside, 'b')), `where the OS goes: ${!vetting.ok ? vetting.reason : ''}`);
  } finally {
    rec.restore();
  }
  assert.deepEqual(rec.calls, [], 'refused by TreeMap before git, not by git\'s own answer after it');
});

test('a commondir naming `link/../x` is judged where the link leads, before git is started', async (t) => {
  if (process.platform === 'win32') { t.skip('Windows applies .. before links'); return; }
  const root = tmp('treemap-gitptr-cdotdot-');
  const outside = tmp('treemap-gitptr-cdotdot-out-');
  fs.mkdirSync(path.join(outside, 'sub'));
  fs.mkdirSync(path.join(outside, 'b'));
  fs.mkdirSync(path.join(root, '.git'));
  try {
    fs.symlinkSync(path.join(outside, 'sub'), path.join(root, '.git', 'a'), 'dir');
  } catch {
    t.skip('this system cannot make a link here');
    return;
  }
  fs.writeFileSync(path.join(root, '.git', 'commondir'), 'a/../b\n');
  const rec = recordGit(() => ({ code: 128, stderr: 'the recorder: no git call was expected' }));
  try {
    const vetting = await vetRepository(root, { insideScannedRoot: under(root) });
    assert.equal(!vetting.ok && vetting.kind, 'refused', JSON.stringify(vetting));
    assert.ok((!vetting.ok ? vetting.reason : '').includes(outside), !vetting.ok ? vetting.reason : '');
  } finally {
    rec.restore();
  }
  assert.deepEqual(rec.calls, []);
});

test('a pointer naming nothing that is there is refused, not judged by its spelling', async () => {
  const root = tmp('treemap-gitptr-gone-');
  fs.writeFileSync(path.join(root, '.git'), 'gitdir: no-such-folder\n');
  const rec = recordGit(() => ({ code: 128, stderr: 'the recorder: no git call was expected' }));
  try {
    const vetting = await vetRepository(root, { insideScannedRoot: under(root) });
    assert.equal(!vetting.ok && vetting.kind, 'refused', JSON.stringify(vetting));
    assert.match(!vetting.ok ? vetting.reason : '', /not there/);
  } finally {
    rec.restore();
  }
  assert.deepEqual(rec.calls, []);
});

/* ══════════════════ Pointers that name nothing git could use (review #18) ══════════════════ */

test('a .git file with no gitdir line, or an empty one, is refused before git is started', async () => {
  for (const text of ['', 'gitdir:\n', 'not a pointer\n']) {
    const root = tmp('treemap-gitptr-empty-');
    fs.writeFileSync(path.join(root, '.git'), text);
    const rec = recordGit(() => ({ code: 128, stderr: 'the recorder: no git call was expected' }));
    try {
      const vetting = await vetRepository(root, { insideScannedRoot: () => true });
      assert.equal(!vetting.ok && vetting.kind, 'refused', `${JSON.stringify(text)}: ${JSON.stringify(vetting)}`);
      assert.match(!vetting.ok ? vetting.reason : '', /does not name a git folder/);
    } finally {
      rec.restore();
    }
    assert.deepEqual(rec.calls, [], JSON.stringify(text));
  }
});

test('a commondir that is empty, a folder or a link is refused before git is started', async (t) => {
  const cases: Array<[string, (file: string) => void]> = [
    ['empty', (file) => fs.writeFileSync(file, '')],
    ['a folder', (file) => fs.mkdirSync(file)],
  ];
  const probe = tmp('treemap-gitptr-probe-');
  let links = true;
  try {
    fs.symlinkSync(path.join(probe, 'x'), path.join(probe, 'l'), 'file');
  } catch {
    links = false;
  }
  if (links) cases.push(['a link', (file) => fs.symlinkSync(path.join(probe, 'target'), file, 'file')]);
  else t.diagnostic('this system cannot make a link here: the link case is not run');
  fs.writeFileSync(path.join(probe, 'target'), `${probe}\n`);
  for (const [what, make] of cases) {
    const root = tmp('treemap-gitptr-common-');
    fs.mkdirSync(path.join(root, '.git'));
    make(path.join(root, '.git', 'commondir'));
    const rec = recordGit(() => ({ code: 128, stderr: 'the recorder: no git call was expected' }));
    try {
      const vetting = await vetRepository(root, { insideScannedRoot: () => true });
      assert.equal(!vetting.ok && vetting.kind, 'refused', `${what}: ${JSON.stringify(vetting)}`);
    } finally {
      rec.restore();
    }
    assert.deepEqual(rec.calls, [], what);
  }
});

test('a .git that is neither a file, a folder nor a link is refused before git is started', { skip: process.platform === 'win32' }, async () => {
  const root = tmp('treemap-gitptr-sock-');
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(path.join(root, '.git'), resolve));
  const rec = recordGit(() => ({ code: 128, stderr: 'the recorder: no git call was expected' }));
  try {
    const vetting = await vetRepository(root, { insideScannedRoot: () => true });
    assert.equal(!vetting.ok && vetting.kind, 'refused', JSON.stringify(vetting));
    assert.match(!vetting.ok ? vetting.reason : '', /not a file or folder/);
  } finally {
    rec.restore();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  assert.deepEqual(rec.calls, []);
});

/* ══════════════════ An alternates file that is not a plain file, on every platform (FG4d, review #10) ══════════════════ */

/**
 * Opens as Windows opens: there is no `O_NOFOLLOW` there, and `open` follows a link. Every path
 * opened while `run` runs is recorded, and each open is made with that flag taken away — so what
 * refuses a link here is what refuses it on Windows, and a link opened at all shows as a record.
 */
async function openingAsWindowsDoes<T>(run: () => Promise<T>): Promise<{ result: T; opened: string[] }> {
  const promises = fs.promises as unknown as { open: (...args: unknown[]) => Promise<unknown> };
  const open = promises.open;
  const opened: string[] = [];
  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  promises.open = async (file: unknown, flags: unknown, ...rest: unknown[]) => {
    opened.push(String(file));
    return open.call(fs.promises, file, typeof flags === 'number' ? flags & ~noFollow : flags, ...rest);
  };
  try {
    return { result: await run(), opened };
  } finally {
    promises.open = open;
  }
}

test('an alternates file that is a link is refused by what it is, before it is opened — as on Windows, where open follows a link', async (t) => {
  const root = fakeRepo();
  const elsewhere = tmp('treemap-gitptr-altlink-win-');
  // An empty plain file where the link leads: followed, it would read as "borrows nothing".
  fs.writeFileSync(path.join(elsewhere, 'alternates'), '');
  const file = path.join(root, '.git', 'objects', 'info', 'alternates');
  try {
    fs.symlinkSync(path.join(elsewhere, 'alternates'), file, 'file');
  } catch {
    t.skip('this system cannot make a link here');
    return;
  }
  const { result, opened } = await openingAsWindowsDoes(() => vetRecorded(root, under(root)));
  assert.equal(!result.vetting.ok && result.vetting.kind, 'refused', JSON.stringify(result.vetting));
  assert.match(!result.vetting.ok ? result.vetting.reason : '', /not a plain file/);
  assert.deepEqual(opened.filter((p) => p === file), [], 'the link was never opened');
  assert.deepEqual(result.calls, [], 'git was never started');
});

test('an alternates file that is a pipe is refused before it is opened', { skip: process.platform === 'win32' }, async () => {
  const root = fakeRepo();
  const file = path.join(root, '.git', 'objects', 'info', 'alternates');
  execFileSync('mkfifo', [file], { env: process.env });
  const { result, opened } = await openingAsWindowsDoes(() => vetRecorded(root, () => true));
  assert.equal(!result.vetting.ok && result.vetting.kind, 'refused', JSON.stringify(result.vetting));
  assert.match(!result.vetting.ok ? result.vetting.reason : '', /not a plain file/);
  assert.deepEqual(opened.filter((p) => p === file), [], 'the pipe was never opened');
  assert.deepEqual(result.calls, []);
});

/* ══════════════════ The bounds and the guards of the read-ahead (FG4d, review #12) ══════════════════ */

test('alternates borrowed more than five folders deep refuse the repository', async () => {
  const root = fakeRepo();
  // objects → l1 → l2 → l3 → l4 → l5 → l6, every one inside the scan: git stops following at five.
  const lenders = [1, 2, 3, 4, 5, 6].map((n) => path.join(root, `l${String(n)}`));
  for (const lender of lenders) fs.mkdirSync(path.join(lender, 'info'), { recursive: true });
  alternates(root, `${lenders[0]}\n`);
  for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(lenders[i], 'info', 'alternates'), `${lenders[i + 1]}\n`);
  const { vetting, calls } = await vetRecorded(root, under(root));
  assert.equal(!vetting.ok && vetting.kind, 'refused', JSON.stringify(vetting));
  assert.match(!vetting.ok ? vetting.reason : '', /more than 5 folders deep/);
  assert.deepEqual(calls, []);
});

test('an alternates file longer than 64 KiB is not read, and refuses the repository', async () => {
  const root = fakeRepo();
  alternates(root, `${'#'.repeat(1023)}\n`.repeat(64) + '#\n');
  const { vetting, calls } = await vetRecorded(root, under(root));
  assert.equal(!vetting.ok && vetting.kind, 'refused', JSON.stringify(vetting));
  assert.match(!vetting.ok ? vetting.reason : '', /too long/);
  assert.deepEqual(calls, []);
});

test('text after a quoted alternates line, which git reads as a second entry, refuses the repository', async () => {
  const root = fakeRepo();
  const inside = path.join(root, 'shared', 'objects');
  fs.mkdirSync(inside, { recursive: true });
  const outside = tmp('treemap-gitptr-trailing-');
  alternates(root, `"${inside.replace(/\\/g, '\\\\')}" ${outside}\n`);
  const { vetting, calls } = await vetRecorded(root, under(root));
  assert.equal(!vetting.ok && vetting.kind, 'refused', JSON.stringify(vetting));
  assert.match(!vetting.ok ? vetting.reason : '', /cannot read as Git does/);
  assert.deepEqual(calls, []);
});

test('a git folder with more than 10,000 entries at its top is not looked through, and refuses the repository', async () => {
  const root = fakeRepo();
  const dir = path.join(root, '.git');
  for (let i = 0; i < 10_000; i++) fs.writeFileSync(path.join(dir, `e${String(i)}`), '');
  const { vetting, calls } = await vetRecorded(root, under(root));
  assert.equal(!vetting.ok && vetting.kind, 'refused', JSON.stringify(vetting));
  assert.match(!vetting.ok ? vetting.reason : '', /too many entries/);
  assert.deepEqual(calls, []);
});

test('a link at the top of the common folder a linked worktree shares is judged too', async (t) => {
  const root = tmp('treemap-gitptr-wtlink-');
  const common = path.join(root, 'main.git');
  const admin = path.join(common, 'worktrees', 'wt');
  fs.mkdirSync(admin, { recursive: true });
  fs.mkdirSync(path.join(common, 'objects', 'info'), { recursive: true });
  const work = path.join(root, 'wt');
  fs.mkdirSync(work);
  fs.writeFileSync(path.join(work, '.git'), `gitdir: ${admin}\n`);
  fs.writeFileSync(path.join(admin, 'commondir'), '../..\n');
  const elsewhere = tmp('treemap-gitptr-wtlink-elsewhere-');
  try {
    fs.symlinkSync(elsewhere, path.join(common, 'refs'), 'dir');
  } catch {
    t.skip('this system cannot make a link here');
    return;
  }
  const rec = recordGit(() => ({ code: 128, stderr: 'the recorder: no git call was expected' }));
  try {
    const vetting = await vetRepository(work, { insideScannedRoot: under(root) });
    assert.equal(!vetting.ok && vetting.kind, 'refused', JSON.stringify(vetting));
    assert.ok((!vetting.ok ? vetting.reason : '').includes(elsewhere), !vetting.ok ? vetting.reason : '');
  } finally {
    rec.restore();
  }
  assert.deepEqual(rec.calls, []);
});

/* ══════════════════ A pointer file read exactly as git reads it (FG4d, review #1) ══════════════════ */

/**
 * Git keeps everything after `gitdir: ` in a `.git` file, and everything in a `commondir`, but for
 * the trailing CR and LF: a leading or trailing space and a later line are part of the path. Each
 * layout holds a clean folder under the trimmed name and, under the name git reads, one that
 * borrows objects from outside every scan — TreeMap must judge the second.
 */
function decoyAndReal(parent: string, gitName: string): string {
  fs.mkdirSync(path.join(parent, gitName.trim().split('\n')[0], 'objects', 'info'), { recursive: true });
  const read = path.join(parent, gitName);
  fs.mkdirSync(path.join(read, 'objects', 'info'), { recursive: true });
  const outside = tmp('treemap-gitptr-exact-out-');
  fs.writeFileSync(path.join(read, 'objects', 'info', 'alternates'), `${outside}\n`);
  return outside;
}

async function vetNoGit(root: string, inside: (p: string) => boolean) {
  const rec = recordGit(() => ({ code: 128, stderr: 'the recorder: no git call was expected' }));
  try {
    return { vetting: await vetRepository(root, { insideScannedRoot: inside }), calls: rec.calls };
  } finally {
    rec.restore();
  }
}

test('a .git file is read as git reads it: leading and trailing spaces and later lines are part of the path', async () => {
  // A name that ends in a space, or holds a newline, is not one Windows can make.
  const names = process.platform === 'win32' ? [' real'] : [' real', 'real ', 'real\nsecond'];
  for (const name of names) {
    const root = tmp('treemap-gitptr-exact-');
    const outside = decoyAndReal(root, name);
    fs.writeFileSync(path.join(root, '.git'), `gitdir: ${name}\r\n`);
    const { vetting, calls } = await vetNoGit(root, under(root));
    assert.equal(!vetting.ok && vetting.kind, 'refused', `${JSON.stringify(name)}: ${JSON.stringify(vetting)}`);
    assert.ok((!vetting.ok ? vetting.reason : '').includes(outside), `${JSON.stringify(name)}: the folder git reads is judged`);
    assert.deepEqual(calls, [], JSON.stringify(name));
  }
});

test('a commondir is read as git reads it: leading spaces and later lines are part of the path', async () => {
  const names = process.platform === 'win32' ? [' other'] : [' other', 'other\nmore'];
  for (const name of names) {
    const root = tmp('treemap-gitptr-exactc-');
    fs.mkdirSync(path.join(root, '.git', 'objects', 'info'), { recursive: true });
    const outside = decoyAndReal(path.join(root, '.git'), name);
    fs.writeFileSync(path.join(root, '.git', 'commondir'), `${name}\n`);
    const { vetting, calls } = await vetNoGit(root, under(root));
    assert.equal(!vetting.ok && vetting.kind, 'refused', `${JSON.stringify(name)}: ${JSON.stringify(vetting)}`);
    assert.ok((!vetting.ok ? vetting.reason : '').includes(outside), `${JSON.stringify(name)}: the folder git reads is judged`);
    assert.deepEqual(calls, [], JSON.stringify(name));
  }
});

test('a .git file needs git\'s own `gitdir: ` prefix, space included', async () => {
  const root = tmp('treemap-gitptr-prefix-');
  fs.mkdirSync(path.join(root, 'real'));
  fs.writeFileSync(path.join(root, '.git'), 'gitdir:real\n');
  const { vetting, calls } = await vetNoGit(root, () => true);
  assert.equal(!vetting.ok && vetting.kind, 'refused', JSON.stringify(vetting));
  assert.match(!vetting.ok ? vetting.reason : '', /does not name a git folder/);
  assert.deepEqual(calls, []);
});

test('where git says it works must be the folder TreeMap read ahead, or git goes no further', async () => {
  const root = fakeRepo();
  // Inside the scan, and not the .git TreeMap read: git's answer is not what was vetted.
  const other = path.join(root, 'other.git');
  fs.mkdirSync(other);
  const rec = recordGit((sub) => {
    if (sub[0] === 'rev-parse') return { stdout: `${root}\n${other}\n${other}\n` };
    if (sub[0] === 'config') return { stdout: PLAIN };
    return { code: 128, stderr: `the recorder: only the vetting was expected (${sub.join(' ')})` };
  });
  let vetting;
  try {
    vetting = await vetRepository(root, { insideScannedRoot: under(root) });
  } finally {
    rec.restore();
  }
  assert.equal(!vetting.ok && vetting.kind, 'refused', JSON.stringify(vetting));
  assert.ok((!vetting.ok ? vetting.reason : '').includes(other), !vetting.ok ? vetting.reason : '');
  assert.deepEqual(commandsOf(rec.calls), ['rev-parse'], 'asked where it works, and nothing after');
});

/* ══════════════════ Names read byte for byte (FG4d, review #2) ══════════════════ */

test('a quoted alternates line holding a character outside the BMP names the folder git reads, not a lookalike', async (t) => {
  const root = fakeRepo();
  const objects = path.join(root, '.git', 'objects');
  const outside = tmp('treemap-gitptr-emoji-');
  try {
    fs.symlinkSync(outside, path.join(objects, '\u{1F600}'), 'dir');
  } catch {
    t.skip('this system cannot make a link here');
    return;
  }
  // The name a code-unit-at-a-time decoding makes of it: two replacement characters, inside the scan.
  fs.mkdirSync(path.join(objects, '��'));
  alternates(root, '"\u{1F600}"\n');
  const { vetting, calls } = await vetRecorded(root, under(root));
  assert.equal(!vetting.ok && vetting.kind, 'refused', JSON.stringify(vetting));
  assert.ok((!vetting.ok ? vetting.reason : '').includes(outside), `the link git follows is judged: ${!vetting.ok ? vetting.reason : ''}`);
  assert.deepEqual(calls, []);
});

test('bytes that are not UTF-8, in an alternates line or its quoted escapes, refuse the repository rather than name a lookalike', async () => {
  const cases: Array<[string, Buffer]> = [
    ['a raw byte', Buffer.concat([Buffer.from('lookalike-'), Buffer.from([0xff]), Buffer.from('\n')])],
    ['an escaped byte', Buffer.from('"lookalike-\\377"\n')],
  ];
  for (const [what, text] of cases) {
    const root = fakeRepo();
    // What a lossy decoding makes of either: a folder inside the scan.
    fs.mkdirSync(path.join(root, '.git', 'objects', 'lookalike-�'));
    fs.writeFileSync(path.join(root, '.git', 'objects', 'info', 'alternates'), text);
    const { vetting, calls } = await vetRecorded(root, under(root));
    assert.equal(!vetting.ok && vetting.kind, 'refused', `${what}: ${JSON.stringify(vetting)}`);
    assert.match(!vetting.ok ? vetting.reason : '', /cannot read exactly/, what);
    assert.deepEqual(calls, [], what);
  }
});

test('a .git file whose path is not UTF-8 refuses the repository rather than name a lookalike', async () => {
  const root = tmp('treemap-gitptr-bytes-');
  fs.mkdirSync(path.join(root, 'lookalike-�', 'objects', 'info'), { recursive: true });
  fs.writeFileSync(path.join(root, '.git'), Buffer.concat([Buffer.from('gitdir: lookalike-'), Buffer.from([0xff]), Buffer.from('\n')]));
  const { vetting, calls } = await vetNoGit(root, under(root));
  assert.equal(!vetting.ok && vetting.kind, 'refused', JSON.stringify(vetting));
  assert.match(!vetting.ok ? vetting.reason : '', /cannot read exactly/);
  assert.deepEqual(calls, []);
});

test('a byte-order mark at the start of an alternates file is part of the first path, as git reads it', async (t) => {
  const root = fakeRepo();
  const objects = path.join(root, '.git', 'objects');
  const outside = tmp('treemap-gitptr-bom-');
  try {
    fs.symlinkSync(outside, path.join(objects, '﻿lender'), 'dir');
  } catch {
    t.skip('this system cannot make a link here');
    return;
  }
  // What a decoder that drops the mark would judge instead: a plain folder inside the scan.
  fs.mkdirSync(path.join(objects, 'lender'));
  alternates(root, '﻿lender\n');
  const { vetting, calls } = await vetRecorded(root, under(root));
  assert.equal(!vetting.ok && vetting.kind, 'refused', JSON.stringify(vetting));
  assert.ok((!vetting.ok ? vetting.reason : '').includes(outside), !vetting.ok ? vetting.reason : '');
  assert.deepEqual(calls, []);
});
