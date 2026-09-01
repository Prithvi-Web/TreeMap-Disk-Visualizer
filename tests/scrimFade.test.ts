import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * The nav scrim's FADE, not its resting state.
 *
 * tests/overlayLayering.test.ts already pins the scrim's rank while the
 * overlay sidebar is open. It reads one z-index per element, which is the
 * whole reason this defect walked straight past it: the bug lives in a state
 * no single number describes. Closing the sidebar swaps `.collapsed` on in
 * one frame — so the raise scoped to `#sideNav:not(.collapsed)` evaporates
 * immediately — while the scrim it was covering keeps painting for another
 * `--dur-3` as its opacity animates out. For that whole fade the scrim was
 * ABOVE the panel it had just uncovered, and the app dimmed the one surface
 * the user was watching on the way out.
 *
 * So these pins are written as a state machine, not as numbers. Every rule
 * that gives #navScrim or #sideNav a z-index is resolved per sidebar state
 * (expanded / collapsed) by real cascade order — specificity, then document
 * order — and the invariant asserted is an ORDERING that must hold in every
 * one of those states: the sidebar outranks its own scrim. A redesign may
 * move all of these numbers; it may not reintroduce a state in which the
 * scrim paints over the sidebar. The companion pin below keeps the obvious
 * cheat — dropping the scrim under the app's chrome again — from passing.
 */

const INDEX = readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

/**
 * The page's one stylesheet, comments stripped.
 *
 * Stripping is safe, and the scanner below can be this small, only because
 * the repo forbids braces inside CSS comments (tests/chartWrapNoOverflow.ts
 * enforces it) — a brace in a comment re-points every brace-matched slicer
 * in the suite, this one included.
 */
const CSS = (() => {
  const open = INDEX.indexOf('<style>');
  assert.notEqual(open, -1, 'the built page carries an inline stylesheet');
  const close = INDEX.indexOf('</style>', open);
  assert.notEqual(close, -1, 'the inline stylesheet closes');
  return INDEX.slice(open + '<style>'.length, close).replace(/\/\*[\s\S]*?\*\//g, '');
})();

interface Rule {
  /** The selector list, exactly as authored. */
  selector: string;
  /** The declarations between the braces. */
  body: string;
  /** Enclosing at-rules, outermost first — `@media (max-width: 900px)` etc. */
  at: string[];
  /** Document order, which breaks specificity ties the way the cascade does. */
  order: number;
}

/** Every declaration block in `css`, tagged with the at-rules that gate it. */
function parse(css: string): Rule[] {
  const out: Rule[] = [];
  const stack: string[] = [];
  let head = '';
  for (let i = 0; i < css.length; i++) {
    const ch = css[i];
    if (ch === '{') {
      const selector = head.trim();
      head = '';
      if (selector.startsWith('@')) { stack.push(selector); continue; }
      const end = css.indexOf('}', i);
      assert.notEqual(end, -1, `rule "${selector}" closes`);
      out.push({ selector, body: css.slice(i + 1, end), at: [...stack], order: out.length });
      i = end;
      continue;
    }
    if (ch === '}') { stack.pop(); head = ''; continue; }
    head += ch;
  }
  return out;
}

const RULES = parse(CSS);

/** One declaration's value, or null. Anchored so `width` cannot match `max-width`. */
function optDecl(body: string, prop: string): string | null {
  const m = new RegExp(`(?:^|[;{\\s])${prop}\\s*:\\s*([^;}]+)`).exec(body);
  return m ? m[1].trim() : null;
}

/**
 * The compound this selector actually paints. `body:has(#sideNav…) main`
 * mentions the sidebar but styles main; counting it as a sidebar rule would
 * make the resolver answer a question nobody asked.
 */
function subjects(selector: string): string[] {
  return selector.split(',').map((part) => {
    const flat = part.replace(/\([^)]*\)/g, ''); // :has()/:not() arguments are not the subject
    return flat.trim().split(/[\s>+~]+/).filter(Boolean).pop() ?? '';
  });
}

const paints = (selector: string, id: RegExp): boolean => subjects(selector).some((s) => id.test(s));

/**
 * Specificity as (ids, classes, elements). `:not()`, `:has()` and `:is()`
 * contribute their ARGUMENT's specificity rather than counting as a
 * pseudo-class, so they are flattened before counting. Deliberately a small
 * subset of the real algorithm — enough for the handful of selectors that
 * rank these two elements, and every one of them is asserted to be inside
 * that subset by `zIndexOf` before it is trusted.
 */
function specificity(selector: string): [number, number, number] {
  const flat = selector.replace(/:(?:not|has|is)\(/g, '(');
  const ids = (flat.match(/#[\w-]+/g) ?? []).length;
  const classes = (flat.match(/\.[\w-]+|\[[^\]]*\]|:[\w-]+/g) ?? []).length;
  const elements = (flat.match(/(?:^|[\s>+~(])[a-z][\w-]*/g) ?? []).length;
  return [ids, classes, elements];
}

const outranks = (a: [number, number, number], b: [number, number, number]): boolean =>
  a[0] !== b[0] ? a[0] > b[0] : a[1] !== b[1] ? a[1] > b[1] : a[2] > b[2];

/** The one narrow-window block the whole overlay behaviour lives in. */
const NARROW = /^@media\s*\(\s*max-width:\s*900px\s*\)$/;
const isNarrow = (at: string[]): boolean => at.some((q) => NARROW.test(q.replace(/\s+/g, ' ').trim()));

/**
 * The sidebar has exactly two states, and the close transition is the moment
 * one becomes the other. `.collapsed` is set the instant the close starts and
 * is still set when the fade ends, so a rank asserted in both states is a
 * rank that holds for every frame in between — which is precisely what a
 * per-element z-index reading cannot tell you.
 */
const STATES = [
  { name: 'sidebar expanded — the scrim armed', collapsed: false },
  { name: 'sidebar collapsing — the scrim fading out', collapsed: true },
] as const;

function appliesInState(selector: string, collapsed: boolean): boolean {
  if (/:not\(\.collapsed\)/.test(selector)) return !collapsed;
  if (/\.collapsed/.test(selector)) return collapsed;
  return true;
}

/**
 * The z-index `id` computes to in the narrow-window overlay, in one sidebar
 * state — resolved by cascade, so a rule that is overridden in that state
 * cannot be mistaken for the answer.
 */
function zIndexOf(id: RegExp, collapsed: boolean): number {
  const candidates = RULES.filter((r) => paints(r.selector, id) && optDecl(r.body, 'z-index') !== null);
  assert.ok(candidates.length > 0, `${id} is ranked somewhere in the stylesheet`);
  for (const c of candidates) {
    assert.ok(
      c.at.length === 0 || isNarrow(c.at),
      `"${c.selector}" ranks ${id} inside ${JSON.stringify(c.at)} — an at-rule this resolver ` +
      'does not model. Teach it that context before relying on this pin again.',
    );
  }
  const winner = candidates
    .filter((c) => appliesInState(c.selector, collapsed))
    .reduce((best: Rule | null, c) =>
      best === null || outranks(specificity(c.selector), specificity(best.selector)) ||
      (!outranks(specificity(best.selector), specificity(c.selector)) && c.order > best.order)
        ? c
        : best,
    null);
  assert.ok(winner !== null, `${id} is ranked with the sidebar ${collapsed ? 'collapsed' : 'expanded'}`);
  const z = Number(optDecl(winner.body, 'z-index'));
  assert.ok(Number.isFinite(z), `"${winner.selector}" ranks ${id} with a plain integer`);
  return z;
}

const SCRIM = /^#navScrim/;
const SIDEBAR = /^#sideNav/;

test('the scrim never paints above the sidebar, in either state of the close transition', () => {
  // The regression this pin exists for: the raise lived on
  // `#sideNav:not(.collapsed)` while the scrim's own high rank was
  // unconditional, so the two dropped at different times. Closing the panel
  // below 900px left the scrim on top for the full --dur-3 fade and dimmed
  // the panel it had just uncovered. Whatever pairs them — demoting the
  // scrim on the collapsed state, raising the sidebar in both — the ordering
  // has to survive BOTH readings, because the fade spans both.
  for (const state of STATES) {
    const scrim = zIndexOf(SCRIM, state.collapsed);
    const sidebar = zIndexOf(SIDEBAR, state.collapsed);
    assert.ok(
      sidebar > scrim,
      `${state.name}: #sideNav (${sidebar}) must outrank #navScrim (${scrim}) — ` +
      'a scrim over the sidebar dims the surface the user is looking at',
    );
  }
});

test('pairing the scrim to the sidebar does not hand back the layering fix', () => {
  // The cheap way to satisfy the pin above is to shove the scrim back under
  // everything, which restores the older bug: a dim that leaves the app's own
  // floating chrome lit AND clickable straight through it. While the sidebar
  // is the live surface the scrim still has to cover what it dims.
  const scrim = zIndexOf(SCRIM, false);
  for (const [name, id] of [
    ['#selectionBar', /^#selectionBar/],
    ['#previewPane', /^#previewPane/],
    ['#cartDock', /^#cartDock/],
  ] as const) {
    const z = zIndexOf(id, false);
    assert.ok(scrim > z, `an armed #navScrim (${scrim}) must still cover ${name} (${z})`);
  }
});

test('the scrim can only animate at widths where the sidebar outranks it', () => {
  // Above the breakpoint #sideNav is back in flow at its in-flow rank and is
  // never raised, so a fade must not be able to START there either —
  // otherwise widening the window past 900px with the panel open replays the
  // same bug at desktop size. Both halves of "the scrim is visible" — the
  // opacity it animates to and the transition that animates it — belong
  // inside the narrow block, where the raise lives.
  const scrimRules = RULES.filter((r) => paints(r.selector, SCRIM));
  assert.ok(scrimRules.length > 0, '#navScrim is styled somewhere');
  let animated = 0;
  for (const r of scrimRules) {
    const opacity = optDecl(r.body, 'opacity');
    const transition = optDecl(r.body, 'transition');
    if (transition !== null) animated++;
    const visible = opacity !== null && Number(opacity) !== 0;
    if (visible || transition !== null) {
      assert.ok(
        isNarrow(r.at),
        `"${r.selector}" makes #navScrim ${visible ? 'visible' : 'animate'} outside the ` +
        'narrow-window block, at widths where the sidebar is not raised above it',
      );
    }
  }
  assert.equal(animated > 0, true, 'the scrim still fades rather than snapping below 900px');
});
