import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Premium polish round — structural pins.
 *
 * Two complaints drove this round and both were layout collapses that no
 * behavioural test could see: legend size values wrapping into two lines the
 * moment the window left fullscreen, and the treemap toolbar wrapping into
 * ragged accidental rows. These pins hold the load-bearing CSS/markup so a
 * refactor cannot quietly reintroduce either.
 */

const INDEX = readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

function block(startAnchor: string, endAnchor: string): string {
  const start = INDEX.indexOf(startAnchor);
  assert.notEqual(start, -1, `anchor "${startAnchor}" exists in index.html`);
  const end = INDEX.indexOf(endAnchor, start + startAnchor.length);
  assert.notEqual(end, -1, `anchor "${endAnchor}" follows it`);
  return INDEX.slice(start, end);
}

/* ── The legend: one row is one line, at every window width ── */

test('legend size values refuse to wrap — the fullscreen-only bug', () => {
  const styles = block('FX: Charts — styles', 'end FX: Charts — styles');
  const val = styles.match(/\.fx-li-val\s*\{[^}]*\}/);
  assert.ok(val, '.fx-li-val rule exists');
  assert.match(val![0], /white-space:\s*nowrap/, 'the value column never breaks into two lines');
});

test('legend columns collapse progressively instead of crushing', () => {
  const styles = block('FX: Charts — styles', 'end FX: Charts — styles');
  // The legends measure themselves, not the window: container queries.
  assert.match(styles, /\.fx-legend[^{]*\{[^}]*container-type:\s*inline-size/,
    'fx-legend is a size container');
  assert.match(INDEX, /\.donut-legend\s*\{[^}]*container-type:\s*inline-size/,
    'the dashboard donut legend is a size container too');
  // Under pressure the decorative mini-bar goes first, the count second —
  // the value and percent survive at every width.
  const collapse = styles.match(/@container[^{]*\(max-width[^{]*\{[\s\S]*?\.fx-li-track[\s\S]*?display:\s*none/);
  assert.ok(collapse, 'a narrow-container rule hides the mini bar track');
  const collapse2 = styles.match(/@container[^{]*\(max-width[^{]*\{[\s\S]*?\.fx-li-cnt[\s\S]*?display:\s*none/);
  assert.ok(collapse2, 'a narrower-container rule hides the file count');
});

/* ── The toolbar: two deliberate rows, a truly centred view switcher ── */

test('treemap toolbar is two designed rows, not one wrapping soup', () => {
  const tm = block('<div class="tm-toolbar">', 'tm-querybar');
  assert.match(tm, /tb-row tb-row-nav/, 'row one exists (nav | view | find)');
  assert.match(tm, /tb-row tb-row-controls/, 'row two exists (appearance | modes | actions)');
  const navRow = tm.slice(tm.indexOf('tb-row-nav'), tm.indexOf('tb-row-controls'));
  assert.match(navRow, /tmViewSeg/, 'the view switcher lives in the nav row');
  const controls = tm.slice(tm.indexOf('tb-row-controls'));
  assert.match(controls, /tmColorSeg/, 'color modes live in the controls row');
  assert.match(controls, /tmExportBtn/, 'actions live in the controls row');
});

test('disk city rides the same two-row toolbar system', () => {
  const city = block('id="view-city"', 'id="cityWrap"');
  assert.match(city, /tb-row tb-row-nav/, 'city row one');
  assert.match(city, /tb-row tb-row-controls/, 'city row two');
});

test('the view switcher is centred by construction, not by luck', () => {
  const rule = INDEX.match(/\.tb-row-nav\s*\{[^}]*\}/);
  assert.ok(rule, '.tb-row-nav rule exists');
  assert.match(rule![0], /grid-template-columns:\s*minmax\(0,\s*1fr\)\s*auto\s*minmax\(0,\s*1fr\)/,
    'equal flexible flanks hold the seg in the true centre');
  // And when the toolbar itself narrows, the seg drops to its own centred
  // line instead of crushing the crumbs or the search field.
  assert.match(INDEX, /@container[^{]*\(max-width[^)]*\)[^{]*\{[\s\S]{0,600}?"view view"/,
    'a narrow-container rule gives the seg its own full-width line');
});
