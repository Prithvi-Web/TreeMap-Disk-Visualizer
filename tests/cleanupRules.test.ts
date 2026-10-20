import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

import { isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-cleanupRules-data-');

import { collectCleanupSuggestions } from '../src/services/cleanupRules';
import { loadRuleCatalog } from '../src/services/rulePacks';
import { CleanupSuggestionGroup, FileNode } from '../src/models/types';
import { compileIgnoreList, CompiledIgnore } from '../src/utils/glob';
import { buildStoreFromTree } from '../src/services/scanStore';

/**
 * Smart Suggestions — one explicit regression test per shipped rule.
 *
 * §C8 requires these to exist BEFORE the rules move into JSON packs: the whole
 * acceptance criterion for that refactor is "every existing suggestion fires
 * identically afterwards", and there is no way to hold that line without a test
 * per rule. They were written against the hand-coded implementation and must
 * keep passing verbatim once the packs replace it — so treat a failure here as
 * "the refactor changed behaviour", never as "update the expectation".
 */

const ROOT = path.resolve('/scanroot');
const R = (...parts: string[]) => path.join(ROOT, ...parts);
const NO_IGNORE: CompiledIgnore[] = [];

let uid = 0;
function file(name: string, size = 4096, at = ROOT, modifiedAt = Date.now()): FileNode {
  return {
    name, path: path.join(at, name), size, type: 'file', modifiedAt, isHidden: name.startsWith('.'),
    extension: (name.split('.').pop() || '').toLowerCase(),
  };
}
function dir(name: string, children: FileNode[], at = ROOT): FileNode {
  const here = path.join(at, name);
  const rebased = children.map((c) => rebase(c, here));
  return {
    name, path: here, type: 'dir', modifiedAt: 0, isHidden: name.startsWith('.'),
    size: rebased.reduce((s, c) => s + c.size, 0), children: rebased,
  };
}
/** Re-root a subtree that was built against a different parent. */
function rebase(node: FileNode, parent: string): FileNode {
  const here = path.join(parent, node.name);
  if (node.type === 'file') return { ...node, path: here };
  const kids = (node.children || []).map((c) => rebase(c, here));
  return { ...node, path: here, children: kids, size: kids.reduce((s, c) => s + c.size, 0) };
}
function tree(children: FileNode[], rootPath = ROOT): FileNode {
  const kids = children.map((c) => rebase(c, rootPath));
  return {
    name: path.basename(rootPath) || rootPath, path: rootPath, type: 'dir', modifiedAt: 0, isHidden: false,
    size: kids.reduce((s, c) => s + c.size, 0), children: kids,
  };
}
/** A dir with one file inside, so it has a non-zero size (rules skip empty dirs). */
function pkg(name: string, bytes = 10_000): FileNode {
  return dir(name, [file(`payload-${uid++}.bin`, bytes)]);
}

function run(root: FileNode, ignore: CompiledIgnore[] = NO_IGNORE): CleanupSuggestionGroup[] {
  return collectCleanupSuggestions(root, ignore);
}
function groupById(groups: CleanupSuggestionGroup[], id: string): CleanupSuggestionGroup | undefined {
  return groups.find((g) => g.id === id);
}
function paths(group: CleanupSuggestionGroup | undefined): string[] {
  return (group?.items ?? []).map((i) => i.path).sort();
}

/* ─────────────────── Regenerable project directories ─────────────────── */

test('node_modules is flagged regenerable with npm install, no manifest required', () => {
  const g = groupById(run(tree([pkg('node_modules')])), 'regen-node-modules');
  assert.ok(g, 'node_modules must be suggested');
  assert.equal(g.category, 'regenerable');
  assert.equal(g.title, 'node_modules');
  assert.equal(g.regenerateCmd, 'npm install');
  assert.deepEqual(paths(g), [R('node_modules')]);
});

/** A virtualenv's top: the pyvenv.cfg Python's venv writes in every one it makes (BQL-b1 review F1.4), and a file of payload. */
function venvAt(name: string, bytes = 10_000): FileNode {
  return dir(name, [file('pyvenv.cfg', 200), file(`payload-${uid++}.bin`, bytes)]);
}

test('a virtualenv is flagged only next to a Python manifest', () => {
  for (const manifest of ['requirements.txt', 'pyproject.toml', 'Pipfile', 'setup.py', 'setup.cfg', '.python-version']) {
    const g = groupById(run(tree([venvAt('.venv'), file(manifest)])), 'regen-python-venv');
    assert.ok(g, `.venv beside ${manifest} must be suggested`);
    assert.equal(g.regenerateCmd, 'python3 -m venv <folder>, then reinstall the packages it held', 'what makes a virtualenv again (H08)');
  }
  for (const name of ['.venv', 'venv', 'env']) {
    assert.ok(groupById(run(tree([venvAt(name), file('pyproject.toml')])), 'regen-python-venv'), `${name} is a venv name`);
  }
  // No manifest: no rule offers it (the test below) — Package leftovers
  // reports it, saying no project file is beside it.
  assert.equal(groupById(run(tree([venvAt('env')])), 'regen-python-venv'), undefined);
});

test('a folder is offered as a virtualenv only when it holds pyvenv.cfg, and as coverage reports only when it holds a report a test tool writes: a person\'s own folder of that name beside a project file is neither (BQL-b1 review F1.4)', () => {
  // review-scratch/lens-safety/probe1.ts: /root/svc/env holding prod.env and
  // local.env, beside requirements.txt, was offered whole as "Python
  // virtualenv — Python can make it again", at high confidence, with "To put
  // it back: python3 -m venv env". A folder named coverage holding a site's
  // own pages, beside package.json (Eleventy) or a Gemfile (Jekyll), was
  // offered as test coverage reports "the next test run writes again".
  const settings = dir('env', [file('prod.env', 300), file('local.env', 200)]);
  assert.deepEqual(offered(run(tree([dir('svc', [settings, file('requirements.txt', 40)])]))), [],
    'a folder of settings named env beside requirements.txt is offered by no rule');
  for (const [manifest, pages] of [['package.json', ['index.md', 'home.md']], ['Gemfile', ['index.md']], ['pubspec.yaml', ['notes.txt']]] as const) {
    const site = dir('coverage', pages.map((p) => file(p, 900)));
    assert.deepEqual(offered(run(tree([dir('site', [site, file(manifest, 40)])]))), [],
      `a folder named coverage holding ${pages.join(' and ')} beside ${manifest} is offered by no rule`);
  }
  // What each tool writes there by default, or with its usual reporter:
  // lcov (Jest, c8, nyc, `flutter test --coverage`), Istanbul's json, json-summary,
  // clover, cobertura and html reports (Jest, Vitest, c8, nyc), SimpleCov's results.
  const REPORTS: Array<[string, string]> = [
    ['package.json', 'lcov.info'], ['package.json', 'coverage-final.json'], ['package.json', 'coverage-summary.json'],
    ['package.json', 'clover.xml'], ['package.json', 'cobertura-coverage.xml'], ['package.json', 'prettify.js'],
    ['Gemfile', '.resultset.json'], ['pubspec.yaml', 'lcov.info'],
  ];
  for (const [manifest, report] of REPORTS) {
    const reports = dir('coverage', [file('index.html', 900), file(report, 4000)]);
    assert.deepEqual(paths(groupById(run(tree([dir('web', [reports, file(manifest, 40)])])), 'test-coverage')), [R('web', 'coverage')],
      `control: coverage holding ${report} beside ${manifest} is offered`);
  }
  // Each sentence says what the folder holds as well as what sits beside it.
  assert.equal(groupById(run(tree([venvAt('.venv'), file('requirements.txt')])), 'regen-python-venv')?.why,
    'A folder named .venv, venv or env holding pyvenv.cfg, sitting next to requirements.txt, pyproject.toml, Pipfile, setup.py, setup.cfg or .python-version.',
    'the virtualenv\'s why names what it holds (every name the rule knows: the walk\'s sentence, narrowed where groups are served)');
  assert.equal(groupById(run(tree([dir('coverage', [file('lcov.info', 4000)]), file('package.json')])), 'test-coverage')?.why,
    'A folder named coverage holding lcov.info, coverage-final.json, coverage-summary.json, clover.xml, cobertura-coverage.xml, prettify.js or .resultset.json, sitting next to package.json, Gemfile or pubspec.yaml.',
    'the coverage folder\'s why names what it holds');
});

/** Every item any group offers, by path. */
function offered(groups: CleanupSuggestionGroup[]): string[] {
  return groups.flatMap((g) => g.items.map((i) => i.path)).sort();
}

test('a virtualenv with no project file beside it is offered by no rule: nothing makes it again by itself, so it is no tool cache "rebuilt automatically when needed" (BQL item 7b)', () => {
  // W/bql/scratch/r7-venv-rules.ts: /root/scripts/.venv beside run.py alone
  // was a "Tool caches" item, "Caches left by dev tools — rebuilt
  // automatically when needed", and an approved Autopilot policy on that group
  // trashed it unattended with that reason. The scripts that use it stop
  // working until someone makes it again and reinstalls what it held.
  for (const name of ['.venv', 'venv', 'env']) {
    const venv = dir(name, [file('pyvenv.cfg', 200), dir('lib', [file('site.py', 90_000)])]);
    const groups = run(tree([dir('scripts', [venv, file('run.py', 300)])]));
    assert.deepEqual(offered(groups), [], `${name} beside run.py alone is offered by no rule: ${JSON.stringify(groups.map((g) => g.id))}`);
  }
});

/**
 * pip as it is installed: it ships a package folder named `build`
 * (pip/_internal/operations/build, in pip 26.0.1 as in Python 3.13's own), and
 * Python writes `__pycache__` beside the modules it imports.
 */
function pipPackage(): FileNode {
  return dir('pip', [
    file('__init__.py', 400),
    dir('__pycache__', [file('__init__.cpython-312.pyc', 700)]),
    dir('_internal', [dir('operations', [
      dir('build', [file('build_tracker.py', 4600), file('metadata.py', 1400), file('wheel.py', 1100)]),
      dir('install', [file('wheel.py', 27_000)]),
      dir('__pycache__', [file('check.cpython-312.pyc', 6100)]),
    ])]),
  ]);
}
/** `pipPackage` installed in a folder `packages` (outermost first) down, its last name the package folder. */
function installedIn(packages: string[]): FileNode {
  let at = dir(packages[packages.length - 1], [pipPackage(), dir('pip-26.0.1.dist-info', [file('RECORD', 9000)])]);
  for (const name of packages.slice(0, -1).reverse()) at = dir(name, [at]);
  return at;
}
/** A virtualenv as `python3 -m venv` makes it, pip in it. */
function realVenv(name: string, packages = ['lib', 'python3.12', 'site-packages']): FileNode {
  return dir(name, [file('pyvenv.cfg', 200), dir('bin', [file('python3', 50), file('pip', 250)]), installedIn(packages)]);
}

test('nothing in a Python environment\'s installed packages is offered: pip\'s own build package and the bytecode beside it are parts of pip, not build output, so a virtualenv no rule claims yields no pieces (BQL-b1 review F1.1, F1.3, F1.6)', () => {
  // review-scratch/r3-venv-pip.ts: with `.venv` out of "Tool caches", the walk
  // went into /root/scripts/.venv and offered pip/_internal/operations/build as
  // "Build output — Compiled output folders — regenerated by the next build".
  // Trashed, pip in that environment cannot import its own build module, and
  // nothing makes the folder again.
  const venvs: Array<[string, string[]?]> = [['.venv'], ['venv'], ['env'], ['.venv', ['Lib', 'site-packages']]];
  for (const [name, packages] of venvs) {
    const claimed: string[] = [];
    const groups = collectCleanupSuggestions(tree([dir('scripts', [realVenv(name, packages), file('run.py', 300)])]), NO_IGNORE, loadRuleCatalog(),
      (_rule, nodePath) => claimed.push(nodePath));
    const where = `${name}${packages ? ` (${packages.join('/')})` : ''}`;
    assert.deepEqual(offered(groups), [], `${where} beside run.py alone: nothing in it is offered: ${JSON.stringify(groups.map((g) => [g.id, paths(g)]))}`);
    assert.deepEqual(claimed, [], `${where}: and no rule claims anything in it, so the Reclaim Score calls none of it rebuilt`);
  }
  // A Python installed for the system holds its packages the same way:
  // Homebrew's lib/python3.13/site-packages, Debian's lib/python3/dist-packages.
  for (const packages of [['lib', 'python3.13', 'site-packages'], ['lib', 'python3', 'dist-packages']]) {
    assert.deepEqual(offered(run(tree([installedIn(packages)]))), [], `pip in ${packages.join('/')}: nothing in it is offered`);
  }
  // Control: the same folders anywhere else are matched as the rules say.
  assert.deepEqual(offered(run(tree([dir('proj', [pipPackage()])]))),
    [R('proj', 'pip', '__pycache__'), R('proj', 'pip', '_internal', 'operations', '__pycache__'), R('proj', 'pip', '_internal', 'operations', 'build')].sort(),
    'control: outside an installed-packages folder, build and __pycache__ are offered by their rules');
  // Control: a virtualenv beside a project file is still offered whole.
  assert.deepEqual(offered(run(tree([dir('proj', [realVenv('.venv'), file('requirements.txt', 40)])]))), [R('proj', '.venv')],
    'control: a virtualenv beside requirements.txt is offered whole, as before');
});

/** `node` under `parent`, every path joined with `sep`: a tree spelled as a scan on Windows spells it, on any machine. */
function spelledWith(node: FileNode, parent: string, sep: string): FileNode {
  const here = parent.endsWith(sep) ? parent + node.name : parent + sep + node.name;
  if (node.type === 'file') return { ...node, path: here };
  const kids = (node.children || []).map((c) => spelledWith(c, here, sep));
  return { ...node, path: here, children: kids, size: kids.reduce((s, c) => s + c.size, 0) };
}

const BOTH_STORES = [['object store', (t: FileNode) => t], ['packed store', (t: FileNode) => buildStoreFromTree(t)]] as const;

test('a scan rooted in an installed-packages folder, or below one, offers nothing in it: the walk cannot meet the folder as a child there, so the root\'s own path decides (BQL-b1 review F2.1, F2.4)', () => {
  // review-scratch/r2-judge/probe.ts: a scan of a virtualenv's site-packages,
  // made to see which package is big, offered pip/_internal/operations/build
  // as "Build output — Compiled output folders — regenerated by the next
  // build" and pip/__pycache__ as bytecode: the walk tested only a child's
  // name, and the root is no child.
  const site = '/v/.venv/lib/python3.12/site-packages';
  const roots: Array<[string, FileNode[]]> = [
    [site, [pipPackage(), dir('pip-26.0.1.dist-info', [file('RECORD', 9000)])]],
    [`${site}/pip`, pipPackage().children!],
    [`${site}/pip/_internal/operations`, [dir('build', [file('wheel.py', 1100)]), dir('__pycache__', [file('check.cpython-312.pyc', 6100)])]],
    ['/usr/lib/python3/dist-packages/pip', pipPackage().children!],
    ['/v/env/Lib/Site-Packages', [pipPackage()]], // Windows' Lib\site-packages, in another case
  ];
  for (const [root, children] of roots) {
    for (const [label, make] of BOTH_STORES) {
      const claimed: string[] = [];
      const groups = collectCleanupSuggestions(make(tree(children, path.resolve(root))), NO_IGNORE, loadRuleCatalog(), (_rule, nodePath) => claimed.push(nodePath));
      assert.deepEqual(offered(groups), [], `${label}, a scan of ${root}: nothing in it is offered: ${JSON.stringify(groups.map((g) => [g.id, paths(g)]))}`);
      assert.deepEqual(claimed, [], `${label}, a scan of ${root}: and no rule claims anything in it`);
    }
  }
  // Spelled with backslashes, as a scan on Windows spells its root.
  const winRoot = 'C:\\Users\\me\\proj\\.venv\\Lib\\site-packages';
  const winTree: FileNode = { ...tree([]), name: 'site-packages', path: winRoot, children: [spelledWith(pipPackage(), winRoot, '\\')] };
  assert.deepEqual(offered(run(winTree)), [], `a scan of ${winRoot}: nothing in it is offered`);
  // Control: a root whose folders only begin with the name is no such folder.
  const notes = path.resolve('/v/site-packages-notes/pip');
  assert.deepEqual(offered(run(tree(pipPackage().children!, notes))),
    [path.join(notes, '__pycache__'), path.join(notes, '_internal', 'operations', '__pycache__'), path.join(notes, '_internal', 'operations', 'build')].sort(),
    'control: under a folder named site-packages-notes, build and __pycache__ are offered by their rules');
});

test('a folder holding a *.dist-info folder holds installed packages wherever it is - uv\'s cache, pip install --target - so the walk never goes into it (BQL-b1 review F2.4)', () => {
  // review-scratch/r2/probe3.ts: uv keeps each wheel it unpacks in its cache
  // as the package folders and their .dist-info, outside any site-packages.
  // A scan of the home folder offered
  // ~/Library/Caches/uv/archive-v0/Xk3pQ9/pip/_internal/operations/build as
  // Build output; `pip install --target` lays packages out the same way.
  const wheel = (): FileNode[] => [pipPackage(), dir('pip-26.0.1.dist-info', [file('RECORD', 9000), file('METADATA', 800)])];
  const homes: Array<[string, FileNode]> = [
    ['uv\'s cache', dir('Library', [dir('Caches', [dir('uv', [dir('archive-v0', [dir('Xk3pQ9', wheel())])])])])],
    ['pip install --target', dir('lambda', [dir('package', wheel()), file('handler.py', 900)])],
    ['a .dist-info in another case', dir('vendor', [pipPackage(), dir('pip-26.0.1.DIST-INFO', [file('RECORD', 9000)])])],
  ];
  for (const [label, home] of homes) {
    for (const [store, make] of BOTH_STORES) {
      const claimed: string[] = [];
      const groups = collectCleanupSuggestions(make(tree([home, pkg('node_modules')])), NO_IGNORE, loadRuleCatalog(), (_rule, nodePath) => claimed.push(nodePath));
      assert.deepEqual(offered(groups), [R('node_modules')], `${label}, ${store}: nothing in the installed packages is offered: ${JSON.stringify(groups.map((g) => [g.id, paths(g)]))}`);
      assert.deepEqual(claimed, [R('node_modules')], `${label}, ${store}: and no rule claims anything in them`);
    }
  }
  // A scan rooted at the folder that holds them.
  assert.deepEqual(offered(run(tree(wheel(), path.resolve('/Users/me/Library/Caches/uv/archive-v0/Xk3pQ9')))), [],
    'a scan of the unpacked wheel itself: nothing in it is offered');
  // Control: a FILE named like one is no installed package's record.
  assert.deepEqual(offered(run(tree([dir('vendor', [pipPackage(), file('pip-26.0.1.dist-info', 10)])]))),
    [R('vendor', 'pip', '__pycache__'), R('vendor', 'pip', '_internal', 'operations', '__pycache__'), R('vendor', 'pip', '_internal', 'operations', 'build')].sort(),
    'control: beside a file named pip-26.0.1.dist-info, build and __pycache__ are offered by their rules');
});

test('__pycache__ is flagged and says it regenerates itself', () => {
  const g = groupById(run(tree([pkg('__pycache__')])), 'regen-pycache');
  assert.ok(g);
  assert.equal(g.category, 'regenerable');
  assert.equal(g.regenerateCmd, 'automatic on next run');
});

test('target resolves Rust vs Maven by the manifest beside it', () => {
  const rust = groupById(run(tree([pkg('target'), file('Cargo.toml')])), 'regen-rust-target');
  assert.ok(rust, 'target + Cargo.toml is a Rust target');
  assert.equal(rust.regenerateCmd, 'cargo build');

  const maven = groupById(run(tree([pkg('target'), file('pom.xml')])), 'regen-maven-target');
  assert.ok(maven, 'target + pom.xml is a Maven target');
  assert.equal(maven.regenerateCmd, 'mvn package');

  // Neither manifest: it is only generic build output, with no restore command.
  const bare = run(tree([pkg('target')]));
  assert.equal(groupById(bare, 'regen-rust-target'), undefined);
  assert.equal(groupById(bare, 'regen-maven-target'), undefined);
  assert.ok(groupById(bare, 'build-output'));
});

test('a Gradle build dir is flagged next to any Gradle script', () => {
  for (const manifest of ['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts']) {
    const g = groupById(run(tree([pkg('build'), file(manifest)])), 'regen-gradle-build');
    assert.ok(g, `build beside ${manifest} must be suggested`);
    assert.equal(g.regenerateCmd, 'gradle build');
  }
});

test('Pods is flagged next to a Podfile', () => {
  const g = groupById(run(tree([pkg('Pods'), file('Podfile')])), 'regen-cocoapods');
  assert.ok(g, 'the match is case-insensitive on the directory name');
  assert.equal(g.regenerateCmd, 'pod install');
  assert.equal(groupById(run(tree([pkg('Pods')])), 'regen-cocoapods'), undefined);
});

test('framework build dirs are flagged, and dist and .output only beside a JS project file', () => {
  for (const name of ['.next', '.nuxt', '.svelte-kit', '.angular']) {
    const g = groupById(run(tree([pkg(name)])), 'regen-web-build');
    assert.ok(g, `${name} needs no sibling`);
    assert.equal(g.regenerateCmd, 'npm run build');
  }
  for (const manifest of ['package.json', 'next.config.js', 'nuxt.config.ts', 'vite.config.js', 'svelte.config.js', 'angular.json']) {
    assert.ok(groupById(run(tree([pkg('dist'), file(manifest)])), 'regen-web-build'), `dist beside ${manifest}`);
    assert.ok(groupById(run(tree([pkg('.output'), file(manifest)])), 'regen-web-build'), `.output beside ${manifest}`);
  }
  // "output" is any tool's word, not only Nuxt's: alone, `npm run build`
  // would make nothing there, so no rule says it does (BQL item 7b).
  assert.deepEqual(offered(run(tree([pkg('.output')]))), [], '.output alone is offered by no rule');
  // `foo.*` patterns must not match a bare prefix.
  assert.equal(groupById(run(tree([pkg('dist'), file('vite.config')])), 'regen-web-build'), undefined);
});

test('rules sharing an id merge into one group', () => {
  const g = groupById(run(tree([pkg('.next', 1000), pkg('dist', 2000), file('package.json', 10)])), 'regen-web-build');
  assert.ok(g);
  assert.deepEqual(paths(g), [R('.next'), R('dist')]);
  assert.equal(g.totalSize, 3000);
});

/* ─────────────────────────── Name rules ─────────────────────────── */

test('unqualified build output is flagged regenerable without a restore command', () => {
  for (const name of ['dist', 'target', 'build']) {
    const g = groupById(run(tree([pkg(name)])), 'build-output');
    assert.ok(g, `${name} is generic build output`);
    assert.equal(g.category, 'regenerable');
    assert.equal(g.regenerateCmd, undefined, 'no manifest means no command we could honestly print');
  }
});

test('every tool cache directory is flagged as a cache, and the rule names only folders no person names their own', () => {
  // Matched by name alone, with "rebuilt automatically when needed": each name
  // is one tool's own folder (BQL item 7b). `.venv` (nothing makes it again by
  // itself), `coverage` (a person's own word) and `.gradle` (in a home folder,
  // Gradle's own settings and downloads) left it; the tests below.
  const REVIEWED = ['.pytest_cache', '.mypy_cache', '.ruff_cache', '.turbo', '.parcel-cache', '.eslintcache', '.tox'];
  assert.deepEqual(loadRuleCatalog().directory.find((r) => r.id === 'tool-caches')?.names, REVIEWED,
    'a name added to the rule is reviewed here first');
  for (const name of REVIEWED) {
    const g = groupById(run(tree([pkg(name)])), 'tool-caches');
    assert.ok(g, `${name} must be flagged`);
    assert.equal(g.category, 'cache');
  }
});

test('a coverage folder is offered only beside a project file whose test tools write their reports there — never by its name alone, where it may hold a person\'s own papers (BQL item 7b)', () => {
  // Alone, and beside the project file of a language whose own source
  // folders may be called coverage: coverage.py's repository holds its
  // package `coverage/` beside pyproject.toml, a Go package is a folder beside
  // go.mod, and a Cargo workspace lists member crates beside Cargo.toml.
  // Each holds a report, so only the folder beside it decides (BQL-b1 review F1.4: what it holds decides too, above).
  const reports = (): FileNode => dir('coverage', [file('lcov.info', 10_000)]);
  for (const beside of [[], ['pyproject.toml'], ['setup.cfg'], ['setup.py'], ['go.mod'], ['Cargo.toml']]) {
    const groups = run(tree([reports(), ...beside.map((f) => file(f))]));
    assert.deepEqual(offered(groups), [], `coverage beside ${beside.join(', ') || 'nothing'} is offered by no rule`);
  }
  // Jest, Vitest, c8 and nyc (package.json), SimpleCov (Gemfile) and
  // `flutter test --coverage` (pubspec.yaml) write `coverage/` by default.
  for (const manifest of ['package.json', 'Gemfile', 'pubspec.yaml']) {
    const g = groupById(run(tree([reports(), file(manifest)])), 'test-coverage');
    assert.ok(g, `coverage beside ${manifest} is offered`);
    assert.equal(g.category, 'regenerable', 'coverage reports: a regenerable group, as every rule with a way back is');
    assert.deepEqual(paths(g), [R('coverage')], 'the coverage folder itself is offered');
  }
  assert.equal(groupById(run(tree([reports(), file('Gemfile')])), 'test-coverage')?.why,
    'A folder named coverage holding lcov.info, coverage-final.json, coverage-summary.json, clover.xml, cobertura-coverage.xml, prettify.js or .resultset.json, sitting next to package.json, Gemfile or pubspec.yaml.',
    'its why says what matched');
});

/**
 * A project's .gradle as Gradle 8 leaves it after a build: one folder per
 * Gradle version, buildOutputCleanup, vcs-1 and the file-system.probe file
 * system watching writes.
 */
function projectGradle(): FileNode {
  return dir('.gradle', [
    dir('8.10', [dir('fileHashes', [file('fileHashes.bin', 20_000)]), dir('executionHistory', [file('executionHistory.bin', 40_000)])]),
    dir('buildOutputCleanup', [file('cache.properties', 50), file('outputFiles.bin', 18_000)]),
    dir('vcs-1', [file('gc.properties', 0)]),
    file('file-system.probe', 8),
  ]);
}

test('a .gradle folder is offered only beside a Gradle build file and holding what a build writes: the one in a home folder is Gradle\'s own settings and downloads, and only its caches folder is a cache (BQL item 7b; BQL-b1 review F2.2)', () => {
  for (const manifest of ['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts']) {
    const g = groupById(run(tree([projectGradle(), file(manifest)])), 'gradle-project-cache');
    assert.ok(g, `.gradle beside ${manifest} is offered`);
    assert.equal(g.category, 'regenerable', 'the Gradle project cache: a regenerable group, as every rule with a way back is');
    assert.equal(g.regenerateCmd, 'gradle build', 'the Gradle project cache: the command that writes it again');
  }
  // Any one of the three a build writes will do.
  for (const keep of ['buildOutputCleanup', 'vcs-1', 'file-system.probe']) {
    const only = dir('.gradle', projectGradle().children!.filter((c) => c.name === keep || c.name === '8.10'));
    assert.ok(groupById(run(tree([only, file('build.gradle')])), 'gradle-project-cache'), `.gradle holding ${keep} beside build.gradle is offered`);
  }
  // Nothing a build writes in it: no rule vouches that a build makes it again.
  assert.equal(groupById(run(tree([pkg('.gradle'), file('build.gradle')])), 'gradle-project-cache'), undefined,
    'a .gradle holding none of what a build writes is not offered');
  // ~/.gradle holds gradle.properties (often signing and repository
  // passwords) and init scripts a person wrote. Matched by its name, it was
  // offered whole as a tool cache, and the walk never reached the known
  // location ~/.gradle/caches inside it.
  const home = os.homedir();
  const expected = process.platform === 'win32' ? [] : [path.join(home, '.gradle', 'caches')]; // dev-caches names it on macOS and Linux
  const userHome = (): FileNode => dir('.gradle', [
    file('gradle.properties', 300), dir('init.d', [file('repos.gradle', 200)]), dir('caches', [file('modules-2.bin', 9000)]),
    dir('wrapper', [dir('dists', [file('gradle-8.10-bin.zip', 9000)])]), dir('daemon', [dir('8.10', [file('daemon-1.out.log', 300)])]),
  ]);
  assert.deepEqual(offered(run(tree([userHome()], home))), expected, 'only the caches folder inside the Gradle user home is offered');
  // review-scratch/r6-gradle/probe.ts: with a build file beside it - a stray
  // build.gradle in the home folder, or CI's GRADLE_USER_HOME=$PWD/.gradle
  // beside the project's - the user home was offered whole as "Gradle's own
  // records for this project — the next Gradle build writes them again",
  // which no build does for gradle.properties or an init script.
  assert.deepEqual(offered(run(tree([userHome(), file('build.gradle')], home))), expected,
    'beside a build file too, only the caches folder inside the Gradle user home is offered');
  const both = dir('.gradle', [...projectGradle().children!, ...userHome().children!]);
  assert.deepEqual(offered(run(tree([both, file('settings.gradle.kts')], home))), expected,
    'a .gradle that is both a project\'s and the Gradle user home (CI) is not offered whole');
  // Each thing only a Gradle user home holds refuses it on its own.
  for (const [name, node] of [
    ['gradle.properties', file('gradle.properties', 300)], ['init.d', dir('init.d', [file('repos.gradle', 200)])],
    ['init.gradle', file('init.gradle', 200)], ['init.gradle.kts', file('init.gradle.kts', 200)],
    ['caches', dir('caches', [file('modules-2.bin', 9000)])], ['wrapper', dir('wrapper', [file('w.jar', 900)])],
    ['daemon', dir('daemon', [file('d.log', 300)])],
  ] as const) {
    const mixed = dir('.gradle', [...projectGradle().children!, node]);
    assert.equal(groupById(run(tree([mixed, file('build.gradle')])), 'gradle-project-cache'), undefined,
      `a project .gradle that also holds ${name} is not offered`);
  }
  assert.equal(groupById(run(tree([projectGradle(), file('build.gradle')])), 'gradle-project-cache')?.why,
    'A folder named .gradle holding buildOutputCleanup, file-system.probe or vcs-1 and no gradle.properties, init.d, init.gradle, init.gradle.kts, caches, wrapper or daemon, sitting next to build.gradle, build.gradle.kts, settings.gradle or settings.gradle.kts.',
    'its why says what it holds, what it does not, and what sits beside it');
});

test('OS junk files are flagged as junk, matched case-insensitively', () => {
  for (const name of ['.DS_Store', 'Thumbs.db', 'desktop.ini']) {
    const g = groupById(run(tree([file(name, 6148)])), 'os-junk');
    assert.ok(g, `${name} must be flagged`);
    assert.equal(g.category, 'junk');
    assert.equal(g.items[0].type, 'file');
  }
});

test('a junk file is flagged regardless of size, unlike a directory rule', () => {
  // Directory rules require size > 0; the file rule has no such gate, and a
  // zero-byte .DS_Store is still clutter.
  assert.ok(groupById(run(tree([file('.DS_Store', 0)])), 'os-junk'));
  assert.equal(groupById(run(tree([dir('node_modules', [])])), 'regen-node-modules'), undefined);
});

/* ───────────────────── OS path-prefix rules ───────────────────── */

test('the OS browser and developer cache locations are flagged', () => {
  const home = os.homedir();
  const cases: Array<{ prefix: string; id: string }> =
    process.platform === 'darwin'
      ? [
          { prefix: path.join(home, 'Library', 'Caches', 'Google', 'Chrome'), id: 'browser-caches' },
          { prefix: path.join(home, 'Library', 'Developer', 'Xcode', 'DerivedData'), id: 'dev-caches' },
        ]
      : process.platform === 'win32'
        ? [
            { prefix: path.join(home, '.m2', 'repository'), id: 'dev-caches' },
            { prefix: path.join(home, '.cargo', 'registry'), id: 'dev-caches' },
          ]
        : [
            { prefix: path.join(home, '.cache', 'mozilla'), id: 'browser-caches' },
            { prefix: path.join(home, '.npm', '_cacache'), id: 'dev-caches' },
          ];

  for (const { prefix, id } of cases) {
    // Scan the parent so the cache directory itself is a child of the root.
    const parent = path.dirname(prefix);
    const g = groupById(run(tree([pkg(path.basename(prefix))], parent)), id);
    assert.ok(g, `${prefix} must be flagged as ${id}`);
    assert.equal(g.category, 'cache');
    assert.deepEqual(paths(g), [prefix]);
  }
});

/* ─────────────────────── Old downloads ─────────────────────── */

test('old, large files in Downloads are flagged; recent or small ones are not', () => {
  const downloads = path.join(os.homedir(), 'Downloads');
  const old = Date.now() - 120 * 86_400_000;
  const recent = Date.now() - 3 * 86_400_000;
  const groups = run(tree([
    file('big-and-old.dmg', 5_000_000, downloads, old),
    file('big-but-recent.dmg', 5_000_000, downloads, recent),
    file('old-but-tiny.txt', 1000, downloads, old),
  ], downloads));
  const g = groupById(groups, 'old-downloads');
  assert.ok(g, 'the stale download must be flagged');
  assert.equal(g.category, 'junk');
  assert.deepEqual(paths(g), [path.join(downloads, 'big-and-old.dmg')]);
});

test('an old, large file outside Downloads is not flagged', () => {
  const groups = run(tree([file('archive.dmg', 5_000_000, ROOT, Date.now() - 200 * 86_400_000)]));
  assert.equal(groupById(groups, 'old-downloads'), undefined);
});

/* ─────────────────────── Structural behaviour ─────────────────────── */

test('a claimed directory is never descended into', () => {
  // A nested node_modules inside an outer one must not produce a second item —
  // the outer suggestion already accounts for its bytes.
  const inner = dir('node_modules', [file('inner.bin', 5000)]);
  const root = tree([dir('node_modules', [file('outer.bin', 5000), dir('pkg', [inner])])]);
  const g = groupById(run(root), 'regen-node-modules');
  assert.ok(g);
  assert.deepEqual(paths(g), [R('node_modules')], 'exactly one item, the outermost');
});

test('rule precedence is regenerable, then name, then path', () => {
  // `dist` beside package.json is both a regen-web-build and a build-output
  // match. The regenerable rule wins, because it is the one that can name the
  // command that puts the folder back.
  const groups = run(tree([pkg('dist'), file('package.json', 10)]));
  assert.ok(groupById(groups, 'regen-web-build'));
  assert.equal(groupById(groups, 'build-output'), undefined);
});

test('ignored paths are never suggested', () => {
  const ignore = compileIgnoreList(['**/node_modules/**', 'node_modules']);
  const groups = collectCleanupSuggestions(tree([pkg('node_modules'), pkg('__pycache__')]), ignore);
  assert.equal(groupById(groups, 'regen-node-modules'), undefined, 'the user said hands off');
  assert.ok(groupById(groups, 'regen-pycache'), 'unrelated rules still fire');
});

test('groups sort by reclaimable size, items sort by size, and items are capped', () => {
  const many = Array.from({ length: 250 }, (_, i) => dir(`p${i}`, [pkg('__pycache__', 1000 + i)]));
  const groups = run(tree([...many, pkg('node_modules', 10_000_000)]));
  assert.equal(groups[0].id, 'regen-node-modules', 'the biggest group leads');

  const py = groupById(groups, 'regen-pycache');
  assert.ok(py);
  assert.equal(py.items.length, 200, 'the item list is capped at 200');
  assert.equal(py.totalSize, many.reduce((s, _, i) => s + 1000 + i, 0), 'but the total counts every match');
  for (let i = 1; i < py.items.length; i++) {
    assert.ok(py.items[i - 1].size >= py.items[i].size, 'items are largest-first');
  }
});

test('an unremarkable tree produces no suggestions at all', () => {
  const groups = run(tree([dir('src', [file('index.ts', 2000)]), file('README.md', 500)]));
  assert.deepEqual(groups, []);
});
