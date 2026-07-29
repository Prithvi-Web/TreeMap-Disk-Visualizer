import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FileNode } from '../src/models/types';
import { collectEmptyFolders } from '../src/services/diskScanner';

/**
 * Empty Folders reports directories with nothing underneath them.
 *
 * The thing being pinned here is what it deliberately does NOT report. An empty
 * directory is worth ~0 bytes, so the feature is about tidiness, not space —
 * which makes a false positive purely costly. `.git/refs/tags` and
 * `.git/objects/info` are empty in almost every repository on a disk, so they
 * flooded the list, and "Select all — 1000 folders" then quietly reached into
 * every repo the user owns to delete git's own bookkeeping.
 */

const NOW = 1_800_000_000_000;

function file(name: string, path: string, size = 10): FileNode {
  return { name, path, size, type: 'file', modifiedAt: NOW, isHidden: name.startsWith('.') };
}
function dir(name: string, path: string, children: FileNode[]): FileNode {
  return {
    name, path, type: 'dir', modifiedAt: NOW, isHidden: name.startsWith('.'),
    size: children.reduce((s, c) => s + c.size, 0), children,
  };
}

/** A tree shaped like a real home folder: one repo, some genuinely empty dirs. */
function tree(): FileNode {
  return dir('r', '/r', [
    dir('proj', '/r/proj', [
      dir('.git', '/r/proj/.git', [
        file('HEAD', '/r/proj/.git/HEAD'),
        dir('refs', '/r/proj/.git/refs', [dir('tags', '/r/proj/.git/refs/tags', [])]),
        dir('objects', '/r/proj/.git/objects', [dir('info', '/r/proj/.git/objects/info', [])]),
      ]),
      dir('src', '/r/proj/src', [file('keep.ts', '/r/proj/src/keep.ts')]),
    ]),
    dir('emptyOne', '/r/emptyOne', []),
    dir('nested', '/r/nested', [dir('deep', '/r/nested/deep', [])]),
    dir('.Trash', '/r/.Trash', []),
  ]);
}

test('git bookkeeping and the OS Trash are never offered as empty folders', () => {
  const { folders } = collectEmptyFolders(tree(), true);
  const paths = folders.map((f) => f.path).sort();

  assert.deepEqual(paths, ['/r/emptyOne', '/r/nested'],
    'only the user\'s own empty directories, and only the topmost of them');

  for (const forbidden of ['/r/proj/.git/refs/tags', '/r/proj/.git/objects/info',
    '/r/proj/.git/refs', '/r/proj/.git/objects', '/r/.Trash']) {
    assert.ok(!paths.includes(forbidden), `${forbidden} must not be offered for deletion`);
  }
});

test('the nested count matches what is offered, so the two numbers agree', () => {
  // The UI says "Select all — N top-level empty folders (M counting nested
  // ones)". If M still counted the git directories, the sentence would promise
  // to remove things the list refuses to show.
  const { folders, totalCount } = collectEmptyFolders(tree(), true);
  assert.equal(folders.length, 2);
  assert.equal(totalCount, 3, 'emptyOne, nested, and nested/deep — nothing from .git or .Trash');
});

test('a directory holding only junk still counts as empty, and .git still does not', () => {
  const t = dir('r', '/r', [
    dir('justJunk', '/r/justJunk', [file('.DS_Store', '/r/justJunk/.DS_Store')]),
    dir('.git', '/r/.git', [
      file('HEAD', '/r/.git/HEAD'),
      dir('info', '/r/.git/info', [file('.DS_Store', '/r/.git/info/.DS_Store')]),
    ]),
  ]);
  const paths = collectEmptyFolders(t, true).folders.map((f) => f.path);
  assert.deepEqual(paths, ['/r/justJunk'], 'junk-only is empty; junk-only inside .git is still git\'s');

  // And with the junk rule off, neither is empty.
  assert.deepEqual(collectEmptyFolders(t, false).folders.map((f) => f.path), []);
});

test('empty localisation folders inside an .app bundle are left alone', () => {
  // A signed bundle ships dozens of empty `.lproj` folders, and they sit inside
  // the signature's seal. Removing one frees ~0 bytes and stops the app
  // launching — the worst possible trade.
  const t = dir('r', '/r', [
    dir('Thing.app', '/r/Thing.app', [
      dir('Contents', '/r/Thing.app/Contents', [
        file('Info.plist', '/r/Thing.app/Contents/Info.plist'),
        dir('Resources', '/r/Thing.app/Contents/Resources', [
          dir('en.lproj', '/r/Thing.app/Contents/Resources/en.lproj', []),
          dir('fr.lproj', '/r/Thing.app/Contents/Resources/fr.lproj', []),
        ]),
      ]),
    ]),
    dir('mine', '/r/mine', []),
  ]);
  const { folders, totalCount } = collectEmptyFolders(t, true);
  assert.deepEqual(folders.map((f) => f.path), ['/r/mine'], 'only the folder the user made');
  assert.equal(totalCount, 1);
});

test('a repository that is genuinely empty is skipped whole, not descended into', () => {
  // `.git` with nothing in it at all is still git's directory, not a stray.
  const t = dir('r', '/r', [dir('.git', '/r/.git', [dir('refs', '/r/.git/refs', [])])]);
  const { folders, totalCount } = collectEmptyFolders(t, true);
  assert.deepEqual(folders, []);
  assert.equal(totalCount, 0);
});
