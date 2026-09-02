import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Dashboard wiring — the bklit kit meeting the dashboard's own cards.
 *
 * Same split as fxWiring: the one extractable helper (the All Storage
 * square strips) is EXECUTED against stub namespaces, because "no total
 * means no strip" and "the cascade plays once" are behaviour. Everything
 * else is structural containment: each card's designed treatment must keep
 * its honesty gate, its animated-numeral key, its loading-veil off-switch
 * and — for the one new live canvas handle — its paired destroy on every
 * exit door. The failure mode these guard against is always a refactor
 * that keeps the pretty half and quietly drops the discipline.
 */

const INDEX = readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

/** A slice of the file between two exact anchors — containment checks only. */
function slice(startAnchor: string, endAnchor: string): string {
  const start = INDEX.indexOf(startAnchor);
  assert.notEqual(start, -1, `anchor "${startAnchor}" exists in index.html`);
  const end = INDEX.indexOf(endAnchor, start + startAnchor.length);
  assert.notEqual(end, -1, `anchor "${endAnchor}" follows it`);
  return INDEX.slice(start, end);
}

/* ══════════════ All Storage square strips, as behaviour ══════════════ */

type StripApi = {
  asqStrip: (used: number, total: number, rowIdx: number) => string;
  squares: number;
  entered: () => boolean;
  setEntered: (v: boolean) => void;
};

function makeStrip(reduced: boolean, hidden = false): StripApi {
  const src = slice('const ASQ_SQUARES', 'function renderAllStorage(');
  // The stub mirrors the kit's documented squareStack contract (zero stays
  // dark, any real value lights at least one, max fills exactly) — the real
  // implementation is exercised by fxChartsPrimitives.
  const FxCharts = {
    math: {
      squareStack: (value: number, max: number, rows: number) =>
        !(rows > 0) || !(max > 0) || !(value > 0) ? 0 : Math.max(1, Math.min(rows, Math.round((value / max) * rows))),
      sampleRamp: () => '#0A84FF',
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function(
    'FxCharts', 'REDUCED', 'document',
    `'use strict'; ${src}
     return { asqStrip, squares: ASQ_SQUARES,
              entered: () => allStorageEntered, setEntered: (v) => { allStorageEntered = v; } };`,
  )(FxCharts, reduced, { hidden }) as StripApi;
}

test('a storage with no known total gets no strip — squares against an unknown ceiling would be invented', () => {
  const api = makeStrip(false);
  assert.equal(api.asqStrip(50, 0, 0), '', 'zero total');
  assert.equal(api.asqStrip(50, NaN as number, 0), '', 'unknown total');
});

test('used lights squares, free stays visible as ghosts, and the two always sum to the strip', () => {
  const api = makeStrip(false);
  const half = api.asqStrip(50, 100, 0);
  const lit = (half.match(/class="fx-bsq-sq[ "]/g) || []).length - (half.match(/fx-bsq-ghost/g) || []).length;
  const ghosts = (half.match(/fx-bsq-ghost/g) || []).length;
  assert.equal(lit + ghosts, api.squares, 'every square is either lit or ghost');
  assert.equal(lit, Math.round(api.squares / 2), 'half full lights half the squares');
  const full = api.asqStrip(100, 100, 0);
  assert.equal((full.match(/fx-bsq-ghost/g) || []).length, 0, 'a full disk has no ghosts');
  assert.match(half, /aria-hidden="true"/, 'the strip is decoration — the row text carries the facts');
});

test('past 85% the lit squares speak danger, below it they ride the ramp', () => {
  const api = makeStrip(false);
  assert.match(api.asqStrip(90, 100, 0), /background:var\(--danger\)/, 'the old bar’s threshold survives the redesign');
  assert.doesNotMatch(api.asqStrip(50, 100, 0), /--danger/, 'a healthy disk never borrows the warning color');
});

test('the cascade is armed once, never under REDUCED, never while hidden', () => {
  const api = makeStrip(false);
  assert.match(api.asqStrip(50, 100, 1), /fx-bsq-pre/, 'first paint arms the entrance');
  assert.match(api.asqStrip(50, 100, 1), /transition-delay:/, 'with the staggered delays');
  api.setEntered(true);
  assert.doesNotMatch(api.asqStrip(50, 100, 1), /fx-bsq-pre/, 'a repaint never replays it');
  const reduced = makeStrip(true);
  assert.doesNotMatch(reduced.asqStrip(50, 100, 1), /fx-bsq-pre/, 'REDUCED renders the final state directly');
  const hidden = makeStrip(false, true);
  assert.doesNotMatch(hidden.asqStrip(50, 100, 1), /fx-bsq-pre/, 'a hidden tab must not queue an entrance');
});

test('renderAllStorage rolls its numerals, releases the pre-squares, and keeps the honesty rows', () => {
  const fn = slice('function renderAllStorage(', 'async function cloudTrashPaths(');
  assert.match(fn, /FxNum\.rollHtml\(host, rows\.join\(''\), 'storage'\)/, 'numerals roll under a same-entity key');
  assert.match(fn, /querySelectorAll\('\.fx-bsq-pre'\)/, 'the armed squares are actually released');
  assert.match(fn, /allStorageEntered = true/, 'and the one-shot flag latches');
  assert.match(fn, /asqStrip\(used, state\.system\.totalDisk/, 'the local disk strip binds real bytes');
  assert.match(fn, /asqStrip\(q\.used, q\.total/, 'the cloud strip binds the provider’s own quota');
  assert.match(fn, /Not on this computer/, 'the A3 gap row survives the redesign');
});

test('the Dashboard and All Storage read the disk’s used figure instead of deriving one', () => {
  // freeDisk is statfs bavail, which excludes the blocks the system keeps for
  // itself. Subtracting it counts that reserve as space something is using,
  // and the Missing GB receipt — which reads occupied blocks — then disagrees
  // with this tile by ~50 GB on a 1 TB ext4 volume.
  const sys = slice('async function loadSystem', 'async function loadTrash');
  assert.match(sys, /const used = sys\.usedDisk/, 'the tile reads the figure the server publishes');
  assert.doesNotMatch(sys, /sys\.totalDisk\s*-\s*sys\.freeDisk/,
    'total − free counts the root reserve as space something is using');
  const all = slice('function renderAllStorage(', 'async function cloudTrashPaths(');
  assert.match(all, /const used = state\.system\.usedDisk/, 'and so does the All Storage row');
  assert.doesNotMatch(all, /state\.system\.totalDisk\s*-\s*state\.system\.freeDisk/, 'the same derivation, gone');
});

/* ══════════════ Hard links: two counters, two labels ══════════════ */

/**
 * The dashboard counts NAMES AFTER THE FIRST; the Settings diagnostic counts
 * INODES. An inode with three names makes the first say 2 and the second say
 * 1. Both are true, and while both were labelled as a count of "files" the two
 * screens simply disagreed. The labels are the fix, so the labels are what is
 * pinned — and BOTH of them, because pinning half the pair lets it re-collide.
 */

type DiskNoteEl = { hidden: boolean; textContent: string; classList: { add: () => void; remove: () => void }; setAttribute: () => void };

function renderDiskNotesWith(scanStats: Record<string, unknown>): Record<string, DiskNoteEl> {
  const src = slice('function renderDiskNotes()', 'async function renderCloudSafe');
  const els: Record<string, DiskNoteEl> = {};
  const $ = (id: string) =>
    (els[id] ??= { hidden: false, textContent: '', classList: { add: () => {}, remove: () => {} }, setAttribute: () => {} });
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const fn = new Function(
    '$', 'state', 'formatCount', 'formatBytes', 'fxTmPillBeamsSync',
    `'use strict'; ${src} return renderDiskNotes;`,
  )(
    $,
    { scanStats, treemap: { hideCloud: false } },
    (n: number | null) => (n ?? 0).toLocaleString(),
    (n: number) => n + ' B',
    () => {},
  ) as () => void;
  fn();
  return els;
}

test('the dashboard row counts extra NAMES, and says so — three names for one file is two extra', () => {
  const els = renderDiskNotesWith({ hardlinkedFiles: 2, hardlinkedBytes: 8 });
  assert.equal(els.hardlinkRow.hidden, false, 'the row shows when there is something to say');
  assert.match(els.hardlinkText.textContent, /^2 extra file names \(8 B\)$/,
    'the noun names what the counter holds, so it cannot be read as a count of files');
  assert.doesNotMatch(els.hardlinkText.textContent, /hard-linked file/,
    'the old noun is what let this number be compared with the diagnostic’s');
  const one = renderDiskNotesWith({ hardlinkedFiles: 1, hardlinkedBytes: 4 });
  assert.match(one.hardlinkText.textContent, /^1 extra file name \(4 B\)$/, 'and the singular still reads');
  const none = renderDiskNotesWith({ hardlinkedFiles: 0 });
  assert.equal(none.hardlinkRow.hidden, true, 'nothing to say, nothing shown');
});

test('the row’s hint says the bytes beside it are not added twice', () => {
  assert.match(INDEX, /Each is another name for data already counted, so totals match what the OS reports\./,
    'the muted line under hardlinkText carries the reassurance');
});

test('the Settings diagnostic counts hard-linked FILES, each once — the other half of the pair', () => {
  const fn = slice('async function renderAllocationDiagnostic(', 'async function loadFleet(');
  assert.match(fn, /Hard-linked files/, 'the label names files');
  assert.match(fn, /each counted once, however many names it has/,
    'and the hint says which of the two quantities this is');
  assert.doesNotMatch(fn, /<span>Files with more than one name<\/span>/,
    'the old label read as the dashboard’s row and reported a different number');
  assert.match(fn, /a\.hardlinkedNames > 0/, 'the reconciling row is gated on there being extra names');
  assert.match(fn, /names beyond the first, the figure the Dashboard shows/, 'and it says which screen it matches');
});

/* ══════════════ Disk Topology ══════════════ */

test('topology bars moved onto the kit recipe with the danger exception intact', () => {
  const fn = slice('function topoSection(', 'function wireTopologyActions(');
  assert.match(fn, /fx-bar-fill/, 'the ramp-gradient fill');
  assert.match(fn, /fxBarStyle\(rank\)/, 'colored by section rank on the shared ramp');
  assert.match(fn, /pct > 85 \? 'background:var\(--danger\);'/, 'a disk past 85% keeps the solid warning');
  // Free space is stated only when the platform reported both sides.
  assert.match(fn, /typeof v\.usedBytes === 'number' && typeof v\.sizeBytes === 'number'/,
    'the free figure is gated on both bytes being real');
  assert.match(fn, /formatBytes\(v\.sizeBytes - v\.usedBytes\)/, 'and is arithmetic on those, never a guess');
});

test('topology rolls its numerals and animates its bars through the shared entries', () => {
  const fn = slice('function renderTopology(', 'function topoSection(');
  assert.match(fn, /FxNum\.rollHtml\(body, sections\.join\(''\) \+ note, 'topo'\)/);
  assert.match(fn, /fxBarsIn\(body\)/);
  assert.match(fn, /classList\.remove\('fx-chart-loading'\)/, 'painting settles the veil');
});

/* ══════════════ Held-Up Space ══════════════ */

test('zombie rows carry the kit bar only when the bytes are real', () => {
  const fn = slice('function renderZombies(', 'function wireZombieActions(');
  assert.match(fn, /p\.bytes > 0 && maxHeld > 0/, 'unknown-size holders get no bar — an empty track would claim zero');
  assert.match(fn, /fx-bar-fill/, 'the kit fill');
  assert.match(fn, /fxBarStyle\(i\)/, 'on the shared ramp');
  assert.match(fn, /FxNum\.rollHtml\(body, head \+ rows \+ more \+ note, 'zh'\)/, 'the total still rolls');
  assert.match(fn, /fxBarsIn\(body\)/, 'bars animate in through the shared entry');
  assert.match(fn, /classList\.remove\('fx-chart-loading'\)/, 'painting settles the veil');
});

/* ══════════════ Cost to Keep ══════════════ */

test('cost bars normalize to the priciest plan shown; a provider with no plan gets none', () => {
  const fn = slice('async function loadCostEstimate(', 'let dhGauge = null;');
  assert.match(fn, /p\.current\.tier \? p\.current\.monthly : 0/, 'the max ignores providers with nothing to sell');
  assert.match(fn, /tier && maxMonthly > 0/, 'no tier, no bar');
  assert.match(fn, /fxBarStyle\(i\)/, 'the shared ramp');
  assert.match(fn, /fxBarsIn\(host\)/, 'the shared width-in');
});

test('cost prices roll under a scan+currency key, and the honesty copy survives', () => {
  const fn = slice('async function loadCostEstimate(', 'let dhGauge = null;');
  assert.match(fn, /FxNum\.rollHtml\(host,[\s\S]+?`\$\{state\.scanId\}:\$\{\$\('costCurrency'\)\.value\}`\)/,
    'a currency or scan change is a new entity and snaps');
  assert.match(fn, /cost-save/, 'the green saving state stays');
  assert.match(fn, /never looks them up online, so check the provider before you buy/, 'the as-of footnote stays');
});

test('the cost veil covers exactly the reload and settles on every exit', () => {
  const fn = slice('async function loadCostEstimate(', 'let dhGauge = null;');
  assert.match(fn, /if \(host\.querySelector\('\.cost-row'\)\) host\.classList\.add\('fx-chart-loading'\)/,
    'only a populated card is veiled — the first paint is a labelled skeleton');
  const removes = (fn.match(/classList\.remove\('fx-chart-loading'\)/g) || []).length;
  assert.ok(removes >= 2, `error and success both settle it (found ${removes})`);
});

/* ══════════════ Drive Health ══════════════ */

test('the wear gauge only renders a genuine 0..100 reading — past 100 stays a text row', () => {
  const fn = slice('function renderDriveHealth(', 'const SEVERITY_LABEL =');
  assert.match(fn, /s\.percentageUsed >= 0 && s\.percentageUsed <= 100/, 'the bounds gate');
  assert.match(fn, /wear === null && s\.percentageUsed !== null/, 'an out-of-range figure keeps its kv row');
  assert.match(fn, /orientation: 'linear'/, 'the stage-2 linear orientation');
  assert.match(fn, /activeGradient: FxCharts\.ramp\(2\)/, 'notches ride the accent ramp');
  assert.doesNotMatch(fn, /danger:/, 'the card renders no verdict — not even a red gauge');
});

test('the wear gauge dies on every exit door: rewrite, fetch error, dashboard unmount', () => {
  const drop = slice('function fxDriveGaugeDrop(', 'async function loadDriveHealth(');
  assert.match(drop, /dhGauge\.destroy\(\); dhGauge = null;/, 'the drop really drops');
  const render = slice('function renderDriveHealth(', 'const SEVERITY_LABEL =');
  const dropAt = render.indexOf('fxDriveGaugeDrop()');
  const rewriteAt = render.indexOf('host.innerHTML');
  assert.ok(dropAt !== -1 && rewriteAt !== -1 && dropAt < rewriteAt,
    'destroy BEFORE the innerHTML rewrite that would strand the handle');
  const load = slice('async function loadDriveHealth(', 'function renderDriveHealth(');
  assert.match(load, /fxDriveGaugeDrop\(\)/, 'the fetch-error paint drops it too');
  const entry = slice("id: 'dashboard'", "id: 'treemap'");
  assert.match(entry, /fxDriveGaugeDrop\(\)/, 'the view unmount closes the same leak');
  assert.match(entry, /if \(state\.driveHealth\) renderDriveHealth\(\)/, 'and mount rebuilds from the held report');
});

test('the theme toggle retints the wear gauge with the other live handles', () => {
  const toggle = slice("$('themeToggle').addEventListener", 'function applySideNav(');
  assert.match(toggle, /if \(dhGauge\) dhGauge\.update\(\{\}\);/, 'a forgotten handle keeps stale ink (QA F3)');
});

test('drive health loads under the stage-1 choreography and every painter settles the veil', () => {
  const load = slice('async function loadDriveHealth(', 'function renderDriveHealth(');
  assert.match(load, /host\.classList\.add\('fx-chart-loading'\)/, 'a reload veils the standing card');
  assert.match(load, /skeletonRows\(\d+, \d+, 'Reading the drive’s own report…'\)/,
    'the first paint keeps the §3.5 copy for screen readers');
  assert.match(load, /classList\.remove\('fx-chart-loading'\)/, 'the error paint settles it');
  assert.match(slice('function renderDriveHealth(', 'const SEVERITY_LABEL ='),
    /classList\.remove\('fx-chart-loading'\)/, 'the success paint settles it');
});

/* ══════════════ Folder Budgets ══════════════ */

test('budget gauges ride the accent ramp while danger still overrides it whole', () => {
  const fn = slice('function renderBudgetWidget(', 'let budgetTarget');
  assert.match(fn, /activeGradient: FxCharts\.ramp\(2\)/, 'the ramp endpoints per notch');
  assert.match(fn, /danger: b\.overBy > 0/, 'over-budget stays the solid danger red');
});

/* ══════════════ Largest Files / Folders custom indicator ══════════════ */

test('the rising row indicator springs from bottom to top and answers keyboard focus too', () => {
  const rule = INDEX.match(/\.bigfile::before\s*\{[^}]*\}/);
  assert.ok(rule, '.bigfile::before exists');
  assert.match(rule![0], /width: 2px/, 'bklit’s 2px line');
  assert.match(rule![0], /transform: scaleY\(0\)/, 'hidden at rest');
  assert.match(rule![0], /transform-origin: bottom/, 'and it rises, not drops');
  assert.match(rule![0], /var\(--ease-spring\)/, 'on the spring curve');
  assert.match(rule![0], /pointer-events: none/, 'never eats a click');
  assert.match(INDEX, /\.bigfile:hover::before, \.bigfile:focus-within::before \{ transform: scaleY\(1\); \}/,
    'hover and focus-within share the reveal');
});

/* ══════════════ The refresh veils settle everywhere ══════════════ */

test('topology and zombies veil only populated cards, and every painter has the off-switch', () => {
  const topoLoad = slice('async function loadTopology(', 'function renderTopologyBlocked(');
  assert.match(topoLoad, /else \{\s*body\.classList\.add\('fx-chart-loading'\);/, 'skeleton first, veil on refresh');
  for (const painter of [
    slice('function renderTopologyBlocked(', 'function renderTopologyError('),
    slice('function renderTopologyError(', 'const TOPO_VISIBLE_VOLUMES'),
  ]) assert.match(painter, /classList\.remove\('fx-chart-loading'\)/, 'blocked/error paints settle the topology veil');
  const zhLoad = slice('async function loadZombies(', 'function renderZombiesBlocked(');
  assert.match(zhLoad, /else \{\s*body\.classList\.add\('fx-chart-loading'\);/);
  for (const painter of [
    slice('function renderZombiesBlocked(', 'function renderZombiesError('),
    slice('function renderZombiesError(', 'function renderZombies('),
  ]) assert.match(painter, /classList\.remove\('fx-chart-loading'\)/, 'blocked/error paints settle the zombie veil');
});

/* ══════════════ Narrow cards shed decoration, never facts ══════════════ */

test('the new bars and strips are container-scoped and shed before the numbers wrap', () => {
  assert.match(INDEX, /#zombieBody \{ container-type: inline-size; \}/);
  assert.match(INDEX, /#costBody \{ container-type: inline-size; \}/);
  assert.match(INDEX, /#allStorageList \{ container-type: inline-size; \}/);
  assert.match(INDEX, /@container \(max-width: 340px\) \{\s*#zombieBody \.fx-bar-track \{ display: none; \}/);
  assert.match(INDEX, /@container \(max-width: 340px\) \{ #costBody \.fx-bar-track \{ display: none; \} \}/);
  assert.match(INDEX, /@container \(max-width: 380px\) \{ \.storage-row \.asq \{ display: none; \} \}/);
});

/* ══════════════ the File Types ring is a share of the scan ══════════════ */

/** `renderDonut` executed, so what is asserted is the spec the ring gets. */
function donutSpec(types: Array<{ ext: string; count: number; totalSize: number }>): any {
  const src = slice('let donutHandle = null;', 'const tmCanvas');
  let captured: any = null;
  const legend = { classList: { add() {}, remove() {} }, set innerHTML(_v: string) {} };
  const FxCharts = { rings: (_c: unknown, _l: unknown, spec: any) => { captured = spec; return { update() {}, destroy() {} }; } };
  const make = new Function(
    '$', 'state', 'FxCharts', 'Canvas2D', 'fxDonutLoadingSync', 'formatCount',
    `${src}; return renderDonut;`,
  );
  make(
    (id: string) => (id === 'donutLegend' ? legend : { getContext: () => ({ clearRect() {} }) }),
    { types },
    FxCharts,
    { setup: () => ({ ctx: { clearRect() {} } }) },
    () => {},
    (n: number) => String(n),
  )();
  return captured;
}

/**
 * The ring showed the eight biggest extensions and nothing else, and the kit
 * computes each slice's percentage against the items it was handed. On a scan
 * with 88 extensions that made ".zip 645.3 MB — 30.1%" when zip is 28.2% of
 * what was scanned: a number that reconciles with nothing the API returns,
 * beside a card headed "File types by size".
 *
 * Folding the remainder into one "Other" slice makes the ring a real
 * part-to-whole again: every percentage is a share of the scan, and the count
 * of extensions the tail stands for is on screen instead of implied.
 */
test('the file-types ring accounts for the whole scan, not just its eight biggest slices', () => {
  const many = Array.from({ length: 20 }, (_, i) => ({ ext: `e${i}`, count: i + 1, totalSize: 1000 - i * 10 }));
  const spec = donutSpec(many);
  const total = many.reduce((a, t) => a + t.totalSize, 0);
  const shown = spec.items.reduce((a: number, it: any) => a + it.value, 0);
  assert.equal(shown, total, 'the slices add up to every byte the scan attributed to a type');
  assert.equal(spec.items.length, 8, 'still eight slices — seven named types and the tail');

  const tail = spec.items[spec.items.length - 1];
  assert.match(tail.name, /13 more/, 'the tail says how many extensions it stands for');
  assert.equal(tail.value, many.slice(7).reduce((a, t) => a + t.totalSize, 0), 'and carries their bytes');
  assert.equal(tail.count, many.slice(7).reduce((a, t) => a + t.count, 0), 'and their file count');

  const few = [
    { ext: 'a', count: 1, totalSize: 10 },
    { ext: 'b', count: 2, totalSize: 20 },
  ];
  const small = donutSpec(few);
  assert.equal(small.items.length, 2, 'nothing is folded when every type already fits');
  assert.ok(!small.items.some((it: any) => /more/.test(it.name)), 'and no empty "Other" slice is invented');
});
