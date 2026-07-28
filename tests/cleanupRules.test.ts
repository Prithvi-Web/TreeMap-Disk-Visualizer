import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { collectCleanupSuggestions } from '../src/services/cleanupRules';
import { CleanupSuggestionGroup, FileNode } from '../src/models/types';
import { compileIgnoreList, CompiledIgnore } from '../src/utils/glob';

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

test('a virtualenv is flagged only next to a Python manifest', () => {
  for (const manifest of ['requirements.txt', 'pyproject.toml', 'Pipfile', 'setup.py', 'setup.cfg', '.python-version']) {
    const g = groupById(run(tree([pkg('.venv'), file(manifest)])), 'regen-python-venv');
    assert.ok(g, `.venv beside ${manifest} must be suggested`);
    assert.equal(g.regenerateCmd, 'pip install -r requirements.txt');
  }
  for (const name of ['.venv', 'venv', 'env']) {
    assert.ok(groupById(run(tree([pkg(name), file('pyproject.toml')])), 'regen-python-venv'), `${name} is a venv name`);
  }
  // No manifest: `.venv` still matches the generic tool-cache rule, but never
  // the regenerable one — the distinction is what carries the restore command.
  assert.equal(groupById(run(tree([pkg('env')])), 'regen-python-venv'), undefined);
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

test('framework build dirs are flagged, and dist only beside a JS project file', () => {
  for (const name of ['.next', '.nuxt', '.output', '.svelte-kit', '.angular']) {
    const g = groupById(run(tree([pkg(name)])), 'regen-web-build');
    assert.ok(g, `${name} needs no sibling`);
    assert.equal(g.regenerateCmd, 'npm run build');
  }
  for (const manifest of ['package.json', 'next.config.js', 'nuxt.config.ts', 'vite.config.js', 'svelte.config.js', 'angular.json']) {
    assert.ok(groupById(run(tree([pkg('dist'), file(manifest)])), 'regen-web-build'), `dist beside ${manifest}`);
  }
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

test('every tool cache directory is flagged as a cache', () => {
  const names = ['.pytest_cache', '.mypy_cache', '.ruff_cache', '.gradle', '.turbo', '.parcel-cache', '.eslintcache', 'coverage', '.venv', '.tox'];
  for (const name of names) {
    const g = groupById(run(tree([pkg(name)])), 'tool-caches');
    assert.ok(g, `${name} must be flagged`);
    assert.equal(g.category, 'cache');
  }
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
