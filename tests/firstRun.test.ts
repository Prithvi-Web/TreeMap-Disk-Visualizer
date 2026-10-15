import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-firstrun-test-');
process.env.TREEMAP_NO_GDU = '1';

import { getSettings, updateSettings } from '../src/services/settings';
import { ITEMS_PER_RULE } from '../src/services/cleanupRules';
import { lift as liftPage } from './fixtures/liftFrontend';

/** tourWinLine and what it reads, out of the built page. */
const WIN_LINE = ['UNITS', 'UI_LOCALE', 'escapeHtml', 'formatBytes', 'formatCount', 'TOUR_WIN_ITEMS', 'SUGGESTION_ITEMS_LISTED', 'tourWinLine'];

/**
 * v4 §9.2 — the guided first run.
 *
 * The tour's promises are stronger than its steps: it must never stage
 * anything itself (the user clicks), never present a suggestion the normal
 * engine would not make (it reads /api/cleanup/suggestions and nothing
 * else), be skippable at every step, and never come back once completed —
 * with the flag persisted through settings.json so a read-only portable
 * session, which persists nothing, honestly shows it again.
 */

const INDEX = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

/* ══════════════════════ The flag ══════════════════════ */

test('tourDone defaults to false, persists true, and refuses junk', async () => {
  const fresh = await getSettings();
  assert.equal(fresh.tourDone, false, 'a new install has not seen the tour');
  const done = await updateSettings({ tourDone: true });
  assert.equal(done.tourDone, true);
  const kept = await updateSettings({ forecastThresholdDays: 30 });
  assert.equal(kept.tourDone, true, 'an unrelated save keeps it');
  const junk = await updateSettings({ tourDone: 'yes' });
  assert.equal(junk.tourDone, false, 'only boolean true counts — a truthy string must not silence the tour');
  await updateSettings({ tourDone: false });
});

/* ══════════════════════ The overlay, structurally ══════════════════════ */

test('the tour exists, is a dialog, and every step can be skipped', () => {
  assert.ok(INDEX.includes('id="tourOverlay"'), 'the overlay exists');
  const tag = INDEX.slice(INDEX.indexOf('id="tourOverlay"') - 250, INDEX.indexOf('id="tourOverlay"') + 250);
  assert.match(tag, /role="dialog"/);
  const js = INDEX.slice(INDEX.indexOf('function tourRender'), INDEX.indexOf('function tourRender') + 9000);
  assert.match(js, /data-tour-skip/, 'a skip control is rendered');
  // Skipping and finishing both persist the flag — the tour never returns
  // uninvited after either.
  const finish = INDEX.slice(INDEX.indexOf('async function tourFinish'), INDEX.indexOf('async function tourFinish') + 700);
  assert.match(finish, /tourDone: true/, 'finish persists the flag');
  assert.match(finish, /\/api\/settings/, 'through the settings endpoint (portable mode then keeps it in memory only)');
});

test('the tour never stages, deletes, or invents — the user clicks, the engine suggests', () => {
  const start = INDEX.indexOf('/* ───────────────────── v4 §9.2');
  assert.notEqual(start, -1, 'the tour block is banner-commented like the rest of Phase 9');
  const block = INDEX.slice(start, INDEX.indexOf('/* ───────────── end §9.2', start));
  assert.ok(block.length > 2000, 'the tour block was located whole');
  // Suggestions come from the normal engine, nothing else.
  assert.match(block, /\/api\/cleanup\/suggestions/, 'wins come from the real suggestion engine');
  // Advisory groups have no delete path anywhere in the app; the tour must
  // not offer to stage them either.
  // Matched on the CODE literal, not the word: the first review round proved
  // by mutation that /advisory/ matched the adjacent comment and the filter
  // could be deleted without a failure. `!g.advisory` only exists in code.
  assert.match(block, /!g\.advisory/, 'advisory groups are filtered out — in code, not in a comment');
  // Staging happens only inside a click handler, through cartAddMany — a bulk
  // door on the ONE cart, living beside cartToggle and running the same
  // save/render pipeline once instead of per item. Deletion is nowhere.
  assert.match(block, /cartAddMany\(/, 'staging rides the shared cart pipeline');
  const bulk = INDEX.slice(INDEX.indexOf('function cartAddMany'), INDEX.indexOf('function cartAddMany') + 800);
  for (const fn of ['saveCart()', 'renderCart()', 'refreshCartButtons()', 'cartPreviewInvalidated()']) {
    assert.ok(bulk.includes(fn), `cartAddMany runs ${fn} — the same pipeline as cartToggle, once`);
  }
  assert.ok(!block.includes('cartTrashAll'), 'the tour cannot commit the cart');
  assert.ok(!/api\('\/api\/files'/.test(block), 'the tour cannot delete');
  assert.ok(!block.includes('confirmTrash'), 'not even via the confirm dialog');
});

test('an empty disk gets honesty, not invented wins', () => {
  const block = INDEX.slice(INDEX.indexOf('/* ───────────────────── v4 §9.2'), INDEX.indexOf('/* ───────────── end §9.2'));
  assert.match(block, /looks clean/, 'no suggestions → the tour says so and ends, rather than inventing a win');
});

test('the tour only appears for a first run, and rides the boot settings read', () => {
  const boot = INDEX.slice(INDEX.indexOf('async function loadCartGoal'), INDEX.indexOf('async function loadCartGoal') + 900);
  assert.match(boot, /tourMaybeStart\(s\.tourDone/, 'the boot settings fetch decides — no second request');
});

test('the welcome card never focuses a hidden input — found by driving the zero-state; its "Choose a folder" opens the folder browser (G03, review F1.2)', () => {
  // Before any scan the top path box is offscreen; focus() on it was a silent
  // no-op, so "I'll pick my own" fell back to the folder browser — the same
  // browser the welcome's own "Choose a folder to get started" opens. The card
  // offers that browser only where the welcome is not on screen (design pass
  // G03, review F1.2), and never a path box to focus.
  const render = INDEX.slice(INDEX.indexOf('function tourRender'), INDEX.indexOf('/** A quick win'));
  assert.doesNotMatch(render, /I’ll pick my own|I'll pick my own/, 'no "I\'ll pick my own"');
  assert.match(render, /querySelector\('\[data-tour-pick\]'\)\.addEventListener\('click', \(\) => \{ openBrowse\(null\); \}\)/, 'the card\'s picker is the folder browser');
  assert.doesNotMatch(render, /pi\.focus\(\)|\$\('pathInput'\)\.focus\(/, 'and nothing in the card focuses the path box');
});

test('one Escape never closes a dialog AND skips the tour', () => {
  // Same promise, stronger architecture after review round 1: the skip now
  // lives at the END of the app-wide Escape chain, so any press an earlier
  // branch claims — modal, menu, preview, climb-out — returns before the
  // tour branch is ever reached.
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const chain = html.slice(html.indexOf('const openModal = topModal();'));
  // closeModal(), not a bare class removal: the funnel carries per-modal
  // teardown (the Settings sheet clears its cloud-connect poll + orb there).
  const modalBranch = chain.indexOf('closeModal(openModal.id)');
  const tourBranch = chain.indexOf("tour.active && !$('tourOverlay').hidden");
  assert.ok(modalBranch !== -1 && tourBranch !== -1 && modalBranch < tourBranch,
    'closing a dialog returns before the tour branch is reached');
  assert.match(chain.slice(tourBranch, tourBranch + 220), /nlPop/, 'an open plain-words popover blocks the skip too');
});

test('the tour card never steals focus from a text field', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const at = html.indexOf('const primary = (cta');
  const around = html.slice(at - 500, at + 300);
  assert.match(around, /INPUT\|TEXTAREA\|SELECT/, 'the active element is checked');
  assert.match(around, /!typing\) primary\.focus\(\)/, 'focus only moves when nobody is typing');
});

test("the wins step never reads a non-answer as clean — polls, and shows refusals", () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const fn = html.slice(html.indexOf('async function tourLoadWins'), html.indexOf('async function tourLoadWins') + 1600);
  assert.match(fn, /poll: true/, 'a still-running scan is waited out, not misread as empty');
  assert.match(fn, /available === false/, "a broken rule catalog becomes 'couldn\u2019t check', with its reason");
  assert.match(fn, /catch \(e\)/, 'so does a transport error');
  assert.ok(!/catch \{ groups = \[\]; \}/.test(fn), 'the silent-empty catch is gone');
  const card = html.slice(html.indexOf("tour.step === 'unknown'"), html.indexOf("tour.step === 'unknown'") + 900);
  assert.match(card, /Couldn/, 'the unknown card says could-not-check, never clean');
  assert.match(card, /escapeHtml\(tour\.unknownReason/, 'and shows the reason, escaped');
});

test('Escape has one meaning: the tour skip is the LAST branch of the app-wide chain', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  // A missing anchor used to slice(-1) — the last character of the page — and
  // every containment check below then failed for the wrong reason.
  assert.notEqual(html.indexOf('const openModal = topModal();'), -1, 'the Escape chain is where this test thinks it is');
  // The dedicated tour listener is gone…
  assert.ok(!/addEventListener\('keydown', \(e\) => \{\n  if \(e\.key === 'Escape' && tour\.active/.test(html),
    'no separate tour Escape listener survives');
  // …and inside the big chain, every established meaning comes first.
  const chain = html.slice(html.indexOf('const openModal = topModal();'));
  const tourAt = chain.indexOf('tour.active && !$(\'tourOverlay\').hidden');
  assert.notEqual(tourAt, -1, 'the tour branch lives in the chain');
  for (const earlier of ['hideCtxMenu()', 'closePreview()', 'exitCartPreview()', 'treemapUp()', 'cityUp()', 'gridUp()']) {
    const at = chain.indexOf(earlier);
    assert.ok(at !== -1 && at < tourAt, `${earlier} outranks the tour skip`);
  }
  const branch = chain.slice(tourAt, tourAt + 300);
  assert.match(branch, /!typing/, 'and Esc from inside a text field never skips the tour');
});

test('the palette closes through its own door from every path — focus restore included', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.match(html, /openModal\.id === 'cmdkModal'\) \{ cmdkClose\(\); return; \}/,
    'the generic Escape path special-cases the palette');
  assert.match(html, /#cmdkModal \{[^}]*z-index: 130/, 'the palette paints above the other modals');
  const scoped = html.slice(html.indexOf("$('cmdkModal').addEventListener('keydown'"), html.indexOf("$('cmdkModal').addEventListener('keydown'") + 600);
  assert.match(scoped, /stopPropagation\(\)/, "palette keys are the palette's — they never reach dupeViewerKeys or the view shortcuts");
});

/* ══════════════════════ QA D06 — the quick-win card reads as sentences ══════════════════════ */

test('a quick win\'s description ends as a sentence — "…fetched crates A folder named…" ran together (QA D06) — and the matcher\'s wording is not shown (G04)', () => {
  const line = liftPage<(g: { description?: string; why?: string }) => string>(WIN_LINE, 'tourWinLine');
  const text = (html: string) => html.replace(/<[^>]+>/g, '');
  assert.equal(text(line({ description: 'Cargo build output and fetched crates', why: 'A folder named target sitting next to Cargo.toml.' })),
    'Cargo build output and fetched crates.', 'the rule\'s description as a sentence; its matcher wording is the Clean Up view\'s, not the tour\'s (G04)');
  assert.equal(text(line({ description: 'Ends already.', why: 'Why.' })), 'Ends already.', 'no doubled full stop');
  assert.equal(text(line({ description: 'Ends with a question?', why: 'Why.' })), 'Ends with a question?');
  assert.equal(text(line({ description: 'Alone' })), 'Alone.', 'still a sentence');
  assert.equal(text(line({ description: '', why: 'Only why.' })).trim(), '', 'an empty description adds no stray full stop');
  assert.match(line({ description: 'a <b>', why: '<i>' }), /^a &lt;b&gt;\.$/, 'escaped, and the why is not on the card');
  const render = INDEX.slice(INDEX.indexOf('function tourRender'), INDEX.indexOf('function tourAdvanceWin'));
  assert.match(render, /<p>\$\{tourWinLine\(g\)\}<\/p>/, 'the card renders through it');
});

test('every quick-win card offers the same "Skip this one" — the last no longer says "Not this one" (QA D06)', () => {
  const render = INDEX.slice(INDEX.indexOf('function tourRender'), INDEX.indexOf('function tourAdvanceWin'));
  assert.match(render, /<button class="btn" data-tour-next>Skip this one<\/button>/, 'one wording on every card');
  assert.doesNotMatch(render, /Not this one/);
});

/* ══════════════ Design pass G03 / G04 / G11 — the first five minutes ══════════════ */

type TEl = {
  innerHTML: string; value: string; hidden: boolean; disabled: boolean; focused: number; rects: number;
  listeners: Record<string, Array<() => void>>; addEventListener: (n: string, fn: () => void) => void;
  querySelector: (sel: string) => TEl | null; getClientRects: () => unknown[]; focus: () => void; contains: (n: unknown) => boolean;
};
function tel(rects = 1): TEl {
  const e: TEl = {
    innerHTML: '', value: '', hidden: false, disabled: false, focused: 0, rects, listeners: {},
    addEventListener: (n, fn) => { (e.listeners[n] ??= []).push(fn); },
    querySelector: () => null,
    getClientRects: () => Array.from({ length: e.rects }),
    focus: () => { e.focused++; },
    contains: () => false,
  };
  return e;
}

/** A stub card's querySelector: finds the buttons its HTML holds, one stub
    per data-tour-* attribute, honouring :not([disabled]) as the page's
    selectors use it. */
function cardFinder(host: TEl, found: Record<string, TEl>, make: () => TEl = () => tel()): (sel: string) => TEl | null {
  return (sel) => {
    const h = host.innerHTML;
    const enabledOnly = sel.endsWith(':not([disabled])');
    const base = enabledOnly ? sel.slice(0, -':not([disabled])'.length) : sel;
    const buttons = [...h.matchAll(/<button\b([^>]*)>/g)].map((m) => ({ attrs: m[1], at: m.index! }));
    const ok = (b: { attrs: string }) => !enabledOnly || !/\bdisabled\b/.test(b.attrs);
    let hit: { attrs: string; at: number } | undefined;
    if (base === '.btn-primary') hit = buttons.find((b) => /class="btn btn-primary"/.test(b.attrs) && ok(b));
    else if (base === '.tour-row button') {
      const row = h.indexOf('<div class="tour-row">');
      hit = row === -1 ? undefined : buttons.find((b) => b.at > row && ok(b));
    } else {
      const attr = /^\[([\w-]+)\]$/.exec(base);
      if (attr) hit = buttons.find((b) => b.attrs.includes(attr[1]) && ok(b));
    }
    if (!hit) return null;
    const key = (/data-tour-[\w-]+/.exec(hit.attrs) || ['button'])[0];
    return (found[key] ??= make());
  };
}

/** The tour card's renderer out of the built page, over a stub card that finds what its HTML holds. */
function tourCard(step: string, opts: { home?: string | null; heroUp?: boolean; added?: string[]; win?: Record<string, unknown>; wins?: Array<Record<string, unknown>>; cart?: string[]; takeFocus?: boolean } = {}) {
  const els: Record<string, TEl> = {};
  const $ = (id: string) => (els[id] ??= tel());
  const host = $('tourCard');
  const found: Record<string, TEl> = {};
  // Each paint makes new buttons, as the page's innerHTML does: a button of
  // the last paint keeps its listeners, and is no longer the card's.
  let painted = ''; let paints = 0;
  Object.defineProperty(host, 'innerHTML', { get: () => painted, set: (v: string) => { painted = v; paints++; for (const k of Object.keys(found)) delete found[k]; } });
  host.querySelector = cardFinder(host, found);
  $('emptyBrowseBtn').rects = opts.heroUp ? 1 : 0;
  const winLine = liftPage<(g: unknown) => string>(WIN_LINE, 'tourWinLine');
  const tour = { active: true, step, wins: opts.wins ?? (opts.win ? [opts.win] : []), winIx: 0, added: opts.added ?? [], unknownReason: '' };
  const cart = new Set(opts.cart ?? []);
  // The page's cartAddMany as it behaves: what is not staged yet goes in.
  const cartAddMany = (paths: string[]) => paths.filter((p) => p && !cart.has(p) && cart.add(p)).length;
  const browsed: unknown[] = [];
  const render = INDEX.slice(INDEX.indexOf('function tourRender'), INDEX.indexOf('/** A quick win'));
  // The page's own step to the next win, so Add and Skip move the card on as they do there (review F2.7).
  const advance = pageFn('function tourAdvanceWin(');
  const fn = new Function('$', 'tour', 'state', 'icon', 'escapeHtml', 'formatBytes', 'startScan', 'openBrowse', 'tourLoadWins', 'tourFinish', 'cartAddMany',
    'tourWinLine', 'document', `'use strict'; ${render} ${advance} return { tourRender, tourCartChanged: typeof tourCartChanged === 'function' ? tourCartChanged : () => {} };`)(
    $, tour, { system: { homeDir: opts.home === undefined ? '/Users/x' : opts.home }, cart, root: null }, () => '', (s: string) => s,
    (n: number) => `${n} B`, () => {}, (start: unknown) => { browsed.push(start); }, () => {}, () => {}, cartAddMany, winLine, { activeElement: null },
  ) as { tourRender: (takeFocus?: boolean) => void; tourCartChanged: () => void };
  fn.tourRender(opts.takeFocus);
  const textOf = (h: string) => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  /** The card as it is painted now, after any click, and how many times it has been painted. */
  const now = () => ({ html: host.innerHTML, text: textOf(host.innerHTML), paints });
  return { html: host.innerHTML, text: textOf(host.innerHTML), found, $, tour, cart, browsed, now, cartChanged: fn.tourCartChanged };
}

test('the welcome card offers one alternative, not a second primary action beside the welcome\'s own (G03)', () => {
  const card = tourCard('welcome', { heroUp: true });
  assert.doesNotMatch(card.html, /btn-primary/, 'one primary on screen: the welcome\'s "Choose a folder to get started"');
  assert.match(card.html, /<button class="btn" data-tour-home>Scan my home folder<\/button>/, 'the home folder is offered as the alternative it is');
  assert.doesNotMatch(card.html, /data-tour-pick|I’ll pick my own/, 'and no second way to the same folder browser the welcome\'s own button opens');
  assert.doesNotMatch(card.text, /bigger the rectangle|draws every file/, 'the card does not repeat the welcome\'s own words');
  assert.match(card.text, /Pick a folder to look at first — scanning only reads it; nothing is moved or deleted\. Your home folder is a good place to start\./, card.text);
  assert.equal(card.$('emptyBrowseBtn').focused, 1, 'Enter goes to the one primary: the welcome\'s own button takes focus');
  assert.equal(card.found['data-tour-home']?.focused ?? 0, 0, 'not the home-folder scan');

  const elsewhere = tourCard('welcome', { heroUp: false });
  assert.equal(elsewhere.found['data-tour-pick']?.focused ?? 0, 1, 'with no welcome on screen the card\'s own "Choose a folder" takes focus (review F1.2)');
  assert.equal(elsewhere.found['data-tour-home']?.focused ?? 0, 0, 'not the home-folder scan');
  assert.equal(elsewhere.found['data-tour-skip']?.focused ?? 0, 0, 'never Skip');

  const noHome = tourCard('welcome', { home: null, heroUp: true });
  assert.doesNotMatch(noHome.html, /<div class="tour-row">/, 'no home folder known: no empty row of actions');
  assert.match(noHome.text, /Pick a folder to look at first — scanning only reads it; nothing is moved or deleted\.$/, noHome.text);
});

test('where the welcome\'s own "Choose a folder" is not on screen, the welcome card offers it, and a change of view repaints the card without taking focus (review F1.2)', () => {
  // Offloaded, Time Capsule, Autopilot and Fleet have no folder picker, and
  // Settings › Show the welcome tour again can start the card on any of them:
  // the card said "Pick a folder to look at first" with no way to do so.
  const off = tourCard('welcome', { heroUp: false });
  assert.match(off.html, /<div class="tour-row"><button class="btn" data-tour-pick>Choose a folder<\/button><button class="btn" data-tour-home>Scan my home folder<\/button><\/div>/,
    `the card offers the folder browser itself, first, beside the home folder — neither one blue: ${off.html}`);
  const pick = off.found['data-tour-pick'];
  assert.ok(pick?.listeners.click?.length, 'the button is wired');
  pick.listeners.click.forEach((fn) => fn());
  assert.deepEqual(off.browsed, [null], 'and opens the folder browser');
  const noHome = tourCard('welcome', { heroUp: false, home: null });
  assert.match(noHome.html, /<div class="tour-row"><button class="btn" data-tour-pick>Choose a folder<\/button><\/div>/, 'with no home folder known, the card still has the one way to pick');
  assert.equal(noHome.found['data-tour-pick']?.focused ?? 0, 1, 'and it takes focus, not Skip');
  assert.doesNotMatch(tourCard('welcome', { heroUp: true }).html, /data-tour-pick/, 'with the welcome on screen, its own button is the one way');
  const quiet = tourCard('welcome', { heroUp: false, takeFocus: false });
  assert.equal(Object.values(quiet.found).reduce((n, b) => n + b.focused, 0) + quiet.$('emptyBrowseBtn').focused, 0, 'a repaint asked not to take focus takes none');

  // tourFollowView: called by switchView, it repaints the welcome card when
  // whether the welcome's button is on screen no longer matches the card.
  const follow = INDEX.slice(INDEX.indexOf('function tourFollowView'), INDEX.indexOf('/** A quick win'));
  const run = (o: { step?: string; active?: boolean; offered: boolean; heroUp: boolean; inCard?: boolean }) => {
    const card = tel(); card.innerHTML = o.offered ? '<button class="btn" data-tour-pick>Choose a folder</button>' : '';
    card.querySelector = (sel: string) => (sel === '[data-tour-pick]' && card.innerHTML.includes('data-tour-pick') ? tel() : null);
    card.contains = () => o.inCard === true;
    const hero = tel(o.heroUp ? 1 : 0);
    const renders: unknown[] = [];
    new Function('$', 'tour', 'tourRender', 'document', `'use strict'; ${follow} tourFollowView();`)(
      (id: string) => (id === 'tourCard' ? card : id === 'emptyBrowseBtn' ? hero : tel()), { active: o.active ?? true, step: o.step ?? 'welcome' },
      (takeFocus: unknown) => { renders.push(takeFocus); }, { activeElement: {} });
    return renders;
  };
  assert.deepEqual(run({ offered: false, heroUp: false }), [false], 'the welcome went off screen: the card repaints, offering the picker, without taking focus from the view just opened');
  assert.deepEqual(run({ offered: true, heroUp: true }), [false], 'it came back: the card repaints without its own');
  assert.deepEqual(run({ offered: true, heroUp: true, inCard: true }), [true], 'focus that was on the card\'s button goes with the repaint, not to <body>');
  assert.deepEqual(run({ offered: true, heroUp: false }), [], 'nothing changed: no repaint');
  assert.deepEqual(run({ offered: false, heroUp: true }), [], 'nothing changed: no repaint');
  assert.deepEqual(run({ offered: false, heroUp: false, step: 'map' }), [], 'only the welcome step offers the picker');
  assert.deepEqual(run({ offered: false, heroUp: false, active: false }), [], 'and only while the tour is up');
});

test('"Skip the tour" sits in the card\'s header on every step, never alone on a second row of buttons (G03)', () => {
  const win = { title: 'Rust build target', description: 'Cargo build output and fetched crates', totalSize: 78_800_000,
    items: [{ name: 'target', path: '/c/rusty/target', size: 78_800_000 }] };
  for (const [step, opts] of [['welcome', { heroUp: true }], ['scanning', {}], ['map', {}], ['win', { win }]] as const) {
    const card = tourCard(step, opts);
    const head = /<div class="tour-head"><span class="tour-step">[^<]+<\/span><button class="tour-skip" data-tour-skip>Skip the tour<\/button><\/div>/.exec(card.html);
    assert.ok(head, `${step}: Skip is in the header: ${card.html}`);
    const row = card.html.slice(card.html.indexOf('<div class="tour-row">'));
    assert.ok(card.html.indexOf('<div class="tour-row">') === -1 || !row.includes('data-tour-skip'), `${step}: and not in the row of actions`);
    assert.equal((card.html.match(/data-tour-skip/g) || []).length, 1, `${step}: once`);
  }
  const css = INDEX.slice(INDEX.indexOf('/* ── v4 §9.2: the first-run coach card ── */'), INDEX.indexOf('#rcPopover .rc-pop-head'));
  assert.match(css, /\.tour-card \.tour-head \{ display: flex; align-items: center; justify-content: space-between;/, 'the header lays the step and Skip out on one line');
  assert.match(css, /\.tour-card \.tour-skip \{[^}]*min-height: 24px;/, 'Skip keeps a 24 px target');
});

test('a quick win says what it found — the rule\'s plain words, each item\'s name and size — never the matcher\'s wording (G04)', () => {
  const line = liftPage<(g: unknown) => string>(WIN_LINE, 'tourWinLine');
  const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const why = 'A folder named .next; or a folder named dist sitting next to package.json, next.config.*';
  const one = line({ description: 'Framework build output — rebuilt by the next build', why, totalSize: 12_300_000,
    items: [{ name: '.next', path: '/c/webapp/.next', size: 12_300_000 }] });
  assert.doesNotMatch(one, /folder named|sitting next to|next\.config/, `no matcher wording: ${one}`);
  assert.equal(text(one), 'Framework build output — rebuilt by the next build. .next in webapp 12.3 MB');
  const four = line({ description: 'Python bytecode cache', why, totalSize: 4_000,
    items: [1, 2, 3, 4].map((i) => ({ name: '__pycache__', path: `/c/p${i}/__pycache__`, size: 1_000 })) });
  assert.equal(text(four), 'Python bytecode cache. __pycache__ in p1 1.0 KB __pycache__ in p2 1.0 KB __pycache__ in p3 1.0 KB and 1 more',
    'three named, the rest counted');
  const listed = (n: number, size: (i: number) => number, totalSize: number) => line({ description: 'OS junk', totalSize,
    items: Array.from({ length: n }, (_, i) => ({ name: '.DS_Store', path: `/c/d${i}/.DS_Store`, size: size(i) })) });
  assert.equal(liftPage<number>(['SUGGESTION_ITEMS_LISTED'], 'SUGGESTION_ITEMS_LISTED'), ITEMS_PER_RULE, 'the page counts on the server\'s own cap on a rule\'s list');
  assert.match(text(listed(ITEMS_PER_RULE - 1, () => 1_000, (ITEMS_PER_RULE - 1) * 1_000)), new RegExp(`and ${ITEMS_PER_RULE - 4} more$`),
    'a list shorter than the cap holds every match, so the rest are counted');
  assert.match(text(listed(ITEMS_PER_RULE, () => 1_000, 900_000)), /\.DS_Store in d2 1\.0 KB and more$/, 'a list the server cut short is not given a count it does not have');
  // A rule matching empty files (.DS_Store, Thumbs.db) can list as many
  // bytes as its total while matches past the cap go unlisted (review F1.4).
  const sumsUp = text(listed(ITEMS_PER_RULE, (i) => (i < 3 ? 6_000 : 0), 18_000));
  assert.match(sumsUp, /and more$/, `a full list whose sizes add up to the total is not proof it holds every match: ${sumsUp.slice(-40)}`);
  assert.doesNotMatch(sumsUp, /\d more$/, 'so no count is given');
  assert.match(line({ description: 'a <b>', totalSize: 1, items: [{ name: '<i>', path: '/<u>/<i>', size: 1 }] }), /a &lt;b&gt;\.[\s\S]*<b>&lt;i&gt;<\/b> <span class="muted">in &lt;u&gt;<\/span>/, 'everything escaped');
  const card = tourCard('win', { win: { title: 'Web framework build', description: 'Framework build output', why, totalSize: 12_300_000,
    items: [{ name: '.next', path: '/c/webapp/.next', size: 12_300_000 }] } });
  assert.match(card.html, /<h4>[^<]*Web framework build — 12300000 B<\/h4>/, 'the card is headed by the rule\'s own plain title');
  assert.doesNotMatch(card.html, /folder named/, 'and the matcher wording is nowhere on it');
});

test('the last step does not point at a cart that is not on screen (G04)', () => {
  const none = tourCard('cart', { added: [] });
  assert.doesNotMatch(none.text, /The cart at the bottom is where/, 'nothing staged: the cart is not drawn, so it is not pointed at');
  assert.match(none.text, /You added nothing — also fine\. Anything you add later waits in a cleanup cart that appears at the bottom right once it holds something\./, none.text);
  const some = tourCard('cart', { added: ['/c/a', '/c/b'], cart: ['/c/a', '/c/b'] });
  assert.match(some.text, /Everything you added is waiting in the cleanup cart at the bottom right\. Committing the cart/, some.text);
});

test('the last step reads what this run added against the cart as it is now, and a restarted tour starts with nothing added (review F1.1)', () => {
  // The sentence was chosen by a count of adds kept for the session: after
  // a run that added something, a commit that emptied the cart and Settings
  // › Show the welcome tour again, a run that added nothing still said
  // "Everything you added is waiting in the cleanup cart at the bottom
  // right" over a cart that was not drawn.
  const staged = tourCard('cart', { added: ['/c/a', '/c/b'], cart: ['/c/a', '/c/b', '/c/older'] });
  assert.match(staged.text, /Everything you added is waiting in the cleanup cart at the bottom right\./, staged.text);
  assert.doesNotMatch(staged.text, /Nothing has been deleted/, 'no claim about deletions the cart cannot vouch for: the header already says "deleted only when you say so"');
  const gone = tourCard('cart', { added: ['/c/a'], cart: [] });
  assert.doesNotMatch(gone.text, /Everything you added is waiting|You added nothing/, `taken out or committed since: neither "waiting" nor "nothing added": ${gone.text}`);
  assert.match(gone.text, /Everything you added has since left the cart\. The cleanup cart shows at the bottom right whenever it holds something\./, gone.text);
  const part = tourCard('cart', { added: ['/c/a', '/c/b'], cart: ['/c/a'] });
  assert.match(part.text, /Some of what you added has since left the cart\. The cleanup cart shows at the bottom right whenever it holds something\./, part.text);
  const older = tourCard('cart', { added: [], cart: ['/c/older'] });
  assert.match(older.text, /You added nothing — also fine\./, 'what was staged before this run is not this run\'s');

  // "Add to cart" records the paths it put in the cart, and only those: one
  // already staged before the tour was not added by it.
  const win = { title: 'Rust build target', description: 'Cargo build output', totalSize: 10,
    items: [{ name: 'target', path: '/c/one/target', size: 5 }, { name: 'target', path: '/c/two/target', size: 5 }] };
  const card = tourCard('win', { win, cart: ['/c/one/target'] });
  const add = card.found['data-tour-add'];
  assert.ok(add?.listeners.click?.length, 'control: the add button is wired');
  add.listeners.click.forEach((fn) => fn());
  assert.deepEqual(card.tour.added, ['/c/two/target'], 'this run added the one path it put in the cart');
  assert.ok(card.cart.has('/c/two/target'), 'control: and it is in the cart');

  // A restart begins a new run: nothing added, no wins, no reason left over.
  const start = INDEX.slice(INDEX.indexOf('function tourMaybeStart'), INDEX.indexOf('async function tourFinish'));
  const tour = { active: false, step: 'cart', wins: [win], winIx: 2, added: ['/c/a'], unknownReason: 'Could not check: offline' };
  let rendered = 0;
  new Function('tour', 'state', 'tourRender', `'use strict'; ${start} tourMaybeStart(false);`)(tour, { scanId: 's1' }, () => { rendered++; });
  assert.equal(rendered, 1, 'control: the tour started');
  assert.equal(tour.step, 'map', 'control: a scanned session opens on the map');
  assert.deepEqual(tour.added, [], 'nothing added yet in this run');
  assert.deepEqual(tour.wins, [], 'no wins from the last run');
  assert.equal(tour.winIx, 0, 'and none counted');
  assert.equal(tour.unknownReason, '', 'and no reason left from the last run');
});

test('Add and Skip on a quick win move to the next, and the last step reads every add of the run against the cart (review F2.7)', () => {
  // Overwriting the run's adds with the last win's, an Add that stays put,
  // or a last advance that misses the cart step each passed every test: the
  // one Add pressed in them started from nothing, on the only win.
  const w1 = { title: 'Rust build target', description: 'Cargo build output', totalSize: 10,
    items: [{ name: 'target', path: '/c/a1/target', size: 5 }, { name: 'target', path: '/c/a2/target', size: 5 }] };
  const w2 = { title: 'Python bytecode', description: 'Python bytecode cache', totalSize: 4,
    items: [{ name: '__pycache__', path: '/c/b1/__pycache__', size: 4 }] };
  const press = (card: ReturnType<typeof tourCard>, key: string) => {
    const button = card.found[key];
    assert.ok(button?.listeners.click?.length, `${key} is on the card and wired`);
    button.listeners.click.forEach((fn) => fn());
  };
  const card = tourCard('win', { wins: [w1, w2] });
  assert.match(card.text, /Quick win 1 of 2/, 'control: the first win');
  press(card, 'data-tour-add');
  assert.deepEqual(card.tour.added, ['/c/a1/target', '/c/a2/target'], 'the first win\'s two paths are this run\'s');
  assert.deepEqual([card.tour.step, card.tour.winIx], ['win', 1], 'Add moves on to the next win');
  assert.match(card.now().text, /Quick win 2 of 2/, 'and paints its card');
  card.cart.delete('/c/a2/target'); // taken out of the cart by hand
  press(card, 'data-tour-add');
  assert.deepEqual(card.tour.added, ['/c/a1/target', '/c/a2/target', '/c/b1/__pycache__'], 'the second win\'s path joins the first\'s, not in place of them');
  assert.equal(card.tour.step, 'cart', 'after the last win, the cart step');
  assert.match(card.now().text, /Some of what you added has since left the cart\./, `one of the run\'s adds left the cart: ${card.now().text}`);

  // "Skip this one" moves on the same way, adding nothing.
  const skipped = tourCard('win', { wins: [w1, w2] });
  press(skipped, 'data-tour-next');
  assert.deepEqual([skipped.tour.step, skipped.tour.winIx], ['win', 1], 'Skip this one moves on to the next win');
  assert.match(skipped.now().text, /Quick win 2 of 2/, 'and paints its card');
  press(skipped, 'data-tour-next');
  assert.equal(skipped.tour.step, 'cart', 'skipping the last win reaches the cart step too');
  assert.deepEqual(skipped.tour.added, [], 'with nothing added');
  assert.match(skipped.now().text, /You added nothing — also fine\./, skipped.now().text);
});

test('the cart step follows the cart: taken out, cleared or committed while its card is up, the sentence changes with it (review F2.3)', async () => {
  // The card is not modal: the cart's Clear, its remove buttons and a commit
  // all work beside it. It read the cart once, at paint, and went on saying
  // "Everything you added is waiting in the cleanup cart at the bottom right"
  // over a cart that was no longer drawn.
  const card = tourCard('cart', { added: ['/c/a', '/c/b'], cart: ['/c/a', '/c/b'] });
  assert.match(card.text, /Everything you added is waiting in the cleanup cart at the bottom right\./, `control: ${card.text}`);
  card.cart.delete('/c/b');
  card.cartChanged();
  assert.match(card.now().text, /Some of what you added has since left the cart\./, `one taken out: ${card.now().text}`);
  card.cart.clear();
  card.cartChanged();
  assert.match(card.now().text, /Everything you added has since left the cart\./, `cleared or committed: ${card.now().text}`);
  assert.doesNotMatch(card.now().text, /is waiting/, 'and nothing is said to be waiting');
  // Focus stays where the person is — on the cart's own buttons — unless it was on the card's Finish, which the repaint replaces.
  assert.equal(card.found['data-tour-done']?.focused ?? 0, 0, 'the repaint takes no focus the card did not hold');
  card.$('tourCard').contains = () => true;
  card.cartChanged();
  assert.equal(card.found['data-tour-done']?.focused ?? 0, 1, 'focus that was on Finish goes to the new Finish, not to <body>');
  // Other steps do not read the cart's contents into their words, and are left as painted.
  const map = tourCard('map');
  map.cartChanged();
  assert.equal(map.now().paints, 1, 'a change of cart does not repaint the map step');
  const over = tourCard('cart', { added: ['/c/a'], cart: ['/c/a'] });
  over.tour.active = false;
  over.cartChanged();
  assert.equal(over.now().paints, 1, 'nor a tour that is over');

  // renderCart, the one render every change of the cart goes through, tells the tour — once the dock shows or hides.
  const renderSrc = pageFn('async function renderCart(');
  const calls: string[] = [];
  const dock = { shown: false, classList: { toggle: (c: string, on: boolean) => { if (c === 'show') dock.shown = on; } } };
  const inert: unknown = new Proxy(function inert() { /* stand-in */ }, {
    get: (_t, k) => (k === Symbol.toPrimitive ? () => 0 : k === 'then' ? undefined : inert), set: () => true, apply: () => inert });
  const state = { cart: new Set(['/c/a']) };
  const given: Record<string, unknown> = {
    state, $: (id: string) => (id === 'cartDock' ? dock : inert), ensureNodes: async () => {},
    tourCartChanged: () => { calls.push(`tour told, dock ${dock.shown ? 'shown' : 'hidden'}`); },
  };
  const scope = new Proxy(given, { has: (_t, k) => typeof k === 'string' && k !== 'renderCart', get: (t, k) => (k === Symbol.unscopables ? undefined : k in t ? t[k as string] : inert), set: (t, k, v) => { t[k as string] = v; return true; } });
  const renderCart = new Function('scope', `with (scope) { ${renderSrc}\nreturn renderCart; }`)(scope) as () => Promise<void>;
  await renderCart();
  state.cart.clear();
  await renderCart();
  assert.deepEqual(calls, ['tour told, dock shown', 'tour told, dock hidden'], 'each render tells the tour once, after the dock shows or hides');
});

test('a first run, with nothing scanned, opens on the welcome card; a scanned session on the map (review F2.8)', () => {
  // The branch a brand-new person takes: with no scan yet the tour begins at
  // "Start with one folder", not at a map that is not there.
  const start = INDEX.slice(INDEX.indexOf('function tourMaybeStart'), INDEX.indexOf('async function tourFinish'));
  const run = (scanId: string | null, done: unknown = false, active = false) => {
    const tour = { active, step: 'cart', wins: [], winIx: 0, added: [], unknownReason: '' };
    let rendered = 0;
    new Function('tour', 'state', 'tourRender', `'use strict'; ${start} tourMaybeStart(arguments[3]);`)(tour, { scanId }, () => { rendered++; }, done);
    return { step: tour.step, rendered, active: tour.active };
  };
  assert.deepEqual(run(null), { step: 'welcome', rendered: 1, active: true }, 'nothing scanned: the welcome card, painted once');
  assert.deepEqual(run('s1'), { step: 'map', rendered: 1, active: true }, 'control: a scanned session opens on the map');
  assert.deepEqual(run(null, true), { step: 'cart', rendered: 0, active: false }, 'a tour already finished does not start');
  assert.deepEqual(run(null, false, true), { step: 'cart', rendered: 0, active: true }, 'nor does one already running start over');
});

test('Finish, Skip or Escape never drop focus to <body>: it lands on the page\'s primary action, the map, or the view (G11)', async () => {
  const finish = INDEX.slice(INDEX.indexOf('async function tourFinish'), INDEX.indexOf('function tourRender'));
  const run = async (opts: { heroUp?: boolean; view?: string; mapUp?: boolean; inCard?: boolean; noControl?: boolean }) => {
    const els: Record<string, TEl> = {};
    const $ = (id: string) => (els[id] ??= tel(0));
    $('tourOverlay').contains = () => opts.inCard !== false;
    $('emptyBrowseBtn').rects = opts.heroUp ? 1 : 0;
    $('treemapCanvas').rects = opts.mapUp ? 1 : 0;
    const control = tel(); const tab = tel();
    const fn = new Function('$', 'tour', 'state', 'api', 'toast', 'document', 'activeViewControl', `'use strict'; ${finish} return tourFinish;`)(
      $, { active: true }, { view: opts.view ?? 'treemap' }, async () => ({}), () => {},
      { activeElement: {}, querySelector: (sel: string) => (sel === '.tabbar button[aria-selected="true"]' ? tab : null) }, () => (opts.noControl ? null : control)) as (m: string) => Promise<void>;
    await fn('Tour complete');
    return { hero: $('emptyBrowseBtn').focused, map: $('treemapCanvas').focused, control: control.focused, tab: tab.focused, hidden: $('tourOverlay').hidden };
  };
  const onMap = await run({ view: 'treemap', mapUp: true });
  assert.equal(onMap.hidden, true, 'the card goes');
  assert.equal(onMap.map, 1, 'on the map, focus goes to the map, which the card was just describing');
  const welcome = await run({ heroUp: true, view: 'dashboard' });
  assert.equal(welcome.hero, 1, 'skipped from the welcome: the welcome\'s own "Choose a folder"');
  const other = await run({ view: 'apps' });
  assert.equal(other.control, 1, 'elsewhere, the view\'s first control');
  // A view with no enabled control on screen: the last fallback (review F1.9).
  const bare = await run({ view: 'trends', noControl: true });
  assert.deepEqual([bare.hero, bare.map, bare.control, bare.tab], [0, 0, 0, 1], 'nothing to press in the view: its own tab takes focus');
  const away = await run({ view: 'treemap', mapUp: true, inCard: false });
  assert.deepEqual([away.map, away.hero, away.control, away.tab], [0, 0, 0, 0], 'focus that was not in the card is left where it is');
  // "Scan my home folder" repaints the card as the scanning step, which has no
  // row of actions: focus on the button that is gone lands on the control left.
  const scanning = tourCard('scanning');
  assert.equal(scanning.found['data-tour-skip']?.focused, 1, 'the scanning card\'s one control, Skip, takes focus');
  // A quick win already in the cart has its "Already in the cart" disabled:
  // focus on a disabled button goes nowhere, so the next enabled action takes it.
  const win = { title: 'Rust build target', description: 'Cargo build output', totalSize: 5, items: [{ name: 'target', path: '/c/rusty/target', size: 5 }] };
  const inCart = tourCard('win', { win, cart: ['/c/rusty/target'] });
  assert.match(inCart.html, /data-tour-add disabled>Already in the cart</, 'control: the add button is disabled');
  assert.equal(inCart.found['data-tour-next']?.focused ?? 0, 1, '"Skip this one" takes focus, not the disabled button');
  const fresh = tourCard('win', { win });
  assert.equal(fresh.found['data-tour-add']?.focused ?? 0, 1, 'a win not yet staged focuses "Add to cart"');
});

/* ══════════════ Review F1.11 — a scan's chrome never leaves focus on <body> ══════════════ */

/** A page function by its declaration, brace-matched, out of the built page. */
function pageFn(decl: string): string {
  const start = INDEX.indexOf(decl);
  assert.notEqual(start, -1, `${decl} is in the page`);
  let depth = 0;
  for (let i = INDEX.indexOf('{', INDEX.indexOf(')', start)); i < INDEX.length; i++) {
    if (INDEX[i] === '{') depth++;
    else if (INDEX[i] === '}' && --depth === 0) return INDEX.slice(start, i + 1);
  }
  return assert.fail(`${decl} never closes`);
}

test('a scan started from a button its own chrome then hides moves focus on — to the tour card, the view, or its tab — never to <body> (review F1.11)', () => {
  // The welcome's "Choose a folder" opens the folder browser; "Scan this
  // folder" closes it, and the browser hands focus back to that button as
  // it closes. The scan's chrome then hid the button (#emptyState), and
  // focus fell to <body> for the whole scan. Trends' and History's "Choose
  // a folder", hidden by the switch to the Dashboard, did the same.
  const kept = pageFn('function withFocusKept(');
  const run = (o: { had?: 'button' | 'body'; hides?: boolean; tour?: boolean; control?: boolean }) => {
    // <body> is passed over whatever box it has, so here it has none; and the
    // document reports focus on <body> the moment the button stops painting,
    // as a browser's focus fixup may — so what held focus is read before.
    const button = tel(1); const body = tel(0); const skip = tel(); const control = tel(); const tab = tel();
    const doc = {
      body, get activeElement() { return o.had === 'body' || button.rects === 0 ? body : button; },
      querySelector: (sel: string) => (sel === '.tabbar button[aria-selected="true"]' ? tab : null),
    };
    let changed = 0;
    new Function('document', 'tourCardControl', 'activeViewControl', `'use strict'; ${kept} withFocusKept(arguments[3]);`)(
      doc, () => (o.tour ? skip : null), () => (o.control === false ? null : control), () => { changed++; if (o.hides !== false) button.rects = 0; });
    return { changed, button: button.focused, skip: skip.focused, control: control.focused, tab: tab.focused };
  };
  assert.deepEqual(run({ tour: true }), { changed: 1, button: 0, skip: 1, control: 0, tab: 0 }, 'the tour card is up: its own control takes focus — the scanning card\'s Skip');
  assert.deepEqual(run({ tour: false }), { changed: 1, button: 0, skip: 0, control: 1, tab: 0 }, 'no tour: the first control of the view now up');
  assert.deepEqual(run({ tour: false, control: false }), { changed: 1, button: 0, skip: 0, control: 0, tab: 1 }, 'nothing to press in it: the view\'s tab');
  assert.deepEqual(run({ tour: true, hides: false }), { changed: 1, button: 0, skip: 0, control: 0, tab: 0 }, 'focus on a control still on screen is left where it is');
  assert.deepEqual(run({ tour: true, had: 'body' }), { changed: 1, button: 0, skip: 0, control: 0, tab: 0 }, 'and focus nobody had placed is not taken');

  // beginScanChrome hides the empty state and brings the Dashboard up inside it.
  const begin = pageFn('function beginScanChrome(');
  const order: string[] = [];
  // Every name but these is an inert stand-in that accepts any call or property.
  const inert: unknown = new Proxy(function inert() { /* stand-in */ }, { get: (_t, k) => (k === Symbol.toPrimitive ? () => 0 : inert), set: () => true, apply: () => inert });
  const emptyState = { style: { display: 'flex' } as Record<string, string> };
  const $ = (id: string) => (id === 'emptyState' ? emptyState : inert);
  const given: Record<string, unknown> = {
    state: { scanGen: 0, whatsNew: { seq: 0 } }, $,
    switchView: (name: string) => { order.push(`switch ${name} (empty state ${emptyState.style.display})`); },
    withFocusKept: (change: () => void) => { order.push('kept: before'); change(); order.push('kept: after'); },
  };
  const scope = new Proxy(given, { has: (_t, k) => typeof k === 'string' && k !== 'beginScanChrome', get: (t, k) => (k === Symbol.unscopables ? undefined : k in t ? t[k as string] : inert), set: (t, k, v) => { t[k as string] = v; return true; } });
  const chrome = new Function('scope', `with (scope) { ${begin}\nreturn beginScanChrome; }`)(scope) as (o?: { quiet?: boolean }) => void;
  chrome({ quiet: true });
  assert.deepEqual(order, [], 'control: a quiet start hides nothing');
  chrome();
  assert.deepEqual(order, ['kept: before', 'switch dashboard (empty state none)', 'kept: after'], 'the empty state goes and the Dashboard comes up inside withFocusKept');

  // tourCardControl: the card's own control, only while the card is up.
  const control = pageFn('function tourCardControl(');
  const pick = (o: { active?: boolean; hidden?: boolean; html: string }) => {
    const host = tel(); host.innerHTML = o.html;
    host.querySelector = (sel: string) => {
      const enabledOnly = sel.endsWith(':not([disabled])');
      const base = enabledOnly ? sel.slice(0, -':not([disabled])'.length) : sel;
      const hit = [...o.html.matchAll(/<button\b([^>]*)>([^<]*)</g)].find((m) => (!enabledOnly || !/\bdisabled\b/.test(m[1])) &&
        (base === '.btn-primary' ? /btn-primary/.test(m[1]) : base === '.tour-row button' ? /data-tour-(?!skip)/.test(m[1]) : m[1].includes(base.slice(1, -1))));
      return hit ? Object.assign(tel(), { innerHTML: hit[2] }) : null;
    };
    const overlay = Object.assign(tel(), { hidden: o.hidden === true });
    const got = new Function('$', 'tour', `'use strict'; ${control} return tourCardControl();`)((id: string) => (id === 'tourCard' ? host : overlay), { active: o.active !== false }) as TEl | null;
    return got ? got.innerHTML : null;
  };
  const scanning = '<div class="tour-head"><button class="tour-skip" data-tour-skip>Skip the tour</button></div>';
  assert.equal(pick({ html: scanning }), 'Skip the tour', 'the scanning card: Skip, its one control');
  assert.equal(pick({ html: '<button class="tour-skip" data-tour-skip>Skip the tour</button><div class="tour-row"><button class="btn btn-primary" data-tour-wins>Show me</button></div>' }), 'Show me', 'else its primary action');
  assert.equal(pick({ html: '<button class="tour-skip" data-tour-skip>Skip the tour</button><div class="tour-row"><button class="btn btn-primary" data-tour-add disabled>In the cart</button><button class="btn" data-tour-next>Skip this one</button></div>' }),
    'Skip this one', 'a disabled primary is passed over');
  assert.equal(pick({ html: scanning, hidden: true }), null, 'the card is down: nothing');
  assert.equal(pick({ html: scanning, active: false }), null, 'the tour is over: nothing');
});

/* ══════════════ Review F1.12 — a failed first scan gives focus back to the welcome's button ══════════════ */

test('a failed first scan paints the welcome card once, with the welcome\'s own "Choose a folder" on screen, and focus goes straight to it (review F1.12)', () => {
  // failScan put the card back (tourScanFailed) before switchView had put
  // the welcome back on screen, so the card picked its focus while the
  // welcome's button was not painted: "Scan my home folder" took it — Enter
  // then scanned the home folder — and with no home folder known, Skip did.
  const fail = pageFn('function failScan(');
  const failed = pageFn('function tourScanFailed(');
  const card = INDEX.slice(INDEX.indexOf('function tourRender'), INDEX.indexOf('/** A quick win'));
  const doc: { activeElement: unknown } = { activeElement: null };
  const focusable = (rects = 1): TEl => { const e = tel(rects); e.focus = () => { e.focused++; doc.activeElement = e; }; return e; };
  const found: Record<string, TEl> = {};
  const els: Record<string, TEl> = {};
  const $ = (id: string) => (els[id] ??= Object.assign(focusable(), { classList: { add() {}, remove() {} } }));
  const host = $('tourCard');
  let paints = 0; let html = '';
  Object.defineProperty(host, 'innerHTML', { get: () => html, set: (v: string) => { paints++; html = v; } });
  host.querySelector = cardFinder(host, found, () => focusable());
  host.contains = (n: unknown) => Object.values(found).includes(n as TEl);
  $('emptyBrowseBtn').rects = 0; // the scan's chrome hid the empty state
  doc.activeElement = Object.assign(focusable(), {}); // the scanning card's Skip, say
  const tour = { active: true, step: 'scanning', wins: [], winIx: 0, added: [], unknownReason: '' };
  const state = { view: 'dashboard', system: { homeDir: '/Users/x' }, cart: new Set(), root: null };
  const order: string[] = [];
  const run = new Function('$', 'tour', 'state', 'icon', 'escapeHtml', 'formatBytes', 'startScan', 'openBrowse', 'tourLoadWins', 'tourFinish', 'cartAddMany',
    'tourAdvanceWin', 'tourWinLine', 'document', 'endScanChrome', 'restoreDashboardPanels', 'toast', 'switchView', 'drainScanQueue',
    `'use strict'; ${card} ${failed} ${fail} return { failScan, tourFollowView };`);
  const page = run($, tour, state, () => '', (s: string) => s, (n: number) => `${n} B`, () => {}, () => {}, () => {}, () => {}, () => 0, () => {}, () => '', doc,
    () => {}, () => {}, () => {},
    // switchView puts the welcome back on screen and, as on the page, tells the card.
    (name: string) => { order.push(`switch ${name}`); $('emptyBrowseBtn').rects = 1; page.tourFollowView(); }, () => {},
  ) as { failScan: (m: string) => void; tourFollowView: () => void };
  page.failScan('Path does not exist');
  assert.deepEqual(order, ['switch dashboard'], 'control: the view the person was on is put back');
  assert.equal(tour.step, 'welcome', 'control: the welcome card is back');
  assert.equal($('emptyBrowseBtn').focused, 1, 'focus goes to the welcome\'s own "Choose a folder"');
  assert.deepEqual(Object.fromEntries(Object.entries(found).map(([k, b]) => [k, b.focused])), Object.fromEntries(Object.keys(found).map((k) => [k, 0])),
    'and never first to a button of the card — "Scan my home folder", or a "Choose a folder" the next paint takes away');
  assert.equal(paints, 1, 'the card is painted once, for the screen it is on');
  assert.doesNotMatch(html, /data-tour-pick/, 'with the welcome\'s button on screen, the card offers no second one');
});

/* ══════════════ Review F1.10 — the closing steps offer only Finish ══════════════ */

test('the closing steps — all clean, could not check, the cart — offer one button, Finish, and no "Skip the tour" (review F1.10)', () => {
  // A tour at its last card has nothing left to skip: Skip there would sit
  // beside Finish, two ways to the same end, and only the welcome-to-win
  // steps were ever rendered by a test.
  const closing: Array<[string, Parameters<typeof tourCard>[1]]> = [['clean', {}], ['unknown', {}], ['cart', { added: [] }], ['cart', { added: ['/c/a'], cart: ['/c/a'] }]];
  for (const [step, opts] of closing) {
    const card = tourCard(step, opts);
    const buttons = [...card.html.matchAll(/<button\b[^>]*>[^<]*<\/button>/g)].map((m) => m[0]);
    assert.deepEqual(buttons, ['<button class="btn btn-primary" data-tour-done>Finish</button>'], `${step}: Finish alone: ${card.html}`);
    assert.doesNotMatch(card.html, /data-tour-skip|Skip the tour/, `${step}: no Skip`);
    assert.equal(card.found['data-tour-done']?.focused ?? 0, 1, `${step}: and Finish takes focus`);
  }
});
