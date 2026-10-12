import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';

// Isolated app-data, before anything that reads settings is imported. Without
// this the suite rewrites the user's real settings.json — including their
// cleanup target, which is the very field under test here.
import { isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-cart-test-');

import { getSettings, updateSettings } from '../src/services/settings';

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
  // Through tmCartRoots, which reads the Set and drops a path whose folder is
  // also staged, so nothing is counted twice (D60).
  assert.match(totals, /tmCartRoots\(\)\.reduce/, 'cartTotalBytes reads the Set, not the DOM');
  const roots = INDEX.slice(INDEX.indexOf('function tmCartRoots'), INDEX.indexOf('function tmBuildPreview'));
  assert.match(roots, /const paths = \[\.\.\.state\.cart\];/, 'and tmCartRoots reads the whole Set');
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
 * reload. The fix is one function — `adoptCartGoal` — that boot and every
 * Settings paint (open AND save) ride, so the server-side normalization tested
 * above meets exactly one client policy. The clear button only empties the
 * box: like every other field it takes effect on Save (review F1.10).
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
    const unknowns = [];
    function renderCartGoal(staged, unknown) { rendered.push(staged); unknowns.push(unknown); }
    function cartTotalBytes() { return 4096; }
    function cartUnknownCount() { return 1; }
    ${src}
    return { adopt: adoptCartGoal, goal: () => cartGoalBytes, rendered, unknowns };
  `)() as { adopt: (v: unknown) => number | null; goal: () => unknown; rendered: number[]; unknowns: unknown[] };
}

test('adoptCartGoal takes the saved target live and repaints the meter — no reload', () => {
  const h = loadAdoptCartGoal();
  assert.equal(h.adopt(20 * 1024 ** 3), 20 * 1024 ** 3);
  assert.equal(h.goal(), 20 * 1024 ** 3, 'the in-memory target follows the save');
  assert.deepEqual(h.rendered, [4096], 'the goal meter repaints against the staged total');
  assert.deepEqual(h.unknowns, [1], 'with the count of staged items it cannot size, so a saved target never reads an unsized cart as 0 B (B06 review)');
});

test('adoptCartGoal keeps the boot path honesty policy: nonsense is no target', () => {
  const h = loadAdoptCartGoal();
  for (const bad of [null, undefined, 0, -1, NaN, '50', {}]) {
    assert.equal(h.adopt(bad), null, `${JSON.stringify(bad)} is no target`);
    assert.equal(h.goal(), null);
  }
  assert.equal(h.rendered.length, 7, 'every adoption repaints, even to hide');
});

test('boot and every Settings paint ride adoptCartGoal; the clear button waits for Save', () => {
  const load = CODE.slice(CODE.indexOf('async function loadCartGoal'), CODE.indexOf('function renderCartGoal'));
  assert.ok(load.length > 100, 'the loadCartGoal slice is non-empty');
  assert.match(load, /adoptCartGoal\(s\.cleanupGoalBytes\)/, 'boot adopts the fetched answer');
  assert.match(load, /adoptCartGoal\(null\)/, 'a failed fetch hides the meter, never a stale number');
  const fields = CODE.slice(CODE.indexOf('function renderCleanupGoalFields'), CODE.indexOf('function collectCleanupGoal'));
  assert.ok(fields.length > 100, 'the renderCleanupGoalFields slice is non-empty');
  assert.match(fields, /adoptCartGoal\(settingsData\.cleanupGoalBytes\)/,
    'every Settings paint — open AND save — adopts the server answer');
  const clear = CODE.slice(CODE.indexOf("$('cleanupGoalClear')"), CODE.indexOf('function renderReclaimWeights'));
  assert.ok(clear.length > 50, 'the clear handler slice is non-empty');
  assert.doesNotMatch(clear, /adoptCartGoal/,
    'clearing the box is an edit Save keeps — the meter follows the save, so "Close without saving" leaves it as it was (review F1.10)');
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

/* ══════ B29 + B06: what the cart says it frees, and what it cannot size ══════ */

/** `function name(…) {…}` from the built page, by brace matching. */
function fnSource(name: string): string {
  let start = INDEX.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} is in the built page`);
  if (INDEX.slice(start - 6, start) === 'async ') start -= 6;
  let depth = 0;
  for (let i = INDEX.indexOf('{', INDEX.indexOf(')', start)); i < INDEX.length; i++) {
    if (INDEX[i] === '{') depth++;
    else if (INDEX[i] === '}' && --depth === 0) return INDEX.slice(start, i + 1);
  }
  return assert.fail(`${name} never closes`);
}

type Node = { name: string; path: string; size: number };

/** Run the page's own renderCart over a cart; what the footer, the pill and the list say. */
async function cartShows(staged: string[], nodes: Record<string, Node>) {
  const els: Record<string, { innerHTML: string; textContent: string; title: string; classList: { toggle(): void } }> = {};
  const $ = (id: string) => (els[id] ??= { innerHTML: '', textContent: '', title: '', classList: { toggle() {} } });
  const goal: unknown[][] = [];
  const deps: Record<string, unknown> = {
    $, state: { cart: new Set(staged) },
    ensureNodes: async () => {}, fxCartPulseSync: () => {}, cartDockToggle: () => {},
    renderCartGoal: (...args: unknown[]) => { goal.push(args); },
    nodeFor: (p: string) => nodes[p] ?? null,
    countUp: (el: { textContent: string }, v: number, fmt: (n: number) => string) => { el.textContent = fmt(v); },
    FxNum: {
      rollText: (el: { textContent: string }, t: string) => { el.textContent = t; },
      rollHtml: (el: { innerHTML: string }, h: string) => { el.innerHTML = h; },
    },
    formatBytes: (n: number) => `${n} B`, formatCount: String, escapeHtml: (s: unknown) => String(s), icon: () => '',
  };
  const names = ['renderCart', 'cartTotalBytes', 'cartKnownPaths', 'cartUnknownCount', 'cartNode', 'tmCartRoots', 'tmParentPath'];
  const keys = Object.keys(deps);
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const render = new Function(...keys, `let cartShown = 200;\n${names.map(fnSource).join('\n')}\nreturn renderCart;`)(
    ...keys.map((k) => deps[k]),
  ) as () => Promise<void>;
  await render();
  return { foot: els.cartFootTotal!.innerHTML, pill: els.cartTabTotal!.textContent, pillTitle: els.cartTabTotal!.title, goal };
}

type GoalEl = {
  hidden: boolean; met: boolean | undefined; style: { width: string }; innerHTML: string; label: string;
  classList: { toggle(c: string, on: boolean): void }; setAttribute(k: string, v: string): void;
};

/** Run the page's own renderCartGoal for a cart of `cartSize` items, `unknown` of them unsized here; what the meter shows. */
function goalShows(staged: number, unknown: number, cartSize: number, target = 50_000_000_000) {
  const els: Record<string, GoalEl> = {};
  const $ = (id: string): GoalEl => {
    if (!els[id]) {
      const e: GoalEl = {
        hidden: true, met: undefined, style: { width: '' }, innerHTML: '', label: '',
        classList: { toggle: (_c, on) => { e.met = on; } }, setAttribute: (_k, v) => { e.label = v; },
      };
      els[id] = e;
    }
    return els[id];
  };
  const pulses: Array<boolean | null> = [];
  const cart = new Set(Array.from({ length: cartSize }, (_, i) => `/c/item${i}`));
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const render = new Function('$', 'fxGoalPulseSync', 'escapeHtml', 'formatBytes', 'state', 'cartGoalBytes',
    `${fnSource('renderCartGoal')}\nreturn renderCartGoal;`)(
    $, (met: boolean | null) => { pulses.push(met); }, (s: unknown) => String(s), (n: number) => `${n} B`,
    { scanId: 's1', cart }, target,
  ) as (staged: number, unknown: number) => void;
  render(staged, unknown);
  return { line: els.cartGoalLine!.innerHTML, label: els.cartGoal!.label, met: els.cartGoal!.met, pulses };
}

const MOV = { name: 'holiday-4k.mov', path: '/c/Videos/holiday-4k.mov', size: 3_000_000_000 };
const DMG = { name: 'Installer.dmg', path: '/c/Installer.dmg', size: 2_000_000_000 };

test('the cart promises what a move to the Trash does — up to its size, once the Trash is emptied — never "Reclaims" (B29)', async () => {
  // QA: "Reclaims 6.5 GB" for three sparse files that occupy 0 bytes; D54 had
  // already reworded Clean Up to say this, and the cart said it more strongly.
  const shown = await cartShows([MOV.path, DMG.path], { [MOV.path]: MOV, [DMG.path]: DMG });
  assert.doesNotMatch(shown.foot, /Reclaims/, `no promise the Trash has not kept: ${shown.foot}`);
  assert.match(shown.foot, /Up to <b>5000000000 B<\/b>, freed when you empty the Trash/, shown.foot);
  assert.equal(shown.pill, '5000000000 B', 'the pill still shows what is staged');
});

test('staged items the scan does not hold are not counted as 0 B — they are named as unknown (B06)', async () => {
  // QA: two node_modules staged from another scan read "Reclaims 0 B" and the pill "2 · 0 B".
  const other = ['/elsewhere/a/node_modules', '/elsewhere/b/node_modules'];
  const none = await cartShows(other, {});
  assert.doesNotMatch(none.foot, /0 B/, `a size nobody measured is not a zero: ${none.foot}`);
  assert.match(none.foot, /2 items not in this scan — size unknown/, none.foot);
  assert.equal(none.pill, '—', 'nor does the pill read 0 B');
  assert.match(none.pillTitle, /size unknown/, 'and it says why on hover');

  const some = await cartShows([MOV.path, other[0]!], { [MOV.path]: MOV });
  assert.match(some.foot, /Up to <b>3000000000 B<\/b>, freed when you empty the Trash · 1 not in this scan, not counted/, some.foot);
  assert.equal(some.pill, '3000000000 B+', 'the pill marks the total as a floor');
  assert.match(some.pillTitle, /1 not in this scan, not counted/);

  const all = await cartShows([MOV.path], { [MOV.path]: MOV });
  assert.equal(all.pill, '3000000000 B', 'no mark when everything is sized');
  assert.equal(all.pillTitle, '');
});

test('the cleanup-target meter does not count an unsized staged item as 0 B: unknown when none is sized, a floor when some are (B06 review)', async () => {
  // Review: the pill read "—" and the footer "2 items not in this scan — size
  // unknown" while the meter beside them read "0 B of 50 GB staged 0%".
  const none = goalShows(0, 2, 2);
  assert.doesNotMatch(none.line, /<b>0 B<\/b>|>0%</, `a size nobody measured is not a zero: ${none.line}`);
  assert.match(none.line, /size unknown/, none.line);
  assert.doesNotMatch(none.label, /: 0 B of|0 percent/, `nor for a screen reader: ${none.label}`);
  assert.match(none.label, /staged size is unknown/, none.label);
  assert.equal(none.met, false, 'an unknown is not "met"');
  assert.deepEqual(none.pulses, [null], 'nor "below target" for the one-shot pulse');

  const some = goalShows(3_000_000_000, 1, 2);
  assert.match(some.line, /<b>3000000000 B\+<\/b> of 50000000000 B staged/, `the known part is marked a floor: ${some.line}`);
  assert.match(some.label, /Cleanup target: at least 3000000000 B of 50000000000 B staged, 6 percent/, some.label);

  const all = goalShows(3_000_000_000, 0, 1);
  assert.match(all.line, /<b>3000000000 B<\/b> of 50000000000 B staged/, `no mark when everything is sized: ${all.line}`);
  assert.match(all.label, /Cleanup target: 3000000000 B of 50000000000 B staged, 6 percent/, all.label);

  // renderCart hands the meter the same unknown count the pill and footer use.
  const other = ['/elsewhere/a/node_modules', '/elsewhere/b/node_modules'];
  assert.deepEqual((await cartShows(other, {})).goal, [[0, 2]], 'all unsized: the meter is told 2 unknown');
  assert.deepEqual((await cartShows([MOV.path, other[0]!], { [MOV.path]: MOV })).goal, [[3_000_000_000, 1]], 'one of two unsized');
});

test('a known staged file under a staged folder this scan does not hold is counted — the unknown folder hides nothing (B06 review)', async () => {
  // Review: Downloads staged from another scan, and Downloads/Projects/a.iso
  // staged from this one. The total folded a.iso into the folder nobody could
  // size and read "Up to 0 B", while the commit still sends a.iso.
  const DOWNLOADS = '/c/Downloads';
  const ISO = { name: 'a.iso', path: '/c/Downloads/Projects/a.iso', size: 400 };
  const shown = await cartShows([DOWNLOADS, ISO.path], { [ISO.path]: ISO });
  assert.match(shown.foot, /Up to <b>400 B<\/b>, freed when you empty the Trash · 1 not in this scan, not counted/, shown.foot);
  assert.equal(shown.pill, '400 B+', 'the pill counts a.iso, marked a floor for the folder it cannot size');
  assert.deepEqual(shown.goal, [[400, 1]], 'and the target meter is handed the same figure');

  // A folder the scan does hold still counts a file inside it once (D60).
  const held = await cartShows([DOWNLOADS, ISO.path], { [ISO.path]: ISO, [DOWNLOADS]: { name: 'Downloads', path: DOWNLOADS, size: 1_000 } });
  assert.equal(held.pill, '1000 B', 'a.iso is inside Downloads, already in its 1,000 bytes');
});

test('after a commit, the cart says where the files went, not that space was recovered (B29)', () => {
  const els: Record<string, { innerHTML: string; hidden: boolean; classList: { add(): void } }> = {};
  const deps: Record<string, unknown> = {
    $: (id: string) => (els[id] ??= { innerHTML: '', hidden: false, classList: { add() {} } }),
    formatCount: String, formatBytes: (n: number) => `${n} B`, escapeHtml: (s: unknown) => String(s), icon: () => '',
    baseName: (p: string) => path.basename(p),
  };
  const keys = Object.keys(deps);
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const run = new Function(...keys, `let confirmPaths = []; let onConfirmTrash = null;\n${fnSource('cartCommitSummary')}\nreturn cartCommitSummary;`)(
    ...keys.map((k) => deps[k]),
  ) as (r: unknown) => void;
  const summary = (r: unknown): string => { run(r); return els.confirmText!.innerHTML; };
  const html = summary({ trashed: ['/c/a', '/c/b'], bytesFreed: 6_500_000_000, runId: 'r1' });
  assert.doesNotMatch(html, /recovered/i, `nothing is recovered by a move to the Trash: ${html}`);
  assert.match(html, /Moved <b>2<\/b> items \(<b>6500000000 B<\/b>\) to the Trash/, html);
  assert.match(html, /comes back when you empty the Trash, less what the Time Capsule keeps so this can be undone/, html);
  const bare = summary({ trashed: ['/c/a'], bytesFreed: 10, capsuleUnavailable: 'No capsule in a portable session.' });
  assert.doesNotMatch(bare, /less what the Time Capsule keeps/, 'no capsule copy is mentioned when none was made');
});
