import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * The dashboard card's two colour traps.
 *
 * Both are CSS-only defects, invisible to every behavioural test in the
 * suite because nothing about the DOM or the data changes — the wrong ink
 * simply lands on the right element:
 *
 *  1. `.sys-facts .fact span` was written for the LABEL ("Total disk"), but
 *     as a descendant rule it also paints anything span-shaped inside the
 *     VALUE. `FxNum.roll()` builds the rolled number out of nested spans
 *     (`.fx-roll`, `.fx-roll-d`, `.fx-roll-sizer`), so every rolled figure
 *     on the card rendered in the dimmed label grey. This is the exact
 *     `.host span` hazard 140-fx-numerals.css documents: its reset says
 *     `color: inherit` at (0,2,0) and a `.sys-facts .fact span` host rule
 *     at (0,2,1) outranks it. Specificity cannot be won here without
 *     escalating forever, so the host rule must stop reaching instead —
 *     the label is the `.fact`'s own child, the digits are not.
 *
 *  2. `.scan-status.error` carried a literal `#ff6b61`, a hue picked for
 *     near-black glass. On the light card it measures ~2.7:1 — the scan
 *     failure message, the one line a user most needs to read, was the
 *     least readable text on the page. `--danger` is theme-tuned in
 *     000-tokens.css and already carries every other error text in the app
 *     (`.toast.error .ic`, `#apQueryStatus.bad`), so the fix is the token,
 *     not a second local hex that would drift away from it.
 *
 * Neither test pins a hex or a line: the first asserts the shape of the
 * selector (it may not reach past the label), the second asserts measured
 * WCAG AA contrast on both grounds the text can land on.
 */

const INDEX = readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

/** The app's own stylesheet: the first <style> block the built page carries. */
const SHEET = (() => {
  const open = INDEX.indexOf('<style>');
  assert.notEqual(open, -1, 'the built page carries an inline stylesheet');
  const close = INDEX.indexOf('</style>', open);
  assert.notEqual(close, -1, 'that stylesheet closes');
  const css = INDEX.slice(open + '<style>'.length, close);
  assert.ok(css.includes('--lg-tint'), 'it is the main sheet, the one that defines the design tokens');
  return css;
})();

/**
 * Comments are stripped before the rules are parsed: the build concatenates
 * the source sheets verbatim, so a rule's "selector" otherwise arrives with
 * the whole file banner glued to its front and `:root` never matches itself.
 */
const CSS = SHEET.replace(/\/\*[\s\S]*?\*\//g, ' ');

/**
 * Every rule as { selector, body }. At-rules are not a special case here:
 * the prelude of `@media ... {` ends in a brace, so the rules NESTED inside
 * one are matched individually and land in this list on their own — which
 * is what these checks want, since a hazard does not stop being one for
 * living inside a media query.
 */
const RULES = [...CSS.matchAll(/([^{}]*)\{([^{}]*)\}/g)]
  .map((m) => ({ selector: m[1].trim(), body: m[2] }))
  .filter((r) => r.selector && !r.selector.startsWith('@'));

/** One selector split into its compounds and the combinators between them.
    A descendant combinator is the absence of a symbol, so it is spelled ' '
    rather than left implicit — the caller has to look at it either way. */
function chain(part: string): { compound: string; combinator: string }[] {
  const tokens = part.trim().replace(/\s*([>+~])\s*/g, ' $1 ').split(/\s+/).filter(Boolean);
  const out: { compound: string; combinator: string }[] = [];
  let combinator = '';
  for (const t of tokens) {
    if (t === '>' || t === '+' || t === '~') { combinator = t; continue; }
    out.push({ compound: t, combinator });
    combinator = ' ';
  }
  return out;
}

/* ── 1. The fact label may not paint the fact's value ── */

test('no rule reaches a span DESCENDANT of a sys-facts row — the rolled digits live in there', () => {
  const suspects = RULES.flatMap((r) => r.selector.split(',').map((p) => p.trim()))
    .filter((p) => p.includes('.sys-facts') && /\bspan\b/.test(p));

  // A guard on the guard: if the markup or the class name ever moves, this
  // scan would find nothing and wave the hazard through in silence.
  assert.ok(suspects.length >= 1, `the scan found the sys-facts span rules (saw ${suspects.join(' | ') || 'nothing'})`);

  const offenders = suspects.filter((p) => {
    const links = chain(p);
    return links.some((link, i) => /\bspan\b/.test(link.compound) && i > 0 && link.combinator !== '>');
  });
  assert.deepEqual(offenders, [],
    'a descendant span rule inside .sys-facts also matches the .fx-roll spans FxNum injects into the <b>, '
    + 'and at (0,2,1) it outranks the numerals reset — scope it to the label with a child combinator');
});

test('the fact label still reads as a label: dimmed, and only the label', () => {
  const label = RULES.find((r) => r.selector.split(',').some((p) => {
    const links = chain(p.trim());
    const last = links[links.length - 1];
    return links.some((l) => l.compound.includes('.sys-facts'))
      && last && /\bspan\b/.test(last.compound) && last.combinator === '>'
      && links[links.length - 2]?.compound.includes('.fact');
  }));
  assert.ok(label, 'the fact label is styled as the row\'s own child');
  assert.match(label!.body, /color:\s*var\(--text-2\)/,
    'the label keeps the secondary ink — the point of the fix is the value getting its own colour back, '
    + 'not the label losing its dimming');
});

/* ── 2. The scan error line is readable on both grounds ── */

/** name → value for every custom property declared in the matching blocks. */
function tokens(selector: RegExp): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of RULES) {
    if (!selector.test(r.selector)) continue;
    for (const m of r.body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  }
  return out;
}
// The bracket in `:root[data-theme="light"]` is what keeps the two ladders
// apart; `:root` alone would swallow both and compare a block with itself.
const DARK = tokens(/^:root$/);
const LIGHT = tokens(/^:root\[data-theme="light"\]$/);

function rgb(value: string): [number, number, number] {
  const hex = /^#([0-9a-f]{6})$/i.exec(value.trim());
  if (hex) return [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16)) as [number, number, number];
  const fn = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(value.trim());
  assert.ok(fn, `colour "${value}" is a hex or rgb()`);
  return [+fn![1], +fn![2], +fn![3]];
}
/** The alpha of an rgba(), or 1 for an opaque colour. */
function alpha(value: string): number {
  const m = /^rgba\(\s*[\d.]+[\s,]+[\d.]+[\s,]+[\d.]+[\s,/]+([\d.]+)\s*\)/i.exec(value.trim());
  return m ? +m[1] : 1;
}
function over(fg: string, bg: [number, number, number]): [number, number, number] {
  const a = alpha(fg), c = rgb(fg);
  return c.map((v, i) => a * v + (1 - a) * bg[i]) as [number, number, number];
}
/** WCAG 2.x relative luminance and contrast ratio. */
function luminance([r, g, b]: [number, number, number]): number {
  const f = (c: number) => (c /= 255) <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function contrast(a: [number, number, number], b: [number, number, number]): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

test('the scan error colour comes from the theme-tuned token, not a dark-only hex', () => {
  const rule = RULES.find((r) => r.selector.split(',').some((p) => p.trim() === '.scan-status.error'));
  assert.ok(rule, '.scan-status.error is styled');
  const colour = /(?:^|;)\s*color\s*:\s*([^;]+)/.exec(rule!.body)?.[1].trim();
  assert.equal(colour, 'var(--danger)',
    'a literal hex here is a dark-theme hue with no light tuning — the same failure --warn and --ok were '
    + 'already rescued from; --danger already carries every other error text in the app');
  assert.ok(DARK['--danger'] && LIGHT['--danger'], '--danger is tuned for both grounds');
  assert.notEqual(LIGHT['--danger'], DARK['--danger'],
    'a light declaration that repeats the dark value is the contrast failure with extra steps');
});

test('the scan error line clears WCAG AA on the card it sits on, in either theme', () => {
  // The status line sits on a glass card: --glass composited over the page.
  // Reading both from the sheet keeps this measurement honest if the palette
  // is ever retuned, instead of pinning yesterday's numbers.
  for (const [name, palette] of [['dark', DARK], ['light', LIGHT]] as const) {
    // A token the light block does not redeclare genuinely inherits the dark
    // value — that is the cascade, not a gap. --danger is the exception the
    // test above already pins, so read it strictly here.
    const page = rgb(palette['--bg-1'] ?? DARK['--bg-1']);
    const card = over(palette['--glass'] ?? DARK['--glass'], page);
    assert.ok(palette['--danger'], `the ${name} theme declares --danger`);
    const ink = rgb(palette['--danger']);
    const ratio = contrast(ink, card);
    // 12.5px is normal-size text: AA is 4.5:1, with no large-text discount.
    assert.ok(ratio >= 4.5,
      `the ${name} theme's error text measures ${ratio.toFixed(2)}:1 on the card — AA for 12.5px text is 4.5:1`);
  }
});
