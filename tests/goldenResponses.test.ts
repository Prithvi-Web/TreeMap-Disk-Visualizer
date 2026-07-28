import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildGoldenTree, captureGolden } from './fixtures/goldenHarness';
import { createApp } from '../src/server';

/**
 * The frontend-parity proof for the packed-store rewrite (§1.1 of the brief):
 * every read endpoint the UI consumes must produce byte-identical JSON to
 * the pre-rewrite server.
 *
 * tests/fixtures/golden/responses.json was recorded by running the SAME
 * harness (fixture builder, capture driver, normalizer) against the
 * pre-rewrite baseline — commit 16ae5b8, v2.3.2 — via a git worktree. This
 * test replays it against the current server and compares the serialized
 * bytes per endpoint: structure, names, sizes, mtimes, flags, child order
 * and property order all included. Only genuinely volatile values (scanId,
 * timestamps, engine label, atime values, the fixture's absolute path) are
 * normalized on BOTH sides by the shared harness.
 */

// macOS-only by construction, not by neglect: the goldens were recorded from
// the pre-rewrite baseline ON macOS, and byte-identity is only meaningful
// against the filesystem that recorded them. Children ride in readdir order,
// which is name-deterministic on APFS but hash-ordered on ext4 and different
// again on NTFS (which also flips path separators) — so on other OSes the
// bytes differ for reasons that say nothing about the code. The rewrite the
// goldens guard is covered cross-OS by the rest of the suite; the fixture
// root is /private/tmp because that is what the recorded baseline used.
test('every API response is byte-identical to the pre-rewrite baseline', { skip: process.platform !== 'darwin' && 'goldens are recorded against APFS readdir order and macOS paths' }, async () => {
  const golden = JSON.parse(
    await fsp.readFile(path.join(__dirname, 'fixtures', 'golden', 'responses.json'), 'utf8'),
  ) as Record<string, unknown>;

  const treeRoot = '/private/tmp/treemap-golden-fixture';
  await buildGoldenTree(treeRoot);
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'treemap-golden-data-'));
  try {
    const current = await captureGolden(
      createApp,
      path.join(__dirname, '..', 'public'),
      treeRoot,
      dataDir,
    );

    assert.deepEqual(Object.keys(current).sort(), Object.keys(golden).sort(), 'endpoint coverage drifted');
    for (const key of Object.keys(golden)) {
      const want = JSON.stringify(golden[key]);
      const got = JSON.stringify(current[key]);
      assert.equal(got, want, `response bytes drifted for "${key}"`);
    }
  } finally {
    delete process.env.TREEMAP_NO_GDU;
    delete process.env.TREEMAP_DATA_DIR;
    await fsp.rm(dataDir, { recursive: true, force: true });
    await fsp.rm(treeRoot, { recursive: true, force: true });
  }
});
