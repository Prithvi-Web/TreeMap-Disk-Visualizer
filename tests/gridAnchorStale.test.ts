import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Grid view: the shift-click anchor outliving the layout it indexes into.
 *
 * `state.grid.anchor` is a POSITIONAL index into `state.grid.layout`, and
 * `layoutGrid()` rebuilds that array from scratch on every folder navigation,
 * sort change, search keystroke, rescan and resize. Nothing cleared the anchor,
 * so position 35 could survive into a three-entry filtered list and the range
 * loop would read `state.grid.layout[35].it` — a TypeError, in the middle of a
 * click handler, with the selection half applied.
 *
 * Both real functions are extracted from the built page and RUN here (the
 * fxViewEnter/motionWidth harness precedent) rather than pattern-matched: the
 * invariant is "a stale anchor cannot crash a shift-click, and a live anchor
 * still selects a range", which is behaviour, not a shape.
 */

const INDEX = readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

/** A function body, from its `function name(` anchor to its MATCHING brace. */
function braced(openAnchor: string): string {
  const start = INDEX.indexOf(openAnchor);
  assert.notEqual(start, -1, `block "${openAnchor}" exists in index.html`);
  let depth = 0;
  for (let i = INDEX.indexOf('{', start); i < INDEX.length; i++) {
    if (INDEX[i] === '{') depth++;
    else if (INDEX[i] === '}' && --depth === 0) return INDEX.slice(start, i + 1);
  }
  return assert.fail(`block "${openAnchor}" never closes`);
}

type Item = { name: string; path: string; size: number; type: 'file' | 'dir' };
type Cell = { it: Item; x: number; y: number; side: number };
type GridState = {
  grid: {
    path: string; sort: string; query: string;
    layout: Cell[]; totalH: number;
    selection: Set<string>; anchor: number | null;
    rangeStart: number; rangeEnd: number;
  };
};

type Harness = {
  state: GridState;
  layoutGrid(items: Item[]): void;
  onCellClick(e: { shiftKey?: boolean; metaKey?: boolean; ctrlKey?: boolean }, i: number): void;
  navigations: string[];
};

/** `n` same-sized files, so the layout is a plain left-to-right run of cells. */
function files(n: number): Item[] {
  return Array.from({ length: n }, (_, i) => ({
    name: `f${i}.bin`, path: `/root/f${i}.bin`, size: 1024, type: 'file' as const,
  }));
}

function harness(): Harness {
  const src = `${braced('function layoutGrid(items) {')}\n${braced('function onCellClick(e, i) {')}`;
  const state: GridState = {
    grid: {
      path: '/root', sort: 'size', query: '',
      layout: [], totalH: 0,
      selection: new Set<string>(), anchor: null,
      rangeStart: 0, rangeEnd: -1,
    },
  };
  const navigations: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const mod = new Function(
    'GAP', 'MIN_SQ', 'MAX_SQ', 'gridScroll', 'state',
    'updateSelectionBar', 'renderGridWindow', 'renderGrid', 'hideTooltip', 'openPreview',
    `'use strict'; ${src}\nreturn { layoutGrid, onCellClick };`,
  )(
    12, 48, 256,
    { clientWidth: 1220 },
    state,
    () => {},
    () => {},
    () => { navigations.push(state.grid.path); },
    () => {},
    () => {},
  ) as Pick<Harness, 'layoutGrid' | 'onCellClick'>;
  assert.equal(typeof mod.layoutGrid, 'function', 'layoutGrid is spliced into the page');
  assert.equal(typeof mod.onCellClick, 'function', 'onCellClick is spliced into the page');
  return { state, navigations, ...mod };
}

test('rebuilding the layout drops the anchor that indexed into the old one', () => {
  const h = harness();
  h.layoutGrid(files(40));
  h.onCellClick({}, 35);                       // plain click parks the anchor at 35
  assert.equal(h.state.grid.anchor, 35, 'a plain click sets the anchor (precondition)');

  h.layoutGrid(files(3));                      // a search keystroke narrows the list
  assert.equal(h.state.grid.anchor, null,
    'the anchor is positional — a rebuilt layout must not leave the old position behind');
});

test('a shift-click survives an anchor left behind by a rebuild path that forgot', () => {
  const h = harness();
  h.layoutGrid(files(3));
  // Simulate the rebuild path that does NOT go through the reset — a future
  // caller writing state.grid.layout itself, or any order-of-operations slip.
  // The point of use must be defensive on its own.
  h.state.grid.anchor = 35;

  assert.doesNotThrow(() => h.onCellClick({ shiftKey: true }, 1),
    'a stale anchor must clamp into range, not read past the end of the layout');
  const sel = [...h.state.grid.selection];
  assert.ok(sel.length > 0, 'the shift-click still selects something');
  for (const p of sel) {
    assert.ok(h.state.grid.layout.some((c) => c.it.path === p),
      `selection ${p} is a cell that currently exists`);
  }
});

test('a live anchor still shift-selects the whole range', () => {
  const h = harness();
  h.layoutGrid(files(40));
  h.onCellClick({}, 5);
  h.onCellClick({ shiftKey: true }, 8);
  assert.deepEqual([...h.state.grid.selection].sort(),
    ['/root/f5.bin', '/root/f6.bin', '/root/f7.bin', '/root/f8.bin'].sort(),
    'range select is the behaviour being protected, not the thing being removed');
});

test('a shift-click back toward the start of the list selects the same range', () => {
  const h = harness();
  h.layoutGrid(files(40));
  h.onCellClick({}, 8);
  h.onCellClick({ shiftKey: true }, 5);
  assert.equal(h.state.grid.selection.size, 4, 'anchor-after-target works in both directions');
  assert.ok(h.state.grid.selection.has('/root/f5.bin') && h.state.grid.selection.has('/root/f8.bin'));
});

test('an anchor at position 0 is a real anchor, not a missing one', () => {
  const h = harness();
  h.layoutGrid(files(40));
  h.onCellClick({}, 0);
  assert.equal(h.state.grid.anchor, 0);
  h.onCellClick({ shiftKey: true }, 2);
  assert.equal(h.state.grid.selection.size, 3, '0 is falsy but it is still an anchor');
});
