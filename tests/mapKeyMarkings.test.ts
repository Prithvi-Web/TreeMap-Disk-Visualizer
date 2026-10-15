import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * The key under the map names the markings the map draws — design pass of
 * 14 Oct 2026 (G27).
 *
 * The map marks four things beyond size: a dashed indigo border on a
 * container TreeMap can look inside, a hatched block with a dashed amber edge
 * for what is staged for the Trash (the cart preview), a hollow dashed tile
 * for a cloud placeholder that is not on this disk, and a branch glyph on a
 * git repository. The key explained only the size ramp.
 *
 * The real drawTreemap and renderTmLegend are cut out of the built page and
 * run against a recording 2D context and a stub legend host: what is asserted
 * is that the key names exactly the markings this paint drew — no more, so it
 * never explains something absent, and no fewer.
 */

const INDEX = readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

function declSource(name: string): string {
  let start = INDEX.indexOf(`\nfunction ${name}(`);
  if (start !== -1) start += 1;
  if (start === -1) start = INDEX.indexOf(`const ${name} = {`);
  if (start === -1) {
    const m = new RegExp(`\\n(?:const|let) [^;\\n]*\\b${name} = `).exec(INDEX);
    assert.ok(m, `${name} is declared in the built page`);
    const at = m!.index + 1;
    return INDEX.slice(at, INDEX.indexOf(';', at) + 1);
  }
  let depth = 0;
  for (let i = INDEX.indexOf('{', INDEX.indexOf(name, start) + name.length); i < INDEX.length; i++) {
    if (INDEX[i] === '{') depth++;
    else if (INDEX[i] === '}' && --depth === 0) return INDEX.slice(start, i + 1) + ';';
  }
  return assert.fail(`${name} never closes`);
}

/** `names` and every top-level helper they turn out to need, found by running them. */
function load<T>(names: string[], deps: Record<string, unknown>, returns: string, run: (fn: T) => void): T {
  const keys = Object.keys(deps);
  const pulled = [...names];
  for (let attempt = 0; attempt < 40; attempt++) {
    const src = `'use strict'; ${pulled.map(declSource).join('\n')}\nreturn ${returns};`;
    try {
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      const fn = new Function(...keys, src)(...keys.map((k) => deps[k])) as T;
      run(fn);
      return fn;
    } catch (e) {
      const missing = /(\w+) is not defined/.exec(String((e as Error).message))?.[1];
      if (!missing || pulled.includes(missing)) throw e;
      pulled.push(missing);
    }
  }
  throw new Error(`${names.join(', ')} would not run after pulling in 40 helpers`);
}

/** A 2D context that does nothing but answer measureText and make gradients. */
function quietCtx() {
  const props: Record<string, unknown> = {
    measureText: (t: string) => ({ width: String(t).length * 6 }),
    createLinearGradient: () => ({ addColorStop() {} }),
    createPattern: () => null,
  };
  return new Proxy(props, {
    get(t, k: string) { return k in t ? t[k] : () => {}; },
    set(t, k: string, v) { t[k] = v; return true; },
  });
}

type Node = Record<string, unknown> & { path: string; x: number; y: number; w: number; h: number };
let seq = 0;
function node(over: Partial<Node> = {}): Node {
  const i = seq++;
  return { name: `n${i}`, path: `/r/n${i}`, size: 1e8, type: 'file', depth: 1, expanded: false, x: 0, y: 0, w: 20, h: 20, ...over };
}

/** Paint `nodes` as the rectangle map and render the key; the key's HTML. */
function keyFor(nodes: Node[], opts: { mode?: string; preview?: boolean; hideCloud?: boolean } = {}): string {
  const host = { innerHTML: '' };
  const state = {
    treemap: { nodes, hideCloud: !!opts.hideCloud, rootSize: 1e12, history: { active: false, diff: false }, pxRects: [] as unknown[],
      colorMode: 'size', mode: opts.mode ?? 'treemap', query: '' },
  };
  load<{ drawTreemap: () => void }>(['drawTreemap', 'renderTmLegend'], {
    $: (id: string) => (id === 'tmLegend' ? host : { clientWidth: 1020 }),
    treemapCanvasHeight: () => 1000,
    window: { devicePixelRatio: 1 },
    tmCanvas: { style: {}, width: 0, height: 0 },
    tmBuffer: { width: 0, height: 0 },
    tmBufCtx: quietCtx(),
    cssVar: () => '#888888',
    state,
    tmNodeCapNote: () => '', renderAltNote() {}, tmSetEmpty() {},
    renderSearchOverlay() {}, presentTreemap() {},
    cellRgb: () => [48, 209, 88],
    tmHatchPattern: () => null,
    tmPreview: { on: !!opts.preview },
    roundRect() {},
    formatBytes: (n: number) => `${n} B`,
  }, '{ drawTreemap }', (fns) => { host.innerHTML = ''; fns.drawTreemap(); });
  return host.innerHTML;
}

/** The markings the key names, in its own words. */
function named(html: string): string[] {
  const at = html.indexOf('tm-marks');
  if (at === -1) return [];
  return [...html.slice(at).matchAll(/<span class="mk"[^>]*>([\s\S]*?)<\/span>/g)]
    .map((m) => m[1].replace(/<[^>]*>/g, '').trim());
}

const BIG = { w: 30, h: 30 }; // 300 × 300 px on the 1000 px map: room for every glyph

test('G27: a map with no markings shows only the size key', () => {
  const html = keyFor([node(BIG), node({ ...BIG, x: 40 })]);
  assert.match(html, /legend-grad/, 'the size key is there');
  assert.deepEqual(named(html), [], 'and no markings are explained that the map does not draw');
});

test('G27: a container TreeMap can look inside is named by what it is — archive, disk image, Photos library', () => {
  assert.deepEqual(named(keyFor([node({ ...BIG, container: 'zip' })])), ['archive you can open']);
  assert.deepEqual(named(keyFor([node({ ...BIG, container: 'tgz' }), node({ ...BIG, x: 40, container: 'iso' })])),
    ['archive or disk image you can open']);
  assert.deepEqual(named(keyFor([node({ ...BIG, container: 'photos', type: 'dir', expanded: true })])), ['Photos library you can open']);
  assert.deepEqual(named(keyFor([node({ ...BIG, container: 'docker' })])), ['disk image you can open'], 'Docker\'s disk image is a disk image');
});

test('G27: a disk image TreeMap cannot list (.dmg), or an entry inside an archive, draws no dashed border — and the key says nothing of it', () => {
  assert.deepEqual(named(keyFor([node({ ...BIG, container: 'dmg' })])), []);
  assert.deepEqual(named(keyFor([node({ ...BIG, container: 'zip', virtual: true })])), []);
});

test('G27: a cloud placeholder drawn hollow is named; one hidden, or too small to be drawn hollow, is not', () => {
  assert.deepEqual(named(keyFor([node({ ...BIG, cloudPlaceholder: true })])), ['in the cloud, not on this disk']);
  assert.deepEqual(named(keyFor([node({ ...BIG, cloudPlaceholder: true })], { hideCloud: true })), []);
  assert.deepEqual(named(keyFor([node({ w: 0.5, h: 0.5, cloudPlaceholder: true })])), [], 'a 5 px placeholder is painted solid');
});

test('G27: a git repository carrying the branch glyph is named; one too small for the glyph is not', () => {
  assert.deepEqual(named(keyFor([node({ ...BIG, type: 'dir', expanded: true, gitRepo: true })])), ['git repository']);
  assert.deepEqual(named(keyFor([node({ w: 5, h: 3, type: 'dir', expanded: true, gitRepo: true })])), [], '50 × 30 px has no glyph');
});

test('G27: what the cart preview hatches is named as staged for the Trash', () => {
  assert.deepEqual(named(keyFor([node({ ...BIG, freed: true })], { preview: true })), ['staged for the Trash']);
});

test('G27: every marking at once, in one compact row, each with its swatch', () => {
  const html = keyFor([
    node({ ...BIG, container: 'zip' }),
    node({ ...BIG, x: 35, freed: true }),
    node({ ...BIG, x: 70, cloudPlaceholder: true }),
    node({ ...BIG, y: 40, type: 'dir', expanded: true, gitRepo: true }),
  ], { preview: true });
  assert.deepEqual(named(html), ['archive you can open', 'staged for the Trash', 'in the cloud, not on this disk', 'git repository']);
  const swatches = [...html.matchAll(/<span class="mk"[^>]*>\s*(<i class="mk-sw [^"]+"|<svg)/g)].length;
  assert.equal(swatches, 4, 'each marking is shown, not just named');
});

test('G27: the markings belong to the rectangle map — another layout\'s key does not inherit them', () => {
  // renderTmLegend also runs under the Sunburst, Circles and Voronoi, which
  // draw none of these marks; the last rectangle map's must not linger there.
  const nodes = [node({ ...BIG, container: 'zip' })];
  assert.deepEqual(named(keyFor(nodes, { mode: 'sunburst' })), []);
});
