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

/** A `<div …>` from its opening tag, `open`, through its MATCHING `</div>`. */
function divElement(open: string): string {
  const start = INDEX.indexOf(open);
  assert.notEqual(start, -1, `"${open}" exists in index.html`);
  const re = /<(\/?)div\b[^>]*>/g;
  re.lastIndex = start;
  let depth = 0;
  for (let m = re.exec(INDEX); m; m = re.exec(INDEX)) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return INDEX.slice(start, m.index + m[0].length);
  }
  return assert.fail(`"${open}" never closes`);
}

test('treemap toolbar is two designed rows, not one wrapping soup', () => {
  // The toolbar itself, tag-matched: ended at the first "tm-querybar" after
  // it, the slice ran on through the timebar and the map's card once the
  // match bar moved into the card (G19), and a control moved out of the
  // toolbar still passed (review F1.11).
  const tm = divElement('<div class="tm-toolbar">');
  for (const after of ['id="tmTimebar"', 'id="treemapWrap"', 'id="treemapCanvas"']) {
    assert.ok(!tm.includes(after), `the slice is the toolbar alone (${after} is past it)`);
  }
  assert.match(tm, /tb-row tb-row-nav/, 'row one exists (nav | view | find)');
  assert.match(tm, /tb-row tb-row-controls/, 'row two exists (appearance | modes | actions)');
  const navRow = tm.slice(tm.indexOf('tb-row-nav'), tm.indexOf('tb-row-controls'));
  assert.match(navRow, /id="tmViewSeg"/, 'the view switcher lives in the nav row');
  const controls = tm.slice(tm.indexOf('tb-row-controls'));
  assert.match(controls, /id="tmColorSeg"/, 'color modes live in the controls row');
  assert.match(controls, /id="tmExportBtn"/, 'actions live in the controls row');
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
  // The crumbs flank is the shrinkable one (the trail clips); the find flank
  // may grow past an equal share but never shrink below its own content —
  // see the B16 geometry test below for why.
  assert.match(cols, /grid-template-columns:\s*minmax\(0,\s*1fr\)\s*auto\s*minmax\(min-content,\s*1fr\)/,
    'the crumbs flank is a shrinkable track — which only helps if the items honour them');
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
  assert.match(rule![0], /grid-template-columns:\s*minmax\(0,\s*1fr\)\s*auto\s*minmax\(min-content,\s*1fr\)/,
    'equal flexible flanks hold the seg in the true centre whenever the find group fits its half');
  // And when the toolbar itself narrows, the seg drops to its own centred
  // line instead of crushing the crumbs or the search field.
  assert.match(INDEX, /@container[^{]*\(max-width[^)]*\)[^{]*\{[\s\S]{0,600}?"view view"/,
    'a narrow-container rule gives the seg its own full-width line');
});

/* ── B16: row one never lays one control over another ── */

/** The built stylesheet, comments removed. */
const SHEET = INDEX.slice(INDEX.indexOf('<style>') + 7, INDEX.indexOf('</style>')).replace(/\/\*[\s\S]*?\*\//g, ' ');
/** `prop` of the first top-level rule whose selector is exactly `sel`. */
function prop(sel: string, name: string): string {
  for (const m of SHEET.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
    if (!m[1].split(',').map((s) => s.trim()).includes(sel)) continue;
    const d = new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([^;]+)`).exec(m[2]);
    if (d) return d[1].trim();
  }
  return assert.fail(`${sel} declares ${name}`);
}
const pxOf = (v: string) => { const m = /^(\d+(?:\.\d+)?)px$/.exec(v.trim()); assert.ok(m, `a px length: ${v}`); return Number(m![1]); };

/**
 * QA B16: at 1024×768 — the desktop window's minimum width — the Highlight
 * field sat 20 px over the "Voronoi" tab. Row one's flanks were equal
 * `minmax(0, 1fr)` tracks, so below a ~1100 px window the find flank was
 * narrower than the field plus the plain-words button, and the group (packed
 * to its end) overflowed leftwards across the switcher.
 *
 * The geometry is rebuilt from the stylesheet for every toolbar width the
 * three-column row is used at (above its narrow container query): the
 * switcher's width from its own rules with a conservative 7.6 px per
 * character of its widest 12.5 px label, the find group from #tmSearch's
 * clamp, the group gap and an icon button. CSS grid gives a flexible track
 * whose minimum is content-sized at least that content, taking it from the
 * other flexible track — the crumbs, which clip by design.
 */
test('the find group never overprints the view switcher, at any toolbar width the row is used at (B16)', () => {
  const cols = prop('.tb-row-nav', 'grid-template-columns');
  const tracks = /^minmax\(0,\s*1fr\)\s+auto\s+minmax\(([\w-]+),\s*1fr\)$/.exec(cols);
  assert.ok(tracks, `row one is crumbs | switcher | find (${cols})`);
  // `auto` would not do: .tb-group sets min-width: 0, which makes an auto
  // minimum zero for this item. Only a content keyword holds the field.
  const findMinIsContent = ['min-content', 'max-content'].includes(tracks![1]);
  const gap = pxOf(prop('.tb-row-nav', 'gap'));
  const narrow = /@container \(max-width: (\d+)px\) \{\s*\.tb-row-nav \{/.exec(SHEET);
  assert.ok(narrow, 'a container query stacks the row when the toolbar is narrow');
  const floor = Number(narrow![1]);

  const labels = [...INDEX.matchAll(/<button role="tab" type="button" data-vm="\w+"[^>]*>([^<]+)<\/button>/g)].map((m) => m[1]);
  assert.equal(labels.length, 4, 'the switcher has its four layouts');
  const tabPad = pxOf(prop('.seg button', 'padding').split(/\s+/)[1]);
  const tab = Math.max(...labels.map((l) => l.length)) * 7.6 + 2 * tabPad; // equal columns (grid-auto-columns: 1fr)
  const segPad = pxOf(prop('.seg', 'padding'));
  const seg = 4 * tab + 2 * segPad + 2;

  const clamp = /^clamp\((\d+)px,\s*(\d+(?:\.\d+)?)cqw,\s*(\d+)px\)$/.exec(prop('#tmSearch', 'width'));
  assert.ok(clamp, `the field's width is a cqw clamp (${prop('#tmSearch', 'width')})`);
  const groupGap = pxOf(prop('.tb-group', 'gap'));
  const iconBtn = pxOf(prop('.icon-btn', 'width'));

  let checked = 0;
  for (let W = floor + 1; W <= 1700; W++) {
    const field = Math.min(Number(clamp![3]), Math.max(Number(clamp![1]), (Number(clamp![2]) / 100) * W));
    const find = field + groupGap + iconBtn;
    const free = W - seg - 2 * gap;
    const right = findMinIsContent ? Math.max(find, free / 2) : free / 2;
    const left = free - right;
    checked++;
    assert.ok(right >= find, `${W}px toolbar: the find flank is ${right.toFixed(1)}px for a ${find.toFixed(1)}px field + button — it would overlap the switcher by ${(find - right).toFixed(1)}px`);
    assert.ok(left >= 0, `${W}px toolbar: the crumbs flank keeps a width (${left.toFixed(1)}px)`);
  }
  assert.ok(checked > 900, `every width from ${floor + 1}px was checked (${checked})`);
});
