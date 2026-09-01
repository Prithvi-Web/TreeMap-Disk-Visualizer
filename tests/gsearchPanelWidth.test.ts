import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * The global-search fly-out has to FIT.
 *
 * `.gsearch-panel` is positioned out of the sidebar — `left: calc(100% + 26px)`
 * off `.gsearch`, which lives inside `#sideNav` — so its right edge is a sum of
 * five separate numbers: the sidebar's margin, its padding, its width, the
 * fly-out offset, and the panel's own width. Any rule that touches one of those
 * without the other four in mind pushes the panel off-screen, and the bug that
 * produced this file did exactly that: a `@media (max-width: 700px)` width sized
 * for the 64px rail, applied while `/` had just EXPANDED the sidebar to 232px.
 * Roughly 170px of panel landed past the right edge of a 660px window.
 *
 * So this test does not pin any particular rule. It rebuilds the geometry from
 * the stylesheet — sidebar width/margin/padding per state, panel `left`/`width`
 * with every applicable `@media` layered on in source order — and asserts the
 * one thing that must always be true: at every window width from the app's
 * 640px floor upward, in BOTH sidebar states, left + width stays inside the
 * viewport. A future refactor that reintroduces a state-blind special case
 * fails here no matter which rule it hides in.
 *
 * (Below 640px the body's own `min-width: 640px` takes over and the page
 * scrolls horizontally by design, so the layout box never gets narrower than
 * the floor this test starts at.)
 */

const INDEX = readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

/** The single stylesheet, comments stripped — a comment's example values must
 *  never be mistaken for declarations by the parsing below. */
const CSS = (() => {
  const open = INDEX.indexOf('<style>');
  const close = INDEX.indexOf('</style>', open);
  assert.ok(open !== -1 && close > open, 'the built page carries a <style> block');
  return INDEX.slice(open + '<style>'.length, close).replace(/\/\*[\s\S]*?\*\//g, ' ');
})();

/** From `at` (or the '{' after it) to the MATCHING close brace. */
function braced(src: string, at: number): string {
  const open = src.indexOf('{', at);
  assert.notEqual(open, -1, 'the slice opens a block');
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(at, i + 1);
  }
  throw new Error('unbalanced braces in the built stylesheet');
}

function ruleAt(anchor: string): string {
  const at = CSS.indexOf(anchor);
  assert.notEqual(at, -1, `the built stylesheet still has a "${anchor.trim()}" rule`);
  return braced(CSS, at);
}

/** `prop: value` pairs of a flat rule. */
function decls(block: string): Record<string, string> {
  const body = block.slice(block.indexOf('{') + 1, block.lastIndexOf('}'));
  assert.ok(!body.includes('{'), 'decls() reads flat rules only');
  const out: Record<string, string> = {};
  for (const part of body.split(';')) {
    const colon = part.indexOf(':');
    if (colon === -1) continue;
    out[part.slice(0, colon).trim()] = part.slice(colon + 1).trim();
  }
  return out;
}

/** A margin/padding shorthand, expanded the way CSS expands it. */
function sides(shorthand: string): { top: string; right: string; bottom: string; left: string } {
  const [top, right = top, bottom = top, left = right] = shorthand.trim().split(/\s+/);
  return { top, right, bottom, left };
}

/** Every custom property this test resolves, read from the sheet, not guessed. */
function customProp(name: string): string {
  const hits = [...CSS.matchAll(new RegExp(`${name}\\s*:\\s*([^;}]+)`, 'g'))].map((m) => m[1].trim());
  assert.equal(hits.length, 1, `${name} is declared exactly once — a second declaration would fork this geometry`);
  return hits[0];
}
const VARS: Record<string, string> = {
  '--side-w': customProp('--side-w'),
  '--side-w-rail': customProp('--side-w-rail'),
};

/**
 * Resolve a CSS length expression to pixels: `var()`, `calc()`, `min()`,
 * `max()`, `vw` and `%` against the containing block. Anything else — a unit
 * this resolver does not know — trips the residue assertion rather than
 * silently evaluating to a wrong number.
 */
function px(expr: string, env: { vw: number; pct: number }): number {
  let e = expr.trim();
  for (let guard = 0; guard < 8 && e.includes('var('); guard++) {
    e = e.replace(/var\(\s*(--[\w-]+)\s*\)/g, (_m, name: string) => {
      const value = VARS[name];
      assert.ok(value !== undefined, `this test knows the value of ${name}`);
      return `(${value})`;
    });
  }
  e = e.replace(/(-?\d*\.?\d+)vw/g, (_m, n: string) => String((Number(n) / 100) * env.vw));
  e = e.replace(/(-?\d*\.?\d+)%/g, (_m, n: string) => String((Number(n) / 100) * env.pct));
  e = e.replace(/(-?\d*\.?\d+)px/g, '$1');
  e = e.replace(/\bcalc\(/g, '(').replace(/\bmin\(/g, 'Math.min(').replace(/\bmax\(/g, 'Math.max(');
  assert.match(
    e.replace(/Math\.(min|max)/g, ''),
    /^[\s\d.+\-*/(),]*$/,
    `"${expr}" resolves to plain arithmetic (an unhandled unit would make this test lie)`,
  );
  const n = Function(`"use strict"; return (${e});`)() as number;
  assert.ok(Number.isFinite(n), `"${expr}" evaluates to a finite length`);
  return n;
}

type Rule = { at: string; selector: string; body: string };

/** Flatten the sheet into rules, carrying each one's at-rule condition. */
function parseRules(src: string, at = ''): Rule[] {
  const out: Rule[] = [];
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1) break;
    const prelude = src.slice(i, open).trim();
    const block = braced(src, open);
    const body = block.slice(1, -1);
    if (prelude.startsWith('@')) {
      // Conditional groups hold rules; @keyframes and @font-face cannot style
      // the panel, so their bodies are skipped rather than mis-parsed.
      if (/^@(media|supports|container|layer)\b/.test(prelude)) {
        out.push(...parseRules(body, at ? `${at} and ${prelude}` : prelude));
      }
    } else {
      out.push({ at, selector: prelude, body });
    }
    i = open + block.length;
  }
  return out;
}
const RULES = parseRules(CSS);

/**
 * Does this selector style #gsearchResults itself? `.gsearch-panel` is also
 * worn by the treemap's query hints (`.gsearch-panel.tm-hints`), which is a
 * different element in a different container — rules aimed at THAT compound
 * must not be folded into this geometry.
 */
function stylesTheFlyout(selector: string): boolean {
  return selector.split(',').some((part) => {
    const compound = part.trim().split(/[\s>+~]+/).pop() ?? '';
    if (!compound.includes('.gsearch-panel')) return false;
    const leftover = compound.replace(/\.gsearch-panel\b/, '').replace(/:{1,2}[\w-]+(\([^)]*\))?/g, '');
    return !/[.#\w]/.test(leftover);
  });
}
const PANEL_RULES = RULES.filter((r) => stylesTheFlyout(r.selector));

/** Whether an at-rule condition holds at a given viewport width. */
function conditionHolds(at: string, vw: number): boolean {
  if (!at) return true;
  return at.split(/\s+and\s+/).every((clause) => {
    const c = clause.replace(/^@media/, '').trim();
    const m = /^\((max|min)-width:\s*([\d.]+)px\)$/.exec(c);
    assert.ok(m, `this test understands the media condition "${clause}" (teach it, do not skip it)`);
    return m![1] === 'max' ? vw <= Number(m![2]) : vw >= Number(m![2]);
  });
}

/** The panel's own `left` / `width` after every applicable rule is layered on. */
function panelLengths(vw: number): { left: string; width: string } {
  let left = '';
  let width = '';
  for (const rule of PANEL_RULES) {
    if (!conditionHolds(rule.at, vw)) continue;
    const d = decls(`{${rule.body}}`);
    for (const clamp of ['min-width', 'max-width']) {
      assert.ok(!(clamp in d), `the fly-out declares no ${clamp} — teach this test the clamp before adding one`);
    }
    if (d.left) left = d.left;
    if (d.width) width = d.width;
  }
  assert.ok(left && width, 'the fly-out declares both a left and a width');
  return { left, width };
}

const NAV = decls(ruleAt('\n#sideNav {'));
const NAV_RAIL = decls(ruleAt('\n#sideNav.collapsed {'));
const NAV_FIXED = decls(ruleAt('\n  #sideNav:not(.collapsed) {'));

/** The sidebar's outer box and inner padding, per state. */
function sidebarBox(vw: number, collapsed: boolean) {
  const env = { vw, pct: vw };
  const margin = sides(NAV.margin);
  const padding = sides(NAV.padding);
  return {
    // In flow the sidebar is the first grid column, at x = 0; under 900px an
    // expanded one goes `position: fixed; left: 0`. Both put its border box at
    // exactly its own left margin, which is what the pin below guarantees.
    left: px(margin.left, env),
    width: px(collapsed ? NAV_RAIL.width : NAV.width, env),
    padLeft: px(collapsed ? NAV_RAIL['padding-left'] : padding.left, env),
    padRight: px(collapsed ? NAV_RAIL['padding-right'] : padding.right, env),
  };
}

/** Where the fly-out's right edge lands, in viewport pixels. */
function flyout(vw: number, collapsed: boolean) {
  const nav = sidebarBox(vw, collapsed);
  // `.gsearch` is a stretched flex child, so it fills the sidebar's content box
  // and is the panel's containing block (it is the `position: relative` one).
  const boxLeft = nav.left + nav.padLeft;
  const boxWidth = nav.width - nav.padLeft - nav.padRight;
  const env = { vw, pct: boxWidth };
  const lengths = panelLengths(vw);
  const left = boxLeft + px(lengths.left, env);
  const width = px(lengths.width, env);
  return { left, width, right: left + width };
}

test('the fly-out is anchored inside the sidebar, off .gsearch', () => {
  // The whole geometry above rests on these two facts; if either moves, the
  // arithmetic is measuring something that no longer exists.
  const wrap = INDEX.indexOf('<div class="gsearch" id="gsearchWrap">');
  assert.notEqual(wrap, -1, '#gsearchWrap carries class "gsearch"');
  const panel = INDEX.indexOf('id="gsearchResults"');
  assert.ok(panel > wrap && panel < INDEX.indexOf('</div>', INDEX.indexOf('<nav class="tabbar"')),
    'the results panel is nested inside the .gsearch wrap');
  assert.match(ruleAt('\n.gsearch {'), /position:\s*relative/,
    '.gsearch is the panel\'s containing block');
  assert.match(NAV_FIXED.left ?? '', /^0(px)?$/,
    'under 900px the expanded sidebar pins to left: 0, so its margin is its whole offset');
});

test('the fly-out fits the window at the 640px floor, in both sidebar states', () => {
  for (const collapsed of [false, true]) {
    const state = collapsed ? 'rail' : 'expanded';
    const box = flyout(640, collapsed);
    assert.ok(
      box.right <= 640,
      `at 640px with the sidebar ${state}, the fly-out runs to x=${box.right} `
        + `(left ${box.left} + width ${box.width}) — ${(box.right - 640).toFixed(0)}px past the right edge`,
    );
  }
});

test('the fly-out never leaves the viewport at any width from 640px up', () => {
  for (let vw = 640; vw <= 1920; vw++) {
    for (const collapsed of [false, true]) {
      const box = flyout(vw, collapsed);
      assert.ok(
        box.right <= vw,
        `at ${vw}px with the sidebar ${collapsed ? 'rail' : 'expanded'}, the fly-out `
          + `runs to x=${box.right} — ${(box.right - vw).toFixed(0)}px past the right edge`,
      );
      assert.ok(box.width > 0, `at ${vw}px the fly-out still has a positive width`);
    }
  }
});
