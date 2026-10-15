import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-diskCityColour-data-');

import { lift, INDEX } from './fixtures/liftFrontend';

/**
 * Disk City opens coloured by Size (design pass G16).
 *
 * It opened in Reclaim: before anything is scored every building wears the
 * unscored grey, and once scored nearly all of them land mid-ramp, so the
 * city read as one amber block. Size is the colour the Treemap opens in, on
 * the same ramp, so the two views of one folder now open looking alike.
 *
 * A choice someone made still wins. Earlier builds wrote the mode they opened
 * in to storage on every visit, so a stored "reclaim" is not evidence that
 * anyone chose it; a stored "type" or "age" is, because only a click ever
 * stored either. A choice is now stored only when it is made.
 */

/** The source of a top-level function in the built page, by brace matching. */
function sourceOf(name: string): string {
  const start = INDEX.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `function ${name} is in the built page`);
  let depth = 0;
  for (let i = INDEX.indexOf('{', start); i < INDEX.length; i++) {
    if (INDEX[i] === '{') depth++;
    else if (INDEX[i] === '}' && --depth === 0) return INDEX.slice(start, i + 1);
  }
  assert.fail(`function ${name} has a balanced body`);
}

/** A localStorage stand-in that records what is written. */
function storage(initial: Record<string, string>): { api: { getItem(k: string): string | null; setItem(k: string, v: string): void }; writes: Array<[string, string]> } {
  const data = new Map(Object.entries(initial));
  const writes: Array<[string, string]> = [];
  return {
    api: {
      getItem: (k) => (data.has(k) ? (data.get(k) as string) : null),
      setItem: (k, v) => { writes.push([k, v]); data.set(k, v); },
    },
    writes,
  };
}

const storedColour = (initial: Record<string, string>): string =>
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  (new Function('localStorage', `'use strict'; ${sourceOf('cityColourStored')}\nreturn cityColourStored();`) as (ls: unknown) => string)(storage(initial).api);

test('G16: with nothing chosen, Disk City opens coloured by Size', () => {
  assert.equal(storedColour({}), 'size', 'a first visit');
  assert.equal(storedColour({ 'tm-citycolour': 'reclaim' }), 'size',
    'the "reclaim" an earlier build stored on every visit is not a choice anyone made');
  assert.equal(storedColour({ 'tm-citycolour': 'nonsense' }), 'size', 'nor is a value no build offers');
  // The state literal reads it, so the very first paint is already Size.
  assert.match(INDEX, /colour: cityColourStored\(\),/, 'the city state starts from the stored choice, or Size');
  assert.doesNotMatch(INDEX, /colour: localStorage\.getItem\('tm-citycolour'\) \|\| 'reclaim'/, 'not from the old Reclaim default');
});

test('G16: a choice that was made still wins', () => {
  assert.equal(storedColour({ 'tm-citycolour': 'type' }), 'type', 'Type, chosen in an earlier build — only a click ever stored it');
  assert.equal(storedColour({ 'tm-citycolour': 'age' }), 'age', 'Age, likewise');
  assert.equal(storedColour({ 'tm-citycolour-picked': 'reclaim' }), 'reclaim', 'Reclaim, chosen in this build');
  assert.equal(storedColour({ 'tm-citycolour-picked': 'size', 'tm-citycolour': 'type' }), 'size', 'the newest choice over an older one');
  const throwing = { getItem() { throw new Error('storage refused'); } };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const read = new Function('localStorage', `'use strict'; ${sourceOf('cityColourStored')}\nreturn cityColourStored();`) as (ls: unknown) => string;
  assert.equal(read(throwing), 'size', 'storage that refuses to be read is no choice either');
});

test('G16: the setter stores a mode only when it was picked, never on the visit that applies it', () => {
  const run = (requested: string, picked: boolean): { mode: string; writes: Array<[string, string]> } => {
    const s = storage({});
    const state = { city: { colour: 'size', blocks: [] as unknown[] } };
    const seg = { querySelectorAll: () => [] as unknown[] };
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const set = new Function('localStorage', 'state', '$', 'cityMode', 'CITY_COLOUR_LABEL', 'cityJitter', 'cityRgb', 'drawCity', 'cityRefreshCard', 'cityFetchFacts',
      `'use strict'; ${sourceOf('citySetColour')}\nreturn citySetColour;`)(
      s.api, state, () => seg, lift(['cityMode'], 'cityMode'), lift(['CITY_COLOUR_LABEL'], 'CITY_COLOUR_LABEL'),
      (rgb: unknown) => rgb, () => [0, 0, 0], () => {}, () => {}, () => {},
    ) as (m: string, p?: boolean) => void;
    set(requested, picked);
    return { mode: state.city.colour, writes: s.writes };
  };
  assert.deepEqual(run('type', false), { mode: 'type', writes: [] }, 'opening the view in a mode is not choosing it');
  assert.deepEqual(run('type', true), { mode: 'type', writes: [['tm-citycolour-picked', 'type']] }, 'a click is');
  assert.deepEqual(run('nonsense', true), { mode: 'size', writes: [['tm-citycolour-picked', 'size']] },
    'and what is stored is the sanitised mode, which falls back to Size');
  const click = INDEX.slice(INDEX.indexOf("$('cityColorSeg').addEventListener('click'"), INDEX.indexOf("$('cityUpBtn').addEventListener"));
  assert.match(click, /citySetColour\(btn\.dataset\.c, true\)/, 'the Color buttons pass that they were picked');
  const mount = INDEX.slice(INDEX.indexOf("id: 'city',"), INDEX.indexOf('unmount()', INDEX.indexOf("id: 'city',")));
  assert.match(mount, /citySetColour\(state\.city\.colour\);/, 'the visit applies the mode without storing it');
});

test('G16: Size is a Color the city offers, keyed by the size ramp the Treemap uses', () => {
  const at = INDEX.indexOf('id="cityColorSeg"');
  const seg = INDEX.slice(at, INDEX.indexOf('</div>', at));
  assert.match(seg, /<button role="tab" type="button" data-c="size" aria-selected="true"[^>]*>Size<\/button>/,
    'a Size button, selected before the script runs');
  assert.equal((seg.match(/aria-selected="true"/g) || []).length, 1, 'and only that one');
  const labels = lift<Record<string, string>>(['CITY_COLOUR_LABEL'], 'CITY_COLOUR_LABEL');
  assert.equal(labels.size, 'its size, from 1 MB or less to 10 GB or more', 'its legend sentence names the ends of the ramp, as the ramp clamps them');
  const ramp = lift<{ sizeRgb: (b: number) => number[] }>(['hexToRgb', 'TIER_LO', 'C_TEAL', 'mix', 'sizeRgb'], '({ sizeRgb })');
  assert.deepEqual(ramp.sizeRgb(1), ramp.sizeRgb(1e6), 'control: everything up to 1 MB wears the first colour');
  assert.deepEqual(ramp.sizeRgb(1e12), ramp.sizeRgb(1e10), 'control: everything from 10 GB wears the last');
  assert.notDeepEqual(ramp.sizeRgb(2e6), ramp.sizeRgb(1e6), 'control: and between them the colour moves');
  // Each building is painted from sizeRgb, the Treemap's own ramp.
  const kit = lift<{ cityRgb: (n: unknown, m: string) => number[]; sizeRgb: (b: number) => number[] }>(
    ['hexToRgb', 'TIER_LO', 'C_TEAL', 'mix', 'sizeRgb', 'cityRgb'], '({ cityRgb, sizeRgb })',
  );
  for (const size of [0, 5e5, 3e6, 2e8, 4e9, 2e10]) {
    assert.deepEqual(kit.cityRgb({ path: '/r/x', size, type: 'dir' }, 'size'), kit.sizeRgb(size), `a ${size}-byte building`);
  }
  assert.deepEqual(kit.cityRgb({ path: '/r/x', size: 2e10 }, 'size'), [255, 69, 58], 'the top of the ramp is the red the Treemap draws');
  const chrome = sourceOf('renderCityChrome');
  assert.match(chrome, /c\.colour === 'size'[\s\S]{0,80}sizeRampCss\(\)/, 'the legend keys Size with the ramp itself');
});

test('G16: the height and colour groups say what they are in words on screen', () => {
  const toolbar = INDEX.slice(INDEX.indexOf('id="view-city"'), INDEX.indexOf('id="cityWrap"'));
  assert.match(toolbar, /<span class="tb-label"[^>]*>Height<\/span>\s*<div class="seg" id="cityHeightSeg"/, 'a visible "Height" before the height buttons');
  assert.match(toolbar, /<span class="tb-label"[^>]*>Color<\/span>\s*<div class="seg" id="cityColorSeg"/,
    'a visible "Color" before the colour buttons — the spelling every other visible word in the app uses');
  assert.doesNotMatch(toolbar, />Colour</, 'never "Colour" on screen');
  assert.match(INDEX, /#view-city \.tb-label \{[^}]*color: var\(--text-2\)/, 'styled as the Treemap toolbar styles its own "Depth" label');
});

/* ── The ramp pops in both themes (the owner's standing rule) ─────────────── */

/** sRGB → CIE L*a*b* (D65), returning [L*, C*ab]. */
function lab(rgb: number[]): [number, number] {
  const lin = (v: number): number => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const [r, g, b] = rgb.map(lin);
  const X = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
  const Y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const Z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const f = (t: number): number => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [116 * f(Y) - 16, Math.hypot(500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z)))];
}

test('G16: the top of the size ramp stays saturated on every roof, near and far, in both themes (C*ab ≥ 60)', () => {
  const kit = lift<{
    sizeRgb: (b: number) => number[]; cityJitter: (rgb: number[], p: string) => number[];
    cityAirRgb: (rgb: number[], t: number, bg: number[]) => number[]; cityShade: (rgb: number[], k: number) => string; hexToRgb: (h: string) => number[];
  }>(['hexToRgb', 'TIER_LO', 'C_TEAL', 'mix', 'sizeRgb', 'cityJitter', 'CITY_AIR_MAX', 'cityAirRgb', 'cityShade'], '({ sizeRgb, cityJitter, cityAirRgb, cityShade, hexToRgb })');
  // Every --bg-1 the tokens define: the backdrop the far roofs recede toward (cityBackdropRgb).
  const backdrops = [...INDEX.matchAll(/--bg-1:\s*(#[0-9a-fA-F]{6});/g)].map((m) => m[1]);
  assert.ok(backdrops.length >= 2, `a dark and a light backdrop: ${backdrops.join(', ')}`);
  // The roof's own paint factors, as drawCity uses them for a building at rest.
  const draw = sourceOf('drawCity');
  assert.match(draw, /tGrad\.addColorStop\(0, cityShade\(rgb, isHover \? 1\.3 : 1\.1\)\)/);
  assert.match(draw, /tGrad\.addColorStop\(1, cityShade\(rgb, isHover \? 1\.08 : 0\.9\)\)/);
  assert.match(draw, /ctx\.fillStyle = cityShade\(rgb, isHover \? 1\.24 : 1\)/);
  assert.match(draw, /const rgb = cityAirRgb\(b\.rgb, cityDepthT\(b\), bg\)/, 'every face is drawn from the receded colour');
  const top = kit.sizeRgb(2e10);
  let worst = { c: Infinity, at: '' };
  for (const bgHex of backdrops) {
    const bg = kit.hexToRgb(bgHex);
    // Paths spread the per-building jitter over its whole range.
    for (let p = 0; p < 400; p++) {
      const base = kit.cityJitter(top, `/Volumes/x/building-${p}`);
      for (let t = 0; t <= 1.0001; t += 0.125) {
        for (const k of [1.1, 1, 0.9]) {
          const m = /rgba\((\d+),(\d+),(\d+),/.exec(kit.cityShade(kit.cityAirRgb(base, t, bg), k)) as RegExpExecArray;
          const c = lab([Number(m[1]), Number(m[2]), Number(m[3])])[1];
          if (c < worst.c) worst = { c, at: `bg ${bgHex}, depth ${t.toFixed(3)}, shade ${k}, path ${p}` };
        }
      }
    }
  }
  assert.ok(worst.c >= 60, `the top of the ramp washes out to C*ab ${worst.c.toFixed(1)} (${worst.at})`);
});
