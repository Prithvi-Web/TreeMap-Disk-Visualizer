import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * The map views tell the truth about what is on screen — the final hunt of
 * 24 Oct 2026, group B (C02, C20–C28, C70–C72).
 *
 * Every pin here RUNS the shipped code: the functions are cut out of the built
 * `public/index.html` by brace matching and evaluated with each global they
 * touch passed in (the mapViewTruth harness). The invariants are about what a
 * person sees, hears and what a key or a click does.
 */

const INDEX = readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const MARKUP = readFileSync(path.join(__dirname, '..', 'src', 'ui', 'markup', '015-view-treemap.html'), 'utf8');

/** `function name(…) {…}`, `const name = {…};` (cut by brace matching) or `const NAME = value;`. */
function declSource(name: string): string {
  let start = INDEX.indexOf(`function ${name}(`);
  if (start > 0 && INDEX.slice(start - 6, start) === 'async ') start -= 6;
  if (start === -1) start = INDEX.indexOf(`const ${name} = {`);
  if (start === -1) {
    let at = INDEX.indexOf(`const ${name} = `);
    if (at === -1) at = INDEX.indexOf(`let ${name} = `);
    assert.notEqual(at, -1, `${name} is declared in the built page`);
    return INDEX.slice(at, INDEX.indexOf(';', at) + 1);
  }
  let from = INDEX.indexOf(name, start) + name.length;
  if (INDEX[from] === '(') {
    for (let paren = 0; from < INDEX.length; from++) {
      if (INDEX[from] === '(') paren++;
      else if (INDEX[from] === ')' && --paren === 0) break;
    }
  }
  let depth = 0;
  for (let i = INDEX.indexOf('{', from); i < INDEX.length; i++) {
    if (INDEX[i] === '{') depth++;
    else if (INDEX[i] === '}' && --depth === 0) return INDEX.slice(start, i + 1) + ';';
  }
  return assert.fail(`${name} never closes`);
}

/** Evaluate the named declarations in one scope, with `deps` as the globals. */
function load<T>(names: string[], deps: Record<string, unknown>, returns: string, prelude = ''): T {
  const keys = Object.keys(deps);
  const src = `'use strict'; ${prelude}\n${names.map(declSource).join('\n')}\nreturn ${returns};`;
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function(...keys, src)(...keys.map((k) => deps[k])) as T;
}

type Node = { path: string; name?: string; size: number; type?: string; depth?: number; children?: Node[]; pruned?: boolean; isTrash?: boolean; freed?: boolean };

/* ══════════════ C02 — the keyboard moves through the folder on screen ══════════════ */

function kbHarness(mode: string) {
  const library: Node = { path: '/home/u/Library', name: 'Library', size: 900, type: 'dir' };
  const big: Node = { path: '/home/u/big', name: 'big', size: 100, type: 'dir', pruned: true }; // the first frame's budget withheld its children
  const root: Node = { path: '/home/u', name: 'u', size: 1000, type: 'dir', children: [library, big] };
  const state = {
    root,
    pathIndex: new Map<string, Node>([[root.path, root], [library.path, library], [big.path, big]]),
    treemap: { mode, rootPath: '/home/u/big', rootName: 'big', rootSize: 100, nodes: [] as Node[], kbSel: null as Node | null },
  };
  const said: string[] = [];
  const live = { set textContent(v: string) { said.push(v); }, get textContent() { return said[said.length - 1] || ''; } };
  const deps = {
    state,
    isSun: () => state.treemap.mode === 'sunburst',
    isCells: () => state.treemap.mode === 'circles' || state.treemap.mode === 'voronoi',
    presentView() {},
    kbShowTip() {},
    hideTooltip() {},
    $: (id: string) => (id === 'tmKbAnnounce' ? live : null),
    formatBytes: (b: number) => `${b} B`,
    cartHas: () => false,
  };
  const api = load<{ kbSiblings: () => Node[]; kbMove: (d: number) => void }>(
    ['kbSiblings', 'kbSelect', 'kbMove'], deps, '{ kbSiblings, kbMove }');
  return { state, said, ...api };
}

test('C02: in a folder the first frame pruned, j/k move through the rectangles the map draws there', () => {
  const h = kbHarness('treemap');
  // The server laid the map out from its whole store: the folder's contents
  // are drawn although the page's tree holds it pruned, with no children.
  h.state.treemap.nodes = [
    { path: '/home/u/big/sub', name: 'sub', size: 60, type: 'dir', depth: 1 },
    { path: '/home/u/big/sub/deep.bin', name: 'deep.bin', size: 50, type: 'file', depth: 2 },
    { path: '/home/u/big/movie.mov', name: 'movie.mov', size: 40, type: 'file', depth: 1 },
  ];
  assert.deepEqual(h.kbSiblings().map((n) => n.path), ['/home/u/big/sub', '/home/u/big/movie.mov'],
    'the drawn top level of the folder on screen, biggest first');
  h.kbMove(1);
  assert.equal(h.state.treemap.kbSel?.path, '/home/u/big/sub', 'j selects the biggest thing drawn here');
  assert.match(h.said[h.said.length - 1], /^sub, folder, 60 B, 60\.0 percent of this view/);
});

test('C02: one level further, in a folder the page never held, j never selects the scan root\'s folders', () => {
  const h = kbHarness('treemap');
  h.state.treemap.rootPath = '/home/u/big/sub';
  h.state.treemap.rootSize = 60;
  h.state.treemap.nodes = [{ path: '/home/u/big/sub/deep.bin', name: 'deep.bin', size: 50, type: 'file', depth: 1 }];
  assert.deepEqual(h.kbSiblings().map((n) => n.path), ['/home/u/big/sub/deep.bin']);
  h.kbMove(1);
  assert.equal(h.state.treemap.kbSel?.path, '/home/u/big/sub/deep.bin', 'never ~/Library, which is not on screen');
});

test('C02: the Trash cell and a preview\'s staged block are not stops for j/k', () => {
  const h = kbHarness('treemap');
  h.state.treemap.rootPath = '/home/u';
  h.state.treemap.rootSize = 1000;
  h.state.treemap.nodes = [
    { path: '/home/u/Library', name: 'Library', size: 900, type: 'dir', depth: 1 },
    { path: '/home/u — freed', name: 'Staged', size: 100, type: 'dir', depth: 1, freed: true },
    { path: '\0trash', name: 'Trash', size: 5000, type: 'dir', depth: 1, isTrash: true },
  ];
  assert.deepEqual(h.kbSiblings().map((n) => n.path), ['/home/u/Library']);
});

test('C02: in the sunburst, circles or Voronoi, a folder the page does not hold gives j/k nothing — never the scan root\'s folders', () => {
  for (const mode of ['sunburst', 'circles', 'voronoi']) {
    const h = kbHarness(mode);
    h.state.treemap.rootPath = '/home/u/big/sub'; // not in the page's tree
    assert.deepEqual(h.kbSiblings(), [], `${mode}: nothing to move through`);
    h.state.treemap.rootPath = '/home/u';
    assert.deepEqual(h.kbSiblings().map((n) => n.path), ['/home/u/Library', '/home/u/big'], `${mode}: a folder the page holds still answers`);
  }
});
