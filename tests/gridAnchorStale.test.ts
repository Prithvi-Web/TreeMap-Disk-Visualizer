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
  /** The Grid's scroller: its width is what the layout flows into. */
  scroll: { clientWidth: number };
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
  const scroll = { clientWidth: 1220 };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const mod = new Function(
    'GAP', 'MIN_SQ', 'MAX_SQ', 'gridScroll', 'state',
    'updateSelectionBar', 'renderGridWindow', 'renderGrid', 'hideTooltip', 'openPreview', 'gridNavigate', 'gridScrollClear', 'gridNoteClicked',
    `'use strict'; ${src}\nreturn { layoutGrid, onCellClick };`,
  )(
    12, 64, 256,
    scroll,
    state,
    () => {},
    () => {},
    () => { navigations.push(state.grid.path); },
    () => {},
    () => {},
    // A folder click goes through the page's gridNavigate (QA D44); here it
    // just moves, so a folder click in a future test lands somewhere.
    (p: string) => { state.grid.path = p; navigations.push(p); },
    // Scrolling a clicked tile clear of the bars (QA C04), and noting it for
    // the re-flow its click brings on (review F1.2), is the scroller's
    // business, driven in gridViewQa; there is no scroller to move here.
    () => {},
    () => {},
  ) as Pick<Harness, 'layoutGrid' | 'onCellClick'>;
  assert.equal(typeof mod.layoutGrid, 'function', 'layoutGrid is spliced into the page');
  assert.equal(typeof mod.onCellClick, 'function', 'onCellClick is spliced into the page');
  return { state, scroll, navigations, ...mod };
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

test('a re-flow of the same files keeps the anchor — the preview pane opening beside the Grid on the click that set it (QA C04)', () => {
  // The open preview pane narrows the page now (QA C04), and the Grid re-flows
  // its tiles into the narrower scroller — on the very click that set the
  // anchor, since a plain click on a file opens the pane. Dropping the anchor
  // there turned the next shift-click into a plain click: no range.
  const h = harness();
  h.layoutGrid(files(40));
  h.onCellClick({}, 5); // a plain click on a file: it is selected, and the pane opens
  assert.equal(h.state.grid.anchor, 5, 'the click sets the anchor (precondition)');
  assert.equal(h.state.grid.layout[3].y, 0, 'control: four tiles to a row at the full width');
  h.scroll.clientWidth = 1220 - 330; // the pane took its width
  h.layoutGrid(files(40));
  assert.ok(h.state.grid.layout[3].y > 0, 'control: three to a row beside the pane — the tiles really re-flowed');
  assert.equal(h.state.grid.anchor, 5, 'the same file is still at position 5, so it is still the anchor');
  h.onCellClick({ shiftKey: true }, 8);
  assert.deepEqual([...h.state.grid.selection].sort(),
    ['/root/f5.bin', '/root/f6.bin', '/root/f7.bin', '/root/f8.bin'], 'and a shift-click selects the range from it');

  // A rebuild that puts another file at that position still drops it.
  const r = harness();
  r.layoutGrid(files(40));
  r.onCellClick({}, 5);
  r.layoutGrid(files(40).reverse()); // a sort flipped: position 5 is f34 now
  assert.equal(r.state.grid.anchor, null, 'a different file at the anchor\'s position is not the anchor');
});
