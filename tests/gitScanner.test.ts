import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';

import { fileTempDir, isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-gitScanner-data-');

import { GIT_HARDENING, gitEnvironment } from '../src/services/gitSafe';
import { runGitGc, setGitGcStepForTests, type GitGcPlan } from '../src/services/gitScanner';
import { createScanRecord } from '../src/services/diskScanner';
import { createApp } from '../src/server';
import { readAudit } from '../src/services/audit';
import { commandsOf, recordGit } from './fixtures/gitRecorder';
import { listAsWindowsNode20 } from './fixtures/windowsListing';

/**
 * FG4 — `git gc` runs only on a repository whose data is really where it looks, and keeps what
 * a person could still want back.
 *
 * The gc itself never runs here: setGitGcStepForTests stands in for it and records the plan it
 * was handed (argv, environment, the git dir). Real git runs only the vetting's two reads, on a
 * plain repository made here, and on layouts that redirect git elsewhere — a `.git` file, a
 * `commondir`, a linked `.git` — which run nothing whatever git makes of them. A repository whose
 * settings are refused is scripted through the recorder, as text.
 */

/**
 * A new folder, spelled as runGitGc resolves it: by the native realpath, which on the Windows
 * runner expands the 8.3 `RUNNER~1` of its temp folder that the JS realpath keeps (FG4c).
 */
function tmp(prefix: string): string {
  return fs.realpathSync.native(fileTempDir(prefix));
}

/**
 * Git for building fixtures, from this process's environment (so it carries the test runner's
 * guard, childEnvCarriesGuard.test.ts) with every GIT_* variable taken out and no system or
 * global settings.
 */
const FIXTURE_HOME = tmp('treemap-gitgc-fixture-home-');
const FIXTURE_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  ...Object.fromEntries(Object.keys(process.env).filter((name) => /^GIT_/i.test(name)).map((name) => [name, undefined])),
  HOME: FIXTURE_HOME, XDG_CONFIG_HOME: FIXTURE_HOME, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(FIXTURE_HOME, 'none'),
};
function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=t@example.invalid', '-c', 'init.defaultBranch=main', ...args],
    { cwd, env: FIXTURE_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** A scanned folder holding a plain repository with a loose object — what the UI offers gc for. */
function scannedRepo(): { root: string; repo: string } {
  const root = tmp('treemap-gitgc-');
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  git(repo, ['init', '-q']);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-qm', 'init']);
  createScanRecord(root);
  return { root, repo };
}

/** Runs runGitGc with the gc step stood in for, answering what it was handed. */
async function gcWithStandIn(repo: string): Promise<{ result: Awaited<ReturnType<typeof runGitGc>>; plans: GitGcPlan[] }> {
  const plans: GitGcPlan[] = [];
  setGitGcStepForTests(async (plan) => {
    plans.push(plan);
    return { stdout: 'packed', stderr: '' };
  });
  try {
    return { result: await runGitGc(repo), plans };
  } finally {
    setGitGcStepForTests(null);
  }
}

test('gc on a plain repository: hardened, told its git dir, and pruning only what has been gone two weeks', async () => {
  const { repo } = scannedRepo();
  const { result, plans } = await gcWithStandIn(repo);
  assert.deepEqual(result, { ok: true, output: 'packed' });
  assert.equal(plans.length, 1);
  const [plan] = plans;
  const gitDir = fs.realpathSync.native(path.join(repo, '.git'));
  assert.equal(plan.gitDir, gitDir);
  assert.deepEqual([...plan.invocation.args], [...GIT_HARDENING, '-C', repo, `--git-dir=${gitDir}`, 'gc', '--aggressive', '--prune=2.weeks.ago']);
  assert.deepEqual(plan.invocation.env, gitEnvironment(), 'the environment from scratch');
  assert.ok(!plan.invocation.args.some((a) => a === '--prune=now'), 'nothing unreachable is dropped the moment it became so');
  const ui = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'app', '220-clean-up-modal.js'), 'utf8');
  // The confirm says what gc deletes for good, and only what --prune=2.weeks.ago removes: recently dropped work survives (hunt C35).
  assert.match(ui, /permanently deletes what no branch, tag or recent reflog entry still points to and is more than two weeks old/, 'the promise the confirm makes, which --prune=2.weeks.ago keeps');
});

test('a .git FILE (a pointer to a git dir elsewhere) is refused before git is asked anything', async () => {
  const { root } = scannedRepo();
  const elsewhere = tmp('treemap-gitgc-victim-');
  git(elsewhere, ['init', '-q']);
  const planted = path.join(root, 'planted');
  fs.mkdirSync(planted);
  fs.writeFileSync(path.join(planted, '.git'), `gitdir: ${path.join(elsewhere, '.git')}\n`);
  const rec = recordGit(() => ({ code: 128, stderr: 'the recorder: no git call was expected' }));
  let outcome;
  try {
    outcome = await gcWithStandIn(planted);
  } finally {
    rec.restore();
  }
  assert.equal(outcome.result.ok, false);
  assert.match(outcome.result.error ?? '', /\.git is a file/);
  assert.deepEqual(outcome.plans, [], 'gc was never started');
  assert.deepEqual(rec.calls, [], 'nor git asked anything');
});

test('a .git that is a link is refused', async (t) => {
  const { root } = scannedRepo();
  const elsewhere = tmp('treemap-gitgc-victim-');
  git(elsewhere, ['init', '-q']);
  const planted = path.join(root, 'planted');
  fs.mkdirSync(planted);
  try {
    fs.symlinkSync(path.join(elsewhere, '.git'), path.join(planted, '.git'), 'dir');
  } catch {
    t.skip('this system cannot make a link here');
    return;
  }
  const { result, plans } = await gcWithStandIn(planted);
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /\.git is a link/);
  assert.deepEqual(plans, []);
});

test('a .git folder that shares another repository\'s objects (commondir) is refused', async () => {
  const { root } = scannedRepo();
  const elsewhere = tmp('treemap-gitgc-victim-');
  git(elsewhere, ['init', '-q']);
  const planted = path.join(root, 'planted');
  fs.mkdirSync(path.join(planted, '.git'), { recursive: true });
  fs.writeFileSync(path.join(planted, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  fs.writeFileSync(path.join(planted, '.git', 'commondir'), `${path.join(elsewhere, '.git')}\n`);
  const { result, plans } = await gcWithStandIn(planted);
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /commondir/);
  assert.deepEqual(plans, []);
});

test('a link anywhere inside .git is refused, naming it', async (t) => {
  const { repo } = scannedRepo();
  const elsewhere = tmp('treemap-gitgc-elsewhere-');
  const link = path.join(repo, '.git', 'objects', 'pack-elsewhere');
  try {
    fs.symlinkSync(elsewhere, link, 'dir');
  } catch {
    t.skip('this system cannot make a link here');
    return;
  }
  const { result, plans } = await gcWithStandIn(repo);
  assert.equal(result.ok, false);
  assert.ok((result.error ?? '').includes('pack-elsewhere'), result.error);
  assert.deepEqual(plans, []);
});

test('a link anywhere inside .git that the listing reads as a folder — Windows under Node 20, whose libuv types a link to a folder and a junction as folders — is refused, naming it', async (t) => {
  const { repo } = scannedRepo();
  const elsewhere = tmp('treemap-gitgc-winlist-');
  const link = path.join(repo, '.git', 'objects', 'pack-elsewhere');
  try {
    fs.symlinkSync(elsewhere, link, 'dir');
  } catch {
    t.skip('this system cannot make a link here');
    return;
  }
  const listing = listAsWindowsNode20();
  let outcome: Awaited<ReturnType<typeof gcWithStandIn>>;
  try {
    outcome = await gcWithStandIn(repo);
  } finally {
    listing.restore();
  }
  assert.equal(outcome.result.ok, false, 'gc was not run through the link');
  assert.ok((outcome.result.error ?? '').includes('pack-elsewhere'), outcome.result.error);
  assert.deepEqual(outcome.plans, []);
});

test('a repository whose settings are refused is never gc\'d, and git only read it', async () => {
  const { repo } = scannedRepo();
  const listing = 'file:.git/config\0core.bare\nfalse\0file:.git/config\0gc.recentobjectshook\nsome-program\0';
  const rec = recordGit((sub) => {
    if (sub[0] === 'rev-parse') return { stdout: `${repo}\n${fs.realpathSync.native(path.join(repo, '.git'))}\n.git\n` };
    if (sub[0] === 'config') return { stdout: listing };
    return { code: 128, stderr: 'unscripted' };
  });
  let outcome;
  try {
    outcome = await gcWithStandIn(repo);
  } finally {
    rec.restore();
  }
  assert.equal(outcome.result.ok, false);
  assert.match(outcome.result.error ?? '', /gc\.recentobjectshook/);
  assert.deepEqual(outcome.plans, []);
  assert.deepEqual(commandsOf(rec.calls), ['rev-parse', 'config']);
});

test('a repository outside every scanned folder is refused, as before', async () => {
  const lone = tmp('treemap-gitgc-unscanned-');
  const { result, plans } = await gcWithStandIn(lone);
  assert.deepEqual(result, { ok: false, error: 'Repository is outside every scanned root' });
  assert.deepEqual(plans, []);
});

test('over HTTP a refused gc answers why and is audited as refused, a gc that ran as ok', async () => {
  const { root, repo } = scannedRepo();
  const planted = path.join(root, 'planted');
  fs.mkdirSync(planted);
  fs.writeFileSync(path.join(planted, '.git'), 'gitdir: /nowhere/.git\n');
  const server = http.createServer(createApp(path.join(__dirname, '..', 'public')));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const post = async (p: string) => {
    const res = await fetch(`http://127.0.0.1:${String(port)}/api/git/gc`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: p, confirm: true }),
    });
    return { status: res.status, body: (await res.json()) as { ok: boolean; error?: string } };
  };
  setGitGcStepForTests(async () => ({ stdout: 'packed', stderr: '' }));
  try {
    const refusedGc = await post(planted);
    assert.equal(refusedGc.status, 200);
    assert.equal(refusedGc.body.ok, false);
    assert.match(refusedGc.body.error ?? '', /\.git is a file/);
    const [refusedEntry] = await readAudit(1);
    assert.equal(refusedEntry.action, 'git.gc');
    assert.equal(refusedEntry.outcome, 'refused', 'a gc refused by its checks is not recorded as done');

    const ran = await post(repo);
    assert.deepEqual(ran.body, { ok: true, output: 'packed' });
    const [ranEntry] = await readAudit(1);
    assert.equal(ranEntry.outcome, 'ok');
  } finally {
    setGitGcStepForTests(null);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('a repository folder that is a link is judged where it really is', async (t) => {
  const { root } = scannedRepo();
  const outside = tmp('treemap-gitgc-outside-');
  git(outside, ['init', '-q']);
  const viaLink = path.join(root, 'x');
  try {
    fs.symlinkSync(outside, viaLink, 'dir');
  } catch {
    t.skip('this system cannot make a link here');
    return;
  }
  const refusedGc = await gcWithStandIn(viaLink);
  assert.equal(refusedGc.result.ok, false);
  assert.match(refusedGc.result.error ?? '', /outside every scanned folder/);
  assert.deepEqual(refusedGc.plans, [], 'gc never reached a repository outside every scan through a link');

  const inside = path.join(root, 'repo');
  const alias = path.join(root, 'alias');
  fs.symlinkSync(inside, alias, 'dir');
  const ran = await gcWithStandIn(alias);
  assert.deepEqual(ran.result, { ok: true, output: 'packed' });
  assert.equal(ran.plans[0].invocation.args[GIT_HARDENING.length + 1], inside, 'gc runs in the real folder');
});

test('a gc that git ran and failed is audited as an error, not as refused or done', async () => {
  const { repo } = scannedRepo();
  const server = http.createServer(createApp(path.join(__dirname, '..', 'public')));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  setGitGcStepForTests(async () => { throw new Error('fatal: gc failed half way'); });
  try {
    const res = await fetch(`http://127.0.0.1:${String(port)}/api/git/gc`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: repo, confirm: true }),
    });
    const body = (await res.json()) as { ok: boolean; error?: string; refused?: boolean };
    assert.equal(body.ok, false);
    assert.equal(body.refused, undefined);
    const [entry] = await readAudit(1);
    assert.equal(entry.outcome, 'error');
  } finally {
    setGitGcStepForTests(null);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

/* ══════════════════ The gc-only checks, each shown to refuse (review #10) ══════════════════ */

test('a special file anywhere inside .git is refused, naming it', { skip: process.platform === 'win32' }, async () => {
  const { repo } = scannedRepo();
  const special = path.join(repo, '.git', 'objects', 's');
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(special, resolve));
  try {
    const { result, plans } = await gcWithStandIn(repo);
    assert.equal(result.ok, false);
    assert.ok((result.error ?? '').includes(special), result.error);
    assert.match(result.error ?? '', /link or special file/);
    assert.deepEqual(plans, []);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('git reporting the repository\'s common data anywhere but its own .git is refused, even inside a scan', async () => {
  // gc would prune that folder for every repository sharing it. Since FG4d the vetting refuses this
  // first, as soon as git answers: where git says it works must be the folders TreeMap read ahead
  // (review #1), and this .git names no common folder. gc's own check behind it refuses the same.
  const { root, repo } = scannedRepo();
  const shared = path.join(root, 'shared.git');
  fs.mkdirSync(shared);
  const gitDir = fs.realpathSync.native(path.join(repo, '.git'));
  const rec = recordGit((sub) => {
    if (sub[0] === 'rev-parse') return { stdout: `${repo}\n${gitDir}\n${shared}\n` };
    if (sub[0] === 'config') return { stdout: 'file:.git/config\0core.bare\nfalse\0' };
    return { code: 128, stderr: 'unscripted' };
  });
  let outcome;
  try {
    outcome = await gcWithStandIn(repo);
  } finally {
    rec.restore();
  }
  assert.equal(outcome.result.ok, false);
  assert.equal(outcome.result.refused, true);
  assert.ok((outcome.result.error ?? '').includes(shared), outcome.result.error);
  assert.deepEqual(outcome.plans, []);
  assert.deepEqual(commandsOf(rec.calls), ['rev-parse'], 'git was asked where it works, and nothing after');
});

test('a repository that borrows objects from another (objects/info/alternates) is not gc\'d', async () => {
  // gc repacks only its own objects (`repack -l`) and drops local copies the other repository also
  // holds, so afterwards more of its history lives only there (FG4c, review #1). The folder named
  // is a plain one inside the scan: the vetting reads it; gc's own check refuses.
  const { root, repo } = scannedRepo();
  const lender = path.join(root, 'lender-objects');
  fs.mkdirSync(lender);
  fs.writeFileSync(path.join(repo, '.git', 'objects', 'info', 'alternates'), `${lender}\n`);
  const { result, plans } = await gcWithStandIn(repo);
  assert.equal(result.ok, false);
  assert.equal(result.refused, true);
  assert.match(result.error ?? '', /borrows objects/);
  assert.deepEqual(plans, []);
});
