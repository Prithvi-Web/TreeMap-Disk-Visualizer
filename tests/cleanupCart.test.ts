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
 * Phase 4 §4.1 / §4.2 — the cart's goal meter, and where a cart button is
 * allowed to appear.
 *
 * The settings half is ordinary validation. The markup half is the part worth
 * a test: §4.2 says an app's **cache** components get a cart button and its
 * data does not, and Games gets one on the **shader cache only**. Those are
 * safety guarantees stated as rendering rules, and a rendering rule with no
 * test is a rule until someone edits the template.
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

/**
 * Slice between two anchors, insisting both exist and the slice is non-empty.
 *
 * The handoff's trap 6, paid for three times: `indexOf(end)` without a start
 * offset can find an earlier occurrence and slice backwards to nothing, and a
 * silently empty slice makes every assertion over it pass.
 */
function slice(src: string, from: string, to: string): string {
  const start = src.indexOf(from);
  assert.notEqual(start, -1, `anchor not found: ${from}`);
  const end = src.indexOf(to, start + from.length);
  assert.notEqual(end, -1, `end anchor not found after ${from}: ${to}`);
  const out = src.slice(start, end);
  assert.ok(out.length > 100, `the slice ${from} → ${to} is suspiciously short`);
  return out;
}

test('the meter is hidden outright when no target is set, rather than showing zero', () => {
  const start = INDEX.indexOf('function renderCartGoal');
  assert.notEqual(start, -1, 'renderCartGoal exists');
  const body = INDEX.slice(start, INDEX.indexOf('async function renderCart', start));
  assert.ok(body.length > 200, 'the renderCartGoal slice is non-empty');
  // The beams round added the one-shot's seed reset to this exact path: a
  // hidden meter must also forget its crossing state, or re-adding a target
  // could pulse off a stale edge.
  assert.match(body, /if \(!cartGoalBytes\) \{ host\.hidden = true; fxGoalPulseSync\(null\); return; \}/);
});

/**
 * The "target met" pulse must mark a crossing the USER caused, never a boot.
 *
 * Boot order defeated the one-shot's null seed: `loadCartGoal` resolves before
 * any scan does, so `adoptCartGoal` painted the meter with a staged total of
 * ZERO — zero only because `cartNode()` cannot resolve a size yet — and that
 * seeded the crossing state to "below target". When the scan landed and the
 * restored cart's real total turned out to be over the target, the one-shot
 * read false → true and fired. The user staged nothing; they reopened the app.
 */
function loadRenderCartGoal(scanId: string | null, goalBytes: number | null) {
  const start = INDEX.indexOf('function renderCartGoal');
  const end = INDEX.indexOf('\n}', start);
  const src = INDEX.slice(start, end + 2);
  const seen: Array<boolean | null> = [];
  const el = () => ({ hidden: false, classList: { toggle() {} }, style: {}, innerHTML: '', setAttribute() {} });
  const els: Record<string, ReturnType<typeof el>> = {};
  const fn = new Function('$', 'fxGoalPulseSync', 'escapeHtml', 'formatBytes', 'state', 'cartGoalBytes',
    `${src}; return renderCartGoal;`)(
    (id: string) => (els[id] ??= el()),
    (met: boolean | null) => { seen.push(met); },
    (s: string) => s, (n: number) => `${n} B`,
    { scanId }, goalBytes) as (staged: number) => void;
  return { render: fn, seen };
}

test('the target-met pulse is told "unknown", not "below", while no scan can size the cart', () => {
  // Boot: the goal arrives before the scan does. The zero it renders is an
  // artefact of unresolved nodes, so it must not become the baseline.
  const boot = loadRenderCartGoal(null, 5e9);
  boot.render(0);
  assert.deepEqual(boot.seen, [null], 'no scan means the staged total is unknown, not below target');

  // With a scan loaded the meter reports the truth in both directions.
  const live = loadRenderCartGoal('scan-1', 5e9);
  live.render(1e9);
  live.render(6e9);
  assert.deepEqual(live.seen, [false, true], 'a real below → met crossing is still reported');
});

/* ══════════════════════ §4.2 where a cart button may appear ══════════════════════ */

/**
 * The Apps breakdown lists an application's own bundle and its user data
 * beside its caches. §4.2 allows a cart button on the cache components only —
 * "Clear caches safely" has always meant cache and logs, and a per-row button
 * that quietly widened that to Data would be the worst kind of regression:
 * one click, no confirmation, and the file *is* the data.
 */
test('Apps offers a cart button on cache and log rows only', () => {
  const start = INDEX.indexOf('function renderApps');
  assert.notEqual(start, -1, 'renderApps exists');
  const body = slice(INDEX, 'function renderApps', '/* ───────────────────────────── Duplicates view');
  assert.match(body, /APP_CART_CATEGORIES/, 'the allowed categories are named, not inlined');
  assert.match(body, /APP_CART_CATEGORIES\.has\(loc\.category\)/, 'the button is gated on the category');
  // And the gate itself admits exactly cache and logs.
  assert.match(INDEX, /const APP_CART_CATEGORIES = new Set\(\['cache', 'logs'\]\)/);
});

test('Games offers a cart button on the shader cache only', () => {
  const start = INDEX.indexOf('function gameCartRows');
  assert.notEqual(start, -1, 'gameCartRows exists');
  const body = slice(INDEX, 'function gameCartRows', 'async function loadGames');
  assert.match(body, /c\.kind === 'shaderCache'/, 'only shader-cache components are listed');
  // Nothing else in the Games renderer may hand out a cart button.
  const games = slice(INDEX, 'function renderGames', 'function clearShaderCaches');
  assert.ok(games.includes('gameCartRows(t)'), 'the shader rows are actually rendered');
  assert.ok(!games.includes('data-cart-add'), 'the title rows themselves carry no cart button');
});

test('advisory Smart Suggestion groups get no cart button at all — not a disabled one', () => {
  const start = INDEX.indexOf('function renderSmartGroups');
  assert.notEqual(start, -1);
  const body = INDEX.slice(start, INDEX.indexOf('smartSortPills', start));
  assert.ok(body.length > 500, 'the renderSmartGroups slice is non-empty');
  assert.match(body, /\$\{adv \? '' : `<button class="icon-btn" data-cart-add=/,
    'an advisory row renders an empty string where the button would be');
});

test('Security findings have no cart path anywhere', () => {
  // §4.2: security findings have no delete path in the app at all, so they get
  // no cart button — not a disabled one, none.
  const body = slice(INDEX, 'function renderSecurity', 'function confirmRelocateSecret');
  assert.ok(!body.includes('data-cart-add'), 'security findings are never stageable for deletion');
});

/* ══════════════════════ the cart list is paged, and says so ══════════════════════ */

test('the cart draws a page of rows, not the whole cart', () => {
  // Measured: rebuilding the list is 44.1 ms for 1,000 rows, and it is rebuilt
  // on every cart click — right at §2.5's 50 ms main-thread budget, and past
  // it above ~1,100 items. Staging a 1,000-hit query is one click away, so
  // that cart is not hypothetical. Paged: 8.2 ms.
  assert.match(INDEX, /const CART_PAGE = 200;/);
  const body = slice(INDEX, 'async function renderCart', 'async function cartTrashAll');
  assert.match(body, /all\.slice\(0, cartShown\)/, 'only a page is drawn');
  assert.match(body, /more staged, not listed here/, '§2.4: a cap that is not stated is a lie about the list');
  assert.match(body, /data-cart-show-all/, 'and the rest can be asked for');
});

test('every cart total is computed from the whole cart, never from the drawn rows', () => {
  // The paging must not reach the numbers. If it ever did, the dock would
  // under-report what is staged — in the one panel whose job is to say how
  // much is about to be deleted.
  const body = slice(INDEX, 'async function renderCart', 'async function cartTrashAll');
  assert.match(body, /const n = state\.cart\.size;/, 'the count is the Set size');
  assert.match(body, /const total = cartTotalBytes\(\);/, 'and the total is over the Set');
  const totals = INDEX.slice(INDEX.indexOf('function cartTotalBytes'), INDEX.indexOf('function cartToggle'));
  assert.match(totals, /\[\.\.\.state\.cart\]\.reduce/, 'cartTotalBytes reads the Set, not the DOM');
});

test('showing all is delegated, like every other cart button', () => {
  // A listener bound per render is attached to an element the next render
  // throws away. That worked until something re-rendered between the bind and
  // the click — which is exactly what happened while measuring this.
  const body = slice(INDEX, "const undo = e.target.closest('[data-cart-undo]')", 'renderCart(); // reflect any persisted cart on load');
  assert.match(body, /closest\('\[data-cart-show-all\]'\)/);
  assert.match(body, /cartShown = Infinity/);
});

test('a commit or a clear resets the page, because it is a different list now', () => {
  const clear = slice(INDEX, 'function cartClear()', 'Sync the +/✓ state');
  assert.match(clear, /cartShown = CART_PAGE/);
  const commit = slice(INDEX, 'async function cartExecuteCommit', 'function cartCommitSummary');
  assert.match(commit, /cartShown = CART_PAGE/);
});

/* ══════════════════════ §4.1 the LIVE target: one honesty policy ══════════════════════ */

/**
 * QA item 5: saving a new cleanup target in Settings left the in-memory
 * `cartGoalBytes` stale, so the dock meter showed the old target until a
 * reload. The fix is one function — `adoptCartGoal` — that boot, every
 * Settings paint (open AND save) and the clear button all ride, so the
 * server-side normalization tested above meets exactly one client policy.
 */
function loadAdoptCartGoal() {
  const start = INDEX.indexOf('function adoptCartGoal(');
  assert.notEqual(start, -1, 'adoptCartGoal exists');
  const end = INDEX.indexOf('\n}', start);
  assert.notEqual(end, -1, 'adoptCartGoal closes');
  const src = INDEX.slice(start, end + 2);
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function(`
    let cartGoalBytes = 'never-adopted';
    const rendered = [];
    function renderCartGoal(staged) { rendered.push(staged); }
    function cartTotalBytes() { return 4096; }
    ${src}
    return { adopt: adoptCartGoal, goal: () => cartGoalBytes, rendered };
  `)() as { adopt: (v: unknown) => number | null; goal: () => unknown; rendered: number[] };
}

test('adoptCartGoal takes the saved target live and repaints the meter — no reload', () => {
  const h = loadAdoptCartGoal();
  assert.equal(h.adopt(20 * 1024 ** 3), 20 * 1024 ** 3);
  assert.equal(h.goal(), 20 * 1024 ** 3, 'the in-memory target follows the save');
  assert.deepEqual(h.rendered, [4096], 'the goal meter repaints against the staged total');
});

test('adoptCartGoal keeps the boot path honesty policy: nonsense is no target', () => {
  const h = loadAdoptCartGoal();
  for (const bad of [null, undefined, 0, -1, NaN, '50', {}]) {
    assert.equal(h.adopt(bad), null, `${JSON.stringify(bad)} is no target`);
    assert.equal(h.goal(), null);
  }
  assert.equal(h.rendered.length, 7, 'every adoption repaints, even to hide');
});

test('boot, the Settings paints and the clear button all ride adoptCartGoal', () => {
  const load = CODE.slice(CODE.indexOf('async function loadCartGoal'), CODE.indexOf('function renderCartGoal'));
  assert.ok(load.length > 100, 'the loadCartGoal slice is non-empty');
  assert.match(load, /adoptCartGoal\(s\.cleanupGoalBytes\)/, 'boot adopts the fetched answer');
  assert.match(load, /adoptCartGoal\(null\)/, 'a failed fetch hides the meter, never a stale number');
  const fields = CODE.slice(CODE.indexOf('function renderCleanupGoalFields'), CODE.indexOf('function collectCleanupGoal'));
  assert.ok(fields.length > 100, 'the renderCleanupGoalFields slice is non-empty');
  assert.match(fields, /adoptCartGoal\(settingsData\.cleanupGoalBytes\)/,
    'every Settings paint — open AND save — adopts the server answer');
  const clear = CODE.slice(CODE.indexOf("$('cleanupGoalClear')"), CODE.indexOf('function renderReclaimWeights'));
  assert.match(clear, /adoptCartGoal\(null\)/, 'clearing the box hides the meter immediately');
});

test('the save path repaints the target from the PUT response, not the form', () => {
  const save = CODE.slice(CODE.indexOf("$('settingsSaveBtn')"), CODE.indexOf('let lastNotifPoll'));
  assert.ok(save.length > 200, 'the save handler slice is non-empty');
  const put = save.indexOf("await api('/api/settings'");
  const repaint = save.indexOf('renderCleanupGoalFields()');
  assert.ok(put !== -1, 'the save PUTs to /api/settings');
  assert.ok(repaint !== -1, 'the save repaints the goal fields');
  assert.ok(put < repaint, 'after the server answered — the response is the truth, the form is a request');
});
