import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Isolated app-data, before anything that reads settings is imported. Without
// this the suite rewrites the user's real settings.json — including their
// cleanup target, which is the very field under test here.
process.env.TREEMAP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-cart-test-'));

import { getSettings, updateSettings } from '../src/services/settings';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDEX = readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

/**
 * `INDEX` with every comment removed — HTML, block and line.
 *
 * The same reason `frontendContract.test.ts` has `appCode()`: a rule stated in
 * a comment necessarily contains the words the rule forbids, and a test that
 * fails because the code was explained is worse than no test.
 */
const CODE = INDEX
  .replace(/<!--[\s\S]*?-->/g, ' ')
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');

/**
 * Phase 4 §4.1 — the cleanup cart's optional target and its meter.
 *
 * The settings half is ordinary validation. The markup half is the part worth
 * a test: §4.1 rules out gamification by name, and "we did not build a reward
 * loop" is a claim that only stays true if something checks.
 */

/* ══════════════════════ §4.1 the target ══════════════════════ */

test('no target is the default, and it is null rather than zero', async () => {
  const settings = await getSettings();
  assert.equal(settings.cleanupGoalBytes, null);
});

test('a target round-trips, and null clears it', async () => {
  const set = await updateSettings({ cleanupGoalBytes: 50 * 1024 ** 3 });
  assert.equal(set.cleanupGoalBytes, 50 * 1024 ** 3);
  const cleared = await updateSettings({ cleanupGoalBytes: null });
  assert.equal(cleared.cleanupGoalBytes, null);
});

test('nonsense is no target, never a number nobody typed', async () => {
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 'fifty', {}, [], true]) {
    const out = await updateSettings({ cleanupGoalBytes: bad });
    assert.equal(out.cleanupGoalBytes, null, `${JSON.stringify(bad)} must clear the target`);
  }
});

test('an absurd target is capped rather than stored, so the meter can always move', async () => {
  const out = await updateSettings({ cleanupGoalBytes: 1e30 });
  assert.equal(out.cleanupGoalBytes, 1024 ** 5);
  await updateSettings({ cleanupGoalBytes: null });
});

test('saving an unrelated setting leaves the target alone', async () => {
  await updateSettings({ cleanupGoalBytes: 12 * 1024 ** 3 });
  const after = await updateSettings({ watchIdleMinutes: 7 });
  assert.equal(after.cleanupGoalBytes, 12 * 1024 ** 3);
  assert.equal(after.watchIdleMinutes, 7);
  await updateSettings({ cleanupGoalBytes: null });
});

test('a fractional byte count is rounded, not stored as a fraction', async () => {
  const out = await updateSettings({ cleanupGoalBytes: 1234.6 });
  assert.equal(out.cleanupGoalBytes, 1235);
  await updateSettings({ cleanupGoalBytes: null });
});

/* ══════════════════════ §4.1 the meter is a meter ══════════════════════ */

test('the goal meter is a progress bar and nothing else — no gamification', () => {
  assert.ok(INDEX.includes('id="cartGoal"'), 'the meter exists in the cart dock');
  assert.ok(INDEX.includes('id="cartGoalFill"') && INDEX.includes('id="cartGoalLine"'));
  // §4.1 names these specifically. A grep over the *code* is crude and exactly
  // right: the rule is that none of this is ever built, so the names are what
  // to check — over CODE, because the comments explaining the rule say them.
  const lower = CODE.toLowerCase();
  for (const banned of ['confetti', 'streak', 'achievement', 'reward']) {
    assert.ok(!lower.includes(banned), `"${banned}" has no place in this product`);
  }
});

test('the meter is hidden outright when no target is set, rather than showing zero', () => {
  const start = INDEX.indexOf('function renderCartGoal');
  assert.notEqual(start, -1, 'renderCartGoal exists');
  const body = INDEX.slice(start, INDEX.indexOf('async function renderCart', start));
  assert.ok(body.length > 200, 'the renderCartGoal slice is non-empty');
  assert.match(body, /if \(!cartGoalBytes\) \{ host\.hidden = true; return; \}/);
});
