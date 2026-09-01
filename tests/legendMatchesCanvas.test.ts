import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * The treemap's size key must be painted from the ramp the CELLS are painted
 * from — one source of truth, not two that happen to agree.
 *
 * The key under the map reads "1 MB [gradient] 10 GB+", and it is the only
 * thing on screen that says what the cell colours mean. It used to be a pure
 * CSS gradient over `--ok`, `--warn`, `--danger`, which matched the canvas by
 * coincidence: those three tokens held the dark palette's status hues, and
 * the canvas ramp's anchors were the same three hexes typed out again in JS.
 * The moment `--ok` and `--danger` were re-tuned in the light theme — correct
 * for the status TEXT they were added for, since #30D158 measures ~1.95:1 on
 * a white card — the key started explaining the picture in colours the
 * picture never used. Nothing failed, because nothing tied the two together.
 *
 * So the invariant here is not "the gradient is teal→amber→red". It is:
 *
 *   whatever colours the shipped key shows, at every point along it, are the
 *   colours the shipped painter produces for the sizes that point stands for,
 *   and they do not change with the theme — because the cells do not.
 *
 * Both sides are pulled out of the built page and RUN, so the assertions keep
 * holding when the ramp is re-tuned and fail the day the key stops following
 * it. Nothing below hard-codes a colour.
 */

const INDEX = readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

/* ─────────────────────────── slicing the page ─────────────────────────── */

/**
 * Scan forward from `open` (an index pointing at `{`) to its MATCHING brace.
 *
 * Quotes and comments are skipped: a `}` inside `'...'` or a `/* … *\/` would
 * otherwise close the block early and hand back a fragment that silently
 * fails to parse — the failure mode that makes a slicing test pass by seeing
 * nothing at all.
 */
function matchBrace(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); if (i === -1) break; continue; }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i + 2) + 1; if (i === 0) break; continue; }
    if (c === "'" || c === '"') {
      for (i++; i < src.length && src[i] !== c; i++) if (src[i] === '\\') i++;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i;
  }
  return -1;
}

/** One top-level `function NAME(...) { … }` declaration, verbatim. */
function fnSource(name: string): string | null {
  const at = INDEX.indexOf(`\nfunction ${name}(`);
  if (at === -1) return null;
  const open = INDEX.indexOf('{', at);
  const close = matchBrace(INDEX, open);
  assert.notEqual(close, -1, `function ${name} closes`);
  return INDEX.slice(at, close + 1);
}

/**
 * The size ramp exactly as the canvas uses it: the tier anchors, the hex →
 * rgb helper, the mixer and `sizeRgb`/`sizeColor`. Sliced from the first
 * anchor to the end of `sizeColor`, so a re-tune of any of it is picked up
 * here without editing this file.
 */
const RAMP_SRC = (() => {
  const a = INDEX.indexOf('const TIER_LO =');
  assert.notEqual(a, -1, 'the built page carries the size ramp anchors');
  const b = INDEX.indexOf('function sizeColor(', a);
  assert.notEqual(b, -1, 'the size ramp exposes sizeColor');
  const close = matchBrace(INDEX, INDEX.indexOf('{', b));
  assert.notEqual(close, -1, 'sizeColor closes');
  return INDEX.slice(a, close + 1);
})();

/**
 * `renderTmLegend` plus every page-level function it turns out to need,
 * resolved by running it and pulling in whatever it asks for.
 *
 * Naming the helper up front would pin this test to today's implementation:
 * the point is that the key is painted from the ramp, not that some
 * particular function does the painting. So the bundle grows until it runs —
 * a helper that is renamed, split or inlined is followed automatically, and a
 * helper the page does not define at top level fails with its own name in the
 * message rather than a bare ReferenceError.
 */
function renderSizeLegend(): string {
  const legend = fnSource('renderTmLegend');
  assert.ok(legend, 'the built page defines renderTmLegend — the footer key lives there');
  const pulled: string[] = [];
  for (let attempt = 0; attempt < 8; attempt++) {
    const stubs = `
      const host = { innerHTML: '' };
      const $ = () => host;
      const state = { treemap: { colorMode: 'size', history: { active: false, diff: false } } };
    `;
    const src = `${stubs}\n${RAMP_SRC}\n${pulled.join('\n')}\n${legend}\nrenderTmLegend();\nreturn host.innerHTML;`;
    try {
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      return new Function(src)() as string;
    } catch (e) {
      const missing = /(\w+) is not defined/.exec(String((e as Error).message))?.[1];
      const extra = missing && fnSource(missing);
      assert.ok(extra, `the size key's paint path needs "${missing}", and the page declares no top-level function by that name`);
      pulled.push(extra);
    }
  }
  throw new Error('renderTmLegend still would not run after pulling in 8 helpers');
}

const LEGEND_HTML = renderSizeLegend();

/* ─────────────────────────── reading the key ──────────────────────────── */

type Stop = { rgb: [number, number, number]; pos: number };

/**
 * The colour stops of the gradient the key actually renders.
 *
 * Positions are optional in CSS — stops without one are spread evenly between
 * their positioned neighbours — so they are filled in the same way here,
 * otherwise a legal three-stop gradient would read as three stops all at 0.
 */
function parseGradient(css: string): Stop[] {
  const g = /linear-gradient\(([^;"']*)\)/.exec(css);
  assert.ok(g, `the size key paints a gradient of its own — found instead: ${css}`);
  const raw = g[1].split(/,(?![^(]*\))/).map((s) => s.trim()).filter((s) => /rgba?\(|#[0-9a-f]{3,8}/i.test(s));
  assert.ok(raw.length >= 2, 'a colour ramp needs at least two stops');
  const stops: { rgb: [number, number, number]; pos: number | null }[] = raw.map((s) => {
    const rgb = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(s);
    const hex = /#([0-9a-f]{6})\b/i.exec(s);
    assert.ok(rgb || hex, `stop "${s}" states a colour this test can read`);
    const c: [number, number, number] = rgb
      ? [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])]
      : [parseInt(hex![1].slice(0, 2), 16), parseInt(hex![1].slice(2, 4), 16), parseInt(hex![1].slice(4, 6), 16)];
    const p = /([\d.]+)%/.exec(s);
    return { rgb: c, pos: p ? Number(p[1]) / 100 : null };
  });
  if (stops[0].pos === null) stops[0].pos = 0;
  if (stops[stops.length - 1].pos === null) stops[stops.length - 1].pos = 1;
  for (let i = 1; i < stops.length - 1; i++) {
    if (stops[i].pos !== null) continue;
    let j = i;
    while (stops[j].pos === null) j++;
    const from = stops[i - 1].pos!, span = (stops[j].pos! - from) / (j - i + 1);
    for (let k = i; k < j; k++) stops[k].pos = from + span * (k - i + 1);
  }
  return stops as Stop[];
}

/** The colour the key shows at `t` along its width, sRGB-interpolated as CSS does. */
function keyAt(stops: Stop[], t: number): [number, number, number] {
  if (t <= stops[0].pos) return stops[0].rgb;
  for (let i = 1; i < stops.length; i++) {
    if (t > stops[i].pos) continue;
    const a = stops[i - 1], b = stops[i];
    const f = b.pos === a.pos ? 0 : (t - a.pos) / (b.pos - a.pos);
    return [0, 1, 2].map((k) => a.rgb[k] + (b.rgb[k] - a.rgb[k]) * f) as [number, number, number];
  }
  return stops[stops.length - 1].rgb;
}

/** The painter itself, and the byte range its ramp spans. */
const PAINTER = (() => {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function(`${RAMP_SRC}\nreturn { sizeRgb, TIER_LO, TIER_HI };`)() as {
    sizeRgb: (bytes: number) => [number, number, number];
    TIER_LO: number;
    TIER_HI: number;
  };
})();

/** The size a point `t` along the key stands for — the ramp's own log domain. */
function bytesAt(t: number): number {
  return 10 ** (PAINTER.TIER_LO + t * (PAINTER.TIER_HI - PAINTER.TIER_LO));
}

/* ────────────────────────── the sheet's side ──────────────────────────── */

/** The app's own stylesheet: the inline block that declares the design tokens. */
const SHEET = (() => {
  const open = INDEX.indexOf('<style>');
  assert.notEqual(open, -1, 'the built page carries its stylesheet inline');
  const close = INDEX.indexOf('</style>', open);
  return INDEX.slice(open + '<style>'.length, close);
})();

/** Every rule body whose selector matches, sliced to its MATCHING brace. */
function ruleBodies(selector: RegExp): string[] {
  const out: string[] = [];
  const re = new RegExp(selector.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(SHEET))) {
    const open = SHEET.indexOf('{', m.index);
    if (open === -1) continue;
    const close = matchBrace(SHEET, open);
    if (close !== -1) out.push(SHEET.slice(open + 1, close));
  }
  return out;
}

/** name → value for every custom property declared across the given bodies. */
function declared(bodies: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const b of bodies) for (const m of b.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}

// `:root {` only — the bracket in `:root[data-theme="light"]` keeps the two
// ladders apart, and a token may be re-declared by any per-feature sheet.
const DARK = declared(ruleBodies(/:root\s*\{/));
const LIGHT = declared(ruleBodies(/:root\[data-theme="light"\]\s*\{/));

/**
 * Every sheet rule that styles the key's own box, found through the class the
 * shipped markup gives it rather than a name typed here.
 */
const KEY_RULES = (() => {
  const cls = /<div[^>]*class="([^"]+)"/.exec(LEGEND_HTML);
  assert.ok(cls, `the key's gradient box carries a class: ${LEGEND_HTML}`);
  const names = cls[1].trim().split(/\s+/);
  return names.flatMap((n) => ruleBodies(new RegExp(`[^{}]*\\.${n}(?![\\w-])[^{}]*\\{`)));
})();

/* ──────────────────────────── the invariants ──────────────────────────── */

test('the size key is painted from the ramp the cells are painted from', () => {
  const stops = parseGradient(LEGEND_HTML);
  // Sampled across the whole width rather than at the anchors: a key with too
  // few stops reproduces the endpoints perfectly and still straightens out
  // the ramp's amber knee in the middle, which is precisely the part of the
  // picture a viewer uses the key to read.
  let worst = { t: 0, key: [0, 0, 0], cells: [0, 0, 0], off: -1 };
  for (let i = 0; i <= 100; i++) {
    const t = i / 100;
    const key = keyAt(stops, t);
    const cells = PAINTER.sizeRgb(bytesAt(t));
    const off = Math.max(...[0, 1, 2].map((k) => Math.abs(key[k] - cells[k])));
    if (off > worst.off) worst = { t, key, cells, off };
  }
  // 1/255 of slack for rounding a stop to integer channels; anything larger
  // is the key and the map telling different stories about the same bytes.
  assert.ok(
    worst.off <= 1,
    `at ${(worst.t * 100).toFixed(0)}% along the key it shows rgb(${worst.key.map(Math.round)}) `
    + `while the painter gives rgb(${worst.cells}) for ${bytesAt(worst.t).toExponential(2)} bytes`,
  );
});

test('the key does not change colour with the theme, because the cells do not', () => {
  // The cells are painted from JS literals, so a cell is the same colour in
  // both themes. Any theme-varying token in the key's paint — inline or from
  // the sheet — is therefore a drift the page cannot detect: --ok, --warn and
  // --danger are TEXT tokens, deliberately re-tuned for light grounds, so a
  // key built from them is wrong in one theme no matter which theme it was
  // eyeballed in. Which tokens vary is read off the page, not listed here.
  const used = [...`${LEGEND_HTML} ${KEY_RULES.join(' ')}`.matchAll(/var\(\s*(--[a-z0-9-]+)/g)].map((m) => m[1]);
  const varying = [...new Set(used)].filter((t) => LIGHT[t] !== undefined && LIGHT[t] !== DARK[t]);
  assert.deepEqual(
    varying,
    [],
    `the size key is painted through ${varying.map((t) => `${t} (${DARK[t]} dark / ${LIGHT[t]} light)`).join(', ')}, `
    + 'so it shows one thing in dark theme and another in light while the map shows neither',
  );
});

test('no stylesheet rule repaints the key behind the ramp', () => {
  // The ramp paint only wins if the sheet is not painting the same box from
  // tokens underneath it — an inline background overrides a class rule, but a
  // leftover `background` in the sheet is the second source of truth waiting
  // for the inline one to be dropped again.
  assert.ok(KEY_RULES.length > 0, 'the key keeps its geometry in the sheet');
  for (const body of KEY_RULES) {
    for (const d of body.split(';')) {
      if (!/^\s*background(-image|-color)?\s*:/.test(d)) continue;
      assert.fail(`the sheet still paints the size key — "${d.trim()}" must come from the canvas ramp instead`);
    }
  }
});

test('the numbers at the ends of the key are the ends of the ramp', () => {
  // "1 MB … 10 GB+" is a claim about the ramp's domain. If the anchors move
  // and the labels do not, every colour in between is being read against the
  // wrong size — the same class of lie as the wrong hue, harder to spot.
  const labels = [...LEGEND_HTML.matchAll(/>\s*([\d.]+)\s*(B|KB|MB|GB|TB)\+?\s*</g)];
  assert.equal(labels.length, 2, `the key labels both ends: ${LEGEND_HTML}`);
  const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];
  const bytes = labels.map((l) => Number(l[1]) * 1024 ** UNITS.indexOf(l[2]));
  assert.equal(Math.round(bytes[0]), Math.round(bytesAt(0)), 'the left label is the bottom of the ramp');
  assert.equal(Math.round(bytes[1]), Math.round(bytesAt(1)), 'the right label is the top of the ramp');
});
