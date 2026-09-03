import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * The pointer is one dot — everywhere, in one family, inverted against the
 * page: a pale bead on the dark theme, an ink bead on the light one.
 *
 * The owner asked for the dot everywhere in the app, with every hover effect
 * kept so it is still obvious what is clickable, and then for it to invert
 * against the background. That splits into two rules this file holds, because
 * both are the kind that rot silently:
 *
 *  1. NO NATIVE CURSOR SURVIVES. A single `cursor: pointer` added later would
 *     flip the pointer back to the OS hand on one control and nowhere else,
 *     which reads as a bug rather than a style. So every `cursor:` value in
 *     the page — stylesheet, inline attribute, or assigned from JS — must be
 *     one of the dot tokens. The tokens are the only place a native keyword
 *     is allowed, and only as the fallback after the comma.
 *
 *  2. THE DOT STILL HAS TO SAY WHAT IT IS OVER. Keeping the hover effects was
 *     the owner's condition, and the dot carries its own share of that: the
 *     clickable variant is a wider ring, text is a caret, refusal is crossed.
 *     A family that collapsed to one artwork would satisfy rule 1 and lose the
 *     affordance, so the variants are named here.
 *
 * A cursor cannot be asserted by looking at pixels from Node. What CAN be held
 * is that the declarations exist, resolve to real artwork with a hotspot, and
 * that no path around them is left open — which is exactly where this kind of
 * change decays.
 */

const INDEX = readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

/** The app's own stylesheet: the first <style> block the built page carries. */
const SHEET = (() => {
  const open = INDEX.indexOf('<style>');
  assert.notEqual(open, -1, 'the built page carries an inline stylesheet');
  const close = INDEX.indexOf('</style>', open);
  assert.notEqual(close, -1, 'that stylesheet closes');
  return INDEX.slice(open + '<style>'.length, close);
})();

/** Every custom property declared by a block whose selector matches. */
function tokensIn(selector: RegExp): Record<string, string> {
  const out: Record<string, string> = {};
  const re = new RegExp(selector.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(SHEET))) {
    const open = SHEET.indexOf('{', m.index);
    if (open === -1) continue;
    let depth = 0;
    for (let i = open; i < SHEET.length; i++) {
      if (SHEET[i] === '{') depth++;
      else if (SHEET[i] === '}' && --depth === 0) {
        for (const d of SHEET.slice(open + 1, i).matchAll(/(--cur-[a-z-]+)\s*:\s*([^;]+);/g)) {
          out[d[1]] = d[2].trim();
        }
        break;
      }
    }
  }
  return out;
}

/**
 * The eight jobs a pointer does in this app, and the artwork each one gets.
 * `grab`/`grabbing` are Disk City's canvas, `ew` is the Trends brush handle,
 * `cross` is the brush's empty strip, `no` is a disabled control.
 */
const FAMILY = ['dot', 'hand', 'text', 'grab', 'grabbing', 'cross', 'ew', 'no'] as const;

/** The native keyword each variant is allowed to fall back to. */
const FALLBACK: Record<string, string> = {
  dot: 'auto', hand: 'pointer', text: 'text', grab: 'grab',
  grabbing: 'grabbing', cross: 'crosshair', ew: 'ew-resize', no: 'not-allowed',
};

test('the whole dot family is defined, as artwork with a hotspot and a native fallback', () => {
  const dark = tokensIn(/:root\s*\{/);
  for (const name of FAMILY) {
    const v = dark[`--cur-${name}`];
    assert.ok(v, `--cur-${name} must be declared — the app has a cursor it has no dot for`);
    assert.match(v, /^url\("data:image\/svg\+xml,/,
      `--cur-${name} must be inline SVG artwork: frontendContract forbids an external file`);
    assert.match(v, /"\)\s+\d+ \d+,/,
      `--cur-${name} needs an explicit hotspot, or the click lands where the art is not`);
    assert.ok(v.trim().endsWith(FALLBACK[name]),
      `--cur-${name} must fall back to ${FALLBACK[name]} if the image is refused`);
  }
});

test('the light theme re-draws the dot, it does not inherit the dark-theme bead', () => {
  const dark = tokensIn(/:root\s*\{/);
  const light = tokensIn(/:root\[data-theme="light"\]\s*\{/);
  for (const name of FAMILY) {
    assert.ok(light[`--cur-${name}`], `--cur-${name} must be re-declared for the light theme`);
    assert.notEqual(light[`--cur-${name}`], dark[`--cur-${name}`],
      `--cur-${name} is byte-identical in both themes — an inverted dot that does not invert`);
  }
});

test('the dot is the page default, inherited by everything that does not override it', () => {
  const html = SHEET.match(/\bhtml\s*\{([^}]*)\}/);
  assert.ok(html, 'there must be an `html` rule to root the cursor on');
  assert.match(html[1], /cursor:\s*var\(--cur-dot\)/,
    'cursor inherits, so setting it on html is what makes the dot reach every element');
});

/**
 * Values that are not artwork but are not a native cursor either: `none` hides
 * the pointer outright and `inherit` defers to the rule above it. Both are
 * fine; a bare `pointer`, `default`, `text` or `grab` is the whole bug.
 */
const NON_ART = new Set(['none', 'inherit', 'unset']);

test('no native cursor is left anywhere in the stylesheet', () => {
  const strays: string[] = [];
  for (const m of SHEET.matchAll(/(?<![-\w])cursor\s*:\s*([^;}]+)/g)) {
    const v = m[1].trim();
    if (v.startsWith('var(--cur-') || NON_ART.has(v)) continue;
    strays.push(v);
  }
  assert.deepEqual(strays, [], 'these stylesheet rules still show an OS cursor instead of the dot');
});

test('no native cursor is left in an inline style attribute', () => {
  const body = INDEX.slice(INDEX.indexOf('</style>'));
  const strays: string[] = [];
  for (const m of body.matchAll(/style="[^"]*?cursor:\s*([^;"]+)/g)) {
    const v = m[1].trim();
    if (v.startsWith('var(--cur-') || NON_ART.has(v)) continue;
    strays.push(v);
  }
  assert.deepEqual(strays, [], 'these inline styles still show an OS cursor instead of the dot');
});

/**
 * The CSS keywords this app has ever assigned from JS, plus the neighbours a
 * future hover handler would reach for. Matching against a keyword list rather
 * than "any literal" is deliberate: these assignments are ternaries over hit
 * names ('w', 'e', 'mid'), and flagging every string in the expression would
 * make the test fail on the hit test instead of on the cursor.
 */
const NATIVE = new Set([
  'auto', 'default', 'pointer', 'text', 'grab', 'grabbing', 'crosshair', 'move',
  'not-allowed', 'ew-resize', 'ns-resize', 'nesw-resize', 'nwse-resize',
  'col-resize', 'row-resize', 'zoom-in', 'zoom-out', 'progress', 'wait', 'help',
]);

test('no native cursor is left in the code that sets one from JS', () => {
  const strays: string[] = [];
  for (const m of INDEX.matchAll(/\.style\.cursor\s*=\s*([^;]+);/g)) {
    // '' clears the inline value and hands the element back to the stylesheet,
    // which is the dot — that is the one non-var assignment that is correct.
    for (const lit of m[1].matchAll(/'([^']*)'/g)) {
      if (NATIVE.has(lit[1])) strays.push(lit[1]);
    }
  }
  assert.deepEqual(strays, [], 'these JS assignments still show an OS cursor instead of the dot');
});
