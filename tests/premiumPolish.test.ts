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

/** An at-rule (or any braced block) from its opening anchor to its MATCHING
    brace — proximity windows walk straight out of a container query. */
function braced(openAnchor: string): string {
  const start = INDEX.indexOf(openAnchor);
  assert.notEqual(start, -1, `block "${openAnchor}" exists in index.html`);
  let depth = 0;
  for (let i = INDEX.indexOf('{', start); i < INDEX.length; i++) {
    if (INDEX[i] === '{') depth++;
    else if (INDEX[i] === '}' && --depth === 0) return INDEX.slice(start, i + 1);
  }
  assert.fail(`block "${openAnchor}" never closes`);
}

/** The declarations of one rule, from a selector anchor to its closing brace. */
function decls(selectorAnchor: string): string {
  const start = INDEX.indexOf(selectorAnchor);
  assert.notEqual(start, -1, `rule "${selectorAnchor}" exists in index.html`);
  const open = INDEX.indexOf('{', start);
  const close = INDEX.indexOf('}', open);
  assert.ok(open !== -1 && close !== -1, `rule "${selectorAnchor}" closes`);
  return INDEX.slice(open + 1, close);
}

/* ── The legend: one row is one line, at every window width ── */

test('legend size values refuse to wrap — the fullscreen-only bug', () => {
  const styles = block('FX: Charts — styles', 'end FX: Charts — styles');
  const val = styles.match(/\.fx-li-val\s*\{[^}]*\}/);
  assert.ok(val, '.fx-li-val rule exists');
  assert.match(val![0], /white-space:\s*nowrap/, 'the value column never breaks into two lines');
});

/**
 * A proximity window ([\s\S]*?) is not a containment check: `}` is just
 * another character to it, so a rule moved OUT of its container query still
 * matched — and `.fx-li-track { display: block }` inside the 360px block
 * passed by walking on into the 260px block and finding an unrelated
 * `display: none`. Each rule is now asserted inside its own brace-matched
 * block, and the breakpoints themselves are pinned: a 360px query moved to
 * 200px never fires at a real card width.
 */
test('legend columns collapse progressively instead of crushing', () => {
  const styles = block('FX: Charts — styles', 'end FX: Charts — styles');
  // The legends measure themselves, not the window: container queries.
  assert.match(styles, /\.fx-legend[^{]*\{[^}]*container-type:\s*inline-size/,
    'fx-legend is a size container');
  assert.match(INDEX, /\.donut-legend\s*\{[^}]*container-type:\s*inline-size/,
    'the dashboard donut legend is a size container too');
  // Under pressure the decorative mini-bar goes first, the count second —
  // the value and percent survive at every width.
  const narrow = braced('@container (max-width: 360px) {');
  assert.match(narrow, /\.fx-li-track \{[^}]*display:\s*none/,
    'the mini bar track goes first, and it goes INSIDE the 360px query');
  assert.ok(!/\.fx-li-cnt \{[^}]*display:\s*none/.test(narrow),
    'the count is still there at 360px — the collapse is progressive, not all at once');
  const narrower = braced('@container (max-width: 260px) {');
  assert.match(narrower, /\.fx-li-cnt \{[^}]*display:\s*none/,
    'the file count goes second, inside the 260px query');
  for (const [where, blk] of [['360px', narrow], ['260px', narrower]] as const) {
    assert.ok(!/\.fx-li-val|\.fx-li-pct/.test(blk),
      `${where} never sheds the value or the percent — those are the facts the row exists for`);
  }
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

/**
 * The nav row is a grid whose flanks are `minmax(0, 1fr)` — tracks that are
 * ALLOWED to be narrower than their content so the breadcrumb trail can clip.
 * `justify-self` with any value other than `stretch` sizes the item to its own
 * content instead of the track, which switches that off: the group grows past
 * its column and paints over the view switcher (measured: 676px of nav inside
 * a 480px track at 1440px, starting from the second crumb). Alignment inside
 * the group is the flex container's job, never the grid item's.
 */
test('every nav-row group fills its grid track instead of sizing to its content', () => {
  const cols = decls('.tb-row-nav {');
  assert.match(cols, /grid-template-columns:\s*minmax\(0,\s*1fr\)\s*auto\s*minmax\(0,\s*1fr\)/,
    'the flanks are shrinkable tracks — which only helps if the items honour them');
  for (const group of ['.tb-nav', '.tb-view', '.tb-find']) {
    const d = decls(`.tb-row-nav ${group} {`);
    const js = /justify-self:\s*([a-z-]+)/.exec(d);
    assert.ok(js, `${group} states its justify-self`);
    assert.equal(js![1], 'stretch',
      `${group} must fill its track — start/center/end size the item to max-content and it overprints its neighbours`);
    assert.match(d, /justify-content:/, `${group} aligns its own contents instead`);
  }
});

test('the crumb trail is the part that gives way, and it clips its ROOT end', () => {
  const d = decls('.crumbs {');
  assert.match(d, /min-width:\s*0/, 'without this a flex item refuses to shrink below min-content');
  assert.match(d, /flex:\s*1 1 auto/, 'the trail takes the slack the nav group leaves and shrinks with it');
  assert.match(d, /overflow:\s*hidden/, 'a deep trail clips rather than pushing its neighbours');
  assert.match(d, /flex-wrap:\s*nowrap/);
  assert.match(d, /justify-content:\s*flex-end/,
    'packed to the end, so the clip eats the root crumbs and the current folder is the last to go');
});

/**
 * Clipping the trail and shrinking every crumb are different things, and only
 * one of them is readable. With `flex: 0 1 auto` every button gave up width
 * together, so a 7-deep trail at 900px rendered as "A › G › C › D › C" — the
 * container never had to clip because the content had already collapsed, and
 * not one folder name survived. Crumbs hold their natural width; the trail
 * overflows past its start edge and the clip takes whole ROOT crumbs, which is
 * what the rule above promises.
 */
test('a crumb keeps its name — the trail clips whole crumbs instead of shrinking them all', () => {
  const b = decls('.crumbs button {');
  assert.match(b, /flex:\s*none/,
    'a crumb never gives up width — shrinking them together makes every name unreadable');
  assert.match(b, /max-width:\s*220px/, 'one absurd folder name still has a ceiling');
  assert.match(b, /text-overflow:\s*ellipsis/, 'and ellipsizes at that ceiling rather than being cut');
  // The clipped root end is a hard cut without this: the mask fades the
  // overflowing crumbs out instead of slicing one mid-letter.
  const d = decls('.crumbs {');
  assert.match(d, /mask-image:\s*linear-gradient\(to right/, 'the clipped root end fades out');
  assert.match(d, /-webkit-mask-image:\s*linear-gradient\(to right/, 'including on WebKit');
});

test('the narrow toolbar keeps the same rule — nav and find still fill their tracks', () => {
  const narrow = braced('@container (max-width: 700px) {');
  assert.match(narrow, /grid-template-areas:\s*"nav find" "view view"/, 'the seg drops to its own line');
  for (const group of ['.tb-nav', '.tb-find', '.tb-view']) {
    const rule = new RegExp(`\\.tb-row-nav \\${group} \\{([^}]*)\\}`).exec(narrow);
    if (!rule) continue; // a group that says nothing here inherits the wide rule, which is already pinned
    const js = /justify-self:\s*([a-z-]+)/.exec(rule[1]);
    if (js) {
      assert.equal(js[1], 'stretch',
        `${group} must not re-introduce content sizing at narrow widths`);
    }
  }
});

/**
 * A security row is `<filename> <kind>`. Both used to live in one
 * `overflow: hidden` line, so a long filename pushed "Private key or
 * certificate" clean off the end and it vanished — at 900px, rows 1 and 2
 * had no kind label at all. The kind IS the finding's meaning; the filename
 * is the part with a graceful way to give way.
 */
test('a security row can lose filename characters but never its kind label', () => {
  const nm = decls('.sec-item .nm {');
  assert.match(nm, /display:\s*flex/, 'the row lays out its two parts instead of running them together');
  assert.match(nm, /min-width:\s*0/);
  assert.ok(!/text-overflow/.test(nm), 'the container no longer ellipsizes both halves as one string');
  const name = decls('.sec-name {');
  assert.match(name, /min-width:\s*0/, 'the filename may shrink below its content');
  assert.match(name, /text-overflow:\s*ellipsis/, 'and says so with an ellipsis');
  assert.match(name, /white-space:\s*nowrap/);
  const kind = decls('.sec-kind {');
  assert.match(kind, /flex:\s*none/, 'the kind label never gives up a pixel — it is what the row means');
  assert.match(INDEX, /<span class="sec-name">\$\{escapeHtml\(f\.name\)\}<\/span><span class="sec-kind">/,
    'the markup gives the filename its own shrinkable box');
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
