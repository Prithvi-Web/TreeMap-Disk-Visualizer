import { test } from 'node:test';
import assert from 'node:assert/strict';
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

type FakeEl = {
  id: string; value: string; textContent: string; innerHTML: string;
  classList: { add(c: string): void; remove(c: string): void };
  listeners: Record<string, (e?: unknown) => unknown>;
  addEventListener(type: string, fn: (e?: unknown) => unknown): void;
  querySelectorAll(sel: string): FakeEl[];
};

function fakeEl(id: string): FakeEl {
  const el: FakeEl = {
    id, value: '', textContent: '', innerHTML: '',
    classList: { add() {}, remove() {} },
    listeners: {},
    addEventListener(type, fn) { el.listeners[type] = fn; },
    querySelectorAll: () => [],
  };
  return el;
}

function browseRuntime(listing: (p: string) => unknown) {
  const els = new Map<string, FakeEl>();
  const $ = (id: string) => { if (!els.has(id)) els.set(id, fakeEl(id)); return els.get(id)!; };
  const asked: string[] = [];
  const scanned: string[] = [];
  const toasts: string[] = [];
  const api = async (url: string) => {
    asked.push(url);
    const p = decodeURIComponent(url.slice(url.indexOf('path=') + 5));
    const answer = listing(p);
    if (answer instanceof Error) throw answer;
    return answer;
  };
  const start = INDEX.indexOf('/* ───────────────────────────── Browse modal ───────────────────────────── */');
  assert.notEqual(start, -1, 'the browse section is in the page');
  const end = INDEX.indexOf('\n});', INDEX.indexOf("$('browseUseBtn').addEventListener('click'", start)) + '\n});'.length;
  const escapeHtml = lift<(s: string) => string>(['escapeHtml'], 'escapeHtml');
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const rt = new Function(
    '$', 'api', 'toast', 'escapeHtml', 'startScan', 'closeModal',
    `'use strict';
     const state = { system: { homeDir: '/home/u', commonDirs: [] } };
     function icon() { return ''; }
     ${INDEX.slice(start, end)}
     return { openBrowse, browseTo, path: () => browsePath };`,
  )($, api, (m: string) => { toasts.push(m); }, escapeHtml, (p: string) => { scanned.push(p); }, () => {}) as {
    openBrowse: (start: string | null) => Promise<void>;
    browseTo: (p: string) => Promise<boolean>;
    path: () => string | null;
  };
  /** The folder names the list shows, top to bottom (the ".." row aside). */
  const rows = () => [...$('browseList').innerHTML.matchAll(/aria-label="Open ([^"]+)"/g)].map((m) => m[1]);
  return { rt, $, asked, scanned, toasts, rows };
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
  $('browseCurrent').value = '  /data/projects ';
  const keydown = $('browseCurrent').listeners.keydown;
  assert.ok(keydown, 'the path field listens for keys');
  let prevented = false;
  await keydown({ key: 'Enter', preventDefault() { prevented = true; } });
  assert.equal(prevented, true, 'Enter is the field\'s own, not the sheet\'s');
  assert.equal(asked[asked.length - 1], '/api/fs/list?path=' + encodeURIComponent('/data/projects'), 'the typed path is listed, trimmed');
  assert.deepEqual(rows(), ['treemap', 'site']);
  assert.equal(rt.path(), '/data/projects');
  const before = asked.length;
  await keydown({ key: 'a', preventDefault() { assert.fail('only Enter is taken'); } });
  assert.equal(asked.length, before, 'other keys just type');
});

test('"Scan this folder" opens a typed path first, and scans it only if it opened (D05)', async () => {
  const { rt, $, scanned, toasts } = browseRuntime((p) => {
    if (p === '/nope') return new Error('No such folder: /nope');
    if (p === '/data') return { path: '/data', parent: '/', dirs: [] };
    return HOME;
  });
  const use = () => $('browseUseBtn').listeners.click();
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

test('the field says it can be typed in (D05)', () => {
  const modal = INDEX.slice(INDEX.indexOf('<div class="modal-backdrop" id="browseModal"'), INDEX.indexOf('<!-- ═══════════ Confirm modal'));
  const field = /<input type="text" id="browseCurrent"[^>]*>/.exec(modal);
  assert.ok(field, 'the current path is a text field');
  assert.match(field![0], /aria-label="[^"]*type a path[^"]*"/i, 'its name says it can be typed in');
  assert.match(modal, /Type a path and press Enter/, 'and the sheet says so in words');
});
