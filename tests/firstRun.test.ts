import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-firstrun-test-');
process.env.TREEMAP_NO_GDU = '1';

import { getSettings, updateSettings } from '../src/services/settings';
import { lift as liftPage } from './fixtures/liftFrontend';

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

test('the welcome card never focuses a hidden input — found by driving the zero-state; it now hands the folder browser to the welcome\'s own button (G03)', () => {
  // Before any scan the top path box is offscreen; focus() on it was a silent
  // no-op, so "I'll pick my own" fell back to the folder browser — the same
  // browser the welcome's own "Choose a folder to get started" opens. The card
  // no longer offers that second way to it (design pass G03), so it has no
  // path box to focus at all.
  const render = INDEX.slice(INDEX.indexOf('function tourRender'), INDEX.indexOf('/** A quick win'));
  assert.doesNotMatch(render, /data-tour-pick/, 'no "I\'ll pick my own"');
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
  const line = liftPage<(g: { description?: string; why?: string }) => string>(['UNITS', 'UI_LOCALE', 'escapeHtml', 'formatBytes', 'formatCount', 'TOUR_WIN_ITEMS', 'tourWinLine'], 'tourWinLine');
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

/** The tour card's renderer out of the built page, over a stub card that finds what its HTML holds. */
function tourCard(step: string, opts: { home?: string | null; heroUp?: boolean; staged?: number; win?: Record<string, unknown> } = {}) {
  const els: Record<string, TEl> = {};
  const $ = (id: string) => (els[id] ??= tel());
  const host = $('tourCard');
  const found: Record<string, TEl> = {};
  host.querySelector = (sel) => {
    const h = host.innerHTML;
    if (sel === '.btn-primary') return /class="btn btn-primary"/.test(h) ? (found.primary ??= tel()) : null;
    if (sel === '.tour-row button') {
      const row = h.indexOf('<div class="tour-row">');
      return row !== -1 && h.indexOf('<button', row) !== -1 ? (found.rowFirst ??= tel()) : null;
    }
    const attr = /^\[([\w-]+)\]$/.exec(sel);
    if (attr) return h.includes(attr[1]) ? (found[attr[1]] ??= tel()) : null;
    if (sel === 'button') return h.includes('<button') ? (found.firstButton ??= tel()) : null;
    return null;
  };
  $('emptyBrowseBtn').rects = opts.heroUp ? 1 : 0;
  const winLine = liftPage<(g: unknown) => string>(['UNITS', 'UI_LOCALE', 'escapeHtml', 'formatBytes', 'formatCount', 'TOUR_WIN_ITEMS', 'tourWinLine'], 'tourWinLine');
  const tour = { active: true, step, wins: opts.win ? [opts.win] : [], winIx: 0, staged: opts.staged ?? 0, unknownReason: '' };
  const render = INDEX.slice(INDEX.indexOf('function tourRender'), INDEX.indexOf('/** A quick win'));
  const fn = new Function('$', 'tour', 'state', 'icon', 'escapeHtml', 'formatBytes', 'startScan', 'openBrowse', 'tourLoadWins', 'tourFinish', 'cartAddMany',
    'tourAdvanceWin', 'tourWinLine', 'document', `'use strict'; ${render} return tourRender;`)(
    $, tour, { system: { homeDir: opts.home === undefined ? '/Users/x' : opts.home }, cart: new Set(), root: null }, () => '', (s: string) => s,
    (n: number) => `${n} B`, () => {}, () => {}, () => {}, () => {}, () => 0, () => {}, winLine, { activeElement: null }) as () => void;
  fn();
  return { html: host.innerHTML, text: host.innerHTML.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(), found, $ };
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
  assert.equal(elsewhere.found.rowFirst?.focused ?? 0, 1, 'with no welcome on screen the card\'s own action takes focus');
  assert.equal(elsewhere.found['data-tour-skip']?.focused ?? 0, 0, 'never Skip');

  const noHome = tourCard('welcome', { home: null, heroUp: true });
  assert.doesNotMatch(noHome.html, /<div class="tour-row">/, 'no home folder known: no empty row of actions');
  assert.match(noHome.text, /Pick a folder to look at first — scanning only reads it; nothing is moved or deleted\.$/, noHome.text);
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
  const line = liftPage<(g: unknown) => string>(['UNITS', 'UI_LOCALE', 'escapeHtml', 'formatBytes', 'formatCount', 'TOUR_WIN_ITEMS', 'tourWinLine'], 'tourWinLine');
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
  const capped = line({ description: 'Node modules', totalSize: 9_000, items: [1, 2, 3, 4].map((i) => ({ name: 'node_modules', path: `/c/p${i}/node_modules`, size: 1_000 })) });
  assert.match(text(capped), /and more$/, 'a list the server cut short is not given a count it does not have');
  assert.match(line({ description: 'a <b>', totalSize: 1, items: [{ name: '<i>', path: '/<u>/<i>', size: 1 }] }), /a &lt;b&gt;\.[\s\S]*<b>&lt;i&gt;<\/b> <span class="muted">in &lt;u&gt;<\/span>/, 'everything escaped');
  const card = tourCard('win', { win: { title: 'Web framework build', description: 'Framework build output', why, totalSize: 12_300_000,
    items: [{ name: '.next', path: '/c/webapp/.next', size: 12_300_000 }] } });
  assert.match(card.html, /<h4>[^<]*Web framework build — 12300000 B<\/h4>/, 'the card is headed by the rule\'s own plain title');
  assert.doesNotMatch(card.html, /folder named/, 'and the matcher wording is nowhere on it');
});

test('the last step does not point at a cart that is not on screen (G04)', () => {
  const none = tourCard('cart', { staged: 0 });
  assert.doesNotMatch(none.text, /The cart at the bottom is where/, 'nothing staged: the cart is not drawn, so it is not pointed at');
  assert.match(none.text, /You added nothing — also fine\. Anything you add later waits in a cleanup cart that appears at the bottom right once it holds something\./, none.text);
  const some = tourCard('cart', { staged: 2 });
  assert.match(some.text, /Everything you added is waiting in the cleanup cart at the bottom right\. Nothing has been deleted\./, some.text);
});

test('Finish, Skip or Escape never drop focus to <body>: it lands on the page\'s primary action, the map, or the view (G11)', async () => {
  const finish = INDEX.slice(INDEX.indexOf('async function tourFinish'), INDEX.indexOf('function tourRender'));
  const run = async (opts: { heroUp?: boolean; view?: string; mapUp?: boolean; inCard?: boolean }) => {
    const els: Record<string, TEl> = {};
    const $ = (id: string) => (els[id] ??= tel(0));
    $('tourOverlay').contains = () => opts.inCard !== false;
    $('emptyBrowseBtn').rects = opts.heroUp ? 1 : 0;
    $('treemapCanvas').rects = opts.mapUp ? 1 : 0;
    const control = tel(); const tab = tel();
    const fn = new Function('$', 'tour', 'state', 'api', 'toast', 'document', 'activeViewControl', `'use strict'; ${finish} return tourFinish;`)(
      $, { active: true }, { view: opts.view ?? 'treemap' }, async () => ({}), () => {},
      { activeElement: {}, querySelector: (sel: string) => (sel === '.tabbar button[aria-selected="true"]' ? tab : null) }, () => control) as (m: string) => Promise<void>;
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
  const away = await run({ view: 'treemap', mapUp: true, inCard: false });
  assert.deepEqual([away.map, away.hero, away.control, away.tab], [0, 0, 0, 0], 'focus that was not in the card is left where it is');
  // "Scan my home folder" repaints the card as the scanning step, which has no
  // row of actions: focus on the button that is gone lands on the control left.
  const scanning = tourCard('scanning');
  assert.equal(scanning.found['data-tour-skip']?.focused, 1, 'the scanning card\'s one control, Skip, takes focus');
});
