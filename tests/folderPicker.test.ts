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

/** A listing that answers only when the test says so — a sleeping NAS or external drive. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => { open = resolve; });
  return { opened, open };
}

type FakeEl = {
  id: string; value: string; textContent: string; innerHTML: string; disabled: boolean;
  title: string; scrollLeft: number; readonly scrollWidth: number;
  classList: { add(c: string): void; remove(c: string): void };
  listeners: Record<string, (e?: unknown) => unknown>;
  addEventListener(type: string, fn: (e?: unknown) => unknown): void;
  querySelectorAll(sel: string): FakeEl[];
};

function fakeEl(id: string): FakeEl {
  const el: FakeEl = {
    id, value: '', textContent: '', innerHTML: '', disabled: false,
    title: '', scrollLeft: 0,
    // A laid-out text field's content is as wide as its text (7 px a character here).
    get scrollWidth() { return el.value.length * 7; },
    classList: { add() {}, remove() {} },
    listeners: {},
    addEventListener(type, fn) { el.listeners[type] = fn; },
    querySelectorAll: () => [],
  };
  return el;
}

function browseRuntime(listing: (p: string) => unknown | Promise<unknown>) {
  const els = new Map<string, FakeEl>();
  const $ = (id: string) => { if (!els.has(id)) els.set(id, fakeEl(id)); return els.get(id)!; };
  const asked: string[] = [];
  const scanned: string[] = [];
  const toasts: string[] = [];
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
    '$', 'api', 'toast', 'escapeHtml', 'startScan',
    `'use strict';
     const state = { system: { homeDir: '/home/u', commonDirs: [] } };
     function icon() { return ''; }
     ${INDEX.slice(start, end)}
     ${closeModal}
     return { openBrowse, browseTo, path: () => browsePath, close: () => closeModal('browseModal') };`,
  )($, api, (m: string) => { toasts.push(m); }, escapeHtml, (p: string) => { scanned.push(p); }) as {
    openBrowse: (start: string | null, onPick?: (p: string) => void) => Promise<void>;
    browseTo: (p: string) => Promise<boolean>;
    path: () => string | null;
    /** The picker dismissed — Escape, the ✕ or the scrim. */
    close: () => void;
  };
  /** The folder names the list shows, top to bottom (the ".." row aside). */
  const rows = () => [...$('browseList').innerHTML.matchAll(/aria-label="Open ([^"]+)"/g)].map((m) => m[1]);
  /** A click on "Scan this folder" (or "Use this folder" when a pick is pending). */
  const use = () => $('browseUseBtn').listeners.click() as Promise<void>;
  return { rt, $, asked, scanned, toasts, rows, use };
}

const HOME = { path: '/home/u', parent: '/home', dirs: ['.agents', '.antigravity', 'Desktop', '.cache', 'Documents', 'Downloads'].map(dir) };

/* ══════════════ Ordering ══════════════ */

test('ordinary folders are listed first and dot-folders after them, each keeping the server\'s order (D05)', async () => {
  const { rt, rows } = browseRuntime(() => HOME);
  await rt.openBrowse(null);
  assert.deepEqual(rows(), ['Desktop', 'Documents', 'Downloads', '.agents', '.antigravity', '.cache']);
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
  $('browseCurrent').value = '/data';
  await use();
  assert.deepEqual(picked, ['/data'], 'a typed path that opens is the one picked');
  await rt.openBrowse('/home/u', onPick);
  await use();
  assert.deepEqual(picked, ['/data', '/home/u'], 'with nothing typed, the folder shown is picked');
  assert.deepEqual(scanned, [], 'a pick never starts a scan');
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
  g2.open();
  await pending;
  assert.deepEqual(second.scanned, [], 'a superseded typed path is not scanned, and neither is the folder that replaced it');
  assert.deepEqual(scanned, []);
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
