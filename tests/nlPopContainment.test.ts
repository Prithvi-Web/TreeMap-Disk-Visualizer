import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * §9.6's plain-words popover is `position: fixed` and it is placed from
 * VIEWPORT coordinates: `nlOpen()` reads `tmNlBtn.getBoundingClientRect()` and
 * writes that left/top straight onto `#nlPop`. That arithmetic is only correct
 * while the popover's containing block IS the viewport.
 *
 * It stopped being the viewport the day the treemap toolbar started measuring
 * itself. `.tm-toolbar { container-type: inline-size }` computes to
 * `contain: layout style inline-size`, and LAYOUT containment makes the
 * toolbar the containing block for every `position: fixed` descendant — so a
 * popover that was a DOM child of the toolbar resolved `top: 88px` against the
 * toolbar's box instead of the window's, landed low and left of the sparkle
 * button, and was clipped by the toolbar's own stacking context.
 * (1440px window, sidebar expanded, Treemap view, click #tmNlBtn.)
 *
 * The fix is placement, not arithmetic: the popover lives at the top level of
 * the body, beside #ctxMenu and #rcPopover, which are fixed for the same
 * reason and already live there.
 *
 * So the invariant this pins is the one the arithmetic actually depends on —
 * NOT "the popover is not inside .tm-toolbar". Every property below makes an
 * element a containing block for its fixed descendants, and any of them
 * appearing on any ancestor would break `nlOpen()` in exactly the same way:
 * a `transform` added to `main` tomorrow, or the `container-type` that the
 * next self-measuring wrapper brings with it. Both the offending properties
 * and the ancestor chain are DERIVED from the shipped page, so nothing here
 * has to be re-listed by hand when either side changes.
 */

const INDEX = readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

const CSS = (() => {
  const open = INDEX.indexOf('<style>');
  const close = INDEX.indexOf('</style>', open);
  assert.ok(open !== -1 && close > open, 'the page carries one inlined stylesheet');
  return INDEX.slice(open + '<style>'.length, close);
})();

/* ── The stylesheet, as rules ───────────────────────────────────────────── */

interface Rule { selectors: string[]; body: string }

/** Reads the block that starts at the `{` at or after `from`. */
function block(css: string, from: number): { body: string; end: number } {
  const open = css.indexOf('{', from);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}' && --depth === 0) return { body: css.slice(open + 1, i), end: i + 1 };
  }
  throw new Error('unbalanced braces in the stylesheet');
}

/* @keyframes hold `from`/`to` blocks that are not selectors at all, so they
   come out first and are read separately below. */
const KEYFRAMES = new Map<string, string>();
const FLAT = (() => {
  let css = CSS;
  for (;;) {
    const m = /@keyframes\s+([\w-]+)/.exec(css);
    if (!m) return css;
    const { body, end } = block(css, m.index);
    KEYFRAMES.set(m[1], body);
    css = css.slice(0, m.index) + css.slice(end);
  }
})();

const RULES: Rule[] = (() => {
  const out: Rule[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(FLAT)) !== null) {
    const selector = m[1].replace(/\/\*[\s\S]*?\*\//g, ' ').trim();
    if (!selector || selector.startsWith('@')) continue;
    out.push({ selectors: selector.split(',').map((s) => s.trim()).filter(Boolean), body: m[2] });
  }
  return out;
})();

/* Returned with its case intact: keyframe names are case-SENSITIVE, so
   lowercasing here would quietly stop `animation: viewIn …` from ever
   resolving to the @keyframes block that moves it. */
const value = (body: string, prop: string): string | null => {
  const flat = body.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\s+/g, ' ');
  const m = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`, 'i').exec(flat);
  return m ? m[1].trim() : null;
};

/**
 * Every property here promotes an element to the containing block of its
 * `position: fixed` descendants (CSS Position 4 §3.3, CSS Contain §2).
 * `contain: paint` counts as much as `layout` does, and `container-type`
 * counts because it expands to `contain: layout style <axis>`.
 */
const PROMOTERS = ['transform', 'translate', 'rotate', 'scale', 'perspective',
  'filter', 'backdrop-filter', 'will-change', 'container-type', 'container', 'contain'];

function promotedBy(body: string): string | null {
  for (const prop of PROMOTERS) {
    const raw = value(body, prop);
    if (raw === null) continue;
    const v = raw.toLowerCase();
    if (v === 'none' || v === 'normal' || v === 'auto' || v === 'initial') continue;
    // A `contain` that buys only size or style containment changes no boxes.
    if (prop === 'contain' && !/\b(layout|paint|strict|content)\b/.test(v)) continue;
    // will-change only promotes for the properties that themselves promote —
    // `will-change: opacity` is a paint hint and leaves the boxes alone.
    if (prop === 'will-change' && !/\b(transform|translate|rotate|scale|perspective|filter|contain)\b/.test(v)) continue;
    return `${prop}: ${v}`;
  }
  // An animation promotes for as long as it RUNS, which is enough: the view
  // switch that reveals the toolbar is exactly when the popover can be opened.
  const anim = value(body, 'animation') ?? value(body, 'animation-name');
  if (anim) {
    for (const [name, frames] of KEYFRAMES) {
      if (!new RegExp(`(^|[^\\w-])${name}([^\\w-]|$)`).test(anim)) continue;
      if (promotedBy(frames.replace(/[^{}]*\{/g, '').replace(/\}/g, ';'))) return `animation ${name}`;
    }
  }
  return null;
}

/* ── The page, as an element tree ───────────────────────────────────────── */

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr']);

interface El { tag: string; id: string; classes: string[]; style: string }

function attr(attrs: string, name: string): string {
  const m = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(attrs);
  return m ? (m[2] ?? m[3] ?? '') : '';
}

/** The open elements above the first element carrying `id`, outermost first. */
function ancestorsOf(id: string): El[] {
  const html = INDEX
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '<style></style>')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '<script></script>');
  const stack: El[] = [];
  const re = /<(\/?)([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^'">])*)>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const tag = m[2].toLowerCase();
    const attrs = m[3];
    if (m[1] === '/') {
      for (let i = stack.length - 1; i >= 0; i--) if (stack[i].tag === tag) { stack.length = i; break; }
      continue;
    }
    if (VOID.has(tag) || /\/\s*$/.test(attrs)) continue;
    const el: El = {
      tag,
      id: attr(attrs, 'id'),
      classes: attr(attrs, 'class').split(/\s+/).filter(Boolean),
      style: attr(attrs, 'style'),
    };
    if (el.id === id) return stack.slice();
    stack.push(el);
  }
  throw new Error(`the shipped page has no element with id="${id}"`);
}

/** Does `selector`'s SUBJECT (its rightmost compound) match this element? */
function matches(el: El, selector: string): boolean {
  const subject = selector.split(/\s*[>+~]\s*|\s+/).filter(Boolean).pop() ?? '';
  if (/::/.test(subject)) return false; // styles a pseudo-element, not the element
  const bare = subject.replace(/::?[\w-]+(\([^)]*\))?/g, '').replace(/\[[^\]]*\]/g, '');
  const tag = /^[\w-]+/.exec(bare);
  if (tag && tag[0] !== '*' && tag[0] !== el.tag) return false;
  const ids = bare.match(/#[\w-]+/g) ?? [];
  if (ids.some((i) => i.slice(1) !== el.id)) return false;
  const classes = bare.match(/\.[\w-]+/g) ?? [];
  if (classes.some((c) => !el.classes.includes(c.slice(1)))) return false;
  return Boolean(tag || ids.length || classes.length);
}

test('#nlPop has no ancestor that becomes the containing block for fixed children', () => {
  const chain = ancestorsOf('nlPop');
  const offenders: string[] = [];

  for (const el of chain) {
    const label = `<${el.tag}${el.id ? ` id="${el.id}"` : ''}${el.classes.length ? ` class="${el.classes.join(' ')}"` : ''}>`;
    const inline = promotedBy(el.style);
    if (inline) offenders.push(`${label} — inline ${inline}`);
    for (const rule of RULES) {
      const reason = promotedBy(rule.body);
      if (!reason) continue;
      for (const sel of rule.selectors) {
        if (matches(el, sel)) { offenders.push(`${label} — \`${sel}\` sets ${reason}`); break; }
      }
    }
  }

  assert.deepEqual(offenders, [],
    'nlOpen() places #nlPop from getBoundingClientRect() viewport coordinates, so every ' +
    'ancestor above it must leave the viewport as its containing block — move the popover ' +
    'to the top level of the body (where #ctxMenu and #rcPopover already sit) instead of ' +
    'nesting it inside a box that measures, transforms or contains itself');
});
