import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Frontend structural contract — the guard rail for the §3.4 refactor.
 *
 * §9 requires regression tests pinning the current behaviour of all ten views
 * *before* anything changes. The frontend is a single zero-dependency HTML file
 * with no bundler and no test harness, and §3 forbids adding one — so a DOM
 * test runner is off the table.
 *
 * What is available, and genuinely valuable, is a structural contract over the
 * file itself. It cannot prove a view renders correctly (that is verified by
 * driving the real app in a browser, which is done alongside these), but it
 * catches exactly the failure modes a large refactor produces: a view silently
 * dropped, a tab pointing at a section that no longer exists, a raw `fetch()`
 * bypassing the shared wrapper, a locally reimplemented byte formatter, a
 * duplicated element id, a second navigation mechanism left coexisting with the
 * registry.
 *
 * Every assertion here corresponds to a rule in §3.4, §3.6 or §10, and says
 * which one.
 */

const INDEX = readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

/**
 * The ten views §0 names: eight tabs plus the Clean Up and Settings surfaces —
 * followed by the tabs later phases add. Growing this list is deliberate: a
 * view that appears without being added here is a view nobody decided to ship.
 */
const TAB_VIEWS = [
  'dashboard', 'treemap', 'grid', 'apps', 'duplicates', 'trends', 'compare', 'offloaded',
  'capsule', // B3 — Time Capsule
  'autopilot', // B1 — Autopilot
  'games', // C7 — game libraries
  'security', // C5 — secrets hygiene
] as const;
const MODAL_VIEWS = ['cleanModal', 'settingsModal'] as const;

/** Body of the one inline <script> that holds the application. */
function appScript(): string {
  const start = INDEX.indexOf("<script>\n'use strict';");
  assert.ok(start !== -1, 'the application script must be findable');
  const end = INDEX.indexOf('</script>', start);
  return INDEX.slice(start, end);
}

/**
 * The script with comments removed.
 *
 * Required, not cosmetic: the "no raw fetch" rule below is documented in a
 * comment that necessarily contains the word `fetch()`, and a scan of the raw
 * text flags its own documentation. A test that fails because the code was
 * explained is worse than no test — so structural rules are checked against
 * code only.
 *
 * String and template-literal contents are left alone: they are short here and
 * removing them correctly would need a real tokenizer, while the patterns these
 * tests look for do not occur inside strings.
 */
function appCode(): string {
  return appScript()
    .replace(/\/\*[\s\S]*?\*\//g, ' ') // block comments
    .replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1'); // line comments, sparing "http://"
}

/* ══════════════════════ The ten views still exist ══════════════════════ */

test('every tab button has a matching view section', () => {
  for (const view of TAB_VIEWS) {
    assert.ok(INDEX.includes(`data-view="${view}"`), `tab button for "${view}" is missing`);
    assert.ok(INDEX.includes(`id="view-${view}"`), `view section for "${view}" is missing`);
  }
});

test('no tab points at a view section that does not exist', () => {
  // The reverse direction: a refactor that renames a section but not its tab
  // produces a tab that silently shows nothing.
  const tabs = [...INDEX.matchAll(/data-view="([a-z]+)"/g)].map((m) => m[1]);
  for (const tab of new Set(tabs)) {
    assert.ok(INDEX.includes(`id="view-${tab}"`), `tab "${tab}" has no view-${tab} section`);
  }
});

test('the Clean Up and Settings surfaces are present', () => {
  for (const id of MODAL_VIEWS) {
    assert.ok(INDEX.includes(`id="${id}"`), `${id} is missing`);
  }
});

test('the held-up space card (B5) is present, wired, and honest in every state', () => {
  assert.ok(INDEX.includes('id="zombieCard"'), 'the Dashboard card exists');
  assert.ok(INDEX.includes('id="zombieBody"') && INDEX.includes('id="zombieRefresh"'), 'its body and refresh control exist');

  // The panel logic, sliced from its own anchor forward (never from 0 — an
  // earlier match would slice backwards to empty).
  const code = appCode();
  const start = code.indexOf('function loadZombies');
  assert.ok(start !== -1, 'loadZombies exists');
  const end = code.indexOf('System info', start);
  const panel = code.slice(start, end === -1 ? code.length : end);
  assert.ok(panel.length > 500, 'the B5 panel slice is non-empty');

  // §3.5: unavailable-with-reason and error-with-retry are distinct states.
  assert.match(panel, /capabilityUnavailable/, 'a 409 renders the capability reason, not a generic error');
  assert.match(panel, /renderZombiesBlocked/, 'the unavailable state exists');
  assert.match(panel, /data-zh-retry/, 'the error state offers a retry');
  // §B5: the restart confirmation carries the unsaved-work warning explicitly,
  // and differs by whether relaunch is genuinely supported.
  assert.match(panel, /unsaved work/, 'the unsaved-work warning is present');
  assert.match(panel, /appBundle\s*\?/, 'the confirmation distinguishes reopenable apps from bare processes');
  // The action goes through the shared confirm dialog, not a bare click.
  assert.match(panel, /confirmModal/, 'restart is confirmed, never immediate');
});

test('every view section is a tabpanel with an accessible label', () => {
  // §6 accessibility: a canvas-heavy view is unusable without this.
  for (const view of TAB_VIEWS) {
    const section = INDEX.match(new RegExp(`<section class="view" id="view-${view}"[^>]*>`));
    assert.ok(section, `view-${view} section not found`);
    assert.match(section![0], /role="tabpanel"/, `view-${view} must be a tabpanel`);
    assert.match(section![0], /aria-label="/, `view-${view} must carry an accessible label`);
  }
});

test('the tab bar is a labelled tablist and every tab is a real tab', () => {
  assert.match(INDEX, /<nav class="tabbar" role="tablist" aria-label="[^"]+"/);
  const buttons = [...INDEX.matchAll(/<button role="tab" aria-selected="(?:true|false)" data-view="[a-z]+"/g)];
  assert.equal(buttons.length, TAB_VIEWS.length, 'every tab must declare role and selection state');
});

/* ══════════════════════ Element ids are unique ══════════════════════ */

test('no element id is declared twice', () => {
  // $(id) returns the first match, so a duplicate silently wires half the UI to
  // the wrong node — a classic outcome of copy-pasting a panel during a refactor.
  const ids = [...INDEX.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) dupes.add(id);
    seen.add(id);
  }
  assert.deepEqual([...dupes], [], 'duplicate element ids');
});

/* ══════════════════════ One fetch path (§3.4) ══════════════════════ */

test('every network call goes through the shared wrapper, never a raw fetch', () => {
  // The wrapper itself is the single legitimate `fetch(` call site. Anything
  // else bypasses the error envelope, rate-limit backoff and 202 polling —
  // §3.4: "Zero raw fetch() calls anywhere else."
  const calls = [...appCode().matchAll(/(?<![\w.])fetch\s*\(/g)];
  assert.equal(calls.length, 1, `the shared wrapper must be the only fetch() call site`);
});

test('the shared wrapper reads the project error envelope, not a second convention', () => {
  const script = appScript();
  // The backend envelope is flat { error, code } (middleware/errorHandler.ts),
  // NOT the nested { error: { code, message } } shape §3.2 sketches. §3.2 says
  // to follow the existing one — this pins that decision so a future edit does
  // not quietly introduce a second convention.
  assert.match(script, /body\s*&&\s*body\.error/, 'wrapper must read body.error');
  assert.match(script, /body\s*&&\s*body\.code/, 'wrapper must read body.code');
});

test('EventSource streams are closed, never leaked', () => {
  const script = appScript();
  assert.match(script, /new EventSource\(/, 'the app streams scan progress over SSE');
  assert.match(script, /\.close\(\)/, 'streams must be closed — a leaked SSE keeps the scan alive after navigation');
});

/* ══════════════════════ One formatter (§3.6) ══════════════════════ */

test('bytes are formatted in exactly one place', () => {
  const script = appScript();
  const definitions = [...script.matchAll(/function formatBytes\s*\(/g)];
  assert.equal(definitions.length, 1, '§3.6: never a locally reimplemented formatter');
});

test('no panel hand-rolls a KB/MB/GB unit ladder of its own', () => {
  const script = appScript();
  // A second unit array is how two panels start disagreeing about the same
  // number. The shared UNITS constant is the only one allowed.
  const ladders = [...script.matchAll(/\[\s*'B'\s*,\s*'KB'/g)];
  assert.equal(ladders.length, 1, 'exactly one unit ladder may exist');
});

/* ══════════════════════ Escaping (§C3, XSS) ══════════════════════ */

test('an HTML escaper exists and is used', () => {
  const script = appScript();
  assert.match(script, /function escapeHtml\s*\(/, 'user-controlled text must be escapable');
  const uses = [...script.matchAll(/escapeHtml\s*\(/g)];
  assert.ok(uses.length > 20, `escapeHtml should be used widely; found ${String(uses.length)} uses`);
});

test('file names and paths are never interpolated raw into innerHTML', () => {
  const script = appScript();
  // A filename is user-controlled: a folder called `<img onerror=…>` executes
  // if it reaches innerHTML unescaped.
  //
  // The check is anchored on the *sink*, not on the interpolation, because
  // escaping legitimately happens at the boundary rather than at the source:
  // the growth-projection banner builds `culprits` from raw names and then
  // inserts `${escapeHtml(culprits)}`, which is correct. Flagging that would
  // make this test noise, and a noisy test stops being read.
  //
  // So: for every `.innerHTML =` assignment, scan the statement that follows
  // for a bare `${x.name}` / `${x.path}`. The window is a documented heuristic
  // — a template literal has no cheap statement terminator — sized generously
  // enough to cover the multi-line assignments this file actually contains.
  const WINDOW = 900;
  const offenders: string[] = [];

  for (const sink of script.matchAll(/\.innerHTML\s*(?:\+)?=/g)) {
    const statement = script.slice(sink.index, sink.index + WINDOW);
    for (const bare of statement.matchAll(/\$\{\s*([A-Za-z_$][\w$]*)\.(name|path)\s*\}/g)) {
      offenders.push(`${bare[0]} near: ${statement.slice(0, 60).replace(/\s+/g, ' ')}`);
    }
  }

  assert.deepEqual(offenders, [], 'interpolate names and paths through escapeHtml before they reach markup');
});

test('toast() escapes its message, since the safe-sink rule above depends on it', () => {
  const script = appScript();
  const toastFn = script.slice(script.indexOf('function toast('), script.indexOf('function toast(') + 400);
  assert.match(toastFn, /escapeHtml\s*\(\s*msg\s*\)/, 'toast builds innerHTML, so it must escape');
});

/* ══════════════════════ Zero dependencies (§3) ══════════════════════ */

test('the frontend loads no external script, style or font', () => {
  // §3: the zero-dependency frontend stays zero-dependency, and §5's no-network
  // rule means the UI must work with no internet at all.
  assert.ok(!/<script[^>]+src=/i.test(INDEX), 'no external script tags');
  assert.ok(!/<link[^>]+href="https?:/i.test(INDEX), 'no external stylesheets or fonts');
  assert.ok(!/@import\s+url\(\s*['"]?https?:/i.test(INDEX), 'no remote CSS imports');
});

test('no frontend framework or bundler crept in', () => {
  // §10, anti-pattern 1: "adding a frontend framework just for this one panel".
  //
  // Matched on real usage, not on substrings: the file legitimately contains
  // the word "react" in a comment crediting rdev/liquid-glass-react, the MIT
  // technique the Liquid Glass engine was ported from. Flagging that would make
  // the test a nuisance rather than a guard.
  const usage: [RegExp, string][] = [
    [/\bimport\s+React\b/, 'React import'],
    [/\brequire\(\s*['"]react['"]\s*\)/, 'React require'],
    [/\bReactDOM\s*\./, 'ReactDOM usage'],
    [/\bReact\.createElement\s*\(/, 'React.createElement'],
    [/\bnew\s+Vue\s*\(/, 'Vue instantiation'],
    [/\bd3\s*\.\s*(?:select|scale|hierarchy|treemap)\s*\(/, 'D3 usage'],
    [/\bnew\s+Chart\s*\(/, 'Chart.js usage'],
  ];
  for (const [pattern, label] of usage) {
    assert.ok(!pattern.test(INDEX), `${label} must not appear in the zero-dependency frontend`);
  }
});

/* ══════════════════════ Accessibility (§6) ══════════════════════ */

test('reduced motion is respected', () => {
  // §6: prefers-reduced-motion must be honoured for the animated treemap.
  assert.match(INDEX, /prefers-reduced-motion/, 'animations must respect the OS setting');
});

test('modals trap focus and close on Escape', () => {
  const script = appScript();
  assert.match(script, /Escape/, '§3.6: Esc closes modals');
  assert.match(INDEX, /aria-modal="true"/, 'modals must be announced as modal');
});

test('the canvas views have an accessible list counterpart', () => {
  // §6: "a treemap that only conveys meaning through colour and area needs an
  // accompanying accessible list view". Grid is that counterpart.
  assert.ok(INDEX.includes('id="view-grid"'), 'the Grid view is the accessible counterpart to the treemap');
});

/* ══════════════════════ View registry (§3.4) ══════════════════════ */

test('every tab view is registered in the view registry', () => {
  // Two legitimate places a view can be declared: the original ten sit in the
  // VIEWS literal, and everything added from Phase 1 onward comes in through
  // registerView(). What must never happen is a tab with no registration at
  // all — switchView would take its unknown-view early return and the tab
  // would look dead. So this checks the union, not one hard-coded location.
  const code = appCode();
  const literal = code.slice(code.indexOf('const VIEWS = ['), code.indexOf('const VIEW_BY_ID'));
  assert.ok(literal.length > 100, 'the view registry must exist');
  const registered = code.slice(code.indexOf('function registerView(view)'));

  for (const view of TAB_VIEWS) {
    const declaration = new RegExp(`id:\\s*'${view}'`);
    assert.ok(
      declaration.test(literal) || declaration.test(registered),
      `"${view}" has a tab but is registered nowhere`,
    );
  }
});

test('views are added through registerView, which keeps the lookup map in sync', () => {
  // Found by exercising the registry rather than trusting it: pushing to VIEWS
  // alone left VIEW_BY_ID stale, so switchView took its "unknown view" early
  // return and the new tab appeared dead rather than broken. Every view added
  // from Phase 1 onward depends on this staying correct.
  const code = appCode();
  assert.match(code, /function registerView\(view\)/);
  const fn = code.slice(code.indexOf('function registerView(view)'), code.indexOf('let mountedView'));
  assert.match(fn, /VIEW_BY_ID\.set\(view\.id, view\)/, 'the lookup map must be updated');
  assert.match(fn, /VIEWS\.push\(view\)|VIEWS\[at\] = view/, 'the ordered list must be updated');
  assert.match(fn, /VIEW_BY_ID\.has\(view\.id\)/, 're-registering must replace, not duplicate');
});

test('there is exactly one navigation mechanism', () => {
  const code = appCode();
  // §3.4: "do not leave two navigation mechanisms coexisting." Only the
  // registry may decide what a tab shows.
  assert.equal([...code.matchAll(/function switchView\s*\(/g)].length, 1);
  assert.match(code, /VIEW_BY_ID\.get\(name\)/, 'switchView must resolve through the registry');
  // The old form branched on the view name inside switchView itself.
  assert.ok(
    !/switchView[\s\S]{0,2000}if\s*\(\s*name\s*===\s*'treemap'/.test(code),
    'per-view branches must live in the registry, not in switchView',
  );
});

test('switching views tears down the outgoing view before mounting the next', () => {
  const code = appCode();
  const fn = code.slice(code.indexOf('function switchView('), code.indexOf('function renderCapabilityNotice'));
  assert.match(fn, /mountedView[\s\S]*unmount\(\)/, 'the outgoing view must be unmounted');
  assert.ok(
    fn.indexOf('unmount()') < fn.indexOf('view.mount()'),
    'unmount must run before the next mount, or both views hold the same timers',
  );
});

test('the Duplicates view stops its polling timers when unmounted', () => {
  // The concrete leak the registry closes: both duplicate finders reschedule
  // themselves every 700ms until their job completes, whether or not the view
  // is on screen.
  const code = appCode();
  const registry = code.slice(code.indexOf("id: 'duplicates'"), code.indexOf("id: 'trends'"));
  assert.match(registry, /unmount\(\)/, 'duplicates must declare an unmount');
  assert.match(registry, /clearTimeout\(state\.dup\.pollTimer\)/);
  assert.match(registry, /clearTimeout\(state\.near\.pollTimer\)/);
});

test('the Treemap view stops live mode and its animation frame when unmounted', () => {
  const code = appCode();
  const entry = code.slice(code.indexOf("id: 'treemap'"), code.indexOf("id: 'grid'"));
  assert.match(entry, /disableLive\(/, 'live mode holds two intervals and a rAF loop');
  assert.match(entry, /cancelAnimationFrame\(/);
});

test('views that browse a tree repoint themselves when a new scan lands', () => {
  // A drill-in path belongs to the tree it came from; reusing it across a
  // rescan either renders the wrong folder or silently finds nothing.
  const code = appCode();
  const treemap = code.slice(code.indexOf("id: 'treemap'"), code.indexOf("id: 'grid'"));
  const grid = code.slice(code.indexOf("id: 'grid'"), code.indexOf("id: 'apps'"));
  assert.match(treemap, /onScanChange\(\)/);
  assert.match(grid, /onScanChange\(\)/);
});

test('a view that fails to mount disables itself rather than taking the app down', () => {
  // §6, failure isolation.
  const code = appCode();
  const fn = code.slice(code.indexOf('function switchView('), code.indexOf('function renderCapabilityNotice'));
  assert.match(fn, /try\s*\{\s*view\.mount\(\);?\s*\}\s*catch/);
});

/* ══════════════════════ App state pub/sub (§3.4) ══════════════════════ */

test('state changes are published through subscribe/notify, not poked view to view', () => {
  const code = appCode();
  assert.match(code, /function subscribe\(topic, fn\)/);
  assert.match(code, /function emit\(topic, payload\)/);
  assert.match(code, /const TOPIC = \{/, 'topics are named constants, so a typo cannot silently subscribe to nothing');
});

test('a listener that throws cannot stop the other listeners', () => {
  const code = appCode();
  const emitFn = code.slice(code.indexOf('function emit(topic'), code.indexOf('const TOPIC'));
  assert.match(emitFn, /try\s*\{[\s\S]*catch/, '§6: one broken panel must not freeze the rest');
});

/* ══════════════════════ Capability gating (§2.2, §3.5) ══════════════════════ */

test('capabilities are fetched and applied to the tab bar', () => {
  const code = appCode();
  assert.match(code, /\/api\/platform\/capabilities/, 'the frontend reads the capability endpoint');
  assert.match(code, /function applyCapabilitiesToTabs/);
  assert.match(code, /tab-unavailable/, 'an unavailable view is dimmed, not deleted');
});

test('an unavailable view explains itself instead of rendering blank', () => {
  // §3.5 state 5, and §10's ban on "silent capability failures — a blank panel
  // with no explanation".
  const code = appCode();
  assert.match(code, /function renderCapabilityNotice/);
  const fn = code.slice(code.indexOf('function renderCapabilityNotice'), code.indexOf('function applyCapabilitiesToTabs'));
  assert.match(fn, /escapeHtml\(reason\)/, "the capability's own reason is shown, escaped");
});

test('unknown capabilities never disable a view', () => {
  // Failing to reach the endpoint must not hide half the app.
  const code = appCode();
  const fn = code.slice(code.indexOf('function viewBlockedReason'), code.indexOf('function switchView('));
  assert.match(fn, /if \(!caps\) return null/, 'not yet known must mean not blocked');
});

/* ══════════════════════ Shared canvas toolkit (§3.4) ══════════════════════ */

test('a shared Canvas 2D toolkit exists with the primitives panels need', () => {
  const code = appCode();
  const toolkit = code.slice(code.indexOf('const Canvas2D = {'), code.indexOf('function roundRect('));
  for (const primitive of ['setup(', 'roundRect(', 'toLocal(', 'hitTest(', 'fitText(', 'drawCell(']) {
    assert.ok(toolkit.includes(primitive), `Canvas2D.${primitive} is missing`);
  }
});

test('the treemap hit-tests through the shared toolkit, not its own copy', () => {
  // §3.4: new panels must reuse hit detection "rather than each
  // re-implementing" it — which only holds if the existing panel uses it too.
  const code = appCode();
  const fn = code.slice(code.indexOf('function treemapHit('), code.indexOf('async function expandContainerNode'));
  assert.match(fn, /Canvas2D\.hitTest\(/);
  assert.match(fn, /Canvas2D\.toLocal\(/);
});

test('nested cells resolve to the deepest hit, so a file wins over its folder', () => {
  const code = appCode();
  const toolkit = code.slice(code.indexOf('hitTest(rects'), code.indexOf('fitText(ctx'));
  assert.match(toolkit, /depthOf/, 'without a depth rule, clicking a file selects its parent folder');
});

/* ══════════════════════ Shared fetch wrapper (§3.4) ══════════════════════ */

test('the wrapper owns rate-limit backoff, so no caller has to remember it', () => {
  const code = appCode();
  const fn = code.slice(code.indexOf('async function api(url'), code.indexOf('function reportError'));
  assert.match(fn, /429/, 'a surfaced 429 reads to the user as a failed action');
  assert.match(fn, /setTimeout/, 'backoff before retrying');
});

test('the wrapper can wait out a 202 rather than each panel writing a poll loop', () => {
  const code = appCode();
  const fn = code.slice(code.indexOf('async function api(url'), code.indexOf('function reportError'));
  assert.match(fn, /res\.status === 202/);
  assert.match(fn, /PENDING_TIMEOUT/, 'polling must terminate rather than spin forever');
});

test('a capability failure is marked so panels can render it as an answer', () => {
  const code = appCode();
  assert.match(code, /capabilityUnavailable/);
  const report = code.slice(code.indexOf('function reportError'), code.indexOf('function reportError') + 600);
  assert.match(report, /capabilityUnavailable/, 'a missing capability is not an error in red');
});

test('there is only one rate-limit backoff implementation', () => {
  // apiPaced used to be a second code path; it must now delegate.
  const code = appCode();
  const paced = code.slice(code.indexOf('async function apiPaced'), code.indexOf('async function apiPaced') + 300);
  assert.match(paced, /return api\(/, 'apiPaced must delegate to the one wrapper');
});

/* ══════════════════════ Live index UI (A1) ══════════════════════ */

test('an indexed folder paints from the index before any scan finishes', () => {
  const code = appCode();
  assert.match(code, /\/api\/index\/status/, 'the UI asks whether a folder is indexed');
  assert.match(code, /\/api\/index\/tree/, 'and reads the tree from it');
  const fn = code.slice(code.indexOf('async function startScan(path'), code.indexOf('async function startScanRequest'));
  assert.match(fn, /openFromIndex/, 'startScan tries the index first');
});

test('the index badge distinguishes live from stale, in plain language', () => {
  // §A1: green "always current", amber when the index is stale/reconciling.
  // §10 bans confidently-wrong numbers, and stale data presented as current is
  // exactly that — so the difference must be visible.
  const code = appCode();
  const fn = code.slice(code.indexOf('function renderIndexBadge'), code.indexOf('async function indexStatusFor'));
  assert.match(fn, /state !== 'ready'/, 'staleness comes from the server, not a guess');
  assert.match(fn, /out of date/i, 'the stale case says so in words a person can act on');
  assert.match(fn, /always current/i, 'the live case says so too');
});

test('a stale index is still shown, never blanked', () => {
  // Hiding a stale tree would be worse than labelling it: it is usually correct
  // and always better than nothing.
  const code = appCode();
  const fn = code.slice(code.indexOf('async function startScan(path'), code.indexOf('async function startScanRequest'));
  assert.match(fn, /state !== 'building'/, "only a half-built index is refused, not a stale one");
});

test('the background refresh cannot wipe an already-painted tree', () => {
  const code = appCode();
  const fn = code.slice(code.indexOf('async function startScanRequest'), code.indexOf('/* ─────────────── "What'));
  assert.match(fn, /if \(quiet\)/, 'a failed background rescan leaves the indexed view alone');
});

test('indexing is an optimisation: every failure path falls back to scanning', () => {
  const code = appCode();
  const status = code.slice(code.indexOf('async function indexStatusFor'), code.indexOf('async function openFromIndex'));
  assert.match(status, /catch\s*\{[\s\S]*return null/, 'no index service must not break scanning');
  const open = code.slice(code.indexOf('async function openFromIndex'), code.indexOf('async function buildIndexInBackground'));
  assert.match(open, /return false/, 'an unreadable index falls through to a real scan');
});

test('the background index build waits for the job before reporting its state', () => {
  // POST /api/index/build answers 202 immediately; reading status straight
  // afterwards describes an index that is still being written.
  const code = appCode();
  const fn = code.slice(code.indexOf('async function buildIndexInBackground'), code.indexOf('async function startScan(path'));
  assert.match(fn, /\/result/, 'it polls the job result');
  assert.match(fn, /poll:\s*true/, 'through the shared wrapper 202 handling');
});

test('the index badge respects reduced motion', () => {
  // Its pulse is pure decoration, which is what §6 asks be switched off.
  assert.match(INDEX, /prefers-reduced-motion: no-preference\)[\s\S]{0,200}index-badge/);
});

/* ══════════════════════ Allocation, shared vs exclusive (A2) ══════════════════════ */

test('the tooltip only adds an allocation line when it says something new', () => {
  // A line reading "100% exclusive" on every ordinary file is noise, and noise
  // is what stops people reading tooltips at all.
  const code = appCode();
  const fn = code.slice(code.indexOf('function allocationTooltipLine'), code.indexOf('function showTooltip'));
  // Asserted as behaviour, not as literal source: the guard gained a
  // cloud-placeholder case in A3, and a test pinned to the exact old text
  // failed for a change that was entirely correct.
  assert.match(fn, /return ''/, 'there is an early return for the uninteresting case');
  assert.match(fn, /!shared/, 'a file sharing nothing…');
  assert.match(fn, /!underAllocated/, '…and occupying what it claims…');
  assert.match(fn, /!node\.cloudPlaceholder/, '…and not in the cloud, gets no extra line');
  assert.match(fn, /shared/, 'a shared file does');
  assert.match(fn, /on disk/, 'so does one that occupies less than it claims');
});

test('a cloud placeholder tooltip names both places the bytes are', () => {
  // §A3: "report cloud size and local size separately, never conflated."
  // Showing only the claimed size is what makes an evicted 4 GB video look
  // like it is filling the disk.
  const code = appCode();
  const fn = code.slice(code.indexOf('function allocationTooltipLine'), code.indexOf('function showTooltip'));
  assert.match(fn, /on this computer/, 'what it costs here');
  assert.match(fn, /in \$\{escapeHtml\(provider\)\}/, 'and what it costs in the named service');
  assert.match(fn, /Not downloaded/, 'stated plainly');
  // Deleting a placeholder deletes it from the service too — a real consequence
  // the user must not discover afterwards.
  assert.match(fn, /removes it from/, 'the consequence of deleting it is spelled out');
});

test('a sparse file is explicitly told apart from a cloud file in the UI', () => {
  // The dangerous conflation: a VM disk image occupies far less than it claims,
  // and calling it "in the cloud" invites deleting something irreplaceable.
  const code = appCode();
  const fn = code.slice(code.indexOf('function allocationTooltipLine'), code.indexOf('function showTooltip'));
  assert.match(fn, /it is not a cloud file/, 'the non-cloud case says so outright');
});

test('a cloud placeholder is drawn hollow, not as a solid block', () => {
  // §A3 asks for distinct visual treatment. A solid cell the size of a 4 GB
  // evicted video asserts "this is filling your disk", which is false.
  // Anchored on code, not on comments: appCode() strips comments, so slicing
  // between "// Pass 1" and "// Pass 2" matched an empty string and asserted
  // nothing at all.
  const code = appCode();
  const pass1 = code.slice(code.indexOf('state.treemap.pxRects = px;'), code.indexOf("ctx.textBaseline = 'middle'"));
  assert.ok(pass1.length > 200, 'the leaf-fill pass was located');
  assert.match(pass1, /n\.cloudPlaceholder/, 'placeholders take a different path');
  assert.match(pass1, /setLineDash/, 'and are outlined rather than filled');
});

test('the All Storage strip reports scanned cloud bytes without double-counting', () => {
  const code = appCode();
  const fn = code.slice(code.indexOf("const host = $('allStorageList')"), code.indexOf("host.querySelectorAll('[data-cloud-scan]')"));
  assert.match(fn, /Not on this computer/);
  assert.match(fn, /taking no space here/, 'it explains the gap rather than adding to the total');
});

test('a shared file is shown as freeing nothing, not as owning its bytes', () => {
  // The whole point of the scope rule: telling someone they can reclaim space
  // that deleting the file would not actually free is worse than saying nothing.
  const code = appCode();
  const fn = code.slice(code.indexOf('function allocationTooltipLine'), code.indexOf('function showTooltip'));
  assert.match(fn, /0 B exclusive to this copy/);
  assert.match(fn, /frees nothing/);
  assert.match(fn, /outside this folder/, 'a family reaching outside the root says so distinctly');
});

test('allocation is resolved once per file and cached, never per hover', () => {
  // The treemap fires mousemove continuously; a fetch per event would flood
  // the rate limiter and make the tooltip flicker.
  const code = appCode();
  const fn = code.slice(code.indexOf('function resolveAllocation'), code.indexOf('/**\n * The A2 line'));
  assert.match(fn, /allocationCache\.has\(node\.path\)/, 'a cached answer is not re-fetched');
  assert.match(fn, /allocationCache\.set\(node\.path, null\)/, 'the slot is claimed before the request');
  assert.match(fn, /node\.type !== 'file'/, 'directories are never asked about');
});

test('cached allocation is dropped when a new scan lands', () => {
  // shared/exclusive is relative to what was in scope; a file that lost its
  // twin since the last scan must stop claiming that deleting it frees nothing.
  const code = appCode();
  const fn = code.slice(code.indexOf('function indexTree(root)'), code.indexOf('function nodeFor'));
  assert.match(fn, /allocationCache\.clear\(\)/);
});

test('the tooltip repaints only if it is still showing the same file', () => {
  const code = appCode();
  const fn = code.slice(code.indexOf('function resolveAllocation'), code.indexOf('/**\n * The A2 line'));
  assert.match(fn, /tip\.dataset\.path === node\.path/, 'a late answer must not overwrite a different tooltip');
});

test('the Settings diagnostic shows the measurement gap rather than hiding it', () => {
  // §A2 asks for the reconciliation delta to be visible. Quietly correcting for
  // it would hide precisely the uncertainty the user needs to know about.
  const code = appCode();
  const fn = code.slice(code.indexOf('async function renderAllocationDiagnostic'), code.indexOf('/* ─────────────────────────────  Settings modal'));
  assert.match(fn, /What other tools would report/, 'the naive figure is stated, not implied');
  assert.match(fn, /Space actually used/);
  assert.match(fn, /escapeHtml\(a\.reason\)/, 'the approximation caveat is always shown, escaped');
});

test('the diagnostic explains a missing reconciliation instead of showing nothing', () => {
  const code = appCode();
  const fn = code.slice(code.indexOf('async function renderAllocationDiagnostic'), code.indexOf('/* ─────────────────────────────  Settings modal'));
  assert.match(fn, /only works when you scan a whole disk/, 'a subfolder says why there is no comparison');
  assert.match(fn, /INDEX_NOT_BUILT/, 'a not-yet-indexed folder is a state, not an error');
});

/* ══════════════════════ Global search (A4) ══════════════════════ */

/** The sidebar's markup, sliced with an explicit start so it cannot slice
 *  backwards to empty (the trap this file has hit three times). */
function sideNavHtml(): string {
  const start = INDEX.indexOf('<aside id="sideNav"');
  assert.ok(start !== -1, 'the sidebar exists');
  const end = INDEX.indexOf('</aside>', start);
  const nav = INDEX.slice(start, end);
  assert.ok(nav.length > 500, 'the sidebar slice is non-empty');
  return nav;
}

test('the global search box lives at the top of the sidebar, not inside a view', () => {
  // §A4: "an always-available search bar (not tied to one view)". Putting it in
  // a view would make it search whatever happens to be on screen, which is the
  // opposite of the point. And the user's spec for the sidebar is explicit:
  // search first, then the views.
  const nav = sideNavHtml();
  assert.match(nav, /id="gsearch"/, 'the input is in the sidebar');
  assert.match(nav, /id="gsearchResults"/);
  assert.ok(
    nav.indexOf('id="gsearch"') < nav.indexOf('role="tablist"'),
    'search comes before the view list',
  );
});

test('the search box is a proper combobox for screen readers', () => {
  // §6 accessibility: a type-ahead that announces nothing is unusable without
  // sight, and the results are the whole feature.
  const nav = sideNavHtml();
  assert.match(nav, /role="combobox"/);
  assert.match(nav, /aria-expanded="false"/, 'expansion state is announced');
  assert.match(nav, /aria-controls="gsearchResults"/);
  assert.match(INDEX, /id="gsearchResults"[^>]*role="listbox"/);
});

test('the sidebar collapses to a rail, remembers the choice, and announces its state', () => {
  const nav = sideNavHtml();
  assert.match(nav, /id="sideToggle"/, 'the collapse control exists');
  assert.match(nav, /aria-expanded/, 'and carries an expanded state for assistive tech');
  const code = appCode();
  assert.match(code, /localStorage\.setItem\('tm-sidenav'/, 'the preference persists');
  assert.match(code, /mod && e\.key\.toLowerCase\(\) === 'b'/, '⌘B toggles it');
  assert.match(INDEX, /#sideNav\.collapsed \.side-label \{ display: none/, 'labels leave in rail mode');
  assert.match(INDEX, /aria-orientation="vertical"/, 'the tablist declares its new axis');
});

test('search uses the shared query language, never a second one', () => {
  // §A4 forbids inventing a second query language. The backend parses it in
  // src/utils/searchQuery.ts; the frontend must not re-implement matching at
  // all — it just sends the raw text.
  const code = appCode();
  const fn = code.slice(code.indexOf('async function runGsearch'), code.indexOf("$('gsearch').addEventListener('input'"));
  assert.match(fn, /\/api\/search\?q=/, 'the query goes to the server verbatim');
  assert.ok(!/startsWith\('\*\.'\)/.test(fn), 'the frontend does not parse the query itself');
});

test('a stale response cannot overwrite a newer one', () => {
  // Type-ahead fires many requests; without a sequence guard, a slow early
  // response lands after a fast later one and shows the wrong results.
  const code = appCode();
  const fn = code.slice(code.indexOf('async function runGsearch'), code.indexOf("$('gsearch').addEventListener('input'"));
  assert.match(fn, /\+\+gsearch\.seq/);
  assert.match(fn, /seq !== gsearch\.seq/, 'and the guard is actually checked');
});

test('typing is debounced so a fast typist issues one query, not eight', () => {
  const code = appCode();
  const fn = code.slice(code.indexOf("$('gsearch').addEventListener('input'"), code.indexOf("$('gsearch').addEventListener('keydown'"));
  assert.match(fn, /clearTimeout\(gsearch\.timer\)/);
  assert.match(fn, /setTimeout/);
});

test('results are keyboard navigable and openable', () => {
  const code = appCode();
  const fn = code.slice(code.indexOf("$('gsearch').addEventListener('keydown'"), code.indexOf("$('gsearch').addEventListener('focus'"));
  for (const key of ['ArrowDown', 'ArrowUp', 'Escape', 'Enter']) {
    assert.ok(fn.includes(key), `${key} is handled`);
  }
});

test('the keyboard shortcut works even when the sidebar is collapsed to the rail', () => {
  // Focusing a `display: none` element does nothing at all, silently — the
  // rail hides the input, so the shortcut must open the sidebar first.
  const code = appCode();
  assert.match(code, /function summonGlobalSearch/);
  const start = code.indexOf('function summonGlobalSearch');
  const fn = code.slice(start, code.indexOf('function renderGsearch', start));
  assert.ok(fn.length > 100, 'the summon slice is non-empty');
  assert.match(fn, /applySideNav\(false\)/, 'the sidebar opens first');
  assert.match(fn, /\.focus\(\)/);
  assert.match(INDEX, /#sideNav\.collapsed #gsearch \{ display: none/, 'the rail genuinely hides the input');
  assert.match(INDEX, /id="gsearchRailBtn"/, 'and offers the icon form in its place');
});

test("the Treemap's own filter box keeps its / shortcut", () => {
  // A pre-existing, documented binding. The global box takes "/" only on views
  // that never claimed it, and Cmd/Ctrl+K everywhere.
  const code = appCode();
  assert.match(code, /e\.key === '\/' && !typing && state\.view !== 'treemap'/, 'treemap is excluded');
  assert.match(code, /e\.key === '\/' && !typing && state\.view === 'grid'/, 'grid keeps its own');
  assert.match(code, /mod && e\.key\.toLowerCase\(\) === 'k'/, 'Cmd/Ctrl+K is global');
});

test('an empty result explains which kind of nothing it is', () => {
  // "No matches" and "you have not indexed anything yet" are different
  // problems with different fixes; one message for both reads as broken.
  const code = appCode();
  const fn = code.slice(code.indexOf('function renderGsearch'), code.indexOf('function gsearchHighlight'));
  assert.match(fn, /Nothing is indexed yet/);
  assert.match(fn, /No matches for/);
});

test('a capped count is shown as "N+", never as an exact figure', () => {
  const code = appCode();
  const fn = code.slice(code.indexOf('function renderGsearch'), code.indexOf('function gsearchHighlight'));
  assert.match(fn, /countCapped \? `\$\{formatCount\(result\.total\)\}\+`/, 'the cap is disclosed');
});

test('results from a stale index say so', () => {
  const code = appCode();
  const fn = code.slice(code.indexOf('function renderGsearch'), code.indexOf('function gsearchHighlight'));
  assert.match(fn, /staleRoots/);
  assert.match(fn, /out of date/i);
});

test('opening a result reuses the existing click-through and highlight', () => {
  // §3.6: new panels match existing behaviour — click-through into the treemap
  // at that path, and the existing highlight box rather than a second one.
  const code = appCode();
  const fn = code.slice(code.indexOf('async function gsearchGoTo'), code.indexOf('async function runGsearch'));
  assert.match(fn, /switchView\('treemap'\)/);
  assert.match(fn, /loadTreemap\(/);
  assert.match(fn, /\$\('tmSearch'\)\.value/, 'the existing highlight box is reused');
});

test('the search box owns its whole row, so zoom can never clip it', () => {
  // The horizontal header's terminal bug: at mild page zoom the search box
  // clipped and overlapped its neighbours, because one row held ten tabs,
  // a search box and three actions. In the sidebar the box has the column
  // to itself — full width, no flex competition — and the results panel
  // flies out over the content rather than fighting for sidebar width.
  assert.match(INDEX, /#gsearch \{\n  width: 100%;/, 'the input takes the full column');
  assert.match(INDEX, /\.gsearch-panel \{\n  position: absolute; top: 0; left: calc\(100% \+ 26px\)/, 'results fly out beside the sidebar');
});

/* ══════════════════════ Disk topology (A5) ══════════════════════ */

test('the topology panel lives on the Dashboard and is never hidden on plain machines', () => {
  // §A5 acceptance: "on a plain machine, the panel is simple and uncluttered
  // rather than hidden" — so it is a Dashboard card present unconditionally,
  // not a capability-gated tab that vanishes.
  const dashboard = INDEX.slice(INDEX.indexOf('id="view-dashboard"'), INDEX.indexOf('id="view-treemap"'));
  assert.match(dashboard, /id="topologyCard"/, 'the card is part of the Dashboard');
  assert.match(dashboard, /id="topologyBody"/);
  assert.match(dashboard, /id="topologyRefresh"/, 'the layout can be re-read after plugging in a drive');
});

test('topology data comes from the platform endpoint through the shared wrapper', () => {
  const code = appCode();
  assert.match(code, /\/api\/platform\/topology/);
});

test('an unavailable capability renders as an answer with its reason and a re-check', () => {
  // First real consumer of the §2.2 capability machinery: known-unavailable is
  // rendered from state.capabilities without a doomed request, and the server's
  // 409 reason lands in the same place when capabilities were unknown.
  const code = appCode();
  const load = code.slice(code.indexOf('async function loadTopology'), code.indexOf('function renderTopologyBlocked'));
  assert.match(load, /volumeTopology/, 'the card reads its own capability key');
  assert.match(load, /capabilityUnavailable/, "the wrapper's 409 marker is honoured");
  const blocked = code.slice(code.indexOf('function renderTopologyBlocked'), code.indexOf('function renderTopologyError'));
  assert.match(blocked, /escapeHtml\(reason/, 'the reason is shown, escaped');
  const wire = code.slice(code.indexOf('function wireTopologyActions'), code.indexOf("$('topologyRefresh')"));
  assert.match(wire, /capabilities\/refresh/, 'the re-check re-probes rather than re-reading a 30s cache');
});

test('per-disk usage sums each volume’s own bytes, never the shared ceiling', () => {
  // The correctness core of A5: APFS/pool volumes all report the container's
  // size as their own, so summing sizeBytes books the container once per
  // volume. Only usedBytes may be added up.
  const code = appCode();
  const section = code.slice(code.indexOf('function topoSection'), code.indexOf('function wireTopologyActions'));
  assert.match(section, /reduce\([\s\S]{0,40}?v\.usedBytes/, 'the bar total is a sum of usedBytes');
  assert.ok(!/reduce\([\s\S]{0,40}?v\.sizeBytes/.test(section), 'a disk bar never sums volume ceilings');
  assert.match(section, /typeof v\.usedBytes === 'number'/, 'null usage is told apart from zero');
});

test('usage the platform could not read is said out loud, not treated as zero', () => {
  // §2.2 / §10: a bar quietly missing unreadable volumes is a confident wrong
  // number. The caveat must name the count it excludes.
  const code = appCode();
  const section = code.slice(code.indexOf('function topoSection'), code.indexOf('function wireTopologyActions'));
  assert.match(section, /don.t report how full/i, 'a disk with no readable usage says so');
  assert.match(section, /excludes[^<]*volume/i, 'a partially readable disk names what the bar misses');
});

test('a pooled volume renders as one section across its disks, never split by arithmetic', () => {
  // §A5: on RAID/Storage Spaces the resiliency layout decides where bytes
  // land; dividing them per member disk would be a made-up number.
  const code = appCode();
  const render = code.slice(code.indexOf('function renderTopology('), code.indexOf('function topoSection'));
  assert.match(render, /includes\('\|'\)/, 'multi-disk backing sets form their own sections');
  assert.match(render, /POOL/, 'and are labelled as a pool');
});

test('the topology card implements the §3.5 states', () => {
  const code = appCode();
  assert.match(INDEX, /Reading disk layout/, 'loading, never a blank flash');
  assert.match(code, /No disks are visible/, 'the empty case, with a retry beside it');
  assert.match(code, /Couldn.t read the disk layout/, 'the error case, from the envelope message');
  const load = code.slice(code.indexOf('async function loadTopology'), code.indexOf('function renderTopologyBlocked'));
  assert.match(load, /querySelector\('\.topo-disk'\)/, 'a refresh repaints in place rather than blanking a populated card');
});

test('volume names and mount points are escaped before rendering', () => {
  // Volume labels are user-controlled text from outside the app.
  const code = appCode();
  const section = code.slice(code.indexOf('function topoSection'), code.indexOf('function wireTopologyActions'));
  assert.match(section, /escapeHtml\(nm\)/);
  assert.match(section, /escapeHtml\(v\.mountPoint\)/);
  assert.match(section, /formatBytes\(/, 'bytes go through the shared formatter (§3.6)');
});

test('the volume list folds its tail so a plain machine stays uncluttered', () => {
  const code = appCode();
  const section = code.slice(code.indexOf('function topoSection'), code.indexOf('function wireTopologyActions'));
  assert.match(section, /TOPO_VISIBLE_VOLUMES/, 'rows beyond the fold are hidden, not dropped');
  assert.match(section, /aria-expanded/, 'the fold is a real, stateful control');
});

test('the card repaints when the capability answer lands, even a failed one', () => {
  // The card must not sit on its skeleton because /api/platform/capabilities
  // failed — the topology request itself carries the same answer.
  const code = appCode();
  assert.match(code, /subscribe\(TOPIC\.capabilities,[\s\S]{0,30}loadTopology/);
  const caps = code.slice(code.indexOf('async function loadCapabilities'), code.indexOf('let topologyLoading'));
  const afterCatch = caps.slice(caps.indexOf('catch'));
  assert.match(afterCatch, /emit\(TOPIC\.capabilities/, 'the topic fires on the failure path too');
});

/* ══════════════════════ Open-file guard (B2) ══════════════════════ */

test('the open-file warning lives in the one dialog every view shares', () => {
  // §B2 asks for the warning in "every delete/trash confirmation dialog across
  // every view". There is exactly one such dialog, so putting it there covers
  // Grid, Treemap, the cart, Clean Up and Duplicates at once — and no future
  // view can route around it.
  const modal = INDEX.slice(INDEX.indexOf('id="confirmModal"'), INDEX.indexOf('id="confirmModal"') + 1400);
  assert.match(modal, /id="confirmOpenHandles"/, 'the warning panel is inside the confirmation dialog');
  assert.match(modal, /role="status"/, 'and is announced to a screen reader when it appears');
  const code = appCode();
  assert.match(code, /\/api\/files\/open-handles/, 'the dialog pre-flights the check');
});

test('the dialog opens first and the check fills in behind it', () => {
  // Blocking a delete dialog on a round-trip makes every delete feel stuck.
  const code = appCode();
  const fn = code.slice(code.indexOf('async function confirmTrash'), code.indexOf('let openHandleSeq'));
  const opens = fn.indexOf("$('confirmModal').classList.add('open')");
  const checks = fn.indexOf('checkOpenHandlesFor');
  assert.ok(opens !== -1 && checks !== -1);
  assert.ok(opens < checks, 'the modal is shown before the check is started');
  assert.match(fn, /void checkOpenHandlesFor/, 'and the check is not awaited');
});

test('a stale answer cannot paint into a later dialog', () => {
  const code = appCode();
  const fn = code.slice(code.indexOf('async function checkOpenHandlesFor'), code.indexOf('function renderOpenHandleWarning'));
  assert.match(fn, /const seq = \+\+openHandleSeq/);
  assert.match(fn, /if \(seq !== openHandleSeq\) return/, 'a superseded check discards its own result');
});

test('the button says what it will actually do', () => {
  // A "Move to Trash" button that proceeds past a warning the user just read is
  // a different action than the one it names.
  const code = appCode();
  const fn = code.slice(code.indexOf('function renderOpenHandleWarning'), code.indexOf('function baseName'));
  assert.match(fn, /confirmIgnoreOpenHandles = true/);
  assert.match(fn, /setConfirmButton\('Delete anyway'\)/);
});

test('the panel and button reset before every new confirmation', () => {
  // Otherwise a cloud delete — which returns early, before the check — would
  // inherit the previous dialog's warning and its "Delete anyway" button.
  const code = appCode();
  const fn = code.slice(code.indexOf('async function confirmTrash'), code.indexOf('$(\'confirmTitle\').innerHTML = icon(\'trash\', 18) + \'Move to Trash?\''));
  assert.match(fn, /resetOpenHandleWarning\(\)/);
  const reset = code.slice(code.indexOf('function resetOpenHandleWarning'), code.indexOf('async function checkOpenHandlesFor'));
  assert.match(reset, /openHandleSeq\+\+/, 'and abandons any check still in flight');
  assert.match(reset, /confirmIgnoreOpenHandles = false/, 'the bypass never carries over');
});

test('"couldn\'t check" is never rendered as "nothing is open"', () => {
  // §2.2: the three states stay distinct. An empty conflict list with
  // checked:false is an unknown, and must read as one.
  const code = appCode();
  const fn = code.slice(code.indexOf('function renderOpenHandleWarning'), code.indexOf('function baseName'));
  assert.match(fn, /report\.checked === false/, 'the unknown case is told apart from the clear case');
});

test('a failed pre-flight does not stand between the user and their delete', () => {
  const code = appCode();
  const fn = code.slice(code.indexOf('async function checkOpenHandlesFor'), code.indexOf('function renderOpenHandleWarning'));
  assert.match(fn, /catch\s*\{[\s\S]*?host\.hidden = true;[\s\S]*?return;/, 'the panel simply disappears');
});

test('the delete request carries the choice the user made', () => {
  const code = appCode();
  const fn = code.slice(code.indexOf('async function trashPaths'), code.indexOf('async function reofferBlockedTrash'));
  assert.match(fn, /ignoreOpenHandles: true/, 'and only when they chose it');
  assert.match(fn, /ignoreOpenHandles \?/, 'the flag is omitted rather than sent as false');
});

test('a file opened after the check re-asks instead of just failing', () => {
  // The race the pre-flight cannot close: the server refuses, and the user gets
  // the real reason plus a way forward rather than a dead-end toast.
  const code = appCode();
  const fn = code.slice(code.indexOf('async function trashPaths'), code.indexOf('async function reofferBlockedTrash'));
  assert.match(fn, /e\.code === 'OPEN_HANDLE_CONFLICT'/);
  assert.match(fn, /reofferBlockedTrash/);
  const reoffer = code.slice(code.indexOf('async function reofferBlockedTrash'), code.indexOf('function rescan'));
  assert.match(reoffer, /renderOpenHandleWarning/, 'the re-ask shows which program, not just that it failed');
});

test('error details survive the shared fetch wrapper', () => {
  // The envelope is flat, so `conflicts` rides alongside error/code. Dropping
  // unknown keys there would leave the dialog unable to name any program.
  const code = appCode();
  const fn = code.slice(code.indexOf('async function api('), code.indexOf('function reportError'));
  assert.match(fn, /k !== 'error' && k !== 'code'/, 'extra envelope keys are carried onto the error');
});

test('program names and file names are escaped in the warning', () => {
  const code = appCode();
  const fn = code.slice(code.indexOf('function renderOpenHandleWarning'), code.indexOf('function baseName'));
  assert.match(fn, /escapeHtml\(name\)/);
  assert.match(fn, /escapeHtml\(baseName\(f\)\)/);
});

/* ══════════════════════ Time Capsule (B3) ══════════════════════ */

test('the Time Capsule is a registered view, not a second navigation mechanism', () => {
  // registerView() is the only supported way to add a view: pushing to VIEWS
  // alone leaves VIEW_BY_ID stale and switchView silently does nothing.
  const code = appCode();
  assert.match(code, /registerView\(\{[\s\S]{0,200}id:\s*'capsule'/, 'it goes through the registry');
  assert.match(INDEX, /data-view="capsule"/, 'and has a real tab');
  assert.match(INDEX, /id="view-capsule"/, 'pointing at a real section');
});

test('the capsule reads persisted history, so it works with no scan loaded', () => {
  const code = appCode();
  const reg = code.slice(code.indexOf("id: 'capsule'"), code.indexOf("id: 'capsule'") + 400);
  assert.match(reg, /needsScan:\s*false/, 'like Trends, Compare and Offloaded');
});

test('the empty state explains that an empty capsule is the correct state', () => {
  // Until Autopilot (B1) exists nothing deletes automatically, so this list is
  // legitimately empty. Saying "nothing here" without saying why would read as
  // a fault, and would make a user hunt for a feature that is working.
  const code = appCode();
  assert.match(code, /that.s the normal state/i);
  assert.match(code, /deletes automatically/i, 'it names what fills the capsule');
  assert.match(code, /delete yourself/i, 'and what deliberately does not');
});

test('protection that was withheld or withdrawn is shown, never left to a log', () => {
  // §B3's "warn rather than silently skipping protection" is only satisfied if
  // the warning reaches a human. These are the moments a user would otherwise
  // discover by looking for a file that is not there.
  const code = appCode();
  assert.match(code, /function renderCapsuleEvents/);
  assert.match(code, /couldn.t keep/i, 'the section has a heading of its own');
  const labels = code.slice(code.indexOf('CAPSULE_EVENT_LABEL'), code.indexOf('async function loadCapsule'));
  for (const kind of ['evicted', 'expired', 'unprotected', 'lost']) {
    assert.match(labels, new RegExp(kind), `${kind} is given plain-language wording`);
  }
});

test('an item with no copy left offers no Restore button', () => {
  // Offering a restore that must fail is worse than not offering one. The flag
  // is hasPayload, never heldBytes: an empty folder holds zero bytes and is
  // still perfectly restorable.
  const code = appCode();
  const render = code.slice(code.indexOf('function renderCapsule('), code.indexOf('function renderCapsuleEvents'));
  assert.match(render, /const gone = !e\.hasPayload/, 'presence is its own fact, not inferred from size');
  assert.match(render, /gone \? '' : `[\s\S]{0,200}data-cap-restore/, 'no payload → no Restore');
  assert.ok(!/heldBytes\s*>\s*0\s*\?/.test(render), 'restorability is never derived from a byte count');
});

test('the capsule shows how full it is against its own cap', () => {
  const code = appCode();
  const render = code.slice(code.indexOf('function renderCapsule('), code.indexOf('function renderCapsuleEvents'));
  assert.match(render, /status\.capBytes/, 'the ceiling is shown, not just the usage');
  assert.match(render, /retentionDays/, 'and how long things are kept');
  assert.match(render, /formatBytes\(/, 'through the shared formatter (§3.6)');
});

test('restoring streams through the one shared progress dialog', () => {
  // §3.3: anything that can exceed a second uses the SSE job pattern, and §3.6
  // wants it to look like every other job rather than a bespoke panel.
  const code = appCode();
  const fn = code.slice(code.indexOf('function restoreFromCapsule'), code.indexOf('function forgetCapsuleEntry'));
  assert.match(fn, /watchJob\(/, 'the same driver Offload uses');
  assert.match(fn, /\/api\/timecapsule\/jobs\/\$\{resp\.jobId\}\/progress/);
  assert.match(fn, /cancelUrl/, 'and it is cancellable (§6)');
});

test('there is one job-progress implementation, not one per feature', () => {
  const code = appCode();
  assert.match(code, /function watchJob\(opts\)/);
  const offload = code.slice(code.indexOf('function watchOffloadJob'), code.indexOf("$('offloadCancelBtn')"));
  assert.match(offload, /watchJob\(\{/, 'offload delegates to it rather than keeping its own copy');
  assert.equal((code.match(/new EventSource\(opts\.progressUrl\)/g) || []).length, 1);
});

test('forgetting a copy uses the shared destructive confirmation', () => {
  const code = appCode();
  const fn = code.slice(code.indexOf('function forgetCapsuleEntry'), code.indexOf("$('capsuleSearch')"));
  assert.match(fn, /onConfirmTrash =/, 'the same dialog every destructive action uses (§3.6)');
  assert.match(fn, /confirmModal/);
  assert.match(fn, /already deleted from your disk/, 'and it is honest about what is actually at stake');
});

test('the capsule panel implements the §3.5 states', () => {
  const code = appCode();
  assert.match(code, /Reading the Time Capsule/, 'loading');
  assert.match(code, /Couldn.t read the Time Capsule/, 'error, from the envelope message');
  assert.match(code, /capsuleRetry/, 'with a retry');
  const render = code.slice(code.indexOf('function renderCapsule('), code.indexOf('function renderCapsuleEvents'));
  assert.match(render, /status\.available/, 'unavailable, with the reason');
  assert.match(render, /Nothing protected matches that search/, 'a search that finds nothing is not the empty state');
});

test('capsule retention and its size cap are user-settable', () => {
  assert.match(INDEX, /id="capsuleRetentionDays"/);
  assert.match(INDEX, /id="capsuleMaxPercent"/);
  const code = appCode();
  assert.match(code, /timeCapsuleRetentionDays/);
  assert.match(code, /timeCapsuleMaxPercent/);
  // The bound matters: the capsule must never be the reason a disk fills up.
  assert.match(INDEX, /id="capsuleMaxPercent"[^>]*max="90"/);
});

/* ══════════════════════ Autopilot (B1) ══════════════════════ */

test('Autopilot is its own tab and does not replace Clean Up', () => {
  // §B1: "New Autopilot tab alongside (not replacing) Clean Up, which stays
  // manual." Deleting something now and standing up a rule that deletes
  // forever are different decisions and must stay different surfaces.
  assert.match(INDEX, /data-view="autopilot"/);
  assert.match(INDEX, /id="view-autopilot"/);
  assert.match(INDEX, /id="cleanModal"/, 'Clean Up is still here');
  assert.match(INDEX, /id="cleanPaneRules"/, 'with its manual rules pane intact');
  const code = appCode();
  assert.match(code, /registerView\(\{[\s\S]{0,200}id:\s*'autopilot'/);
});

test('the policy editor reuses the Clean Up rule controls rather than inventing new ones', () => {
  // Same four ideas, same order, same wording as Clean Up's custom rules.
  for (const id of ['apRuleAgeOn', 'apRuleAgeDays', 'apRuleSizeOn', 'apRuleSizeMb', 'apRuleExtOn', 'apRuleExts']) {
    assert.match(INDEX, new RegExp(`id="${id}"`), `${id} is missing from the policy editor`);
  }
});

test('every safety rail is exposed in the editor, not just in the engine', () => {
  // A rail the user cannot see or set is a rail they will not trust.
  for (const id of ['apMaxRun', 'apMaxWeek', 'apConfirmAbove', 'apCooldown', 'apDryRunFirst', 'apEnabled']) {
    assert.match(INDEX, new RegExp(`id="${id}"`), `${id} is missing`);
  }
});

test('the empty state explains that nothing is deleted on a first run', () => {
  // The single most important thing to know before writing a policy.
  const code = appCode();
  assert.match(code, /Nothing is ever deleted on the first run/i);
  assert.match(code, /Time Capsule/, 'and that deletions are recoverable');
});

test('a run awaiting approval opens itself and offers the approval', () => {
  // A decision folded behind a disclosure triangle is a decision nobody makes.
  const code = appCode();
  const fn = code.slice(code.indexOf('function renderAutopilotRuns'), code.indexOf('function approveAutopilotPolicy'));
  assert.match(fn, /data-ap-approve/);
  assert.match(fn, /querySelector\('\[data-ap-approve\]'\)[\s\S]{0,80}classList\.add\('open'\)/);
});

test('approval goes through the shared destructive confirmation', () => {
  const code = appCode();
  const fn = code.slice(code.indexOf('function approveAutopilotPolicy'), code.indexOf('function undoAutopilotRun'));
  assert.match(fn, /onConfirmTrash =/, 'the same dialog every destructive action uses (§3.6)');
  assert.match(fn, /without asking again/, 'and it is honest about what approval means');
});

test('undo streams through the one shared progress dialog', () => {
  const code = appCode();
  const fn = code.slice(code.indexOf('function undoAutopilotRun'), code.indexOf('function deletePolicy'));
  assert.match(fn, /watchJob\(/);
  assert.match(fn, /\/api\/timecapsule\/jobs\/\$\{resp\.jobId\}\/progress/, 'the capsule owns the restore, Autopilot just starts it');
  assert.match(fn, /cancelUrl/);
});

test('a run shows why each item was chosen, and what it left alone', () => {
  // §B1 wants the run record to carry what and why. On screen that means the
  // rule's own words beside every item, and the skipped list visible.
  const code = appCode();
  const fn = code.slice(code.indexOf('function renderAutopilotRuns'), code.indexOf('function approveAutopilotPolicy'));
  assert.match(fn, /i\.reason/, 'each item says why it was selected');
  assert.match(fn, /r\.skipped/, 'and what was left behind is shown');
  assert.match(fn, /blockedReason/, 'a run that refused explains itself');
});

test('preview never saves, and is available before a policy exists', () => {
  const code = appCode();
  assert.match(code, /\/api\/autopilot\/simulate/);
  const fn = code.slice(code.indexOf("$('apPreviewBtn')"), code.indexOf("$('apSaveBtn')"));
  assert.match(fn, /policy: policyFromEditor\(\)/, 'it previews the unsaved draft');
  assert.ok(!/method:\s*'PUT'/.test(fn), 'previewing must not write anything');
});

test('byte limits are entered in GB and converted once, in one place', () => {
  const code = appCode();
  // Anchored on a string that occurs once: '#apMatchSeg' also appears inside
  // setApMatchKind, above this function, which would slice backwards to
  // nothing and silently assert against an empty string.
  const fn = code.slice(code.indexOf('function policyFromEditor'), code.indexOf("$('apAddBtn')"));
  assert.match(fn, /const gb = \(id\)/, 'one conversion helper, not three hand-written multiplications');
  assert.match(fn, /maxBytesPerRun: gb\('apMaxRun'\)/);
  assert.match(fn, /maxBytesPerWeek: gb\('apMaxWeek'\)/);
  assert.match(fn, /requireConfirmationAbove: gb\('apConfirmAbove'\)/);
});

test('the Autopilot panel implements the §3.5 states', () => {
  const code = appCode();
  assert.match(code, /Loading policies/, 'loading');
  assert.match(code, /Couldn.t load Autopilot/, 'error, from the envelope message');
  assert.match(code, /apRetry/, 'with a retry');
  assert.match(code, /No policies yet/, 'empty');
  assert.match(code, /Nothing has run yet/, 'and an empty run history is explained too');
});

/* ══════════════════════ Snapshot recovery (B4) ══════════════════════ */

test('only a removed Compare row offers to check snapshots', () => {
  // §B4 puts the action on removed rows. A file that still exists has nothing
  // to recover, and the button beside it would be noise on every other row.
  const code = appCode();
  const fn = code.slice(code.indexOf('function deltaRow'), code.indexOf('async function checkSnapshotsFor'));
  assert.match(fn, /const removed = en\.sizeB === null/);
  assert.match(fn, /removed && opts\.offerSnapshots/, 'gated on the row actually being a deletion');
  assert.match(fn, /data-snap-check/);
});

test('looking is separated from recovering, because only one costs a password', () => {
  const code = appCode();
  assert.match(code, /\/api\/system\/snapshots\/find-deleted/);
  assert.match(code, /\/api\/system\/snapshots\/restore/);
  const find = code.slice(code.indexOf('async function checkSnapshotsFor'), code.indexOf('async function restoreFromSnapshot'));
  assert.ok(!/snapshots\/restore/.test(find), 'checking must never trigger the privileged call');
});

test('an unconfirmed snapshot is never described as containing the file', () => {
  // On macOS and Windows TreeMap knows a snapshot exists but not what is in it
  // until authorized. Saying "found it" would be a claim nobody checked.
  const code = appCode();
  const fn = code.slice(code.indexOf('async function checkSnapshotsFor'), code.indexOf('async function restoreFromSnapshot'));
  assert.match(fn, /result\.confirmed/, 'the two cases are told apart');
  // Assert the *claim*, not adjacency: the wording comes from a template whose
  // plural switch splits "covers"/"cover" from "this period", so a
  // phrase-matching regex would break on a perfectly correct edit.
  assert.match(fn, /this period/, 'the unconfirmed wording is about a period being covered');
  assert.match(fn, /cover/, 'in terms of coverage');
  assert.match(fn, /administrator password/i, 'and says what checking would cost');

  // The decisive part: only the branch that actually looked inside may claim a
  // find. "Found in" must sit on the confirmed side of the ternary.
  // Search for the end anchor *after* the start one: `host.innerHTML` also
  // appears in the loading and error branches above this, so a plain
  // indexOf would slice backwards to an empty string.
  const headlineAt = fn.indexOf('const headline');
  const branches = fn.slice(headlineAt, fn.indexOf('host.innerHTML', headlineAt));
  assert.ok(branches.length > 50, 'the headline slice must not be empty');
  const split = branches.split(/\n\s*:\s/);
  assert.equal(split.length, 2, 'headline is a two-branch choice on result.confirmed');
  assert.match(split[0], /Found in/, 'the confirmed branch is the one that claims a find');
  assert.ok(!/Found in/.test(split[1]), 'the unconfirmed branch never claims the file is in there');
});

test('the panel promises the recovered file goes beside the original', () => {
  const code = appCode();
  const fn = code.slice(code.indexOf('async function checkSnapshotsFor'), code.indexOf('async function restoreFromSnapshot'));
  assert.match(fn, /never over anything/i);
});

test('a declined password prompt is shown neutrally, not as a failure', () => {
  const code = appCode();
  const fn = code.slice(code.indexOf('async function restoreFromSnapshot'), code.indexOf('function wireSnapshotActions'));
  assert.match(fn, /AUTHORIZATION_DECLINED/);
  assert.match(fn, /declined \? 'clock' : 'alert'/, 'a decision gets a neutral icon, an error gets the alert');
});

test('the snapshot panel implements the §3.5 states', () => {
  const code = appCode();
  assert.match(code, /Looking through this system.s snapshots/, 'loading');
  assert.match(code, /Try again/, 'error, with a retry');
  const fn = code.slice(code.indexOf('async function checkSnapshotsFor'), code.indexOf('async function restoreFromSnapshot'));
  assert.match(fn, /result\.reason/, 'unavailable, carrying the specific reason');
  assert.match(fn, /stillPresent/, 'and the not-a-recovery-case answer');
});

/* ══════════════════════ Safety copy (§2, §B2) ══════════════════════ */

test('the delete confirmation still promises the Trash', () => {
  // The trash-only guarantee is the app's core safety promise; a refactor must
  // not quietly reword it away.
  assert.match(INDEX, /Trash|Recycle Bin/, 'the destructive dialog must name the Trash');
});

/* ══════════════ Near-duplicate rendering stays windowed (perf) ══════════════ */

test('the near-duplicate view renders a window, never the whole result', () => {
  const code = appCode();
  // A single result clustered 1,556 images into one group; rendering all of it
  // added 28,196 nodes and 7,830 listeners, which is what made the whole app
  // sluggish afterwards. The window is the fix, so it is pinned.
  assert.match(code, /const ND_CLUSTER_BATCH = \d+/, 'clusters render in batches');
  assert.match(code, /const ND_ITEMS_PER_STEP = \d+/, 'images within a cluster render in steps');

  const render = code.slice(code.indexOf('function renderNearDupes'), code.indexOf('function bindNearDupeDelegation'));
  assert.ok(render.length > 0, 'renderNearDupes must be findable');
  assert.doesNotMatch(render, /clusters\.map\(/, 'the renderer must not build every cluster at once');
  assert.match(render, /ndAppendClusters\(\)/, 'it hands off to the incremental appender');

  const append = code.slice(code.indexOf('function ndAppendClusters'), code.indexOf('function ndSyncNewNodes'));
  assert.ok(append.length > 0, 'ndAppendClusters must be findable');
  assert.match(append, /Math\.min\(n\.clusters\.length, from \+ ND_CLUSTER_BATCH\)/, 'each step is bounded');
  assert.match(append, /data-nd-loadmore/, 'and leaves an explicit control for the next batch');
});

test('near-duplicate handlers are delegated, not attached per image', () => {
  const code = appCode();
  const bind = code.slice(code.indexOf('function bindNearDupeDelegation'), code.indexOf('function updateNdToolbar'));
  assert.ok(bind.length > 0, 'the delegation block must be findable');
  for (const type of ['change', 'click', 'keydown', 'error']) {
    assert.match(bind, new RegExp(`body\\.addEventListener\\('${type}'`), `${type} is delegated from #ndBody`);
  }
  // The old code attached listeners inside querySelectorAll loops over every
  // checkbox, thumb wrapper, image and reveal button.
  const render = code.slice(code.indexOf('function ndItemHtml'), code.indexOf('function bindNearDupeDelegation'));
  assert.doesNotMatch(render, /\.forEach\(\s*\w+\s*=>\s*\{?[^}]*addEventListener/, 'no per-element listener loops remain');
});

test('a failed thumbnail retries before it is called broken', () => {
  const code = appCode();
  assert.match(code, /const ND_THUMB_RETRIES = \d+/, 'retries are bounded and named');
  const bind = code.slice(code.indexOf('function bindNearDupeDelegation'), code.indexOf('function updateNdToolbar'));
  assert.match(bind, /tries < ND_THUMB_RETRIES/, 'a transient failure is retried');
  assert.match(bind, /nd-thumb broken/, 'and only then replaced with the broken placeholder');
});

test('leaving the Duplicates view frees the near-duplicate DOM', () => {
  const code = appCode();
  const unmount = code.slice(code.indexOf("id: 'duplicates'"), code.indexOf("id: 'trends'"));
  assert.ok(unmount.length > 0, 'the duplicates view registration must be findable');
  assert.match(unmount, /ndClearBody\(\)/, 'unmount empties #ndBody');
  assert.match(code, /function ndClearBody/, 'and that helper exists');
});

test('cart buttons are only rewritten when their state actually changed', () => {
  const code = appCode();
  const fn = code.slice(code.indexOf('function refreshCartButtons'), code.indexOf('async function renderCart'));
  assert.ok(fn.length > 0, 'refreshCartButtons must be findable');
  assert.match(fn, /if \(b\.dataset\.cartin === want\) return;/, 'an already-correct button is skipped entirely');
});

/* ══════════════ Smart Suggestions are rule-pack sourced (§C8) ══════════════ */

test('every suggestion group offers a "why is this suggested" affordance', () => {
  const code = appCode();
  const fn = code.slice(code.indexOf('async function loadSmartSuggestions'), code.indexOf("$('cleanFindBtn')"));
  assert.ok(fn.length > 0, 'loadSmartSuggestions must be findable');
  assert.match(fn, /class="icon-btn why-btn" data-why=/, 'each group gets a why control');
  assert.match(fn, /aria-expanded="false" aria-controls="smartWhy/, 'and it is announced as a disclosure');
  assert.match(fn, /What matched:/, 'the panel says what the rule matched');
  assert.match(fn, /confidenceWording\(g\.confidence, adv\)/, 'and states the rule pack confidence');
  assert.match(code, /function confidenceWording/, 'confidence is put into words, not shown as a bare level');
});

test('an advisory group is never offered for deletion', () => {
  const code = appCode();
  const fn = code.slice(code.indexOf('async function loadSmartSuggestions'), code.indexOf("$('cleanFindBtn')"));
  assert.match(fn, /const adv = !!g\.advisory;/, 'advisory groups are identified');
  // No select-all, no per-item checkbox, no cart button — the three ways an
  // item can reach the delete path.
  assert.match(fn, /adv\s*\n?\s*\?[^]*?adv-mark[^]*?:\s*`<input type="checkbox" class="smart-all"/, 'no select-all on an advisory group');
  assert.match(fn, /\$\{adv \? '<span class="adv-spacer"><\/span>' : `<input type="checkbox" class="smart-ck"/, 'no per-item checkbox');
  assert.match(fn, /\$\{adv \? '' : `<button class="icon-btn" data-cart-add=/, 'no add-to-cart button');
  assert.match(fn, /Do not move this to the Trash/, 'and the panel says so plainly');
});

test('a broken rule pack is reported as unavailable, with its reason', () => {
  const code = appCode();
  const fn = code.slice(code.indexOf('async function loadSmartSuggestions'), code.indexOf("$('cleanFindBtn')"));
  assert.match(fn, /data\.available === false/, 'the unavailable state is handled');
  assert.match(fn, /Smart Suggestions are unavailable/, 'and named as unavailable, not as "nothing found"');
  assert.match(fn, /escapeHtml\(data\.reason/, 'carrying the specific reason from the server');
});

test('the rule-pack catalog states which packs produced the list, and when', () => {
  const code = appCode();
  assert.match(code, /function catalogNote/, 'provenance is rendered');
  const fn = code.slice(code.indexOf('function catalogNote'), code.indexOf('async function loadSmartSuggestions'));
  assert.match(fn, /Rule packs:/);
  assert.match(fn, /updated \$\{escapeHtml\(updated\)\}/, 'a stale catalog must be visible as stale');
});

/* ══════════════ Package leftovers feed the existing bucket (§C6) ══════════════ */

test('the package panel is grouped by ecosystem and shows owner, date and command', () => {
  const code = appCode();
  const fn = code.slice(code.indexOf('async function renderPackageOrphans'), code.indexOf('const BROWSER_FAV'));
  assert.ok(fn.length > 0, 'renderPackageOrphans must be findable');
  assert.match(fn, /class="pkg-eco"/, 'entries are grouped per ecosystem');
  assert.match(fn, /pkg-proj/, 'each entry names its owning project, or says there is none');
  assert.match(fn, /formatDate\(e\.modifiedAt\)/, 'and its last-build date');
  assert.match(fn, /to clear' : 'to restore'/, 'and the command that puts it back or clears it');
});

test('an in-use package artifact is never offered for deletion by this panel', () => {
  const code = appCode();
  const fn = code.slice(code.indexOf('async function renderPackageOrphans'), code.indexOf('const BROWSER_FAV'));
  assert.match(fn, /const selectable = e\.kind !== 'active' && !e\.advisory;/, 'active and advisory rows are not selectable');
  assert.match(fn, /selectable\s*\n?\s*\?\s*`<input type="checkbox" class="pkg-ck"/, 'only selectable rows get a checkbox');
  assert.match(fn, /\$\{selectable \? `<button class="icon-btn" data-cart-add=/, 'and only they get a cart button');
});

test('the package panel feeds the one Clean Up selection, deduped by path', () => {
  const code = appCode();
  const fn = code.slice(code.indexOf('function activeCleanSelection'), code.indexOf('function updateCleanSummary'));
  assert.ok(fn.length > 0, 'activeCleanSelection must be findable');
  // An orphaned node_modules is offered by BOTH the package panel and Smart
  // Suggestions; selecting it twice must not count its bytes twice.
  assert.match(fn, /const chosen = new Map\(\)/, 'the selection is keyed by path');
  assert.match(fn, /#packageOrphans \.pkg-ck/, 'the package panel contributes to it');
  assert.match(fn, /paths: \[\.\.\.chosen\.keys\(\)\]/, 'and the result is the deduped key set');
});

test('a broken rule pack makes the package panel say so, not report zero orphans', () => {
  const code = appCode();
  const fn = code.slice(code.indexOf('async function renderPackageOrphans'), code.indexOf('const BROWSER_FAV'));
  assert.match(fn, /data\.available === false/);
  assert.match(fn, /could not be checked/, 'unknown is not the same as clean');
  assert.match(fn, /escapeHtml\(data\.reason/);
});

/* ══════════════════ Games: only shader caches are clearable (§C7) ══════════════════ */

test('the Games view breaks each title into its parts', () => {
  const code = appCode();
  const fn = code.slice(code.indexOf('function renderGames'), code.indexOf('function clearShaderCaches'));
  assert.ok(fn.length > 0, 'renderGames must be findable');
  for (const part of ['base', 'dlc', 'shaderCache', 'workshop', 'compatPrefix']) {
    assert.ok(code.includes(`${part}:`) || code.includes(`gp-${part}`), `the ${part} component is rendered`);
  }
  assert.match(fn, /No Steam, Epic, GOG or itch\.io library was found/, 'and it has an honest empty state');
});

test('only the shader cache is ever offered for clearing, and the stutter is stated', () => {
  const code = appCode();
  const fn = code.slice(code.indexOf('function clearShaderCaches'), code.indexOf("/** Short per-category summary"));
  assert.ok(fn.length > 0, 'clearShaderCaches must be findable');
  // The one filter that keeps a redownload, a mod subscription or a Proton
  // prefix out of the delete list.
  assert.match(fn, /c\.kind === 'shaderCache'/, 'the delete list is filtered to shader caches alone');
  assert.match(fn, /trashPaths\(paths\)/, 'and goes through the one Trash-only delete path');
  assert.match(fn, /stutter once/, 'the one-time cost is stated before the user agrees');
  assert.doesNotMatch(fn, /kind === 'base'|kind === 'workshop'|kind === 'compatPrefix'/, 'nothing else is collected');
});

test('a game total states when it disagrees with the launcher, rather than hiding it', () => {
  const code = appCode();
  const fn = code.slice(code.indexOf('function renderGames'), code.indexOf('function clearShaderCaches'));
  assert.match(fn, /t\.reportedBytes/, 'the launcher’s own figure is used');
  assert.match(fn, /says \$\{formatBytes\(t\.reportedBytes\)\}/, 'and shown when it differs');
});

/* ══════════════════ Security: look, never delete (§C5) ══════════════════ */

test('the Security panel offers no delete, and says it never read anything', () => {
  const code = appCode();
  const fn = code.slice(code.indexOf('function renderSecurity'), code.indexOf('function confirmRelocateSecret'));
  assert.ok(fn.length > 0, 'renderSecurity must be findable');
  // False positives here are expensive; the only actions are "show me" and
  // "put it somewhere sensible".
  assert.doesNotMatch(fn, /data-cart-add|confirmTrash|trashPaths/, 'no delete of any kind is offered');
  assert.match(fn, /data-sec-reveal/, 'reveal is offered');
  assert.match(fn, /no file was opened and nothing leaves this computer/, 'and the method is stated plainly');
});

test('moving a secret warns that references to the old path will break', () => {
  const code = appCode();
  const fn = code.slice(code.indexOf('function confirmRelocateSecret'), code.indexOf("/* ───────────────────────────── Games view"));
  assert.ok(fn.length > 0, 'confirmRelocateSecret must be findable');
  assert.match(fn, /will need updating/, 'the real cost of moving a key is stated');
  assert.match(fn, /Nothing is deleted/, 'and that nothing is deleted');
  assert.match(fn, /confirm: true/, 'the endpoint is double-gated');
});

/* ══════════════ Provenance URLs are untrusted text (§C3) ══════════════ */

test('an origin URL is never a live link, and never shown up front', () => {
  const code = appCode();
  const fn = code.slice(code.indexOf('async function loadProvenance'), code.indexOf('function renderPreviewMeta'));
  assert.ok(fn.length > 0, 'loadProvenance must be findable');
  // The string came from a web page. A full URL in a panel is both ugly and a
  // shoulder-surfing risk, and an anchor is a click away from being followed.
  assert.doesNotMatch(fn, /<a\s/i, 'no anchor is ever built');
  assert.doesNotMatch(fn, /window\.open|location\.href|fetch\(data\.url/, 'the URL is never followed');
  assert.match(fn, /escapeHtml\(data\.host/, 'the host is escaped');
  assert.match(fn, /Show the full address/, 'the full URL is behind a deliberate click');
  assert.match(fn, /textContent = data\.url/, 'and set as text, never as markup');
});

test('a file with no recorded origin is explained, not left blank', () => {
  const code = appCode();
  const fn = code.slice(code.indexOf('async function loadProvenance'), code.indexOf('function renderPreviewMeta'));
  assert.match(fn, /data\.absentReason/, 'the server’s explanation is shown');
  assert.match(fn, /!data\.supported/, 'and an OS that cannot record it says so separately');
  assert.match(fn, /never opened since it was saved/, 'last-opened has an honest unknown state');
});
