import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Polish round — the light theme, measured.
 *
 * Every assertion here is a WCAG 2.x contrast computation over the tokens
 * the built page actually declares, composited onto the grounds the ink
 * actually lands on (the page, and the glass card over it). Nothing pins a
 * hex: retune a token and the number is re-measured; drift a token back and
 * the ratio, not a string, is what fails.
 *
 * The defects this file was written for:
 *  - light `--text-3` measured 2.8:1 — every path, date and "you can restore
 *    it from the Trash" line was a grey smudge on a white card;
 *  - light `--warn` measured 4.0:1, under the 4.5:1 the token file promises;
 *  - `.btn-primary:hover` carried a dark-theme hex, so in the light theme
 *    the button got PALER on hover and its white label fell to 3.2:1;
 *  - six dark-only literals (`#30d158`, `#ff6b60`, `#ff6b61`, `#4aa3ff`…)
 *    bypassed the theme-tuned `--ok` / `--danger` / `--accent`;
 *  - seven warning surfaces used two different literal hues under one
 *    `--warn` glyph, and the yellow border vanished on a white card;
 *  - floating chrome and every `.btn` cast hard-coded black shadows that the
 *    light theme's shadow tokens never reached.
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

const CSS = SHEET.replace(/\/\*[\s\S]*?\*\//g, ' ');

type Rule = { selector: string; body: string };
/** Every rule as { selector, body }; rules nested in an at-rule land on their own. */
const RULES: Rule[] = [...CSS.matchAll(/([^{}]*)\{([^{}]*)\}/g)]
  .map((m) => ({ selector: m[1].trim(), body: m[2] }))
  .filter((r) => r.selector && !r.selector.startsWith('@'));

const parts = (r: Rule) => r.selector.split(',').map((p) => p.trim());
/** The FIRST rule whose selector list contains `sel` exactly. */
function ruleFor(sel: string): Rule {
  const r = RULES.find((x) => parts(x).includes(sel));
  assert.ok(r, `a rule for "${sel}" exists`);
  return r!;
}
/** The last-declared value of `prop` in a body (the cascade within one rule). */
function prop(body: string, name: string): string | null {
  let out: string | null = null;
  for (const m of body.matchAll(new RegExp(`(?:^|;)\\s*${name.replace(/[-]/g, '\\-')}\\s*:\\s*([^;]+)`, 'g'))) out = m[1].trim();
  return out;
}

function tokens(selector: RegExp): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of RULES) {
    if (!selector.test(r.selector)) continue;
    for (const m of r.body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  }
  return out;
}
const DARK = tokens(/^:root$/);
const LIGHT_ONLY = tokens(/^:root\[data-theme="light"\]$/);
/** The light palette as the cascade resolves it: light declarations over the dark ones. */
const LIGHT = { ...DARK, ...LIGHT_ONLY };

type RGB = [number, number, number];
function rgb(value: string): RGB {
  const hex = /^#([0-9a-f]{6})$/i.exec(value.trim());
  if (hex) return [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16)) as RGB;
  const fn = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(value.trim());
  assert.ok(fn, `colour "${value}" is a hex or rgb()`);
  return [+fn![1], +fn![2], +fn![3]];
}
function alpha(value: string): number {
  const m = /^rgba\(\s*[\d.]+[\s,]+[\d.]+[\s,]+[\d.]+[\s,/]+([\d.]+)\s*\)/i.exec(value.trim());
  return m ? +m[1] : 1;
}
function over(fg: string, bg: RGB): RGB {
  const a = alpha(fg), c = rgb(fg);
  return c.map((v, i) => a * v + (1 - a) * bg[i]) as RGB;
}
function mix(a: RGB, pct: number, b: RGB): RGB {
  return a.map((v, i) => pct * v + (1 - pct) * b[i]) as RGB;
}
function luminance([r, g, b]: RGB): number {
  const f = (c: number) => (c /= 255) <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function contrast(a: RGB, b: RGB): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
const fmt = (n: number) => n.toFixed(2);

/**
 * A CSS colour expression as the page would paint it over `ground`:
 * `var(--x)` through the palette, hex/rgb(a) composited, and
 * `color-mix(in srgb, A P%, B)` mixed after resolving both arms (with
 * `transparent` meaning "the ground shows through").
 */
function paint(expr: string, palette: Record<string, string>, ground: RGB): RGB {
  const e = expr.trim();
  const v = /^var\((--[a-z0-9-]+)\)$/.exec(e);
  if (v) {
    assert.ok(palette[v[1]], `${v[1]} is declared`);
    return paint(palette[v[1]], palette, ground);
  }
  if (e === 'transparent') return ground;
  const cm = /^color-mix\(in srgb,\s*(.+?)\s+([\d.]+)%,\s*(.+)\)$/.exec(e);
  if (cm) return mix(paint(cm[1], palette, ground), +cm[2] / 100, paint(cm[3], palette, ground));
  return over(e, ground);
}

const THEMES = [['dark', DARK], ['light', LIGHT]] as const;
function grounds(palette: Record<string, string>): { page: RGB; card: RGB } {
  const page = rgb(palette['--bg-1']);
  return { page, card: over(palette['--glass'], page) };
}

/* ═══════════════ text and status tokens, on both grounds ═══════════════ */

test('the three text tokens clear AA on the page and on a card, in both themes', () => {
  for (const [name, palette] of THEMES) {
    const { page, card } = grounds(palette);
    for (const t of ['--text-1', '--text-2', '--text-3']) {
      assert.ok(palette[t], `${name} declares ${t}`);
      for (const [gname, g] of [['page', page], ['card', card]] as const) {
        const ratio = contrast(over(palette[t], g), g);
        assert.ok(ratio >= 4.5, `${name} ${t} measures ${fmt(ratio)}:1 on the ${gname} — 10.5px paths and dates need 4.5:1`);
      }
    }
    // The ladder still reads as a ladder: tertiary stays visibly lighter than secondary.
    const l2 = contrast(over(palette['--text-2'], page), page), l3 = contrast(over(palette['--text-3'], page), page);
    assert.ok(l3 < l2, `${name}: --text-3 (${fmt(l3)}) stays quieter than --text-2 (${fmt(l2)})`);
  }
});

test('--warn, --ok and --danger are text colours on a card in both themes — 4.5:1 or better', () => {
  for (const [name, palette] of THEMES) {
    const { card } = grounds(palette);
    for (const t of ['--warn', '--ok', '--danger']) {
      const ratio = contrast(rgb(palette[t]), card);
      assert.ok(ratio >= 4.5, `${name} ${t} measures ${fmt(ratio)}:1 on the card`);
    }
  }
});

/* ═══════════════ the primary button's hover ═══════════════ */

test('the primary button deepens on hover in the light theme and keeps its label legible in both', () => {
  const hover = ruleFor('.btn-primary:hover');
  const bg = prop(hover.body, 'background');
  assert.ok(bg && /var\(--accent-hover\)\s*$/.test(bg), 'the hover fill ends in the theme token, not a hex');
  assert.doesNotMatch(bg!, /#[0-9a-f]{3,8}/i, 'no literal hue in the hover fill');
  for (const [name, palette] of THEMES) {
    assert.ok(palette['--accent-hover'], `${name} declares --accent-hover`);
    const rest = contrast([255, 255, 255], rgb(palette['--accent']));
    const lit = contrast([255, 255, 255], rgb(palette['--accent-hover']));
    const floor = name === 'light' ? 4.5 : 3;
    assert.ok(lit >= floor, `${name}: white on the hover fill measures ${fmt(lit)}:1 (floor ${floor}:1)`);
    assert.ok(rest >= floor, `${name}: white on the resting fill measures ${fmt(rest)}:1 (floor ${floor}:1)`);
  }
  assert.notEqual(LIGHT_ONLY['--accent-hover'], undefined, 'the light block re-tunes the hover, it does not inherit the dark one');
  // Light controls deepen under the pointer; dark ones brighten. Never the reverse.
  assert.ok(luminance(rgb(LIGHT['--accent-hover'])) < luminance(rgb(LIGHT['--accent'])), 'light: hover is darker than rest');
  assert.ok(luminance(rgb(DARK['--accent-hover'])) > luminance(rgb(DARK['--accent'])), 'dark: hover is brighter than rest');
});

/* ═══════════════ dark-only literals, gone ═══════════════ */

test('status inks come from the theme-tuned tokens — no dark-only green or salmon literal survives', () => {
  const expect: Array<[string, string]> = [
    ['.cost-save', 'var(--ok)'],
    ['.icon-btn.danger:hover', 'var(--danger)'],
    ['.pkg-tag.orphan', 'var(--danger)'],
    ['.sev-high .sec-sev', 'var(--danger)'],
    ['#liveFeed .lf-row .up', 'var(--ok)'],
    ['#liveFeed .lf-row .down', 'var(--danger)'],
    ['.pkg-tag.cache', 'var(--accent-ink)'],
  ];
  for (const [sel, want] of expect) assert.equal(prop(ruleFor(sel).body, 'color'), want, `${sel} takes its ink from ${want}`);
  for (const sel of ['.fl-dot.on', '.gp-workshop']) assert.equal(prop(ruleFor(sel).body, 'background'), 'var(--ok)', `${sel} is the token green`);
  assert.match(prop(ruleFor('.dup-file .tag').body, 'border') ?? '', /var\(--ok\)/, 'the keep chip draws its border from the same green as its text');
  for (const r of RULES) {
    for (const m of r.body.matchAll(/(?:^|;)\s*color\s*:\s*([^;]+)/g)) {
      assert.ok(!/#30d158|#ff6b60/i.test(m[1]), `"${r.selector}" paints text with a dark-only literal (${m[1].trim()})`);
    }
  }
  assert.ok(LIGHT_ONLY['--accent-ink'] && LIGHT_ONLY['--accent-ink'] !== DARK['--accent-ink'],
    '--accent-ink is a text token, so the light theme re-tunes it');
});

test('each rescued ink clears AA on the ground it actually sits on, in both themes', () => {
  const chips: Array<[string, number]> = [
    ['.pkg-tag.orphan', 4.5], ['.pkg-tag.cache', 4.5], ['.sev-high .sec-sev', 4.5], ['.sev-medium .sec-sev', 4.5],
  ];
  for (const [name, palette] of THEMES) {
    const { card } = grounds(palette);
    for (const [sel, floor] of chips) {
      const r = ruleFor(sel);
      const ground = paint(prop(r.body, 'background')!, palette, card);
      const ink = paint(prop(r.body, 'color')!, palette, ground);
      const ratio = contrast(ink, ground);
      assert.ok(ratio >= floor, `${name} ${sel} measures ${fmt(ratio)}:1 on its own chip (floor ${floor}:1)`);
    }
    // Plain inks on the card.
    for (const sel of ['.cost-save', '#liveFeed .lf-row .up', '#liveFeed .lf-row .down']) {
      const ratio = contrast(paint(prop(ruleFor(sel).body, 'color')!, palette, card), card);
      assert.ok(ratio >= 4.5, `${name} ${sel} measures ${fmt(ratio)}:1 on the card`);
    }
    // The trash icon on its hover tint: an icon, so the UI-component bar.
    const hover = ruleFor('.icon-btn.danger:hover');
    const tint = paint(prop(hover.body, 'background')!, palette, card);
    const icon = contrast(paint(prop(hover.body, 'color')!, palette, tint), tint);
    assert.ok(icon >= 3, `${name} .icon-btn.danger:hover measures ${fmt(icon)}:1 (UI floor 3:1)`);
  }
});

/* ═══════════════ one warning recipe ═══════════════ */

test('every warning surface shares one --warn-based recipe, and the border is visible on a white card', () => {
  for (const r of RULES) {
    assert.ok(!/255,\s*214,\s*10|255,\s*159,\s*10/.test(r.body), `"${r.selector}" still carries a literal warning hue`);
  }
  const panels = ['.growth-proj.warn', '#confirmOpenHandles', '.smart-group.advisory', '.pm-row.warn', '.vid-warn', '.sec-item.sev-medium'];
  for (const sel of panels) {
    const r = ruleFor(sel);
    const bg = prop(r.body, 'background') ?? prop(r.body, 'background-color');
    const line = prop(r.body, 'border-color') ?? prop(r.body, 'border');
    assert.ok(bg && /var\(--warn/.test(bg), `${sel} tints from --warn (${bg})`);
    assert.ok(line && /var\(--warn/.test(line), `${sel} draws its edge from --warn (${line})`);
  }
  for (const [name, palette] of THEMES) {
    const { card } = grounds(palette);
    assert.ok(palette['--warn-soft'] && palette['--warn-line'], `${name} declares the warn recipe tokens`);
    const edge = contrast(paint('var(--warn-line)', palette, card), card);
    assert.ok(edge >= 1.75, `${name}: the warning edge measures ${fmt(edge)}:1 against the card — the old yellow was 1.09:1, invisible`);
    // Warn text on the warn tint: the growth projection and the open-files notice are 12.5px prose.
    const tint = paint('var(--warn-soft)', palette, card);
    const ink = contrast(rgb(palette['--warn']), tint);
    assert.ok(ink >= 4.5, `${name}: --warn text on --warn-soft measures ${fmt(ink)}:1`);
  }
});

/* ═══════════════ shadows follow the theme ═══════════════ */

/** Top-level comma split (a colour function's commas stay inside their parens). */
function layers(value: string): string[] {
  const out: string[] = [];
  let depth = 0, cur = '';
  for (const ch of value) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

test('no drop shadow outside the token blocks is a hard-coded black — the light theme owns its shadows', () => {
  const lightOverrides = new Set(RULES.filter((r) => /^:root\[data-theme="light"\]/.test(r.selector) && /box-shadow/.test(r.body))
    .flatMap((r) => parts(r).map((p) => p.replace(/^:root\[data-theme="light"\]\s*/, ''))));
  const offenders: string[] = [];
  for (const r of RULES) {
    if (/^:root/.test(r.selector)) continue;
    const sh = prop(r.body, 'box-shadow');
    if (!sh) continue;
    for (const layer of layers(sh)) {
      if (/^inset\b/.test(layer) || !/rgba\(\s*0\s*,\s*0\s*,\s*0\s*,/.test(layer)) continue;
      const lengths = layer.match(/-?[\d.]+px/g) ?? [];
      const blur = lengths[2] ? parseFloat(lengths[2]) : 0;
      if (blur <= 0) continue; // a 0-blur ring on a thumbnail is a halo, not a shadow
      if (parts(r).every((p) => lightOverrides.has(p))) continue; // a light rule re-declares it
      offenders.push(`${r.selector} → ${layer}`);
    }
  }
  assert.deepEqual(offenders, [], 'use --shadow-1/2/3 or --shadow-btn(-hover), which the light block re-tunes');
  for (const sel of ['#liveFeed', '.tm-preview-banner']) {
    assert.match(prop(ruleFor(sel).body, 'box-shadow') ?? '', /var\(--shadow-2\)/, `${sel} casts the theme's floating-chrome shadow`);
  }
  for (const [sel, tok] of [['.btn', '--shadow-btn'], ['.btn:hover', '--shadow-btn-hover'], ['.btn:active', '--shadow-btn']] as const) {
    assert.match(prop(ruleFor(sel).body, 'box-shadow') ?? '', new RegExp(`var\\(${tok}\\)`), `${sel} uses ${tok}`);
  }
  for (const tok of ['--shadow-btn', '--shadow-btn-hover']) {
    assert.ok(DARK[tok] && LIGHT_ONLY[tok] && DARK[tok] !== LIGHT_ONLY[tok], `${tok} is declared for both themes, differently`);
    assert.ok(alpha(LIGHT_ONLY[tok].match(/rgba\([^)]*\)/)![0]) < alpha(DARK[tok].match(/rgba\([^)]*\)/)![0]), `${tok} is lighter in the light theme`);
  }
});
