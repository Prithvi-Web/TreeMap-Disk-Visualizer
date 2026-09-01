import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Light theme: a status colour that is only defined in the dark block is a
 * contrast bug waiting to happen.
 *
 * The dark palette is built for near-black glass, so its saturated status
 * hues are all far too light to sit on a white card. `--warn` (#FFD60A)
 * measures ~1.4:1 there and was re-tuned in the light block long ago with a
 * comment saying exactly that — but the same reasoning was never applied to
 * its neighbours, and `--ok` (#30D158, ~1.95:1) shipped unreadable on every
 * light surface that states a good outcome: Folder Budgets' under-budget
 * figure, the duplicate "keep" tag, the cleanup/status greens.
 *
 * The rule these tests hold is deliberately not "--ok is #17803A". A hex pin
 * would be re-typed by the next designer and prove nothing. The invariant is
 * structural: any token the app ever puts in a `color:` declaration is a
 * TEXT colour, so it must be tuned for BOTH grounds it can land on, and the
 * light tuning must actually be a different colour — a light block that
 * repeats the dark hex is the bug wearing a declaration.
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
 * Every block whose selector matches, sliced to its MATCHING brace. A lazy
 * `[^}]*` would stop at the first `}` inside a nested at-rule and silently
 * drop half the tokens, which would make this file pass by seeing nothing.
 */
function rootBlocks(selector: RegExp): string[] {
  const out: string[] = [];
  const re = new RegExp(selector.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(SHEET))) {
    const open = SHEET.indexOf('{', m.index);
    if (open === -1) continue;
    let depth = 0;
    for (let i = open; i < SHEET.length; i++) {
      if (SHEET[i] === '{') depth++;
      else if (SHEET[i] === '}' && --depth === 0) { out.push(SHEET.slice(open + 1, i)); break; }
    }
  }
  return out;
}

/** name → value for every custom property declared across the given blocks. */
function declared(blocks: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const b of blocks) {
    for (const m of b.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  }
  return out;
}

// `:root {` only — the bracket in `:root[data-theme="light"]` keeps the two
// ladders apart, and a token may be (re)declared by any of the per-feature
// sheets, so both sides are the union of every matching block.
const DARK = declared(rootBlocks(/:root\s*\{/));
const LIGHT = declared(rootBlocks(/:root\[data-theme="light"\]\s*\{/));

/**
 * Tokens the page uses as a text colour, scanned over the WHOLE document and
 * not just the stylesheet: views paint status text through inline
 * `style="color:var(--ok)"` too, so a sheet-only scan would miss the very
 * surfaces (Trends, Compare) this bug was reported on. Tokens that no `:root`
 * declares are per-element inputs like `--tint`, always supplied by the
 * caller, and there is no theme block for them to be missing from.
 */
const textTokens = (() => {
  const found = new Set<string>();
  for (const decl of INDEX.matchAll(/(?:^|[;{\s"'`])color\s*:\s*([^;}"'`]*)/g)) {
    for (const v of decl[1].matchAll(/var\(\s*(--[a-z0-9-]+)/g)) found.add(v[1]);
  }
  return [...found].filter((t) => t in DARK).sort();
})();

test('every token used as a text colour is tuned for both themes', () => {
  // A guard on the guard: if the scan ever stops finding the palette, the
  // assertions below would pass over an empty list and prove nothing.
  assert.ok(textTokens.length >= 5, `the scan found the text palette (saw ${textTokens.join(', ') || 'nothing'})`);
  assert.ok(textTokens.includes('--ok'), '--ok is one of them — it is the colour this file was written for');

  const missing = textTokens.filter((t) => !(t in LIGHT));
  assert.deepEqual(missing, [],
    'a text colour defined only in the dark block carries a near-black-ground hue onto white cards');
});

test('the light theme re-tunes those tokens instead of repeating the dark hue', () => {
  const inherited = textTokens.filter((t) => t in LIGHT && LIGHT[t] === DARK[t]);
  assert.deepEqual(inherited, [],
    'a light declaration that repeats the dark value is not a tuning, it is the same contrast failure with extra steps');
});

/**
 * The token is the single source of truth for the good/green status colour.
 * Before `--ok` had a light value, `105-trends.css` patched the one surface
 * somebody noticed — the down-delta badge — with a literal hex under
 * `:root[data-theme="light"]`. Now that the token itself is tuned, a local
 * hex can only drift away from it: it would keep that one badge on an older
 * green while every other green moves. Greens come from `--ok`, everywhere.
 */
test('the good/green status colour comes from --ok, not from a per-component light override', () => {
  // Compare the captured declarations, not the match object: a failed
  // RegExp match prints its whole `input`, i.e. the entire stylesheet.
  const rule = SHEET.match(/:root\[data-theme="light"\][^{}]*\.delta-badge\.down\s*\{([^}]*)\}/);
  assert.equal(rule?.[1].trim() ?? null, null,
    'the light theme hard-codes the down-delta green instead of letting --ok carry it');
  assert.match(SHEET, /\.delta-badge\.down\s*\{[^}]*color:\s*var\(--ok\)/,
    'the badge still takes its green from the token');
});
