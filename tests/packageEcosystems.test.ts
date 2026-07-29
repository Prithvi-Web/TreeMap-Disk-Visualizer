import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanPackageEcosystems, brokenVenvInterpreter, PackageEntry } from '../src/services/packageEcosystemScanner';
import { loadRuleCatalogFrom } from '../src/services/rulePacks';
import { compileIgnoreList } from '../src/utils/glob';
import { FileNode } from '../src/models/types';

/**
 * §C6 — package-manager-aware orphan detection.
 *
 * Acceptance, verbatim: "A deliberately orphaned node_modules/target/venv
 * (parent removed) is flagged; an active one is not." Every ecosystem here is
 * driven by the §C8 rule packs, so these also prove the rules really are data:
 * nothing below names a directory that this file also hard-codes into the
 * scanner.
 */

const PACKS = path.join(__dirname, '..', 'src', 'services', 'rulepacks');
const catalog = () => loadRuleCatalogFrom(PACKS, process.platform);
const ROOT = path.resolve('/pkgroot');

/** Marker/evidence files default to 0 bytes so size assertions read as payload only. */
function file(name: string, size = 0): FileNode {
  return { name, path: name, size, type: 'file', modifiedAt: 1_700_000_000_000, isHidden: name.startsWith('.'), extension: (name.split('.').pop() || '').toLowerCase() };
}
function dir(name: string, children: FileNode[]): FileNode {
  return { name, path: name, type: 'dir', modifiedAt: 1_700_000_000_000, isHidden: name.startsWith('.'), size: 0, children };
}
/** Re-root a hand-built tree so every path is real and consistent. */
function rebase(node: FileNode, parent: string): FileNode {
  const here = path.join(parent, node.name);
  if (node.type === 'file') return { ...node, path: here };
  const kids = (node.children || []).map((c) => rebase(c, here));
  return { ...node, path: here, children: kids, size: kids.reduce((s, c) => s + c.size, 0) };
}
function tree(children: FileNode[], rootPath = ROOT): FileNode {
  const kids = children.map((c) => rebase(c, rootPath));
  return { name: path.basename(rootPath) || rootPath, path: rootPath, type: 'dir', modifiedAt: 0, isHidden: false, size: kids.reduce((s, c) => s + c.size, 0), children: kids };
}

function run(root: FileNode, ignore: string[] = []): PackageEntry[] {
  const report = scanPackageEcosystems(root, compileIgnoreList(ignore), catalog());
  return report.ecosystems.flatMap((e) => e.entries);
}
function find(entries: PackageEntry[], p: string): PackageEntry | undefined {
  return entries.find((e) => e.path === p);
}

/* ─────────────── The acceptance criterion, one case per artifact ─────────────── */

test('an orphaned node_modules is flagged and an active one is not', () => {
  const entries = run(tree([
    dir('live-project', [file('package.json'), dir('node_modules', [file('.package-lock.json'), file('dep.js', 5000)])]),
    dir('dead-project', [dir('node_modules', [file('.package-lock.json'), file('dep.js', 9000)])]),
  ]));

  const orphan = find(entries, path.join(ROOT, 'dead-project', 'node_modules'));
  assert.ok(orphan, 'the orphan must be found');
  assert.equal(orphan.kind, 'orphan');
  assert.equal(orphan.ecosystem, 'npm');
  assert.equal(orphan.size, 9000);
  assert.match(orphan.reason, /package\.json/, 'the reason names the manifest that is missing');
  assert.equal(orphan.command, 'npm install');

  const active = find(entries, path.join(ROOT, 'live-project', 'node_modules'));
  assert.ok(active, 'the active one is listed as context');
  assert.equal(active.kind, 'active', 'an owned dependency tree is never called an orphan');
  assert.equal(active.projectName, 'live-project');
});

test('an orphaned Rust target is flagged and an active one is not', () => {
  const entries = run(tree([
    dir('live-crate', [file('Cargo.toml'), dir('target', [file('CACHEDIR.TAG'), file('bin', 7000)])]),
    dir('dead-crate', [dir('target', [file('CACHEDIR.TAG'), file('bin', 8000)])]),
  ]));
  const orphan = find(entries, path.join(ROOT, 'dead-crate', 'target'));
  assert.ok(orphan);
  assert.equal(orphan.kind, 'orphan');
  assert.equal(orphan.ecosystem, 'cargo');
  assert.equal(orphan.command, 'cargo build');
  assert.equal(find(entries, path.join(ROOT, 'live-crate', 'target'))!.kind, 'active');
});

test('an orphaned virtualenv is flagged and an active one is not', () => {
  const entries = run(tree([
    dir('live-py', [file('requirements.txt'), dir('.venv', [file('pyvenv.cfg'), file('lib', 3000)])]),
    dir('dead-py', [dir('.venv', [file('pyvenv.cfg'), file('lib', 4000)])]),
  ]));
  const orphan = find(entries, path.join(ROOT, 'dead-py', '.venv'));
  assert.ok(orphan);
  assert.equal(orphan.kind, 'orphan');
  assert.equal(orphan.ecosystem, 'python');
  assert.equal(find(entries, path.join(ROOT, 'live-py', '.venv'))!.kind, 'active');
});

/* ─────────────── Not guessing when it cannot know ─────────────── */

test('an unidentifiable "target" is not claimed for any ecosystem', () => {
  // `target` belongs to both Rust and Maven. With the manifest gone and no
  // evidence inside, a label would be a guess — and a wrongly-labelled delete
  // suggestion is worse than a missed one.
  const entries = run(tree([dir('mystery', [dir('target', [file('something.bin', 5000)])])]));
  assert.equal(find(entries, path.join(ROOT, 'mystery', 'target')), undefined);
});

test('evidence inside the directory decides Rust vs Maven when the manifest is gone', () => {
  const entries = run(tree([
    dir('was-rust', [dir('target', [file('.rustc_info.json'), file('bin', 1000)])]),
    dir('was-maven', [dir('target', [dir('maven-status', [file('x', 10)]), file('app.jar', 2000)])]),
  ]));
  assert.equal(find(entries, path.join(ROOT, 'was-rust', 'target'))!.ecosystem, 'cargo');
  assert.equal(find(entries, path.join(ROOT, 'was-maven', 'target'))!.ecosystem, 'maven');
});

test('a claimed directory is never descended into', () => {
  // A node_modules holding nested node_modules must produce exactly one entry.
  const entries = run(tree([
    dir('proj', [dir('node_modules', [
      file('.package-lock.json'),
      dir('pkg-a', [dir('node_modules', [file('.package-lock.json'), file('inner.js', 100)])]),
    ])]),
  ]));
  const npm = entries.filter((e) => e.ecosystem === 'npm');
  assert.equal(npm.length, 1);
  assert.equal(npm[0].path, path.join(ROOT, 'proj', 'node_modules'));
});

test('ignored paths are never reported', () => {
  const entries = run(
    tree([dir('dead', [dir('node_modules', [file('.package-lock.json'), file('d.js', 100)])])]),
    ['**/node_modules/**', 'node_modules'],
  );
  assert.equal(entries.length, 0, 'the user said hands off');
});

/* ─────────────── Caches, which are never "orphaned" ─────────────── */

test('a shared package cache is classified as a cache, with the command that clears it', () => {
  const c = catalog();
  const npmCache = c.packageCache.find((r) => r.ecosystem === 'npm');
  assert.ok(npmCache, 'the shipped pack defines an npm cache location');
  const cachePath = npmCache.paths[0];

  const entries = run(tree([dir(path.basename(cachePath), [file('content.bin', 12345)])], path.dirname(cachePath)));
  const hit = find(entries, cachePath);
  assert.ok(hit, `${cachePath} must be recognised`);
  assert.equal(hit.kind, 'cache', 'a shared cache is never called orphaned — nothing "owns" it');
  assert.equal(hit.ecosystem, 'npm');
  assert.equal(hit.command, npmCache.clearCommand);
});

test('a root-owned cache is advisory, so it is never offered for trashing', { skip: process.platform !== 'linux' }, () => {
  const c = catalog();
  const apt = c.packageCache.find((r) => r.ecosystem === 'apt');
  assert.ok(apt);
  const entries = run(tree([dir(path.basename(apt.paths[0]), [file('pkg.deb', 999)])], path.dirname(apt.paths[0])));
  assert.equal(find(entries, apt.paths[0])!.advisory, true);
});

/* ─────────────── Homebrew: a version no longer used ─────────────── */

test('superseded Homebrew kegs are flagged, and a single-version formula is not', () => {
  const entries = run(tree([
    dir('Cellar', [
      dir('ripgrep', [
        { ...dir('13.0.0', [file('bin', 5000)]), modifiedAt: 1_600_000_000_000 },
        { ...dir('14.1.0', [file('bin', 5200)]), modifiedAt: 1_700_000_000_000 },
      ]),
      dir('jq', [dir('1.7.1', [file('bin', 900)])]),
    ]),
  ]));
  const brew = entries.filter((e) => e.ecosystem === 'homebrew');
  assert.equal(brew.length, 1, 'only the superseded version is reported');
  assert.equal(brew[0].path, path.join(ROOT, 'Cellar', 'ripgrep', '13.0.0'));
  assert.equal(brew[0].kind, 'orphan');
  assert.match(brew[0].reason, /Superseded/);
  assert.equal(brew[0].command, 'brew cleanup ripgrep');
});

/* ─────────────── A venv pointing at an interpreter that is gone ─────────────── */

test('a venv whose Python is gone is an orphan even though its project is alive', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-venv-'));
  const project = path.join(tmp, 'alive');
  const venv = path.join(project, '.venv');
  fs.mkdirSync(venv, { recursive: true });
  fs.writeFileSync(path.join(project, 'requirements.txt'), 'flask\n');
  fs.writeFileSync(path.join(venv, 'pyvenv.cfg'), `home = ${path.join(tmp, 'python-that-was-uninstalled', 'bin')}\nversion = 3.11.4\n`);

  assert.match(brokenVenvInterpreter(venv)!, /python-that-was-uninstalled/);

  const entries = run(tree([
    dir('alive', [file('requirements.txt'), dir('.venv', [file('pyvenv.cfg'), file('lib', 6000)])]),
  ], tmp));
  const hit = find(entries, venv);
  assert.ok(hit);
  assert.equal(hit.kind, 'orphan', 'an environment that cannot run is not "active"');
  assert.match(hit.reason, /interpreter is gone/);

  // And a healthy one is left alone: point it at an interpreter that exists.
  fs.writeFileSync(path.join(venv, 'pyvenv.cfg'), `home = ${tmp}\nversion = 3.11.4\n`);
  assert.equal(brokenVenvInterpreter(venv), null);
  assert.equal(find(run(tree([dir('alive', [file('requirements.txt'), dir('.venv', [file('pyvenv.cfg'), file('lib', 6000)])])], tmp)), venv)!.kind, 'active');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('a venv with no pyvenv.cfg is judged on its project alone, never guessed', () => {
  assert.equal(brokenVenvInterpreter(path.join(os.tmpdir(), 'definitely-not-a-venv-' + process.pid)), null);
});

/* ─────────────── Totals and grouping ─────────────── */

test('the report groups by ecosystem and totals only what it claims to', () => {
  const report = scanPackageEcosystems(
    tree([
      dir('dead-js', [dir('node_modules', [file('.package-lock.json'), file('a', 10_000)])]),
      dir('live-js', [file('package.json'), dir('node_modules', [file('.package-lock.json'), file('b', 3_000)])]),
      dir('dead-rs', [dir('target', [file('CACHEDIR.TAG'), file('c', 7_000)])]),
    ]),
    [],
    catalog(),
  );
  const npm = report.ecosystems.find((e) => e.ecosystem === 'npm')!;
  assert.equal(npm.orphanCount, 1);
  assert.equal(npm.orphanBytes, 10_000);
  assert.equal(npm.activeCount, 1);
  assert.equal(npm.activeBytes, 3_000);

  assert.equal(report.orphanCount, 2, 'one npm, one cargo');
  assert.equal(report.orphanBytes, 17_000, 'orphan bytes exclude the active tree');
  assert.equal(report.activeBytes, 3_000);
  // Orphans lead within a group; the biggest ecosystem leads overall.
  assert.equal(npm.entries[0].kind, 'orphan');
  assert.equal(report.ecosystems[0].ecosystem, 'npm');
});

test('an unremarkable tree reports nothing at all', () => {
  const report = scanPackageEcosystems(tree([dir('src', [file('index.ts', 500)])]), [], catalog());
  assert.deepEqual(report.ecosystems, []);
  assert.equal(report.orphanCount, 0);
});
