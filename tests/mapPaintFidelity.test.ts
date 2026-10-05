import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * What the map paints is what the map means — QA of 5 Oct 2026 (batch QA-6).
 *
 * The painters are cut out of the built `public/index.html` and RUN against a
 * recording 2D context (the fxChartsPerf precedent): every call is kept with
 * its arguments, `measureText` answers 6 px a character, and the assertions
 * are about the pixels' instructions — which text, at what width, in which
 * colour — rather than about how the source happens to spell them.
 */

const INDEX = readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

/** `function name(…) {…}`, `const name = {…};` (brace matched) or `const|let NAME = value;`. */
function declSource(name: string): string {
  let start = INDEX.indexOf(`function ${name}(`);
  if (start === -1) start = INDEX.indexOf(`const ${name} = {`);
  if (start === -1) {
    let at = INDEX.indexOf(`const ${name} = `);
    if (at === -1) at = INDEX.indexOf(`let ${name} = `);
    assert.notEqual(at, -1, `${name} is declared in the built page`);
    return INDEX.slice(at, INDEX.indexOf(';', at) + 1);
  }
  let depth = 0;
  for (let i = INDEX.indexOf('{', INDEX.indexOf(name, start) + name.length); i < INDEX.length; i++) {
    if (INDEX[i] === '{') depth++;
    else if (INDEX[i] === '}' && --depth === 0) return INDEX.slice(start, i + 1) + ';';
  }
  return assert.fail(`${name} never closes`);
}

function load<T>(names: string[], deps: Record<string, unknown>, returns: string): T {
  const keys = Object.keys(deps);
  const src = `'use strict'; ${names.map(declSource).join('\n')}\nreturn ${returns};`;
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function(...keys, src)(...keys.map((k) => deps[k])) as T;
}

type Call = [string, unknown[]];
type Grad = { kind: 'linear'; args: number[]; stops: Array<[number, string]> };

/** A 2D context that records every method call with its arguments; text is 6 px a character. */
function recordingCtx() {
  const calls: Call[] = [];
  const fills: unknown[] = []; // fillStyle at each fill()/fillRect()
  const props: Record<string, unknown> = {
    measureText: (t: string) => ({ width: String(t).length * 6 }),
    createLinearGradient: (...args: number[]) => {
      const g: Grad = { kind: 'linear', args, stops: [] };
      return Object.assign(g, { addColorStop: (o: number, c: string) => { g.stops.push([o, c]); } });
    },
  };
  const ctx: any = new Proxy(props, {
    get(t, k: string) {
      if (k in t) return t[k];
      return (...a: unknown[]) => {
        calls.push([k, a]);
        if (k === 'fill' || k === 'fillRect') fills.push(t.fillStyle);
      };
    },
    set(t, k: string, v) { t[k] = v; return true; },
  });
  return { ctx, calls, fills, texts: () => calls.filter(([k]) => k === 'fillText') };
}

/* ══════════════ D27 — sunburst labels fit, shorten, or go — never squeeze ══════════════ */

const LONG = 'com_apple_MobileAsset_iOSSimulatorRuntime';

function paintSunburst(ringT: number) {
  const rec = recordingCtx();
  const innerR0 = 94;
  const geo = { dpr: 1, cssW: 600, cssH: 600, cx: 300, cy: 300, rings: 2, outerR: innerR0 + 2 * ringT, innerR0, ringT };
  const arc = (name: string, a0: number, a1: number) => ({
    n: { name, path: '/r/' + name }, depth: 1, a0, a1, cx: 300, cy: 300, rInner: innerR0, rOuter: innerR0 + ringT,
  });
  const arcs = [arc(LONG, -Math.PI / 2, 0.6), arc('Docs', 0.6, 2.2), arc('ab', 2.2, 4.7)];
  const status = { textContent: '' };
  const render = load<(root: unknown, arcs: unknown[], geo: unknown) => void>(
    ['renderSunburstFrame', 'sunFitLabel', 'SUN_LABEL_MIN_CHARS', 'Canvas2D'], {
      tmBufCtx: rec.ctx,
      cssVar: () => '#000',
      cellRgb: () => [10, 132, 255],
      mix: (a: number[]) => a,
      sectorPath() {},
      $: () => status,
      state: { treemap: { history: { active: false } } },
      formatCount: String,
      formatBytes: (n: number) => `${n} B`,
      formatWhen: String,
      presentSunburst() {},
      renderTmLegend() {},
      window: { devicePixelRatio: 1 },
    }, 'renderSunburstFrame');
  render({ name: 'A folder whose name is far too long for the centre', size: 123456 }, arcs, geo);
  return rec;
}

test('D27: no sunburst text is drawn with fillText\'s squeeze argument', () => {
  // fillText(text, x, y, maxWidth) compresses the glyphs horizontally until
  // they fit. A ring label runs radially, so its room is the ring thickness,
  // and every real folder name was crushed into an unreadable smear.
  for (const ringT of [94, 20]) {
    const squeezed = paintSunburst(ringT).texts().filter(([, a]) => a.length > 3);
    assert.deepEqual(squeezed.map(([, a]) => a[0]), [], `ring ${ringT}px: nothing is squeezed to fit`);
  }
});

test('D27: a long name is shortened with "…" to the ring\'s room; one that fits is drawn whole', () => {
  const texts = paintSunburst(94).texts().map(([, a]) => String(a[0]));
  const long = texts.find((t) => t.startsWith('com_apple'));
  assert.ok(long, 'the long name is labelled');
  assert.ok(long!.endsWith('…'), `and shortened with an ellipsis (${long})`);
  assert.ok(long!.length * 6 <= 94 - 7, `inside the ring's ${94 - 7}px of room (${long!.length * 6}px)`);
  assert.ok(texts.includes('Docs'), 'a name that fits is drawn whole');
});

test('D27: a ring too thin for three letters and "…" gets no label rather than a stub', () => {
  const texts = paintSunburst(20).texts().map(([, a]) => String(a[0]));
  const stubs = texts.filter((t) => t.endsWith('…') && LONG.startsWith(t.slice(0, -1)));
  assert.deepEqual(stubs, [], `no "c…" or "co…" stub of the long name (${texts.join(' | ')})`);
  assert.ok(texts.includes('ab'), 'a two-letter name that fits whole is still drawn');
});

test('D27: the centre disc shortens the folder name to the disc rather than squeezing it', () => {
  const texts = paintSunburst(94).texts().map(([, a]) => String(a[0]));
  const centre = texts.find((t) => t.startsWith('A folder'));
  assert.ok(centre && centre.endsWith('…'), `the centre name is shortened (${centre})`);
  assert.ok(centre!.length * 6 <= 94 * 1.8, 'to the disc\'s width');
});
