import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-largestFoldersFold-data-');

import { collectLargestFolders } from '../src/services/diskScanner';
import { buildStoreFromTree } from '../src/services/scanStore';
import type { FileNode } from '../src/models/types';
import { lift, INDEX } from './fixtures/liftFrontend';

/**
 * Largest Folders lists distinct space (design pass G15).
 *
 * The Dashboard card listed the API's ten biggest folders as they came, and a
 * folder with one child holds what that child holds: on /Applications the
 * rows were IntelliJ IDEA.app, its Contents and its plugins, all about
 * 4.5 GB, then Chrome's .app, Contents, Frameworks, Framework.framework and
 * Versions, all about 1.5 GB — ten rows, three apps. In the page only, a
 * folder inside a listed folder that holds nearly all of it (95% or more) is
 * folded into the outer row, which keeps the name a person knows (the .app),
 * the row says what it folded, and the list fills with the next distinct
 * folders. /api/large-folders and its order are unchanged: agents read it.
 *
 * The API's answer here is the server's own (collectLargestFolders over a
 * synthetic tree), so the fold is tested against the order the page is
 * really handed — including the tie the walk produces, a folder listed after
 * the one-child folder inside it.
 */

type Folder = { name: string; path: string; size: number; fileCount: number; modifiedAt?: number };
type Row = Folder & { folded: Folder[] };

const T = 1_800_000_000_000;
const file = (dir: string, name: string, size: number): FileNode => ({ name, path: `${dir}/${name}`, type: 'file', extension: name.split('.').pop() ?? '', size, modifiedAt: T, isHidden: false });
const dir = (parent: string, name: string, children: (p: string) => FileNode[]): FileNode => {
  const p = `${parent}/${name}`;
  const kids = children(p);
  return { name, path: p, type: 'dir', size: kids.reduce((a, k) => a + k.size, 0), modifiedAt: T, isHidden: false, children: kids };
};
/** An app whose bytes sit at the bottom of a one-child chain: name.app/Contents/…chain…/payload. */
const chainApp = (parent: string, name: string, chain: string[], bytes: number, extra = 0): FileNode =>
  dir(parent, name, (app) => [dir(app, 'Contents', (c) => {
    const inner = chain.reduceRight<(p: string) => FileNode[]>((below, link) => (p) => [dir(p, link, below)], (p) => [file(p, 'payload.bin', bytes)]);
    return [...inner(c), ...(extra ? [file(c, 'Info.plist', extra)] : [])];
  })]);

const ROOT = '/Applications';
function applications(): FileNode {
  const kids = (p: string): FileNode[] => [
    // 4.5 GB, of which plugins holds 4.4 GB (97.8%): .app, Contents and plugins are one place.
    dir(p, 'IntelliJ IDEA.app', (a) => [dir(a, 'Contents', (c) => [
      dir(c, 'plugins', (pl) => [file(pl, 'all.jar', 4_400_000_000)]),
      file(c, 'lib.jar', 100_000_000),
    ])]),
    // 1.5 GB at the bottom of a five-folder chain.
    chainApp(p, 'Google Chrome.app', ['Frameworks', 'Google Chrome Framework.framework', 'Versions', '130.0'], 1_500_000_000),
    // 3.1 GB in two parts: Developer (2 GB) and SharedFrameworks (1.1 GB) are distinct places inside Xcode.
    dir(p, 'Xcode.app', (a) => [dir(a, 'Contents', (c) => [
      dir(c, 'Developer', (d) => [file(d, 'sdk.bin', 2_000_000_000)]),
      dir(c, 'SharedFrameworks', (s) => [file(s, 'fw.bin', 1_100_000_000)]),
    ])]),
    // Exactly at the line: Resources holds 95% of Docker.app, MacOS 5%.
    dir(p, 'Docker.app', (a) => [dir(a, 'Contents', (c) => [
      dir(c, 'Resources', (r) => [file(r, 'vm.img', 950_000_000)]),
      dir(c, 'MacOS', (m) => [file(m, 'docker', 50_000_000)]),
    ])]),
    // Just under it: Assets holds 94.9% of Blender.app, so it is a place of its own.
    dir(p, 'Blender.app', (a) => [
      dir(a, 'Assets', (r) => [file(r, 'lib.blend', 930_000_000)]),
      file(a, 'blender', 50_000_000),
    ]),
    // A sibling whose name starts with another's: not inside it.
    chainApp(p, 'Slack', ['Bin'], 600_000_000),
    chainApp(p, 'Slack Helper', ['Bin'], 590_000_000),
    // Smaller apps, enough distinct places to fill the list past the folded rows.
    ...Array.from({ length: 8 }, (_, i) => chainApp(p, `Tool ${i}.app`, ['Resources'], 400_000_000 - i * 20_000_000, 1_000_000)),
  ];
  const children = kids(ROOT);
  return { name: 'Applications', path: ROOT, type: 'dir', size: children.reduce((a, k) => a + k.size, 0), modifiedAt: T, isHidden: false, children };
}

/** The API's answer for the card's request: the server's own collector. */
function apiFolders(limit: number): Folder[] {
  return collectLargestFolders(buildStoreFromTree(applications()), limit, 1_000_000) as Folder[];
}

/** The page's fold, lifted when a test first asks (so the control above runs on its own). */
let lifted: ((folders: Folder[]) => Row[]) | null = null;
const bigFolderRows = (folders: Folder[]): Row[] =>
  (lifted ??= lift<(folders: Folder[]) => Row[]>(['tmIsInside', 'BIG_FOLDERS_ROWS', 'BIG_FOLDER_FOLD_SHARE', 'bigFolderRows'], 'bigFolderRows'))(folders);

/** The page's limit for the card's request, read from loadDashboardLists. */
function cardLimit(): number {
  const at = INDEX.indexOf('async function loadDashboardLists(');
  const m = /\/api\/large-folders\?scanId=\$\{scanId\}&limit=(\d+)/.exec(INDEX.slice(at, at + 2000));
  assert.ok(m, 'loadDashboardLists asks /api/large-folders with a limit');
  return Number(m[1]);
}

test('G15 control: the API lists the same space several times, in the order the page is handed', () => {
  const api = apiFolders(10).map((f) => f.path.slice(ROOT.length + 1));
  assert.deepEqual(api.slice(0, 3), ['IntelliJ IDEA.app/Contents', 'IntelliJ IDEA.app', 'IntelliJ IDEA.app/Contents/plugins'],
    'a one-child folder comes BEFORE its parent when they tie, and the chain fills the top three rows');
  const chrome = api.filter((p) => p.startsWith('Google Chrome.app'));
  assert.equal(chrome.length, 4, 'four of the ten are Chrome\'s chain, and the other two of its six did not fit');
});

test('G15: each row is a distinct place — a folder holding 95% or more of a listed folder it lies in is folded into that row', () => {
  const api = apiFolders(cardLimit());
  const rows = bigFolderRows(api);
  const rel = (p: string): string => p.slice(ROOT.length + 1);
  assert.deepEqual(rows.map((r) => rel(r.path)), [
    'IntelliJ IDEA.app', 'Xcode.app', 'Xcode.app/Contents/Developer', 'Google Chrome.app',
    'Xcode.app/Contents/SharedFrameworks', 'Docker.app', 'Blender.app', 'Blender.app/Assets', 'Slack', 'Slack Helper',
  ], 'ten distinct places, biggest first: the outer folder of each chain, the inner one where it is a part rather than nearly all');
  // The defining property, over every pair: no row lies in another row while holding 95% or more of it.
  for (const inner of rows) {
    for (const outer of rows) {
      if (inner === outer || !inner.path.startsWith(outer.path + '/')) continue;
      assert.ok(inner.size < outer.size * 0.95, `${rel(inner.path)} is a row, yet holds ${(100 * inner.size / outer.size).toFixed(1)}% of ${rel(outer.path)}`);
    }
  }
  // And every folded folder lies in its row and holds 95% or more of it — the sentence the row prints.
  for (const r of rows) {
    for (const f of r.folded) {
      assert.ok(f.path.startsWith(r.path + '/'), `${rel(f.path)} lies in ${rel(r.path)}`);
      assert.ok(f.size >= r.size * 0.95, `${rel(f.path)} holds ${(100 * f.size / r.size).toFixed(1)}% of ${rel(r.path)}`);
    }
  }
  const byPath = new Map(rows.map((r) => [rel(r.path), r.folded.map((f) => rel(f.path)).sort()]));
  assert.deepEqual(byPath.get('IntelliJ IDEA.app'), ['IntelliJ IDEA.app/Contents', 'IntelliJ IDEA.app/Contents/plugins'],
    'the .app keeps the row, its Contents and plugins fold into it');
  assert.deepEqual(byPath.get('Google Chrome.app'), [
    'Google Chrome.app/Contents', 'Google Chrome.app/Contents/Frameworks', 'Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework',
    'Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Versions', 'Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Versions/130.0',
  ], 'the whole five-folder chain folds into Google Chrome.app');
  assert.deepEqual(byPath.get('Docker.app'), ['Docker.app/Contents', 'Docker.app/Contents/Resources'], 'exactly 95% folds');
  assert.deepEqual(byPath.get('Blender.app'), [], '94.9% does not: Assets is a row of its own');
  assert.deepEqual(byPath.get('Xcode.app'), ['Xcode.app/Contents'], 'Contents folds; Developer (65%) and SharedFrameworks (35%) are places of their own');
  assert.deepEqual(byPath.get('Slack'), ['Slack/Contents', 'Slack/Contents/Bin'], 'Slack Helper is not inside Slack, whatever its name starts with');
});

test('G15: the card asks for enough of the API\'s list to fill ten distinct rows, and the API answers as before', () => {
  const limit = cardLimit();
  assert.ok(limit > 10, `the card asks for more than the ten it shows (asks ${limit})`);
  assert.equal(bigFolderRows(apiFolders(limit)).length, 10, 'and that is enough here for ten distinct rows');
  assert.ok(bigFolderRows(apiFolders(10)).length < 10, 'control: the API\'s first ten alone hold fewer than ten distinct places');
  // The API is untouched: its order is size, ties as the walk meets them.
  const api = apiFolders(500);
  for (let i = 1; i < api.length; i++) assert.ok(api[i - 1].size >= api[i].size, 'the API answers largest first');
  assert.match(INDEX, /state\.bigFolders = lfo\.folders;/, 'the page keeps the API\'s list as it came; only the card folds');
});

test('G15: a Windows path folds by its own separator, and a name that only starts like another does not', () => {
  const W = 'C:\\Program Files';
  const rows = bigFolderRows([
    { name: 'App', path: `${W}\\App`, size: 1000, fileCount: 2 },
    { name: 'bin', path: `${W}\\App\\bin`, size: 990, fileCount: 1 },
    { name: 'App Data', path: `${W}\\App Data`, size: 980, fileCount: 1 },
  ]);
  assert.deepEqual(rows.map((r) => [r.name, r.folded.map((f) => f.name)]), [['App', ['bin']], ['App Data', []]]);
});

/* ── The card says what it folded ─────────────────────────────────────────── */

function renderCard(folders: Folder[]): { html: string } {
  const host = { innerHTML: '', querySelectorAll: () => [] as unknown[] };
  const start = INDEX.indexOf('function renderBigFolders(');
  let depth = 0, end = -1;
  for (let i = INDEX.indexOf('{', start); i < INDEX.length; i++) {
    if (INDEX[i] === '{') depth++;
    else if (INDEX[i] === '}' && --depth === 0) { end = i + 1; break; }
  }
  const deps: Record<string, unknown> = {
    $: () => host, state: { bigFolders: folders }, bigFolderRows,
    escapeHtml: (s: string) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'),
    chipFor: () => '', formatCount: (n: number) => n.toLocaleString('en-US'), fxBarStyle: () => '', sizeInk: () => '#000',
    formatBytes: (n: number) => `${(n / 1e9).toFixed(1)} GB`, fxBarsIn() {},
  };
  const keys = Object.keys(deps);
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  (new Function(...keys, `'use strict'; ${INDEX.slice(start, end)}\nreturn renderBigFolders;`)(...keys.map((k) => deps[k])) as () => void)();
  return { html: host.innerHTML };
}

test('G15: a row that folded folders in names them, and its tooltip gives each one\'s path and size', () => {
  const { html } = renderCard(apiFolders(cardLimit()));
  const rows = html.split('<div class="bigfile"').slice(1);
  assert.equal(rows.length, 10, 'ten rows');
  const intellij = rows.find((r) => r.includes('data-jump="/Applications/IntelliJ IDEA.app"')) as string;
  assert.ok(intellij, 'IntelliJ IDEA.app has a row');
  assert.match(intellij, /Also covers Contents and plugins inside it, which each hold nearly all of its size/, 'says what it folded, in words');
  assert.match(intellij, /title="Inside it, not listed again:\n\/Applications\/IntelliJ IDEA\.app\/Contents — 4\.5 GB\n\/Applications\/IntelliJ IDEA\.app\/Contents\/plugins — 4\.4 GB"/,
    'and the tooltip gives each folded folder\'s path and size, outermost first');
  const docker = rows.find((r) => r.includes('data-jump="/Applications/Docker.app"')) as string;
  assert.match(docker, /Also covers Contents and Resources inside it/);
  const blender = rows.find((r) => r.includes('data-jump="/Applications/Blender.app"')) as string;
  assert.doesNotMatch(blender, /Also covers/, 'a row that folded nothing says nothing');
  const xcode = rows.find((r) => r.includes('data-jump="/Applications/Xcode.app"')) as string;
  assert.match(xcode, /Also covers Contents inside it, which holds nearly all of its size/, 'one folded folder, said in the singular');
  // The bars compare the rows shown: the first row is the full bar.
  assert.match(rows[0], /<span class="fx-li-pct num">100%<\/span>/);
  assert.doesNotMatch(html, /data-jump="\/Applications\/IntelliJ IDEA\.app\/Contents"/, 'Contents has no row of its own');
});
