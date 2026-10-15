import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Design pass of 14 Oct 2026 — the CSS and layout findings (G08, G10, G14,
 * G19, G20, G22, G25).
 *
 * Read from the built page, as it ships: the stylesheet is parsed into rules
 * and the markup sliced by id. Where a finding is about legibility the inks
 * are composited onto the grounds they sit on and measured by WCAG contrast
 * (the polishVisualTheme recipe); where it is about layout, the rule that
 * decides the layout is read. What only a browser can measure is listed in
 * the batch's browser checks.
 */

const INDEX = readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

const SHEET = (() => {
  const open = INDEX.indexOf('<style>');
  assert.notEqual(open, -1, 'the built page carries an inline stylesheet');
  return INDEX.slice(open + '<style>'.length, INDEX.indexOf('</style>', open));
})();
const CSS = SHEET.replace(/\/\*[\s\S]*?\*\//g, ' ');

type Rule = { selector: string; body: string };
const RULES: Rule[] = [...CSS.matchAll(/([^{}]*)\{([^{}]*)\}/g)]
  .map((m) => ({ selector: m[1].trim(), body: m[2] }))
  .filter((r) => r.selector && !r.selector.startsWith('@'));
const parts = (r: Rule) => r.selector.split(',').map((p) => p.trim());
/** Every rule whose selector list contains `sel` exactly. */
const rulesFor = (sel: string) => RULES.filter((x) => parts(x).includes(sel));
function ruleFor(sel: string): Rule {
  const r = rulesFor(sel)[0];
  assert.ok(r, `a rule for "${sel}" exists`);
  return r!;
}
/** The last-declared value of `name` in a body. */
function prop(body: string, name: string): string | null {
  let out: string | null = null;
  for (const m of body.matchAll(new RegExp(`(?:^|;)\\s*${name.replace(/[-]/g, '\\-')}\\s*:\\s*([^;]+)`, 'g'))) out = m[1].trim();
  return out;
}
/** `name` as the cascade leaves it across every rule for `sel`, in source order. */
function cascaded(sel: string, name: string): string | null {
  let out: string | null = null;
  for (const r of rulesFor(sel)) { const v = prop(r.body, name); if (v !== null) out = v; }
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
const LIGHT = { ...DARK, ...tokens(/^:root\[data-theme="light"\]$/) };
const THEMES = [['dark', DARK], ['light', LIGHT]] as const;

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
function mix(a: RGB, pct: number, b: RGB): RGB { return a.map((v, i) => pct * v + (1 - pct) * b[i]) as RGB; }
function luminance([r, g, b]: RGB): number {
  const f = (c: number) => (c /= 255) <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function contrast(a: RGB, b: RGB): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
const fmt = (n: number) => n.toFixed(2);
/** A colour expression over `ground`: var(), hex/rgb(a), color-mix(in srgb, A P%, B), transparent. */
function paint(expr: string, palette: Record<string, string>, ground: RGB): RGB {
  const e = expr.trim();
  const v = /^var\((--[a-z0-9-]+)\)$/.exec(e);
  if (v) { assert.ok(palette[v[1]], `${v[1]} is declared`); return paint(palette[v[1]], palette, ground); }
  if (e === 'transparent') return ground;
  const cm = /^color-mix\(in srgb,\s*(.+?)\s+([\d.]+)%,\s*(.+)\)$/.exec(e);
  if (cm) return mix(paint(cm[1], palette, ground), +cm[2] / 100, paint(cm[3], palette, ground));
  return over(e, ground);
}
const page = (palette: Record<string, string>) => rgb(palette['--bg-1']);
const card = (palette: Record<string, string>) => over(palette['--glass-strong'], page(palette));

/** The markup of the element with `id`, through its matching close tag. */
function element(id: string): string {
  const at = INDEX.indexOf(`id="${id}"`);
  assert.notEqual(at, -1, `#${id} is in the page`);
  const open = INDEX.lastIndexOf('<', at);
  const tag = /^<([a-z0-9]+)/.exec(INDEX.slice(open))![1];
  let depth = 0;
  const re = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'g');
  re.lastIndex = open;
  for (let m = re.exec(INDEX); m; m = re.exec(INDEX)) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return INDEX.slice(open, m.index + m[0].length);
  }
  return assert.fail(`#${id} never closes`);
}

/* ══════════════ G19 — typing in Highlight does not push the map down ══════════════ */

test('G19: the match bar is a layer over the foot of the map, not a row above it — the map does not move when it appears', () => {
  // The bar (saved views · Save view · Stage N files · "18 matches — 17
  // shown here…") appeared between the toolbar and the map the moment a
  // query had something to say, and the map jumped down ~56 px under the
  // user's eyes (shots/071 vs 040). Inside the map's card and out of flow,
  // it can no longer move the canvas: treemapCanvasHeight measures the card,
  // and nothing in the card's flow changes when the bar shows.
  const wrap = element('treemapWrap');
  assert.ok(wrap.includes('id="tmQueryBar"'), 'the bar lives in the map\'s card');
  assert.ok(wrap.indexOf('id="tmQueryBar"') > wrap.indexOf('id="treemapCanvas"'), 'after the canvas, painted over it');
  const section = element('view-treemap');
  const rows = section.slice(0, section.indexOf('id="treemapWrap"'));
  assert.ok(!rows.includes('id="tmQueryBar"'), 'no longer a row between the toolbar and the map');
  const bar = '#treemapWrap > .tm-querybar';
  assert.equal(cascaded(bar, 'position'), 'absolute', 'out of the card\'s flow');
  assert.match(cascaded(bar, 'bottom') ?? '', /^\d+px$/, 'anchored to the foot of the map, over its smallest tiles');
  assert.equal(prop(ruleFor('#treemapWrap').body, 'position'), 'relative', 'and the card is what it is positioned in');
  assert.ok(Number(cascaded(bar, 'z-index')) >= 6, 'above the canvas, the orbs and the live feed\'s level');
});

test('G19: the floating bar is opaque and its message reads at 4.5:1 in both themes', () => {
  // Floating over tiles of any colour, a translucent bar would put its
  // 11.5px message on whatever is under it.
  const bg = cascaded('#treemapWrap > .tm-querybar', 'background');
  assert.ok(bg, 'the bar paints its own background');
  for (const [name, palette] of THEMES) {
    const under = paint(bg!, palette, [255, 0, 0]);
    const elsewhere = paint(bg!, palette, [0, 0, 255]);
    assert.deepEqual(under.map(Math.round), elsewhere.map(Math.round), `${name}: the bar is opaque — no tile shows through it`);
    for (const sel of ['.tm-queryerr', '.tm-queryerr.okmsg']) {
      const ink = paint(cascaded(sel, 'color')!.replace(/^var\(--danger,\s*#[0-9a-f]+\)$/i, 'var(--danger)'), palette, under);
      const c = contrast(ink, under);
      assert.ok(c >= 4.5, `${name}: ${sel} measures ${fmt(c)}:1 on the bar`);
    }
  }
});

test('G19: while the cart is open it stands left of the cart, as the preview banner does', () => {
  // The open cart is a fixed 366 px layer over the right of the map; a bar
  // centred under it would lose its Stage button there.
  const r = ruleFor('body.cart-open #treemapWrap > .tm-querybar');
  assert.equal(prop(r.body, 'transform'), 'none');
  assert.match(prop(r.body, 'left') ?? '', /^\d+px$/);
  assert.match(prop(r.body, 'max-width') ?? '', /402px/, 'the same allowance the preview banner keeps for the dock');
});

/* ══════════════ G08 — every <select> keeps its arrow, in both themes, at rest, hovered and focused ══════════════ */

/** CSS specificity of one compound-selector chain, as [ids, classes|attrs|pseudo-classes, elements]. */
function specificity(sel: string): [number, number, number] {
  const s = sel.replace(/::[a-z-]+/g, ' ');
  const ids = (s.match(/#[\w-]+/g) ?? []).length;
  const cls = (s.match(/\.[\w-]+|\[[^\]]*\]|:(?!:)[\w-]+(\([^)]*\))?/g) ?? []).length;
  const els = (s.replace(/\[[^\]]*\]|\([^)]*\)/g, '').match(/(^|[\s>+~])[a-z][\w-]*/gi) ?? []).length;
  return [ids, cls, els];
}
const cmp = (a: [number, number, number], b: [number, number, number]) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/**
 * The background-image a `select` ends up with, in `theme`, in `state`
 * ('' | ':hover' | ':focus'): every rule whose selector names a select in
 * that state (bare, or under the theme's root), its `background` shorthand
 * counted as setting the image to its own gradients (or none), the winner by
 * specificity and then by source order.
 */
function selectImage(theme: 'dark' | 'light', state: '' | ':hover' | ':focus'): string {
  const applies = (p: string) => {
    const bare = p.replace(/^:root\[data-theme="light"\]\s+/, '');
    if (bare !== p && theme !== 'light') return false;
    return bare === 'select' || (state !== '' && bare === `select${state}`);
  };
  let best: { spec: [number, number, number]; order: number; image: string } | null = null;
  for (const [order, r] of RULES.entries()) {
    for (const p of parts(r)) {
      if (!applies(p)) continue;
      for (const m of r.body.matchAll(/(?:^|;)\s*(background(?:-image)?)\s*:\s*([^;]+)/g)) {
        const image = m[1] === 'background-image' ? m[2].trim()
          : (m[2].match(/(?:linear|radial|conic)-gradient\((?:[^()]|\([^()]*\))*\)/g) ?? ['none']).join(', ');
        const spec = specificity(p);
        if (!best || cmp(spec, best.spec) > 0 || (cmp(spec, best.spec) === 0 && order >= best.order)) best = { spec, order, image };
      }
    }
  }
  assert.ok(best, `some rule paints a ${theme} select${state}`);
  return best!.image;
}

test('G08: a select shows its arrow in both themes — resting, hovered and focused', () => {
  // `:root[data-theme="light"] select { background: … }` re-set the whole
  // background after `select {}` had drawn its arrow into background-image,
  // so every select in the light theme lost it.
  const arrow = selectImage('dark', '');
  assert.match(arrow, /^linear-gradient\(45deg,.*\),\s*linear-gradient\(135deg,/, `the dark select draws its two-stroke arrow (${arrow})`);
  for (const theme of ['dark', 'light'] as const) {
    for (const state of ['', ':hover', ':focus'] as const) {
      assert.equal(selectImage(theme, state), arrow, `${theme} select${state} keeps the arrow`);
    }
  }
});

/* ══════════════ G10 — a focused Duplicates group header shows its focus ring ══════════════ */

test('G10: a focused Duplicates group header draws its ring inside itself, where the group\'s overflow cannot clip it', () => {
  // The app's ring is 2px at a 2px offset — outside the element — and the
  // header's card (.dup-group) has overflow: hidden, so the ring was cut off
  // entirely (shots/110b).
  assert.equal(cascaded('.dup-group', 'overflow'), 'hidden', 'the group clips what spills out of it');
  const r = ruleFor('.dup-head:focus-visible');
  const outline = prop(r.body, 'outline') ?? '';
  const width = parseFloat(/([\d.]+)px/.exec(outline)?.[1] ?? '0');
  assert.ok(width >= 2, `a 2px ring (${outline})`);
  assert.match(outline, /var\(--accent\)/, 'in the app\'s ring colour');
  const offset = parseFloat(prop(r.body, 'outline-offset') ?? '0');
  assert.ok(offset <= -width, `drawn inside the header (outline-offset ${offset}px against a ${width}px ring)`);
  for (const [name, palette] of THEMES) {
    const ground = card(palette);
    const c = contrast(paint('var(--accent)', palette, ground), ground);
    assert.ok(c >= 3, `${name}: the ring measures ${fmt(c)}:1 against the card (a UI component needs 3:1)`);
  }
});

/* ══════════════ G14 — Quick Stats always shows the largest file's size ══════════════ */

/** A top-level `[async ]function name(…) {…}` from the built page, brace matched. */
function fnSource(name: string): string {
  const at = INDEX.search(new RegExp(`\\n(?:async )?function ${name}\\(`)) + 1;
  assert.ok(at > 0, `${name} is in the page`);
  // The body's brace comes after the parameter list, which may destructure.
  let i0 = INDEX.indexOf('(', at), parens = 0;
  for (; i0 < INDEX.length; i0++) { if (INDEX[i0] === '(') parens++; else if (INDEX[i0] === ')' && --parens === 0) break; }
  let depth = 0;
  for (let i = INDEX.indexOf('{', i0); i < INDEX.length; i++) {
    if (INDEX[i] === '{') depth++;
    else if (INDEX[i] === '}' && --depth === 0) return INDEX.slice(at, i + 1);
  }
  return assert.fail(`${name} never closes`);
}

test('G14: the largest file is a name that gives way and a size that never does', () => {
  // "Google Chrome Framework · 5…": name and size were one string in a
  // label capped at 200 px inside a 514 px tile, so the size — the fact the
  // tile exists for — was what got cut.
  const id = INDEX.indexOf('id="statLargest"');
  const tile = INDEX.slice(INDEX.lastIndexOf('class="stat-tile', id), INDEX.indexOf('Largest file', id));
  assert.match(tile, /<span class="nm" id="statLargest">/, 'the name is an element of its own');
  assert.match(tile, /<span class="sz" id="statLargestSize">/, 'and so is the size, after it');
  const nm = ruleFor('.stat-largest .nm').body, sz = ruleFor('.stat-largest .sz').body;
  assert.equal(prop(nm, 'text-overflow'), 'ellipsis', 'the name ellipsizes');
  assert.equal(prop(nm, 'overflow'), 'hidden');
  assert.equal(prop(nm, 'min-width'), '0', 'and may shrink below its text');
  assert.equal(prop(sz, 'flex'), 'none', 'the size never shrinks');
  assert.equal(cascaded('.stat-tile .v.stat-largest', 'display'), 'flex', 'the two share one line');
  assert.equal(cascaded('.stat-tile > div', 'min-width'), '0', 'and the tile\'s text column may shrink, so the name can give way inside it');
  assert.equal(cascaded('.stat-tile .v.small', 'max-width'), null, 'no fixed cap: the line takes the tile\'s width');
});

test('G14: the dashboard writes the name and the size apart, and clears both', async () => {
  const els: Record<string, { textContent: string; innerHTML: string }> = {};
  const $ = (id: string) => (els[id] ??= { textContent: '', innerHTML: '' });
  const api = async (url: string) => {
    if (url.includes('large-files')) return { files: [{ name: 'Google Chrome Framework', path: '/A/Google Chrome Framework', size: 5_012_000_000 }] };
    if (url.includes('file-types')) return { types: [] };
    return { folders: [] };
  };
  const noop = () => {};
  const run = new Function('$', 'state', 'api', 'seedNodes', 'formatBytes', 'escapeHtml', 'refreshBigFiles', 'renderBigFolders', 'renderDonut', 'fxDonutLoadingSync', 'toast',
    `'use strict'; ${fnSource('loadDashboardLists')} return loadDashboardLists;`)(
    $, { scanId: 's1', largest: [], types: [], bigFolders: [], donut: {} }, api, noop, (n: number) => `${(n / 1e9).toFixed(1)} GB`, (s: string) => s,
    noop, noop, noop, noop, noop) as () => Promise<boolean>;
  assert.equal(await run(), true);
  assert.equal(els.statLargest.textContent, 'Google Chrome Framework');
  assert.equal(els.statLargestSize.textContent, ' · 5.0 GB');
  // Every place that takes the figure down takes both halves down.
  const resets = [...INDEX.matchAll(/\$\('statLargest'\)\.textContent = '–';/g)];
  assert.ok(resets.length >= 2, 'the figure is taken down when a scan starts and when an index paint has none');
  for (const m of resets) {
    assert.match(INDEX.slice(m.index!, m.index! + 120), /^\$\('statLargest'\)\.textContent = '–';\s*\$\('statLargestSize'\)\.textContent = '';/,
      'and its size with it');
  }
  const sets = [...INDEX.matchAll(/\$\('statLargest'\)\.textContent = largest \?/g)];
  assert.ok(sets.length >= 2, 'both painters write the name');
  for (const m of sets) assert.match(INDEX.slice(m.index!, m.index! + 200), /\$\('statLargestSize'\)\.textContent = largest \?/, 'and the size beside it');
});

/* ══════════════ G20 — an empty stage of a meter shows its track ══════════════ */

test('G20: every stage of the Clean Up and Duplicates meters draws a visible track, so an empty one reads as empty, not as missing', () => {
  // With nothing staged, "Suggested / Staged / Projected free" was one blue
  // block and two 2 px hairlines: a lone button, not a meter (shots/081).
  // The track is the stage's whole extent; the value is drawn inside it.
  // Its edge and fill are decoration — the stage's name, value and percent
  // are printed under it — so the floors are for being seen, not read.
  const fill = cascaded('.fx-fun-track', 'background');
  const ring = cascaded('.fx-fun-track', 'box-shadow');
  assert.ok(fill, 'the track paints a fill');
  assert.match(ring ?? '', /^inset 0 0 0 1px (var\(--[a-z0-9-]+\))$/, 'and a 1px inner edge');
  assert.equal(cascaded('.fx-fun-track', 'border-radius'), prop(ruleFor('.fx-fun-seg').body, 'border-radius'), 'with the value segment\'s corners');
  const edge = /(var\(--[a-z0-9-]+\))$/.exec(ring!)![1];
  for (const [name, palette] of THEMES) {
    for (const [where, ground] of [['the Clean Up sheet', page(palette)], ['a card', card(palette)]] as const) {
      const f = contrast(paint(fill!, palette, ground), ground);
      const e = contrast(paint(edge, palette, ground), ground);
      assert.ok(f >= 1.15, `${name}, ${where}: the track's fill stands off the ground (${fmt(f)}:1, floor 1.15)`);
      assert.ok(e >= 1.4, `${name}, ${where}: its edge is seen (${fmt(e)}:1, floor 1.4)`);
    }
  }
});

/* ══════════════ G25 — the hero's feature labels do not dress as buttons ══════════════ */

test('G25: the three hero features read as static labels — no pill border or fill, no hover, no pointer', () => {
  // "Reads a whole drive in minutes", "Trash-only deletes", "No tracking,
  // fully local" wore the exact dress of the clickable pills (Live, Lens,
  // "Show me") — border, fill, 99px radius — and did nothing when clicked.
  const row = INDEX.slice(INDEX.indexOf('<div class="feature-row">'), INDEX.indexOf('</div>', INDEX.indexOf('<div class="feature-row">')));
  assert.equal([...row.matchAll(/<span class="feature">/g)].length, 3, 'the three features are spans, not controls');
  assert.doesNotMatch(row, /<button|<a\b|tabindex|role="button"/, 'nothing in the row is focusable or clickable');
  const f = rulesFor('.feature');
  assert.ok(f.length >= 1, '.feature is styled');
  const decl = (n: string) => cascaded('.feature', n);
  for (const [n, ok] of [['border', /^(none|0)$/], ['background', /^(none|transparent)$/]] as const) {
    const v = decl(n);
    assert.ok(v === null || ok.test(v), `.feature has no ${n} (${v})`);
  }
  assert.equal(decl('box-shadow'), null, 'and no lift');
  assert.ok(!/--cur-hand|pointer/.test(decl('cursor') ?? ''), 'and no hand cursor');
  const hovers = RULES.filter((r) => parts(r).some((p) => /\.feature(?:\s|:|$)/.test(p) && /:hover|:active/.test(p)));
  assert.deepEqual(hovers.map((r) => r.selector), [], 'nothing changes under the pointer');
  // Still legible, as the quiet text it now is.
  for (const [name, palette] of THEMES) {
    const c = contrast(paint(decl('color')!, palette, page(palette)), page(palette));
    assert.ok(c >= 4.5, `${name}: the feature text measures ${fmt(c)}:1 on the page`);
  }
});

/* ══════════════ G22 — no alarm colour on neutral information ══════════════ */

test('G22: Fleet\'s "What they can never see" is a reassurance, drawn as neutrally as what they would see', () => {
  // It was a red danger box (6% --danger, a --danger-line edge) under a
  // "ban" glyph: the reassuring half of the disclosure dressed as an alarm.
  const never = rulesFor('.fleet-disclosure .fl-col.never');
  for (const r of never) {
    assert.doesNotMatch(r.body, /--danger|--warn/, `"${r.selector}" paints no alarm colour (${r.body.trim()})`);
  }
  const fleet = fnSource('renderFleet');
  const col = /<div class="fl-col never"><b>\$\{icon\('(\w+)'/.exec(fleet);
  assert.ok(col, 'the "never" column is rendered');
  assert.notEqual(col![1], 'ban', 'under a glyph that is not a prohibition sign');
  assert.match(fleet, /fleet-alarm/, 'the real alarm — pairing stopped after wrong codes — keeps its own box');
  assert.match(ruleFor('.fleet-alarm').body, /--warn|--danger/, 'in an alert colour');
});

/** renderTopology from the built page over `topo`, with home and scan root at the given paths; each disk's title → whether its bar is danger red. */
function topologyBars(topo: unknown, homeDir: string | null, rootPath: string | null): Record<string, boolean> {
  const body = { innerHTML: '', classList: { remove() {}, add() {} } };
  const deps: Record<string, unknown> = {
    $: () => body,
    state: { system: homeDir ? { homeDir } : null, root: rootPath ? { path: rootPath } : null },
    FxNum: { rollHtml: (el: { innerHTML: string }, html: string) => { el.innerHTML = html; } },
    fxBarsIn() {}, wireTopologyActions() {},
    formatBytes: (n: number) => `${n} B`, escapeHtml: (s: string) => String(s), fxBarStyle: () => 'background:var(--fx-ramp);',
  };
  const keys = Object.keys(deps);
  const names = ['renderTopology'];
  for (let attempt = 0; attempt < 12; attempt++) {
    const src = `'use strict'; ${names.map((n) => (/^[A-Z_]+$/.test(n) ? constSource(n) : fnSource(n))).join('\n')} return renderTopology;`;
    try {
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      (new Function(...keys, src)(...keys.map((k) => deps[k])) as (t: unknown) => void)(topo);
      break;
    } catch (e) {
      const missing = /(\w+) is not defined/.exec(String((e as Error).message))?.[1];
      if (!missing || names.includes(missing)) throw e;
      names.push(missing);
    }
  }
  const out: Record<string, boolean> = {};
  for (const disk of body.innerHTML.split('<div class="topo-disk">').slice(1)) {
    const title = /<span class="nm" title="([^"]*)"/.exec(disk)![1];
    const bar = /<div class="topo-track"><div class="fx-bar-fill"[^>]*style="([^"]*)"/.exec(disk);
    assert.ok(bar, `${title} draws its usage bar`);
    out[title] = /var\(--danger\)/.test(bar![1]);
  }
  return out;
}
/** A top-level `const NAME = …;` from the built page. */
function constSource(name: string): string {
  const at = INDEX.indexOf(`\nconst ${name} = `) + 1;
  assert.ok(at > 0, `${name} is in the page`);
  return INDEX.slice(at, INDEX.indexOf(';', at) + 1);
}

const GB = 1e9;
const TOPO = {
  physicalDisks: [
    { id: 'disk0', name: 'APPLE SSD AP0512Z', sizeBytes: 500 * GB, rotational: false },
    { id: 'disk9', name: 'Disk Image', sizeBytes: 9.1 * GB, rotational: false },
    { id: 'disk12', name: 'Backup Drive', sizeBytes: 2000 * GB, rotational: true },
  ],
  logicalVolumes: [
    { id: 'disk3s5', name: 'Data', mountPoint: '/System/Volumes/Data', usedBytes: 258 * GB, sizeBytes: 500 * GB, freeBytes: 205 * GB, physicalDiskIds: ['disk0'], kind: 'apfs' },
    { id: 'disk3s1', name: 'Macintosh HD', mountPoint: '/', usedBytes: 13.7 * GB, sizeBytes: 500 * GB, freeBytes: 205 * GB, physicalDiskIds: ['disk0'], kind: 'apfs' },
    { id: 'disk9s1', name: 'iOS 18.4 Simulator', mountPoint: '/Library/Developer/CoreSimulator/Volumes/iOS_22E238', usedBytes: 8.8 * GB, sizeBytes: 9.1 * GB, freeBytes: 0.26 * GB, physicalDiskIds: ['disk9'], kind: 'apfs' },
    { id: 'disk12s2', name: 'Backup', mountPoint: '/Volumes/Backup', usedBytes: 1900 * GB, sizeBytes: 2000 * GB, freeBytes: 100 * GB, physicalDiskIds: ['disk12'], kind: 'apfs' },
  ],
};
const withBoot = (usedGB: number) => ({ ...TOPO, logicalVolumes: TOPO.logicalVolumes.map((v) => (v.id === 'disk3s5' ? { ...v, usedBytes: usedGB * GB } : v)) });

test('G22: Disk Topology paints a full disk image or backup drive neutrally — a disk is red only when low where you work', () => {
  // Three iOS simulator disk images, 96–97% full by construction, drew three
  // red bars beside a healthy main disk. TreeMap alarms where low space
  // hurts: the disk holding your home folder (what All Storage's "This Mac"
  // row judges) or the folder you scanned.
  const calm = topologyBars(TOPO, '/Users/me', '/Users/me/Projects');
  assert.deepEqual(calm, { 'APPLE SSD AP0512Z': false, 'Disk Image': false, 'Backup Drive': false },
    'a 97%-full disk image and a 95%-full backup drive are not alarms; a 54% main disk is not either');
  const full = topologyBars(withBoot(440), '/Users/me', '/Users/me/Projects');
  assert.equal(full['APPLE SSD AP0512Z'], true, 'the main disk past the threshold, holding the home folder, is red');
  assert.equal(full['Disk Image'], false, 'and the disk image stays calm beside it');
  const scanned = topologyBars(TOPO, '/Users/me', '/Volumes/Backup/Photos');
  assert.equal(scanned['Backup Drive'], true, 'a nearly full drive holding the folder on screen is red');
  assert.equal(topologyBars(TOPO, '/Users/me', '/Volumes/BackupOld/x')['Backup Drive'], false,
    'a folder on /Volumes/BackupOld is not on the drive mounted at /Volumes/Backup — a mount point is a folder boundary');
  const unknownHome = topologyBars(withBoot(440), null, null);
  assert.equal(unknownHome['APPLE SSD AP0512Z'], false, 'with no home or folder known, nothing is judged near — no alarm on a guess');
});

test('G22: the topology\'s threshold is the All Storage strip\'s — one number, read from both', () => {
  const strip = /const danger = used \/ total > ([\d.]+);/.exec(fnSource('asqStrip'));
  assert.ok(strip, 'the All Storage strip states its threshold');
  const share = /const SPACE_LOW_USED_SHARE = ([\d.]+);/.exec(INDEX);
  assert.ok(share, 'the topology names its threshold');
  assert.equal(Number(share![1]), Number(strip![1]), 'and they are the same number');
  // Exactly at the threshold: the strip's `>` is the topology's `>`.
  const edge = topologyBars(withBoot(Number(share![1]) * 500 - 13.7), '/Users/me', null);
  assert.equal(edge['APPLE SSD AP0512Z'], false, 'at the threshold exactly, not yet');
});

test('G22: Missing GB\'s reason a line is unknown is plain muted text, not warning text, in both themes', () => {
  // "macOS does not report purgeable space…" is a fact about what can be
  // measured, printed in warning yellow under the Purgeable line.
  const sel = '.mg-row .mg-reason';
  const colours = RULES.filter((r) => parts(r).some((p) => p.replace(/^:root\[data-theme="light"\]\s+/, '') === sel))
    .map((r) => prop(r.body, 'color')).filter((v): v is string => v !== null);
  assert.ok(colours.length >= 1, 'the reason is styled');
  for (const c of colours) assert.equal(c, prop(ruleFor('.muted').body, 'color'), `the reason takes the .muted ink, not ${c}`);
  for (const [name, palette] of THEMES) {
    const ratio = contrast(paint(colours[colours.length - 1], palette, card(palette)), card(palette));
    assert.ok(ratio >= 4.5, `${name}: the reason measures ${fmt(ratio)}:1 on the card`);
  }
});
