import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs, { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { sanitizePath, PathRejectedError } from '../src/utils/pathSanitizer';

/**
 * Whitespace in a path is DATA at the end and NOISE at the front.
 *
 * `sanitizePath` has always called `input.trim()`, but until the guard learned
 * to rewrite `req.url` the trimmed value was thrown away: it was assigned to
 * `req.query[name]`, and express 5 re-parses the query on every access, so the
 * handler still saw the raw string. Making the sanitisation real made the trim
 * real too — and a trailing space is a perfectly legal filename byte on macOS
 * and Linux. `path.resolve` preserves it deliberately. Every store lookup in
 * this app is exact string equality, so trimming "~/Downloads/Screenshots " to
 * "~/Downloads/Screenshots" does not find a folder "close enough": it finds
 * nothing, and the route 404s on a directory the treemap is drawing on screen.
 * `String.prototype.trim` is also wider than ASCII — it eats U+00A0 and U+FEFF,
 * which arrive routinely in names pasted out of a web page.
 *
 * Leading whitespace is the opposite: nothing before an absolute path or a "~"
 * can be part of the name, so it stays stripped, and a whitespace-only string
 * stays "empty".
 *
 * The second half of this file pins the COST of the blocklist's realpath.
 * `guardBodyPathsMax(2000)` sanitizes a whole batch with `paths.map`, so a
 * per-path `realpathSync.native` puts up to 2,000 synchronous syscalls on the
 * event loop for one facts request. The cost has to scale with the number of
 * DIRECTORIES in the batch, not with the number of files in them — while still
 * catching a symlink leaf, which is where the actual bypass lives.
 *
 * Real fixtures in a real temp directory throughout: the bug is about what the
 * kernel accepts as a name, which no stub can tell us.
 */

/** mkdtemp fixture; the caller removes it (rm unlinks symlinks, never follows). */
async function mkTmp(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'tm-trim-'));
}

function rejection(fn: () => unknown): PathRejectedError {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof PathRejectedError, `expected PathRejectedError, got ${String(err)}`);
    return err as PathRejectedError;
  }
  assert.fail('expected sanitizePath to throw, it returned normally');
}

// Win32 strips trailing spaces and dots from a name inside the OS itself, so a
// fixture with one cannot be created there and the bug cannot occur there.
const noTrailingWs = process.platform === 'win32' && 'trailing whitespace is not a legal Windows filename';

test('a folder whose name ends in a space stays reachable', { skip: noTrailingWs }, async () => {
  const dir = await mkTmp();
  try {
    const real = path.join(dir, 'Screenshots ');
    await fsp.mkdir(real);

    const clean = sanitizePath(real);
    assert.equal(clean, real, 'sanitizePath must return the name the filesystem actually holds');
    assert.ok(fs.existsSync(clean), 'the returned path must exist — this is the 404 the bug caused');
    // Spell out why the trimmed answer is not "close enough": it names nothing.
    assert.ok(!fs.existsSync(real.trimEnd()), 'fixture is only meaningful if the trimmed spelling is absent');
    // Sanitized twice on most requests (pathGuard middleware, then the service).
    assert.equal(sanitizePath(clean), clean, 'sanitizePath must be idempotent');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('a folder whose name ends in a non-breaking space or a BOM stays reachable', { skip: noTrailingWs }, async () => {
  const dir = await mkTmp();
  try {
    // Both of these are inside String.prototype.trim's whitespace set and both
    // turn up in names pasted from a browser.
    for (const name of ['Rechnung ', 'Report﻿']) {
      const real = path.join(dir, name);
      await fsp.mkdir(real);
      const clean = sanitizePath(real);
      assert.equal(clean, real, `sanitizePath must preserve ${JSON.stringify(name)}`);
      assert.ok(fs.existsSync(clean), 'the returned path must exist');
      assert.equal(sanitizePath(clean), clean, 'sanitizePath must be idempotent');
    }
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('a "~" path keeps its trailing space through home expansion', { skip: noTrailingWs }, () => {
  // The reported case, without touching the user's home directory: expansion
  // must not be a second place the name gets quietly shortened.
  assert.equal(sanitizePath('~/Downloads/Screenshots '), path.join(os.homedir(), 'Downloads', 'Screenshots '));
});

test('leading whitespace is still stripped and blank input is still rejected', () => {
  const home = os.homedir();
  // Nothing before an absolute path or a "~" can be part of a name, so a
  // leading run of whitespace is always noise from a copy-paste.
  assert.equal(sanitizePath(`  \t${home}`), home);
  assert.equal(sanitizePath(' ~'), home);
  // Emptiness is still judged on the fully trimmed string, so a value that is
  // nothing but whitespace never reaches path.resolve (which would hand back
  // the process's cwd for it).
  for (const blank of ['', '   ', '\t\n', ' ', '﻿']) {
    assert.equal(rejection(() => sanitizePath(blank)).code, 'PATH_INVALID', JSON.stringify(blank));
  }
});

test('a symlink into a blocked directory is caught even after its parent was memoised', {
  skip: process.platform === 'win32' && 'creating a symlink needs privilege on Windows',
}, async () => {
  const dir = await mkTmp();
  try {
    // Prime whatever cache the canonicaliser keeps for this directory FIRST...
    assert.equal(sanitizePath(dir), dir);
    assert.equal(sanitizePath(path.join(dir, 'ordinary.txt')), path.join(dir, 'ordinary.txt'));

    // ...then plant the symlinks. A memo that answered from the primed entry
    // instead of looking at the new leaf would wave both of these through.
    const leaf = path.join(dir, 'innocent-looking');
    await fsp.symlink('/dev', leaf);
    assert.equal(rejection(() => sanitizePath(leaf)).code, 'PATH_BLOCKED');
    // Reached THROUGH the new link, where the link is an intermediate
    // component rather than the leaf.
    assert.equal(rejection(() => sanitizePath(path.join(leaf, 'null'))).code, 'PATH_BLOCKED');
    // And a child that does not exist: the deepest existing ancestor is still
    // the blocked directory.
    assert.equal(rejection(() => sanitizePath(path.join(leaf, 'nope'))).code, 'PATH_BLOCKED');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('realpath cost scales with directories, not with the size of the batch', async () => {
  const dir = await mkTmp();
  const native = fs.realpathSync.native;
  let calls = 0;
  try {
    const files: string[] = [];
    // A mix of existing and not-yet-existing leaves: both shapes go through
    // the blocklist check, and the ENOENT shape used to climb the whole path.
    for (let i = 0; i < 100; i++) {
      const p = path.join(dir, `file-${i}.bin`);
      await fsp.writeFile(p, 'x');
      files.push(p);
    }
    for (let i = 0; i < 100; i++) files.push(path.join(dir, `absent-${i}.bin`));

    (fs.realpathSync as unknown as { native: typeof native }).native = ((...args: Parameters<typeof native>) => {
      calls++;
      return native(...args);
    }) as typeof native;

    // Exactly what guardBodyPathsMax(2000) does with a facts request body.
    const cleaned = files.map((p) => sanitizePath(p));
    assert.deepEqual(cleaned, files, 'the batch must come back unchanged');

    // One directory, so a directory-proportional cost is a small constant. The
    // pre-fix code made one call per path (200) plus a climb per absent leaf.
    assert.ok(
      calls <= 4,
      `expected a per-directory number of realpath calls for ${files.length} paths, got ${calls}`,
    );
  } finally {
    (fs.realpathSync as unknown as { native: typeof native }).native = native;
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
