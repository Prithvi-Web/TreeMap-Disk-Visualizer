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
  assert.ok(!games.includes('data-cart-add') && !games.includes('cartButtonHtml('), 'the title rows themselves carry no cart button');
});

test('advisory Smart suggestion groups get no cart button at all — not a disabled one', () => {
  const start = INDEX.indexOf('function renderSmartGroups');
  assert.notEqual(start, -1);
  const body = INDEX.slice(start, INDEX.indexOf('smartSortPills', start));
  assert.ok(body.length > 500, 'the renderSmartGroups slice is non-empty');
  assert.match(body, /\$\{adv \? '' : cartButtonHtml\(/,
    'an advisory row renders an empty string where the button would be');
});

test('Security findings have no cart path anywhere', () => {
  // §4.2: security findings have no delete path in the app at all, so they get
  // no cart button — not a disabled one, none.
  const body = slice(INDEX, 'function renderSecurity', 'function confirmRelocateSecret');
  assert.ok(!body.includes('data-cart-add') && !body.includes('cartButtonHtml('), 'security findings are never stageable for deletion');
});

/* ══════════════════════ D11 — a cart toggle says what pressing it does ══════════════════════ */

type Toggle = { attrs: Record<string, string>; cls: Set<string>; innerHTML: string; dataset: Record<string, string> };

/** The page's own cart-toggle helpers over a cart holding `staged`, and a button parsed out of the markup they write. */
function cartToggles(staged: string[]) {
  const state = { cart: new Set(staged), view: 'dashboard' };
  const deps: Record<string, unknown> = {
    state,
    icon: (name: string) => `<svg data-icon="${name}"></svg>`,
    updateDupToolbar: () => {}, document: { querySelectorAll: () => [] },
  };
  const keys = Object.keys(deps);
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const page = new Function(...keys, `${['escapeHtml', 'cartButtonHtml', 'cartButtonTitle', 'cartButtonLabel', 'refreshCartButtons'].map(fnSource).join('\n')}
    return { cartButtonHtml, refreshCartButtons };`)(...keys.map((k) => deps[k])) as {
    cartButtonHtml: (path: string, name: string, px?: number) => string; refreshCartButtons: (roots: unknown[]) => void;
  };
  /** A button as a browser would build it from the markup: its attributes, classes, data-* and content. */
  const parse = (html: string): Toggle => {
    const open = /^<button([^>]*)>([\s\S]*)<\/button>$/.exec(html.trim());
    assert.ok(open, `one button is written: ${html}`);
    const attrs: Record<string, string> = {};
    for (const m of open![1].matchAll(/([\w-]+)="([^"]*)"/g)) attrs[m[1]] = m[2].replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    const dataset: Record<string, string> = {};
    for (const [k, v] of Object.entries(attrs)) if (k.startsWith('data-')) dataset[k.slice(5).replace(/-(\w)/g, (_s, c: string) => c.toUpperCase())] = v;
    return { attrs, cls: new Set((attrs.class || '').split(/\s+/).filter(Boolean)), innerHTML: open![2], dataset };
  };
  /** refreshCartButtons over that one button, as the page walks a scope. */
  const refresh = (b: Toggle) => page.refreshCartButtons([{
    querySelectorAll: () => [{
      getAttribute: (k: string) => b.attrs[k] ?? null, setAttribute: (k: string, v: string) => { b.attrs[k] = v; },
      dataset: new Proxy(b.dataset, { set: (t, k: string, v: string) => { t[k] = v; b.attrs['data-' + k] = v; return true; } }),
      classList: { toggle: (c: string, on: boolean) => { if (on) b.cls.add(c); else b.cls.delete(c); } },
      set innerHTML(h: string) { b.innerHTML = h; }, get innerHTML() { return b.innerHTML; },
    }],
  }]);
  return { state, html: page.cartButtonHtml, parse, refresh };
}

test('a cart toggle tells a screen reader what pressing it does: "Remove … from Clean Up cart" on a staged item (QA third pass D11)', () => {
  // QA third pass D11: on a staged item the tooltip said "Remove from cleanup
  // cart" and the icon was ✓, but the label a screen reader reads still said
  // "Add holiday-4k.mov to cleanup cart" — on the Dashboard's Largest Files,
  // Duplicates and Clean Up rows alike.
  const t = cartToggles([MOV.path]);
  const staged = t.parse(t.html(MOV.path, MOV.name, 14));
  assert.equal(staged.attrs['aria-label'], 'Remove holiday-4k.mov from Clean Up cart', 'a staged item: pressing it removes');
  assert.equal(staged.attrs.title, 'Remove from Clean Up cart');
  assert.match(staged.innerHTML, /data-icon="check"/);
  assert.ok(staged.cls.has('cartin'));
  assert.equal(staged.dataset.cartin, '1', 'stamped, so the cart walk has nothing to rewrite');
  const fresh = t.parse(t.html(DMG.path, DMG.name));
  assert.equal(fresh.attrs['aria-label'], 'Add Installer.dmg to Clean Up cart', 'an item not staged: pressing it adds');
  assert.equal(fresh.attrs.title, 'Add to Clean Up cart');
  assert.match(fresh.innerHTML, /data-icon="plus"/);
  assert.equal(fresh.dataset.cartin, '0');
  const odd = t.parse(t.html('/c/a"b.txt', 'a"b <x>.txt'));
  assert.equal(odd.attrs['aria-label'], 'Add a"b <x>.txt to Clean Up cart', 'a name is escaped into the attribute, not cut short by it');
  assert.equal(odd.attrs['data-cart-add'], '/c/a"b.txt');
});

test('a cart toggle\'s label follows the cart both ways as the item is staged and unstaged (QA third pass D11)', () => {
  const t = cartToggles([]);
  const b = t.parse(t.html(MOV.path, MOV.name, 14));
  t.state.cart.add(MOV.path);
  t.refresh(b);
  assert.equal(b.attrs['aria-label'], 'Remove holiday-4k.mov from Clean Up cart', 'staged: the label says it removes');
  assert.equal(b.attrs.title, 'Remove from Clean Up cart', 'as the tooltip says');
  assert.match(b.innerHTML, /data-icon="check"/);
  t.state.cart.delete(MOV.path);
  t.refresh(b);
  assert.equal(b.attrs['aria-label'], 'Add holiday-4k.mov to Clean Up cart', 'unstaged: it adds again');
  assert.equal(b.attrs.title, 'Add to Clean Up cart');
});

test('every cart toggle in the app is written by the one helper, so none can be drawn in the wrong state (QA third pass D11)', () => {
  // The labels were written in twelve places, each with "Add …" fixed in it;
  // the games' shader rows were never synced to the cart at all.
  const writes = [...CODE.matchAll(/data-cart-add="/g)].length;
  assert.equal(writes, 1, `one place writes a cart toggle (found ${writes})`);
  assert.match(fnSource('cartButtonHtml'), /data-cart-add="/, 'and it is cartButtonHtml');
  for (const fn of ['renderCloudSafe', 'renderBigFiles', 'gameCartRows', 'renderMedia', 'renderApps', 'dupFillGroup', 'ndItemHtml',
    'loadEmptyFolders', 'renderPackageOrphans', 'renderBrowserProfiles', 'renderSmartGroups', 'runCleanFind']) {
    assert.match(fnSource(fn), /cartButtonHtml\(/, `${fn} draws its cart toggles with cartButtonHtml`);
  }
});

/* ══════════════════════ E12 — the cart pill is named by what it shows ══════════════════════ */

/** One element of the page's static markup: its tag, attributes and children (text as strings). */
type MarkupEl = { tag: string; attrs: Record<string, string>; children: Array<MarkupEl | string> };
const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);

/** The page's <body> markup, before its script, as a tree. */
function markupTree(): MarkupEl {
  const at = INDEX.indexOf('<body');
  const html = INDEX.slice(at, INDEX.indexOf('<script>', at)).replace(/<!--[\s\S]*?-->/g, '');
  const root: MarkupEl = { tag: '#root', attrs: {}, children: [] };
  const stack = [root];
  for (const m of html.matchAll(/<(\/?)([a-zA-Z][\w-]*)((?:\s+[\w:-]+(?:="[^"]*")?)*)\s*(\/?)>|([^<]+)/g)) {
    const top = stack[stack.length - 1];
    if (m[5] !== undefined) { top.children.push(m[5]); continue; }
    const tag = m[2].toLowerCase();
    if (m[1]) {
      const i = stack.map((e) => e.tag).lastIndexOf(tag);
      assert.ok(i > 0, `</${tag}> closes an open element`);
      stack.length = i;
      continue;
    }
    const attrs: Record<string, string> = {};
    for (const a of m[3].matchAll(/([\w:-]+)(?:="([^"]*)")?/g)) attrs[a[1]] = (a[2] ?? '').replace(/&amp;/g, '&');
    const el: MarkupEl = { tag, attrs, children: [] };
    top.children.push(el);
    if (!VOID_TAGS.has(tag) && !m[4]) stack.push(el);
  }
  return root;
}

function* markupWalk(el: MarkupEl): Generator<MarkupEl> {
  for (const c of el.children) if (typeof c !== 'string') { yield c; yield* markupWalk(c); }
}

/** Text an element reads out or shows: `spoken` keeps visually hidden (.sr-only) text, `shown` drops it; neither has aria-hidden text. */
function markupText(el: MarkupEl, mode: 'spoken' | 'shown'): string {
  if (el.attrs['aria-hidden'] === 'true' || el.attrs.hidden !== undefined) return '';
  if (mode === 'shown' && /(^|\s)sr-only(\s|$)/.test(el.attrs.class || '')) return '';
  return el.children.map((c) => (typeof c === 'string' ? c.replace(/&[a-z]+;|&#\d+;/g, ' ') : ` ${markupText(c, mode)} `)).join('');
}

/** The words of a text, in order: what a voice command has to say, punctuation and case aside. */
const wordsOf = (s: string): string[] => s.toLowerCase().match(/[\p{L}\p{N}]+(?:\.\p{N}+)?/gu) ?? [];

/** A control's accessible name as a browser computes it here: aria-label, else its content (hidden text included, aria-hidden text not). */
function accessibleName(el: MarkupEl): string {
  return (el.attrs['aria-label'] || '').trim() || markupText(el, 'spoken');
}

/** Whether `inner`'s words run, in order and together, inside `outer`'s. */
function containsWords(outer: string[], inner: string[]): boolean {
  if (!inner.length) return true;
  for (let i = 0; i + inner.length <= outer.length; i++) if (inner.every((w, k) => outer[i + k] === w)) return true;
  return false;
}

test('the cart pill\'s accessible name contains the words it shows — a voice user saying "Review" reaches it (QA fourth pass E12, WCAG 2.5.3)', () => {
  // QA fourth pass E12: the pill shows "1 · 3.2 GB Review" and was named
  // "Open cleanup cart" — no word of what is on screen.
  const tab = [...markupWalk(markupTree())].find((e) => e.attrs.id === 'cartTab');
  assert.ok(tab, '#cartTab is in the page');
  assert.equal(tab!.attrs.role, 'button', 'control: the pill is a button');
  // renderCart writes the count and the total into their spans; the words around them are the markup's.
  const filled = (count: string, total: string): MarkupEl => {
    const copy = (e: MarkupEl): MarkupEl => ({ ...e, children: e.children.map((c) => (typeof c === 'string' ? c : copy(c))) });
    const t = copy(tab!);
    for (const e of markupWalk(t)) {
      if (e.attrs.id === 'cartTabCount') e.children = [count];
      if (e.attrs.id === 'cartTabTotal') e.children = [total];
    }
    return t;
  };
  for (const [count, total] of [['0', '0 B'], ['1', '3.2 GB'], ['12', '480.5 MB+']]) {
    const t = filled(count, total);
    const shown = wordsOf(markupText(t, 'shown'));
    assert.deepEqual(shown.slice(-1), ['review'], `control: the pill shows "Review" (${shown.join(' ')})`);
    const name = accessibleName(t);
    assert.ok(containsWords(wordsOf(name), shown), `named "${name.replace(/\s+/g, ' ').trim()}", it contains what it shows: "${shown.join(' ')}"`);
    assert.match(name, /Clean Up cart/, 'and still says what it is');
  }
});

test('no control in the page is named without the words it shows (WCAG 2.5.3, QA fourth pass E12)', () => {
  const CONTROL = /^(button|link|menuitem|tab|checkbox|switch|option)$/;
  let checked = 0;
  for (const el of markupWalk(markupTree())) {
    const control = el.tag === 'button' || (el.tag === 'a' && 'href' in el.attrs) || CONTROL.test(el.attrs.role || '');
    if (!control) continue;
    const shown = wordsOf(markupText(el, 'shown'));
    if (!shown.length) continue; // an icon-only control: its label is all it has
    checked++;
    const name = accessibleName(el);
    assert.ok(containsWords(wordsOf(name), shown),
      `${el.tag}#${el.attrs.id || '?'} shows "${shown.join(' ')}" and is named "${name.replace(/\s+/g, ' ').trim()}"`);
  }
  assert.ok(checked >= 40, `control: ${checked} labelled controls in the markup were checked`);
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
async function cartShows(staged: string[], nodes: Record<string, Node>, opts: { capsuleOff?: boolean } = {}) {
  const els: Record<string, { innerHTML: string; textContent: string; title: string; classList: { toggle(): void } }> = {};
  const $ = (id: string) => (els[id] ??= { innerHTML: '', textContent: '', title: '', classList: { toggle() {} } });
  const goal: unknown[][] = [];
  const deps: Record<string, unknown> = {
    $, state: { cart: new Set(staged), capsuleOff: opts.capsuleOff },
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
  const names = ['renderCart', 'cartTotalBytes', 'cartKnownPaths', 'cartUnknownCount', 'cartNode', 'tmCartRoots', 'tmParentPath', ...LIFT_SPACE];
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

/** cartSpaceSaid (D07): the one place the cart's two sentences about space are written. */
const LIFT_SPACE = ['cartSpaceSaid'];

const MOV = { name: 'holiday-4k.mov', path: '/c/Videos/holiday-4k.mov', size: 3_000_000_000 };
const DMG = { name: 'Installer.dmg', path: '/c/Installer.dmg', size: 2_000_000_000 };

test('the cart promises what a move to the Trash does — up to its size, once the Trash is emptied — never "Reclaims" (B29)', async () => {
  // QA: "Reclaims 6.5 GB" for three sparse files that occupy 0 bytes; D54 had
  // already reworded Clean Up to say this, and the cart said it more strongly.
  const shown = await cartShows([MOV.path, DMG.path], { [MOV.path]: MOV, [DMG.path]: DMG });
  assert.doesNotMatch(shown.foot, /Reclaims/, `no promise the Trash has not kept: ${shown.foot}`);
  assert.match(shown.foot, /<b>5000000000 B<\/b> staged for the Trash\. Up to that much space comes back, but only when you empty the Trash\./, shown.foot);
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
  assert.match(some.foot, /<b>3000000000 B<\/b> staged for the Trash · 1 not in this scan, not counted\. Up to that much space comes back/, some.foot);
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
  assert.match(some.label, /Clean Up target: at least 3000000000 B of 50000000000 B staged, 6 percent/, some.label);

  const all = goalShows(3_000_000_000, 0, 1);
  assert.match(all.line, /<b>3000000000 B<\/b> of 50000000000 B staged/, `no mark when everything is sized: ${all.line}`);
  assert.match(all.label, /Clean Up target: 3000000000 B of 50000000000 B staged, 6 percent/, all.label);

  // Past the target, the figure that met it is still a floor while some items are unsized.
  const metSome = goalShows(60_000_000_000, 1, 2);
  assert.equal(metSome.met, true, 'the sized part alone meets the target');
  assert.match(metSome.line, /Target met\.<\/b> <span>60000000000 B\+ staged toward 50000000000 B\./, `marked a floor: ${metSome.line}`);
  assert.match(metSome.label, /Clean Up target met: at least 60000000000 B staged toward 50000000000 B/, metSome.label);
  const metAll = goalShows(60_000_000_000, 0, 1);
  assert.match(metAll.line, /Target met\.<\/b> <span>60000000000 B staged toward 50000000000 B\./, `no mark when everything is sized: ${metAll.line}`);
  assert.match(metAll.label, /Clean Up target met: 60000000000 B staged toward 50000000000 B/, metAll.label);

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
  assert.match(shown.foot, /<b>400 B<\/b> staged for the Trash · 1 not in this scan, not counted\. Up to that much space comes back/, shown.foot);
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
  const run = new Function(...keys, `let confirmPaths = []; let onConfirmTrash = null;\n${[...LIFT_SPACE, 'cartCommitSummary'].map(fnSource).join('\n')}\nreturn cartCommitSummary;`)(
    ...keys.map((k) => deps[k]),
  ) as (r: unknown) => void;
  const summary = (r: unknown): string => { run(r); return els.confirmText!.innerHTML; };
  const html = summary({ trashed: ['/c/a', '/c/b'], bytesFreed: 6_500_000_000, runId: 'r1' });
  assert.doesNotMatch(html, /recovered/i, `nothing is recovered by a move to the Trash: ${html}`);
  assert.match(html, /Moved <b>2<\/b> items \(<b>6500000000 B<\/b>\) to the Trash/, html);
  assert.match(html, /Up to that much space comes back, but only when you empty the Trash\./, html);
  assert.match(html, /The Undo Vault also keeps a copy so you can undo this, and that copy takes up space until the Undo Vault removes it\./, html);
  const bare = summary({ trashed: ['/c/a'], bytesFreed: 10, capsuleUnavailable: 'No capsule in a portable session.' });
  assert.match(bare, /Up to that much space comes back, but only when you empty the Trash\./, 'with no capsule copy, the space still comes back only when the Trash is emptied');
  assert.doesNotMatch(bare, /Undo Vault also keeps a copy/, 'no capsule copy is mentioned when none was made');
});

/* ══════════════════════ D07 — before the commit, the cart says what the summary says ══════════════════════ */

const SPACE_LATER = 'Up to that much space comes back, but only when you empty the Trash.';
const CAPSULE_SPACE = 'The Undo Vault also keeps a copy so you can undo this, and that copy takes up space until the Undo Vault removes it.';

/** The confirm sheet's manifest for a dry run that would move `MOV`, the capsule on or off. */
function sheetSays(capsule: { available: boolean; reason?: string }, moving: Node[] = [MOV], conflicts: string[] = []): string {
  const plan = {
    items: moving.map((n) => ({ path: n.path, bytes: n.size, willDelete: true })), bytesWouldFree: moving.reduce((s, n) => s + n.size, 0),
    bytesSkipped: 0, evicts: [], capsule, openHandles: { checked: true, complete: true, conflicts: conflicts.map((p) => ({ path: p })) }, batches: 1,
  };
  const keys = ['formatCount', 'formatBytes', 'escapeHtml', 'icon', 'baseName', 'state'];
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  // The installed-program warning cartManifestHtml adds (fifth browser pass F01) is the page's own too.
  const warning = ['installedProgramWarningHtml', 'installedProgramWords', 'installedProgramRemoval'];
  return new Function(...keys, `${[...LIFT_SPACE, ...warning, 'cartManifestHtml'].map(fnSource).join('\n')}\nreturn cartManifestHtml;`)(
    String, (n: number) => `${n} B`, (s: unknown) => String(s), () => '', (p: string) => path.basename(p), { cart: new Set() },
  )(plan, 0) as string;
}

/** The Preview banner's sentence for a cart staging `MOV`. */
function bannerSays(capsuleOff = false): string {
  const text = { innerHTML: '' };
  const els: Record<string, unknown> = {
    tmPreviewText: text, tmPreviewBanner: { hidden: true }, cartPreview: null,
    treemapWrap: { classList: { toggle() {} }, style: { removeProperty() {} } },
  };
  const keys = ['$', 'tmPreview', 'formatBytes', 'formatCount', 'escapeHtml', 'tmPreviewPadSync', 'tmPreviewWatch', 'state'];
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function(...keys, `${[...LIFT_SPACE, 'syncCartPreviewChrome'].map(fnSource).join('\n')}\nreturn syncCartPreviewChrome;`)(
    (id: string) => els[id] ?? null, { on: true, freedBytes: MOV.size, outsideView: 0, outsideBytes: 0 },
    (n: number) => `${n} B`, String, (s: unknown) => String(s), () => false, () => {}, { cart: new Set([MOV.path]), capsuleOff },
  )();
  return text.innerHTML;
}

/** The post-commit summary for a run that moved `MOV`. */
function summarySays(extra: Record<string, unknown> = {}): string {
  const els: Record<string, { innerHTML: string; hidden: boolean; classList: { add(): void } }> = {};
  const keys = ['$', 'formatCount', 'formatBytes', 'escapeHtml', 'icon', 'baseName', 'state'];
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function(...keys, `let confirmPaths = []; let onConfirmTrash = null;\n${[...LIFT_SPACE, 'cartCommitSummary'].map(fnSource).join('\n')}\nreturn cartCommitSummary;`)(
    (id: string) => (els[id] ??= { innerHTML: '', hidden: false, classList: { add() {} } }), String, (n: number) => `${n} B`, (s: unknown) => String(s), () => '',
    (p: string) => path.basename(p), { cart: new Set() },
  )({ trashed: [MOV.path], bytesFreed: MOV.size, runId: 'r1', ...extra });
  return els.confirmText!.innerHTML;
}

const plainText = (html: string) => html.replace(/<[^>]+>/g, '');

test('before the commit the cart says what the summary says: space comes back only when the Trash is emptied, and the Time Capsule\'s copy takes space until it is removed (QA third pass D07)', async () => {
  // QA third pass D07: the footer said "Up to 3.2 GB, freed when you empty
  // the Trash", the Preview banner "up to that much comes back when you
  // empty it", and the confirm sheet nothing about space — while the dry run
  // reserved 3.2 GB of the capsule's room for a copy. Only the summary, shown
  // after the decision, said both.
  const surfaces: Record<string, string> = {
    'the cart footer': (await cartShows([MOV.path], { [MOV.path]: MOV })).foot,
    'the Preview banner': bannerSays(),
    'the confirm sheet': sheetSays({ available: true }),
    'the summary': summarySays(),
  };
  for (const [where, html] of Object.entries(surfaces)) {
    const text = plainText(html);
    assert.ok(text.includes(SPACE_LATER), `${where} says the space comes back only when the Trash is emptied: ${text}`);
    // The sheet names its copy once, in the sentence that says it is made,
    // and says there that it takes up space (QA fourth pass E14b, below).
    if (where === 'the confirm sheet') assert.match(text, SHEET_COPY_SPACE, `${where} says the Time Capsule's copy takes up space until it is removed: ${text}`);
    else assert.ok(text.includes(CAPSULE_SPACE), `${where} says the Time Capsule's copy takes up space until it is removed: ${text}`);
  }
});

/** The confirm sheet's one sentence about its copy ends by saying the copy takes up space until the capsule removes it. */
const SHEET_COPY_SPACE = /until the Undo Vault removes the cop(?:y, which takes|ies, which take) up space until then\./;

test('the cart\'s confirm sheet names the Time Capsule\'s copy once — never "copied into the Time Capsule" and then "also keeps a copy" (QA fourth pass E14b)', () => {
  // QA fourth pass E14b: "It is copied into the Time Capsule … The Time
  // Capsule also keeps a copy so you can undo this, and that copy takes up
  // space until the Time Capsule removes it." One copy, introduced twice.
  for (const moving of [[MOV], [MOV, DMG]]) {
    const text = plainText(sheetSays({ available: true }, moving));
    const said = `${moving.length} item(s): ${text}`;
    const introduced = text.match(/copied into the Undo Vault|keeps? a copy|Undo Vault also/g) || [];
    assert.equal(introduced.length, 1, `the copy is introduced once (${introduced.join(' | ')}) — ${said}`);
    assert.match(text, SHEET_COPY_SPACE, `and that sentence says the copy takes up space until it is removed — ${said}`);
    assert.ok(text.includes(SPACE_LATER), `the space still comes back only when the Trash is emptied — ${said}`);
  }
});

test('where no Time Capsule copy is kept, no surface says one is — a portable session that saves nothing, a dry run that finds the capsule off (QA third pass D07)', async () => {
  const surfaces: Record<string, string> = {
    'the cart footer': (await cartShows([MOV.path], { [MOV.path]: MOV }, { capsuleOff: true })).foot,
    'the Preview banner': bannerSays(true),
    'the confirm sheet': sheetSays({ available: false, reason: 'This portable session saves nothing, so there is nowhere to keep a recoverable copy.' }),
    'the summary': summarySays({ capsuleUnavailable: 'This portable session saves nothing.' }),
  };
  for (const [where, html] of Object.entries(surfaces)) {
    const text = plainText(html);
    assert.ok(text.includes(SPACE_LATER), `${where} still says the space comes back only when the Trash is emptied: ${text}`);
    assert.ok(!text.includes(CAPSULE_SPACE), `${where} claims no copy that is not kept: ${text}`);
    assert.doesNotMatch(text, SHEET_COPY_SPACE, `${where} claims no copy that is not kept: ${text}`);
  }
});

test('the cart\'s two sentences about space are written once, and a portable session that saves nothing tells the cart (QA third pass D07)', () => {
  for (const sentence of [SPACE_LATER, CAPSULE_SPACE]) {
    assert.equal(CODE.split(sentence).length - 1, 1, `written in one place: "${sentence}"`);
  }
  for (const fn of ['renderCart', 'syncCartPreviewChrome', 'cartManifestHtml', 'cartCommitSummary']) {
    assert.match(fnSource(fn), /cartSpaceSaid\(/, `${fn} says it through cartSpaceSaid`);
  }
  const portable = fnSource('loadPortableMode');
  assert.match(portable, /if \(!portableInfo\.writable\) \{ state\.capsuleOff = true; void renderCart\(\); \}/,
    'the session that saves nothing (timeCapsule\'s isEphemeral: portable and not writable) turns the capsule sentence off');
});

/* ══════════════════════ D08 — one item is "it", never "all 1" ══════════════════════ */

test('a one-item run is spoken of as one: "Puts it back where it was", never "all 1" (QA third pass D08)', () => {
  // QA third pass D08: "Puts all 1 back where they were" under a one-item run.
  const one = plainText(summarySays());
  assert.match(one, /Puts it back where it was, from the Undo Vault — byte for byte, with its permissions and the dates it was last modified and opened\./, one);
  assert.doesNotMatch(one, /\ball 1\b|where they were|their permissions/, one);
  const two = plainText(summarySays({ trashed: [MOV.path, DMG.path] }));
  assert.match(two, /Puts all 2 back where they were, from the Undo Vault — byte for byte, with their permissions and the dates they were last modified and opened\./, two);
  // Nothing confirmed moved, one item the Trash may have taken.
  const unsure = plainText(summarySays({ trashed: [], unverified: [{ path: MOV.path, reason: 'The Trash did not answer.' }] }));
  assert.match(unsure, /Puts it back if the Trash has taken it, from the Undo Vault/, unsure);
  const unsureTwo = plainText(summarySays({ trashed: [], unverified: [{ path: MOV.path, reason: 'r' }, { path: DMG.path, reason: 'r' }] }));
  assert.match(unsureTwo, /Puts back any of them the Trash has taken, from the Undo Vault/, unsureTwo);
});

test('the rest of the cart\'s one-item sentences agree in number: the sheet, a refused move, an open file, the undo (QA third pass D08)', async () => {
  const sheet = plainText(sheetSays({ available: true }));
  assert.match(sheet, /It is copied into the Undo Vault and checked before anything is deleted, so it can be undone in one click — even after you empty the Trash, until the Undo Vault removes the copy, which takes up space until then\./, sheet);
  assert.doesNotMatch(sheet, /Each one|whole batch/, sheet);
  const sheetTwo = plainText(sheetSays({ available: true }, [MOV, DMG]));
  assert.match(sheetTwo, /Each one is copied into the Undo Vault .* so the whole batch can be undone in one click — even after you empty the Trash, until the Undo Vault removes the copies, which take up space until then\./, sheetTwo);
  const open = plainText(sheetSays({ available: true }, [MOV], [MOV.path]));
  assert.match(open, /It is open in another program right now, which will stop the move\./, open);
  const openTwo = plainText(sheetSays({ available: true }, [MOV, DMG], [MOV.path]));
  assert.match(openTwo, /1 of these is open in another program right now, which will stop the whole batch\./, openTwo);

  const refused = plainText(summarySays({ failedToTrash: [{ path: DMG.path, reason: 'in use' }] }));
  assert.match(refused, /1 could not be moved to the Trash\. It is untouched, its copy was discarded, and it is still in your cart:\s*Installer\.dmg\s*in use/, refused);
  const refusedTwo = plainText(summarySays({ failedToTrash: [{ path: DMG.path, reason: 'in use' }, { path: '/c/x', reason: 'in use' }] }));
  assert.match(refusedTwo, /2 could not be moved to the Trash\. Those are untouched, their copies were discarded, and they are still in your cart:/, refusedTwo);
});

test('the Time Capsule keeps its copies for "1 day", not "1 days" (QA third pass D08)', () => {
  const shown = (retentionDays: number): string => {
    const texts: Record<string, string> = {};
    const el = (id: string) => ({ id, hidden: true, innerHTML: '', textContent: '', classList: { add() {}, remove() {} }, querySelectorAll: () => [] });
    const els: Record<string, ReturnType<typeof el>> = {};
    const deps: Record<string, unknown> = {
      $: (id: string) => (els[id] ??= el(id)),
      state: { capsule: { q: '', index: {
        status: { available: true, usedBytes: 10, capBytes: 100, retentionDays },
        entries: [{ id: 'e1', name: 'a.mov', originalPath: '/c/a.mov', sizeBytes: 10, capturedAt: 1, hasPayload: true, runId: 'r1' }], events: [],
      } } },
      FxCharts: { gauge: () => ({ update() {}, destroy() {} }) },
      FxNum: { rollText: (e: { id: string }, t: string) => { texts[e.id] = t; }, rollHtml: (e: { id: string }, h: string) => { texts[e.id] = h; } },
      formatBytes: (n: number) => `${n} B`, formatCount: String, formatDate: String, escapeHtml: (s: unknown) => String(s),
      icon: () => '', chipFor: () => '', renderCapsuleEvents: () => {}, capsuleGaugeHide: () => {}, restoreFromCapsule: () => {},
      forgetCapsuleEntry: () => {},
    };
    const keys = Object.keys(deps);
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    new Function(...keys, `let capsuleGaugeHandle = null;\n${fnSource('renderCapsule')}\nreturn renderCapsule;`)(...keys.map((k) => deps[k]))();
    return texts.capsuleGaugeText ?? '';
  };
  assert.match(shown(1), /kept for 1 day$/, shown(1));
  assert.match(shown(30), /kept for 30 days$/, shown(30));
});
