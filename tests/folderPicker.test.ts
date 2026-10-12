import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { INDEX, lift } from './fixtures/liftFrontend';

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
  id: string; value: string; textContent: string; innerHTML: string; disabled: boolean;
  title: string; scrollLeft: number; scrollTop: number; readonly scrollWidth: number;
  classList: { add(c: string): void; remove(c: string): void; toggle(c: string, on?: boolean): void };
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
    id, value: '', textContent: '', innerHTML: '', disabled: false,
    title: '', scrollLeft: 0, scrollTop: 0,
    // A laid-out text field's content is as wide as its text (7 px a character here).
    get scrollWidth() { return el.value.length * 7; },
    classList: { add() {}, remove() {}, toggle() {} },
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

function browseRuntime(listing: (p: string) => unknown | Promise<unknown>, doc: { activeElement: unknown } = { activeElement: null }) {
  const els = new Map<string, FakeEl>();
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
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const rt = new Function(
    '$', 'api', 'toast', 'toastAction', 'escapeHtml', 'startScan', 'formatCount', 'document',
    `'use strict';
     const state = { system: { homeDir: '/home/u', commonDirs: [] } };
     function icon() { return ''; }
     ${INDEX.slice(start, end)}
     ${closeModal}
     return { openBrowse, browseTo, path: () => browsePath, close: () => closeModal('browseModal') };`,
  )($, api, (m: string) => { toasts.push(m); }, offerRecorder(offers), escapeHtml, (p: string) => { scanned.push(p); }, (n: number) => n.toLocaleString('en-US'), doc) as {
    openBrowse: (start: string | null, onPick?: ((p: string) => void) | null, title?: string | null, useLabel?: string | null) => Promise<void>;
    browseTo: (p: string) => Promise<boolean>;
    path: () => string | null;
    /** The picker dismissed — Escape, the ✕ or the scrim. */
    close: () => void;
  };
  /** The folder names the list shows, top to bottom (the ".." row aside). */
  const rows = () => [...$('browseList').innerHTML.matchAll(/aria-label="Open ([^"]+)"/g)].map((m) => m[1]);
  /** A click on "Scan this folder" (or "Use this folder" when a pick is pending). */
  const use = () => $('browseUseBtn').listeners.click() as Promise<void>;
  return { rt, $, asked, scanned, toasts, offers, rows, use };
}

const HOME = { path: '/home/u', parent: '/home', dirs: ['.agents', '.antigravity', 'Desktop', '.cache', 'Documents', 'Downloads'].map(dir) };

/* ══════════════ Ordering ══════════════ */

test('ordinary folders are listed first and dot-folders after them, each keeping the server\'s order (D05)', async () => {
  const { rt, rows } = browseRuntime(() => HOME);
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
  const { rt, $, rows } = browseRuntime((p) => listings[p] ?? HOME);
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

  // The real "Offload…" entry: its pick copies, verifies and trashes the originals.
  const opened: unknown[][] = [];
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const flow = new Function('state', 'toast', 'hideCtxMenu', 'openBrowse', 'runOffloadJob',
    `'use strict'; ${braced('function startOffloadFlow(')} return startOffloadFlow;`,
  )({ scanId: 's1', root: { path: '/home/u' } }, () => {}, () => {}, (...a: unknown[]) => { opened.push(a); }, () => {}) as (paths: string[]) => void;
  flow(['/home/u/a.mov']);
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

/**
 * The picker, the Scan card (its Scan button, path box and Fast rescan box)
 * and the Autopilot policy editor, evaluated together from the built page:
 * the picker fills a box, and the box is read again by everything else.
 */
function boxesRuntime(listing: (p: string) => unknown) {
  const els = new Map<string, BoxEl>();
  const $ = (id: string) => {
    if (!els.has(id)) {
      const el = fakeEl(id) as BoxEl;
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
    if (url !== '/api/autopilot/simulate') return {};
    // The server scans the policy's folder to preview it: a folder that is not
    // there answers as its listing does — 404 PATH_NOT_FOUND (simulatePolicy → startScan).
    const there = await listing(body.policy.path);
    if (there instanceof Error) throw there;
    return { items: [], bytesWouldDelete: 0, capBytes: null, wouldBlockReason: null, skipped: [] };
  };
  const stored = new Map<string, string>();
  const localStorage = { getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => { stored.set(k, v); } };
  const document = {
    querySelector: (sel: string) => (sel === '#apMatchSeg button[aria-selected="true"]' ? { dataset: { apmatch: 'custom' } } : null),
    querySelectorAll: () => [],
  };
  const browse = between('/* ───────────────────────────── Browse modal ───────────────────────────── */',
    "$('browseUseBtn').addEventListener('click'") + between("$('browseUseBtn').addEventListener('click'", '\n});\n') + '\n});\n';
  const src = [
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
    'setTimeout', 'clearTimeout',
    `'use strict';
     const state = { scanning: false, system: { homeDir: '/home/u', commonDirs: [] }, autopilot: { policies: [] } };
     const GB = 1024 * 1024 * 1024;
     let apDraft = null;
     function icon() { return ''; }
     ${src}
     return { openBrowse, browseTo, path: () => browsePath, rememberScannedRoot, openPolicyEditor,
       close: (id) => closeModal(id), scanning: (on) => { state.scanning = on; } };`,
  )($, api, (m: string) => { toasts.push(m); }, offerRecorder(offers), escapeHtml,
    (p: string, o: { incremental?: boolean }) => { scanned.push([p, o]); }, noop,
    localStorage, document, noop, noop, String, String, noop, noop, noop, noop, setTimeout, clearTimeout) as {
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
  };
  /** A click on a button whose handler may be async; resolves when it has run. */
  const click = (id: string) => Promise.resolve($(id).listeners.click());
  /** A person typing or pasting into a box: its value, then its input event. */
  const type = (id: string, text: string) => { $(id).value = text; void $(id).listeners.input?.(); };
  const policy = (url: string) => sent.filter((s) => s.url === url).at(-1)!.body;
  /** The folders of every policy list saved, one list per save. */
  const saved = () => sent.filter((s) => s.url === '/api/autopilot/policies').map((s) => s.body.policies!.map((p) => p.path));
  /** How many times the policy list was saved. */
  const saves = () => saved().length;
  return { rt, $, asked, scanned, toasts, offers, click, type, policy, saved, saves, timers, fire };
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

type ToastBtn = { label: string; attrs: Record<string, string>; listeners: Array<() => void>; addEventListener(t: string, f: () => void): void; click(): void; focus(): void };
type ToastEl = { cls: Set<string>; html: string; innerHTML: string; button: ToastBtn | null; removed: boolean; className: string;
  classList: { add(c: string): void; contains(c: string): boolean }; querySelector(sel: string): ToastBtn | null; contains(x: unknown): boolean; remove(): void };

/**
 * The page's toastAction, evaluated with a fake document on a clock the test
 * steps (fire): what it put on screen, its button, and where focus is.
 */
function toastRuntime() {
  const doc = { activeElement: null as unknown, createElement: () => toastEl() };
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
          label: b[2], attrs, listeners: [],
          addEventListener(t, f) { if (t === 'click') btn.listeners.push(f); },
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
  const host = { appendChild(el: ToastEl) { shown.push(el); } };
  const $ = (id: string) => { assert.equal(id, 'toasts', 'a toast goes in #toasts'); return host; };
  const escapeHtml = lift<(s: string) => string>(['escapeHtml'], 'escapeHtml');
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  // The counter that names each toast's message for its button, where the page has one.
  const seqDecl = INDEX.includes('let toastActionSeq = 0;') ? 'let toastActionSeq = 0;' : '';
  // The offers each sheet made, and what retires them as it closes, where the page has them.
  const retire = INDEX.includes('const sheetToasts = new Map();')
    ? `const sheetToasts = new Map(); ${braced('function toastsRetire(')}` : 'const toastsRetire = undefined;';
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const made = new Function('document', '$', 'icon', 'escapeHtml', 'setTimeout',
    `'use strict'; ${seqDecl} ${retire} ${braced('function toastAction(')} return { toastAction, toastsRetire };`,
  )(doc, $, () => '<svg></svg>', escapeHtml, setTimeout) as {
    toastAction: (msg: string, label: string, fn: () => unknown, kind?: string, ms?: number, opts?: { focus?: boolean; sheet?: string }) => void;
    /** A sheet closing (modalClosed): the offers made in it go. */
    toastsRetire: ((sheet: string) => void) | undefined;
  };
  return { toastAction: made.toastAction, toastsRetire: made.toastsRetire, doc, shown, timers, fire };
}

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
  const inSheet = { id: 'save' };
  const inToast = { id: 'offer' };
  const onPage = { id: 'map' };
  const sheet = { contains: (x: unknown) => x === inSheet };
  const toasts = { contains: (x: unknown) => x === inToast };
  const pulled: unknown[] = [];
  const heard: { focusin?: (e: { target: unknown }) => void } = {};
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function('document', '$', 'noteFocus', 'topModal', 'modalFocusInto', `'use strict'; ${guard}`)(
    { addEventListener: (t: string, f: (e: { target: unknown }) => void) => { if (t === 'focusin') heard.focusin = f; } },
    (id: string) => { assert.equal(id, 'toasts'); return toasts; },
    () => {}, () => sheet, (s: unknown) => { pulled.push(s); });
  assert.ok(heard.focusin, 'control: the guard listens for focusin');
  heard.focusin!({ target: onPage });
  assert.deepEqual(pulled, [sheet], 'control: focus that lands on the page under a sheet is pulled back into it');
  heard.focusin!({ target: inToast });
  assert.deepEqual(pulled, [sheet], 'focus on an offer\'s button stays there');
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
