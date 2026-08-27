import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { squarify } from '../src/utils/treemap';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
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
  const parts: string[] = [];
  for (const name of names) {
    const start = INDEX.indexOf(`function ${name}(`);
    assert.notEqual(start, -1, `function ${name} was located in public/index.html`);
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
  return new Function(`${parts.join('\n')}\nreturn ${returns};`)() as T;
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
  assert.match(body, /const staged = new Set\(paths\)/);
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
  const body = slice('  // Pass 1: cushion-shaded leaf fills.', '  // Pass 2: directory frames.');
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
  const fetcher = slice('function fetchScoresForTreemap', '$(\'tmColorSeg\').addEventListener');
  assert.match(fetcher, /!r\.n\.freed/, 'freed blocks are excluded from the scoring batch');
  const coverage = slice('function reclaimCoverageNote', 'Height for the treemap/sunburst canvas');
  assert.match(coverage, /r\.n\.freed\) continue;/, 'and from the coverage denominator');
});

test('the preview is read-only for the keyboard, not just the mouse', () => {
  // Delete used to trash a real file under a banner saying nothing had been
  // deleted: the mouse handlers were guarded and this block was not. Same
  // condition as the time slider, which was already here.
  const nav = slice("// Feature 6 — keyboard navigation in the treemap", "if (e.key === 'Escape')");
  assert.match(nav, /!state\.treemap\.history\.active && !tmPreview\.on/);
  assert.match(nav, /case 'Delete':/, 'the guarded block really is the one with Delete in it');
});
