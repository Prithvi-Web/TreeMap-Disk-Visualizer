import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { lift } from './fixtures/liftFrontend';

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
 * `transparent` meaning "the ground shows through"), and `currentColor` as
 * `current` — the element's own text colour, where the caller knows it.
 */
function paint(expr: string, palette: Record<string, string>, ground: RGB, current?: RGB): RGB {
  const e = expr.trim();
  const v = /^var\((--[a-z0-9-]+)\)$/.exec(e);
  if (v) {
    assert.ok(palette[v[1]], `${v[1]} is declared`);
    return paint(palette[v[1]], palette, ground, current);
  }
  if (e === 'transparent') return ground;
  if (e === 'currentColor') {
    assert.ok(current, 'currentColor is painted only where the text colour is known');
    return current!;
  }
  const cm = /^color-mix\(in srgb,\s*(.+?)\s+([\d.]+)%,\s*(.+)\)$/.exec(e);
  if (cm) return mix(paint(cm[1], palette, ground, current), +cm[2] / 100, paint(cm[3], palette, ground, current));
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

test('the primary button deepens on hover in the light theme, brightens in the dark, and fills from its own token', () => {
  const hover = ruleFor('.btn-primary:hover');
  const bg = prop(hover.body, 'background');
  assert.ok(bg && /var\(--accent-fill-hover\)\s*$/.test(bg), 'the hover fill ends in the theme token, not a hex');
  assert.doesNotMatch(bg!, /#[0-9a-f]{3,8}/i, 'no literal hue in the hover fill');
  const rest = prop(ruleFor('.btn-primary').body, 'background');
  assert.ok(rest && /var\(--accent-fill\)\s*$/.test(rest), 'the resting fill ends in the theme token');
  for (const [name, palette] of THEMES) {
    for (const t of ['--accent-fill', '--accent-fill-hover']) assert.ok(palette[t], `${name} declares ${t}`);
  }
  assert.notEqual(LIGHT_ONLY['--accent-fill-hover'], undefined, 'the light block re-tunes the hover, it does not inherit the dark one');
  // Light controls deepen under the pointer; dark ones brighten. Never the reverse.
  assert.ok(luminance(rgb(LIGHT['--accent-fill-hover'])) < luminance(rgb(LIGHT['--accent-fill'])), 'light: hover is darker than rest');
  assert.ok(luminance(rgb(DARK['--accent-fill-hover'])) > luminance(rgb(DARK['--accent-fill'])), 'dark: hover is brighter than rest');
});

/**
 * `linear-gradient(<angle>, <stop>, …), var(--fill)` as { angle, stops, fill }:
 * the angle in degrees (CSS's: 0deg points up, 90deg right), each stop a
 * colour with its position in percent — a missing first position is 0%, a
 * missing last 100%, and missing middle ones are spread evenly, as CSS
 * places them.
 */
function sheenOver(background: string): { angle: number; stops: Array<{ at: number; colour: string }>; fill: string } {
  const top = layers(background);
  assert.equal(top.length, 2, `a sheen over one fill (${background})`);
  const g = /^linear-gradient\((.*)\)$/.exec(top[0]);
  assert.ok(g, `the sheen is a linear gradient (${top[0]})`);
  const all = layers(g![1]);
  const deg = /^(-?[\d.]+)deg$/.exec(all[0].trim());
  assert.ok(deg, `the sheen states its angle in degrees (${all[0]})`);
  const raw = all.slice(1).map((a) => {
    const m = /^(rgba?\([^)]*\))\s*(?:([\d.]+)%)?$/.exec(a.trim());
    assert.ok(m, `a stop is a colour and an optional percentage (${a})`);
    return { colour: m![1], at: m![2] === undefined ? null : +m![2] };
  });
  if (raw[0].at === null) raw[0].at = 0;
  if (raw[raw.length - 1].at === null) raw[raw.length - 1].at = 100;
  for (let i = 1; i < raw.length - 1; i++) {
    if (raw[i].at !== null) continue;
    let j = i; while (raw[j].at === null) j++;
    const a = raw[i - 1].at!, b = raw[j].at!;
    for (let k = i; k < j; k++) raw[k].at = a + ((b - a) * (k - i + 1)) / (j - i + 1);
  }
  return { angle: +deg![1], stops: raw as Array<{ at: number; colour: string }>, fill: top[1] };
}

/**
 * Where a point of a box falls on a CSS linear gradient, in percent: the
 * gradient line runs through the box's centre at `angle`, and is as long as
 * the box's projection on it, |w·sin a| + |h·cos a| (CSS Images 3, §3.1.1) —
 * so at any angle but a vertical one the x of the point counts too.
 */
function gradientAt(angle: number, w: number, h: number, x: number, y: number): number {
  const a = (angle * Math.PI) / 180;
  const along = (x - w / 2) * Math.sin(a) - (y - h / 2) * Math.cos(a);
  const length = Math.abs(w * Math.sin(a)) + Math.abs(h * Math.cos(a));
  return (0.5 + along / length) * 100;
}

/** px of a `<n>px` length (0 for none). */
const px = (v: string | null | undefined) => parseFloat(/(-?[\d.]+)px/.exec(v ?? '')?.[1] ?? '0');

test('G09: the primary button\'s white label clears 4.5:1 WITH its sheen, resting and hovered, in both themes, at every width — and the blue stays vivid', () => {
  // White on #0A84FF is 3.65:1 flat, and the sheen's white lifts the fill
  // under the label further: QA measured 3.0–3.9:1 rendered in the dark
  // theme. The sheen is measured where CSS puts it: over the padding box
  // (the gradient's positioning area), along the gradient's own angle — a
  // tilted sheen reaches further down a wide button's left end than its
  // height alone implies, which is how a 188 px "Show me what I could free"
  // measured 4.09:1 hovered in the dark while a band down the middle passed
  // (review F1.1). Every point of the label's box is measured, at every
  // width a primary button takes, for the standard button and for each
  // primary button the page sizes with its own style.
  const btn = ruleFor('.btn');
  const pad = (prop(btn.body, 'padding') ?? '').trim().split(/\s+/).map(px);
  const standard = {
    h: px(prop(btn.body, 'min-height')), fs: px(prop(btn.body, 'font-size')),
    padX: pad.length > 1 ? pad[1] : pad[0], border: px(prop(btn.body, 'border')),
  };
  assert.ok(standard.h >= 24 && standard.fs >= 11 && standard.padX > 0 && standard.border > 0, `the button's geometry is read (${JSON.stringify(standard)})`);
  const geometries = [standard];
  for (const m of INDEX.matchAll(/class="btn btn-primary"[^>]*style="([^"]*)"/g)) {
    const own = (name: string) => new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([^;]+)`).exec(m[1])?.[1] ?? null;
    const ownPad = own('padding')?.trim().split(/\s+/).map(px);
    geometries.push({
      h: own('min-height') ? px(own('min-height')) : standard.h,
      fs: own('font-size') ? px(own('font-size')) : standard.fs,
      padX: ownPad ? (ownPad.length > 1 ? ownPad[1] : ownPad[0]) : standard.padX,
      border: standard.border,
    });
  }
  assert.ok(geometries.length >= 2, 'the empty state\'s larger "Choose a folder" button is measured too');
  for (const sel of ['.btn-primary', '.btn-primary:hover']) {
    const { angle, stops, fill } = sheenOver(prop(ruleFor(sel).body, 'background')!);
    const alphaAt = (at: number) => {
      const i = stops.findIndex((st) => st.at >= at);
      const last = stops[stops.length - 1];
      const [a, b] = i === -1 ? [last, last] : i === 0 ? [stops[0], stops[0]] : [stops[i - 1], stops[i]];
      return { a, b, t: b.at === a.at ? 0 : (at - a.at) / (b.at - a.at) };
    };
    for (const [name, palette] of THEMES) {
      const base = paint(fill, palette, [0, 0, 0]);
      let worst = Infinity, where = '';
      for (const g of geometries) {
        // The positioning area is the padding box; the label's line box
        // (font size × 1.2, rounded up to whole pixels as the engine lays it
        // out) is centred in it, across the whole content width.
        const h = g.h - 2 * g.border, line = Math.ceil(g.fs * 1.2);
        for (let width = 60; width <= 400; width += 10) {
          const w = width - 2 * g.border;
          const x0 = g.padX, x1 = w - g.padX, y0 = (h - line) / 2, y1 = (h + line) / 2;
          for (let i = 0; i <= 20; i++) for (let j = 0; j <= 8; j++) {
            const x = x0 + ((x1 - x0) * i) / 20, y = y0 + ((y1 - y0) * j) / 8;
            const { a, b, t } = alphaAt(gradientAt(angle, w, h, x, y));
            const under = mix(over(b.colour, base), t, over(a.colour, base));
            const c = contrast([255, 255, 255], under);
            if (c < worst) { worst = c; where = `a ${width}×${g.h} button, ${fmt(x)}px in and ${fmt(y)}px down its label`; }
          }
        }
      }
      assert.ok(worst >= 4.5, `${name} ${sel}: the white label measures ${fmt(worst)}:1 at ${where} (floor 4.5:1)`);
      // Vivid, not greyed: CIE C*ab of the fill itself.
      const chroma = labChroma(base);
      assert.ok(chroma >= 60, `${name} ${sel}: the fill keeps its colour — C*ab ${chroma.toFixed(1)} (floor 60)`);
    }
  }
});

/** CIE C*ab under D65. */
function labChroma([r8, g8, b8]: RGB): number {
  const f = (c: number) => (c /= 255) <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  const r = f(r8), g = f(g8), b = f(b8);
  const X = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047, Y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const Z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const k = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  return Math.hypot(500 * (k(X) - k(Y)), 200 * (k(Y) - k(Z)));
}

/**
 * The two grounds a `.card.glass` really shows: --glass-strong over the page,
 * and that again under the card's own sheen at its brightest (the first stop
 * of the .glass gradient, which the light theme re-declares). Text in the
 * card has to read on both.
 */
function glassCardGrounds(name: string, palette: Record<string, string>): RGB[] {
  const page = rgb(palette['--bg-1']);
  const strong = over(palette['--glass-strong'], page);
  const rule = name === 'light' ? ruleFor(':root[data-theme="light"] .glass') : ruleFor('.glass');
  const sheen = /linear-gradient\(\s*[\d.]+deg\s*,\s*(rgba\([^)]*\))/.exec(prop(rule.body, 'background') ?? '');
  assert.ok(sheen, `${name}: the glass card's sheen is found`);
  return [strong, over(sheen![1], strong)];
}

test('G09: the Security "Minor" badge and the drive-health "unknown" line clear 4.5:1 on the ground they sit on, in both themes', () => {
  for (const [name, palette] of THEMES) {
    for (const card of glassCardGrounds(name, palette)) {
      // A low finding's row (.sec-item, its own --surface-1 over the card),
      // then the badge's chip over that.
      const row = paint(prop(ruleFor('.sec-item').body, 'background')!, palette, card);
      const sev = ruleFor('.sec-sev');
      const chip = paint(prop(sev.body, 'background')!, palette, row);
      const badge = contrast(paint(prop(sev.body, 'color')!, palette, chip), chip);
      assert.ok(badge >= 4.5, `${name}: the "Minor" badge measures ${fmt(badge)}:1 on its chip (QA: 4.28 light, 3.85 dark)`);
      const dh = ruleFor('.dh-unknown');
      const panel = paint(prop(dh.body, 'background')!, palette, card);
      const line = contrast(paint(prop(dh.body, 'color')!, palette, panel), panel);
      assert.ok(line >= 4.5, `${name}: "Drive health reporting needs…" measures ${fmt(line)}:1 on its panel (QA: 4.497 dark)`);
    }
  }
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

/* ═══════════════ B21 — a size printed in its ramp colour reads in both themes ═══════════════ */

/**
 * The size ramp (teal → amber → red) is tuned for dark glass, and amber is
 * the lightest colour on it: Libraries and Apps printed their totals in the
 * RAW ramp colour, #FFBB13 on a near-white card — about 1.5:1 in the light
 * theme. The Dashboard's badges already mixed the ramp with --text-1, but at
 * 60% even that measured 2.6:1 there. One helper now builds every size ink,
 * with the ramp's share a theme token, and this measures it across the whole
 * ramp on every ground a badge sits on.
 */
test('every size figure printed in the ramp colour clears 4.5:1 on its badge, the card and the page, in both themes (B21)', () => {
  const ink = lift<(bytes: number) => string>(
    ['TIER_LO', 'hexToRgb', 'C_TEAL', 'mix', 'sizeRgb', 'sizeColor', 'sizeInk'], 'sizeInk');
  let checked = 0;
  for (const [name, palette] of THEMES) {
    assert.ok(palette['--size-ink'], `${name} declares the ramp's share of a size ink`);
    const { page, card } = grounds(palette);
    const surfaces: Array<[string, RGB]> = [
      ['the card', card], ['the page', page],
      ['a badge on the card', paint('var(--surface-2)', palette, card)],
      ['a badge on the page', paint('var(--surface-2)', palette, page)],
    ];
    for (const [where, ground] of surfaces) {
      // 1 B to 3 TB in 1/20-decade steps: every hue the ramp can produce.
      for (let e = 0; e <= 12.5; e += 0.05) {
        const bytes = Math.round(10 ** e);
        const expr = ink(bytes).replace(/var\(--size-ink\)/g, palette['--size-ink']);
        const ratio = contrast(paint(expr, palette, ground), ground);
        checked++;
        assert.ok(ratio >= 4.5, `${name}: a ${bytes}-byte figure measures ${fmt(ratio)}:1 on ${where} (${expr})`);
      }
    }
  }
  assert.ok(checked > 1500, `the ramp was sampled (${checked} points)`);
});

test('no size figure paints its ramp colour raw — every text use goes through the one ink (B21)', () => {
  const code = INDEX.slice(INDEX.indexOf('<script>'));
  const raw = [...code.matchAll(/color:\s*\$\{sizeColor\(/g)].length;
  const handMixed = [...code.matchAll(/color:\s*color-mix\(in srgb, \$\{sizeColor\(/g)].length;
  assert.equal(raw, 0, 'a raw ramp colour as text is ~1.5:1 on a light card');
  assert.equal(handMixed, 0, 'a hand-written mix fixes the share at one value for both themes');
  const inks = [...code.matchAll(/color:\s*\$\{sizeInk\(/g)].length;
  assert.ok(inks >= 13, `the badges and the tooltip take the ink (${inks})`);
});

/* ═══════════════ B21 review F1.7 — a reclaim score printed in its ramp colour reads too ═══════════════ */

/**
 * The reclaim ramp (grey → amber → teal) printed raw as the score badge's
 * text: on a light card a 50 measured 1.36:1, and the best candidates 1.7–2.0
 * — while the size beside it, through sizeInk, passed. In Reclaim order the
 * badge is the only measure in a Largest Files row (B03). Measured here is
 * what the badge itself prints, resting and hovered (its hover tints its own
 * ground), at each confidence (whatever the confidence rule does to the
 * badge's opacity), on the card, the page and a chip, in both themes.
 */
test('every reclaim score the badge prints clears 4.5:1 — resting or hovered, at every confidence, in both themes (B21 review F1.7)', () => {
  const badge = lift<(path: string, fact: { score: number; confidence: string }) => string>(
    ['escapeHtml', 'hexToRgb', 'C_TEAL', 'mix', 'C_RC_LOW', 'reclaimRgb', 'reclaimColor', 'reclaimInk', 'reclaimBadge'], 'reclaimBadge');
  const tint = /^color-mix\(in srgb, currentColor ([\d.]+)%, transparent\)$/.exec(prop(ruleFor('.rc-badge:hover').body, 'background') ?? '');
  assert.ok(tint, 'a hovered or focused badge tints its ground with its own ink');
  const hoverShare = +tint![1] / 100;
  let checked = 0;
  for (const [name, palette] of THEMES) {
    const { page, card } = grounds(palette);
    const surfaces: Array<[string, RGB]> = [
      ['the card', card], ['the page', page],
      ['a chip on the card', paint('var(--surface-2)', palette, card)],
      ['a chip on the page', paint('var(--surface-2)', palette, page)],
    ];
    for (const confidence of ['high', 'medium', 'low']) {
      const rule = RULES.find((r) => parts(r).includes(`.rc-badge.conf-${confidence}`));
      const opacity = rule && prop(rule.body, 'opacity') !== null ? Number(prop(rule.body, 'opacity')) : 1;
      for (const [where, ground] of surfaces) {
        for (let score = 0; score <= 100; score++) {
          const printed = /style="color:([^"]+)"/.exec(badge('/c/x.mov', { score, confidence }));
          assert.ok(printed, 'the badge prints its score in a colour');
          if (printed![1].includes('var(--reclaim-ink)')) assert.ok(palette['--reclaim-ink'], `${name} declares the ramp's share of a score ink`);
          const expr = printed![1].replace(/var\(--reclaim-ink\)/g, palette['--reclaim-ink']);
          const ink = paint(expr, palette, ground);
          for (const hovered of [false, true]) {
            // The badge's opacity takes its text and its own background together.
            const back = hovered ? mix(ink, hoverShare, ground) : ground;
            const ratio = contrast(mix(ink, opacity, ground), mix(back, opacity, ground));
            checked++;
            assert.ok(ratio >= 4.5,
              `${name}: a ${confidence}-confidence ${score}${hovered ? ', hovered,' : ''} measures ${fmt(ratio)}:1 on ${where} (${expr}${opacity < 1 ? `, opacity ${opacity}` : ''})`);
          }
        }
      }
    }
  }
  assert.equal(checked, 2 * 3 * 4 * 101 * 2, `every score was measured (${checked})`);
});

test('no reclaim score is printed in its raw ramp colour — the tooltip and the breakdown take the badge’s ink (B21 review F1.7)', () => {
  const code = INDEX.slice(INDEX.indexOf('<script>'));
  const raw = [...code.matchAll(/color:\s*\$\{reclaimColor\(/g)].length;
  assert.equal(raw, 0, 'a raw reclaim colour as text is 1.4–2.6:1 on a light card');
  const inks = [...code.matchAll(/color:\s*\$\{reclaimInk\(/g)].length;
  assert.ok(inks >= 2, `the tooltip's score line and the breakdown's badge take the ink (${inks})`);
});

/* ═══════════════ B21 review F2.2 — medium confidence looks medium, measured ═══════════════ */

/** Every keyword `border-style` takes; `none` and `hidden` draw nothing. */
const BORDER_STYLES = ['none', 'hidden', 'solid', 'dashed', 'dotted', 'double', 'groove', 'ridge', 'inset', 'outset'];

/**
 * The ring a score badge paints at `confidence`, as the cascade resolves it:
 * the base `.rc-badge` border, then each border declaration of
 * `.rc-badge.conf-<confidence>` in order (no such rule: the base ring), and
 * that rule's opacity, which dims the ring with everything else. `width` is
 * in px; a shorthand that leaves a part out resets it to its initial value,
 * as the cascade does (`border: none` is a 3px-medium ring of style none).
 */
function badgeRing(confidence: string): { width: number; style: string; colour: string; opacity: number } {
  const length = (v: string) => {
    const m = /^(\d*\.?\d+)(px)?$/.exec(v.trim());
    assert.ok(m && (m[2] || +m[1] === 0), `a border width is a px length (got "${v}")`);
    return +m![1];
  };
  const shorthand = (v: string) => {
    const tokens = layers(v.replace(/\s+(?![^(]*\))/g, ','));
    const out = { width: 3, style: 'none', colour: 'currentColor' };
    for (const t of tokens) {
      if (BORDER_STYLES.includes(t)) out.style = t;
      else if (/^\d*\.?\d+(px)?$/.test(t)) out.width = length(t);
      else out.colour = t;
    }
    return out;
  };
  const base = prop(ruleFor('.rc-badge').body, 'border');
  assert.ok(base, 'the badge draws a ring');
  let { width, style, colour } = shorthand(base!);
  const own = RULES.find((r) => parts(r).includes(`.rc-badge.conf-${confidence}`));
  if (!own) return { width, style, colour, opacity: 1 };
  for (const [, k, v] of own.body.matchAll(/([a-z-]+)\s*:\s*([^;]+)/g)) {
    if (k === 'border') ({ width, style, colour } = shorthand(v.trim()));
    else if (k === 'border-width') width = length(v);
    else if (k === 'border-style') style = v.trim();
    else if (k === 'border-color') colour = v.trim();
    // A per-side or logical longhand would change the ring without this reading it: say so rather than measure the wrong ring.
    else assert.ok(!/^border-(top|right|bottom|left|block|inline|image)/.test(k), `the badge ring is read from border, border-width, border-style and border-color only (got ${k})`);
  }
  const opacity = prop(own.body, 'opacity');
  return { width, style, colour, opacity: opacity === null ? 1 : Number(opacity) };
}

/**
 * How loud a medium-confidence ring may be, as a share of a high-confidence
 * ring's contrast with the same ground. Two-thirds keeps the difference one
 * that is seen at a glance rather than measured: today's 55% ring sits at
 * under half on every ground, and a ring mixed at 80% or more would pass for
 * a full one.
 */
const MEDIUM_RING_MAX_SHARE = 2 / 3;

/**
 * How faint a medium-confidence ring may get: 2:1 against the ground under
 * it, on every ground, at every score. Not WCAG's 3:1 for a non-text
 * indicator, because the ring is not what carries the state — the tilde
 * before the score and the badge's accessible name say "medium confidence"
 * in words, and the score itself, at 4.5:1 or better, is what identifies the
 * control. But the ring is the at-a-glance difference between medium and
 * low, so it has to be seen: a 5% ring measures 1.06:1 and a transparent one
 * 1:1, both of which the ceiling above accepts. Today's 55% ring measures
 * 2.44:1 at its faintest; a ring mixed under about 45% falls below the floor.
 */
const MEDIUM_RING_MIN_CONTRAST = 2;

test('a medium-confidence badge draws a ring — seen, but quieter than a high-confidence one, and not a low one’s dashes — on every ground, at every score, in both themes (B21 review F2.2, F3.1)', () => {
  // Review: the only guard here passed with any declaration at all in the
  // medium rule — `border-color: currentColor`, which paints exactly the
  // high-confidence ring, kept it green. Measured instead: the ring each
  // confidence paints, in the badge's own ink, against the ground under it.
  // Review F3.1: that measure had a ceiling and no floor, so a medium ring
  // that vanished (transparent, `border-style: none`, a 5% mix) passed.
  const badge = lift<(path: string, fact: { score: number; confidence: string }) => string>(
    ['escapeHtml', 'hexToRgb', 'C_TEAL', 'mix', 'C_RC_LOW', 'reclaimRgb', 'reclaimColor', 'reclaimInk', 'reclaimBadge'], 'reclaimBadge');
  const ring = { high: badgeRing('high'), medium: badgeRing('medium'), low: badgeRing('low') };
  assert.ok(!['none', 'hidden'].includes(ring.medium.style), `a medium badge draws its ring (border-style ${ring.medium.style})`);
  assert.ok(ring.medium.width > 0, `a medium ring has a width (${ring.medium.width}px)`);
  assert.notEqual(ring.medium.style, ring.low.style, `a medium ring is not drawn like a low one (${ring.low.style})`);
  let checked = 0;
  for (const [name, palette] of THEMES) {
    const { page, card } = grounds(palette);
    const surfaces: Array<[string, RGB]> = [
      ['the card', card], ['the page', page],
      ['a chip on the card', paint('var(--surface-2)', palette, card)],
      ['a chip on the page', paint('var(--surface-2)', palette, page)],
    ];
    for (const [where, ground] of surfaces) {
      for (let score = 0; score <= 100; score++) {
        const loudness = (confidence: 'high' | 'medium') => {
          const printed = /style="color:([^"]+)"/.exec(badge('/c/x.mov', { score, confidence }));
          assert.ok(printed, 'the badge prints its score in a colour');
          const ink = paint(printed![1].replace(/var\(--reclaim-ink\)/g, palette['--reclaim-ink']), palette, ground);
          const r = ring[confidence];
          return contrast(mix(paint(r.colour, palette, ground, ink), r.opacity, ground), ground);
        };
        const high = loudness('high'), medium = loudness('medium');
        checked++;
        assert.ok(medium <= high * MEDIUM_RING_MAX_SHARE,
          `${name}: a medium-confidence ${score} rings at ${fmt(medium)}:1 on ${where}, a high one at ${fmt(high)}:1 — not a third quieter (${ring.medium.colour})`);
        assert.ok(medium >= MEDIUM_RING_MIN_CONTRAST,
          `${name}: a medium-confidence ${score} rings at ${fmt(medium)}:1 on ${where} — fainter than ${MEDIUM_RING_MIN_CONTRAST}:1, a ring nobody sees (${ring.medium.colour})`);
      }
    }
  }
  assert.equal(checked, 2 * 4 * 101, `every score was measured (${checked})`);
});
