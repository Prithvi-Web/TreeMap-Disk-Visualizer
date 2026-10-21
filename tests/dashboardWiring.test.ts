import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { lift } from './fixtures/liftFrontend';
// The page's own formatCount, not a stand-in that agrees with itself (issue #34).
const pageFormatCount = lift<(n: unknown) => string>(['UI_LOCALE', 'formatCount'], 'formatCount');

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

test('the dashboard names the room reserved but not filled, and hides the row when there is none', () => {
  // Docker.raw claims 64 GB and may hold 12. The tile, the total and the
  // receipt all counted the claim; this row is where the difference is said.
  const els = renderDiskNotesWith({ sparseFiles: 3, sparseBytes: 52 });
  assert.equal(els.sparseRow.hidden, false);
  assert.match(els.sparseText.textContent, /^3 files claim 52 B more than they take$/,
    'the count, the shortfall, and what it means — in that order');
  const one = renderDiskNotesWith({ sparseFiles: 1, sparseBytes: 9 });
  assert.match(one.sparseText.textContent, /^1 file claims 9 B more than it takes$/, 'the singular agrees');
  // Windows always reports 0 here, and the index-first paint publishes no
  // sparse keys at all — neither may show an empty row.
  assert.equal(renderDiskNotesWith({ sparseFiles: 0 }).sparseRow.hidden, true);
  assert.equal(renderDiskNotesWith({}).sparseRow.hidden, true, 'undefined is not a number of files');
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
    pageFormatCount,
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

test('topology bars moved onto the kit recipe, with the danger exception kept for a disk low where you work', () => {
  const fn = slice('function topoSection(', 'function wireTopologyActions(');
  assert.match(fn, /fx-bar-fill/, 'the ramp-gradient fill');
  assert.match(fn, /fxBarStyle\(rank\)/, 'colored by section rank on the shared ramp');
  // Design pass G22: past 85% used is red only on a disk holding the home
  // folder or the folder on screen; a full disk image or backup drive is not
  // an alarm. tests/designPolishG.test.ts renders the cases.
  assert.match(fn, /const low = pct !== null && pct > SPACE_LOW_USED_SHARE \* 100 && vols\.some\(\(v\) => near\.has\(v\)\);/,
    'a disk past the threshold, where you work, keeps the solid warning');
  assert.match(fn, /low \? 'background:var\(--danger\);'/);
});

/** topoSection lifted from the built page, with byte-exact stand-ins for its helpers. */
function liftTopoSection(): (s: Record<string, unknown>, rank?: number) => string {
  const src = slice('function topoSection(', 'function wireTopologyActions(');
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function('formatBytes', 'escapeHtml', 'fxBarStyle', 'TOPO_VISIBLE_VOLUMES', 'SPACE_LOW_USED_SHARE',
    `'use strict'; ${src} return topoSection;`)((n: number) => n + ' B', (s: string) => String(s), () => '', 6, 0.85) as
    (s: Record<string, unknown>, rank?: number) => string;
}

test('a volume’s free figure is the free space the platform reported, never ceiling minus own use (QA D16)', () => {
  // An APFS volume's sizeBytes is the SHARED container ceiling and usedBytes
  // that one volume's consumption, so their difference is "container minus my
  // own use" — Preboot showed 450 GB free on a disk with 208 GB free. The real
  // answer is already in the API: freeBytes, from statfs.
  const topoSection = liftTopoSection();
  const apfs = (id: string, used: number) => ({
    id, name: id, mountPoint: '/' + id, kind: 'apfs', sizeBytes: 494e9, usedBytes: used, freeBytes: 208e9,
  });
  const html = topoSection({ title: 'APPLE SSD', tag: 'SSD', capacity: 494e9, vols: [apfs('Data', 250e9), apfs('Preboot', 12e9)] });
  const frees = [...html.matchAll(/<span class="free num"[^>]*>([^<]*)<\/span>/g)].map((m) => m[1]);
  assert.deepEqual(frees, ['208000000000 B free', '208000000000 B free'],
    'each volume shows the free space it can actually use');
  assert.doesNotMatch(html, /482000000000 B free|244000000000 B free/, 'never the ceiling minus its own use');

  // Free space the platform could not read is left out — not derived.
  const unread = topoSection({ title: 'USB', tag: null, capacity: 64e9,
    vols: [{ id: 'disk4s1', name: 'STICK', mountPoint: '/Volumes/STICK', kind: 'partition', sizeBytes: 64e9, usedBytes: 10e9, freeBytes: null }] });
  assert.doesNotMatch(unread, /class="free num"/, 'an unknown free figure is not shown at all');
  assert.doesNotMatch(unread, /54000000000 B free/, 'and is never made up from ceiling − used');
});

test('a pool member without volumes of its own says it is part of the pool, never "No volumes on this disk."', () => {
  // Issue #35 was filed over that sentence; under a Storage Spaces or RAID
  // member it is false — the member's bytes are in the combined section below.
  const topoSection = liftTopoSection();
  const member = topoSection({ title: 'WDC WD40EFRX', tag: 'HDD', capacity: 4e12, vols: [], inPool: true });
  assert.match(member, /Part of the pool below\./);
  assert.doesNotMatch(member, /No volumes on this disk/);
  const empty = topoSection({ title: 'Spare', tag: 'HDD', capacity: 4e12, vols: [] });
  assert.match(empty, /No volumes on this disk\./, 'a disk with nothing on it still says so');
  const render = slice('function renderTopology(', 'function topoSection(');
  assert.match(render, /inPool: pooledIds\.has\(d\.id\)/, 'membership comes from the multi-disk group keys');
  assert.match(render, /key\.includes\('\|'\)/, 'a group key with a separator is a pool');
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
  // The scan the prices were worked out from (treeScanId, read once at the start), and the currency.
  assert.match(fn, /FxNum\.rollHtml\(host,[\s\S]+?`\$\{scanId\}:\$\{\$\('costCurrency'\)\.value\}`\)/,
    'a currency or scan change is a new entity and snaps');
  assert.match(fn, /const scanId = treeScanId\(\);/, 'and that scan is the tree on screen\'s');
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
  const toggle = slice('function themeRepaint(', '\n}\n'); // the list every theme change reaches (review F1.5)
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
  // Named "Other" since QA D24 ("873 more" ellipsized to "873 …" in the
  // legend's name column); how many extensions it stands for is its tooltip.
  assert.equal(tail.name, 'Other');
  assert.match(tail.title, /13 more extensions/, 'the tail says how many extensions it stands for');
  assert.equal(tail.value, many.slice(7).reduce((a, t) => a + t.totalSize, 0), 'and carries their bytes');
  assert.equal(tail.count, many.slice(7).reduce((a, t) => a + t.count, 0), 'and their file count');

  const few = [
    { ext: 'a', count: 1, totalSize: 10 },
    { ext: 'b', count: 2, totalSize: 20 },
  ];
  const small = donutSpec(few);
  assert.equal(small.items.length, 2, 'nothing is folded when every type already fits');
  assert.ok(!small.items.some((it: any) => it.name === 'Other' || /more/.test(it.title || '')), 'and no empty "Other" slice is invented');
});

/* ══════════════ B02 — a Trash TreeMap could not read is not "at least 0 B" ══════════════ */

type FactEl = { hidden: boolean; textContent: string; title: string; dataset: Record<string, unknown>; style: Record<string, string>; contains: (n: unknown) => boolean };
const factEl = (): FactEl => ({ hidden: true, textContent: '', title: '', dataset: {}, style: {}, contains: () => false });

/**
 * loadTrash out of the built page over `answer`. The row starts as the markup
 * ships it — hidden — or, with `shown`, as an earlier read that found
 * something left it, so that taking it away is something the read does. Its
 * best-effort `catch` swallows any throw, so the page's `document` and
 * `activeViewControl` are stood in for (no focus here: polishUiModals has
 * where focus goes when the row goes holding it, review F2.2 of E04).
 */
async function loadTrashWith(answer: unknown, { shown = false } = {}) {
  const src = slice('async function loadTrash', 'function openTrashModal');
  const els: Record<string, FactEl> = {};
  const $ = (id: string) => (els[id] ??= factEl());
  $('trashFact').title = 'View Trash contents'; // as the markup ships it
  $('trashFact').hidden = !shown;
  const countUp = (el: FactEl, n: number, fmt: (v: number) => string) => { el.dataset.v = n; el.textContent = fmt(n); };
  const run = new Function('api', 'state', '$', 'countUp', 'formatBytes', 'formatCount', 'document', 'activeViewControl', `'use strict'; ${src} return loadTrash;`)(
    async () => answer, {}, $, countUp, (n: number) => `${n} B`, String, { activeElement: null }, () => null,
  ) as () => Promise<void>;
  await run();
  return els;
}

test('a Trash TreeMap could not read says so and why — never "at least 0 B" (B02)', async () => {
  const reason = 'macOS would not let TreeMap read the Trash. Give it Full Disk Access in System Settings.';
  const unread = await loadTrashWith({ totalBytes: 0, itemCount: 0, complete: false, incompleteReason: reason });
  assert.equal(unread.trashFact.hidden, false, 'the row stays: hiding it would say the Trash is empty');
  assert.doesNotMatch(unread.sysTrash.textContent, /at least 0/, 'a floor of nothing is not a fact');
  // Where a size belongs, a size or "Unknown"; why, under the label (design pass G13).
  assert.equal(unread.sysTrash.textContent, 'Unknown', 'nothing could be sized: the size is unknown');
  assert.equal(unread.sysTrashSub.hidden, false, 'and the row says why under its label');
  assert.equal(unread.sysTrashSub.textContent, 'Couldn’t read all of it', 'it says the Trash could not be read');
  assert.equal(unread.trashFact.title, reason, 'and the reason the server gave is on the row');
  assert.equal(Number(unread.sysTrash.dataset.v), 0, 'the roll restarts from nothing when a size comes');

  // Review F1.5: `complete: false` with nothing found is also what the server
  // answers when one location could not be read and the others were read and
  // found empty (~/.Trash read, a drive's .Trashes refused) — the answer
  // cannot tell the two apart. "Couldn't read it" claimed none of it was read.
  // The row says what is true of both.
  const partEmpty = await loadTrashWith({ totalBytes: 0, itemCount: 0, complete: false, incompleteReason: 'Part of the Trash could not be read (EACCES).' });
  for (const [what, row] of [['nothing read', unread], ['part read, found empty', partEmpty]] as const) {
    assert.equal(row.sysTrash.textContent, 'Unknown', `${what}: no size is known`);
    assert.equal(row.sysTrashSub.textContent, 'Couldn’t read all of it', `${what}: a sentence true either way — not "none of it could be read"`);
  }
  assert.equal(partEmpty.trashFact.title, 'Part of the Trash could not be read (EACCES).', 'and the server\'s own sentence says which');

  const partial = await loadTrashWith({ totalBytes: 5000, itemCount: 3, complete: false, incompleteReason: reason });
  assert.equal(partial.sysTrash.textContent, 'at least 5000 B · 3', 'a real floor is still a floor');
  assert.equal(partial.sysTrashSub.hidden, false, 'with why it is only a floor under the label');
  assert.equal(partial.sysTrashSub.textContent, 'Couldn’t read all of it');
  assert.equal(partial.trashFact.title, reason, 'with the reason it is only a floor');

  const whole = await loadTrashWith({ totalBytes: 2000, itemCount: 4, complete: true });
  assert.equal(whole.sysTrash.textContent, '2000 B · 4');
  assert.equal(whole.sysTrashSub.hidden, true, 'a Trash read in full has nothing to explain');
  assert.equal(whole.trashFact.title, 'View Trash contents', 'a Trash read in full keeps the plain title');
  const empty = await loadTrashWith({ totalBytes: 0, itemCount: 0, complete: true }, { shown: true });
  assert.equal(empty.trashFact.hidden, true, 'an empty Trash read in full has no row, as before — the row a read that found something left is taken away');
});

type SheetEl = { textContent: string; innerHTML: string; disabled: boolean; cls: Set<string>; classList: { add: (c: string) => void } };
const sheetEl = (): SheetEl => { const e: SheetEl = { textContent: '', innerHTML: '', disabled: true, cls: new Set(), classList: { add: (c) => { e.cls.add(c); } } }; return e; };

/** openTrashModal out of the built page, run over the answer the row was painted from. */
function openTrashWith(answer: unknown) {
  const src = slice('function openTrashModal', "$('trashFact').addEventListener('click', openTrashModal);");
  const els: Record<string, SheetEl> = {};
  const $ = (id: string) => (els[id] ??= sheetEl());
  new Function('state', '$', 'formatBytes', 'formatCount', 'escapeHtml', 'icon', 'chipFor', `'use strict'; ${src} return openTrashModal;`)(
    { trash: answer }, $, (n: number) => `${n} B`, pageFormatCount, (s: string) => s, () => '', () => '',
  )();
  return els;
}

test('the Trash sheet\'s header says what the row says — never "at least 0 B · 0 items" (B02 review F2.4)', () => {
  // Review F2.4: F1.5 made the row say "Couldn't read all of it" for this
  // answer, the everyday one on a Mac without Full Disk Access, but the sheet
  // the row opens still titled itself "Trash · at least 0 B · 0 items" — the
  // vacuous floor B02 set out to remove, read as a count by a screen reader,
  // over a body saying the Trash could not be read.
  const reason = 'macOS would not let TreeMap read the Trash. Give it Full Disk Access in System Settings.';
  const unread = openTrashWith({ totalBytes: 0, itemCount: 0, complete: false, incompleteReason: reason });
  assert.equal(unread.trashModal.cls.has('open'), true, 'the sheet opens');
  assert.doesNotMatch(unread.trashModalMeta.textContent, /at least 0|0 items/, 'no floor of nothing in the header');
  assert.equal(unread.trashModalMeta.textContent, '· couldn’t read all of it', 'the header says what the row says');
  assert.match(unread.trashModalBody.innerHTML, /Full Disk Access/, 'and the body gives the server\'s reason');
  assert.equal(unread.emptyTrashBtn.disabled, false, 'Empty Trash stays on: the platform\'s own emptier may reach what TreeMap could not read');

  const partial = openTrashWith({ totalBytes: 5000, itemCount: 3, complete: false, incompleteReason: reason });
  assert.equal(partial.trashModalMeta.textContent, '· at least 5000 B · 3 items', 'a real floor is still a floor');
  const one = openTrashWith({ totalBytes: 2000, itemCount: 1, complete: true, items: [{ name: 'a.txt', size: 2000 }] });
  assert.equal(one.trashModalMeta.textContent, '· 2000 B · 1 item', 'a Trash read in full states its size and count; one item is "1 item"');
});

test('C02: a Trash TreeMap could not read gets a sheet that says so plainly — no total it does not show, no items it does not list', () => {
  const reason = 'macOS would not let TreeMap read the Trash. Give it Full Disk Access in System Settings.';
  const unread = openTrashWith({ totalBytes: 0, itemCount: 0, complete: false, incompleteReason: reason });
  assert.match(unread.trashModalBody.innerHTML,
    /macOS would not let TreeMap read the Trash\. Give it Full Disk Access in System Settings\. TreeMap cannot list what is in it or say how much space it takes\./,
    `what could not be read, and what that leaves unknown: ${unread.trashModalBody.innerHTML}`);
  assert.equal(unread.trashModalNote.textContent, '', 'no "Items restore from here" over a sheet that lists no items');

  const partial = openTrashWith({ totalBytes: 5000, itemCount: 2, complete: false, incompleteReason: 'Part of the Trash could not be read (EACCES).',
    items: [{ name: 'a.txt', size: 3000 }, { name: 'b.txt', size: 2000 }] });
  assert.match(partial.trashModalBody.innerHTML, /Part of the Trash could not be read \(EACCES\)\. The items below are the ones TreeMap could read\./,
    `a partial read says what it could not read above what it lists: ${partial.trashModalBody.innerHTML}`);
  assert.match(partial.trashModalBody.innerHTML, /a\.txt[\s\S]*b\.txt/, 'and lists them');
  assert.equal(partial.trashModalNote.textContent, 'Items restore from here until the Trash is emptied.', 'items listed: the note is about them');

  const whole = openTrashWith({ totalBytes: 2000, itemCount: 1, complete: true, items: [{ name: 'a.txt', size: 2000 }] });
  assert.doesNotMatch(whole.trashModalBody.innerHTML, /could not|cannot/, 'a Trash read in full has no caveat');
  assert.equal(whole.trashModalNote.textContent, 'Items restore from here until the Trash is emptied.');
  const empty = openTrashWith({ totalBytes: 0, itemCount: 0, complete: true, items: [] });
  assert.equal(empty.trashModalNote.textContent, '', 'an empty Trash has nothing to restore');
});

/* Review F3.2: the F2.4 cases never fed the header a Trash read in full and
   found empty, nor a partial read that sized nothing but counted something —
   so keying the header's sentence on anything but the row's own condition
   passed. Both answers are reachable: Empty Trash leaves a full, empty answer
   in state while the synthetic Trash cell stays drawn until the next layout,
   and clicking it opens this sheet; a partial read can find only empty files.
   Then one answer table runs through the row and the sheet it opens, so the
   two cannot drift apart. */
test('the Trash row and the sheet it opens agree on every answer, a full and empty read included (review F3.2)', async () => {
  const reason = 'Part of the Trash could not be read (EACCES).';
  const emptyRead = openTrashWith({ totalBytes: 0, itemCount: 0, complete: true, items: [] });
  assert.equal(emptyRead.trashModalMeta.textContent, '· 0 B · 0 items', 'a Trash read in full and found empty says so: nothing in it, not "couldn’t read"');
  assert.match(emptyRead.trashModalBody.innerHTML, /The Trash is empty\./, 'over a body that says the Trash is empty');
  const emptyFiles = openTrashWith({ totalBytes: 0, itemCount: 3, complete: false, incompleteReason: reason });
  assert.equal(emptyFiles.trashModalMeta.textContent, '· couldn’t read all of it',
    'a partial read that sized nothing says what the row says, whatever it counted — not "at least 0 B · 3 items"');

  const answers = [
    { totalBytes: 0, itemCount: 0, complete: false, incompleteReason: reason },
    { totalBytes: 0, itemCount: 3, complete: false, incompleteReason: reason },
    { totalBytes: 5000, itemCount: 3, complete: false, incompleteReason: reason },
    { totalBytes: 2000, itemCount: 1, complete: true, items: [{ name: 'a.txt', size: 2000 }] },
    { totalBytes: 0, itemCount: 0, complete: true, items: [] },
  ];
  for (const answer of answers) {
    const { totalBytes, itemCount, complete } = answer;
    const row = await loadTrashWith(answer);
    const sheet = openTrashWith(answer);
    const rowText = row.trashFact.hidden ? '(no row)' : row.sysTrash.textContent; // an empty Trash read in full has no row
    const rowUnread = rowText === 'Unknown';
    const headerUnread = sheet.trashModalMeta.textContent === '· couldn’t read all of it';
    assert.equal(headerUnread, rowUnread,
      `${totalBytes} B, ${itemCount} items, complete ${complete}: the header says "couldn’t read all of it" exactly when the row does ` +
      `(row "${rowText}", header "${sheet.trashModalMeta.textContent}")`);
  }
});

test('the Trash row has a line under its label for why a size is unknown or only a floor, shown only then (design pass G13)', () => {
  assert.match(INDEX, /<div class="fact fact-trash" id="trashFact" hidden role="button" tabindex="0" title="View Trash contents"><span>Trash<small class="fact-sub" id="sysTrashSub" hidden><\/small><\/span><b id="sysTrash" class="num">–<\/b><\/div>/,
    'the line ships empty and hidden');
  assert.match(INDEX, /\.fact-trash \.fact-sub \{ display: block;/, 'and sits under the label, not beside it');
});

/* ══════════════ B18 — the System card follows the disk, not the page load ══════════════ */

test('the System card\'s disk figures are read again whenever a scan lands (B18)', async () => {
  // B18: read once at page load; half an hour of disk churn later it stated a
  // Free figure 3.8 GB away from the Missing GB receipt in the same session.
  const src = slice('function paintDiskFacts(', '/* Feature 8 — Trash awareness. */') +
    slice('/* The System card follows the disk', '/* Empty Trash');
  const els: Record<string, FactEl> = {};
  const $ = (id: string) => (els[id] ??= factEl());
  // The card as the page load painted it.
  $('sysFree').textContent = '199 B'; $('sysUsed').textContent = '261 B'; $('ringPct').textContent = '57%';
  const state: Record<string, unknown> = { system: { homeDir: '/Users/x', platform: 'darwin', totalDisk: 460, freeDisk: 199, usedDisk: 261 } };
  let answer: unknown = { homeDir: '/Users/x', platform: 'darwin', totalDisk: 460, freeDisk: 195, usedDisk: 265 };
  const asked: string[] = [];
  const handlers: Array<[string, (id: unknown) => unknown]> = [];
  new Function('api', 'state', '$', 'countUp', 'formatBytes', 'requestAnimationFrame', 'subscribe', 'TOPIC', `'use strict'; ${src}`)(
    async (url: string) => { asked.push(url); if (answer instanceof Error) throw answer; return answer; },
    state, $, (el: FactEl, n: number, fmt: (v: number) => string) => { el.textContent = fmt(n); }, (n: number) => `${n} B`,
    (fn: () => void) => fn(), (topic: string, fn: (id: unknown) => unknown) => { handlers.push([topic, fn]); }, { scan: 'scan' },
  );
  const onScan = handlers.filter(([t]) => t === 'scan').map(([, fn]) => fn);
  assert.equal(onScan.length, 1, 'one listener for a scan landing');
  await onScan[0](null);
  assert.deepEqual(asked, [], 'a tree with no scan behind it (the index paint) asks nothing');
  await onScan[0]('s1');
  assert.deepEqual(asked, ['/api/system'], 'a scan that landed asks the disk again');
  assert.equal(els.sysFree.textContent, '195 B', 'Free is the disk\'s figure now');
  assert.equal(els.sysUsed.textContent, '265 B', 'and Used');
  assert.equal(els.ringPct.textContent, '58%', 'and the ring');
  assert.equal((state.system as { freeDisk: number }).freeDisk, 195, 'the app\'s copy follows, for every view that reads it');
  answer = new Error('offline');
  await onScan[0]('s2');
  assert.equal(els.sysFree.textContent, '195 B', 'a failed read keeps the figures it had');
  assert.equal((state.system as { homeDir: string }).homeDir, '/Users/x', 'and the app\'s copy');
});

/* ══════════════ B25 — a folder already over its budget is said to be over it ══════════════ */

test('a budget gauge over its budget reads its real share — "136%", never "100%" beside "over by 3.6 MB" (B25)', () => {
  const fn = slice('function renderBudgetWidget(', 'let budgetTarget');
  const specs: Array<Record<string, unknown>> = [];
  const list = { innerHTML: '', classList: { remove() {} }, querySelectorAll: (sel: string) => (sel === 'canvas.budget-gauge' ? [{}, {}] : []) };
  const card = { hidden: true };
  const $ = (id: string) => (id === 'budgetList' ? list : id === 'budgetCard' ? card : null);
  const state = { budgets: { list: [
    { path: '/p/originals/2', name: '2', maxBytes: 10_000_000, actualBytes: 13_600_000, overBy: 3_600_000 },
    { path: '/p/Music', name: 'Music', maxBytes: 10_000_000, actualBytes: 5_000_000, overBy: 0 },
  ] } };
  const FxCharts = { gauge: (_cv: unknown, spec: Record<string, unknown>) => { specs.push(spec); return { destroy() {} }; }, ramp: () => ['#000', '#fff'] };
  new Function('$', 'state', 'FxCharts', 'formatBytes', 'escapeHtml', 'icon', 'budgetProjectionLine', 'nodeFor', 'openBudgetDialog',
    'fxBudgetGaugesDrop', 'budgetGauges', 'document', 'focusLanding',
    `'use strict'; ${fn} renderBudgetWidget();`)(
    $, state, FxCharts, (n: number) => `${n} B`, (s: string) => s, () => '', () => '', () => null, () => {}, () => {}, [],
    { activeElement: null, body: null }, () => null,
  );
  assert.equal(specs.length, 2);
  // What the ring prints: the caller's formatValue, or the kit's own default (FxCharts.gauge) when none is passed.
  const fmt = (s: Record<string, unknown>, v: number) =>
    (typeof s.formatValue === 'function' ? s.formatValue as (x: number) => string : (x: number) => Math.round(x * 100) + '%')(v);
  assert.equal(fmt(specs[0], 1), '136%', 'the full ring of an over-budget folder says how far over: 13.6 of 10');
  assert.equal(fmt(specs[0], 0.5), '68%', 'and counts up to it in proportion while the ring fills');
  assert.equal(specs[0].danger, true, 'still the danger red');
  assert.equal(fmt(specs[1], 0.5), '50%', 'a folder within its budget reads as before');
});

test('saving a budget on a folder already over it says so — never "≤", which reads as "within" (B25)', async () => {
  const src = slice('async function commitBudget(', 'async function removeBudget(');
  const run = async (target: Record<string, unknown>, value: string, sizeFromScan: number | null = null) => {
    const toasts: string[] = [];
    const els: Record<string, { value: string }> = { budgetValue: { value }, budgetUnit: { value: '1000000' } };
    const commit = new Function('$', 'toast', 'currentSavedBudgets', 'saveBudgetList', 'closeModal', 'formatBytes', 'loadBudgets', 'nodeFor', 'target',
      `'use strict'; let budgetTarget = target; ${src} return commitBudget;`)(
      (id: string) => els[id], (m: string) => toasts.push(m), async () => [], async () => [], () => {}, (n: number) => `${n} B`, async () => {},
      () => (sizeFromScan === null ? null : { size: sizeFromScan }), target,
    ) as () => Promise<void>;
    await commit();
    return toasts;
  };
  const over = await run({ path: '/p/originals/2', name: '2', size: 13_600_000 }, '10');
  assert.equal(over.length, 1);
  assert.doesNotMatch(over[0], /≤/, 'no "≤": the folder is not within it');
  assert.match(over[0], /already over/, 'it is already over the budget');
  assert.match(over[0], /13600000 B of 10000000 B/, 'by the numbers the dialog showed');
  const within = await run({ path: '/p/Music', name: 'Music', size: 5_000_000 }, '10');
  assert.doesNotMatch(within[0], /over|≤/, 'within: neither "over" nor "≤"');
  assert.match(within[0], /Music is 5000000 B of its 10000000 B/, 'within: how much of it is used');
  const fromScan = await run({ path: '/p/x', name: 'x', size: null }, '10', 12_000_000);
  assert.match(fromScan[0], /already over/, 'the size the scan holds counts when the menu did not carry one');
  const unknown = await run({ path: '/p/y', name: 'y', size: null }, '10');
  assert.doesNotMatch(unknown[0], /≤|over|of its/, 'with no size known, nothing is claimed about it');
  assert.match(unknown[0], /10000000 B/);
});
