import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Design pass G02 — before any scan, every view says what it is.
 *
 * Nine of the fifteen views need a scan. Before one, each of them put up the
 * Dashboard's welcome ("See what's eating your disk") with no title of its
 * own, so clicking Grid, Apps or Security looked like nothing had happened.
 * The views that do not need a scan had their own blanks: Trends drew a
 * 230 px empty chart over a tiny "No data yet.", History's calendar said
 * "Click a day…" over "Run a scan first." with nothing to press, and
 * Offloaded and Time Capsule offered a search box with nothing to search.
 *
 * `switchView`, `loadTrends`, `loadCalendar`, `renderOffloadIndex` and
 * `renderCapsule` are EXECUTED out of the built page against a stub DOM.
 */

const INDEX = readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

function slice(a: string, b: string): string {
  const i = INDEX.indexOf(a);
  assert.notEqual(i, -1, `anchor "${a}" exists`);
  const j = INDEX.indexOf(b, i + a.length);
  assert.notEqual(j, -1, `anchor "${b}" follows`);
  return INDEX.slice(i, j);
}

/** A top-level `const NAME = { … };` of the page, whole. */
function constBlock(name: string): string {
  const start = INDEX.indexOf(`const ${name} = {`);
  assert.notEqual(start, -1, `const ${name} exists`);
  let depth = 0;
  for (let i = INDEX.indexOf('{', start); i < INDEX.length; i++) {
    if (INDEX[i] === '{') depth++;
    else if (INDEX[i] === '}' && --depth === 0) return INDEX.slice(start, INDEX.indexOf(';', i) + 1);
  }
  return assert.fail(`const ${name} never closes`);
}

type El = {
  id: string; hidden: boolean; innerHTML: string; textContent: string; disabled: boolean; title: string;
  style: Record<string, string>; dataset: Record<string, string>; attrs: Record<string, string>; cls: Set<string>;
  listeners: Record<string, Array<() => void>>; parentElement: El | null;
  classList: { add: (c: string) => void; remove: (c: string) => void; toggle: (c: string, on?: boolean) => boolean };
  setAttribute: (k: string, v: string) => void; getAttribute: (k: string) => string | null;
  addEventListener: (n: string, fn: () => void) => void; querySelector: (sel: string) => El | null; querySelectorAll: () => El[];
};

function el(id = ''): El {
  const kids: Record<string, El> = {};
  const e: El = {
    id, hidden: false, innerHTML: '', textContent: '', disabled: false, title: '',
    style: {}, dataset: {}, attrs: {}, cls: new Set(), listeners: {}, parentElement: null,
    classList: {
      add: (c) => { e.cls.add(c); }, remove: (c) => { e.cls.delete(c); },
      toggle: (c, on) => { const n = on === undefined ? !e.cls.has(c) : on; if (n) e.cls.add(c); else e.cls.delete(c); return n; },
    },
    setAttribute: (k, v) => { e.attrs[k] = v; }, getAttribute: (k) => e.attrs[k] ?? null,
    addEventListener: (n, fn) => { (e.listeners[n] ??= []).push(fn); },
    // A control the code just wrote into innerHTML, found by its attribute.
    querySelector: (sel) => (e.innerHTML.includes(sel.replace(/[[\]]/g, '')) ? (kids[sel] ??= el(sel)) : null),
    querySelectorAll: () => [],
  };
  return e;
}

function makeDom() {
  const els: Record<string, El> = {};
  const $ = (id: string) => {
    if (!els[id]) { els[id] = el(id); els[id].parentElement = el(id + '-parent'); }
    return els[id];
  };
  return { $, els };
}

/** The sidebar's own name for every view, in order: `data-view` → its label. */
const SIDEBAR = [...INDEX.matchAll(/<button role="tab" aria-selected="(?:true|false)" data-view="(\w+)"[^>]*>(?:<span data-icon="\w+"><\/span>)<span class="side-label">([^<]+)<\/span><\/button>/g)]
  .map((m) => ({ id: m[1], label: m[2] }));

/** Every registered view's id, label, icon and needsScan, read from the page's own registrations. */
const REGISTERED = new Map([...INDEX.matchAll(/id: '(\w+)',\s*label: '([^']+)',\s*icon: '(\w+)',(?:\s*\/\/[^\n]*)*\s*needsScan: (true|false)/g)]
  .map((m) => [m[1], { id: m[1], label: m[2], icon: m[3], needsScan: m[4] === 'true' }]));

/** switchView out of the built page, with nothing scanned. */
function pageBeforeAnyScan() {
  const { $ } = makeDom();
  const state: Record<string, unknown> = { root: null, scanning: false, scanId: null, capabilities: null, view: null };
  // A view that needs a scan must not mount with nothing scanned; the others
  // mount for real, and what they mount is not under test here.
  const mountFor = (v: { id: string; needsScan: boolean }): (() => void) => (v.needsScan
    ? () => { throw new Error(`${v.id} mounted with nothing scanned`); }
    : () => {});
  const viewById = new Map([...REGISTERED.values()].map((v) => [v.id, { ...v, mount: mountFor(v) }]));
  const tabs = SIDEBAR.map((s) => { const b = el(); b.dataset.view = s.id; return b; });
  // viewBlockedReason, then what stands between it and switchView (the empty
  // state's copy and its renderer), then switchView itself.
  const src = slice('function viewBlockedReason(', '/**\n * The first enabled control on screen');
  const switchView = new Function('$', 'state', 'VIEW_BY_ID', 'tabs', 'document', 'icon', 'hideTooltip', 'hideCtxMenu', 'selectionBarFollowView',
    'fxEmptyCtaSync', 'fxScanHeroSync', 'renderCapabilityNotice', 'fxViewEnter', 'toast',
    `'use strict'; let mountedView = null; ${src} return switchView;`)(
    $, state, viewById, tabs, { querySelectorAll: () => [] }, (name: string, size: number) => `<svg data-i="${name}" data-s="${size}"></svg>`,
    () => {}, () => {}, () => {}, () => {}, () => {}, () => {}, () => {}, () => {},
  ) as (id: string) => void;
  return { switchView, $ };
}

test('control: the sidebar and the registrations this test reads are the page\'s own', () => {
  assert.equal(SIDEBAR.length, 15, `the sidebar lists fifteen views (${SIDEBAR.map((s) => s.id).join(', ')})`);
  for (const s of SIDEBAR) {
    const v = REGISTERED.get(s.id);
    assert.ok(v, `${s.id} is registered`);
    assert.equal(v!.label, s.label, `${s.id}: the registry's label is the sidebar's`);
  }
  assert.equal([...REGISTERED.values()].filter((v) => v.needsScan).length, 9, 'nine views need a scan');
});

test('before any scan, every view that needs one opens on its own empty state: its sidebar name, what it will show, and the one action (G02)', () => {
  const { switchView, $ } = pageBeforeAnyScan();
  const leads = new Set<string>();
  for (const s of SIDEBAR) {
    const v = REGISTERED.get(s.id)!;
    switchView(s.id);
    if (!v.needsScan) {
      assert.equal($('emptyState').style.display, 'none', `${s.label} needs no scan: it shows itself, not the empty state`);
      continue;
    }
    assert.equal($('emptyState').style.display, 'flex', `${s.label}: the empty state is up`);
    if (s.id === 'dashboard') {
      assert.equal($('emptyHero').hidden, false, 'the Dashboard\'s empty state is the welcome');
      assert.equal($('emptyForView').hidden, true, 'and nothing else');
      continue;
    }
    assert.equal($('emptyHero').hidden, true, `${s.label}: the Dashboard's welcome is not put up for it`);
    assert.equal($('emptyForView').hidden, false, `${s.label}: its own empty state is`);
    assert.equal($('emptyViewTitle').textContent, s.label, `${s.label}: titled with the sidebar's name for it`);
    assert.match($('emptyViewIcon').innerHTML, new RegExp(`data-i="${v.icon}"`), `${s.label}: with the sidebar's icon for it`);
    const lead = $('emptyViewLead').textContent;
    assert.match(lead, /^Once a folder is scanned, [^.]+\.$/, `${s.label}: one sentence of what it will show once a folder is scanned: "${lead}"`);
    assert.doesNotMatch(lead, /this view fills in/, `${s.label}: its own sentence, not the fallback`);
    assert.ok(!leads.has(lead), `${s.label}: a sentence of its own`);
    leads.add(lead);
  }
  assert.equal(leads.size, 8, 'eight views have a sentence of their own, the Dashboard the welcome');
});

test('the Dashboard\'s welcome names it, and every empty state has the same single action (G02)', () => {
  const section = slice('<section id="emptyState">', '</section>');
  const hero = slice('<div class="empty-hero" id="emptyHero">', '<div class="empty-for-view"');
  assert.match(hero, /<p class="empty-kicker">Dashboard<\/p>/, 'the welcome says it is the Dashboard');
  assert.match(hero, /<h1>See what's eating your disk<\/h1>/, 'and keeps its headline');
  const buttons = [...section.matchAll(/<button\b[^>]*>/g)].map((m) => m[0]);
  assert.equal(buttons.length, 1, `one action for every view: ${buttons.join(' ')}`);
  assert.match(buttons[0], /class="btn btn-primary" id="emptyBrowseBtn"/);
  assert.match(section, /<\/span>Choose a folder to get started\s*<\/button>/, 'the same words on it for every view');
  const forView = slice('<div class="empty-for-view" id="emptyForView" hidden>', '<button');
  for (const id of ['emptyViewIcon', 'emptyViewTitle', 'emptyViewLead']) assert.match(forView, new RegExp(`id="${id}"`), `${id} is in the per-view part`);
  // The two parts lay out as the section's own children, so its flex gap spaces them.
  const css = slice('/* ── Design pass G02: every view\'s empty state', '/* ── end G02 ── */');
  assert.match(css, /#emptyState \.empty-hero,\s*#emptyState \.empty-for-view \{ display: contents; \}/);
});

/* ══════════════ Trends — an explanation and an action, not an empty chart ══════════════ */

async function trendsWith(roots: Array<{ rootPath: string; count: number }>) {
  const { $ } = makeDom();
  const state: Record<string, unknown> = { root: null, trends: { roots: [], snapshots: [], path: null } };
  const browsed: unknown[] = [];
  const drawn: string[] = [];
  const src = slice('async function loadTrends(', '/* The tmLoadSeq pattern');
  const load = new Function('$', 'state', 'api', 'escapeHtml', 'toast', 'drawTrendChart', 'drawTrendNet', 'loadTrendData', 'openBrowse',
    `'use strict'; ${src} return loadTrends;`)(
    $, state, async () => ({ roots }), (s: string) => s, (m: string) => assert.fail(`toast: ${m}`),
    () => drawn.push('chart'), () => drawn.push('net'), async () => { drawn.push('data'); }, (start: unknown) => browsed.push(start),
  ) as () => Promise<void>;
  await load();
  return { $, browsed, drawn };
}

test('Trends with no history says what it will show and offers the action, instead of an empty 230 px chart (G02)', async () => {
  const none = await trendsWith([]);
  assert.equal(none.$('trendEmpty').hidden, false, 'the explanation is up');
  assert.equal(none.$('trendGrid').hidden, true, 'the empty chart and its neighbour are not');
  assert.equal(none.$('trendToolbar').hidden, true, 'nor a folder list with nothing in it');
  const markup = slice('<div class="card glass trend-empty" id="trendEmpty" hidden>', '<div class="trends-toolbar" id="trendToolbar">');
  assert.match(markup, /<h2><span data-icon="trendUp"><\/span>No history yet<\/h2>/);
  assert.match(markup, /<p class="muted">Trends draws how a folder’s size changes from one scan to the next\. Scan a folder to start its history\.<\/p>/);
  assert.match(markup, /<button class="btn btn-primary" id="trendEmptyBrowse"><span data-icon="folder"><\/span>Choose a folder<\/button>/);
  const wiring = slice("$('trendEmptyBrowse').addEventListener('click',", '\n');
  assert.match(wiring, /openBrowse\(null\)/, 'the action is the empty state\'s own: the folder browser');

  const some = await trendsWith([{ rootPath: '/c', count: 2 }]);
  assert.equal(some.$('trendEmpty').hidden, true, 'with history, no explanation');
  assert.equal(some.$('trendGrid').hidden, false, 'the charts');
  assert.equal(some.$('trendToolbar').hidden, false, 'and the folder list');
  assert.deepEqual(some.drawn, ['data'], 'and the history is drawn');
});

/* ══════════════ History — the calendar's empty state has an action ══════════════ */

async function calendarWith(scanId: string | null) {
  const { $ } = makeDom();
  const browsed: unknown[] = [];
  const src = slice('async function loadCalendar(', 'function renderCalendar(');
  const load = new Function('$', 'state', 'api', 'escapeHtml', 'icon', 'skeletonRows', 'renderCalendar', 'openBrowse', 'calChannel', 'calSeq', 'calData',
    `'use strict'; ${src} return loadCalendar;`)(
    $, { scanId, view: 'history' }, async () => ({ modified: [], degraded: [] }), (s: string) => s, () => '', () => '<skeleton>', () => {},
    (start: unknown) => browsed.push(start), 'modified', 0, null,
  ) as () => Promise<void>;
  await load();
  return { $, browsed };
}

test('History\'s calendar before a scan says what it shows and offers the action — no "Click a day…" over nothing (G02)', async () => {
  const none = await calendarWith(null);
  assert.equal(none.$('calControls').hidden, true, '"Click a day…" and the channel switch go while there are no days');
  const body = none.$('calBody').innerHTML;
  assert.doesNotMatch(body, /Run a scan first/);
  assert.match(body, /Once a folder is scanned, the calendar shows its files by the day they last changed or were created, one square per day\./, body);
  assert.match(body, /<button class="btn btn-primary" data-cal-browse>/, 'with the action');
  const btn = none.$('calBody').querySelector('[data-cal-browse]')!;
  assert.ok(btn.listeners.click?.length, 'the action is wired');
  btn.listeners.click.forEach((fn) => fn());
  assert.deepEqual(none.browsed, [null], 'which opens the folder browser');

  const scanned = await calendarWith('s1');
  assert.equal(scanned.$('calControls').hidden, false, 'a scan brings the controls back');
  assert.match(slice('<div id="histPanelCalendar"', '<div id="histPanelJournal"'), /<div class="rule-row" id="calControls"/, 'the row the code hides is the controls\' own');
});

/* ══════════════ Offloaded and Time Capsule — no search box over nothing ══════════════ */

test('Offloaded and Time Capsule show their search box only once there is something to search (G02)', () => {
  const css = slice('/* ── Design pass G02: every view\'s empty state', '/* ── end G02 ── */');
  assert.match(css, /#view-offloaded:has\(#offloadInfo:empty\) #offloadSearchRow,\s*#view-capsule:has\(#capsuleInfo:empty\) #capsuleSearchRow \{ display: none; \}/,
    'the search row goes while the summary line above it is empty');
  assert.match(slice('<section class="view" id="view-offloaded"', '</section>'), /<div class="rule-row" id="offloadSearchRow"[^>]*>\s*<div class="field"[^>]*>\s*<span data-icon="search"><\/span>\s*<input type="text" id="offloadSearch"/);
  assert.match(slice('<section class="view" id="view-capsule"', '</section>'), /<div class="rule-row" id="capsuleSearchRow"[^>]*>\s*<div class="field"[^>]*>\s*<span data-icon="search"><\/span>\s*<input type="text" id="capsuleSearch"/);
  assert.match(slice('<section class="view" id="view-offloaded"', '</section>'), /<div class="apps-info muted" id="offloadInfo"><\/div>/, 'the summary line ships empty, so the box starts hidden');
  assert.match(slice('<section class="view" id="view-capsule"', '</section>'), /<div class="apps-info muted" id="capsuleInfo"><\/div>/);
});

/** The rule above holds only while each list writes its summary line exactly when it lists something. */
test('each list writes its summary line exactly when it holds something to search (G02)', () => {
  const roll = { rollHtml: (e: El, html: string) => { e.innerHTML = html; e.textContent = html.replace(/<[^>]+>/g, ''); }, rollText: (e: El, t: string) => { e.textContent = t; } };
  const offload = (index: unknown) => {
    const { $ } = makeDom();
    $('offloadInfo').textContent = 'stale';
    const src = slice('function renderOffloadIndex(', "$('offloadSearch').addEventListener('input'");
    new Function('$', 'state', 'FxNum', 'formatCount', 'formatBytes', 'formatDate', 'escapeHtml', 'chipFor', 'icon', 'api', 'toast', 'runRestoreJob', 'OFFLOAD_ROWS_PER_DESTINATION',
      `'use strict'; ${src} renderOffloadIndex();`)(
      $, { offload: { index, q: '' } }, roll, String, (n: number) => `${n} B`, String, (s: string) => s, () => '', () => '', async () => ({}), () => {}, () => {}, 200);
    return $('offloadInfo').textContent;
  };
  assert.equal(offload({ entries: [], destinations: [] }), '', 'nothing offloaded: no summary, so no search box');
  assert.equal(offload(null), '', 'no index: the same');
  assert.notEqual(offload({ entries: [{ id: 'a', name: 'a.mov', originalPath: '/c/a.mov', destRoot: '/V', size: 5, offloadedAt: 1 }],
    destinations: [{ root: '/V', mounted: true, activeCount: 1, totalBytes: 5 }] }), '', 'something offloaded: a summary, and the box');

  const capsule = (index: unknown) => {
    const { $ } = makeDom();
    $('capsuleInfo').textContent = 'stale';
    const src = slice('function renderCapsule(', '/* Protection withheld or withdrawn');
    new Function('$', 'state', 'FxNum', 'FxCharts', 'formatCount', 'formatBytes', 'formatDate', 'escapeHtml', 'chipFor', 'icon',
      'capsuleGaugeHide', 'capsuleGaugeHandle', 'renderCapsuleEvents', 'restoreFromCapsule', 'forgetCapsuleEntry',
      `'use strict'; ${src} renderCapsule();`)(
      $, { capsule: { index, q: '' } }, roll, { gauge: () => ({ update() {} }) }, String, (n: number) => `${n} B`, String, (s: string) => s, () => '', () => '',
      () => {}, null, () => {}, () => {}, () => {});
    return $('capsuleInfo').textContent;
  };
  const status = { available: true, usedBytes: 0, capBytes: 100, retentionDays: 30 };
  assert.equal(capsule({ status, entries: [], events: [] }), '', 'an empty Time Capsule: no summary, so no search box');
  assert.equal(capsule({ status: { available: false, reason: 'No room.' }, entries: [], events: [] }), '', 'an unavailable one: the same');
  assert.notEqual(capsule({ status: { ...status, usedBytes: 5 }, entries: [{ id: 'a', name: 'a', originalPath: '/c/a', sizeBytes: 5, capturedAt: 1, hasPayload: true, kind: 'file' }], events: [] }),
    '', 'something protected: a summary, and the box');
});
