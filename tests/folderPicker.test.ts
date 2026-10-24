import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { INDEX, lift } from './fixtures/liftFrontend';
import { isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-folderPicker-data-');
import { sanitizePath } from '../src/utils/pathSanitizer';

/**
 * The "Choose a folder" picker (QA D05, 5 Oct 2026 — batch QA-4a).
 *
 * In a home folder the hidden dot-folders (.agents, .antigravity, .cache…)
 * came first and pushed Documents and Downloads below the fold, and there was
 * no way to type a path: before the first scan the Scan card's path box is
 * not on screen, so the picker was the only door and it took clicks only.
 * Ordinary folders now come first, dot-folders after them, and the picker's
 * own path line is a field: type a path, press Enter, and it opens — and
 * "Scan this folder" opens a typed path first, acting only if it opened.
 *
 * The browse section of the built page is evaluated with a fake DOM and a
 * recording api(), so what runs is the code that ships.
 */

type Dir = { name: string; path: string; isHidden: boolean };
const dir = (name: string): Dir => ({ name, path: `/home/u/${name}`, isHidden: name.startsWith('.') });

/* ══════════════ The browse section, evaluated ══════════════ */

/** A brace-matched block of the page from an opening anchor (walks past the parameter list first). */
function braced(openAnchor: string): string {
  const start = INDEX.indexOf(openAnchor);
  assert.notEqual(start, -1, `"${openAnchor}" is in the page`);
  let p = INDEX.indexOf('(', start), paren = 0;
  for (; p < INDEX.length; p++) {
    if (INDEX[p] === '(') paren++;
    else if (INDEX[p] === ')' && --paren === 0) break;
  }
  let depth = 0;
  for (let i = INDEX.indexOf('{', p); i < INDEX.length; i++) {
    if (INDEX[i] === '{') depth++;
    else if (INDEX[i] === '}' && --depth === 0) return INDEX.slice(start, i + 1);
  }
  return assert.fail(`"${openAnchor}" never closes`);
}

/** Every callback already queued has run (a turn of the event loop, not a clock). */
const settle = () => new Promise<void>((resolve) => { setImmediate(resolve); });

/** A listing that answers only when the test says so — a sleeping NAS or external drive. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => { open = resolve; });
  return { opened, open };
}

type FakeEl = {
  id: string; value: string; textContent: string; innerHTML: string; disabled: boolean; checked: boolean; hidden: boolean;
  title: string; scrollLeft: number; scrollTop: number; readonly scrollWidth: number;
  classList: { add(c: string): void; remove(c: string): void; toggle(c: string, on?: boolean): void; contains(c: string): boolean };
  /** The classes the page set — read to tell whether a sheet is open. */
  cls: Set<string>;
  attrs: Record<string, string>;
  setAttribute(k: string, v: string): void; removeAttribute(k: string): void; getAttribute(k: string): string | null;
  listeners: Record<string, (e?: unknown) => unknown>;
  addEventListener(type: string, fn: (e?: unknown) => unknown): void;
  querySelectorAll(sel: string): FakeEl[];
  querySelector(sel: string): { focus(): void } | null;
  contains(other: unknown): boolean;
  focus(): void;
};

function fakeEl(id: string): FakeEl {
  const el: FakeEl = {
    id, value: '', textContent: '', innerHTML: '', disabled: false, checked: false, hidden: false,
    title: '', scrollLeft: 0, scrollTop: 0,
    // A laid-out text field's content is as wide as its text (7 px a character here).
    get scrollWidth() { return el.value.length * 7; },
    classList: {
      add(c) { el.cls.add(c); },
      remove(c) { el.cls.delete(c); },
      toggle(c, on) { if (on ?? !el.cls.has(c)) el.cls.add(c); else el.cls.delete(c); },
      contains(c) { return el.cls.has(c); },
    },
    cls: new Set<string>(),
    attrs: {},
    setAttribute(k, v) { el.attrs[k] = String(v); },
    removeAttribute(k) { delete el.attrs[k]; },
    getAttribute(k) { return k in el.attrs ? el.attrs[k] : null; },
    listeners: {},
    addEventListener(type, fn) { el.listeners[type] = fn; },
    querySelectorAll: () => [],
    querySelector: () => null,
    contains: () => false,
    focus() {},
  };
  return el;
}

/** A toast with one button (the page's toastAction): what it said, its button, and a click on it. */
type Offer = { msg: string; label: string; kind: string; focus: boolean; sheet: string | null; choose: () => Promise<unknown> };
function offerRecorder(offers: Offer[]) {
  return (msg: string, label: string, fn: () => unknown, kind = 'success', _ms?: number, opts?: { focus?: boolean; sheet?: string | null }) => {
    offers.push({ msg, label, kind, focus: !!opts?.focus, sheet: opts?.sheet ?? null, choose: () => Promise.resolve(fn()) });
  };
}

/** A browser's localStorage over a Map; `broken`, every call throws, as a private window's or a blocked site's may. */
function fakeStorage(init: Record<string, string> = {}, broken = false) {
  const map = new Map(Object.entries(init));
  const refuse = (): never => { throw new Error('SecurityError: The operation is insecure.'); };
  return {
    map,
    getItem: (k: string) => (broken ? refuse() : map.get(k) ?? null),
    setItem: (k: string, v: string) => { if (broken) refuse(); map.set(k, String(v)); },
    removeItem: (k: string) => { if (broken) refuse(); map.delete(k); },
  };
}

/** A whole-drive button as a browser holds it: its path, and the span its name is in (null where the page drew none). */
type DriveButton = {
  dataset: { p: string }; attrP: string; lead: string; nm: { textContent: string } | null; rest: string;
  querySelector(sel: string): { textContent: string } | null;
  /** Taken out of the row. */
  remove(): void;
  /** New buttons from `html` put in the row just before this one ('beforebegin'). */
  insertAdjacentHTML(where: string, html: string): void;
};
type DriveRow = FakeEl & { writes: number; buttons: DriveButton[]; insertAdjacentHTML(where: string, html: string): void };

/**
 * #browseDrives holding the buttons its HTML makes, as a browser does: each
 * innerHTML write makes new buttons (counted in `writes`; a focused one is
 * gone, and a click under way loses its button), a button's name span can be
 * rewritten in place, a button can be taken out, new ones can be put in
 * before a button or at the row's end — every other button standing — and
 * the row's HTML is read back from its buttons.
 */
function driveRowEl(): DriveRow {
  const row = fakeEl('browseDrives') as DriveRow;
  const decode = (s: string) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  let label = '';
  row.writes = 0;
  row.buttons = [];
  const made = (html: string): DriveButton[] => [...html.matchAll(/<button[^>]*data-p="([^"]*)"[^>]*>([\s\S]*?)<\/button>/g)].map((m) => {
    const named = /^([\s\S]*?)<span class="browse-drive-nm">([^<]*)<\/span>([\s\S]*)$/.exec(m[2]);
    const nm = named ? { textContent: decode(named[2]) } : null;
    const b: DriveButton = {
      dataset: { p: decode(m[1]) }, attrP: m[1], lead: named ? named[1] : m[2], nm, rest: named ? named[3] : '',
      querySelector: (sel: string) => (sel === '.browse-drive-nm' ? nm : null),
      remove() { const i = row.buttons.indexOf(b); if (i !== -1) row.buttons.splice(i, 1); },
      insertAdjacentHTML(where: string, more: string) {
        assert.equal(where, 'beforebegin', 'a button takes new ones before it');
        const i = row.buttons.indexOf(b);
        assert.notEqual(i, -1, 'new buttons go before a button still in the row');
        row.buttons.splice(i, 0, ...made(more));
      },
    };
    return b;
  });
  Object.defineProperty(row, 'innerHTML', {
    get: () => label + row.buttons.map((b) =>
      `<button class="pill browse-drive" data-p="${b.attrP}">${b.lead}${b.nm ? `<span class="browse-drive-nm">${b.nm.textContent}</span>` : ''}${b.rest}</button>`).join(''),
    set: (html: string) => {
      row.writes++;
      label = /^<span class="browse-drives-lbl">[^<]*<\/span>/.exec(html)?.[0] ?? '';
      row.buttons = made(html);
    },
  });
  row.insertAdjacentHTML = (where: string, html: string) => {
    assert.equal(where, 'beforeend', 'the row takes new buttons at its end');
    row.buttons.push(...made(html));
  };
  row.querySelectorAll = ((sel: string) => (sel === '.browse-drive' ? [...row.buttons] : [])) as unknown as FakeEl['querySelectorAll'];
  return row;
}

/** What the page around the picker knows: the platform, the disk layout's answer (topologyAnswer), this browser's storage. */
type PickerWorld = {
  platform?: string; homeDir?: string;
  /** topologyAnswer's answer: GET /api/platform/topology, or an Error it rejects with. */
  topology?: () => unknown | Promise<unknown>;
  capabilities?: unknown;
  storage?: ReturnType<typeof fakeStorage>;
};

function browseRuntime(listing: (p: string) => unknown | Promise<unknown>, doc: { activeElement: unknown } = { activeElement: null }, world: PickerWorld = {}) {
  const els = new Map<string, FakeEl>();
  const driveRow = driveRowEl();
  els.set('browseDrives', driveRow);
  const $ = (id: string) => { if (!els.has(id)) els.set(id, fakeEl(id)); return els.get(id)!; };
  const asked: string[] = [];
  const scanned: string[] = [];
  const toasts: string[] = [];
  const offers: Offer[] = [];
  const api = async (url: string) => {
    asked.push(url);
    const p = decodeURIComponent(url.slice(url.indexOf('path=') + 5));
    const answer = await listing(p);
    if (answer instanceof Error) throw answer;
    return answer;
  };
  const start = INDEX.indexOf('/* ───────────────────────────── Browse modal ───────────────────────────── */');
  assert.notEqual(start, -1, 'the browse section is in the page');
  const end = INDEX.indexOf('\n});', INDEX.indexOf("$('browseUseBtn').addEventListener('click'", start)) + '\n});'.length;
  const escapeHtml = lift<(s: string) => string>(['escapeHtml'], 'escapeHtml');
  // The page's own closeModal: Escape, the ✕, the scrim and a Use that acted
  // all close the picker through it (its other arms are for other sheets).
  const closeModal = braced('function closeModal(');
  const storage = world.storage ?? fakeStorage();
  /** How many times the picker asked for the disk layout. */
  const layoutAsked = { n: 0 };
  const topologyAnswer = async () => {
    layoutAsked.n++;
    const answer = await (world.topology ?? (() => new Error('no disk layout in this test')))();
    if (answer instanceof Error) throw answer;
    return answer;
  };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const rt = new Function(
    '$', 'api', 'toast', 'toastAction', 'escapeHtml', 'startScan', 'formatCount', 'document', 'topologyAnswer', 'localStorage', '__world',
    `'use strict';
     const state = { system: { homeDir: __world.homeDir ?? '/home/u', commonDirs: [], platform: __world.platform }, capabilities: __world.capabilities ?? null };
     function icon() { return ''; }
     ${INDEX.slice(start, end)}
     ${closeModal}
     return { openBrowse, browseTo, path: () => browsePath, close: () => closeModal('browseModal'), drawDrives: browseDrawDrives };`,
  )($, api, (m: string) => { toasts.push(m); }, offerRecorder(offers), escapeHtml, (p: string) => { scanned.push(p); }, (n: number) => n.toLocaleString('en-US'), doc,
    topologyAnswer, storage, world) as {
    openBrowse: (start: string | null, onPick?: ((p: string) => void) | null, title?: string | null, useLabel?: string | null, where?: unknown) => Promise<void>;
    browseTo: (p: string) => Promise<boolean>;
    path: () => string | null;
    /** The picker dismissed — Escape, the ✕ or the scrim. */
    close: () => void;
    /** The page's browseDrawDrives: the whole-drive row drawn for these drives. */
    drawDrives: (drives: Array<{ path: string; name: string }>) => void;
  };
  /** The folder names the list shows, top to bottom (the ".." row aside). */
  const rows = () => [...$('browseList').innerHTML.matchAll(/aria-label="Open ([^"]+)"/g)].map((m) => m[1]);
  /** A click on "Scan this folder" (or "Use this folder" when a pick is pending). */
  const use = () => $('browseUseBtn').listeners.click() as Promise<void>;
  /** The "Show hidden folders" box ticked or unticked, as a person does it. */
  const showHidden = (on: boolean) => { $('browseShowHidden').checked = on; return $('browseShowHidden').listeners.change(); };
  /** The whole-drive choices on screen, as [label, path]. */
  const drives = () => ($('browseDrives').hidden ? [] : [...$('browseDrives').innerHTML.matchAll(/<button[^>]*data-p="([^"]*)"[^>]*>([\s\S]*?)<\/button>/g)]
    .map((m) => [m[2].replace(/<[^>]*>/g, ''), m[1]]));
  /** A click on the whole-drive choice at `p`, delegated as the page listens for it. */
  const clickDrive = (p: string) => $('browseDrives').listeners.click({ target: { closest: (sel: string) => (sel === '[data-p]' ? { dataset: { p } } : null) } });
  return { rt, $, asked, scanned, toasts, offers, rows, use, storage, layoutAsked, showHidden, drives, clickDrive, driveRow };
}

const HOME = { path: '/home/u', parent: '/home', dirs: ['.agents', '.antigravity', 'Desktop', '.cache', 'Documents', 'Downloads'].map(dir) };

/* ══════════════ Ordering ══════════════ */

/** This browser asked to see hidden folders (G26: they wait to be asked for). */
const SHOWING_HIDDEN = (): PickerWorld => ({ storage: fakeStorage({ 'tm-browse-hidden': 'show' }) });

test('ordinary folders are listed first and dot-folders after them, each keeping the server\'s order (D05)', async () => {
  const { rt, rows } = browseRuntime(() => HOME, undefined, SHOWING_HIDDEN());
  await rt.openBrowse(null);
  assert.deepEqual(rows(), ['Desktop', 'Documents', 'Downloads', '.agents', '.antigravity', '.cache']);
});

test('a listing the server cut says so above its folders, with how many there are; one it did not cut says nothing (POL item 2)', async () => {
  // GET /api/fs/list sends at most 500 subfolders, the first 500 in this
  // order, and `total` for all of them. Nothing said a folder of 1,234 showed
  // 500, and the rest could only be reached by typing their path.
  const BIG = '/home/u/big';
  const listings: Record<string, unknown> = {
    [BIG]: { path: BIG, parent: '/home/u', dirs: ['a', 'b', '.c'].map(dir), total: 1234 },
    '/home/u/all': { path: '/home/u/all', parent: '/home/u', dirs: ['a', 'b'].map(dir), total: 2 },
  };
  const { rt, $, rows } = browseRuntime((p) => listings[p] ?? HOME, undefined, SHOWING_HIDDEN());
  const said = async (p: string) => { await rt.browseTo(p); return $('browseList').innerHTML; };
  const cut = await said(BIG);
  assert.deepEqual({
    note: /Showing the first 3 of 1,234 folders\. Type a path above to open one that is not listed\./.test(cut),
    above: cut.indexOf('Showing') < cut.indexOf('aria-label="Open a"'),
    rows: rows(),
    whole: /Showing/.test(await said('/home/u/all')),
    older: /Showing/.test(await said('/home/u')),
  }, {
    note: true,
    above: true,
    rows: ['a', 'b', '.c'],
    whole: false, // every folder was sent
    older: false, // an answer with no total says nothing
  });
});

test('a new listing opens at its top, with the cut-list note and ".." in view, and focus on the row that opened it goes to the new list’s first row — or the path field when the list has none — rather than falling to the page (POL item 2 review, F2.10)', async () => {
  // The list is its own scroller. Its rows were replaced and its offset kept, so a folder opened from far
  // down the previous list opened scrolled down too — the "Showing the first 500" note and ".." out of
  // view — and the clicked row, gone, left focus on the page, so the next Tab started at the sheet's top.
  const BIG = '/home/u/big';
  const listings: Record<string, unknown> = {
    [BIG]: { path: BIG, parent: '/home/u', dirs: ['a', 'b'].map(dir), total: 1234 },
    '/empty': { path: '/empty', parent: null, dirs: [], total: 0 },
  };
  const body = { a: 'the page' };
  const doc: { activeElement: unknown } = { activeElement: body };
  const { rt, $ } = browseRuntime((p) => listings[p] ?? HOME, doc);
  const list = $('browseList');
  const focused: string[] = [];
  // The list as the DOM keeps it (POL item 2 review, F3.3): replacing its rows destroys them, the focused
  // one with them, and focus falls to the page — so whether focus WAS in the list can only be read before
  // the rows are replaced. A fake whose answer ignored the order passed a page that read it after.
  const rowsInList = new Set<unknown>();
  let html = list.innerHTML;
  Object.defineProperty(list, 'innerHTML', {
    get: () => html,
    set: (next: string) => {
      html = next;
      if (rowsInList.has(doc.activeElement)) doc.activeElement = body;
      rowsInList.clear();
    },
  });
  list.contains = (other) => rowsInList.has(other);
  list.querySelector = (sel) => {
    const first = /class="browse-item" data-p="([^"]*)"/.exec(list.innerHTML);
    return sel === '.browse-item' && first ? { focus: () => { focused.push(first[1]); } } : null;
  };
  $('browseCurrent').focus = () => { focused.push('the path field'); };
  await rt.openBrowse(null);
  const step = async (p: string, focusInList: boolean) => {
    list.scrollTop = 900; // scrolled down the listing on screen
    const aRow = { a: 'a row of the listing on screen' };
    rowsInList.add(aRow);
    doc.activeElement = focusInList ? aRow : body;
    focused.length = 0;
    await rt.browseTo(p);
    return { scrollTop: list.scrollTop, focused: [...focused] };
  };
  assert.deepEqual({
    fromARow: await step(BIG, true),
    fromAChip: await step('/home/u', false),
    intoAnEmptyFolder: await step('/empty', true),
  }, {
    fromARow: { scrollTop: 0, focused: ['/home/u'] }, // "..", the new list's first row
    fromAChip: { scrollTop: 0, focused: [] }, // focus was not in the list: it stays where it was
    intoAnEmptyFolder: { scrollTop: 0, focused: ['the path field'] },
  });
  assert.match($('browseList').innerHTML, /No subfolders\./);
});

test('the ordering is one function, stable, and keeps every folder (D05)', () => {
  const browseOrder = lift<(dirs: Dir[]) => Dir[]>(['browseOrder'], 'browseOrder');
  const dirs = ['.b', 'a', '.a', 'b', 'c'].map(dir);
  assert.deepEqual(browseOrder(dirs).map((d) => d.name), ['a', 'b', 'c', '.b', '.a'], 'hidden last, otherwise as given');
  assert.deepEqual(dirs.map((d) => d.name), ['.b', 'a', '.a', 'b', 'c'], 'the server\'s list is not reordered in place');
  assert.deepEqual(browseOrder([]), []);
});

/* ══════════════ G26: hidden folders wait to be asked for; the whole drive is a choice ══════════════ */

/*
 * The first-run picker listed 50+ dot-folders under the home folder (after the
 * ordinary ones, D05, but every one of them) and offered no way to scan the
 * whole drive, though the hero promises "Reads a whole drive in minutes". Dot-
 * folders now wait for a "Show hidden folders" box this browser remembers, and
 * a typed or pasted path opens hidden or not; the picker that scans offers the
 * whole drive at its top, named as the disk layout names it — never a guess.
 */

test('hidden dot-folders are not listed until asked for, and the box beside the button says how many there are (G26)', async () => {
  const t = browseRuntime(() => HOME);
  await t.rt.openBrowse(null);
  assert.equal(t.$('browseShowHidden').checked, false, 'a viewer who never asked sees none: the box starts clear');
  assert.deepEqual(t.rows(), ['Desktop', 'Documents', 'Downloads'], 'only the ordinary folders are listed');
  assert.equal(t.$('browseHiddenCount').textContent, ' (3)', 'the box says how many it holds back');
  await t.showHidden(true);
  assert.deepEqual(t.rows(), ['Desktop', 'Documents', 'Downloads', '.agents', '.antigravity', '.cache'], 'ticked, they follow the ordinary ones (D05)');
  assert.equal(t.storage.map.get('tm-browse-hidden'), 'show', 'and the choice is kept in this browser');
  await t.showHidden(false);
  assert.deepEqual(t.rows(), ['Desktop', 'Documents', 'Downloads'], 'cleared, they go again');
  assert.equal(t.storage.map.has('tm-browse-hidden'), false, 'and the kept choice with them');
});

test('the choice is remembered for this viewer, and a browser that will not store it still lets the box work for the visit (G26)', async () => {
  const kept = browseRuntime(() => HOME, undefined, SHOWING_HIDDEN());
  await kept.rt.openBrowse(null);
  assert.equal(kept.$('browseShowHidden').checked, true, 'a viewer who asked before finds the box ticked');
  assert.deepEqual(kept.rows().slice(-3), ['.agents', '.antigravity', '.cache'], 'and the hidden folders listed');
  const refused = fakeStorage({}, true);
  const t = browseRuntime(() => HOME, undefined, { storage: refused });
  await t.rt.openBrowse(null);
  assert.deepEqual(t.rows(), ['Desktop', 'Documents', 'Downloads'], 'storage that throws reads as the default: hidden');
  await t.showHidden(true);
  assert.deepEqual(t.rows().slice(-3), ['.agents', '.antigravity', '.cache'], 'and ticking the box still lists them');
  await t.rt.browseTo('/home/u');
  assert.deepEqual(t.rows().slice(-3), ['.agents', '.antigravity', '.cache'], 'for every folder opened after, this visit');
});

test('a hidden folder typed or pasted into the path line still opens, and is the folder scanned (G26)', async () => {
  const CACHE = '/home/u/.cache';
  const t = browseRuntime((p) => (p === CACHE ? { path: CACHE, parent: '/home/u', dirs: ['go', '.npm'].map(dir) } : HOME));
  await t.rt.openBrowse(null);
  t.$('browseCurrent').value = CACHE;
  await t.$('browseCurrent').listeners.keydown({ key: 'Enter', preventDefault() {} });
  assert.equal(t.rt.path(), CACHE, 'Enter opens it');
  assert.deepEqual(t.rows(), ['go'], 'its own ordinary folders are listed');
  await t.use();
  assert.deepEqual(t.scanned, [CACHE], 'and "Scan this folder" scans it');
  await t.rt.openBrowse(null);
  t.$('browseCurrent').value = '  ' + CACHE; // pasted, with paste debris before it
  await t.use();
  assert.deepEqual(t.scanned, [CACHE, CACHE], 'a pasted path is opened and scanned without pressing Enter');
});

test('a folder holding only hidden folders says so, rather than seeming to hold nothing (G26)', async () => {
  const listings: Record<string, unknown> = {
    '/home/u/dots': { path: '/home/u/dots', parent: '/home/u', dirs: ['.a', '.b'].map(dir), total: 2 },
    '/home/u/dot': { path: '/home/u/dot', parent: '/home/u', dirs: ['.a'].map(dir), total: 1 },
    '/empty': { path: '/empty', parent: null, dirs: [], total: 0 },
  };
  const t = browseRuntime((p) => listings[p] ?? HOME);
  await t.rt.browseTo('/home/u/dots');
  const said = t.$('browseList').innerHTML;
  assert.deepEqual(t.rows(), [], 'no ordinary folder to list');
  assert.match(said, /No folders here but 2 hidden ones — tick Show hidden folders to list them\./, 'the list says what is there');
  await t.rt.browseTo('/home/u/dot');
  assert.match(t.$('browseList').innerHTML, /No folders here but 1 hidden one — tick Show hidden folders to list it\./, 'one, said as one');
  await t.showHidden(true);
  assert.deepEqual(t.rows(), ['.a'], 'ticked, it is listed');
  assert.doesNotMatch(t.$('browseList').innerHTML, /No folders here/, 'and the line goes');
  await t.showHidden(false);
  await t.rt.browseTo('/empty');
  assert.match(t.$('browseList').innerHTML, /No subfolders\./, 'a folder with none at all still says so');
  assert.equal(t.$('browseHiddenCount').textContent, '', 'and the box counts nothing');
});

test('a listing the server cut stays true with hidden folders left out: it says it was cut only where what it lists was (POL item 2, G26)', async () => {
  // The server sends ordinary folders first and cuts after (fs/list), so a cut
  // listing that holds any hidden folder holds every ordinary one.
  const listings: Record<string, unknown> = {
    '/home/u/big': { path: '/home/u/big', parent: '/home/u', dirs: ['a', 'b', '.c'].map(dir), total: 1234 },
    '/home/u/wide': { path: '/home/u/wide', parent: '/home/u', dirs: ['a', 'b'].map(dir), total: 1234 },
  };
  const t = browseRuntime((p) => listings[p] ?? HOME);
  const look = async (p: string) => {
    await t.rt.browseTo(p);
    return { rows: t.rows(), note: /Showing the first [^<]*/.exec(t.$('browseList').innerHTML)?.[0] ?? null, count: t.$('browseHiddenCount').textContent };
  };
  assert.deepEqual(await look('/home/u/big'), { rows: ['a', 'b'], note: null, count: ' (1,232)' },
    'every ordinary folder is listed, so nothing says the list was cut; the box counts the 1,232 hidden ones');
  assert.deepEqual(await look('/home/u/wide'), { rows: ['a', 'b'], note: 'Showing the first 2 of 1,234 folders. Type a path above to open one that is not listed.', count: '' },
    'a cut among the ordinary folders is said; how many of the rest are hidden is not known, so the box counts nothing');
  await t.showHidden(true);
  assert.deepEqual(await look('/home/u/big'), { rows: ['a', 'b', '.c'], note: 'Showing the first 3 of 1,234 folders. Type a path above to open one that is not listed.', count: ' (1,232)' },
    'with hidden folders shown, the cut is said as before');
});

test('the picker that scans offers the whole startup disk at its top, by the name the disk layout gives the volume at / — "Macintosh HD" — and opens it to scan (G26)', async () => {
  const ROOT = { path: '/', parent: null, dirs: ['Applications', 'Library', 'System', 'Users'].map((n) => ({ name: n, path: `/${n}`, isHidden: false })) };
  const layout = { logicalVolumes: [{ id: 'disk3s5', name: 'Data', mountPoint: '/System/Volumes/Data' }, { id: 'disk3s1s1', name: 'Macintosh HD', mountPoint: '/' }] };
  const t = browseRuntime((p) => (p === '/' ? ROOT : HOME), undefined, { platform: 'darwin', topology: () => layout });
  await t.rt.openBrowse(null);
  await settle();
  assert.deepEqual(t.drives(), [['Macintosh HD', '/']], 'one choice: the startup disk, under its own name');
  assert.match(t.$('browseDrives').innerHTML, /Whole drive/, 'said as the whole drive');
  t.clickDrive('/');
  await settle();
  assert.equal(t.rt.path(), '/', 'choosing it opens / in the picker');
  assert.equal(t.$('browseCurrent').value, '/', 'the path line shows what will be scanned');
  await t.use();
  assert.deepEqual(t.scanned, ['/'], '"Scan this folder" scans / through the one scan route — its "Stay on this drive" and Full Disk Access messages with it');
});

test('the startup disk is never given a guessed name: with no layout, or none for /, it is "Startup disk"; a renamed one keeps its name (G26)', async () => {
  const names: Record<string, string[][]> = {};
  for (const [what, world] of [
    ['the layout fails', { topology: () => new Error('diskutil: not found') }],
    ['the layout names no volume at /', { topology: () => ({ logicalVolumes: [{ name: 'Data', mountPoint: '/System/Volumes/Data' }] }) }],
    ['the volume at / has no name', { topology: () => ({ logicalVolumes: [{ name: null, mountPoint: '/' }] }) }],
    ['the disk was renamed', { topology: () => ({ logicalVolumes: [{ name: 'Studio SSD', mountPoint: '/' }] }) }],
  ] as const) {
    const t = browseRuntime(() => HOME, undefined, { platform: 'darwin', ...world });
    await t.rt.openBrowse(null);
    await settle();
    names[what] = t.drives();
  }
  assert.deepEqual(names, {
    'the layout fails': [['Startup disk', '/']],
    'the layout names no volume at /': [['Startup disk', '/']],
    'the volume at / has no name': [['Startup disk', '/']],
    'the disk was renamed': [['Studio SSD', '/']],
  });
  // A machine whose disk layout is known to be unavailable is not asked for it.
  const t = browseRuntime(() => HOME, undefined, { platform: 'darwin', capabilities: { volumeTopology: { available: false, reason: 'no diskutil' } }, topology: () => ({ logicalVolumes: [{ name: 'X', mountPoint: '/' }] }) });
  await t.rt.openBrowse(null);
  await settle();
  assert.deepEqual([t.drives(), t.layoutAsked.n], [[['Startup disk', '/']], 0], 'the capability says no: no request, and no name');
});

test('on Windows the whole-drive choices are the drive letters the layout lists, by label and letter; on Linux it is / (G26)', () => {
  const wholeDrives = lift<(platform: string, topo: unknown, homeDir: string) => { path: string; name: string }[]>(['browseWholeDrives'], 'browseWholeDrives');
  const win = { logicalVolumes: [
    { id: 'D:', name: 'D:', mountPoint: 'D:\\' },
    { id: 'C:', name: 'Windows', mountPoint: 'C:\\' },
    { id: 'disk1', name: 'Recovery', mountPoint: null },
  ] };
  assert.deepEqual(wholeDrives('win32', win, 'C:\\Users\\u'), [{ path: 'C:\\', name: 'Windows (C:)' }, { path: 'D:\\', name: 'D:' }],
    'every lettered drive, in letter order; a label beside its letter, never a letter twice');
  assert.deepEqual(wholeDrives('win32', null, 'C:\\Users\\u'), [{ path: 'C:\\', name: 'C:' }], 'with no layout, the home folder\'s own drive, by its letter');
  assert.deepEqual(wholeDrives('win32', null, '\\\\server\\home\\u'), [], 'and none where the home folder is on no lettered drive');
  assert.deepEqual(wholeDrives('linux', win, '/home/u'), [{ path: '/', name: '/' }], 'on Linux, /');
  assert.deepEqual(wholeDrives('freebsd', null, '/home/u'), [], 'and nothing offered where the platform is not one TreeMap knows');
});

/*
 * The helper above names the drives. These open the picker itself on Linux
 * and Windows, so its wiring is pinned too: which platform asks the disk
 * layout and which draws at once, what a layout that cannot be read leaves,
 * and that a choice opens that drive to scan (G26 review F1.2).
 */
test('opened to scan on Linux, the picker offers / as the whole drive, and choosing it opens / to scan (G26 review F1.2)', async () => {
  const ROOT = { path: '/', parent: null, dirs: ['home', 'usr', 'var'].map((n) => ({ name: n, path: `/${n}`, isHidden: false })) };
  const t = browseRuntime((p) => (p === '/' ? ROOT : HOME), undefined, { platform: 'linux', topology: () => ({ logicalVolumes: [{ name: 'root', mountPoint: '/' }] }) });
  await t.rt.openBrowse(null);
  // Linux names / as /: nothing to ask the disk layout (an lsblk run) for,
  // so / is drawn at once and the layout is never asked (G26 review F2.2).
  assert.deepEqual([t.drives(), t.layoutAsked.n], [[['/', '/']], 0], 'drawn at once, with no disk layout asked for');
  await settle();
  assert.deepEqual([t.drives(), t.layoutAsked.n], [[['/', '/']], 0], 'one choice: /, and still no disk layout asked for');
  t.clickDrive('/');
  await settle();
  assert.equal(t.rt.path(), '/', 'choosing it opens / in the picker');
  await t.use();
  assert.deepEqual(t.scanned, ['/'], 'and "Scan this folder" scans it');
});

test('opened to scan on Windows, the picker offers each lettered drive the layout lists — the home folder\'s own drive where the layout cannot be read — and a choice opens that drive to scan (G26 review F1.2)', async () => {
  const drive = (letter: string) => ({ path: `${letter}:\\`, parent: null, dirs: [{ name: 'Users', path: `${letter}:\\Users`, isHidden: false }] });
  const listing = (p: string) => (/^[A-Z]:\\$/.test(p) ? drive(p[0]) : { path: 'C:\\Users\\u', parent: 'C:\\Users', dirs: [] });
  const layout = { logicalVolumes: [
    { id: 'D:', name: 'D:', mountPoint: 'D:\\' },
    { id: 'C:', name: 'Windows', mountPoint: 'C:\\' },
  ] };
  const win = { platform: 'win32', homeDir: 'C:\\Users\\u' };
  const t = browseRuntime(listing, undefined, { ...win, topology: () => layout });
  await t.rt.openBrowse(null);
  await settle();
  assert.deepEqual(t.drives(), [['Windows (C:)', 'C:\\'], ['D:', 'D:\\']], 'every lettered drive, by label and letter');
  assert.equal(t.layoutAsked.n, 1, 'which Windows asks the disk layout for, once (G26 review F2.2)');
  t.clickDrive('D:\\');
  await settle();
  assert.equal(t.rt.path(), 'D:\\', 'choosing one opens that drive in the picker');
  await t.use();
  assert.deepEqual(t.scanned, ['D:\\'], 'and "Scan this folder" scans it');
  // The layout cannot be read: the home folder's own drive, by its letter.
  const bare = browseRuntime(listing, undefined, { ...win, topology: () => new Error('Get-Volume failed') });
  await bare.rt.openBrowse(null);
  await settle();
  assert.deepEqual(bare.drives(), [['C:', 'C:\\']], 'with no layout, the home folder\'s own drive');
  bare.clickDrive('C:\\');
  await settle();
  assert.equal(bare.rt.path(), 'C:\\', 'which opens in the picker');
});

/*
 * On a picker's first open the whole-drive row waited, hidden, for the disk
 * layout (diskutil, or Windows' Get-Volume with its 30 s limit), then appeared
 * above the path field and pushed the field, its chips and the list down
 * under the pointer; and every answer rewrote the row, so a choice focused or
 * being clicked meanwhile was replaced (G26 review F2.4). The row is now drawn
 * at once, under the name that needs no layout, and an answer naming the same
 * drives renames their buttons in place.
 */
test('on its first open the picker draws the whole drive at once, under the name that needs no disk layout, and the layout\'s answer renames that same button in place — the row never appears late, and a choice focused or being clicked keeps its button (G26 review F2.4)', async () => {
  const g = gate();
  const layout = { logicalVolumes: [{ name: 'Macintosh HD', mountPoint: '/' }] };
  const t = browseRuntime(() => HOME, undefined, { platform: 'darwin', topology: async () => { await g.opened; return layout; } });
  await t.rt.openBrowse(null);
  assert.deepEqual([t.drives(), t.layoutAsked.n], [[['Startup disk', '/']], 1], 'drawn at once, before the layout it asked for answers, under the name that needs none');
  const first = t.driveRow.buttons[0];
  assert.equal(t.driveRow.writes, 1, 'control: the row was written once');
  g.open();
  await settle(); await settle();
  assert.deepEqual(t.drives(), [['Macintosh HD', '/']], 'the answer names the startup disk');
  assert.deepEqual([t.driveRow.writes, t.driveRow.buttons[0] === first], [1, true], 'on the same button, renamed in place: the row is not written again');
  // Opened again: the name the layout gave is drawn at once, and an answer
  // that says the same again changes nothing.
  await t.rt.openBrowse(null);
  await settle(); await settle();
  assert.deepEqual([t.drives(), t.driveRow.writes, t.driveRow.buttons[0] === first, t.layoutAsked.n], [[['Macintosh HD', '/']], 1, true, 2],
    'asked again, the same answer leaves the same button standing');
});

/*
 * F2.4 kept a button only where the answer named the same drives as the row
 * held. On a Windows machine with C: and D:, the C: drawn at once was
 * replaced when the layout (Get-Volume, up to 30 s) answered with both: a
 * keyboard user on it fell to <body>, and a click under way was lost (G26
 * review F3.5). The row is reconciled by path: a drive still listed keeps its
 * button, renamed in place; a drive that left loses its button; one that came
 * gets a new one, in its place in the order.
 */
test('on Windows the home folder\'s own drive is drawn at once, and the layout\'s answer keeps that button — renamed in place — as drives come and go beside it, each new one in its place in the order and no button left opening a drive that left (G26 review F2.4, F3.5)', async () => {
  const g = gate();
  const vol = (letter: string, name: string) => ({ id: `${letter}:`, name, mountPoint: `${letter}:\\` });
  let layout = { logicalVolumes: [vol('C', 'Windows'), vol('D', 'D:')] };
  const t = browseRuntime(() => ({ path: 'C:\\Users\\u', parent: 'C:\\Users', dirs: [] }), undefined,
    { platform: 'win32', homeDir: 'C:\\Users\\u', topology: async () => { await g.opened; return layout; } });
  await t.rt.openBrowse(null);
  assert.deepEqual(t.drives(), [['C:', 'C:\\']], 'the home folder\'s drive, at once, by its letter');
  const c = t.driveRow.buttons[0];
  assert.equal(t.driveRow.writes, 1, 'control: the row was written once');
  g.open();
  await settle(); await settle();
  assert.deepEqual(t.drives(), [['Windows (C:)', 'C:\\'], ['D:', 'D:\\']], 'the layout\'s drives, once it answers');
  assert.deepEqual([t.driveRow.writes, t.driveRow.buttons[0] === c], [1, true],
    'C: keeps its button, renamed in place, with D: put in beside it — the row is not written again, so a choice focused or being clicked keeps its button');
  // D: unplugged and E: plugged in: as many drives as before, not the same ones.
  const d = t.driveRow.buttons[1];
  layout = { logicalVolumes: [vol('C', 'Windows'), vol('E', 'Backup')] };
  await t.rt.openBrowse(null);
  await settle(); await settle();
  assert.deepEqual(t.drives(), [['Windows (C:)', 'C:\\'], ['Backup (E:)', 'E:\\']], 'each choice opens the drive it names');
  assert.deepEqual([t.driveRow.writes, t.driveRow.buttons[0] === c, t.driveRow.buttons.includes(d)], [1, true, false],
    'C: keeps its button, and D:\'s is gone — never renamed to open E:');
  // A card reader before C:, and D: back between C: and E:.
  const e = t.driveRow.buttons[1];
  layout = { logicalVolumes: [vol('E', 'Backup'), vol('B', 'Card'), vol('C', 'Windows'), vol('D', 'D:')] };
  await t.rt.openBrowse(null);
  await settle(); await settle();
  assert.deepEqual(t.drives(), [['Card (B:)', 'B:\\'], ['Windows (C:)', 'C:\\'], ['D:', 'D:\\'], ['Backup (E:)', 'E:\\']], 'each new drive in its place in the letter order');
  assert.deepEqual([t.driveRow.writes, t.driveRow.buttons[1] === c, t.driveRow.buttons[3] === e], [1, true, true], 'C: and E: keep their buttons');
  assert.match(t.$('browseDrives').innerHTML, /^<span class="browse-drives-lbl">Whole drive<\/span>/, 'and the row is still said as the whole drive');
});

test('the whole-drive row is written again only where no button can stand — drives in another order than the buttons on screen, or none of them kept — and drawn empty and hidden for no drive (G26 review F3.5)', () => {
  const t = browseRuntime(() => HOME, undefined, { platform: 'win32', homeDir: 'C:\\Users\\u' });
  const drive = (letter: string) => ({ path: `${letter}:\\`, name: `${letter}:` });
  const label = () => /^<span class="browse-drives-lbl">Whole drive<\/span>/.test(t.$('browseDrives').innerHTML);
  t.rt.drawDrives([drive('C'), drive('D')]);
  assert.deepEqual([t.drives(), label()], [[['C:', 'C:\\'], ['D:', 'D:\\']], true], 'control: drawn, under its label');
  t.rt.drawDrives([drive('D'), drive('C')]);
  assert.deepEqual([t.drives(), label()], [[['D:', 'D:\\'], ['C:', 'C:\\']], true], 'drawn in the order given, though both drives were on screen');
  t.rt.drawDrives([drive('E')]);
  assert.deepEqual([t.drives(), label()], [[['E:', 'E:\\']], true], 'none kept: the new drive alone, under the label');
  t.rt.drawDrives([]);
  assert.deepEqual([t.drives(), t.$('browseDrives').hidden, t.$('browseDrives').innerHTML], [[], true, ''], 'no drive: an empty row, hidden');
});

test('the whole drive is offered only where the picker scans — not for an Autopilot folder or an offload destination — and a late layout answer never draws it into those (G26)', async () => {
  let release!: () => void;
  const slow = new Promise<void>((resolve) => { release = resolve; });
  const layout = { logicalVolumes: [{ name: 'Macintosh HD', mountPoint: '/' }] };
  let late = false;
  const t = browseRuntime(() => HOME, undefined, { platform: 'darwin', topology: async () => { if (late) await slow; return layout; } });
  await t.rt.openBrowse(null);
  await settle();
  assert.deepEqual(t.drives(), [['Macintosh HD', '/']], 'control: the picker that scans offers it');
  await t.rt.openBrowse('/home/u', () => {}, 'Folder this policy cleans');
  await settle();
  assert.deepEqual(t.drives(), [], 'a pick for Autopilot offers no whole drive');
  await t.rt.openBrowse(null, () => {}, 'Offload to…', 'Offload to this folder', { chips: [{ path: '/Volumes/Backup', name: 'Backup' }], hint: 'Choose a drive.' });
  await settle();
  assert.deepEqual(t.drives(), [], 'nor an offload');
  // Opened to scan while the layout is slow, then for a pick before it answers.
  late = true;
  await t.rt.openBrowse(null);
  assert.deepEqual(t.drives(), [['Macintosh HD', '/']], 'what the layout said before is drawn at once');
  await t.rt.openBrowse('/home/u', () => {}, 'Folder this policy cleans');
  release();
  await settle(); await settle();
  assert.deepEqual(t.drives(), [], 'the late answer does not draw the whole drive into the pick');
});

/*
 * The whole-drive choice opens a drive's root, and a root's listing holds
 * folders the server will not open: /dev (and /proc, /sys and /run on Linux),
 * and on macOS /.vol, /.nofollow and /.resolve once hidden folders are shown;
 * C:\$Recycle.Bin and C:\System Volume Information on Windows. GET
 * /api/fs/list listed them as it listed any folder, and a row for one opened
 * only an error toast (then `Scanning "/dev" is not allowed`) — on the first
 * thing the first-run chooser offers (G26 review F3.1). The server leaves them
 * out now (K53, review F1.2: tests/fsListOrder.test.ts); the picker leaves out
 * exactly the folders the server refuses by their name: its own blocklists,
 * read below from src/utils/pathSanitizer.ts, so one added there and not to
 * the page goes RED.
 */
/** A listing of `root` holding `names`, each spelled under it as GET /api/fs/list spells it. */
function rootListing(root: string, names: string[]) {
  return { path: root, parent: null, dirs: names.map((n) => ({ name: n, path: root + n, isHidden: n.startsWith('.') })) };
}

test('a drive root\'s listing draws no row for a folder the server will not open — /dev and macOS\'s second names at /, /proc, /sys and /run on Linux, C:\\$Recycle.Bin on Windows — and counts none of them as hidden (G26 review F3.1)', async () => {
  // macOS's / as a readdir of it lists its folders (the review's own, on this Mac).
  const MAC_ROOT = rootListing('/', ['Applications', 'Library', 'System', 'Users', 'Volumes', 'cores', 'dev', 'opt', 'private', 'sbin', 'usr', '.file', '.nofollow', '.resolve', '.vol']);
  const mac = browseRuntime((p) => (p === '/' ? MAC_ROOT : HOME), undefined, { platform: 'darwin' });
  await mac.rt.openBrowse(null);
  await settle();
  mac.clickDrive('/');
  await settle();
  assert.equal(mac.rt.path(), '/', 'control: the whole drive opened');
  assert.deepEqual(mac.rows(), ['Applications', 'Library', 'System', 'Users', 'Volumes', 'cores', 'opt', 'private', 'sbin', 'usr'], 'macOS: no row for /dev');
  assert.equal(mac.$('browseHiddenCount').textContent, ' (1)', 'macOS: one hidden folder counted, .file — never the three the server refuses');
  await mac.showHidden(true);
  assert.deepEqual(mac.rows().filter((n) => n.startsWith('.')), ['.file'], 'macOS: shown, the hidden folders are .file alone — no /.vol, /.nofollow or /.resolve');
  // Linux's /.
  const linux = browseRuntime(() => rootListing('/', ['bin', 'boot', 'dev', 'etc', 'home', 'proc', 'root', 'run', 'srv', 'sys', 'tmp', 'usr', 'var']),
    undefined, { platform: 'linux' });
  await linux.rt.browseTo('/');
  assert.deepEqual(linux.rows(), ['bin', 'boot', 'etc', 'home', 'root', 'srv', 'tmp', 'usr', 'var'], 'Linux: no row for /dev, /proc, /run or /sys');
  // A cut listing counts only what the picker can list: 600 folders, /dev among the 500 sent.
  const many = { ...rootListing('/', ['dev', ...Array.from({ length: 499 }, (_, i) => `d${String(i).padStart(3, '0')}`)]), total: 600 };
  const cut = browseRuntime(() => many, undefined, { platform: 'linux' });
  await cut.rt.browseTo('/');
  assert.equal(cut.rows().length, 499, 'control: every folder sent but /dev is drawn');
  assert.match(cut.$('browseList').innerHTML, /Showing the first 499 of 599 folders\./, 'the cut is said of the folders the picker can list');
  // Windows: C:\ and its Windows folder; D:\ holds a $Recycle.Bin the server opens (its blocklist names C: alone).
  const win = browseRuntime((p) => (p === 'D:\\' ? rootListing('D:\\', ['$Recycle.Bin', 'Data'])
    : p === 'C:\\Windows' ? { path: 'C:\\Windows', parent: 'C:\\', dirs: ['System32', 'SysWOW64', 'Temp', 'WinSxS'].map((n) => ({ name: n, path: `C:\\Windows\\${n}`, isHidden: false })) }
      : rootListing('C:\\', ['$Recycle.Bin', 'PerfLogs', 'Program Files', 'System Volume Information', 'Users', 'Windows'])),
  undefined, { platform: 'win32', homeDir: 'C:\\Users\\u' });
  await win.rt.browseTo('C:\\');
  assert.deepEqual(win.rows(), ['PerfLogs', 'Program Files', 'Users', 'Windows'], 'Windows: no row for C:\\$Recycle.Bin or C:\\System Volume Information');
  await win.rt.browseTo('C:\\Windows');
  assert.deepEqual(win.rows(), ['Temp'], 'nor for System32, SysWOW64 or WinSxS in C:\\Windows');
  await win.rt.browseTo('D:\\');
  assert.deepEqual(win.rows(), ['$Recycle.Bin', 'Data'], 'D:\\$Recycle.Bin, which the server opens, is drawn');
  // Deeper on macOS: the two the blocklist names below /.
  const deep = browseRuntime((p) => ({ path: p, parent: '/', dirs: (p === '/private/var' ? ['db', 'folders', 'tmp'] : ['Data', 'Preboot', 'VM']).map((n) => ({ name: n, path: `${p}/${n}`, isHidden: false })) }),
    undefined, { platform: 'darwin' });
  await deep.rt.browseTo('/private/var');
  assert.deepEqual(deep.rows(), ['folders', 'tmp'], 'no row for /private/var/db');
  await deep.rt.browseTo('/System/Volumes');
  assert.deepEqual(deep.rows(), ['Data', 'Preboot'], 'nor for /System/Volumes/VM');
});

test('the folders the picker leaves out are the server\'s own refusals by name: every entry of pathSanitizer\'s blocklists, on the platform it is for, and macOS\'s second names (G26 review F3.1)', async () => {
  const src = readFileSync(path.join(__dirname, '..', 'src', 'utils', 'pathSanitizer.ts'), 'utf8');
  const listOf = (name: string) => {
    const m = new RegExp(`const ${name} = \\[([\\s\\S]*?)\\];`).exec(src);
    assert.ok(m, `${name} is in pathSanitizer.ts`);
    return [...m![1].matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((x) => x[1].replace(/\\\\/g, '\\'));
  };
  const unix = listOf('UNIX_BLOCKLIST');
  const windows = listOf('WINDOWS_BLOCKLIST');
  const second = /const DARWIN_ALIAS_ROOT = \/\^\\\/\\\.\(\?:([a-z|]+)\)/i.exec(src)?.[1].split('|') ?? [];
  assert.ok(unix.includes('/dev') && windows.includes('c:\\$recycle.bin') && second.includes('vol'), `control: the lists were read — ${JSON.stringify({ unix, windows, second })}`);
  const cases: Array<[string, string]> = [
    ...unix.flatMap((p): Array<[string, string]> => [['darwin', p], ['linux', p]]),
    // Windows folds case: as the source spells it, and as a listing does.
    ...windows.flatMap((p): Array<[string, string]> => [['win32', p], ['win32', p.toUpperCase()]]),
    ...second.flatMap((n): Array<[string, string]> => [['darwin', `/.${n}`], ['darwin', `/.${n.toUpperCase()}`]]),
  ];
  const drawn: string[] = [];
  for (const [platform, p] of cases) {
    const sep = platform === 'win32' ? '\\' : '/';
    const cut = p.lastIndexOf(sep);
    const parent = cut === 0 ? sep : /:$/.test(p.slice(0, cut)) ? p.slice(0, cut) + sep : p.slice(0, cut);
    const name = p.slice(cut + 1);
    const under = (n: string) => (parent.endsWith(sep) ? parent + n : parent + sep + n);
    const t = browseRuntime(() => ({ path: parent, parent: null, dirs: [name, 'ordinary'].map((n) => ({ name: n, path: under(n), isHidden: n.startsWith('.') })) }),
      undefined, { platform, homeDir: platform === 'win32' ? 'C:\\Users\\u' : '/home/u', ...SHOWING_HIDDEN() });
    await t.rt.browseTo(parent);
    assert.ok(t.rows().includes('ordinary'), `control: ${platform} ${parent} was listed`);
    if (t.rows().includes(name)) drawn.push(`${platform} ${p}`);
  }
  assert.deepEqual(drawn, [], 'no folder the server refuses by its name is drawn as a row');
});

/*
 * The BQL-a review, F3.3: /run/media lists (udisks2 mounts drives there, so it is let out of the "/run"
 * blocklist entry) while /run stays refused, and GET /api/fs/list answers /run/media with parent "/run" — so
 * its ".." row opened only an error toast, the case G26 review F3.1 removed for the rows below.
 */
test('the picker draws no "Up one level" row to a folder the server refuses — /run/media lists, /run does not — while ".." to a folder it opens is drawn (BQL-a review F3.3)', async () => {
  const listing = (p: string) => (p === '/run/media'
    ? { path: '/run/media', parent: '/run', dirs: [{ name: 'me', path: '/run/media/me', isHidden: false }] }
    : { path: p, parent: '/run/media', dirs: [{ name: 'USB', path: `${p}/USB`, isHidden: false }] });
  const t = browseRuntime(listing, undefined, { platform: 'linux' });
  const ups = () => [...t.$('browseList').innerHTML.matchAll(/data-p="([^"]*)" aria-label="Up one level"/g)].map((m) => m[1]);
  assert.equal(await t.rt.browseTo('/run/media'), true, 'control: /run/media opens');
  assert.deepEqual(t.rows(), ['me'], 'control: its drives are listed');
  assert.deepEqual(ups(), [], 'no ".." row to /run, which the server refuses');
  assert.equal(await t.rt.browseTo('/run/media/me'), true, 'control: a drive under it opens');
  assert.deepEqual(ups(), ['/run/media'], 'from a drive, ".." opens /run/media');
  assert.deepEqual(t.toasts, [], 'and nothing was refused');
});

test('the whole-drive choice sits at the top of the sheet, and the sheet still opens on its path field; the hidden-folders box is a labelled checkbox (G26)', () => {
  const sheet = INDEX.slice(INDEX.indexOf('<div class="modal-backdrop" id="browseModal"'), INDEX.indexOf('<!-- ═══════════ Confirm modal'));
  const at = (needle: string) => sheet.indexOf(needle);
  assert.ok(at('id="browseDrives"') !== -1 && at('id="browseCurrent"') !== -1, 'control: both are in the sheet');
  assert.ok(at('id="browseDrives"') < at('id="browseCurrent"'), 'the whole drive comes first');
  assert.match(sheet, /<div [^>]*id="browseDrives"[^>]*\bhidden\b/, 'and is hidden until the picker offers it');
  // The modal net lands on a sheet's first input (modalFocusTarget): the path field, before the box.
  const firstInput = /<(?:input|select|textarea)\b[^>]*\bid="([^"]+)"/.exec(sheet)?.[1];
  assert.equal(firstInput, 'browseCurrent', 'the first field is still the path line');
  assert.match(sheet, /<label[^>]*>\s*<input type="checkbox" id="browseShowHidden">\s*Show hidden folders/, 'the box says what it does');
});

/* ══════════════ Typing a path ══════════════ */

test('the picker\'s path line is a field: it shows where you are, and Enter opens what was typed (D05)', async () => {
  const { rt, $, asked, rows } = browseRuntime((p) => (p === '/data/projects'
    ? { path: '/data/projects', parent: '/data', dirs: ['treemap', 'site'].map(dir) }
    : HOME));
  await rt.openBrowse(null);
  assert.equal($('browseCurrent').value, '/home/u', 'the field holds the folder being shown');
  $('browseCurrent').value = '  /data/projects';
  const keydown = $('browseCurrent').listeners.keydown;
  assert.ok(keydown, 'the path field listens for keys');
  let prevented = false;
  await keydown({ key: 'Enter', preventDefault() { prevented = true; } });
  assert.equal(prevented, true, 'Enter is the field\'s own, not the sheet\'s');
  assert.equal(asked[asked.length - 1], '/api/fs/list?path=' + encodeURIComponent('/data/projects'), 'the typed path is listed, leading whitespace dropped');
  assert.deepEqual(rows(), ['treemap', 'site']);
  assert.equal(rt.path(), '/data/projects');
  const before = asked.length;
  await keydown({ key: 'a', preventDefault() { assert.fail('only Enter is taken'); } });
  assert.equal(asked.length, before, 'other keys just type');
});

test('typing an operating-system folder in the path line and pressing Enter says why in words true of browsing — never "Scanning … is not allowed" — and the picker stays where it was (BQL item 5)', async () => {
  // GET /api/fs/list refuses /dev with the sanitizer's own sentence, and the picker toasts the server's
  // message; it read `Scanning "/dev" is not allowed` while nobody had asked to scan — the picker may be
  // choosing an offload destination or an Autopilot folder.
  const blocked = process.platform === 'win32' ? 'C:\\Windows\\System32' : '/dev';
  let refusal: Error & { code?: string } = new Error('the sanitizer did not refuse');
  try { sanitizePath(blocked); } catch (err) { refusal = err as Error & { code?: string }; }
  assert.equal(refusal.code, 'PATH_BLOCKED', 'control: the server refuses it');
  const { rt, $, toasts } = browseRuntime((p) => (p === blocked ? Object.assign(new Error(refusal.message), { code: refusal.code }) : HOME));
  await rt.openBrowse(null);
  $('browseCurrent').value = blocked;
  await $('browseCurrent').listeners.keydown({ key: 'Enter', preventDefault() {} });
  assert.equal(toasts.at(-1), refusal.message, 'the server\'s sentence is what the toast says');
  assert.doesNotMatch(toasts.at(-1) ?? '', /Scanning/, 'and it speaks of no scan');
  assert.equal(rt.path(), '/home/u', 'the picker stays where it was');
});

/** /nope does not open; /data opens; anything else is the home folder. */
const typedListing = (p: string) => {
  if (p === '/nope') return new Error('No such folder: /nope');
  if (p === '/data') return { path: '/data', parent: '/', dirs: [] };
  return HOME;
};

test('"Scan this folder" opens a typed path first, and scans it only if it opened (D05)', async () => {
  const { rt, $, scanned, toasts, use } = browseRuntime(typedListing);
  await rt.openBrowse(null);
  $('browseCurrent').value = '/nope';
  await use();
  assert.deepEqual(scanned, [], 'a path that does not open is never scanned — nor is the folder shown before it');
  assert.ok(toasts.some((t) => /No such folder/.test(t)), 'and the reason is shown');
  assert.equal($('browseUseBtn').disabled, false, 'and the button is live again, to correct the path and press it (review F2.6)');
  $('browseCurrent').value = '/data';
  await use();
  assert.deepEqual(scanned, ['/data'], 'a typed path that opens is the one scanned');
  await rt.openBrowse(null);
  await use();
  assert.deepEqual(scanned, ['/data', '/home/u'], 'with nothing typed, the folder shown is scanned, as before');
});

test('choosing a folder for Offload or Autopilot obeys the same rule: a typed path is picked only if it opened (F1.6)', async () => {
  // The offload destination and the Autopilot folder are picked through this
  // sheet; the offload job starts on the pick with no second confirmation, so
  // "the folder shown before" in place of a typed one would move files there.
  const { rt, $, scanned, toasts, use } = browseRuntime(typedListing);
  const picked: string[] = [];
  const onPick = (p: string) => { picked.push(p); };
  await rt.openBrowse('/home/u', onPick);
  $('browseCurrent').value = '/nope';
  await use();
  assert.deepEqual(picked, [], 'a typed path that does not open is not picked — nor the folder shown before it');
  assert.ok(toasts.some((t) => /No such folder/.test(t)), 'and the reason is shown');
  assert.equal($('browseUseBtn').disabled, false, '"Use this folder" is live again too (review F2.6)');
  $('browseCurrent').value = '/data';
  await use();
  assert.deepEqual(picked, ['/data'], 'a typed path that opens is the one picked');
  await rt.openBrowse('/home/u', onPick);
  await use();
  assert.deepEqual(picked, ['/data', '/home/u'], 'with nothing typed, the folder shown is picked');
  assert.deepEqual(scanned, [], 'a pick never starts a scan');
});

test('the picker\'s one button says what it does where it was opened — "Scan this folder" only when it scans, "Use this folder" for a pick, "Offload to this folder" for an offload (final review F1.7)', async () => {
  // The label was static markup: opened for "Offload to…" the only button
  // read "Scan this folder" and started an offload that trashes the
  // originals; opened for the Autopilot folder it read the same and only
  // filled the box. The sentence was false in both.
  const { rt, $ } = browseRuntime(typedListing);
  const label = () => $('browseUseBtn').innerHTML.replace(/<[^>]*>/g, '');
  assert.match(INDEX, /<button class="btn btn-primary" id="browseUseBtn"><span data-icon="check"><\/span>Scan this folder<\/button>/,
    'control: the markup draws the button as "Scan this folder"');
  $('browseUseBtn').innerHTML = 'Scan this folder'; // as the markup draws it
  await rt.openBrowse(null);
  assert.equal(label(), 'Scan this folder', 'opened to scan, it says it scans');
  await rt.openBrowse('/home/u', () => {}, 'Folder this policy cleans');
  assert.equal(label(), 'Use this folder', 'opened for a pick, it says it uses the folder — nothing is scanned');
  await rt.openBrowse(null);
  assert.equal(label(), 'Scan this folder', 'opened to scan again, it says so again');
  await rt.openBrowse(null, () => {}, 'Offload to…', 'Offload to this folder');
  assert.equal(label(), 'Offload to this folder', 'a caller may name its own action');

  // The real "Offload…" entry: its pick copies, verifies and trashes the originals. Its drive list is
  // offloadDrives', lifted with it (review F3.3): left out, the call threw, the flow's own catch read
  // that as "can't list the drives", and the api stand-in was never asked.
  const opened: unknown[][] = [];
  const asked: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const flow = new Function('state', 'toast', 'hideCtxMenu', 'openBrowse', 'api', 'tmIsInside', 'offloadPicked',
    `'use strict'; ${braced('async function offloadDrives(')}\n${braced('async function startOffloadFlow(')} return startOffloadFlow;`,
  )({ scanId: 's1', root: { path: '/home/u' } }, () => {}, () => {}, (...a: unknown[]) => { opened.push(a); },
    async (url: string) => { asked.push(url); return { volumes: [] }; }, () => false, () => {}) as (paths: string[]) => Promise<void>;
  await flow(['/home/u/a.mov']);
  assert.deepEqual(asked, ['/api/volumes', '/api/volumes?from=%2Fhome%2Fu'], 'control: the flow ran — its drives were asked for, then judged from the scanned folder');
  assert.match((opened[0]?.[4] as { hint?: string } | undefined)?.hint ?? '', /No other drive is connected/, 'control: and the picker says what that list said, not that the drives could not be listed');
  assert.equal(opened.length, 1, 'control: Offload… opens the picker');
  assert.equal(opened[0][3], 'Offload to this folder', 'and its button names the offload, not a scan');

  // The Autopilot editor's Browse… asks for a pick; the Scan card's for a scan.
  const boxes = boxesRuntime(strictListing);
  const boxLabel = () => boxes.$('browseUseBtn').innerHTML.replace(/<[^>]*>/g, '');
  await boxes.click('apBrowseBtn');
  assert.equal(boxLabel(), 'Use this folder', 'from the policy editor it reads "Use this folder"');
  await boxes.click('browseBtn');
  assert.equal(boxLabel(), 'Scan this folder', 'from the Scan card, "Scan this folder"');
});

test('an offload\'s picker shows the drives its caller names and the line saying why, and the next picker is the plain one again (fourth browser pass, E01)', async () => {
  const { rt, $ } = browseRuntime(typedListing);
  const open = rt.openBrowse as unknown as (start: string | null, onPick?: unknown, title?: string, label?: string, where?: unknown) => Promise<void>;
  const plain = 'Type a path and press Enter, or open a folder below.';
  assert.match(INDEX, new RegExp(`<div class="muted" id="browseHint"[^>]*>${plain}</div>`), 'control: the markup draws the plain line, by an id the picker can set');
  await open('/home/u', () => {}, 'Offload to…', 'Offload to this folder',
    { chips: [{ path: '/Volumes/Backup', name: 'Backup' }], hint: 'Pick a folder on another drive: it frees nothing here.' });
  assert.equal($('browseHint').textContent, 'Pick a folder on another drive: it frees nothing here.', 'the caller\'s line');
  assert.match($('browseChips').innerHTML, /data-p="\/Volumes\/Backup">[^<]*Backup<\/button>/, 'the caller\'s shortcuts');
  await open(null);
  assert.equal($('browseHint').textContent, plain, 'opened for a scan, the plain line is back');
  assert.doesNotMatch($('browseChips').innerHTML, /Backup/, 'and the drives are not left behind');
});

test('an offload\'s pick is answered before the picker goes: a folder the dry run refuses leaves the picker open on it, button live, for another choice — a plan that answers closes it as its sheet opens (fifth browser pass F02)', async () => {
  // QA fifth pass F02: "Offload to this folder" on a folder the server refuses closed the picker with
  // the toast — the person had to open Offload… again to choose another folder.
  // A held button can drop focus to the page, as a browser does with a disabled control.
  const body = { a: 'the page' };
  const doc: { activeElement: unknown; body: unknown } = { activeElement: null, body };
  const { rt, $, use } = browseRuntime(typedListing, doc);
  const open = rt.openBrowse as unknown as (start: string | null, onPick?: unknown, title?: string, label?: string, where?: unknown) => Promise<void>;
  type Ctl = { leave(): void; current(): boolean };
  let refocused = 0;
  $('browseUseBtn').focus = () => { refocused++; doc.activeElement = $('browseUseBtn'); };
  const presses: Array<{ dest: string; ctl: Ctl; answer: () => void }> = [];
  const pick = (dest: string, ctl: Ctl) => new Promise<void>((resolve) => { presses.push({ dest, ctl, answer: resolve }); });
  const isOpen = () => $('browseModal').cls.has('open');
  await open('/home/u', pick, 'Offload to…', 'Offload to this folder', { hint: 'Pick a folder on another drive.', holdOpen: true });
  assert.ok(isOpen(), 'control: the picker is open');
  doc.activeElement = $('browseUseBtn'); // pressed from the keyboard
  const first = use();
  await settle();
  doc.activeElement = body; // the held button let focus go
  assert.deepEqual(presses.map((x) => x.dest), ['/home/u'], 'the press hands the folder shown to the pick');
  assert.ok(isOpen(), 'and the picker stays open while the pick answers');
  assert.equal($('browseUseBtn').disabled, true, 'its button held, so one press plans once');
  assert.equal(presses[0].ctl.current(), true, 'control: the pick is the picker\'s current one');
  presses[0].answer(); // refused: the pick toasts and does not leave
  await first;
  assert.ok(isOpen(), 'refused, the picker is still open, on the folder it showed');
  assert.equal(rt.path(), '/home/u', 'on that folder');
  assert.equal($('browseUseBtn').disabled, false, 'with its button live again');
  assert.deepEqual([refocused, doc.activeElement === $('browseUseBtn')], [1, true], 'and focus back on it, where the press was made');
  // Focus moved on while the pick answered — to the path field, to type another folder: the refusal
  // leaves it there, rather than pulling it back to the button mid-word (review F3.7 of F02).
  const typing = use();
  await settle();
  doc.activeElement = $('browseCurrent'); // clicked into the path field, typing
  $('browseCurrent').value = '/Volumes/Back';
  presses[1].answer(); // refused
  await typing;
  assert.deepEqual([rt.path(), $('browseUseBtn').disabled], ['/home/u', false], 'control: refused, the picker is still on the folder, its button live');
  assert.deepEqual([refocused, doc.activeElement === $('browseCurrent')], [1, true], 'focus stays in the path field the person moved to, not pulled back to the button');
  presses.splice(1, 1); // that press is answered; the next is the second choice below
  // Focus gone from everything while the pick answered (activeElement null): the button takes it back too.
  $('browseCurrent').value = '/home/u';
  doc.activeElement = $('browseUseBtn');
  const unfocused = use();
  await settle();
  doc.activeElement = null;
  presses[1].answer(); // refused
  await unfocused;
  presses.splice(1, 1);
  assert.deepEqual([refocused, doc.activeElement === $('browseUseBtn')], [2, true], 'with nothing focused at all, focus goes back to the button too');
  // Another choice from the same picker: its pick is still the offload's.
  $('browseCurrent').value = '/data';
  const second = use();
  await settle();
  assert.deepEqual(presses.map((x) => x.dest), ['/home/u', '/data'], 'a second choice is picked by the same offload');
  presses[1].ctl.leave(); // planned: the pick closes the picker as its sheet opens
  assert.ok(!isOpen(), 'a pick that answers closes the picker');
  assert.equal(presses[1].ctl.current(), false, 'and is no longer the picker\'s current pick');
  presses[1].answer();
  await second;
  assert.equal($('browseUseBtn').disabled, false, 'the button is handed back with the closed picker');
  // Escape while a pick answers: that pick is no longer current, and leaving cannot close a newer picker.
  await open('/home/u', pick, 'Offload to…', 'Offload to this folder', { hint: 'x', holdOpen: true });
  const third = use();
  await settle();
  rt.close();
  assert.equal(presses[2].ctl.current(), false, 'a pick whose picker was dismissed is not current');
  await open('/home/u', pick, 'Offload to…', 'Offload to this folder', { hint: 'x', holdOpen: true });
  presses[2].ctl.leave();
  assert.ok(isOpen(), 'and its leave() does not close the picker opened since');
  presses[2].answer();
  await third;
  // Another folder listed while a pick answers — a drive's chip, a row, "..": that pick is retired too,
  // its answer being for a folder the picker no longer shows (review F1.6 of F02). Its plan answering
  // opens no sheet over the folder now shown, and leaves the picker there, its button live.
  const fourth = use();
  await settle();
  assert.equal(presses[3].ctl.current(), true, 'control: a pick is current while its folder is shown');
  assert.equal($('browseUseBtn').disabled, true, 'control: its button held');
  assert.equal(await rt.browseTo('/data'), true, 'control: another folder is listed');
  assert.equal(presses[3].ctl.current(), false, 'a pick whose picker has listed another folder is not current');
  assert.ok(isOpen(), 'the picker stays open');
  assert.deepEqual([rt.path(), $('browseUseBtn').disabled], ['/data', false], 'on the folder now listed, its button live for a choice there');
  presses[3].ctl.leave();
  assert.ok(isOpen(), 'and the old pick\'s leave() does not close the picker on the folder listed since');
  presses[3].answer();
  await fourth;
  assert.deepEqual([rt.path(), $('browseUseBtn').disabled], ['/data', false], 'its answer leaves the picker on /data with its button live');
  rt.close();
  // A pick without holdOpen is unchanged: the picker closes as it picks.
  const plain: string[] = [];
  await open('/home/u', (p: string) => { plain.push(p); }, 'Folder this policy cleans');
  await use();
  assert.deepEqual(plain, ['/home/u'], 'control: a plain pick is made');
  assert.ok(!isOpen(), 'and closes the picker at once, as before');
});

test('a folder named by ?path= keeps the whitespace at its end — the deep link is read as every path box is, never trimmed into its sibling (final review F1.8)', () => {
  // The VS Code extension's one channel: "Scan with TreeMap" on a folder
  // named "Screenshots " put "Screenshots" in the box and scanned it — and
  // granted the scanned-root permission to that sibling.
  const fn = between('function requestedPath()', 'async function restoreLastSession');
  const asPath = lift<(s: string) => string>(['asPath'], 'asPath');
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const read = (search: string) => new Function('location', 'asPath', `'use strict'; ${fn} return requestedPath();`)({ search }, asPath) as string | null;
  assert.equal(read('?path=' + encodeURIComponent('/Users/me/Screenshots ')), '/Users/me/Screenshots ', 'the trailing space is part of the name');
  assert.equal(read('?path=' + encodeURIComponent('  /Users/me/Screenshots')), '/Users/me/Screenshots', 'leading whitespace is paste debris');
  assert.equal(read('?path=' + encodeURIComponent('   ')), null, 'a blank path names nothing');
  assert.equal(read(''), null, 'control: no path asked for');
});

/* ══════════════ A trailing space is part of a folder's name (F1.1) ══════════════ */

const SHOT = '/home/u/Screenshots ';
/** A home folder holding "Screenshots " (trailing space) and a sibling "Screenshots" without it. */
const spacedListing = (p: string) => {
  if (p === SHOT) return { path: SHOT, parent: '/home/u', dirs: [] };
  if (p === '/home/u/Screenshots') return { path: '/home/u/Screenshots', parent: '/home/u', dirs: [] };
  return { ...HOME, dirs: [...HOME.dirs, dir('Screenshots'), dir('Screenshots ')] };
};

test('a folder picked from the list is acted on as the server spelled it — its trailing space is never trimmed off (F1.1)', async () => {
  // macOS and Linux allow a trailing space; the server keeps it (sanitizePath),
  // and trimming it finds the sibling without one — or nothing at all.
  const { rt, $, asked, scanned, use } = browseRuntime(spacedListing);
  await rt.openBrowse(null);
  assert.match($('browseList').innerHTML, /data-p="\/home\/u\/Screenshots "/, 'the row carries the name as listed');
  await rt.browseTo(SHOT); // what clicking that row does
  assert.equal($('browseCurrent').value, SHOT, 'the field shows the folder as the server spelled it');
  const listed = asked.length;
  await use();
  assert.deepEqual(scanned, [SHOT], 'the folder chosen is scanned, not its sibling without the space');
  assert.equal(asked.length, listed, 'and it is not listed again under another spelling');

  const picked: string[] = [];
  await rt.openBrowse(null, (p) => { picked.push(p); });
  await rt.browseTo(SHOT);
  await use();
  assert.deepEqual(picked, [SHOT], 'a pick for Offload or Autopilot takes the same folder');
});

test('a typed path loses only its leading whitespace, as the server\'s own rule does — a trailing space stays (F1.1)', async () => {
  const { rt, $, asked, scanned, use } = browseRuntime(spacedListing);
  await rt.openBrowse(null);
  $('browseCurrent').value = '  /home/u/Screenshots ';
  await $('browseCurrent').listeners.keydown({ key: 'Enter', preventDefault() {} });
  assert.equal(asked[asked.length - 1], '/api/fs/list?path=' + encodeURIComponent(SHOT), 'Enter lists the name with its trailing space');
  assert.equal(rt.path(), SHOT);
  await rt.openBrowse(null);
  $('browseCurrent').value = ' /home/u/Screenshots ';
  await use();
  assert.deepEqual(scanned, [SHOT], '"Scan this folder" on a typed path keeps the trailing space too');
});

/* ══════════════ A typed path that is slow to open (F1.8) ══════════════ */

const NAS = '/Volumes/NAS/backup';
/** The NAS answers when its gate opens; /data at once; anything else is the home folder. */
function slowListing(g: ReturnType<typeof gate>) {
  return (p: string) => {
    if (p === NAS) return g.opened.then(() => ({ path: NAS, parent: '/Volumes/NAS', dirs: [dir('late')] }));
    if (p === '/data') return { path: '/data', parent: '/', dirs: [dir('projects')] };
    return HOME;
  };
}

test('a picker dismissed while a typed path is still opening acts on nothing — no pick, no scan (F1.8)', async () => {
  // Offload to…: type the NAS, press the button, change your mind and press
  // Escape. The offload job starts on the pick, so a pick after the dismissal
  // would move files the person had just walked away from.
  for (const withPick of [true, false]) {
    const g = gate();
    const { rt, $, scanned, use } = browseRuntime(slowListing(g));
    const picked: string[] = [];
    await rt.openBrowse(null, withPick ? (p) => { picked.push(p); } : undefined);
    $('browseCurrent').value = NAS;
    const pending = use();
    rt.close();
    g.open();
    await pending;
    assert.deepEqual(picked, [], `nothing is picked after the dismissal (${withPick ? 'pick' : 'scan'} door)`);
    assert.deepEqual(scanned, [], `nothing is scanned after the dismissal (${withPick ? 'pick' : 'scan'} door)`);
  }
  // A typed path that fails after the dismissal is not reported either.
  const g = gate();
  const { rt, $, toasts, use } = browseRuntime((p) => (p === '/Volumes/gone'
    ? g.opened.then(() => new Error('No such folder: /Volumes/gone'))
    : HOME));
  await rt.openBrowse(null);
  $('browseCurrent').value = '/Volumes/gone';
  const pending = use();
  rt.close();
  g.open();
  await pending;
  assert.deepEqual(toasts, [], 'a failure that lands after the dismissal is not shown');
});

test('a second press while a typed path opens does nothing — the pick happens once and never falls through to a scan (F1.8)', async () => {
  const g = gate();
  const { rt, $, scanned, use } = browseRuntime(slowListing(g));
  const picked: string[] = [];
  await rt.openBrowse(null, (p) => { picked.push(p); });
  $('browseCurrent').value = NAS;
  const first = use();
  assert.equal($('browseUseBtn').disabled, true, 'the button is disabled while the typed path opens');
  const second = use();
  g.open();
  await Promise.all([first, second]);
  assert.deepEqual(picked, [NAS], 'picked once');
  assert.deepEqual(scanned, [], 'the second press did not scan the offload destination');
  assert.equal($('browseUseBtn').disabled, false, 'and the button is enabled again for the next time');
});

test('a slow listing that answers after a newer one never takes over the picker (F1.8)', async () => {
  const g = gate();
  const { rt, $, rows, scanned } = browseRuntime(slowListing(g));
  await rt.openBrowse(null);
  $('browseCurrent').value = NAS;
  const enter = $('browseCurrent').listeners.keydown({ key: 'Enter', preventDefault() {} });
  await rt.browseTo('/data'); // a folder chip, answered first
  g.open();
  await enter;
  assert.equal(rt.path(), '/data', 'the folder asked for last is the one shown');
  assert.equal($('browseCurrent').value, '/data', 'the field is not overwritten by the late answer');
  assert.deepEqual(rows(), ['projects'], 'nor is the list');

  // "Scan this folder" on the slow path, then a chip while it opens: the
  // person moved on, so neither folder is scanned behind their back.
  const g2 = gate();
  const second = browseRuntime(slowListing(g2));
  await second.rt.openBrowse(null);
  second.$('browseCurrent').value = NAS;
  const pending = second.use();
  await second.rt.browseTo('/data');
  assert.equal(second.$('browseUseBtn').disabled, false,
    'the picker shows /data now, and its button is live while the NAS has still not answered (review F2.6)');
  g2.open();
  await pending;
  assert.deepEqual(second.scanned, [], 'a superseded typed path is not scanned, and neither is the folder that replaced it');
  assert.deepEqual(scanned, []);
  assert.equal(second.$('browseUseBtn').disabled, false, 'and the late answer leaves it live');
});

test('a picker dismissed while a typed path hangs comes back with a live button, and the old answer never releases a newer press\'s hold (review F2.3, F2.5)', async () => {
  // Type a sleeping NAS, press "Scan this folder", give up with Escape and
  // open the picker again: the NAS may not answer for minutes, and nothing in
  // the reopened sheet is waiting on it.
  const g = gate();
  const g2 = gate();
  const OTHER = '/Volumes/other';
  const { rt, $, scanned, use } = browseRuntime((p) => {
    if (p === NAS) return g.opened.then(() => ({ path: NAS, parent: '/Volumes/NAS', dirs: [] }));
    if (p === OTHER) return g2.opened.then(() => ({ path: OTHER, parent: '/Volumes', dirs: [] }));
    return HOME;
  });
  await rt.openBrowse(null);
  $('browseCurrent').value = NAS;
  const first = use();
  assert.equal($('browseUseBtn').disabled, true, 'held while the NAS is asked');
  rt.close();
  assert.equal($('browseUseBtn').disabled, false, 'a dismissed picker holds nothing');
  await rt.openBrowse(null); // Browse… again, the NAS still silent
  assert.equal($('browseUseBtn').disabled, false, 'the reopened picker\'s button is live while the old listing hangs');

  // A second slow path, pressed in the reopened picker, holds the button
  // until its own listing answers — the first one settling is not that.
  $('browseCurrent').value = OTHER;
  const second = use();
  assert.equal($('browseUseBtn').disabled, true, 'the new press holds it');
  g.open();
  await first;
  assert.deepEqual(scanned, [], 'the dismissed press acts on nothing when its answer lands');
  assert.equal($('browseUseBtn').disabled, true, 'nor does it release a hold that is not its own');
  g2.open();
  await second;
  assert.deepEqual(scanned, [OTHER], 'the press made in the reopened picker acts once its own listing answers');
});

/* ══════════════ A long path shows its end (F1.9) ══════════════ */

test('a path longer than the field shows its end — the folder that "Scan this folder" acts on — after every listing (F1.9)', async () => {
  // An unfocused text field shows the START of its value; at about seventy
  // characters the folder name at the end was clipped off.
  const LONG = '/Users/someone/Desktop/Claude Code/Treemap/node_modules/.cache/babel-loader';
  const { rt, $ } = browseRuntime((p) => (p === LONG ? { path: LONG, parent: path.dirname(LONG), dirs: [] } : HOME));
  const field = $('browseCurrent');
  await rt.openBrowse(null);
  assert.equal(field.scrollLeft, '/home/u'.length * 7, 'scrolled to the end of the first listing');
  await rt.browseTo(LONG);
  assert.equal(field.scrollLeft, LONG.length * 7, 'and to the end of the next — the current folder is the part on screen');
  assert.equal(field.title, LONG, 'the whole path is the field\'s tooltip');
});

test('the field says it can be typed in (D05)', () => {
  const modal = INDEX.slice(INDEX.indexOf('<div class="modal-backdrop" id="browseModal"'), INDEX.indexOf('<!-- ═══════════ Confirm modal'));
  const field = /<input type="text" id="browseCurrent"[^>]*>/.exec(modal);
  assert.ok(field, 'the current path is a text field');
  assert.match(field![0], /aria-label="[^"]*type a path[^"]*"/i, 'its name says it can be typed in');
  assert.match(modal, /Type a path and press Enter/, 'and the sheet says so in words');
});

/* ══════════════ A stray trailing space that names no folder (F2.9) ══════════════ */

const DOCS = '/home/u/Documents';
const list = (p: string) => '/api/fs/list?path=' + encodeURIComponent(p);
/** The server's answer for a path that is not there (errorHandler: ENOENT). */
const notFound = () => Object.assign(new Error('Path does not exist'), { code: 'PATH_NOT_FOUND', status: 404 });
/** What an offer says (offerMeant): the path as typed, what is at its end in words, and the folder it probably meant. */
const noFolder = (typed: string, blanks: string, meant: string) =>
  `No folder is named “${typed}” — the path ends with ${blanks}. Did you mean “${meant}”?`;
/** Home, Documents, "Screenshots " with its space, "Gone" without one; a folder that refuses to be read; nothing else. */
const strictListing = (p: string) => {
  if (p === '/home/u') return HOME;
  if (p === DOCS) return { path: DOCS, parent: '/home/u', dirs: [] };
  if (p === '/home/u/Gone') return { path: '/home/u/Gone', parent: '/home/u', dirs: [] };
  if (p === SHOT) return { path: SHOT, parent: '/home/u', dirs: [] };
  if (p === '/locked ') return Object.assign(new Error('Permission denied'), { code: 'PERMISSION_DENIED', status: 403 });
  return notFound();
};

test('a typed path whose trailing space names no folder is never opened as the folder without it: the picker says so and offers that folder, which opens only when clicked — Enter, Scan and a pick (QA4a R4-1)', async () => {
  // A double-click selection in a terminal or a chat often carries a space,
  // invisible in the field and in "Path does not exist". But "Screenshots "
  // that has gone is not "Screenshots": the person chooses, nothing swaps.
  const { rt, $, asked, scanned, toasts, offers, use } = browseRuntime(strictListing);
  await rt.openBrowse(null);
  $('browseCurrent').value = DOCS + ' ';
  await $('browseCurrent').listeners.keydown({ key: 'Enter', preventDefault() {} });
  assert.deepEqual(asked.slice(-2), [list(DOCS + ' '), list(DOCS)], 'as typed first, then the folder without the space is looked up');
  assert.equal(rt.path(), '/home/u', 'but not opened: the picker stays where it was');
  assert.equal(offers.length, 1, 'the person is told, with the folder offered');
  assert.equal(offers[0].msg, noFolder(DOCS + ' ', 'a space', DOCS), '"no such folder", for the path as typed — its space said in words');
  assert.equal(offers[0].label, 'Open that folder', 'and the folder it probably meant is the choice');
  assert.equal(offers[0].kind, 'error', 'shown as an error');
  assert.deepEqual(toasts, [], 'one answer, not a plain "Path does not exist" beside it');
  await offers[0].choose();
  assert.equal(rt.path(), DOCS, 'clicking it opens that folder');
  assert.equal($('browseCurrent').value, DOCS, 'spelled as the server listed it');

  await rt.openBrowse(null);
  $('browseCurrent').value = DOCS + ' \t';
  await use();
  assert.deepEqual(scanned, [], '"Scan this folder" scans nothing in its place — nor the folder shown before it');
  assert.equal(offers.length, 2, 'it offers the folder too');
  assert.equal(offers[1].label, 'Open that folder');
  assert.equal($('browseUseBtn').disabled, false, 'and the button is live again');
  await offers.at(-1)!.choose();
  await use();
  assert.deepEqual(scanned, [DOCS], 'the folder offered is scanned once chosen and pressed');

  const picked: string[] = [];
  await rt.openBrowse(null, (p) => { picked.push(p); });
  $('browseCurrent').value = DOCS + ' ';
  await use();
  assert.deepEqual(picked, [], 'a pick for Offload or Autopilot takes nothing in its place');
  assert.equal(offers.length, 3, 'and offers the folder as well');
});

test('a typed path overtaken while it opens is not looked up without its space, and offers nothing (QA4a R4-1)', async () => {
  const g = gate();
  const { rt, $, asked, offers, toasts } = browseRuntime((p) => (p === DOCS + ' ' ? g.opened.then(() => notFound()) : strictListing(p)));
  await rt.openBrowse(null);
  $('browseCurrent').value = DOCS + ' ';
  const enter = $('browseCurrent').listeners.keydown({ key: 'Enter', preventDefault() {} });
  await rt.browseTo(DOCS); // a chip or a row, answered first
  g.open();
  await enter;
  assert.equal(asked.filter((u) => u === list(DOCS)).length, 1, 'only the chip asked for the folder — the overtaken path was not looked up again');
  assert.deepEqual(offers, [], 'nothing is offered for a listing nobody is waiting for');
  assert.deepEqual(toasts, []);
});

test('a folder is looked up without its trailing space only for a typed path, only after "no such folder", and is never opened in its place (review F1.1, F2.9, QA4a R4-1)', async () => {
  const { rt, $, asked, scanned, toasts, offers, use } = browseRuntime(strictListing);
  await rt.openBrowse(null);
  $('browseCurrent').value = SHOT;
  await use();
  assert.deepEqual(scanned, [SHOT], 'a folder whose name ends in a space is found as typed');
  // A row listed as "Gone " whose folder has since gone: its sibling "Gone"
  // is another folder, not the one clicked.
  const before = asked.length;
  assert.equal(await rt.browseTo('/home/u/Gone '), false, 'a listed row whose folder has gone does not open — not even as its sibling');
  assert.equal(asked.length, before + 1, 'which is never looked up');
  await rt.openBrowse(null);
  const n = asked.length;
  $('browseCurrent').value = '/locked ';
  await use();
  assert.equal(asked.length, n + 1, 'a folder that refuses to be read is not tried under another name');
  assert.ok(toasts.includes('Permission denied'), 'and its own reason is shown');
  $('browseCurrent').value = '/home/u/Nope ';
  await use();
  assert.deepEqual(scanned, [SHOT], 'neither spelling exists: nothing is scanned');
  assert.equal(toasts[toasts.length - 1], 'Path does not exist', 'and the person is told');
  assert.deepEqual(offers, [], 'nothing is offered where no folder has either spelling, nor for a row or a locked folder');
});

/* ══════════════ The boxes a folder is picked into (F2.1, F2.4, F2.8) ══════════════ */

/** The page's text from one anchor up to (not including) the next. */
function between(from: string, to: string): string {
  const start = INDEX.indexOf(from);
  assert.notEqual(start, -1, `"${from}" is in the page`);
  const end = INDEX.indexOf(to, start);
  assert.ok(end > start, `"${to}" follows "${from}"`);
  return INDEX.slice(start, end);
}

type BoxEl = FakeEl & { checked?: boolean; hidden?: boolean; querySelector(sel: string): null; click(): void };

/** The page's scan voice in a boxesRuntime: whether the page is heard yet, what the region says or holds back, and every write of it. */
type Voice = { heard: boolean; hear(): void; says(): string; writes: string[] };

/**
 * #scanAnnounce as a browser holds it, as far as the scan's voice reaches (review F1.7): its child nodes — the text
 * node a write leaves, a node appended — and, for each write that adds or removes one, a record for the page's watch.
 * Emptying it while it holds nothing changes nothing, and queues no record (DOM "replace all").
 */
function voiceRegion(el: BoxEl, record: () => void, writes: string[]): void {
  let nodes: unknown[] = [];
  let text = '';
  const changed = (added: unknown[], removed: unknown[]) => { if (added.length || removed.length) record(); };
  Object.defineProperty(el, 'textContent', {
    get: () => text,
    set: (v: unknown) => {
      text = String(v ?? '');
      writes.push(text);
      const removed = nodes;
      nodes = text ? [{ nodeType: 3, data: text }] : [];
      changed(nodes, removed);
    },
  });
  Object.defineProperty(el, 'childNodes', { get: () => nodes });
  Object.defineProperty(el, 'firstChild', { get: () => nodes[0] ?? null });
  Object.assign(el, { appendChild: (node: { data?: string }) => { nodes = [...nodes, node]; text += node.data ?? ''; changed([node], []); return node; } });
}

/**
 * The picker, the Scan card (its Scan button, path box and Fast rescan box)
 * and the Autopilot policy editor, evaluated together from the built page:
 * the picker fills a box, and the box is read again by everything else.
 * `voice`: the page's scan voice too (040) — its watch of #scanAnnounce, told
 * of each write a microtask later as a browser tells it, and the page not
 * heard (a sheet just closed, the net yet to lift inert) until voice.hear().
 */
function boxesRuntime(listing: (p: string) => unknown, saveRefusal: Error | null = null, voice: { heard: boolean } | null = null) {
  const els = new Map<string, BoxEl>();
  const frames: Array<() => void> = [];
  let waiting: (() => void) | null = null;
  const writes: string[] = [];
  /** The page's MutationObserver, as far as the scan's voice reaches: records queued, handed on a microtask later, or taken back. */
  class VoiceObserver {
    private readonly queued: unknown[] = [];
    constructor(private readonly cb: (records: unknown[]) => void) {}
    observe(target: BoxEl): void { voiceRegion(target, () => this.queue(target), writes); }
    private queue(target: BoxEl): void {
      if (!this.queued.length) queueMicrotask(() => { const r = this.queued.splice(0); if (r.length) this.cb(r); });
      this.queued.push({ type: 'childList', target });
    }
    takeRecords(): unknown[] { return this.queued.splice(0); }
  }
  const aloudWait = (_live: unknown, then: () => void) => { if (voice!.heard) return false; waiting = then; return true; };
  const v: Voice | null = voice && {
    get heard() { return voice.heard; },
    set heard(on: boolean) { voice.heard = on; },
    /** The page heard again: what waited for it runs, and two frames pass. */
    hear() { voice.heard = true; const w = waiting; waiting = null; w?.(); for (let i = 0; i < 2; i++) for (const f of frames.splice(0)) f(); },
    says: () => rtVoice.says(),
    writes,
  };
  let rtVoice: { says: () => string } = { says: () => '' };
  /**
   * Where focus is, as a browser keeps it: a control focused holds it until another takes it — or until it
   * is disabled, when the browser's focus fixup hands it to <body> as it next reads where focus is, and
   * enabling the control again does not give it back (eighth browser pass K02).
   */
  const focus: { active: BoxEl | null } = { active: null };
  const $ = (id: string) => {
    if (!els.has(id)) {
      const el = fakeEl(id) as BoxEl;
      el.focus = () => { focus.active = el; };
      // A box may have several listeners for one event (the page adds one per concern).
      el.addEventListener = (type, fn) => {
        const before = el.listeners[type];
        el.listeners[type] = before ? (e) => { void before(e); return fn(e); } : fn;
      };
      el.querySelector = () => null;
      // As HTMLElement.click(): a disabled control ignores it (Enter in the path box calls it).
      el.click = () => { if (!el.disabled) void el.listeners.click?.(); };
      els.set(id, el);
    }
    return els.get(id)!;
  };
  const asked: string[] = [];
  const sent: { url: string; body: { policy?: { path: string }; policies?: { path: string; name?: string }[] } }[] = [];
  const scanned: [string, { incremental?: boolean }][] = [];
  const toasts: string[] = [];
  const offers: Offer[] = [];
  // The page's timers, on a clock the test steps itself (fire): count, don't time.
  const timers: { fn: () => void; delay: number; cleared: boolean }[] = [];
  const setTimeout = (fn: () => void, delay: number) => { timers.push({ fn, delay, cleared: false }); return timers.length; };
  const clearTimeout = (id: number) => { if (timers[id - 1]) timers[id - 1].cleared = true; };
  /** Every timer still pending runs now, as if its delay had passed. */
  const fire = () => { for (const t of timers) if (!t.cleared) { t.cleared = true; t.fn(); } };
  const api = async (url: string, opts?: { body?: string }) => {
    if (url.startsWith('/api/fs/list')) {
      asked.push(url);
      const answer = await listing(decodeURIComponent(url.slice(url.indexOf('path=') + 5)));
      if (answer instanceof Error) throw answer;
      return answer;
    }
    const body = JSON.parse(opts?.body ?? '{}');
    sent.push({ url, body });
    // The server refusing the policy list (`saveRefusal`): the editor stays open, saying why.
    if (url === '/api/autopilot/policies' && saveRefusal) throw saveRefusal;
    if (url !== '/api/autopilot/simulate') return {};
    // The server scans the policy's folder to preview it: a folder that is not
    // there answers as its listing does — 404 PATH_NOT_FOUND (simulatePolicy → startScan).
    const there = await listing(body.policy.path);
    if (there instanceof Error) throw there;
    return { items: [], bytesWouldDelete: 0, capBytes: null, wouldBlockReason: null, skipped: [] };
  };
  const stored = new Map<string, string>();
  const localStorage = { getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => { stored.set(k, v); } };
  const body = fakeEl('body') as BoxEl;
  const document = {
    querySelector: (sel: string) => (sel === '#apMatchSeg button[aria-selected="true"]' ? { dataset: { apmatch: 'custom' } } : null),
    querySelectorAll: () => [],
    body,
    createTextNode: (data: string) => ({ nodeType: 3, data: String(data) }),
    get activeElement(): BoxEl {
      if (focus.active && focus.active.disabled) focus.active = null; // the focus fixup
      return focus.active ?? body;
    },
  };
  const browse = between('/* ───────────────────────────── Browse modal ───────────────────────────── */',
    "$('browseUseBtn').addEventListener('click'") + between("$('browseUseBtn').addEventListener('click'", '\n});\n') + '\n});\n';
  const voiceSrc = voice ? [
    'const scanVoiceSheet = new Map();', 'const scanVoiceHeld = new Map();', 'let scanVoiceWatch = null;',
    braced('function scanVoiceHolding('), braced('function scanVoiceSays('), braced('function scanVoiceChanged('),
    between("if (typeof MutationObserver !== 'undefined') {\n  const voice = ['scanAnnounce', 'stopAnnounce'].map($);", '\n}\n') + '\n}\n',
  ] : [];
  const src = [
    ...voiceSrc,
    browse,
    braced('function closeModal('),
    between('function scannedRoots()', 'async function showFastRescanStat'),
    between("$('scanBtn').addEventListener('click'", "window.addEventListener('beforeunload'"),
    braced('function openPolicyEditor('),
    braced('function setScanButtonMode('),
    between('/** Read the dialog back into the wire shape the API validates. */', 'registerView({'),
  ].join('\n');
  const escapeHtml = lift<(s: string) => string>(['escapeHtml'], 'escapeHtml');
  const noop = () => {};
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const rt = new Function(
    '$', 'api', 'toast', 'toastAction', 'escapeHtml', 'startScan', 'stopScan', 'localStorage', 'document',
    'fxOrbShow', 'fxOrbHide', 'formatBytes', 'formatCount', 'loadAutopilot', 'setApMatchKind', 'renderApGroupList', 'validateApQuery',
    'setTimeout', 'clearTimeout', 'MutationObserver', 'aloudWait', 'topModal', 'requestAnimationFrame',
    `'use strict';
     const state = { scanning: false, system: { homeDir: '/home/u', commonDirs: [] }, autopilot: { policies: [] } };
     const KB = 1e3, MB = 1e6, GB = 1e9, TB = 1e12; // the page's decimal units (000-prelude, QA D09)
     let apDraft = null;
     function icon() { return ''; }
     ${src}
     return { openBrowse, browseTo, path: () => browsePath, rememberScannedRoot, openPolicyEditor,
       close: (id) => closeModal(id), scanning: (on) => { state.scanning = on; },
       ${voice ? "says: () => scanVoiceSays($('scanAnnounce'))" : ''} };`,
  )($, api, (m: string) => { toasts.push(m); }, offerRecorder(offers), escapeHtml,
    (p: string, o: { incremental?: boolean }) => { scanned.push([p, o]); }, noop,
    localStorage, document, noop, noop, String, String, noop, noop, noop, noop, setTimeout, clearTimeout,
    voice ? VoiceObserver : undefined, aloudWait, () => null, (f: () => void) => { frames.push(f); }) as {
    openBrowse: (start: string | null, onPick?: (p: string) => void) => Promise<void>;
    browseTo: (p: string) => Promise<boolean>;
    path: () => string | null;
    rememberScannedRoot: (p: string) => void;
    /** The page's own editor, opened on a saved policy (or a new one, with null). */
    openPolicyEditor: (policy: Record<string, unknown> | null) => void;
    /** A sheet closed — Escape, the ✕ or the scrim all run the page's closeModal. */
    close: (id: string) => void;
    /** A scan starting (or ending) some other way: Recent, the dock, the queue. */
    scanning: (on: boolean) => void;
    /** What #scanAnnounce says, or holds back (the page's scanVoiceSays), with `voice`. */
    says?: () => string;
  };
  if (rt.says) rtVoice = { says: rt.says };
  /** A click on a button whose handler may be async; resolves when it has run. */
  const click = (id: string) => Promise.resolve($(id).listeners.click());
  /** A person typing or pasting into a box: its value, then its input event. */
  const type = (id: string, text: string) => { $(id).value = text; void $(id).listeners.input?.(); };
  const policy = (url: string) => sent.filter((s) => s.url === url).at(-1)!.body;
  /** The folders of every policy list saved, one list per save. */
  const saved = () => sent.filter((s) => s.url === '/api/autopilot/policies').map((s) => s.body.policies!.map((p) => p.path));
  /** How many times the policy list was saved. */
  const saves = () => saved().length;
  return { rt, $, asked, scanned, toasts, offers, click, type, policy, saved, saves, timers, fire, document, voice: v };
}

test('a folder picked into the Scan card keeps its trailing space when Scan and Browse… read the box again, and Fast rescan knows it (review F2.4, F2.8)', async () => {
  const { rt, $, asked, scanned, click } = boxesRuntime(strictListing);
  await click('browseBtn'); // the box is empty: the picker opens at home
  await rt.browseTo(SHOT); // the row "Screenshots "
  await click('browseUseBtn');
  assert.equal($('pathInput').value, SHOT, 'the box holds the folder as listed');
  assert.deepEqual(scanned.map(([p]) => p), [SHOT], 'and it is the folder scanned');
  rt.rememberScannedRoot(SHOT); // what the finished scan records
  $('pathInput').listeners.input();
  assert.equal($('fastRescanWrap').hidden, false, 'Fast rescan is offered for the folder scanned before');
  assert.ok(!$('fastRescan').checked, 'offered, never ticked for the person (QA D45)');
  $('fastRescan').checked = true; // the person ticks it
  await click('scanBtn');
  assert.deepEqual(scanned.map(([p]) => p), [SHOT, SHOT], 'Scan on the card scans that folder again, not its sibling "Screenshots"');
  assert.equal(scanned[1][1].incremental, true, 'as the fast rescan it offered');
  await click('browseBtn');
  assert.equal(asked.at(-1), list(SHOT), 'and Browse… opens the picker at that folder');
  assert.equal(rt.path(), SHOT);
});

test('a folder picked for an Autopilot policy is previewed, saved and browsed as listed — never as its sibling (review F2.1)', async () => {
  const { rt, $, asked, click, policy } = boxesRuntime(strictListing);
  await click('apBrowseBtn');
  await rt.browseTo(SHOT);
  await click('browseUseBtn');
  assert.equal($('apPath').value, SHOT, 'the box holds the folder as listed');
  await click('apPreviewBtn');
  assert.equal(policy('/api/autopilot/simulate').policy!.path, SHOT, 'the preview asks about that folder');
  await click('apSaveBtn');
  assert.deepEqual(policy('/api/autopilot/policies').policies!.map((p) => p.path), [SHOT],
    'and the policy saved cleans it — a sibling "Screenshots" would be trashed on schedule');
  await click('apBrowseBtn');
  assert.equal(asked.at(-1), list(SHOT), 'Browse… opens the picker at it again');
});

test('a stray trailing space typed into the Scan card or the Autopilot folder is never dropped: where no folder has it and one without it exists, nothing is scanned or saved, and that folder is offered (QA4a R4-1)', async () => {
  const { rt, $, asked, scanned, toasts, offers, click, type, policy, saves } = boxesRuntime(strictListing);
  type('pathInput', '   ');
  await click('scanBtn');
  assert.equal(toasts.at(-1), 'Enter a folder path first', 'a box of spaces is an empty box');
  assert.equal(scanned.length, 0, 'and nothing is scanned');
  type('pathInput', '  ' + DOCS + ' ');
  await click('scanBtn');
  assert.deepEqual(asked, [list(DOCS + ' '), list(DOCS)], 'Scan looks the path up as typed, then without the space');
  assert.equal(scanned.length, 0, 'and scans nothing in its place');
  assert.equal(offers.length, 1, 'the person is told, with the folder offered');
  assert.equal(offers[0].msg, noFolder(DOCS + ' ', 'a space', DOCS), '"no such folder", for the path as typed');
  assert.equal(offers[0].label, 'Scan that folder');
  await offers[0].choose();
  assert.equal($('pathInput').value, DOCS, 'clicking it puts that folder in the box');
  assert.deepEqual(scanned.map(([p]) => p), [DOCS], 'and scans it');
  type('pathInput', SHOT);
  await click('scanBtn');
  assert.deepEqual(scanned.map(([p]) => p), [DOCS, SHOT], 'a folder whose name ends in a space is scanned as typed');
  type('pathInput', '/locked ');
  await click('scanBtn');
  assert.deepEqual(scanned.at(-1)![0], '/locked ', 'one that cannot be looked up is scanned as typed, for the scan to report');
  type('pathInput', '/home/u/Nope ');
  await click('scanBtn');
  assert.deepEqual(scanned.at(-1)![0], '/home/u/Nope ', 'where neither spelling is a folder it is scanned as typed, and the scan says so');
  assert.equal(offers.length, 1, 'nothing is offered for either');
  const lookups = asked.length;
  type('pathInput', DOCS);
  await click('scanBtn');
  assert.equal(asked.length, lookups, 'a path with nothing at its end to doubt is not looked up');

  type('pathInput', DOCS + ' ');
  const beforeBrowse = offers.length;
  await click('browseBtn');
  assert.notEqual(rt.path(), DOCS, 'Browse… does not open the folder without the space in its place');
  assert.equal(offers.length, beforeBrowse + 1, 'it offers it');
  assert.equal(offers.at(-1)!.label, 'Open that folder');
  await offers.at(-1)!.choose();
  assert.equal(rt.path(), DOCS, 'and opens it when chosen');

  type('apPath', DOCS + ' ');
  const offered = offers.length;
  await click('apSaveBtn');
  assert.equal(saves(), 0, 'a policy is not saved for the folder without the space');
  assert.equal(offers.length, offered + 1, 'Save answers with an offer of its own');
  assert.equal(offers.at(-1)!.msg, noFolder(DOCS + ' ', 'a space', DOCS), 'the Autopilot editor says "no such folder" too');
  assert.equal(offers.at(-1)!.label, 'Use that folder', 'with the folder offered');
  await offers.at(-1)!.choose();
  await settle();
  assert.equal($('apPath').value, DOCS, 'clicking it puts that folder in the box');
  assert.equal(saves(), 0, 'and saves nothing — saving a standing cleanup is the person\'s own press');
  await click('apSaveBtn');
  assert.deepEqual(policy('/api/autopilot/policies').policies!.map((p) => p.path), [DOCS], 'which saves the folder chosen');
});

test('a stray trailing space after a folder scanned before is never scanned as that folder: the folder is offered, and chosen it is scanned with Fast rescan offered for it, never ticked for the person (QA4a R4-2, QA D45)', async () => {
  const { rt, $, scanned, offers, click, type } = boxesRuntime(strictListing);
  rt.rememberScannedRoot(DOCS);
  type('pathInput', DOCS + ' ');
  assert.equal($('fastRescanWrap').hidden, true, 'Fast rescan is not offered for a path never scanned, exactly as typed');
  await click('scanBtn');
  assert.deepEqual(scanned, [], 'no full scan of the folder without the space');
  await offers.at(-1)!.choose();
  assert.equal($('fastRescanWrap').hidden, false, 'the folder chosen was scanned before: Fast rescan is offered for it');
  assert.ok(!$('fastRescan').checked, 'offered, never ticked for the person — it can be the slow path (QA D45)');
  assert.deepEqual(scanned, [[DOCS, { incremental: false }]], 'so the click scans it as Scan would with the box unticked: in full');
});

test('a path the page put in a box — a pick, Recent, the last scan, a saved policy — is never altered, even where its folder has gone and a person once typed the same text (QA4a R4-1)', async () => {
  // "Gone " was typed, scanned and saved in a policy, and has since been
  // removed; "Gone" beside it is another folder. 79089e3 remembered the typing
  // and, when the page later put the same text in the box, read it as typed
  // and pointed the policy at "Gone" — an unattended cleanup of another folder.
  const GONE = '/home/u/Gone ';
  const { rt, $, asked, scanned, offers, click, type, saved } = boxesRuntime(strictListing);
  type('apPath', GONE); // typed once, when the folder still existed
  rt.openPolicyEditor({ id: 'p1', name: 'Old shots', path: GONE, match: { kind: 'custom' }, enabled: true });
  assert.equal($('apPath').value, GONE, 'the editor shows the policy\'s folder');
  await click('apSaveBtn');
  assert.deepEqual(saved(), [[GONE]], 'saving it again keeps its folder — the sibling would be trashed on schedule');
  assert.deepEqual(asked, [], 'its own folder is not looked up under another name');
  assert.equal(offers.length, 0, 'nor questioned');

  type('pathInput', GONE); // typed once
  $('pathInput').value = GONE; // Recent, or the last scan, puts the same text in the box
  await click('scanBtn');
  assert.deepEqual(scanned, [], 'Scan never scans the sibling in its place');
  assert.equal(offers.at(-1)!.msg, noFolder(GONE, 'a space', '/home/u/Gone'), 'it says the folder is not there, and the sibling is only offered');
  assert.equal($('pathInput').value, GONE, 'the box keeps the path the page put there');
  await click('apBrowseBtn');
  assert.notEqual(rt.path(), '/home/u/Gone', 'Browse… from the policy never opens the sibling in its place');
  assert.equal($('apPath').value, GONE, 'and the policy\'s folder is untouched');
});

/* ══════════════ A path box's lookup: one press, held, bounded (QA4a R4-3) ══════════════ */

/** A folder on a network drive whose name ends in a space; slow to answer. */
const SLOW = '/Volumes/NAS/Shots ';
/** SLOW exists, and answers only when the gate opens; everything else as strictListing. */
const slowShots = (g: ReturnType<typeof gate>) => (p: string) =>
  (p === SLOW ? g.opened.then(() => ({ path: SLOW, parent: '/Volumes/NAS', dirs: [] })) : strictListing(p));
/** DOCS + ' ' is not there, and says so only when the gate opens; DOCS is. */
const slowStray = (g: ReturnType<typeof gate>) => (p: string) =>
  (p === DOCS + ' ' ? g.opened.then(() => notFound()) : strictListing(p));

test('pressing Scan keeps focus on it through the path\'s lookup — the button held disabled hands focus to <body>, and it is given back as the button is handed back — so the scan\'s Stop holds it and Enter reaches Stop (eighth browser pass K02)', async () => {
  const g = gate();
  const { $, scanned, click, type, document } = boxesRuntime(slowShots(g));
  type('pathInput', SLOW);
  $('scanBtn').focus();
  const pending = click('scanBtn');
  assert.equal($('scanBtn').disabled, true, 'control: Scan is held while the path is looked up');
  assert.equal(document.activeElement, document.body, 'control: a browser hands focus from the disabled button to <body>');
  g.open();
  await pending;
  assert.deepEqual(scanned.map(([p]) => p), [SLOW], 'control: the folder is scanned');
  assert.equal(document.activeElement, $('scanBtn'), 'focus is on the Scan button again — the scan\'s Stop — never left on <body>');
  // Focus the person moved elsewhere while the path was looked up is left where they put it.
  const h = gate();
  const moved = boxesRuntime(slowShots(h));
  moved.type('pathInput', SLOW);
  moved.$('scanBtn').focus();
  const press = moved.click('scanBtn');
  moved.$('browseBtn').focus();
  h.open();
  await press;
  assert.equal(moved.document.activeElement, moved.$('browseBtn'), 'focus the person moved meanwhile stays where they moved it');
  // A press that never focused the button — a mouse click in Safari or Firefox on macOS leaves focus where it was,
  // here <body> — is not given focus it did not have: on Stop, a later Space meant to scroll the page would stop the
  // scan (review F3.7).
  const k = gate();
  const unfocused = boxesRuntime(slowShots(k));
  unfocused.type('pathInput', SLOW);
  assert.equal(unfocused.document.activeElement, unfocused.document.body, 'control: nothing is focused before the press');
  const mouse = unfocused.click('scanBtn');
  k.open();
  await mouse;
  assert.deepEqual(unfocused.scanned.map(([p]) => p), [SLOW], 'control: the folder is scanned');
  assert.equal(unfocused.document.activeElement, unfocused.document.body, 'focus the button never held is not pulled onto it (now Stop) once the scan starts');
});

/** A folder typed into the picker that is not there, on a drive that says so only when the gate opens. */
const SLOW_GONE = '/Volumes/NAS/Gone';
const slowGone = (g: ReturnType<typeof gate>) => (p: string) => (p === SLOW_GONE ? g.opened.then(() => notFound()) : strictListing(p));

test('the picker\'s Use keeps focus while a typed path opens — held disabled, the button hands focus to <body>, and it is given back as the button is, unless the person moved it meanwhile, the button never had it or the picker closed (as K02 found of Scan)', async () => {
  // A typed folder that is not there: the picker stays open, saying so, and Use holds focus for the next path.
  {
    const g = gate();
    const { rt, $, toasts, scanned, click, document } = boxesRuntime(slowGone(g));
    await rt.openBrowse(null);
    $('browseCurrent').value = SLOW_GONE;
    $('browseUseBtn').focus(); // Tab to "Scan this folder", then Enter
    const pending = click('browseUseBtn');
    assert.equal($('browseUseBtn').disabled, true, 'control: Use is held while the typed path opens');
    assert.equal(document.activeElement, document.body, 'control: a browser hands focus from the held button to <body>');
    g.open();
    await pending;
    assert.deepEqual([toasts.at(-1), scanned], ['Path does not exist', []], 'control: nothing is scanned, and the person is told why');
    assert.ok($('browseModal').cls.has('open'), 'control: the picker stays open');
    assert.equal($('browseUseBtn').disabled, false, 'control: Use is handed back');
    assert.equal(document.activeElement, $('browseUseBtn'), 'focus is on Use again — a second Enter reaches it — never left on <body>');
  }
  // A typed folder for an offload's held pick: it opens, the pick answers (refused here, so the picker stays open),
  // and Use holds focus through both — the pick's own hand-back gives focus back only to a button that held it as
  // the pick began (F02), which it did not once the typed path's hold had dropped it on <body>.
  {
    const g = gate();
    const { rt, $, click, document } = boxesRuntime(slowShots(g));
    const picked: string[] = [];
    const answers: Array<() => void> = [];
    const pick = (dest: string) => new Promise<void>((resolve) => { picked.push(dest); answers.push(resolve); });
    const open = rt.openBrowse as unknown as (start: string | null, onPick: unknown, title: string, label: string, where: unknown) => Promise<void>;
    await open('/home/u', pick, 'Offload to…', 'Offload to this folder', { hint: 'Pick a folder on another drive.', holdOpen: true });
    $('browseCurrent').value = SLOW;
    $('browseUseBtn').focus();
    const pending = click('browseUseBtn');
    assert.equal(document.activeElement, document.body, 'control: a browser hands focus from the held button to <body>');
    g.open();
    for (let i = 0; i < 50 && !picked.length; i++) await settle();
    assert.deepEqual(picked, [SLOW], 'control: the typed folder opened and is handed to the pick');
    assert.equal($('browseUseBtn').disabled, true, 'control: the pick holds Use while it answers');
    assert.equal(document.activeElement, document.body, 'control: and focus falls from it again');
    answers[0](); // refused: the pick toasts and does not leave
    await pending;
    assert.equal($('browseUseBtn').disabled, false, 'control: Use is handed back');
    assert.equal(document.activeElement, $('browseUseBtn'), 'focus is on Use once the pick answers — never left on <body>');
  }
  // Focus the person moved while the typed path opened — back into the path field, to type another — stays there.
  {
    const g = gate();
    const { rt, $, click, document } = boxesRuntime(slowGone(g));
    await rt.openBrowse(null);
    $('browseCurrent').value = SLOW_GONE;
    $('browseUseBtn').focus();
    const pending = click('browseUseBtn');
    $('browseCurrent').focus();
    g.open();
    await pending;
    assert.equal(document.activeElement, $('browseCurrent'), 'focus moved meanwhile is left where the person put it');
  }
  // A press that never focused the button — a mouse click in Safari or Firefox on macOS — is given no focus (F3.7).
  {
    const g = gate();
    const { rt, $, click, document } = boxesRuntime(slowGone(g));
    await rt.openBrowse(null);
    $('browseCurrent').value = SLOW_GONE;
    assert.equal(document.activeElement, document.body, 'control: nothing is focused before the press');
    const pending = click('browseUseBtn');
    g.open();
    await pending;
    assert.equal(document.activeElement, document.body, 'focus the button never held is not pulled onto it');
  }
  // The picker closed while the typed path opened: its button is not this press's to give focus to.
  {
    const g = gate();
    const { rt, $, click, document } = boxesRuntime(slowGone(g));
    await rt.openBrowse(null);
    $('browseCurrent').value = SLOW_GONE;
    $('browseUseBtn').focus();
    const pending = click('browseUseBtn');
    assert.equal(document.activeElement, document.body, 'control: focus falls from the held button');
    rt.close('browseModal');
    assert.equal($('browseUseBtn').disabled, false, 'control: the closed picker hands its button back');
    g.open();
    await pending;
    assert.notEqual(document.activeElement, $('browseUseBtn'), 'focus is not pulled into the closed picker');
  }
});

test('a keyboard press of Use on a typed path, overtaken by a folder clicked in the list — which in Safari focuses nothing — gives focus back to Use once its own answer comes, the picker still open; a newer press holding the button gets none from it (BQR-1 item 12d, BQF note)', async () => {
  {
    const g = gate();
    const { rt, $, click, document } = boxesRuntime(slowGone(g));
    await rt.openBrowse(null);
    $('browseCurrent').value = SLOW_GONE;
    $('browseUseBtn').focus(); // Tab to "Scan this folder", then Enter
    const pending = click('browseUseBtn');
    assert.equal(document.activeElement, document.body, 'control: focus falls from the held button');
    await rt.browseTo('/home/u'); // a folder clicked in the list with the mouse: a newer listing, and no focus moves
    assert.deepEqual([$('browseUseBtn').disabled, document.activeElement === document.body], [false, true],
      'control: the newer listing handed the button back, and nothing holds focus');
    g.open();
    await pending;
    assert.equal(rt.path(), '/home/u', 'control: the folder clicked is the one shown; the overtaken press acted on nothing');
    assert.equal(document.activeElement, $('browseUseBtn'), 'focus is on Use again — the press held it — never left on <body>');
  }
  // Overtaken by a newer press that holds the button now: that press gives focus back itself, not this one.
  {
    const g = gate();
    const h = gate();
    const { rt, $, click, document } = boxesRuntime((p: string) => (p === SLOW ? h.opened.then(() => ({ path: SLOW, parent: '/Volumes/NAS', dirs: [] })) : slowGone(g)(p)));
    await rt.openBrowse(null);
    $('browseCurrent').value = SLOW_GONE;
    $('browseUseBtn').focus();
    const first = click('browseUseBtn');
    await rt.browseTo('/home/u');
    $('browseCurrent').value = SLOW;
    const second = click('browseUseBtn'); // pressed with the mouse in Safari: focus stays on <body>
    assert.equal($('browseUseBtn').disabled, true, 'control: the newer press holds the button');
    g.open();
    await first;
    assert.equal(document.activeElement, document.body, 'the overtaken press does not put focus on a button a newer press holds');
    h.open();
    await second;
  }
});

test('Scan holds its button while the path is looked up, and a press the person moved on from acts on nothing (QA4a R4-3)', async () => {
  // Box changed while the lookup ran.
  {
    const g = gate();
    const { $, scanned, offers, toasts, click, type } = boxesRuntime(slowStray(g));
    type('pathInput', DOCS + ' ');
    const pending = click('scanBtn');
    assert.equal($('scanBtn').disabled, true, 'Scan is held while the path is looked up');
    // ...and says so, to the eye and to a screen reader (final review F1.11).
    assert.equal($('scanBtn').getAttribute('aria-busy'), 'true', 'the held button is busy');
    assert.match($('scanBtn').innerHTML, /Checking…/, 'its face says what it is doing');
    assert.match($('scanAnnounce').textContent, /Checking that the folder exists/, 'and the scan\'s live region says it');
    type('pathInput', '/data');
    g.open();
    await pending;
    assert.deepEqual(scanned, [], 'a path no longer in the box is not scanned, nor the folder it might have meant');
    assert.deepEqual(offers, [], 'and nothing is offered for it');
    assert.equal($('scanBtn').disabled, false, 'and Scan is live again');
    assert.equal($('scanBtn').getAttribute('aria-busy'), null, 'no longer busy');
    assert.match($('scanBtn').innerHTML, /Scan$/, 'and says Scan again');
    // The press is dropped out loud: in silence, the person's Scan did nothing
    // and nothing said so (final review F1.5).
    assert.match(toasts.at(-1) ?? '', /^Nothing was scanned — the path changed while it was being checked\. Press Scan to scan the path in the box\.$/,
      'the person is told nothing was scanned, and what to do');
  }
  // A scan started some other way (Recent, the dock) while the lookup ran.
  {
    const g = gate();
    const { rt, scanned, toasts, click, type } = boxesRuntime(slowShots(g));
    type('pathInput', SLOW);
    const pending = click('scanBtn');
    rt.scanning(true);
    g.open();
    await pending;
    assert.deepEqual(scanned, [], 'a press overtaken by a scan that started meanwhile starts nothing');
    assert.equal(toasts.at(-1), 'A scan is already running', 'and says why, as startScan would (final review F1.5)');
  }
  // Enter while Scan is held: the button ignores a click() while disabled,
  // so Enter did nothing and said nothing, and the held press then dropped
  // itself because the box had changed (final review F1.11). Enter is a
  // press of its own, and a newer press takes over.
  {
    const g = gate();
    const { $, scanned, offers, toasts, click, type } = boxesRuntime(slowStray(g));
    type('pathInput', DOCS + ' ');
    const held = click('scanBtn');
    assert.equal($('scanBtn').disabled, true, 'control: Scan is held');
    type('pathInput', '/data');
    await $('pathInput').listeners.keydown({ key: 'Enter' });
    await settle();
    assert.deepEqual(scanned.map(([p]) => p), ['/data'], 'Enter scans the path now in the box');
    g.open();
    await held;
    assert.deepEqual(scanned.map(([p]) => p), ['/data'], 'and the press it overtook acts on nothing');
    assert.deepEqual(offers, [], 'offers nothing');
    assert.deepEqual(toasts, [], 'and says nothing — the newer press answered');
    assert.equal($('scanBtn').disabled, false, 'Scan is live');
  }
  // Two presses on one path (Enter, or a press that got through).
  {
    const g = gate();
    const { offers, click, type } = boxesRuntime(slowStray(g));
    type('pathInput', DOCS + ' ');
    const first = click('scanBtn');
    const second = click('scanBtn');
    g.open();
    await Promise.all([first, second]);
    assert.equal(offers.length, 1, 'two presses on one path answer once');
  }
  // The button is handed back only by the press that holds it: an overtaken
  // press whose lookup lands first leaves the newer press's hold alone
  // (final review F1.15).
  {
    const g1 = gate();
    const g2 = gate();
    const { $, scanned, click, type } = boxesRuntime((p) => (p === DOCS + ' ' ? g1.opened.then(() => notFound())
      : p === SLOW ? g2.opened.then(() => ({ path: SLOW, parent: '/Volumes/NAS', dirs: [] })) : strictListing(p)));
    type('pathInput', DOCS + ' ');
    const older = click('scanBtn');
    type('pathInput', SLOW);
    void $('pathInput').listeners.keydown({ key: 'Enter' }); // the newer press, held on its own lookup
    g1.open();
    await older;
    assert.equal($('scanBtn').disabled, true, 'the older press, landing first, does not hand back the button the newer press holds');
    assert.equal($('scanBtn').getAttribute('aria-busy'), 'true', 'nor end its busy state');
    g2.open();
    await settle();
    assert.equal($('scanBtn').disabled, false, 'the newer press hands it back when its own lookup lands');
    assert.deepEqual(scanned.map(([p]) => p), [SLOW], 'and scans its folder');
  }
  // The folder offered, chosen while a scan runs.
  {
    const { rt, $, scanned, toasts, offers, click, type } = boxesRuntime(strictListing);
    type('pathInput', DOCS + ' ');
    await click('scanBtn');
    rt.scanning(true);
    await offers[0].choose();
    assert.deepEqual(scanned, [], 'a choice made while a scan runs starts nothing');
    assert.equal(toasts.at(-1), 'A scan is already running', 'and says why, rather than nothing at all');
    // The box names the folder being scanned after a scan started some other
    // way (a drop, the dock, the queue): a refused choice leaves it be, or the
    // next press of Scan would scan a folder nobody pressed Scan on (final review F1.12).
    assert.equal($('pathInput').value, DOCS + ' ', 'and leaves the box as it was');
  }
});

test('"Checking that the folder exists…" leaves the scan\'s live region when the check ends without a scan — an offer, a path changed, a newer press — and a running scan\'s sentence is never taken with it (final review F2.4)', async () => {
  // Scan wrote the sentence into #scanAnnounce (role=status) and nothing took
  // it back unless a scan started: after an offer, or a press dropped, the
  // region still said a check was under way.
  const CHECKING = /^Checking that the folder exists…$/;
  // The check finds no such folder, and offers the one without the space.
  {
    const { $, offers, click, type } = boxesRuntime(strictListing);
    type('pathInput', DOCS + ' ');
    const pending = click('scanBtn');
    assert.match($('scanAnnounce').textContent, CHECKING, 'control: the check is said while it runs');
    await pending;
    assert.equal(offers.length, 1, 'control: the folder without the space is offered');
    assert.equal($('scanAnnounce').textContent, '', 'the check is no longer said to be running — the offer, in #toasts, says what it found');
  }
  // The box changed while the check ran: the press is dropped, out loud.
  {
    const g = gate();
    const { $, toasts, click, type } = boxesRuntime(slowStray(g));
    type('pathInput', DOCS + ' ');
    const pending = click('scanBtn');
    type('pathInput', '/data');
    g.open();
    await pending;
    assert.match(toasts.at(-1) ?? '', /^Nothing was scanned/, 'control: the press is dropped');
    assert.equal($('scanAnnounce').textContent, '', 'and the check is no longer said to be running');
  }
  // Enter takes over while Scan is held: the newer press holds the button,
  // and ends the check the older press announced as it settles.
  {
    const g = gate();
    const { $, scanned, click, type } = boxesRuntime(slowStray(g));
    type('pathInput', DOCS + ' ');
    const held = click('scanBtn');
    type('pathInput', '/data');
    await $('pathInput').listeners.keydown({ key: 'Enter' });
    await settle();
    assert.deepEqual(scanned.map(([p]) => p), ['/data'], 'control: Enter scanned the path in the box');
    assert.equal($('scanAnnounce').textContent, '', 'the older press\'s check is no longer said to be running');
    g.open();
    await held;
    assert.equal($('scanAnnounce').textContent, '', 'nor said again when its lookup lands');
  }
  // A scan started some other way while the check ran (Recent, the dock):
  // the region says that scan now, and the check ending leaves it alone.
  {
    const g = gate();
    const { rt, $, toasts, click, type } = boxesRuntime(slowShots(g));
    type('pathInput', SLOW);
    const pending = click('scanBtn');
    assert.match($('scanAnnounce').textContent, CHECKING, 'control: the check is said');
    rt.scanning(true);
    $('scanAnnounce').textContent = 'Scanning…'; // what beginScanChrome says
    g.open();
    await pending;
    assert.equal(toasts.at(-1), 'A scan is already running', 'control: the press is dropped');
    assert.equal($('scanAnnounce').textContent, 'Scanning…', 'and the running scan\'s sentence stays');
  }
});

test('"Checking that the folder exists…" held back by the scan\'s voice — Scan pressed in the task a sheet closes in, the page not yet heard — is taken back as the check ends, and never said after it (review F1.7)', async () => {
  const g = gate();
  const { $, offers, click, type, voice } = boxesRuntime((p) => g.opened.then(() => strictListing(p)), null, { heard: false });
  type('pathInput', DOCS + ' ');
  const pending = click('scanBtn');
  await settle(); // the page's watch hears the write in the microtasks after it
  assert.equal(voice!.says(), 'Checking that the folder exists…', 'control: the check\'s words are held back while the page is not heard');
  assert.equal($('scanAnnounce').textContent, '', 'control: the region empty meanwhile');
  g.open();
  await pending;
  await settle();
  assert.equal(offers.length, 1, 'control: the check ends with an offer of the folder without the space');
  assert.equal(voice!.says(), '', 'the check over, the region neither says nor holds back that it is running');
  voice!.writes.length = 0;
  voice!.hear();
  assert.deepEqual(voice!.writes.filter(Boolean), [], 'and once the page is heard, "Checking…" is never said: the check it spoke of is over');
  assert.equal($('scanAnnounce').textContent, '', 'the region is left empty');
});

test('"Checking that the folder exists…" is taken back only by the press that holds Scan: an overtaken press whose own lookup lands first leaves it while the newer press is still checking (final review F3.1)', async () => {
  // Scan, then Enter on the same path that ends in a space: two presses, each
  // looking the path up with a request of its own. Above, the newer press
  // (/data) has no lookup and empties the region itself, so an overtaken
  // press that cleared it too could not be told from one that leaves it.
  // Here the overtaken press's lookup lands first, while the newer press is
  // still checking: clearing then would silence a check still under way.
  const CHECKING = /^Checking that the folder exists…$/;
  const lookups = [gate(), gate()]; // the presses' lookups, in the order they are asked
  const waiting = [...lookups];
  const { $, offers, click, type } = boxesRuntime((p) => (p === DOCS + ' ' ? waiting.shift()!.opened.then(() => notFound()) : strictListing(p)));
  type('pathInput', DOCS + ' ');
  const older = click('scanBtn');
  void $('pathInput').listeners.keydown({ key: 'Enter' }); // the newer press, held on its own lookup
  await settle();
  assert.equal(waiting.length, 0, 'control: each press looks the path up with a request of its own');
  lookups[0].open();
  await older;
  await settle();
  assert.match($('scanAnnounce').textContent, CHECKING, 'the overtaken press, landing first, leaves the sentence: the newer press is still checking');
  lookups[1].open();
  await settle();
  assert.equal(offers.length, 1, 'control: the newer press, landing, offers the folder without the space');
  assert.equal($('scanAnnounce').textContent, '', 'and its check, over, is no longer said to be running');
});

/* ══════════════ The toast an offer rides in (final review F1.12) ══════════════ */

type ToastKey = { key: string; shiftKey: boolean; altKey: boolean; ctrlKey: boolean; metaKey: boolean;
  defaultPrevented: boolean; stopped: boolean; preventDefault(): void; stopPropagation(): void };
type ToastBtn = { label: string; attrs: Record<string, string>; listeners: Array<() => void>; keys: Array<(e: ToastKey) => void>;
  disabled: boolean; tabIndex: number; visibility: string; getAttribute(k: string): string | null; getClientRects(): unknown[];
  addEventListener(t: string, f: (e: ToastKey) => void): void; click(): void; focus(): void };
/** A control on the page, as the page's modalFocusables reads one (toastRuntime's `stop`). */
type PageStop = { id: string; isConnected: boolean; disabled: boolean; tabIndex: number; visibility: string;
  /** The options its last focus() was called with. */
  focusOpts: unknown;
  getAttribute(k: string): string | null; getClientRects(): unknown[]; focus(opts?: unknown): void };
type ToastEl = { cls: Set<string>; html: string; innerHTML: string; button: ToastBtn | null; removed: boolean; className: string;
  classList: { add(c: string): void; contains(c: string): boolean }; querySelector(sel: string): ToastBtn | null; contains(x: unknown): boolean; remove(): void };

/**
 * The page's toastAction, evaluated with a fake document on a clock the test
 * steps (fire): what it put on screen, its button, and where focus is. The
 * page's Tab stops are counted by the page's own modalFocusables, over the
 * controls the test puts on the page (`stop`) followed by #toasts — the last
 * thing in the page.
 */
function toastRuntime() {
  const doc = {
    activeElement: null as unknown, createElement: () => toastEl(),
    body: { tagName: 'BODY', querySelectorAll: () => [...page.stops, ...shown.filter((el) => !el.removed).map((el) => el.button!)] },
  };
  /** The page's controls in DOM order, outside #toasts, the sheet on top, if any (topModal), and each sheet focus was handed into (modalFocusInto asks modalFocusTarget). */
  const page = { stops: [] as PageStop[], sheet: null as unknown, into: [] as unknown[] };
  /**
   * A control on the page: enabled, in the Tab order and painted. Its
   * `visibility` is the computed one — the selection bar's `visibility:
   * hidden` with nothing selected is inherited by its buttons. A browser
   * refuses focus to a control hidden that way, or gone from the page.
   */
  const stop = (id: string, visibility = 'visible'): PageStop => {
    const s: PageStop = { id, isConnected: true, disabled: false, tabIndex: 0, visibility, focusOpts: undefined,
      getAttribute: () => null, getClientRects: () => [{}],
      focus(opts) { s.focusOpts = opts; if (s.visibility === 'visible' && s.isConnected && !s.disabled) doc.activeElement = s; } };
    return s;
  };
  const shown: ToastEl[] = [];
  const timers: { fn: () => void; delay: number; done: boolean }[] = [];
  const setTimeout = (fn: () => void, delay: number) => { timers.push({ fn, delay, done: false }); return timers.length; };
  /** Every timer due now runs, as if its delay had passed (timers they set wait for the next fire). */
  const fire = () => { for (const t of timers.filter((x) => !x.done)) { t.done = true; t.fn(); } };
  function toastEl(): ToastEl {
    const el: ToastEl = {
      cls: new Set(), html: '', button: null, removed: false,
      get className() { return [...el.cls].join(' '); },
      set className(v: string) { el.cls = new Set(v.split(/\s+/).filter(Boolean)); },
      get innerHTML() { return el.html; },
      set innerHTML(v: string) {
        el.html = v;
        const b = /<button([^>]*)>([\s\S]*?)<\/button>/.exec(v);
        if (!b) { el.button = null; return; }
        const attrs: Record<string, string> = {};
        for (const a of b[1].matchAll(/([\w-]+)="([^"]*)"/g)) attrs[a[1]] = a[2];
        const btn: ToastBtn = {
          label: b[2], attrs, listeners: [], keys: [], disabled: false, tabIndex: 0, visibility: 'visible',
          getAttribute: (k) => (k in attrs ? attrs[k] : null), getClientRects: () => (el.removed ? [] : [{}]),
          addEventListener(t, f) { if (t === 'click') btn.listeners.push(f as () => void); else if (t === 'keydown') btn.keys.push(f); },
          click() { for (const f of btn.listeners) f(); },
          focus() { doc.activeElement = btn; },
        };
        el.button = btn;
      },
      classList: { add: (c) => { el.cls.add(c); }, contains: (c) => el.cls.has(c) },
      querySelector: (sel) => (sel === 'button' ? el.button : null),
      contains: (x) => x === el || (x !== null && x === el.button),
      remove() { el.removed = true; if (el.contains(doc.activeElement)) doc.activeElement = null; },
    };
    return el;
  }
  const host = { appendChild(el: ToastEl) { shown.push(el); }, contains: (x: unknown) => shown.some((el) => !el.removed && el.contains(x)) };
  const $ = (id: string) => { assert.equal(id, 'toasts', 'a toast goes in #toasts'); return host; };
  const escapeHtml = lift<(s: string) => string>(['escapeHtml'], 'escapeHtml');
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  // The counter that names each toast's message for its button, where the page has one.
  const seqDecl = INDEX.includes('let toastActionSeq = 0;') ? 'let toastActionSeq = 0;' : '';
  // The offers each sheet made, and what retires them as it closes, where the page has them.
  const retire = INDEX.includes('const sheetToasts = new Map();')
    ? `const sheetToasts = new Map(); ${braced('function toastsRetire(')}` : 'const toastsRetire = undefined;';
  // The page's own count of its Tab stops, never a stand-in that agrees with
  // itself: a control hidden by visibility kept its box and stayed in the
  // stand-in's list (review F2.1).
  const focusables = braced('function modalFocusables(');
  // The page's own modalFocusInto too, so how it focuses — without scrolling —
  // is the page's and not a stand-in's that ignored it (review F3.1). Which
  // control a sheet opens on is modalFocusTarget's, pinned in polishUiModals:
  // here it is the sheet's `target`, and each sheet asked lands in `page.into`.
  const focusInto = braced('function modalFocusInto(');
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const made = new Function('document', '$', 'icon', 'escapeHtml', 'setTimeout', 'topModal', 'modalFocusTarget', 'getComputedStyle',
    `'use strict'; ${seqDecl} ${retire} ${focusables} ${focusInto} ${braced('function toastAction(')} return { toastAction, toastsRetire };`,
  )(doc, $, () => '<svg></svg>', escapeHtml, setTimeout, () => page.sheet,
    (sheet: { target?: PageStop }) => { page.into.push(sheet); return sheet.target; },
    (el: { visibility?: string }) => ({ visibility: el.visibility ?? 'visible' })) as {
    /** Answers whether the offer is still on screen (review F1.1, F1.6). */
    toastAction: (msg: string, label: string, fn: () => unknown, kind?: string, ms?: number, opts?: { focus?: boolean; sheet?: string }) => { isOpen: () => boolean };
    /** A sheet closing (modalClosed): the offers made in it go. */
    toastsRetire: ((sheet: string) => void) | undefined;
  };
  /** A key pressed on a toast's button, as its own keydown listeners see it. */
  const key = (btn: ToastBtn, name: string, mods: Partial<ToastKey> = {}): ToastKey => {
    const e: ToastKey = { key: name, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, defaultPrevented: false, stopped: false,
      preventDefault() { e.defaultPrevented = true; }, stopPropagation() { e.stopped = true; }, ...mods };
    for (const f of btn.keys) f(e);
    return e;
  };
  return { toastAction: made.toastAction, toastsRetire: made.toastsRetire, doc, shown, timers, fire, page, key, stop };
}

test('outside a sheet an offer goes on Escape, and Tab moves on from the control it answers instead of dropping focus to <body> (QA C09)', () => {
  // QA re-check C09: the Scan card's "Did you mean …?" offer takes focus, but
  // outside a sheet Escape did nothing, and Tab left the page — #toasts is its
  // last element — for <body>.
  const rt = toastRuntime();
  const { stop } = rt;
  const search = stop('gsearch'), box = stop('pathInput'), scan = stop('scanBtn'), map = stop('treemapCanvas');
  rt.page.stops.push(search, box, scan, map);
  box.focus(); // Enter in the Scan card's path box
  let ran = 0;
  rt.toastAction('No folder is named “/x ” — the path ends with a space. Did you mean “/x”?', 'Scan that folder', () => { ran++; }, 'error', 12000, { focus: true });
  const offer = rt.shown[0];
  const btn = offer.button!;
  assert.equal(rt.doc.activeElement, btn, 'control: the offer takes focus');
  const tab = rt.key(btn, 'Tab');
  assert.equal(rt.doc.activeElement, scan, 'Tab moves on to the control after the path box, as if the offer sat beside it');
  assert.ok(tab.defaultPrevented, 'in place of the browser, which had nothing after the toasts to go to');
  assert.ok(!offer.cls.has('out'), 'and the offer stays up, to be chosen or to time out');
  btn.focus();
  rt.key(btn, 'Tab', { shiftKey: true });
  assert.equal(rt.doc.activeElement, box, 'Shift+Tab goes back to the path box it answers');
  btn.focus();
  const esc = rt.key(btn, 'Escape');
  assert.ok(offer.cls.has('out'), 'Escape dismisses the offer');
  assert.equal(rt.doc.activeElement, box, 'and focus goes back where it was');
  assert.ok(esc.defaultPrevented && esc.stopped, 'the key is the offer\'s alone: the map behind it does not climb a folder as well');
  assert.equal(ran, 0, 'dismissing it chooses nothing');
  // A dismissed offer, still fading, answers no key: they are the page's again (review F1.6).
  const late = [rt.key(btn, 'Tab'), rt.key(btn, 'Escape')];
  assert.equal(rt.doc.activeElement, box, 'a key on an offer already dismissed moves nothing');
  assert.ok(late.every((e) => !e.defaultPrevented && !e.stopped), 'and is left to the page');

  // A Tab chord is the browser's or the system's, never the offer's (review F1.6).
  rt.toastAction('No folder is named “/v ”', 'Scan that folder', () => {}, 'error', 12000, { focus: true });
  const chordBtn = rt.shown[1].button!;
  for (const mod of ['ctrlKey', 'altKey', 'metaKey'] as const) {
    chordBtn.focus();
    const e = rt.key(chordBtn, 'Tab', { [mod]: true });
    assert.ok(!e.defaultPrevented && rt.doc.activeElement === chordBtn, `${mod}+Tab is left alone`);
    const s = rt.key(chordBtn, 'Tab', { [mod]: true, shiftKey: true });
    assert.ok(!s.defaultPrevented && rt.doc.activeElement === chordBtn, `${mod}+Shift+Tab is left alone`);
  }

  // An offer whose control has gone from the page moves on to the page's first stop.
  box.focus();
  rt.toastAction('No folder is named “/z ”', 'Scan that folder', () => {}, 'error', 12000, { focus: true });
  rt.page.stops.splice(rt.page.stops.indexOf(box), 1); // the path box went with the Scan card
  const goneBtn = rt.shown[2].button!;
  rt.key(goneBtn, 'Tab');
  assert.equal(rt.doc.activeElement, search, 'Tab with its control gone goes to the first stop, never to <body>');
  goneBtn.focus();
  rt.key(goneBtn, 'Tab', { shiftKey: true });
  assert.equal(rt.doc.activeElement, map, 'and Shift+Tab to the last stop, the one a keyboard reaches #toasts from (review F1.6)');

  // An offer answering the page's last stop wraps to its first — never onto
  // itself or another offer still fading out in #toasts.
  map.focus();
  rt.toastAction('No folder is named “/w ”', 'Scan that folder', () => {}, 'error', 12000, { focus: true });
  rt.key(rt.shown[rt.shown.length - 1].button!, 'Tab');
  assert.equal(rt.doc.activeElement, search, 'Tab from an offer answering the last stop wraps to the first stop');

  // Inside a sheet both keys are the sheet's: Escape closes it, its offers with
  // it (toastsRetire), and Tab cycles inside it (modalTrapTab).
  rt.page.sheet = { id: 'apModal' };
  rt.toastAction('No folder is named “/y ”', 'Use that folder', () => {}, 'error', 12000, { focus: true, sheet: 'apModal' });
  const inSheet = rt.shown[rt.shown.length - 1];
  const e1 = rt.key(inSheet.button!, 'Escape');
  const e2 = rt.key(inSheet.button!, 'Tab');
  assert.ok(!inSheet.cls.has('out') && !e1.defaultPrevented && !e1.stopped && !e2.defaultPrevented,
    'an offer made in a sheet leaves both keys to the sheet');
});

test('Escape on an offer with no control to go back to hands focus to the page\'s last stop, never to <body> as the toast goes (review F1.1)', () => {
  // Only an offer made with { focus: true } knows the control it answers. The
  // others ("These results expire … Scan again", an error's "Scan again",
  // "Deleted the saved view … Undo") are reached by Tab from the page's last
  // stop, #toasts being the last thing in the page. Escape dismissed one and
  // left focus on its button, which went 320 ms later: focus fell to <body>.
  const rt = toastRuntime();
  const { stop } = rt;
  const search = stop('gsearch'), box = stop('pathInput'), map = stop('treemapCanvas');
  rt.page.stops.push(search, box, map);
  map.focus();
  rt.toastAction('These results expire in a minute', 'Scan again', () => {}, 'success', 12000);
  const quiet = rt.shown[0];
  assert.equal(rt.doc.activeElement, map, 'control: an offer made without { focus } does not take it');
  quiet.button!.focus(); // Tab from the last stop
  const esc = rt.key(quiet.button!, 'Escape');
  assert.ok(quiet.cls.has('out') && esc.defaultPrevented && esc.stopped, 'control: Escape dismisses it, and the key is its alone');
  rt.fire();
  assert.ok(quiet.removed, 'control: the toast has gone');
  assert.equal(rt.doc.activeElement, map, 'focus is on the stop a keyboard reached it from, not <body>');

  // An offer that took focus from a control since gone from the page.
  box.focus();
  rt.toastAction('No folder is named “/x ”', 'Scan that folder', () => {}, 'error', 12000, { focus: true });
  const orphan = rt.shown[1];
  box.isConnected = false; // the path box went with the Scan card
  rt.page.stops.splice(rt.page.stops.indexOf(box), 1);
  rt.key(orphan.button!, 'Escape');
  rt.fire();
  assert.ok(orphan.removed, 'control: the toast has gone');
  assert.equal(rt.doc.activeElement, map, 'with the control it answers gone, Escape hands focus to the last stop too');
});

test('the page\'s last stop is one a keyboard can land on: Escape and Shift+Tab on an offer skip the selection bar\'s buttons, hidden by visibility with nothing selected (review F2.1)', () => {
  // The selection bar comes after every view in the page, and with nothing
  // selected it is `visibility: hidden` (QA D02): its buttons keep their
  // boxes but cannot take focus. modalFocusables counted them, so the last
  // stop an offer handed focus to was the hidden Clear — focus stayed on the
  // toast's button and fell to <body> as it went, and Shift+Tab did nothing.
  const rt = toastRuntime();
  const { stop } = rt;
  const search = stop('gsearch'), map = stop('treemapCanvas');
  const bar = [stop('selOffloadBtn', 'hidden'), stop('selTrashBtn', 'hidden'), stop('selClearBtn', 'hidden')];
  rt.page.stops.push(search, map, ...bar);
  map.focus();
  rt.toastAction('These results expire in a minute', 'Scan again', () => {}, 'success', 12000);
  const quiet = rt.shown[0];
  quiet.button!.focus(); // Tab from the map, the last stop a keyboard reaches
  rt.key(quiet.button!, 'Escape');
  rt.fire();
  assert.ok(quiet.removed, 'control: the offer has gone');
  assert.equal(rt.doc.activeElement, map, 'Escape hands focus to the map, the last stop a keyboard can land on — not the hidden Clear, which leaves it on <body>');

  rt.toastAction('These results have expired', 'Scan again', () => {}, 'error', 15000);
  const expired = rt.shown[1].button!;
  expired.focus();
  const back = rt.key(expired, 'Tab', { shiftKey: true });
  assert.equal(rt.doc.activeElement, map, 'Shift+Tab goes back to the map, the stop a keyboard reached it from');
  assert.ok(back.defaultPrevented, 'control: in place of the browser');

  // With something selected the bar is up, and its Clear is the page's last stop.
  for (const b of bar) b.visibility = 'visible';
  expired.focus();
  rt.key(expired, 'Escape');
  assert.equal(rt.doc.activeElement, bar[2], 'with the bar up, Escape hands focus to its Clear, the last stop');
});

test('an offer chosen from the keyboard hands focus on as it goes — back to the control it answers, else into the sheet on top, else to the page\'s last stop — never to <body> (review F2.3)', () => {
  // Enter or Space on a focused button is its click. An offer made without
  // { focus: true } — "Deleted the saved view … Undo", an error's "Scan
  // again", "These results expire … Scan again" — has no control to go back
  // to, so its choice left focus on its button, which went 320 ms later:
  // focus fell to <body>, as it did on Escape before review F1.1.
  const rt = toastRuntime();
  const { stop } = rt;
  const search = stop('gsearch'), box = stop('pathInput'), map = stop('treemapCanvas');
  rt.page.stops.push(search, box, map);
  map.focus();
  let ran = 0;
  rt.toastAction('Deleted the saved view “Big videos”', 'Undo', () => { ran++; }, 'success', 12000);
  const quiet = rt.shown[0];
  quiet.button!.focus(); // Tab from the map
  quiet.button!.click(); // Enter
  assert.equal(ran, 1, 'control: the choice is made');
  rt.fire();
  assert.ok(quiet.removed, 'control: the offer has gone');
  assert.equal(rt.doc.activeElement, map, 'focus is on the page\'s last stop, the one a keyboard reached the offer from — not <body>');
  // The last stop can be off screen — the Grid draws tiles, each a stop, 200 px
  // below its window — and a toast going is no reason to scroll the page.
  assert.deepEqual(map.focusOpts, { preventScroll: true }, 'handed there without scrolling the page');

  // An offer that took focus from a control hands it back there as it is
  // chosen — no more a reason to scroll the page than any other hand-off
  // (review F3.1): the path box can sit above the fold of a scrolled page.
  box.focus(); // Enter in the Scan card's path box
  rt.toastAction('No folder is named “/v ”', 'Scan that folder', () => {}, 'error', 12000, { focus: true });
  const chosen = rt.shown[1];
  assert.equal(rt.doc.activeElement, chosen.button, 'control: the offer takes focus');
  chosen.button!.click();
  rt.fire();
  assert.equal(rt.doc.activeElement, box, 'chosen, it hands focus back to the control it answers');
  assert.deepEqual(box.focusOpts, { preventScroll: true }, 'back there without scrolling the page');

  // A control still in the page that can no longer take focus is no place to
  // go back to: its focus() leaves focus on the offer.
  box.focus();
  rt.toastAction('No folder is named “/x ”', 'Scan that folder', () => {}, 'error', 12000, { focus: true });
  const answered = rt.shown[2];
  box.visibility = 'hidden';
  answered.button!.click();
  rt.fire();
  assert.equal(rt.doc.activeElement, map, 'with the control it answers unable to take focus, focus goes to the page\'s last stop');

  // Over a sheet the page behind is inert, and its last stop no place for
  // focus: it goes into the sheet, where the sheet opens (modalFocusInto) —
  // its first field or its Cancel, never its Save.
  const cancel = stop('settingsCancelBtn');
  const sheet = { id: 'settingsModal', target: cancel };
  rt.page.sheet = sheet;
  rt.toastAction('These results expire in a minute', 'Scan again', () => {}, 'success', 12000);
  const over = rt.shown[3];
  over.button!.focus(); // a press on it
  over.button!.click();
  assert.deepEqual(rt.page.into, [sheet], 'focus is handed into the sheet on top');
  assert.equal(rt.doc.activeElement, cancel, 'onto the control the sheet opens on');
  // By the page's own modalFocusInto, which scrolls neither the page behind
  // nor the sheet (review F3.1).
  assert.deepEqual(cancel.focusOpts, { preventScroll: true }, 'handed there without scrolling');
});

test('an offer\'s button acts once: a double-click, or a click while the toast fades out, does not run its choice again (final review F1.12)', () => {
  // The toast fades for 320 ms before it is removed, and stays clickable
  // while it does. A double-click on "Did you mean…" ran the choice twice:
  // the scan started, then the second run said "A scan is already running".
  const { toastAction, shown, fire } = toastRuntime();
  let ran = 0;
  toastAction('No folder is named “/x ”', 'Use that folder', () => { ran++; }, 'error');
  const btn = shown[0].button!;
  btn.click();
  assert.equal(ran, 1, 'control: a click runs the choice');
  assert.ok(shown[0].cls.has('out'), 'control: and the toast goes');
  btn.click();
  assert.equal(ran, 1, 'a second click while it fades does not run it again');
  fire();
  assert.ok(shown[0].removed, 'control: the toast is removed once it has faded');

  toastAction('Results expire soon', 'Scan again', () => { ran++; }, 'success', 20000);
  fire(); // its time is up: it fades
  assert.ok(shown[1].cls.has('out'), 'control: an offer left alone fades when its time is up');
  shown[1].button!.click();
  assert.equal(ran, 1, 'and a click on it while it fades does nothing');
});

test('an offer says whether it is still on screen — until its time is up, it is dismissed or it is chosen — so a caller can tell a standing offer from one long gone (review F1.1, F1.6)', () => {
  // An expired scan's Scan again offer says the sentence while it is up; a failure after it has gone must be
  // said by its caller, and the page marked the scan offered for good: the map and Find went silent.
  const rt = toastRuntime();
  const map = rt.stop('treemapCanvas');
  rt.page.stops.push(map);
  map.focus();
  const timed = rt.toastAction('These results have expired', 'Scan again', () => {}, 'error', 15000);
  assert.equal(timed.isOpen(), true, 'on screen once made');
  rt.fire(); // 15 s on
  assert.equal(timed.isOpen(), false, 'gone once its time is up');
  const held = rt.toastAction('These results have expired', 'Scan again', () => {}, 'error', 15000);
  rt.shown[1].button!.focus(); // a keyboard on it: it waits for that
  rt.fire();
  assert.equal(held.isOpen(), true, 'still on screen while focus holds it past its time');
  rt.key(rt.shown[1].button!, 'Escape');
  assert.equal(held.isOpen(), false, 'gone once dismissed');
  const chosen = rt.toastAction('These results have expired', 'Scan again', () => {}, 'error', 15000);
  rt.shown[2].button!.click();
  assert.equal(chosen.isOpen(), false, 'gone once chosen');
});

test('an offer says in words what the path ends with, its button is a short verb, and its message wraps inside the toast (final review F1.9, F1.13)', async () => {
  // The only difference between the path typed and the folder offered is
  // whitespace at its end: on screen a hairline gap before a closing quote,
  // to a screen reader nothing — both names read the same, and "no such
  // folder" read as a contradiction. It is said in words.
  const trailingBlanks = lift<(p: string) => string>(['trailingBlanks'], 'trailingBlanks');
  assert.equal(trailingBlanks('/a/Shots '), 'a space');
  assert.equal(trailingBlanks('/a/Shots   '), '3 spaces');
  assert.equal(trailingBlanks('/a/Shots\t'), 'a tab');
  assert.equal(trailingBlanks('/a/Shots\t\t'), '2 tabs');
  assert.equal(trailingBlanks('/a/Shots  '), '2 blank characters');
  const { offers, click, type } = boxesRuntime(strictListing);
  type('pathInput', DOCS + '  ');
  await click('scanBtn');
  assert.equal(offers.at(-1)!.msg, noFolder(DOCS + '  ', '2 spaces', DOCS), 'the offer says how many');

  // The button held the whole path and could not shrink (flex:none): with a
  // long path it hung hundreds of pixels past the toast's 380 px and off the
  // window's edge. The path lives in the message, which wraps — at any
  // character if it must, since a path has no spaces to break at.
  type('apPath', DOCS + ' ');
  await click('apSaveBtn');
  await click('browseBtn'); // the Scan card's box still holds DOCS + '  '
  assert.equal(offers.length, 3, 'control: the Scan card, the Autopilot editor and the picker each made an offer');
  for (const o of offers) assert.doesNotMatch(o.label, /\//, `an offer's button holds no path: "${o.label}"`);
  const span = /\.toast > span \{([^}]*)\}/.exec(INDEX);
  assert.ok(span, 'a toast\'s message has a rule of its own');
  assert.match(span![1], /min-width:\s*0/, 'its message may shrink below its longest word');
  assert.match(span![1], /overflow-wrap:\s*anywhere/, 'and breaks a path anywhere to fit');
});

test('an offer takes focus, so a keyboard reaches it with a sheet open or not, and hands focus back when it goes; a sheet lets focus stay in a toast (final review F1.10)', async () => {
  // The only way to take the folder offered was a toast's button, and with
  // the policy editor or the picker open the keyboard could not get there:
  // Tab cycles inside the sheet and a focusin guard pulls focus back into it.
  const { toastAction, doc, shown, fire } = toastRuntime();
  const box = { isConnected: true, focus() { doc.activeElement = box; } };
  box.focus(); // the person pressed Save, Scan or Enter in a path box
  let ran = 0;
  toastAction('No folder is named “/x ” — the path ends with a space. Did you mean “/x”?', 'Use that folder', () => { ran++; }, 'error', 12000, { focus: true });
  const btn = shown[0].button!;
  assert.equal(doc.activeElement, btn, 'the offer\'s button takes focus as it appears');
  const described = btn.attrs['aria-describedby'];
  assert.ok(described, 'and is described by the message, which a screen reader reads with it');
  assert.ok(shown[0].html.includes(`<span id="${described}">No folder is named`), `the message is the element it names (${described})`);
  fire();
  assert.ok(!shown[0].cls.has('out'), 'a toast holding focus does not time out from under it');
  btn.click();
  assert.equal(ran, 1, 'control: the choice is made');
  assert.equal(doc.activeElement, box, 'and focus goes back where it was');

  toastAction('No folder is named “/y ”', 'Use that folder', () => { ran++; }, 'error', 12000, { focus: true });
  assert.equal(doc.activeElement, shown[1].button, 'control: a second offer takes focus');
  const other = { isConnected: true, focus() { doc.activeElement = other; } };
  other.focus(); // the person tabbed away
  fire();
  assert.ok(shown[1].cls.has('out'), 'once focus has left it, the toast times out as any other');
  assert.equal(doc.activeElement, other, 'and focus stays where the person put it');
  const ids = new Set(shown.map((t) => t.button!.attrs['aria-describedby']));
  assert.equal(ids.size, 2, 'each toast names its own message');

  toastAction('Results expire soon', 'Scan again', () => {}, 'success', 20000);
  assert.equal(doc.activeElement, other, 'a toast nobody asked for leaves focus where it is');

  // Every offer is an answer to the person's own press, so each takes focus.
  const { offers, click, type } = boxesRuntime(strictListing);
  type('pathInput', DOCS + ' ');
  await click('scanBtn');
  type('apPath', DOCS + ' ');
  await click('apSaveBtn');
  await click('browseBtn');
  assert.equal(offers.length, 3, 'control: the Scan card, the Autopilot editor and the picker each made an offer');
  assert.deepEqual(offers.map((o) => o.focus), [true, true, true], 'each offer takes focus');

  // The page's focusin guard, evaluated: focus outside the top sheet is pulled
  // back into it — except into #toasts, where an offer made from the sheet sits.
  const guardAt = INDEX.indexOf("document.addEventListener('focusin', (e) => {\n  noteFocus(e.target);");
  assert.notEqual(guardAt, -1, 'the page has its focusin guard');
  const guard = INDEX.slice(guardAt, INDEX.indexOf('\n});', guardAt) + '\n});'.length);
  // The guard also lets focus stay in a panel a sheet's own content opens over it (inModalOverlay,
  // BQA-1 B31): the page's own list and test, lifted as the guard is, never a stand-in that agrees with itself.
  const overlayAt = INDEX.indexOf('const MODAL_OVERLAYS = ');
  assert.notEqual(overlayAt, -1, 'the page lists the panels a sheet opens over it');
  const overlayFnAt = INDEX.indexOf('function inModalOverlay(', overlayAt);
  const overlay = INDEX.slice(overlayAt, INDEX.indexOf('\n}\n', overlayFnAt) + '\n}\n'.length);
  const inSheet = { id: 'save' };
  const inToast = { id: 'offer' };
  const onPage = { id: 'map' };
  const sheet = { contains: (x: unknown) => x === inSheet };
  const toasts = { contains: (x: unknown) => x === inToast };
  const pulled: unknown[] = [];
  const heard: { focusin?: (e: { target: unknown }) => void } = {};
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function('document', '$', 'noteFocus', 'topModal', 'modalFocusInto', `'use strict'; ${overlay}\n${guard}`)(
    { addEventListener: (t: string, f: (e: { target: unknown }) => void) => { if (t === 'focusin') heard.focusin = f; } },
    (id: string) => { assert.equal(id, 'toasts'); return toasts; },
    () => {}, () => sheet, (s: unknown) => { pulled.push(s); });
  assert.ok(heard.focusin, 'control: the guard listens for focusin');
  heard.focusin!({ target: onPage });
  assert.deepEqual(pulled, [sheet], 'control: focus that lands on the page under a sheet is pulled back into it');
  heard.focusin!({ target: inToast });
  assert.deepEqual(pulled, [sheet], 'focus on an offer\'s button stays there');
  const inBreakdown = { id: 'rcPopClose', closest: (sel: string) => (sel === '#rcPopover' ? {} : null) };
  heard.focusin!({ target: inBreakdown });
  assert.deepEqual(pulled, [sheet], 'focus in the score breakdown a sheet opened over it stays there (B31)');
});

test('an offer made in a sheet goes when that sheet closes — its choice with it, even while it holds focus — the other offers stay, and each offer names the sheet it was made in (final review F2.2, F2.3)', async () => {
  // An offer holding focus never timed out, so one made in the policy editor,
  // Settings or the picker outlived the sheet when Escape closed it: its
  // choice then did nothing (the editor and Settings retire the press) or
  // re-listed a picker nobody could see. modalClosed retires the closing
  // sheet's offers and hands focus back to the sheet's opener (polishUiModals
  // evaluates that side).
  const { toastAction, toastsRetire, doc, shown, fire } = toastRuntime();
  assert.equal(typeof toastsRetire, 'function', 'the page retires the offers a sheet made');
  const ran: string[] = [];
  toastAction('No folder is named “/c ”', 'Scan that folder', () => { ran.push('card'); }, 'error', 12000, { focus: true });
  toastAction('No folder is named “/b ”', 'Open that folder', () => { ran.push('picker'); }, 'error', 12000, { focus: true, sheet: 'browseModal' });
  toastAction('No folder is named “/a ”', 'Use that folder', () => { ran.push('editor'); }, 'error', 12000, { focus: true, sheet: 'apModal' });
  const [card, picker, editor] = shown;
  assert.equal(doc.activeElement, editor.button, 'control: the editor\'s offer holds focus');
  toastsRetire!('apModal'); // Escape closed the editor
  assert.ok(editor.cls.has('out'), 'the editor\'s offer goes as the editor closes, though it holds focus');
  editor.button!.click();
  assert.equal(ran.length, 0, 'and a click on it as it fades makes no choice');
  assert.ok(!card.cls.has('out') && !picker.cls.has('out'), 'the Scan card\'s offer and the picker\'s stay');

  // The editor opened again makes an offer of its own, which goes when the
  // editor closes again.
  toastAction('No folder is named “/d ”', 'Use that folder', () => { ran.push('editor again'); }, 'error', 12000, { focus: true, sheet: 'apModal' });
  const again = shown[3];
  toastsRetire!('apModal');
  assert.ok(again.cls.has('out'), 'an offer made in the editor opened again goes when it closes again');
  again.button!.click();
  card.button!.click();
  assert.deepEqual(ran, ['card'], 'control: the offer no sheet made is still a choice');
  assert.ok(!picker.cls.has('out'), 'control: the picker\'s offer is still up');
  fire();
  assert.ok(editor.removed && again.removed, 'a retired offer leaves the page');

  // Each offer names the sheet it was made in — the Scan card none.
  const { rt, offers, click, type } = boxesRuntime(strictListing);
  type('pathInput', DOCS + ' ');
  await click('scanBtn');
  type('apPath', DOCS + ' ');
  await click('apSaveBtn');
  await click('browseBtn');
  rt.openPolicyEditor(null);
  type('apPath', DOCS + ' ');
  await click('apPreviewBtn');
  assert.equal(offers.length, 4, 'control: the Scan card, Save in the editor, the picker and Preview each made an offer');
  assert.deepEqual(offers.map((o) => o.sheet), [null, 'apModal', 'browseModal', 'apModal'],
    'the Scan card\'s offer belongs to no sheet; the editor\'s and the picker\'s to theirs');
  const settings = settingsRuntime(strictListing, []);
  settings.addRow(DOCS + ' ');
  await settings.save();
  assert.equal(settings.offers.length, 1, 'control: Settings made an offer');
  assert.equal(settings.offers[0].sheet, 'settingsModal', 'and it belongs to Settings');
});

test('a path the lookup cannot even spell — a pasted lone surrogate before a trailing space — never leaves Scan held: it is scanned as typed, for the scan to report (final review F1.5)', async () => {
  // encodeURIComponent throws a URIError on a lone surrogate. boxMeant built
  // the lookup's URL before its promise chain, so the throw escaped the press
  // between holding the button and handing it back: Scan stayed disabled
  // until a reload.
  const ODD = '/x/\uD800 ';
  const { $, scanned, toasts, click, type } = boxesRuntime(strictListing);
  type('pathInput', ODD);
  await click('scanBtn'); // rejects, and fails this test, if the throw escapes
  assert.equal($('scanBtn').disabled, false, 'Scan is live again');
  assert.equal($('scanBtn').getAttribute('aria-busy'), null, 'and not busy');
  assert.deepEqual(scanned.map(([p]) => p), [ODD], 'the path is scanned exactly as typed, for the scan to report');
  assert.deepEqual(toasts, []);
});

test('Preview of a folder whose trailing space names no folder says so in words and offers the folder without it, as Save does — never a bare "Path does not exist" (final review F1.6)', async () => {
  const { rt, $, offers, click, type, policy } = boxesRuntime(strictListing);
  rt.openPolicyEditor(null);
  type('apPath', DOCS + ' ');
  await click('apPreviewBtn');
  assert.equal(policy('/api/autopilot/simulate').policy!.path, DOCS + ' ', 'control: Preview asks about the folder exactly as typed');
  assert.equal(offers.length, 1, 'the folder without the space is offered');
  assert.equal(offers[0].msg, noFolder(DOCS + ' ', 'a space', DOCS), 'in the words Save uses');
  assert.equal(offers[0].label, 'Use that folder');
  assert.match($('apPreview').innerHTML, /No folder is named “\/home\/u\/Documents ” — the path ends with a space\./,
    'and the preview says so where its answer goes, not a bare "Path does not exist"');
  await offers[0].choose();
  assert.equal($('apPath').value, DOCS, 'choosing it puts that folder in the box');

  type('apPath', '/home/u/Nope ');
  await click('apPreviewBtn');
  assert.equal(offers.length, 1, 'nothing is offered where neither spelling is a folder');
  assert.match($('apPreview').innerHTML, /Path does not exist/, 'and the server\'s reason is shown');

  type('apPath', DOCS + ' ');
  await click('apPreviewBtn');
  assert.equal(offers.length, 2, 'control: offered again');
  rt.close('apModal');
  rt.openPolicyEditor({ id: 'p2', name: 'Other', path: '/data', match: { kind: 'custom' } });
  await offers[1].choose();
  assert.equal($('apPath').value, '/data', 'a click on an offer a closed editor made leaves the one opened after it alone');

  // The editor closed while the preview was on its way: no offer is made for it.
  const g = gate();
  const slow = boxesRuntime(slowStray(g));
  slow.rt.openPolicyEditor(null);
  slow.type('apPath', DOCS + ' ');
  const pending = slow.click('apPreviewBtn');
  slow.rt.close('apModal');
  g.open();
  await pending;
  assert.deepEqual(slow.offers, [], 'a preview answered after its editor closed offers nothing');
});

test('Scan reads Fast rescan when pressed, and a lookup that does not answer in time scans the path exactly as typed (QA4a R4-3)', async () => {
  const g = gate();
  const { rt, $, scanned, offers, click, type, timers, fire } = boxesRuntime(slowShots(g));
  rt.rememberScannedRoot(SLOW);
  type('pathInput', SLOW);
  assert.equal($('fastRescanWrap').hidden, false, 'Fast rescan is offered for the folder scanned before');
  assert.ok(!$('fastRescan').checked, 'unticked: it is the person\'s choice (QA D45)');
  $('fastRescan').checked = true; // the person ticks it
  const pending = click('scanBtn');
  $('fastRescan').checked = false; // unticked while Scan waits
  const waiting = timers.filter((t) => !t.cleared);
  assert.equal(waiting.length, 1, 'the wait for the lookup is bounded');
  // Pinned to the number, so a change to the limit is a deliberate edit here:
  // "at most 5 s" let a 4.9 s limit through (final review F1.16).
  const limit = lift<number>(['PATH_LOOKUP_MS'], 'PATH_LOOKUP_MS');
  assert.equal(limit, 3000, 'Scan and Save wait 3 s on a lookup');
  assert.equal(waiting[0].delay, limit, 'and Scan\'s wait is that limit');
  fire();
  await pending;
  assert.deepEqual(scanned, [[SLOW, { incremental: true }]],
    'the path is scanned exactly as typed — the scan answers for a folder that is not there — as the fast rescan Scan was pressed with');
  assert.equal($('scanBtn').disabled, false, 'and Scan is live again');
  g.open();
  await settle();
  assert.equal(scanned.length, 1, 'the late answer starts nothing');
  assert.deepEqual(offers, []);
});

test('Save reads every field when pressed, holds its button while the folder is looked up, and saves nothing once the editor closed, the folder changed or another press took over (QA4a R4-3)', async () => {
  // Every field as Save was pressed.
  {
    const g = gate();
    const { rt, $, click, type, saved, policy } = boxesRuntime(slowShots(g));
    rt.openPolicyEditor(null);
    $('apName').value = 'Shots';
    type('apPath', SLOW);
    const pending = click('apSaveBtn');
    assert.equal($('apSaveBtn').disabled, true, 'Save is held while the folder is looked up');
    $('apName').value = 'Renamed while it waited';
    g.open();
    await pending;
    assert.deepEqual(saved(), [[SLOW]], 'the folder that exists as typed is saved');
    assert.equal(policy('/api/autopilot/policies').policies![0].name, 'Shots', 'with every field as it was when Save was pressed');
    assert.equal($('apSaveBtn').disabled, false, 'and Save is live again');
  }
  // The editor closed while the folder was looked up.
  {
    const g = gate();
    const { rt, $, click, type, saves } = boxesRuntime(slowShots(g));
    rt.openPolicyEditor(null);
    type('apPath', SLOW);
    const pending = click('apSaveBtn');
    rt.close('apModal');
    assert.equal($('apSaveBtn').disabled, false, 'a closed editor holds nothing — it opens again with Save live');
    assert.equal($('apSaveBtn').getAttribute('aria-busy'), null, 'and not busy (final review F1.11)');
    g.open();
    await pending;
    assert.equal(saves(), 0, 'a Save still looking up its folder when the editor closed saves nothing');
  }
  // Another folder typed while it was looked up.
  {
    const g = gate();
    const { rt, $, click, type, saves, toasts } = boxesRuntime(slowShots(g));
    rt.openPolicyEditor(null);
    type('apPath', SLOW);
    const pending = click('apSaveBtn');
    assert.equal($('apSaveBtn').getAttribute('aria-busy'), 'true', 'the held Save is busy (final review F1.11)');
    type('apPath', '/data');
    g.open();
    await pending;
    assert.equal(saves(), 0, 'a Save whose folder was changed while it was looked up saves nothing');
    assert.equal($('apSaveBtn').disabled, false, 'and Save is live again, for the folder now in the box');
    assert.equal($('apSaveBtn').getAttribute('aria-busy'), null, 'no longer busy');
    assert.equal(toasts.at(-1), 'Nothing was saved — the folder changed while it was being checked. Press Save to save the folder in the box.',
      'and the person is told nothing was saved (final review F1.5)');
  }
  // Two presses.
  {
    const g = gate();
    const { rt, click, type, saves } = boxesRuntime(slowShots(g));
    rt.openPolicyEditor(null);
    type('apPath', SLOW);
    const first = click('apSaveBtn');
    const second = click('apSaveBtn');
    g.open();
    await Promise.all([first, second]);
    assert.equal(saves(), 1, 'two presses save once');
  }
  // A press in an editor since closed, landing first, leaves the hold of the
  // press made in the editor opened after it alone (final review F1.15).
  {
    const g1 = gate();
    const g2 = gate();
    const { rt, $, click, type, saved } = boxesRuntime((p) => (p === DOCS + ' ' ? g1.opened.then(() => notFound())
      : p === SLOW ? g2.opened.then(() => ({ path: SLOW, parent: '/Volumes/NAS', dirs: [] })) : strictListing(p)));
    rt.openPolicyEditor(null);
    type('apPath', DOCS + ' ');
    const older = click('apSaveBtn');
    rt.close('apModal'); // hands the button back, and retires that press
    rt.openPolicyEditor(null);
    type('apPath', SLOW);
    const newer = click('apSaveBtn');
    assert.equal($('apSaveBtn').disabled, true, 'control: the newer press holds Save');
    g1.open();
    await older;
    assert.equal($('apSaveBtn').disabled, true, 'the retired press, landing first, does not hand back the button the newer press holds');
    assert.equal($('apSaveBtn').getAttribute('aria-busy'), 'true', 'nor end its busy state');
    g2.open();
    await newer;
    assert.equal($('apSaveBtn').disabled, false, 'the newer press hands it back');
    assert.deepEqual(saved(), [[SLOW]], 'and saves its folder');
  }
});

test('Save keeps focus through its folder\'s lookup — held disabled, the button hands focus to <body>, and it is given back as the button is, unless the person moved it meanwhile, the button never had it or the editor closed (as K02 found of Scan)', async () => {
  const refusal = Object.assign(new Error('A policy needs at least one condition'), { code: 'POLICY_MATCH_EMPTY', status: 400 });
  // The server refuses the policy once the folder is found: the editor stays open, saying why, and Save holds focus
  // for the press after the person fixes it.
  {
    const g = gate();
    const { rt, $, click, type, saves, toasts, document } = boxesRuntime(slowShots(g), refusal);
    rt.openPolicyEditor(null);
    type('apPath', SLOW);
    $('apSaveBtn').focus(); // Tab to Save, then Enter
    const pending = click('apSaveBtn');
    assert.equal($('apSaveBtn').disabled, true, 'control: Save is held while the folder is looked up');
    assert.equal(document.activeElement, document.body, 'control: a browser hands focus from the held button to <body>');
    g.open();
    await pending;
    assert.deepEqual([saves(), toasts.at(-1)], [1, refusal.message], 'control: the save was asked for, and refused with its reason');
    assert.ok($('apModal').cls.has('open'), 'control: the editor stays open');
    assert.equal($('apSaveBtn').disabled, false, 'control: Save is handed back');
    assert.equal(document.activeElement, $('apSaveBtn'), 'focus is on Save again — the next Enter reaches it — never left on <body>');
  }
  // Focus the person moved while the folder was looked up — to the name field — stays there.
  {
    const g = gate();
    const { rt, $, click, type, document } = boxesRuntime(slowShots(g), refusal);
    rt.openPolicyEditor(null);
    type('apPath', SLOW);
    $('apSaveBtn').focus();
    const pending = click('apSaveBtn');
    $('apName').focus();
    g.open();
    await pending;
    assert.equal(document.activeElement, $('apName'), 'focus moved meanwhile is left where the person put it');
  }
  // A press that never focused the button — a mouse click in Safari or Firefox on macOS — is given no focus (F3.7).
  {
    const g = gate();
    const { rt, $, click, type, document } = boxesRuntime(slowShots(g), refusal);
    rt.openPolicyEditor(null);
    type('apPath', SLOW);
    assert.equal(document.activeElement, document.body, 'control: nothing is focused before the press');
    const pending = click('apSaveBtn');
    g.open();
    await pending;
    assert.equal(document.activeElement, document.body, 'focus the button never held is not pulled onto it');
  }
  // The editor closed while the folder was looked up: its Save is not this press's to give focus to.
  {
    const g = gate();
    const { rt, $, click, type, saves, document } = boxesRuntime(slowShots(g), refusal);
    rt.openPolicyEditor(null);
    type('apPath', SLOW);
    $('apSaveBtn').focus();
    const pending = click('apSaveBtn');
    assert.equal(document.activeElement, document.body, 'control: focus falls from the held button');
    rt.close('apModal');
    assert.equal($('apSaveBtn').disabled, false, 'control: the closed editor hands Save back');
    g.open();
    await pending;
    assert.equal(saves(), 0, 'control: a closed editor saves nothing');
    assert.notEqual(document.activeElement, $('apSaveBtn'), 'focus is not pulled into the closed editor');
  }
});

test('an Autopilot offer outlives nothing: a click after the editor closed never fills the one opened next, and a lookup that does not answer in time saves the folder as typed (QA4a R4-3)', async () => {
  {
    const { rt, $, click, type, offers } = boxesRuntime(strictListing);
    rt.openPolicyEditor(null);
    type('apPath', DOCS + ' ');
    await click('apSaveBtn');
    assert.equal(offers.length, 1, 'the folder is offered');
    rt.close('apModal');
    rt.openPolicyEditor({ id: 'p2', name: 'Other', path: '/data', match: { kind: 'custom' } });
    await offers[0].choose();
    assert.equal($('apPath').value, '/data', 'a click on an offer made for an editor since closed leaves the one opened after it alone');
  }
  {
    const g = gate();
    const { rt, click, type, saved, offers, timers, fire } = boxesRuntime(slowStray(g));
    rt.openPolicyEditor(null);
    type('apPath', DOCS + ' ');
    const pending = click('apSaveBtn');
    const waiting = timers.filter((t) => !t.cleared);
    assert.equal(waiting.length, 1, 'Save waits on the lookup for a bounded time');
    assert.equal(waiting[0].delay, 3000, 'of 3 s (final review F1.16)');
    fire();
    await pending;
    assert.deepEqual(saved(), [[DOCS + ' ']],
      'a folder lookup that does not answer in time saves the folder exactly as typed — never the one without its space');
    g.open();
    await settle();
    assert.deepEqual(offers, [], 'its late answer offers nothing');
    assert.equal(saved().length, 1, 'and saves nothing more');
  }
});

test('leading whitespace pasted into the Autopilot folder is paste debris — Preview, Save and Browse… all read the folder without it, and a stray trailing space after it is still offered (final review F1.14)', async () => {
  // Every other test typed only a trailing space into this box: reading it
  // raw anywhere in the editor would have passed them all.
  const { rt, asked, offers, click, type, policy, saved, toasts } = boxesRuntime(strictListing);
  rt.openPolicyEditor(null);
  type('apPath', '  ' + SHOT);
  await click('apPreviewBtn');
  assert.equal(policy('/api/autopilot/simulate').policy!.path, SHOT, 'Preview asks about the folder without the leading spaces');
  await click('apBrowseBtn');
  assert.equal(asked.at(-1), list(SHOT), 'Browse… opens the picker at it');
  rt.close('browseModal');
  await click('apSaveBtn');
  assert.deepEqual(saved(), [[SHOT]], 'and Save saves it — its own trailing space kept');

  rt.openPolicyEditor(null);
  type('apPath', '   ' + DOCS + ' ');
  await click('apSaveBtn');
  assert.equal(saved().length, 1, 'leading and a stray trailing space: nothing is saved');
  assert.ok(!toasts.some((t) => /^Nothing was saved/.test(t)), `not refused as a folder changed while it was checked: ${JSON.stringify(toasts)}`);
  assert.equal(offers.length, 1, 'the folder without the trailing space is offered');
  assert.equal(offers[0].msg, noFolder(DOCS + ' ', 'a space', DOCS), 'for the path as read');
  await offers[0].choose();
  await click('apSaveBtn');
  assert.deepEqual(saved().at(-1), [DOCS], 'and Save after choosing it saves that folder');
});

/* ══════════════ The scheduled-scan folders in Settings (final review F1.4) ══════════════ */

type SchedRow = { box: { value: string; dataset: { i: string } }; querySelector(sel: string): unknown };

/**
 * Settings' schedule rows, collectSettingsForms and the Save button, evaluated
 * from the built page with fake rows: what Save sends, what it offers, and
 * what it tells the person.
 */
function settingsRuntime(listing: (p: string) => unknown, stored: { id: string; path: string }[]) {
  const els = new Map<string, BoxEl>();
  const $ = (id: string) => {
    if (!els.has(id)) {
      const el = fakeEl(id) as BoxEl;
      el.querySelector = () => null;
      el.click = () => { if (!el.disabled) void el.listeners.click?.(); };
      els.set(id, el);
    }
    return els.get(id)!;
  };
  const rows: SchedRow[] = [];
  /** A schedule row as renderSchedules draws it, for settingsData.schedules[i]: its folder box holds `path`. */
  const drawRow = (path: string) => {
    const box = { value: path, dataset: { i: String(rows.length) } };
    const fields: Record<string, unknown> = { '.s-path': box, '.s-int': { value: '24' }, '.s-gb': { value: '' }, '.s-pct': { value: '' }, '.s-on': { checked: true } };
    rows.push({ box, querySelector: (sel: string) => fields[sel] });
  };
  const document = {
    querySelectorAll: (sel: string) => {
      if (sel === '#schedList .sched-row:not(.sched-head)') return rows;
      if (sel === '#schedList .s-path') return rows.map((r) => r.box);
      return [];
    },
  };
  const asked: string[] = [];
  const puts: { schedules: { path: string }[] }[] = [];
  const toasts: string[] = [];
  const offers: Offer[] = [];
  const closed: string[] = [];
  const timers: { fn: () => void; delay: number; cleared: boolean }[] = [];
  const setTimeout = (fn: () => void, delay: number) => { timers.push({ fn, delay, cleared: false }); return timers.length; };
  const clearTimeout = (id: number) => { if (timers[id - 1]) timers[id - 1].cleared = true; };
  const api = async (url: string, opts?: { method?: string; body?: string }) => {
    if (url.startsWith('/api/fs/list')) {
      asked.push(url);
      const answer = await listing(decodeURIComponent(url.slice(url.indexOf('path=') + 5)));
      if (answer instanceof Error) throw answer;
      return answer;
    }
    assert.equal(url, '/api/settings');
    const body = JSON.parse(opts!.body!);
    puts.push(body);
    return { ...body, ignore: [] };
  };
  const browse = between('/* ───────────────────────────── Browse modal ───────────────────────────── */',
    "$('browseUseBtn').addEventListener('click'");
  const src = [browse, between('/** Read the form rows back into settingsData', '/* ── Growth notifications')].join('\n');
  const escapeHtml = lift<(s: string) => string>(['escapeHtml'], 'escapeHtml');
  const noop = () => {};
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const rt = new Function(
    '$', 'api', 'toast', 'toastAction', 'escapeHtml', 'document', 'setTimeout', 'clearTimeout', 'closeModal',
    'renderSchedules', 'renderIgnores', 'renderCleanupGoalFields', 'renderReclaimWeights', 'reclaimReset',
    'collectCloudCreds', 'collectReclaimWeights', 'collectCleanupGoal', 'drawView', 'refreshBigFiles', 'startScan',
    `'use strict';
     const state = { root: null, system: { homeDir: '/home/u', commonDirs: [] }, view: 'dashboard', treemap: {}, bigFilesSort: 'size' };
     let settingsData = { ignore: [], schedules: ${JSON.stringify(stored)}.map((s) => ({ intervalHours: 24, enabled: true, ...s })) };
     let humanScaleOn = true;
     function icon() { return ''; }
     ${src}
     return {
       remember: typeof rememberStoredSchedules === 'function' ? rememberStoredSchedules : () => {},
       closed: typeof settingsSheetClosed === 'function' ? settingsSheetClosed : () => {},
       // What "Add schedule" does before its row is drawn.
       add: (path) => { settingsData.schedules.push({ id: '', path, intervalHours: 24, enabled: true }); },
     };`,
  )($, api, (m: string) => { toasts.push(m); }, offerRecorder(offers), escapeHtml, document, setTimeout, clearTimeout,
    (id: string) => { closed.push(id); }, noop, noop, noop, noop, noop, () => ({}), () => ({}), () => null, noop, noop, noop) as {
    /** What opening the sheet does once the stored settings arrive. */
    remember: () => void;
    /** The sheet closing (closeModal's settingsModal arm). */
    closed: () => void;
    add: (path: string) => void;
  };
  for (const s of stored) drawRow(s.path);
  rt.remember();
  /** "Add schedule", then the person types `path` into its folder box. */
  const addRow = (path: string) => { rt.add(''); drawRow(path); };
  const save = () => Promise.resolve($('settingsSaveBtn').listeners.click());
  /** The folders of every settings body Save sent, one list per save. */
  const saved = () => puts.map((b) => b.schedules.map((s) => s.path));
  return { rt, $, rows, addRow, asked, saved, toasts, offers, closed, save, timers };
}

test('a scheduled scan\'s folder keeps the whitespace at its end — on any Save, stored or typed — and one typed that names no folder, where the folder without it exists, is offered, never saved in its place (final review F1.4)', async () => {
  // collectSettingsForms trimmed every schedule box on every Save, so a
  // folder "Screenshots " saved once was swapped for its sibling
  // "Screenshots" by the next Save of anything in Settings.
  {
    const { asked, saved, save } = settingsRuntime(strictListing, [{ id: 's1', path: SHOT }]);
    await save();
    assert.deepEqual(saved(), [[SHOT]], 'a stored folder is saved as stored, by a Save that never touched it');
    assert.deepEqual(asked, [], 'and is never looked up under another name');
  }
  {
    const { rows, addRow, asked, saved, offers, save } = settingsRuntime(strictListing, []);
    addRow(DOCS + ' '); // typed, with a stray space
    await save();
    assert.deepEqual(saved(), [], 'a typed folder that names none is not saved — nor the folder without its space');
    assert.equal(offers.length, 1, 'the folder without the space is offered');
    assert.equal(offers[0].msg, noFolder(DOCS + ' ', 'a space', DOCS), 'in the words every path box uses');
    assert.equal(offers[0].label, 'Use that folder');
    assert.ok(asked.includes(list(DOCS + ' ')), 'control: the folder as typed was looked up');
    await offers[0].choose();
    assert.equal(rows[0].box.value, DOCS, 'choosing it puts that folder in the box');
    assert.deepEqual(saved(), [], 'and saves nothing — saving is the person\'s own press');
    await save();
    assert.deepEqual(saved(), [[DOCS]], 'which saves the folder chosen');
  }
  {
    const { addRow, saved, offers, save } = settingsRuntime(strictListing, []);
    addRow(SHOT); // a folder whose name ends in a space, typed or added from the scan
    addRow('   ' + DOCS); // leading paste debris
    await save();
    assert.deepEqual(saved(), [[SHOT, DOCS]], 'a folder that exists as typed is saved as typed, and leading whitespace goes');
    assert.deepEqual(offers, []);
  }
});

test('Settings Save holds while a typed scheduled folder is looked up, saves nothing once the sheet closed or a setting changed meanwhile, and says so (final review F1.4)', async () => {
  {
    const g = gate();
    const { $, rows, addRow, saved, toasts, save } = settingsRuntime(slowStray(g), []);
    addRow(DOCS + ' ');
    const pending = save();
    assert.equal($('settingsSaveBtn').disabled, true, 'Save is held while the folder is looked up');
    assert.equal($('settingsSaveBtn').getAttribute('aria-busy'), 'true', 'and busy');
    rows[0].box.value = '/data';
    g.open();
    await pending;
    assert.deepEqual(saved(), [], 'a setting changed while it was looked up: nothing is saved');
    assert.equal(toasts.at(-1), 'Nothing was saved — a setting changed while a scheduled folder was being checked. Press Save to save the settings as they are now.',
      'and the person is told');
    assert.equal($('settingsSaveBtn').disabled, false, 'Save is live again');
    assert.equal($('settingsSaveBtn').getAttribute('aria-busy'), null);
  }
  {
    const g = gate();
    const { rt, $, addRow, saved, offers, save } = settingsRuntime(slowStray(g), []);
    addRow(DOCS + ' ');
    const pending = save();
    rt.closed();
    assert.equal($('settingsSaveBtn').disabled, false, 'a closed sheet holds nothing');
    g.open();
    await pending;
    assert.deepEqual(saved(), [], 'a Save still looking up a folder when the sheet closed saves nothing');
    assert.deepEqual(offers, [], 'and offers nothing');
  }
  {
    const { addRow, saved, timers, save } = settingsRuntime(slowStray(gate()), []);
    addRow(DOCS + ' ');
    const pending = save();
    const waiting = timers.filter((t) => !t.cleared);
    assert.equal(waiting.length, 1, 'the wait is bounded');
    waiting[0].cleared = true;
    waiting[0].fn(); // PATH_LOOKUP_MS pass with no answer
    await pending;
    assert.deepEqual(saved(), [[DOCS + ' ']], 'a lookup that does not answer in time saves the folder exactly as typed — never the one without its space');
  }
  // The wiring the harness stands in for: opening the sheet remembers the
  // folders the server sent, and closing it retires a Save still looking up.
  const opener = braced("$('settingsBtn').addEventListener('click', async () =>");
  assert.match(opener, /settingsData = await api\('\/api\/settings'\);[\s\S]*?\n {2}rememberStoredSchedules\(\);\n {2}renderSchedules\(\);/,
    'opening Settings remembers the stored folders, once they have arrived and before the rows are drawn');
  assert.match(braced('function closeModal('), /if \(id === 'settingsModal'\) \{[^}]*settingsSheetClosed\(\);/,
    'and every way of closing it retires a Save still looking up a folder');
});
