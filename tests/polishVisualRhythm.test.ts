import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Polish round — rhythm: one radius per role, rows that keep their height
 * when the rail folds, a focus ring that follows the control's own corners,
 * and breakpoints that measure the view rather than the window.
 *
 * Structural pins, because every one of these is a layout fact no
 * behavioural test can see: a refactor that quietly retypes `11px` where a
 * token belongs, or that adds a vertical padding to the collapsed rail rule,
 * ships a visible defect with a green suite.
 */

const INDEX = readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

const SHEET = (() => {
  const open = INDEX.indexOf('<style>');
  const close = INDEX.indexOf('</style>', open);
  assert.ok(open !== -1 && close !== -1, 'the built page carries an inline stylesheet');
  return INDEX.slice(open + '<style>'.length, close);
})();
const CSS = SHEET.replace(/\/\*[\s\S]*?\*\//g, ' ');

type Rule = { selector: string; body: string };
const RULES: Rule[] = [...CSS.matchAll(/([^{}]*)\{([^{}]*)\}/g)]
  .map((m) => ({ selector: m[1].trim(), body: m[2] }))
  .filter((r) => r.selector && !r.selector.startsWith('@'));
const parts = (r: Rule) => r.selector.split(',').map((p) => p.trim());
const rulesFor = (sel: string) => RULES.filter((r) => parts(r).includes(sel));
function prop(body: string, name: string): string | null {
  let out: string | null = null;
  for (const m of body.matchAll(new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([^;]+)`, 'g'))) out = m[1].trim();
  return out;
}

/** An at-rule from its opening anchor to its MATCHING brace. */
function braced(openAnchor: string, hay = CSS): string {
  const start = hay.indexOf(openAnchor);
  assert.notEqual(start, -1, `block "${openAnchor}" exists in the stylesheet`);
  let depth = 0;
  for (let i = hay.indexOf('{', start); i < hay.length; i++) {
    if (hay[i] === '{') depth++;
    else if (hay[i] === '}' && --depth === 0) return hay.slice(start, i + 1);
  }
  return assert.fail(`block "${openAnchor}" never closes`);
}

/* ═══════════════ the sidebar rail keeps its row height ═══════════════ */

test('collapsing the sidebar changes no tab’s vertical padding — rows share one height in both states', () => {
  const expanded = rulesFor('.tabbar button');
  assert.ok(expanded.length >= 1, 'the expanded tab rule exists');
  assert.match(prop(expanded[0].body, 'padding') ?? '', /^[\d.]+px\s+[\d.]+px$/, 'the expanded row states its padding as vertical horizontal');
  const collapsed = rulesFor('#sideNav.collapsed .tabbar button');
  assert.ok(collapsed.length >= 1, 'the collapsed tab rule exists');
  for (const r of collapsed) {
    assert.equal(prop(r.body, 'padding'), null, 'the rail rule may not restate the padding shorthand — a different vertical value drops every tab by 2px × its index');
    assert.equal(prop(r.body, 'padding-top'), null);
    assert.equal(prop(r.body, 'padding-bottom'), null);
    assert.equal(prop(r.body, 'min-height'), null);
    assert.equal(prop(r.body, 'height'), null);
  }
  assert.ok(collapsed.some((r) => prop(r.body, 'padding-left') === '0' && prop(r.body, 'padding-right') === '0'),
    'the rail centres the icon by dropping only the horizontal padding');
  // The foot buttons follow the same rule: .btn is height-by-min-height, both states keep vertical 0.
  const foot = rulesFor('#sideNav.collapsed .side-foot .btn');
  assert.ok(foot.length && /^0\s+\d+px$/.test(prop(foot[0].body, 'padding') ?? ''), 'the collapsed foot buttons keep zero vertical padding');
});

/* ═══════════════ focus rings follow the control ═══════════════ */

test('the global :focus-visible ring draws on the control’s own corners — it forces no border-radius', () => {
  const rule = RULES.find((r) => r.selector === ':focus-visible');
  assert.ok(rule, 'the global focus rule exists');
  assert.equal(prop(rule!.body, 'border-radius'), null,
    'a radius here reshapes every .btn (10px) and .icon-btn (9px) the instant focus lands — Chromium draws the outline along the element’s own radius');
  assert.match(rule!.body, /outline:\s*2px solid var\(--accent\)/, 'the ring itself is unchanged');
  const natives = RULES.find((r) => parts(r).includes('input[type="checkbox"]:focus-visible'));
  assert.ok(natives && prop(natives.body, 'border-radius'), 'radius-less natives get a small radius of their own');
});

/* ═══════════════ one radius per role ═══════════════ */

test('inset panels share --r-md and nested notes share --r-sm — no 8/9/10/11px literals on the panel classes', () => {
  const panels = ['.fleet-disclosure .fl-col', '.fleet-code', '.fleet-help', '.fleet-peer', '.sec-item', '.game-title',
    '.vid-warn', '.pm-row', '.dh-unknown', '.drive-tile'];
  const notes = ['.smart-why', '.rc-why', '.alloc-diag .note'];
  for (const [list, tok] of [[panels, 'var(--r-md)'], [notes, 'var(--r-sm)']] as const) {
    for (const sel of list) {
      const rs = rulesFor(sel);
      assert.ok(rs.length >= 1, `${sel} is styled`);
      const radii = rs.map((r) => prop(r.body, 'border-radius')).filter((v): v is string => v !== null);
      assert.ok(radii.length >= 1, `${sel} states a radius`);
      for (const v of radii) assert.equal(v, tok, `${sel} uses ${tok}, not a literal (${v})`);
    }
  }
  for (const r of RULES) {
    const v = prop(r.body, 'border-radius');
    if (!v) continue;
    const literal = /^(8|9|10|11)px$/.test(v);
    const onPanel = parts(r).some((p) => [...panels, ...notes].includes(p));
    assert.ok(!(literal && onPanel), `"${r.selector}" reintroduces a literal ${v} on a panel class`);
  }
});

test('exact and near-duplicate groups share one quiet-row recipe, in both themes', () => {
  const shared = RULES.find((r) => {
    const ps = parts(r);
    return ps.includes('.dup-group') && ps.includes('.nd-cluster')
      && ps.includes(':root[data-theme="light"] .dup-group') && ps.includes(':root[data-theme="light"] .nd-cluster');
  });
  assert.ok(shared, 'one rule carries both list cards for both themes — the light .glass override outranks a bare class rule');
  assert.equal(prop(shared!.body, 'border-radius'), 'var(--r-md)', 'the calmer list radius is the token');
  assert.match(prop(shared!.body, 'box-shadow') ?? '', /var\(--shadow-1\)/, 'a hairline lift, not the full card shadow, repeated hundreds of times');
  assert.doesNotMatch(prop(shared!.body, 'box-shadow') ?? '', /var\(--shadow-2\)/);
  // Nothing later re-splits them.
  for (const sel of ['.dup-group', '.nd-cluster']) {
    for (const r of rulesFor(sel)) {
      const v = prop(r.body, 'border-radius');
      assert.ok(v === null || v === 'var(--r-md)', `${sel} never re-declares a different radius (${v})`);
    }
  }
});

/* ═══════════════ breakpoints measure the view ═══════════════ */

test('the dashboard, trends and city breakpoints are container queries on the view — the sidebar rail buys real room', () => {
  const view = rulesFor('.view');
  assert.ok(view.some((r) => prop(r.body, 'container-type') === 'inline-size'), '.view is a size container');
  for (const px of ['1500px', '1120px', '1100px']) {
    assert.ok(!CSS.includes(`@media (max-width: ${px})`), `the viewport query at ${px} is gone`);
  }
  const wide = braced('@container (max-width: 1200px) {');
  assert.match(wide, /\.dash-grid\s*\{\s*grid-template-columns:\s*1fr 1fr;\s*\}/, 'two equal columns when the view narrows');
  assert.match(wide, /\.quick-stats\s*\{\s*grid-template-columns:\s*1fr;\s*\}/);
  assert.match(wide, /\.trends-grid\s*\{\s*grid-template-columns:\s*1fr;\s*\}/);
  const narrow = braced('@container (max-width: 820px) {');
  assert.match(narrow, /\.dash-grid\s*\{\s*grid-template-columns:\s*1fr;\s*\}/, 'one column when the view is narrow');
  const legend = braced('@container (max-width: 800px) {');
  assert.match(legend, /#cityLegend \.tml-item\s*\{\s*white-space:\s*normal;\s*\}/, 'the city legend wraps on a narrow view, not a narrow window');
  // The thresholds are the old viewport ones minus what an expanded sidebar costs, so the expanded case is unchanged.
  assert.ok(1500 - 1200 >= 244 + 48 && 1120 - 820 >= 244 + 48, 'each container threshold sits ~300px under its old viewport twin');
});
