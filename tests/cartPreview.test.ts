import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync } from 'node:fs';

import { isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-cartPreview-data-');

import { squarify } from '../src/utils/treemap';

const INDEX = readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

/**
 * Phase 4 §4.3 — the simulated "after".
 *
 * §4.3 requires the preview to be a **pure client-side re-layout**, and the
 * only squarified layout in this project lives on the server. So the frontend
 * now carries a port of it, and a port is a promise that decays.
 *
 * These tests keep it honest the only way that works for a single HTML file
 * with no build step: pull the functions out of `public/index.html`, evaluate
 * them, and drive them beside the real implementation over the same corpus.
 * If either side is edited without the other, the rectangles stop matching and
 * this fails — which is precisely what `tests/indexSearch.test.ts` does for the
 * query box, for the same reason.
 */

/** Lift named function declarations out of the app script and evaluate them. */
function lift<T>(names: string[], returns: string): T {
  return new Function(`${declsOf(names)}\nreturn ${returns};`)() as T;
}

/** The source of named function declarations in the app script, in the order named. */
function declsOf(names: string[]): string {
  const parts: string[] = [];
  for (const name of names) {
    const at = INDEX.indexOf(`function ${name}(`);
    assert.notEqual(at, -1, `function ${name} was located in public/index.html`);
    // An async function is lifted with its `async`, or its awaits would not parse.
    const start = INDEX.startsWith('async ', at - 6) ? at - 6 : at;
    // Balanced-brace scan from the declaration's opening brace. Crude, and
    // sufficient: these functions contain no braces inside strings.
    const open = INDEX.indexOf('{', start);
    let depth = 0;
    let end = open;
    for (let i = open; i < INDEX.length; i++) {
      if (INDEX[i] === '{') depth++;
      else if (INDEX[i] === '}') {
        depth--;
        if (depth === 0) { end = i + 1; break; }
      }
    }
    assert.ok(end > open, `function ${name} has a balanced body`);
    parts.push(INDEX.slice(start, end));
  }
  return parts.join('\n');
}

type Rect = { x: number; y: number; w: number; h: number };
const tmSquarify = lift<(areas: number[], rect: Rect) => Rect[]>(
  ['tmWorstRatio', 'tmSquarify'],
  'tmSquarify',
);

const tmIsInside = lift<(p: string, dir: string) => boolean>(['tmIsInside'], 'tmIsInside');
const tmParentPath = lift<(p: string) => string>(['tmParentPath'], 'tmParentPath');

/* ══════════════ the port agrees with the server, rectangle for rectangle ══════════════ */

test('the frontend squarify produces byte-identical rectangles to the server one', () => {
  const rects: Rect[] = [
    { x: 0, y: 0, w: 100, h: 100 },
    { x: 0, y: 0, w: 100, h: 40 },   // wide
    { x: 0, y: 0, w: 25, h: 100 },   // tall
    { x: 12.5, y: 7.25, w: 33.75, h: 19.5 }, // an interior rect, as recursion produces
    { x: 0, y: 0, w: 1, h: 1 },      // the smallest thing that still lays out
  ];
  const corpora: number[][] = [
    [50, 30, 20],
    [100],
    [1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
    [900, 90, 9, 0.9, 0.09],                 // five orders of magnitude
    [6, 6, 4, 3, 2, 2, 1],                   // the paper's own worked example
    Array.from({ length: 200 }, (_, i) => 200 - i),
    Array.from({ length: 64 }, () => 1.5625), // 64 equal children
  ];

  for (const rect of rects) {
    for (const areas of corpora) {
      // Both sides take areas already scaled to the rect, exactly as
      // buildTreemap and tmBuildPreview both do before calling.
      const total = areas.reduce((a, b) => a + b, 0);
      const scaled = areas.map((a) => (a / total) * rect.w * rect.h);
      const mine = tmSquarify(scaled, rect);
      const theirs = squarify(scaled, rect);
      assert.equal(mine.length, theirs.length);
      for (let i = 0; i < mine.length; i++) {
        for (const k of ['x', 'y', 'w', 'h'] as const) {
          assert.equal(
            mine[i][k], theirs[i][k],
            `rect ${JSON.stringify(rect)} corpus ${areas.length} item ${i}.${k}`,
          );
        }
      }
    }
  }
});

test('the port handles the degenerate inputs the real one does, the same way', () => {
  const rect = { x: 0, y: 0, w: 100, h: 100 };
  for (const areas of [[], [0], [0, 0, 0], [10000, 0]]) {
    assert.deepEqual(tmSquarify(areas, rect), squarify(areas, rect));
  }
});

test('every rectangle stays inside the one it was laid into, and they tile it', () => {
  const rect = { x: 5, y: 9, w: 60, h: 35 };
  const areas = [40, 25, 15, 10, 6, 4].map((a) => (a / 100) * rect.w * rect.h);
  const out = tmSquarify(areas, rect);
  let covered = 0;
  for (const r of out) {
    assert.ok(r.x >= rect.x - 1e-9 && r.y >= rect.y - 1e-9, 'no rectangle starts outside');
    assert.ok(r.x + r.w <= rect.x + rect.w + 1e-9, 'no rectangle runs off the right');
    assert.ok(r.y + r.h <= rect.y + rect.h + 1e-9, 'no rectangle runs off the bottom');
    assert.ok(Number.isFinite(r.w) && Number.isFinite(r.h), 'no NaN geometry');
    covered += r.w * r.h;
  }
  assert.ok(Math.abs(covered - rect.w * rect.h) < 1e-6, 'the children exactly tile the parent');
});

/* ══════════════ the path helpers the attribution depends on ══════════════ */

test('containment is separator-aware and cannot be fooled by a shared prefix', () => {
  assert.equal(tmIsInside('/a/b/c.txt', '/a/b'), true);
  assert.equal(tmIsInside('/a/b', '/a/b'), false, 'a path is not inside itself');
  // The trap that would double-count: /a/bb is NOT inside /a/b.
  assert.equal(tmIsInside('/a/bb/c.txt', '/a/b'), false);
  assert.equal(tmIsInside('/a/b.txt.download', '/a/b.txt'), false);
  assert.equal(tmIsInside('/a/b/c', ''), false);
  // Windows shapes, since a scan of a Windows disk uses backslashes throughout.
  assert.equal(tmIsInside('C:\\Users\\me\\x.txt', 'C:\\Users\\me'), true);
  assert.equal(tmIsInside('C:\\Users\\meme\\x.txt', 'C:\\Users\\me'), false);
  // A root that already ends in its separator must not need two.
  assert.equal(tmIsInside('/a', '/'), true);
});

test('the parent of a path is its directory, in either separator', () => {
  assert.equal(tmParentPath('/a/b/c.txt'), '/a/b');
  assert.equal(tmParentPath('C:\\a\\b\\c.txt'), 'C:\\a\\b');
  assert.equal(tmParentPath('nosep'), '');
  // The whole-disk case, and the reason this needed its own test: a scan
  // rooted at "/" draws /Users, /System and friends, and their parent has to
  // be "/" — the node the layout actually starts from. Reporting "" instead
  // matches nothing, and the preview quietly finds no children at all.
  assert.equal(tmParentPath('/Users'), '/');
  assert.equal(tmParentPath('/a'), '/');
  assert.equal(tmParentPath('C:\\Users'), 'C:\\');
});

test('on macOS and Linux a backslash is a character of a folder’s name, never a separator: a tree with a folder named "a\\b" nests as the disk does (POL item 7)', () => {
  // "\" is a legal byte in a POSIX name. Read as a separator — because the
  // folder's own name has one — "/data/a\b/c.txt" fell outside "/data/a\b",
  // and its sibling FILE "/data/a\b\c.txt" fell inside it.
  const tmStepToward = lift<(root: string, p: string) => string | null>(['tmStepToward', 'tmIsInside'], 'tmStepToward');
  const dir = '/data/a\\b';
  assert.deepEqual({
    'a file in the folder is inside it': tmIsInside('/data/a\\b/c.txt', dir),
    'a file beside it, named "a\\b\\c.txt", is not': tmIsInside('/data/a\\b\\c.txt', dir),
    'nor is the folder’s file inside "/data/a"': tmIsInside('/data/a\\b/c.txt', '/data/a'),
    'the folder’s parent': tmParentPath(dir),
    'its file’s parent': tmParentPath('/data/a\\b/c.txt'),
    'the parent of "x\\y" at the root': tmParentPath('/x\\y'),
    'a click inside it opens the folder one level down': tmStepToward(dir, '/data/a\\b/sub/f.txt'),
    'a click from above it opens the folder itself': tmStepToward('/data', '/data/a\\b/sub/f.txt'),
    'a sibling is no step from it': tmStepToward(dir, '/data/a\\b\\sub'),
  }, {
    'a file in the folder is inside it': true,
    'a file beside it, named "a\\b\\c.txt", is not': false,
    'nor is the folder’s file inside "/data/a"': false,
    'the folder’s parent': '/data',
    'its file’s parent': dir,
    'the parent of "x\\y" at the root': '/',
    'a click inside it opens the folder one level down': '/data/a\\b/sub',
    'a click from above it opens the folder itself': dir,
    'a sibling is no step from it': null,
  });
  // Windows paths read as before — a backslash is the separator in a drive's
  // path and a share's — and a cloud identifier is spelled with "/" whatever
  // its names hold.
  assert.deepEqual({
    'drive: inside': tmIsInside('C:\\a\\b\\c.txt', 'C:\\a\\b'),
    'drive: a longer sibling is not inside': tmIsInside('C:\\a\\bb\\c.txt', 'C:\\a\\b'),
    'share: inside': tmIsInside('\\\\srv\\share\\x', '\\\\srv\\share'),
    'a drive root ends in its separator': tmIsInside('C:\\x', 'C:\\'),
    'share: parent': tmParentPath('\\\\srv\\share\\x'),
    'drive: one level down': tmStepToward('C:\\a', 'C:\\a\\b\\c.txt'),
    'share: one level down': tmStepToward('\\\\srv\\share', '\\\\srv\\share\\b\\c.txt'),
    'cloud: inside': tmIsInside('cloud://gdrive/a\\b/c', 'cloud://gdrive/a\\b'),
  }, {
    'drive: inside': true,
    'drive: a longer sibling is not inside': false,
    'share: inside': true,
    'a drive root ends in its separator': true,
    // A share's root folder keeps its separator, as a drive's does: Windows spells it so (path.win32.dirname),
    // and a scan of the share is rooted there (POL item 7 review, F2.7).
    'share: parent': '\\\\srv\\share\\',
    'drive: one level down': 'C:\\a\\b',
    'share: one level down': '\\\\srv\\share\\b',
    'cloud: inside': true,
  });
});

test('on macOS and Linux a backslash in a folder’s name is part of the name everywhere the page splits a path — the breadcrumbs and Up, Live mode’s sizes and pulses, the drive behind a folder, the restore sentence — while Windows paths read as before (POL item 7 review, F1.2)', () => {
  // Item 7 fixed tmIsInside, tmParentPath and tmStepToward; these guessed "\" too, whenever the root's
  // path held one. With root "/data/a\b/proj", "/x/y" below it was one crumb named "/x/y", so Up from
  // two levels down jumped to the root; and a write inside "/data/a\b" also grew its sibling "/data/a".
  type Crumb = { name: string; path: string };
  const crumbs = (root: { name: string; path: string }, p: string): Crumb[] =>
    (new Function('state', `${declsOf(['breadcrumbsFor'])}\nreturn breadcrumbsFor;`)({ root }) as (q: string) => Crumb[])(p);
  const posixRoot = { name: 'proj', path: '/data/a\\b/proj' };
  const deep = crumbs(posixRoot, '/data/a\\b/proj/x/y');
  assert.deepEqual({
    crumbs: deep.map((c) => `${c.name} ${c.path}`),
    up: deep[deep.length - 2]?.path, // treemapUp, kbUp, Escape and the sunburst's centre climb to this one
    nameWithBackslash: crumbs(posixRoot, '/data/a\\b/proj/c\\d/e').map((c) => c.name),
    atTheRoot: crumbs({ name: '/', path: '/' }, '/a\\b/c').map((c) => `${c.name} ${c.path}`),
    windows: crumbs({ name: 'me', path: 'C:\\Users\\me' }, 'C:\\Users\\me\\x\\y').map((c) => `${c.name} ${c.path}`),
    windowsDrive: crumbs({ name: 'C:\\', path: 'C:\\' }, 'C:\\x').map((c) => `${c.name} ${c.path}`),
    share: crumbs({ name: 'share', path: '\\\\srv\\share' }, '\\\\srv\\share\\x').map((c) => c.path),
  }, {
    crumbs: ['proj /data/a\\b/proj', 'x /data/a\\b/proj/x', 'y /data/a\\b/proj/x/y'],
    up: '/data/a\\b/proj/x',
    nameWithBackslash: ['proj', 'c\\d', 'e'],
    atTheRoot: ['/ /', 'a\\b /a\\b', 'c /a\\b/c'],
    windows: ['me C:\\Users\\me', 'x C:\\Users\\me\\x', 'y C:\\Users\\me\\x\\y'],
    windowsDrive: ['C:\\ C:\\', 'x C:\\x'],
    share: ['\\\\srv\\share', '\\\\srv\\share\\x'],
  });

  // Live mode: a change's bytes go to every folder above it, and its pulse to the nearest one drawn.
  type Node = { type: string; size: number };
  const live = (root: string, nodes: Record<string, Node>, ev: Record<string, unknown>): Record<string, number> => {
    const pathIndex = new Map(Object.entries(nodes));
    (new Function('state', `${declsOf(['applyLiveDelta', 'tmParentPath'])}\nreturn applyLiveDelta;`)({ root: { path: root }, pathIndex }) as (e: unknown) => void)(ev);
    return Object.fromEntries([...pathIndex].map(([p, n]) => [p, n.size]));
  };
  const liveRegionFor = lift<(p: string, byPath: Map<string, string>) => string | null>(['liveRegionFor', 'tmParentPath'], 'liveRegionFor');
  assert.deepEqual({
    posix: live('/data', {
      '/data': { type: 'dir', size: 100 }, '/data/a': { type: 'dir', size: 10 },
      '/data/a\\b': { type: 'dir', size: 20 }, '/data/a\\b/f': { type: 'file', size: 5 },
    }, { path: '/data/a\\b/f', kind: 'modified', size: 15, delta: 10 }),
    windows: live('C:\\d', {
      'C:\\d': { type: 'dir', size: 100 }, 'C:\\d\\a': { type: 'dir', size: 10 }, 'C:\\d\\a\\f': { type: 'file', size: 5 },
    }, { path: 'C:\\d\\a\\f', kind: 'modified', size: 10, delta: 5 }),
    pulse: liveRegionFor('/data/a\\b/f', new Map([['/data', 'D'], ['/data/a', 'A']])),
    pulseInside: liveRegionFor('/data/a\\b/f', new Map([['/data/a\\b', 'AB'], ['/data/a', 'A']])),
    pulseWindows: liveRegionFor('C:\\d\\a\\f', new Map([['C:\\d', 'D']])),
  }, {
    posix: { '/data': 110, '/data/a': 10, '/data/a\\b': 30, '/data/a\\b/f': 15 }, // "/data/a" is a sibling: untouched
    windows: { 'C:\\d': 105, 'C:\\d\\a': 15, 'C:\\d\\a\\f': 10 },
    pulse: 'D',
    pulseInside: 'AB',
    pulseWindows: 'D',
  });

  // The drive behind a folder: a mount point is a folder boundary, "\" a separator only on Windows.
  const smartDeviceFor = lift<(topo: unknown, p: string) => string | null>(['smartDeviceFor'], 'smartDeviceFor');
  const topo = { logicalVolumes: [{ mountPoint: '/', physicalDiskIds: ['disk0'] }, { mountPoint: '/Volumes/a\\b', physicalDiskIds: ['disk4'] }], physicalDisks: [{ id: 'disk0' }, { id: 'disk4' }] };
  const winTopo = { logicalVolumes: [{ mountPoint: 'C:\\', physicalDiskIds: ['/dev/w0'] }, { mountPoint: 'D:\\Data', physicalDiskIds: ['/dev/w1'] }], physicalDisks: [{ id: 'a' }, { id: 'b' }] };
  assert.deepEqual({
    inside: smartDeviceFor(topo, '/Volumes/a\\b/x'),
    sibling: smartDeviceFor(topo, '/Volumes/a\\b\\x'), // a folder of /Volumes named "a\b\x", on the boot disk
    windows: smartDeviceFor(winTopo, 'D:\\Data\\x'),
    windowsLonger: smartDeviceFor(winTopo, 'D:\\Database\\x'),
  }, { inside: '/dev/disk4', sibling: '/dev/disk0', windows: '/dev/w1', windowsLonger: null });

  // The restore panel's sentence names the folder the copy would go into.
  const snapFolderRefusedText = lift<(p: string) => string>(['snapFolderRefusedText', 'tmParentPath'], 'snapFolderRefusedText');
  assert.deepEqual({
    posix: /beside the original, in ([^,]*),/.exec(snapFolderRefusedText('/data/a\\b/f\\g.txt'))?.[1], // the file "f\g.txt"
    windows: /beside the original, in ([^,]*),/.exec(snapFolderRefusedText('C:\\x\\f.txt'))?.[1],
  }, { posix: '/data/a\\b', windows: 'C:\\x' });
});

test('the journal’s “Show on treemap” and a global-search hit ask whether a path is in the scan on screen by folder boundary — a whole drive’s scan ("/", "C:\\") holds every path on it, "/Users/me/Projects-old" is not in "/Users/me/Projects", and on macOS and Linux neither is the folder "a\\b" in "/data/a" (POL item 7 review, F2.1 and F2.9)', async () => {
  // journalOpen tried root + "/" and root + "\": "\" was a separator on every system, and a root that
  // ends in its separator never matched — every journal row of a whole-disk scan said "Scan / first".
  const journal = (root: string | null, entryPath: string): string => {
    const log: string[] = [];
    const state = { root: root === null ? null : { path: root }, pathIndex: new Map([[entryPath, { type: 'dir' }]]), treemap: { rootPath: root } };
    const open = new Function('state', '$', 'switchView', 'toast', 'tmApplyQuery',
      `let tmQueryDeb = 0;\n${declsOf(['journalOpen', 'tmIsInside'])}\nreturn journalOpen;`)(
      state, () => ({ value: '' }), (view: string) => log.push(`view ${view}`), () => log.push('toast'), () => undefined,
    ) as (entry: { at: number; path: string; rootPath: string }) => void;
    open({ at: 0, path: entryPath, rootPath: '/the/scan/it/is/in' });
    if (log.includes('toast')) return `scan it first (${log.join(', ')})`;
    return `shown at ${state.treemap.rootPath} (${log.join(', ')})`;
  };
  assert.deepEqual({
    sibling: journal('/data/a', '/data/a\\b/f'),
    wholeDisk: journal('/', '/Users/x/f'),
    wholeDrive: journal('C:\\', 'C:\\Users\\x\\f'),
    inside: journal('/data/a', '/data/a/b'),
    theRootItself: journal('/data/a', '/data/a'),
    longerSibling: journal('/data/a', '/data/ab/f'),
    windows: journal('C:\\d', 'C:\\d\\x'),
    share: journal('\\\\srv\\share', '\\\\srv\\share\\x'),
    noScan: journal(null, '/x'),
  }, {
    sibling: 'scan it first (view dashboard, toast)',
    wholeDisk: 'shown at /Users/x/f (view treemap)',
    wholeDrive: 'shown at C:\\Users\\x\\f (view treemap)',
    inside: 'shown at /data/a/b (view treemap)',
    theRootItself: 'shown at /data/a (view treemap)',
    longerSibling: 'scan it first (view dashboard, toast)',
    windows: 'shown at C:\\d\\x (view treemap)',
    share: 'shown at \\\\srv\\share\\x (view treemap)',
    noScan: 'scan it first (view dashboard, toast)',
  });

  // gsearchGoTo asked folder.startsWith(root): a hit in "/Users/me/Projects-old" was drilled into inside
  // "/Users/me/Projects", the server refused it 403, and the map was left rooted at a folder outside the scan.
  type Hit = { path: string; type: string; parentPath: string; rootPath: string; name: string };
  const goToFor = (state: unknown, hit: Hit, seams: Record<string, unknown>) => new Function(
    'state', '$', 'gsearch', 'gsearchClose', 'toast', 'startScan', 'switchView', 'loadTreemap', 'tmApplyQuery',
    `${declsOf(['gsearchGoTo', 'tmIsInside'])}\nreturn gsearchGoTo;`,
  )(state, () => ({ value: '', blur: () => undefined }), { hits: [hit] }, () => undefined,
    seams.toast, seams.startScan, seams.switchView, seams.loadTreemap, () => undefined) as (p: string) => Promise<void>;
  const search = async (root: string | null, hit: Hit): Promise<{ log: string[]; mapRoot: string | null }> => {
    const log: string[] = [];
    const state = { root: root === null ? null : { path: root }, treemap: { rootPath: root } };
    await goToFor(state, hit, {
      toast: () => log.push('toast'),
      startScan: async (p: string) => { log.push(`scan ${p}`); },
      switchView: (view: string) => log.push(`view ${view}`),
      // A load that fails: loadTreemap roots the map only once the folder has loaded.
      loadTreemap: async (p: string) => { log.push(`load ${p}`); },
    })(hit.path);
    return { log, mapRoot: state.treemap.rootPath };
  };
  const file = (parentPath: string, rootPath: string): Hit => ({ path: `${parentPath}/f`, type: 'file', parentPath, rootPath, name: 'f' });
  assert.deepEqual({
    prefixSibling: await search('/Users/me/Projects', file('/Users/me/Projects-old/app', '/Users/me/Projects-old')),
    backslashSibling: await search('/data/a', file('/data/a\\b', '/data')),
    noScan: await search(null, file('/data/x', '/data')),
    wholeDisk: await search('/', file('/x', '/')),
    wholeDrive: await search('C:\\', { path: 'C:\\x\\f', type: 'file', parentPath: 'C:\\x', rootPath: 'C:\\', name: 'f' }),
    theRootItself: await search('/data', { path: '/data', type: 'dir', parentPath: '/', rootPath: '/data', name: 'data' }),
  }, {
    // Another root is scanned, and the result opened again once that scan is on screen: drilled into
    // now, the map would ask a scan that has not finished.
    prefixSibling: { log: ['toast', 'scan /Users/me/Projects-old'], mapRoot: '/Users/me/Projects' },
    backslashSibling: { log: ['toast', 'scan /data'], mapRoot: '/data/a' },
    noScan: { log: ['toast', 'scan /data'], mapRoot: null },
    // Inside: drilled into, and a load that fails leaves the map where it was.
    wholeDisk: { log: ['view treemap', 'load /x'], mapRoot: '/' },
    wholeDrive: { log: ['view treemap', 'load C:\\x'], mapRoot: 'C:\\' },
    theRootItself: { log: ['view treemap', 'load /data'], mapRoot: '/data' },
  });
  const said: string[] = [];
  await goToFor({ root: { path: '/a' }, treemap: { rootPath: '/a' } }, file('/b/c', '/b'), {
    toast: (text: string) => said.push(text), startScan: async () => undefined, switchView: () => undefined, loadTreemap: async () => undefined,
  })('/b/c/f');
  assert.deepEqual(said, ['“f” is in /b, not the scan on screen — scanning that folder now. Open the result again when the scan finishes.']);
});

test('a global-search hit outside the scan on screen, opened while a scan is running, says a scan is running and starts nothing — startScan would refuse the scan of its folder, so the hit no longer promises one, and the path box keeps what it held (POL item 7 review, F3.1)', async () => {
  type Hit = { path: string; type: string; parentPath: string; rootPath: string; name: string };
  const open = async (scanning: boolean, root: string | null, hit: Hit): Promise<{ log: string[]; pathBox: string }> => {
    const log: string[] = [];
    const pathBox = { value: '/typed/before', blur: () => undefined };
    const state = { scanning, root: root === null ? null : { path: root }, treemap: { rootPath: root } };
    const goTo = new Function(
      'state', '$', 'gsearch', 'gsearchClose', 'toast', 'startScan', 'switchView', 'loadTreemap', 'tmApplyQuery',
      `${declsOf(['gsearchGoTo', 'tmIsInside'])}\nreturn gsearchGoTo;`,
    )(state, (id: string) => (id === 'pathInput' ? pathBox : { value: '', blur: () => undefined }), { hits: [hit] }, () => undefined,
      (text: string, kind?: string) => log.push(kind ? `toast (${kind}): ${text}` : `toast: ${text}`),
      async (p: string) => { log.push(`scan ${p}`); },
      (view: string) => log.push(`view ${view}`),
      async (p: string) => { log.push(`load ${p}`); },
      () => undefined) as (p: string) => Promise<void>;
    await goTo(hit.path);
    return { log, pathBox: pathBox.value };
  };
  const hit: Hit = { path: '/b/c/f', type: 'file', parentPath: '/b/c', rootPath: '/b', name: 'f' };
  const busy = 'toast (error): A scan is already running, so “f” in /b can’t be shown yet. Open the result again once that scan finishes.';
  assert.deepEqual({
    // The quiet refresh behind an index-first paint, or a scan started over the previous one's map.
    whileAScanRuns: await open(true, '/a', hit),
    // The first scan of the session, with nothing on screen yet.
    whileTheFirstScanRuns: await open(true, null, hit),
    idle: await open(false, '/a', hit),
  }, {
    whileAScanRuns: { log: [busy], pathBox: '/typed/before' },
    whileTheFirstScanRuns: { log: [busy], pathBox: '/typed/before' },
    idle: {
      log: ['toast: “f” is in /b, not the scan on screen — scanning that folder now. Open the result again when the scan finishes.', 'scan /b'],
      pathBox: '/b',
    },
  });
});

test('a whole drive’s scan and a share’s are rooted at a folder whose path ends in its separator — "/", "C:\\", "\\\\srv\\share\\" as Windows spells a share’s root — and the page climbs to it: Live mode grows every folder above a change up to that root and stops at the top of a change outside the scan, a change directly in the root lights the root, the preview and Disk City’s Up find it as a folder’s parent, a file at the root is recovered into it, and the “Writing now” rows name each file from below it without losing a letter (POL item 7 review, F2.7, F2.8, F3.5 and F3.6)', () => {
  type Node = { type: string; size: number };
  // The climb is counted, never timed: a climb that cannot stop would hang the page's live handler,
  // and this test with it, rather than fail. Past CLIMB_BOUND steps it is not climbing toward anything.
  const CLIMB_BOUND = 64;
  const live = (root: string, nodes: Record<string, Node>, ev: Record<string, unknown>): Record<string, number> => {
    const pathIndex = new Map(Object.entries(nodes));
    const realParentPath = declsOf(['tmParentPath']).replace('function tmParentPath(', 'function realParentPath(');
    const counted = `let climbs = 0;\nfunction tmParentPath(p) {\n  if (++climbs > ${CLIMB_BOUND}) throw new Error('Live mode is still climbing at ' + JSON.stringify(p) + ' after ${CLIMB_BOUND} steps');\n  return realParentPath(p);\n}`;
    (new Function('state', `${declsOf(['applyLiveDelta'])}\n${realParentPath}\n${counted}\nreturn applyLiveDelta;`)({ root: { path: root }, pathIndex }) as (e: unknown) => void)(ev);
    return Object.fromEntries([...pathIndex].map(([p, n]) => [p, n.size]));
  };
  const liveRegionFor = lift<(p: string, byPath: Map<string, string>) => string | null>(['liveRegionFor', 'tmParentPath'], 'liveRegionFor');
  const snapFolderRefusedText = lift<(p: string) => string>(['snapFolderRefusedText', 'tmParentPath'], 'snapFolderRefusedText');
  const dir = (size: number): Node => ({ type: 'dir', size });
  const file = (size: number): Node => ({ type: 'file', size });
  const share = '\\\\srv\\share\\'; // path.win32.resolve('\\\\srv\\share'): the root of a share's scan
  assert.equal(path.win32.resolve('\\\\srv\\share'), share, 'Windows spells a share’s root folder with its separator');
  // The preview's parent relation, and Disk City's Up, from a folder at the top of a share's scan.
  const drawnKids = (rootPath: string, nodes: { path: string }[]): string[] => {
    const tree = (new Function('state', `${declsOf(['tmDrawnTree', 'tmParentPath'])}\nreturn tmDrawnTree;`)(
      { treemap: { rootPath, rootSize: 10, nodes } }) as () => { kids: Map<string, { path: string }[]> })();
    return (tree.kids.get(rootPath) ?? []).map((n) => n.path);
  };
  const cityUpFrom = (rootPath: string, at: string): string | null => {
    let loaded: string | null = null;
    (new Function('state', 'loadCity', `${declsOf(['cityUp', 'tmParentPath'])}\nreturn cityUp;`)(
      { root: { path: rootPath }, treemap: { rootPath: at } }, (p: string) => { loaded = p; }) as () => void)();
    return loaded;
  };
  assert.deepEqual({
    // The root never grew: the climb cut at the last separator and stopped short of "/", "C:\" or "\\srv\share\".
    wholeDisk: live('/', { '/': dir(100), '/Users': dir(50), '/Users/f': file(5) }, { path: '/Users/f', kind: 'modified', size: 15, delta: 10 }),
    wholeDrive: live('C:\\', { 'C:\\': dir(100), 'C:\\x': dir(50), 'C:\\x\\f': file(5) }, { path: 'C:\\x\\f', kind: 'modified', size: 15, delta: 10 }),
    share: live(share, { [share]: dir(100), [`${share}d`]: dir(10), [`${share}d\\f`]: file(5) }, { path: `${share}d\\f`, kind: 'modified', size: 15, delta: 10 }),
    // Nothing above the scan's root is touched, and a change at the root itself climbs nowhere.
    stopsAtTheRoot: live('/data/d', { '/data': dir(500), '/data/d': dir(100), '/data/d/f': file(5) }, { path: '/data/d/f', kind: 'modified', size: 15, delta: 10 }),
    atTheRoot: live('/data/d', { '/data': dir(500), '/data/d': dir(100) }, { path: '/data/d', kind: 'modified', size: 0, delta: 10 }),
    // A change outside the scan (a watcher's path that differs from the root by case, or by a link) climbs
    // to the top of its own path — "/", another drive's "D:\", another share's root — and stops there:
    // nothing is touched, and the call returns (F3.5).
    outsideTheRoot: live('/data/d', { '/data': dir(500), '/data/d': dir(100), '/data/d/f': file(5) }, { path: '/elsewhere/f', kind: 'modified', size: 15, delta: 10 }),
    outsideOnAnotherDrive: live('C:\\d', { 'C:\\d': dir(100), 'C:\\d\\f': file(5) }, { path: 'D:\\x\\f', kind: 'modified', size: 15, delta: 10 }),
    outsideOnAnotherShare: live(`${share}d`, { [`${share}d`]: dir(100), [`${share}d\\f`]: file(5) }, { path: '\\\\other\\s\\x\\f', kind: 'modified', size: 15, delta: 10 }),
    // A change directly in a whole drive's or a share's root folder, or below one with nothing drawn
    // between, lights the root's region — the circle-pack and Voronoi views draw the root — as a change
    // in any other scanned folder lights that folder (F3.6).
    diskPulseAtItsRoot: liveRegionFor('/f', new Map([['/', 'ROOT']])),
    drivePulseAtItsRoot: liveRegionFor('C:\\f', new Map([['C:\\', 'ROOT']])),
    sharePulseAtItsRoot: liveRegionFor(`${share}f`, new Map([[share, 'ROOT']])),
    sharePulseThroughItsRoot: liveRegionFor(`${share}d\\f`, new Map([[share, 'ROOT']])),
    shareParent: tmParentPath(`${share}x`),
    shareRootIsItsOwnParent: tmParentPath(share),
    sharePreview: drawnKids(share, [{ path: `${share}x` }, { path: `${share}y` }]),
    shareCityUp: cityUpFrom(share, `${share}x`),
    driveCityUp: cityUpFrom('C:\\', 'C:\\x'),
    // A file at a drive's or a share's root is recovered into that root, named as the folder it is —
    // not as the file itself ("/f.txt") nor as "C:", the drive's current folder (F3.6).
    restoreAtDiskRoot: /beside the original, in ([^,]*),/.exec(snapFolderRefusedText('/f.txt'))?.[1],
    restoreAtDriveRoot: /beside the original, in ([^,]*),/.exec(snapFolderRefusedText('C:\\f.txt'))?.[1],
    restoreAtShareRoot: /beside the original, in ([^,]*),/.exec(snapFolderRefusedText(`${share}f.txt`))?.[1],
  }, {
    wholeDisk: { '/': 110, '/Users': 60, '/Users/f': 15 },
    wholeDrive: { 'C:\\': 110, 'C:\\x': 60, 'C:\\x\\f': 15 },
    share: { [share]: 110, [`${share}d`]: 20, [`${share}d\\f`]: 15 },
    stopsAtTheRoot: { '/data': 500, '/data/d': 110, '/data/d/f': 15 },
    atTheRoot: { '/data': 500, '/data/d': 100 },
    outsideTheRoot: { '/data': 500, '/data/d': 100, '/data/d/f': 5 },
    outsideOnAnotherDrive: { 'C:\\d': 100, 'C:\\d\\f': 5 },
    outsideOnAnotherShare: { [`${share}d`]: 100, [`${share}d\\f`]: 5 },
    diskPulseAtItsRoot: 'ROOT',
    drivePulseAtItsRoot: 'ROOT',
    sharePulseAtItsRoot: 'ROOT',
    sharePulseThroughItsRoot: 'ROOT',
    shareParent: share,
    shareRootIsItsOwnParent: share,
    sharePreview: [`${share}x`, `${share}y`],
    shareCityUp: share, // "\\srv\share" is outside the scan: the server refused it 403
    driveCityUp: 'C:\\',
    restoreAtDiskRoot: '/',
    restoreAtDriveRoot: 'C:\\',
    restoreAtShareRoot: share,
  });
  // Controls, not pins: these held before the F2.7 fix too. A share's change in a drawn sub-folder
  // lights that sub-folder, the deepest region, and a file in one is recovered beside it (F3.6).
  assert.deepEqual({
    sharePulseInASubfolder: liveRegionFor(`${share}d\\f`, new Map([[`${share}d`, 'D'], [share, 'ROOT']])),
    shareRestoreInASubfolder: /beside the original, in ([^,]*),/.exec(snapFolderRefusedText(`${share}x\\f.txt`))?.[1],
  }, { sharePulseInASubfolder: 'D', shareRestoreInASubfolder: `${share}x` });

  // The feed's rows, as renderLiveFeed writes them: each file named from below the root.
  const feed = (root: string, paths: string[]): string[] => {
    const host = { hidden: true, innerHTML: '', appendChild: () => undefined };
    const state = { view: 'treemap', root: { path: root }, live: { on: true, window: paths.map((p, i) => ({ path: p, delta: 1000 * (paths.length - i), at: Date.now() })) } };
    const element = () => ({ className: '', setAttribute: () => undefined, appendChild: () => undefined, firstChild: null });
    (new Function('state', '$', 'icon', 'escapeHtml', 'formatBytes', 'document', 'FxCharts',
      `const LIVE_WINDOW_MS = 60000; let liveLineHandle = null; let liveLineWrap = null;\n${declsOf(['renderLiveFeed', 'tmIsInside'])}\nreturn renderLiveFeed;`)(
      state, () => host, () => '', (s: string) => s, (n: number) => `${n} B`, { createElement: element }, { liveLine: () => ({ push: () => undefined }) },
    ) as () => void)();
    return [...host.innerHTML.matchAll(/<span class="nm">([^<]*)<\/span>/g)].map((m) => m[1]);
  };
  assert.deepEqual({
    wholeDisk: feed('/', ['/Users/me/Downloads/big.iso', '/x']),
    wholeDrive: feed('C:\\', ['C:\\Users\\me\\big.iso']),
    folder: feed('/Users/me', ['/Users/me/Downloads/big.iso', '/Users/me']),
    share: feed(share, [`${share}d\\f`]),
    backslashName: feed('/data/a\\b', ['/data/a\\b/f', '/data/a\\bc/g']),
  }, {
    wholeDisk: ['Users/me/Downloads/big.iso', 'x'],
    wholeDrive: ['Users\\me\\big.iso'],
    folder: ['Downloads/big.iso', '/Users/me'], // the root itself keeps its whole path
    share: ['d\\f'],
    backslashName: ['f', '/data/a\\bc/g'], // a sibling that merely starts with the root's name is not below it
  });
});

/* ══════════════ the rules §4.3 states, asserted against the source ══════════════ */

function slice(from: string, to: string): string {
  const start = INDEX.indexOf(from);
  assert.notEqual(start, -1, `anchor not found: ${from}`);
  const end = INDEX.indexOf(to, start + from.length);
  assert.notEqual(end, -1, `end anchor not found: ${to}`);
  const out = INDEX.slice(start, end);
  assert.ok(out.length > 100, `the slice ${from} → ${to} is suspiciously short`);
  return out;
}

test('the preview never calls the server', () => {
  const body = slice('function tmBuildPreview', 'let tmHatch = null');
  for (const forbidden of ['api(', 'fetch(', 'EventSource', 'XMLHttpRequest']) {
    assert.ok(!body.includes(forbidden), `§4.3 forbids a server call; found ${forbidden}`);
  }
});

test('the banner says nothing has been deleted, and it is not optional', () => {
  assert.ok(INDEX.includes('id="tmPreviewBanner"'));
  const body = slice('function syncCartPreviewChrome', "$('cartPreview').addEventListener");
  assert.match(body, /Preview — nothing has been deleted\./);
  // Shown exactly when the preview is on: not a flag someone can leave off.
  assert.match(body, /banner\.hidden = !tmPreview\.on;/);
});

test('exiting restores the saved node list rather than rebuilding it', () => {
  const body = slice('function exitCartPreview', 'function syncCartPreviewChrome');
  assert.match(body, /if \(saved\) state\.treemap\.nodes = saved;/);
  assert.ok(!body.includes('loadTreemap'), 'exiting must not trigger a fetch');
});

test('a staged folder and a file inside it are not both counted', () => {
  // Counting both would free the same space twice and produce a map whose
  // areas do not add up. Asserted on the ancestor walk that answers it — the
  // pairwise `paths.some` inside `paths.filter` this replaced was 250,000
  // string comparisons for a 500-item cart.
  const body = slice('function tmCartRoots', 'function tmBuildPreview');
  // A Set of the staged folders the scan holds (B06 review: an unknown one hides nothing).
  assert.match(body, /const staged = new Set\(paths\.filter\(\(p\) => cartNode\(p\)\)\)/);
  assert.match(body, /if \(staged\.has\(dir\)\) return false/);
  assert.match(body, /if \(dir === tmParentPath\(dir\)\) break/, 'and it terminates at the filesystem root');
});

test('the preview is read-only, like the time slider', () => {
  const clicks = slice("tmCanvas.addEventListener('click'", "async function expandContainerNode");
  assert.match(clicks, /if \(tmPreview\.on\) \{ hideTooltip\(\); return; \}/);
  const menu = slice("tmCanvas.addEventListener('contextmenu'", "$('tmDepth').addEventListener");
  assert.match(menu, /if \(tmPreview\.on\) return;/);
});

test('a freed block is hatched rather than filled', () => {
  const body = slice('  // Pass 1: cushion-shaded leaf fills.', '  // Pass 2.5: diff wash');
  assert.match(body, /if \(r\.n\.freed\)/, 'freed blocks take their own branch');
  assert.match(body, /tmHatchPattern\(ctx\)/, 'and it is the hatch, not a solid fill');
});

/* ══════════════ the layout the preview actually produces ══════════════ */

interface DrawnNode {
  name: string; path: string; size: number; type: string; depth: number;
  expanded: boolean; x: number; y: number; w: number; h: number;
  freed?: boolean;
}
interface PreviewOut {
  nodes: DrawnNode[] | null;
  stagedInView: number;
  outsideView: number;
  outsideBytes: number;
  outsideUnsized: number;
  freedBytes: number;
}

/**
 * `tmBuildPreview` with its two free variables injected.
 *
 * It reads only `state` and `cartNode`, deliberately — §4.3 requires that
 * nothing outlive the preview, and a builder that touches nothing else is the
 * cheapest way to guarantee it. That same property is what makes it testable
 * here without a browser.
 */
function buildPreviewWith(
  nodes: DrawnNode[],
  rootPath: string,
  rootSize: number,
  cart: string[],
  sizes: Record<string, number>,
): PreviewOut {
  const names = ['tmWorstRatio', 'tmSquarify', 'tmParentPath', 'tmIsInside', 'tmDrawnTree', 'tmCartRoots', 'tmBuildPreview'];
  const parts: string[] = [];
  for (const name of names) {
    const start = INDEX.indexOf(`function ${name}(`);
    assert.notEqual(start, -1, `function ${name} was located`);
    const open = INDEX.indexOf('{', start);
    let depth = 0;
    let end = open;
    for (let i = open; i < INDEX.length; i++) {
      if (INDEX[i] === '{') depth++;
      else if (INDEX[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
    }
    parts.push(INDEX.slice(start, end));
  }
  const fn = new Function('state', 'cartNode', `${parts.join('\n')}\nreturn tmBuildPreview();`);
  return fn(
    { treemap: { nodes, rootPath, rootSize }, cart: new Set(cart) },
    (p: string) => (p in sizes ? { path: p, size: sizes[p] } : null),
  ) as PreviewOut;
}

/**
 * A three-level fixture: /r holds two folders of 600 and 400; /r/a holds two
 * files of 400 and 200; /r/b holds one file of 400 and 100 bytes of files too
 * small to have been drawn.
 */
function fixture(): { nodes: DrawnNode[]; sizes: Record<string, number> } {
  const mk = (path: string, size: number, depth: number, expanded: boolean): DrawnNode => ({
    name: path.split('/').pop()!, path, size, type: expanded ? 'dir' : 'file',
    depth, expanded, x: 0, y: 0, w: 0, h: 0,
  });
  return {
    nodes: [
      mk('/r/a', 600, 1, true),
      mk('/r/b', 400, 1, true),
      mk('/r/a/big.mov', 400, 2, false),
      mk('/r/a/mid.mov', 200, 2, false),
      mk('/r/b/one.iso', 300, 2, false),
    ],
    sizes: {
      '/r/a': 600, '/r/b': 400,
      '/r/a/big.mov': 400, '/r/a/mid.mov': 200, '/r/b/one.iso': 300,
      '/r/b/deep/tiny.log': 40,   // inside a drawn folder, never drawn itself
      '/elsewhere/x.bin': 999,    // outside this view entirely
    },
  };
}

/** Every rectangle at one depth, summed as a fraction of the 100×100 canvas. */
function areaOf(nodes: DrawnNode[], pred: (n: DrawnNode) => boolean): number {
  return nodes.filter(pred).reduce((sum, n) => sum + n.w * n.h, 0);
}

test('staging a drawn folder turns it into a hatched block of exactly its size', () => {
  const { nodes, sizes } = fixture();
  const out = buildPreviewWith(nodes, '/r', 1000, ['/r/b'], sizes);
  assert.ok(out.nodes, 'a preview was produced');
  const freed = out.nodes!.filter((n) => n.freed);
  assert.equal(freed.length, 1, 'one freed block, at the root');
  assert.equal(freed[0].size, 400);
  assert.equal(out.freedBytes, 400);
  // Its subtree is gone.
  assert.ok(!out.nodes!.some((n) => n.path.startsWith('/r/b/')), 'the staged subtree is not drawn');
  // And the survivor keeps exactly the area it had: 600/1000 of the canvas.
  const a = out.nodes!.find((n) => n.path === '/r/a')!;
  assert.ok(Math.abs(a.w * a.h - 6000) < 1e-6, 'a surviving folder does not grow into the gap');
});

test('the freed area equals the freed bytes, as a share of the map', () => {
  const { nodes, sizes } = fixture();
  const out = buildPreviewWith(nodes, '/r', 1000, ['/r/a/big.mov'], sizes);
  assert.equal(out.freedBytes, 400);
  // 400 of 1000 bytes → 40% of a 100×100 canvas, wherever it was drawn.
  assert.ok(Math.abs(areaOf(out.nodes!, (n) => Boolean(n.freed)) - 4000) < 1e-6);
});

test('a staged file below the drawn depth shrinks its host and hatches the difference', () => {
  const { nodes, sizes } = fixture();
  // /r/b/deep/tiny.log is inside the drawn folder /r/b but was never drawn.
  const out = buildPreviewWith(nodes, '/r', 1000, ['/r/b/deep/tiny.log'], sizes);
  assert.equal(out.freedBytes, 40);
  const freed = out.nodes!.filter((n) => n.freed);
  assert.equal(freed.length, 1);
  // Charged inside /r/b, which is where those bytes actually are.
  assert.equal(freed[0].path, '/r/b — freed');
  assert.equal(freed[0].size, 40);
  // /r/b itself keeps its rectangle — the space comes out of its interior.
  const b = out.nodes!.find((n) => n.path === '/r/b')!;
  assert.ok(Math.abs(b.w * b.h - 4000) < 1e-6);
});

test('staging a folder and a file inside it frees the folder once, not one-and-a-half times', () => {
  const { nodes, sizes } = fixture();
  const out = buildPreviewWith(nodes, '/r', 1000, ['/r/a', '/r/a/big.mov'], sizes);
  assert.equal(out.freedBytes, 600, 'the file is already inside the folder');
  assert.equal(out.nodes!.filter((n) => n.freed).length, 1);
});

test('a staged path outside this folder is counted and said out loud, never drawn', () => {
  const { nodes, sizes } = fixture();
  const out = buildPreviewWith(nodes, '/r', 1000, ['/r/b', '/elsewhere/x.bin'], sizes);
  assert.equal(out.outsideView, 1);
  assert.equal(out.outsideBytes, 999);
  assert.equal(out.freedBytes, 400, 'only what is in this view is drawn as freed');
});

test('a staged path whose size is unknown is reported, never guessed at', () => {
  const { nodes, sizes } = fixture();
  // Inside the view, but the node cache has no size for it.
  const out = buildPreviewWith(nodes, '/r', 1000, ['/r/b', '/r/a/unresolved.bin'], sizes);
  assert.equal(out.outsideView, 1, 'the unresolvable one is counted, not silently dropped');
  assert.equal(out.freedBytes, 400, 'and it contributes no invented bytes');
});

test('staging the folder the map is rooted at frees the whole canvas', () => {
  const { nodes, sizes } = fixture();
  const out = buildPreviewWith(nodes, '/r', 1000, ['/r'], { ...sizes, '/r': 1000 });
  const freed = out.nodes!.filter((n) => n.freed);
  assert.equal(freed.length, 1);
  assert.equal(freed[0].size, 1000);
  assert.ok(Math.abs(freed[0].w * freed[0].h - 10000) < 1e-6, 'the entire map is hatched');
  assert.equal(out.nodes!.length, 1, 'and nothing else is drawn');
});

test('an empty cart produces no preview rather than an unchanged one', () => {
  const { nodes, sizes } = fixture();
  const out = buildPreviewWith(nodes, '/r', 1000, [], sizes);
  assert.equal(out.nodes, null);
  assert.equal(out.freedBytes, 0);
});

test('the top level still tiles the whole canvas, whatever is staged', () => {
  const { nodes, sizes } = fixture();
  for (const cart of [['/r/a'], ['/r/b'], ['/r/a/mid.mov'], ['/r/b/deep/tiny.log'], ['/r/a', '/r/b/one.iso']]) {
    const out = buildPreviewWith(nodes, '/r', 1000, cart, sizes);
    const top = areaOf(out.nodes!, (n) => n.depth === 1);
    assert.ok(Math.abs(top - 10000) < 1e-6, `cart ${cart.join(',')} left the canvas ${top} instead of 10000`);
  }
});

test('every staged byte is either hatched on the map or reported as outside it', () => {
  const { nodes, sizes } = fixture();
  const cart = ['/r/a/mid.mov', '/r/b/deep/tiny.log', '/elsewhere/x.bin'];
  const out = buildPreviewWith(nodes, '/r', 1000, cart, sizes);
  const staged = cart.reduce((sum, p) => sum + sizes[p], 0);
  // The invariant §4.3's honesty rests on: nothing staged goes unaccounted.
  assert.equal(out.freedBytes + out.outsideBytes, staged);
  assert.equal(out.stagedInView, out.freedBytes);
});

test('a staged path inside an UNexpanded folder shrinks it and hatches beside it', () => {
  // The fourth attribution case: the deepest drawn node containing the staged
  // path is a leaf — a folder the depth limit stopped at — so it has no
  // interior to draw a block in. It shrinks, and its parent's freed block
  // grows by exactly the same amount.
  const mk = (path: string, size: number, depth: number, expanded: boolean): DrawnNode => ({
    name: path.split('/').pop()!, path, size, type: 'dir', depth, expanded,
    x: 0, y: 0, w: 0, h: 0,
  });
  const nodes = [mk('/r/c', 300, 1, false), mk('/r/d', 700, 1, false)];
  const sizes = { '/r/c': 300, '/r/d': 700, '/r/c/inner/x.bin': 100 };
  const out = buildPreviewWith(nodes, '/r', 1000, ['/r/c/inner/x.bin'], sizes);

  assert.equal(out.freedBytes, 100);
  const c = out.nodes!.find((n) => n.path === '/r/c')!;
  assert.equal(c.size, 200, 'the folder is drawn at what would be left of it');
  assert.ok(Math.abs(c.w * c.h - 2000) < 1e-6, 'and its rectangle shrinks to match');
  const freed = out.nodes!.filter((n) => n.freed);
  assert.equal(freed.length, 1);
  assert.equal(freed[0].path, '/r — freed', 'the freed block sits beside it, in the parent');
  assert.ok(Math.abs(areaOf(out.nodes!, (n) => n.depth === 1) - 10000) < 1e-6, 'the canvas still tiles');
});

/* ══════════════ a freed block is not a file ══════════════ */

test('a freed block is never sent to the fact layer, nor counted as unreadable', () => {
  // Its path is synthetic ("<parent> — freed"). It sanitizes cleanly and sits
  // inside the scan root, so it passes the path guard and reaches the
  // providers — which spend a batch slot on a file that never existed and come
  // back with nothing, which the coverage note would then report as a file
  // that could not be read. A count of unreadable files that includes
  // something that is not a file is exactly the number this app refuses.
  // Both ask one predicate, so the batch and the legend's total cannot disagree
  // (tests/reclaimScoreLoop.test.ts drives both with a freed block on screen).
  const askable = lift<(n: object) => boolean>(['reclaimAskableNode', 'reclaimAskablePath'], 'reclaimAskableNode');
  assert.equal(askable({ path: '/r/a — freed', freed: true }), false, 'a freed block is not askable');
  assert.equal(askable({ path: '/r/a' }), true);
  const fetcher = slice('function fetchScoresForTreemap', '$(\'tmColorSeg\').addEventListener');
  assert.match(fetcher, /if \(reclaimAskableNode\(r\.n\)\) paths\.push/, 'the scoring batch takes only askable cells');
  const coverage = slice('function reclaimCoverageNote', 'Height for the treemap/sunburst canvas');
  assert.match(coverage, /if \(!reclaimAskableNode\(r\.n\)\) continue;/, 'and so does the coverage denominator');
});

test('the preview is read-only for the keyboard, not just the mouse', () => {
  // Delete used to trash a real file under a banner saying nothing had been
  // deleted: the mouse handlers were guarded and this block was not. Same
  // condition as the time slider, which was already here.
  const nav = slice("// Feature 6 — keyboard navigation in the treemap", "if (e.key === 'Escape')");
  assert.match(nav, /!state\.treemap\.history\.active && !tmPreview\.on/);
  assert.match(nav, /case 'Delete':/, 'the guarded block really is the one with Delete in it');
});

/* ══════════════ B29: the preview says "staged", not "freed" ══════════════ */

test('the preview banner, the status line and the hatched block say staged for the Trash, never freed (B29)', () => {
  // QA: "The hatched areas are the 4.5 GB this cart would free", "Freed 4.5 GB",
  // "Preview · 4.5 GB would be freed" — for two sparse files that occupy 0 bytes,
  // about to be moved to the Trash, which frees nothing until it is emptied.
  const text = { innerHTML: '' };
  const banner = { hidden: true, offsetHeight: 20 };
  const wrap = { classList: { toggle() {} }, style: { removeProperty() {}, getPropertyValue: () => '', setProperty() {} } };
  const els: Record<string, unknown> = { tmPreviewText: text, tmPreviewBanner: banner, treemapWrap: wrap, cartPreview: null };
  const keys = ['$', 'tmPreview', 'formatBytes', 'formatCount', 'escapeHtml', 'tmPreviewPadSync', 'tmPreviewWatch', 'state'];
  // With the cart's own sentences about space (cartSpaceSaid, D07).
  const body = slice('function syncCartPreviewChrome', '/**\n * Pad the wrap') + slice('function cartSpaceSaid', '/**\n * Protect');
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const sync = new Function(...keys, `${body}\nreturn syncCartPreviewChrome;`)(
    (id: string) => els[id] ?? null, { on: true, freedBytes: 4_500_000_000, outsideView: 0, outsideBytes: 0 },
    (n: number) => `${n} B`, String, (s: unknown) => String(s), () => false, () => {}, { capsuleOff: false },
  ) as () => void;
  sync();
  assert.doesNotMatch(text.innerHTML, /would free/, text.innerHTML);
  // The cart's own sentence in a span of its own, which the stylesheet leaves to the open cart (H52).
  assert.match(text.innerHTML, /<b>4500000000 B<\/b> this cart stages for the Trash\. <span class="tm-pv-cart-said">Up to that much space comes back, but only when you empty the Trash\./, text.innerHTML);

  const status = slice('if (tmPreview.on) {\n    $(\'tmStatus\')', 'if (q) {');
  assert.doesNotMatch(status, /would be freed/);
  assert.match(status, /staged for the Trash/);
  const label = slice('// Pass 3.5 (v4 §4.3)', "ctx.textAlign = 'left'; // pass 4 assumes it");
  assert.match(label, /ctx\.fillText\('Staged ' \+ formatBytes\(r\.n\.size\)/, 'the hatched block is labelled staged');
  assert.doesNotMatch(label, /'Freed '/);
});

test('the hatched block is named "Staged" — the name the magnifier lens prints over it (B29)', () => {
  const { nodes, sizes } = fixture();
  const out = buildPreviewWith(nodes, '/r', 1000, ['/r/b'], sizes);
  const freed = out.nodes!.filter((n) => n.freed);
  assert.deepEqual(freed.map((n) => n.name), ['Staged'], 'not "Freed": nothing is freed until the Trash is emptied');
});

/* ══════════════ B06 review: an unsized staged item is unknown in the banner too ══════════════ */

/** The banner's text for a given preview state, from the page's own syncCartPreviewChrome. */
function bannerFor(preview: Record<string, unknown>): string {
  const text = { innerHTML: '' };
  const banner = { hidden: true, offsetHeight: 20 };
  const wrap = { classList: { toggle() {} }, style: { removeProperty() {}, getPropertyValue: () => '', setProperty() {} } };
  const els: Record<string, unknown> = { tmPreviewText: text, tmPreviewBanner: banner, treemapWrap: wrap, cartPreview: null };
  const keys = ['$', 'tmPreview', 'formatBytes', 'formatCount', 'escapeHtml', 'tmPreviewPadSync', 'tmPreviewWatch', 'state'];
  // With the cart's own sentences about space (cartSpaceSaid, D07).
  const body = slice('function syncCartPreviewChrome', '/**\n * Pad the wrap') + slice('function cartSpaceSaid', '/**\n * Protect');
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const sync = new Function(...keys, `${body}\nreturn syncCartPreviewChrome;`)(
    (id: string) => els[id] ?? null, { on: true, freedBytes: 400, ...preview },
    (n: number) => `${n} B`, String, (s: unknown) => String(s), () => false, () => {}, { capsuleOff: false },
  ) as () => void;
  sync();
  return text.innerHTML;
}

test('the preview counts a staged item with no size apart from the bytes it reports, never as 0 B (B06 review)', () => {
  const { nodes, sizes } = fixture();
  // Drawn, outside the folder with a size, and not in the scan on screen at all.
  const mixed = buildPreviewWith(nodes, '/r', 1000, ['/r/b', '/elsewhere/x.bin', '/gone/y.bin'], sizes);
  assert.equal(mixed.outsideView, 2, 'both are counted as not shown');
  assert.equal(mixed.outsideBytes, 999, 'the bytes are the sized one only');
  assert.equal(mixed.outsideUnsized, 1, 'and the one nobody measured is counted as unknown');
  // Inside the folder, but with no size here either.
  const inside = buildPreviewWith(nodes, '/r', 1000, ['/r/b', '/r/a/unresolved.bin'], sizes);
  assert.equal(inside.outsideUnsized, 1, 'an unsized item inside the folder is unknown too');
  const sized = buildPreviewWith(nodes, '/r', 1000, ['/r/b', '/elsewhere/x.bin'], sizes);
  assert.equal(sized.outsideUnsized, 0, 'and a sized one is not');
});

test('the preview banner marks its figure as a floor when some staged items are unsized, and gives none when all are (B06 review)', () => {
  const mixed = bannerFor({ outsideView: 2, outsideBytes: 999, outsideUnsized: 1 });
  assert.doesNotMatch(mixed, /\(999 B\) are/, `the sized part is not the total for both: ${mixed}`);
  assert.match(mixed, /2 staged items \(999 B\+; 1 not in this scan, not counted\) are outside this folder and not shown\./, mixed);

  const unknown = bannerFor({ outsideView: 2, outsideBytes: 0, outsideUnsized: 2 });
  assert.doesNotMatch(unknown, /\(\d+ B/, `no figure when nothing was measured: ${unknown}`);
  assert.match(unknown, /2 staged items \(not in this scan, size unknown\) are outside this folder and not shown\./, unknown);

  const sized = bannerFor({ outsideView: 1, outsideBytes: 999, outsideUnsized: 0 });
  assert.match(sized, /1 staged item \(999 B\) is outside this folder and not shown\./, `unchanged when every item is sized: ${sized}`);

  const enter = slice('function enterCartPreview', 'function exitCartPreview');
  assert.match(enter, /tmPreview\.outsideUnsized = built\.outsideUnsized;/, 'turning the preview on carries the unknown count to the banner');
});

/* ══════════════ B06 review, round 2: a staged folder above the map ══════════════ */

/** A map rooted at Projects, two files on it, and the folder above it — the cart outlives the scan it was filled from. */
const PROJECTS = '/Users/me/Downloads/Projects';
const ABOVE = '/Users/me/Downloads';
function projectsMap(): { nodes: DrawnNode[]; sizes: Record<string, number> } {
  const mk = (name: string, size: number): DrawnNode => ({
    name, path: `${PROJECTS}/${name}`, size, type: 'file', depth: 1, expanded: false, x: 0, y: 0, w: 0, h: 0,
  });
  return {
    nodes: [mk('a.iso', 400), mk('b.iso', 200)],
    sizes: { [`${PROJECTS}/a.iso`]: 400, [`${PROJECTS}/b.iso`]: 200 },
  };
}

test('a staged folder above this map that the scan does not hold is unknown — never the whole map hatched (B06 review)', () => {
  // Downloads was staged in a wide scan; this scan is of Projects, and holds
  // no Downloads. The cart calls it "not in this scan" and will not trash it,
  // so the preview must not show the whole map going.
  const { nodes, sizes } = projectsMap();
  const out = buildPreviewWith(nodes, PROJECTS, 600, [ABOVE], sizes);
  assert.deepEqual(
    [out.nodes, out.freedBytes, out.stagedInView, out.outsideView, out.outsideUnsized],
    [null, 0, 0, 1, 1],
    'nothing hatched, and the item is counted as not shown and of unknown size',
  );

  // Held by the scan — a drill-down inside a wider scan — it does stage everything on screen.
  const held = buildPreviewWith(nodes, PROJECTS, 600, [ABOVE], { ...sizes, [ABOVE]: 5_000 });
  assert.deepEqual([held.freedBytes, held.stagedInView, held.outsideUnsized], [600, 600, 0]);
  assert.equal(held.nodes!.length, 1, 'one hatched block, and nothing else drawn');
  assert.ok(Math.abs(held.nodes![0]!.w * held.nodes![0]!.h - 10_000) < 1e-6, 'covering the whole map');
});

test('a known staged file under a staged folder this scan does not hold is drawn — the unknown folder hides nothing (B06 review)', () => {
  // The commit sends a.iso (the scan holds it) and leaves the folder above
  // out; the Preview shows the same: a.iso hatched, the folder unknown.
  const { nodes, sizes } = projectsMap();
  const out = buildPreviewWith(nodes, PROJECTS, 600, [ABOVE, `${PROJECTS}/a.iso`], sizes);
  assert.deepEqual(
    [out.freedBytes, out.stagedInView, out.outsideView, out.outsideUnsized],
    [400, 400, 1, 1],
    'a.iso is hatched at its size, and the folder above is counted as not shown, size unknown',
  );
});

/* ══════════════ B06 review, round 2: the preview ends when nothing staged is left on the map ══════════════ */

/** One function declaration, or one `const NAME = …;` line, from the built page. */
function pageSource(name: string): string {
  const fn = INDEX.indexOf(`function ${name}(`);
  if (fn === -1) {
    const at = INDEX.indexOf(`const ${name} = `);
    assert.notEqual(at, -1, `${name} was located in public/index.html`);
    return INDEX.slice(at, INDEX.indexOf(';\n', at) + 1);
  }
  const start = INDEX.startsWith('async ', fn - 6) ? fn - 6 : fn; // an async function keeps its `async`
  const open = INDEX.indexOf('{', INDEX.indexOf(')', fn));
  for (let i = open, depth = 0; i < INDEX.length; i++) {
    if (INDEX[i] === '{') depth++;
    else if (INDEX[i] === '}' && --depth === 0) return INDEX.slice(start, i + 1);
  }
  return assert.fail(`${name} never closes`);
}

/**
 * The page's own preview, cart and chrome code over a fake DOM: the map shows
 * /r with /r/a (60 B) and /r/b (40 B); /other/x (5,000 B) is outside it.
 */
function previewPage(cart: string[]) {
  const real = [
    { name: 'a', path: '/r/a', size: 60, type: 'dir', depth: 1, expanded: false },
    { name: 'b', path: '/r/b', size: 40, type: 'dir', depth: 1, expanded: false },
  ];
  const pathIndex = new Map<string, { path: string; size: number }>(real.map((n) => [n.path, n]));
  pathIndex.set('/other/x', { path: '/other/x', size: 5_000 });
  const state = {
    cart: new Set(cart), view: 'treemap', pathIndex, nodeCache: new Map(),
    treemap: { nodes: real as unknown[], rootPath: '/r', rootSize: 100, mode: 'squarify', history: { active: false }, hover: null as unknown, kbSel: null as unknown },
  };
  const wrapProps: Record<string, string> = {};
  const wrap = {
    previewing: false,
    classList: { toggle(_c: string, on: boolean) { wrap.previewing = on; } },
    style: {
      setProperty(k: string, v: string) { wrapProps[k] = v; }, removeProperty(k: string) { delete wrapProps[k]; },
      getPropertyValue: (k: string) => wrapProps[k] ?? '',
    },
  };
  const button = { pressed: '', setAttribute(_k: string, v: string) { button.pressed = v; }, classList: { toggle() {} } };
  const banner = { hidden: true, offsetHeight: 40 };
  const els: Record<string, unknown> = { treemapWrap: wrap, cartPreview: button, tmPreviewBanner: banner, tmPreviewText: { innerHTML: '' } };
  const drawn: unknown[][] = [];
  const toasts: string[] = [];
  const deps: Record<string, unknown> = {
    state, $: (id: string) => els[id] ?? null,
    toast: (m: string) => { toasts.push(m); }, hideTooltip() {}, drawTreemap: () => { drawn.push(state.treemap.nodes); },
    isSun: () => false, isCells: () => false, isRectMap: () => true,
    escapeHtml: (s: unknown) => String(s), formatBytes: (n: number) => `${n} B`, formatCount: String,
    saveCart() {}, renderCart() {}, refreshCartButtons() {}, ResizeObserver: undefined,
  };
  const names = ['tmPreview', 'TM_PREVIEW_BANNER_INSET', 'tmWorstRatio', 'tmSquarify', 'tmParentPath', 'tmIsInside', 'tmDrawnTree',
    'tmCartRoots', 'tmBuildPreview', 'tmPreviewRefusal', 'enterCartPreview', 'exitCartPreview', 'syncCartPreviewChrome', 'tmPreviewPadSync',
    'TM_CART_GAP', 'tmCartClearSync', 'tmPreviewWatch', 'cartPreviewInvalidated', 'cartNode', 'nodeFor', 'cartToggle', 'tmStageMatches', 'cartSpaceSaid'];
  const keys = Object.keys(deps);
  // The query box's last answer, which the real tmStageMatches stages from:
  // `stageMatches(paths)` sets it to those files and presses Stage.
  const src = `let tmLastHits = { paths: [], total: 0, truncated: false, stage: null };
    ${names.map(pageSource).join('\n')}
    return {
      tmPreview, enterCartPreview, exitCartPreview, cartToggle,
      stageMatches: async (paths) => {
        tmLastHits = { paths, total: paths.length, truncated: false, stage: { paths, noun: 'file' } };
        await tmStageMatches();
      },
    };`;
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const page = new Function(...keys, src)(...keys.map((k) => deps[k])) as {
    tmPreview: { on: boolean; freedBytes: number }; enterCartPreview(): void; exitCartPreview(): void; cartToggle(p: string): void;
    stageMatches(paths: string[]): Promise<void>;
  };
  /** What a person sees: is a preview up, by every sign of one. */
  const shows = () => ({
    on: page.tmPreview.on, bannerHidden: banner.hidden, previewing: wrap.previewing, pressed: button.pressed,
    pad: wrapProps['--tm-preview-pad'] ?? null,
  });
  const bannerText = () => (els.tmPreviewText as { innerHTML: string }).innerHTML;
  return { page, state, real, drawn, toasts, shows, bannerText };
}

const NO_PREVIEW = { on: false, bannerHidden: true, previewing: false, pressed: 'false', pad: null };

test('un-staging the last staged item on the map ends the preview — banner, outline and toggle off, the real map drawn (B06 review)', () => {
  // Review: /r/b on the map and /other/x outside it, preview on; removing /r/b
  // left the banner up ("the hatched areas are the 40 B…"), its Exit button
  // dead, and the hatched map on the canvas.
  const p = previewPage(['/r/b', '/other/x']);
  p.page.enterCartPreview();
  assert.deepEqual(p.shows(), { on: true, bannerHidden: false, previewing: true, pressed: 'true', pad: '60px' }, 'the preview is up');
  p.state.treemap.hover = { path: '/r — freed' }; // the pointer rests on the hatched block

  p.page.cartToggle('/r/b');
  assert.deepEqual(p.shows(), NO_PREVIEW, 'nothing staged is on this map any more: no banner, no outline, the toggle off');
  assert.equal(p.state.treemap.nodes, p.real, 'the real layout is back — the very array, not a rebuild');
  assert.equal(p.drawn.at(-1), p.real, 'and it is what the canvas draws last, not the hatched preview');
  assert.equal(p.state.treemap.hover, null, 'no hover left on a rectangle that is gone');
});

test('un-staging one of two staged items on the map rebuilds the preview from the real layout (B06 review)', () => {
  const p = previewPage(['/r/a', '/r/b']);
  p.page.enterCartPreview();
  p.page.cartToggle('/r/a');
  assert.deepEqual(p.shows(), { on: true, bannerHidden: false, previewing: true, pressed: 'true', pad: '60px' }, 'still previewing');
  const last = p.drawn.at(-1) as Array<{ path: string; size: number; freed?: boolean }>;
  assert.notEqual(last, p.real, 'a preview is drawn');
  assert.deepEqual(last.map((n) => [n.path, n.size, Boolean(n.freed)]), [['/r/a', 60, false], ['/r — freed', 40, true]],
    '/r/a is back on the map at its size, and only /r/b is hatched');
  p.page.exitCartPreview();
  assert.deepEqual(p.shows(), NO_PREVIEW);
  assert.equal(p.state.treemap.nodes, p.real, 'exiting puts the real layout back');
});

/* ══════════════ B06 review, round 3: the refusal names an item this scan does not hold ══════════════ */

/** The last toast the page raised, or '' when it raised none. */
const lastToast = (p: ReturnType<typeof previewPage>): string => p.toasts.at(-1) ?? '';

test('Preview with only items this scan does not hold says they are not in it — not "open the folder they are in" (B06 review)', () => {
  // '/' is a folder above the map and '/gone/y.bin' is elsewhere; this scan
  // holds neither, so no folder of it can preview them, and the cart calls
  // them "not in this scan — size unknown".
  const one = previewPage(['/']);
  one.page.enterCartPreview();
  assert.equal(one.page.tmPreview.on, false, 'there is nothing to preview');
  assert.equal(lastToast(one), 'The 1 staged item is not in this scan — size unknown, so there is nothing to preview.');

  const two = previewPage(['/', '/gone/y.bin']);
  two.page.enterCartPreview();
  assert.equal(lastToast(two), 'The 2 staged items are not in this scan — size unknown, so there is nothing to preview.');
});

test('un-staging the last item on the map, with only items this scan does not hold left, says they are not in it (B06 review)', () => {
  const p = previewPage(['/r/b', '/gone/y.bin']);
  p.page.enterCartPreview();
  p.page.cartToggle('/r/b');
  assert.deepEqual(p.shows(), NO_PREVIEW, 'the preview is over');
  assert.equal(lastToast(p), 'The 1 staged item is not in this scan — size unknown, so there is nothing to preview.');
});

test('a refusal gives the "open the folder" advice only for items elsewhere in this scan, and names the rest (B06 review)', () => {
  const mixed = previewPage(['/other/x', '/gone/y.bin']);
  mixed.page.enterCartPreview();
  assert.equal(lastToast(mixed),
    'None of the 2 staged items is inside this folder. 1 is not in this scan — size unknown; open the folder the other one is in to preview it.');

  // Unequal counts, so the not-in-scan number and the other number cannot trade places unseen.
  const moreSized = previewPage(['/other/x', '/other/z', '/gone/y.bin']);
  moreSized.state.pathIndex.set('/other/z', { path: '/other/z', size: 7 });
  moreSized.page.enterCartPreview();
  assert.equal(lastToast(moreSized),
    'None of the 3 staged items is inside this folder. 1 is not in this scan — size unknown; open the folder the other 2 are in to preview them.');

  const moreUnsized = previewPage(['/other/x', '/', '/gone/y.bin']);
  moreUnsized.page.enterCartPreview();
  assert.equal(lastToast(moreUnsized),
    'None of the 3 staged items is inside this folder. 2 are not in this scan — size unknown; open the folder the other one is in to preview it.');
});

test('a refusal for items that are all elsewhere in this scan keeps the "open the folder" advice, in the right number (B06 review)', () => {
  const one = previewPage(['/other/x']);
  one.page.enterCartPreview();
  assert.equal(lastToast(one), 'None of the 1 staged item is inside this folder — open the folder it is in to preview it.');

  const two = previewPage(['/other/x', '/other/z']);
  two.state.pathIndex.set('/other/z', { path: '/other/z', size: 7 });
  two.page.enterCartPreview();
  assert.equal(lastToast(two), 'None of the 2 staged items is inside this folder — open the folder they are in to preview them.');
});

/* ══════════════ B06 review, round 3: Stage matches while the Preview is up ══════════════ */

test('staging query matches while the Preview is up rebuilds it for the cart as it now is (B06 review)', async () => {
  // Review: with /r/b staged and the Preview up, "Stage matches" added /r/a to
  // the cart while the banner, the status line and the hatching kept showing
  // the 40 B of the cart as it was.
  const p = previewPage(['/r/b']);
  p.page.enterCartPreview();
  assert.match(p.bannerText(), /<b>40 B<\/b>/, 'the preview is up, for /r/b alone');

  await p.page.stageMatches(['/r/a']);
  assert.deepEqual([...p.state.cart].sort(), ['/r/a', '/r/b'], 'the match is in the cart');
  assert.equal(p.shows().on, true, 'still previewing');
  assert.equal(p.page.tmPreview.freedBytes, 100, 'the preview stages both');
  assert.match(p.bannerText(), /<b>100 B<\/b>/, `the banner says so: ${p.bannerText()}`);
  const last = (p.drawn.at(-1) ?? []) as Array<{ path: string; size: number; freed?: boolean }>;
  assert.deepEqual(last.map((n) => [n.path, n.size, Boolean(n.freed)]), [['/r — freed', 100, true]],
    'and the canvas hatches /r/a as well as /r/b');
});

test('staging matches that are all in the cart already leaves the Preview untouched (B06 review)', async () => {
  const p = previewPage(['/r/b']);
  p.page.enterCartPreview();
  const shown = p.state.treemap.nodes;
  const draws = p.drawn.length;
  const hover = { path: '/r/a' };
  p.state.treemap.hover = hover;
  await p.page.stageMatches(['/r/b']);
  assert.equal(p.state.treemap.nodes, shown, 'the same preview, not a rebuild of an unchanged cart');
  assert.equal(p.drawn.length, draws, 'nothing redrawn');
  assert.equal(p.state.treemap.hover, hover, 'and the pointer keeps what it rests on');
});
