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
  'dashboard', 'treemap', 'grid', 'apps', 'duplicates', 'trends', 'offloaded',
  'capsule', // B3 — Time Capsule
  'autopilot', // B1 — Autopilot
  'games', // C7 — game libraries
  'security', // C5 — secrets hygiene
  'fleet', // D1 — LAN fleet view
  'missing', // v4 §5 — The Missing Gigabytes
  'city', // v4 §6.1 — Disk City, the isometric view
  'history', // v4 §7 — one tab for the time dimension: calendar · journal · compare
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

/**
 * The body of a function up to and including its first `return`.
 *
 * Comment-stripped, and that is the whole point. The first version of these
 * two tests searched a fixed window of the RAW source, and both of the guards
 * they were meant to protect could be deleted without either test noticing —
 * because the prose explaining why the guard mattered still contained the word
 * being searched for. Verified by deleting them: two of three mutations passed.
 *
 * Bounding at the first `return` is the other half: a guard is a thing that
 * returns early, so anywhere later in the function is not a guard.
 */
function guardWindow(name: string): string {
  const code = appCode();
  const start = code.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} exists in the script`);
  const open = code.indexOf('{', start);
  const firstReturn = code.indexOf('return', open);
  assert.notEqual(firstReturn, -1, `${name} has an early return to guard with`);
  return code.slice(open, firstReturn + 12);
}

test('no id rides on a data-icon span — the injector replaces the element wholesale', () => {
  /* The icon injector does `el.outerHTML = icon(...)` on every [data-icon]
     span at boot, which destroys the element along with every attribute on
     it. An id put there dies silently, and the first $(...) that reaches for
     it returns null — found live as a load-time crash that killed every
     binding declared after it. The id belongs on a wrapper around the
     data-icon span, never on the span itself. */
  const offenders = [...INDEX.matchAll(/<span[^>]*data-icon=[^>]*>/g)]
    .map((m) => m[0])
    .filter((tag) => /\bid=/.test(tag));
  assert.deepEqual(offenders, [], 'ids on data-icon spans do not survive icon injection');
});

test('the offload dock never runs a bare move — re-verify, manifest, confirm, then the pipeline', () => {
  /* v4 §8.3: the dock is a new gesture onto the PROVEN pipeline. Its drop
     handler must, in order: re-check the drive still exists (mid-drag
     removal aborts), dry-run for the exact manifest, put that manifest
     behind the shared confirm, and only then hand the same paths to the
     same runOffloadJob every other offload uses. This pins the order
     structurally so a refactor cannot quietly skip a step. */
  const code = appCode();
  const start = code.indexOf('async function dockDrop');
  assert.notEqual(start, -1, 'dockDrop exists in the script');
  const body = code.slice(start, start + 4000);
  const reverify = body.indexOf('/api/volumes');
  const dry = body.indexOf('dryRun');
  const confirm = body.indexOf('confirmModal');
  const run = body.indexOf('runOffloadJob');
  assert.ok(reverify !== -1 && dry !== -1 && confirm !== -1 && run !== -1, 'all four steps are present');
  assert.ok(reverify < dry && dry < confirm && confirm < run, 'and in the only safe order');
  // QA D1: the manifest is built from cart entries that exist in THIS scan —
  // one stale path (already offloaded, or from an older scan) must not 404
  // the dryRun and brick every later drop.
  assert.match(body, /pathIndex/, 'stale cart entries are filtered against the scan before the plan');
  // Review RD3: the shared confirm is repainted from a clean slate — a stale
  // open-handle warning panel (and its "Delete anyway" button) must never
  // bleed into the offload dialog.
  assert.match(body, /resetOpenHandleWarning\(\)/, 'the confirm panel is reset before reuse');
});

test('a drop on a drive tile only accepts the cart payload — never a foreign drag', () => {
  /* QA D2: dragover checked the payload type but drop did not, and the
     window-level dragover preventDefault makes the whole page a drop target —
     so a text selection or a Finder file released over a tile launched an
     offload confirm for unrelated cart contents. Both delegates must check. */
  const code = appCode();
  const dockWiring = code.slice(code.indexOf("for (const dockId of ['tmDock', 'cityDock'])"));
  const dropAt = dockWiring.indexOf("addEventListener('drop'");
  assert.notEqual(dropAt, -1, 'the drop delegate exists');
  const dropBody = dockWiring.slice(dropAt, dropAt + 600);
  assert.match(dropBody, /application\/x-treemap-cart/, 'drop rejects payloads that are not the cart');
});

test('the duplicate viewer is keyboard-first, and its key listener is named and taken back', () => {
  /* v4 §8.2: ←/→ between groups, 1/2 to pick the keeper, Space to stage the
     other — and the document-level keydown listener follows the named-
     listener rule: added on open, removed by name on close, so closing the
     viewer cannot leave the app's keys hijacked. */
  const code = appCode();
  assert.match(code, /function dupeViewerKeys\(/, 'the key handler is a named function');
  assert.match(code, /addEventListener\('keydown', dupeViewerKeys\)/, 'added by name');
  assert.match(code, /removeEventListener\('keydown', dupeViewerKeys\)/, 'removed by the same name');
  const handler = code.slice(code.indexOf('function dupeViewerKeys('), code.indexOf('function dupeViewerKeys(') + 2500);
  for (const key of ['ArrowLeft', 'ArrowRight', "' '"]) {
    assert.ok(handler.includes(key), `the handler answers ${key}`);
  }
  assert.match(handler, /e\.key >= '1' && e\.key <= '9'/, 'digit keys pick the keeper — the spec\'s 1/2 pair case and beyond');
});

test('the compare split view exists and follows the reclaim slider keyboard pattern', () => {
  /* v4 §7.4: the divider must be a NATIVE range input — arrows, Home and End
     come from the platform, not from hand-rolled key handling — with a live
     aria-valuetext, the same pattern the reclaim-weight sliders set. And its
     canvas must own its pixel-ratio transform (setTransform, never scale on
     top of an inherited matrix), the rule the overlay test below enforces for
     the static canvases. */
  const code = appCode();
  const start = code.indexOf('function initCmpSplit');
  assert.notEqual(start, -1, 'initCmpSplit exists in the script');
  const end = code.indexOf('function renderCompare');
  assert.notEqual(end, -1, 'renderCompare still exists');
  const split = code.slice(start, start + 6000);
  assert.match(split, /type="range"/, 'the divider is a native range input');
  assert.match(split, /aria-valuetext/, 'the divider announces its position');
  assert.match(split, /setTransform\(/, 'the split canvas sets its own dpr transform');
});

test('every animation entry point asks REDUCED before it starts', () => {
  /* v4 §6 cross-cutting: "every new animation … must too, degrading to an
     instant transition". Checked structurally rather than by eye, because the
     failure mode is invisible to anyone whose own machine is not set to reduce
     motion — the animation simply runs, for someone else.

     Each of these is a function that STARTS a loop. The ones that merely
     continue one (`cityRunMorph`, `altRunZoom`) are deliberately not listed:
     they can only be reached through a starter that has already asked. */
  for (const name of ['cityMorphHeights', 'cityEnter', 'cityAnimateZoom', 'altBeginZoom', 'lapseStart']) {
    assert.match(guardWindow(name), /\bREDUCED\b/,
      `${name} checks REDUCED before its first return`);
  }
});

test('an animation that replaces state first asks whether frames will arrive', () => {
  /* A hidden tab does not run `requestAnimationFrame` at all.

     For an animation that only interpolates, that costs nothing — it simply
     does not play. For one that begins by REPLACING the thing it is animating,
     it is a defect with no symptom in the code. Two were found by driving the
     app in a background tab:

       - Disk City's entry sets every building's height to zero and lets the
         loop raise them, so with no frames the city stays permanently flat —
         and height is two of the three variables that view encodes. Measured:
         all 356 blocks at z = 0.
       - §6.2's level transition is worse, because `presentCells` sits out the
         hover ring, the budget borders and the keyboard cursor for as long as
         one is running. A transition that never ends suppresses all three for
         good — measured still running 2.6 s after the drill.

     `animateTreemapTo` and `animateSunburstTo` had guarded on this since they
     were written. These four had not. */
  for (const name of ['cityEnter', 'cityMorphHeights', 'cityAnimateZoom', 'altBeginZoom']) {
    assert.match(guardWindow(name), /document\.hidden/,
      `${name} refuses to animate when no frames will come`);
  }
  // And each loop lands on the real end state if the tab is hidden AFTER it
  // starts, which no entry check can cover.
  const code = appCode();
  const morph = code.indexOf('function cityRunMorph(');
  assert.match(code.slice(morph, morph + 700), /document\.hidden[\s\S]{0,120}cityFinishMorph/,
    'a height morph interrupted by a hidden tab lands on the real heights');
  const zoomLoop = code.indexOf('function altRunZoom(');
  assert.match(code.slice(zoomLoop, zoomLoop + 700), /document\.hidden[\s\S]{0,90}altZoom = null/,
    'a level transition interrupted by a hidden tab releases the overlays');
});

test('canvas overlays set the pixel-ratio transform, never inherit it', () => {
  /* Every `present*` function starts by blitting at the identity transform and
     then sets the device-pixel-ratio transform for the vector overlays. The
     trap is that each overlay above sets it INSIDE its own `if` — a hover ring,
     a budget border, a keyboard cursor — and all of them are optional. With
     none of them showing, §6.4's lens and §6.3's lasso inherited the identity
     and drew in device pixels while being handed CSS dimensions: half size, at
     half position.

     It survived every hand test, because a hand on a trackpad is hovering a
     cell, which sets the transform on the way past. It appears the moment the
     pointer is over a gap between cells, or the Lens is pinned and the pointer
     leaves the map. `cityHit` documents the same trap one function over — "the
     bug IS the device pixel ratio".

     So the assertion is on the ORDER and the NESTING: an unconditional
     `setTransform(dpr` at the function's own indentation, after the last
     optional overlay and before the lens. */
  for (const fn of ['presentTreemap', 'presentCells']) {
    const start = INDEX.indexOf(`function ${fn}(`);
    assert.notEqual(start, -1, `${fn} exists`);
    const end = INDEX.indexOf('\n}', start);
    const body = INDEX.slice(start, end);
    const lens = body.indexOf('lensPaint(');
    const lasso = body.indexOf('lassoPaint(');
    const overlay = lens === -1 ? lasso : (lasso === -1 ? lens : Math.min(lens, lasso));
    assert.notEqual(overlay, -1, `${fn} draws at least one canvas overlay`);
    // Two-space indent — a statement in the function body, not inside a branch.
    assert.match(body.slice(0, overlay), /\n  tmCtx\.setTransform\(dpr,/,
      `${fn} sets the DPR transform unconditionally before its overlays`);
  }
});

test('the alternate renderers announce what they had to approximate', () => {
  // §6.2 requires the footnote; §2.4 requires it to be visible rather than
  // logged. A live region, so a screen reader hears the caveat change when the
  // map does — and it is emphatically not a toast, because a caveat about what
  // is on screen has to stay up for as long as the screen does.
  assert.ok(INDEX.includes('id="tmAltNote"'), 'the footnote element exists');
  const el = INDEX.slice(INDEX.indexOf('id="tmAltNote"') - 120, INDEX.indexOf('id="tmAltNote"') + 120);
  assert.match(el, /role="status"/, 'the footnote is a status region');
  assert.match(el, /aria-live="polite"/, 'and it is announced when it changes');
});

test('all four map renderers are reachable, and each is a labelled control', () => {
  // §6.2: "selectable from a segmented control in the Treemap view — not new
  // views". So they must NOT be tabs, and must be here.
  for (const mode of ['treemap', 'sunburst', 'circles', 'voronoi']) {
    assert.ok(INDEX.includes(`data-vm="${mode}"`), `the ${mode} renderer has a control`);
    assert.ok(!INDEX.includes(`data-view="${mode === 'treemap' ? '\u0000' : mode}"`),
      `${mode} is a renderer, not a view`);
  }
  assert.ok(INDEX.includes('id="tmLensToggle"'), '§6.4 the magnifier has a pinnable control');
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

test('a pinned-open sidebar demotes to the rail below the breakpoint — the pin survives', () => {
  // QA item 8: with tm-sidenav=open persisted, a viewport below 900px left
  // the expanded panel permanently OVER the dimmed content. The pin is a
  // wide-viewport concept: narrow renders it as the rail, narrow toggles are
  // transient overlays, and widening restores what the user actually chose.
  const code = appCode();
  const side = code.slice(code.indexOf('const sideNavNarrow'), code.indexOf('function toast'));
  assert.ok(side.length > 400, 'the sidebar wiring slice is non-empty');
  // One number, TWO readers — so read it once and hold both to it. Asserting
  // only the JS side let the CSS overlay query drift to 760px with the suite
  // green: between 760 and 900 the JS believes it is narrow (demoting a
  // pinned sidebar, refusing to persist toggles) while the CSS still lays the
  // sidebar out as an in-flow column. That disagreement IS the QA-8 bug.
  const bp = /matchMedia\('\(max-width: (\d+)px\)'\)/.exec(side);
  assert.ok(bp, 'the JS names one breakpoint');
  const overlay = `@media (max-width: ${bp![1]}px) {`;
  const at = INDEX.indexOf(overlay);
  assert.notEqual(at, -1, `the stylesheet carries the same ${overlay} — one number, two readers`);
  let depth = 0, end = -1;
  for (let i = INDEX.indexOf('{', at); i < INDEX.length; i++) {
    if (INDEX[i] === '{') depth++;
    else if (INDEX[i] === '}' && --depth === 0) { end = i; break; }
  }
  const overlayBlock = INDEX.slice(at, end + 1);
  assert.match(overlayBlock, /#sideNav:not\(\.collapsed\) \{[^}]*position: fixed/,
    'and it is the rule that floats the expanded sidebar over the content');
  assert.match(overlayBlock, /#navScrim \{ opacity: 1/, 'with the scrim that dims what it covers');
  assert.match(side, /if \(!sideNavNarrow\.matches\) \{\s*try \{ localStorage\.setItem\('tm-sidenav'/,
    'only a wide-viewport choice persists — a narrow toggle or scrim tap never clobbers the pin');
  assert.match(side, /sideNavNarrow\.addEventListener\('change'/,
    'crossing the breakpoint re-applies the right state');
  assert.match(side, /if \(!\$\('sideNav'\)\.classList\.contains\('collapsed'\)\) applySideNav\(true\)/,
    'entering narrow demotes an open column to the rail');
  assert.match(side, /applySideNav\(sideNavPref\(\) === 'rail'\)/,
    'leaving narrow restores the pinned preference');
  assert.match(side, /applySideNav\(sideNavPref\(\) === 'rail' \|\| sideNavNarrow\.matches\)/,
    'boot honors the pin only at widths where the real column fits');
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

/**
 * The suggestion markup lives in `renderSmartGroups`, which v4 §3.3 split out
 * of `loadSmartSuggestions` so the Reclaim ordering can repaint without
 * re-fetching. The guarantees below are about the markup, so they follow it.
 */
function smartGroupsFn(code: string): string {
  const start = code.indexOf('function renderSmartGroups');
  assert.notEqual(start, -1, 'renderSmartGroups must be findable');
  const end = code.indexOf('async function loadSmartSuggestions', start);
  assert.notEqual(end, -1, 'renderSmartGroups must be followed by loadSmartSuggestions');
  const fn = code.slice(start, end);
  assert.ok(fn.length > 0, 'the renderSmartGroups slice must not be empty');
  return fn;
}

test('every suggestion group offers a "why is this suggested" affordance', () => {
  const code = appCode();
  const fn = smartGroupsFn(code);
  assert.match(fn, /class="icon-btn why-btn" data-why=/, 'each group gets a why control');
  assert.match(fn, /aria-expanded="false" aria-controls="smartWhy/, 'and it is announced as a disclosure');
  assert.match(fn, /What matched:/, 'the panel says what the rule matched');
  assert.match(fn, /confidenceWording\(g\.confidence, adv\)/, 'and states the rule pack confidence');
  assert.match(code, /function confidenceWording/, 'confidence is put into words, not shown as a bare level');
});

test('an advisory group is never offered for deletion', () => {
  const code = appCode();
  const fn = smartGroupsFn(code);
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
  // This one stays with the loader: it is about what happens to the FETCH,
  // and the fetch never reaches renderSmartGroups when the catalog is broken.
  const start = code.indexOf('async function loadSmartSuggestions');
  assert.notEqual(start, -1, 'loadSmartSuggestions must be findable');
  const fn = code.slice(start, code.indexOf("$('cleanFindBtn')", start));
  assert.ok(fn.length > 0, 'the loadSmartSuggestions slice must not be empty');
  assert.match(fn, /data\.available === false/, 'the unavailable state is handled');
  assert.match(fn, /Smart Suggestions are unavailable/, 'and named as unavailable, not as "nothing found"');
  assert.match(fn, /escapeHtml\(data\.reason/, 'carrying the specific reason from the server');
});

test('the rule-pack catalog states which packs produced the list, and when', () => {
  const code = appCode();
  assert.match(code, /function catalogNote/, 'provenance is rendered');
  const fn = code.slice(code.indexOf('function catalogNote'), code.indexOf('function renderSmartGroups'));
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

/* ══════════════ Drive health reports, never editorialises (§C4) ══════════════ */

test('the Drive Health card renders no verdict of its own', () => {
  const code = appCode();
  const fn = code.slice(code.indexOf('async function loadDriveHealth'), code.indexOf('/* ──────────────────────────── Security view'));
  assert.ok(fn.length > 0, 'loadDriveHealth must be findable');
  // The specific harm §C4 names: a false "your drive is dying".
  for (const word of ['failing', 'dying', 'imminent', 'replace your drive', 'healthy', 'Critical']) {
    assert.ok(!fn.includes(word), `the card must not say "${word}"`);
  }
  // The drive's own self-check is attributed to the drive.
  assert.match(fn, /The drive’s own self-check/, "the device's verdict is labelled as the device's");
  assert.match(fn, /reports passed/, 'and reported, not restated');
});

test('an unreadable drive shows the reason and how to fix it', () => {
  const code = appCode();
  const fn = code.slice(code.indexOf('async function loadDriveHealth'), code.indexOf('/* ──────────────────────────── Security view'));
  assert.match(fn, /!data\.available/, 'the unavailable state is handled');
  assert.match(fn, /dh-unknown/, 'and rendered as an explicit unknown');
  assert.match(fn, /escapeHtml\(data\.reason/, 'carrying the server’s reason, which names the install command');
});

/* ══════════════ Cost figures are dated, never fetched (§C1) ══════════════ */

test('the cost card always shows the date its prices were recorded', () => {
  const code = appCode();
  const fn = code.slice(code.indexOf('async function loadCostEstimate'), code.indexOf('/* ───────────────────────────── Drive Health'));
  assert.ok(fn.length > 0, 'loadCostEstimate must be findable');
  assert.match(fn, /Prices as of/, 'the "as of" date is on screen, not buried');
  assert.match(fn, /escapeHtml\(est\.asOf\)/);
  assert.match(fn, /never looks them up online/, 'and the reason it can go stale is stated');
});

test('a cleanup that does not change the plan is not sold as a saving', () => {
  const code = appCode();
  const fn = code.slice(code.indexOf('async function loadCostEstimate'), code.indexOf('/* ───────────────────────────── Drive Health'));
  assert.match(fn, /p\.monthlySavingUsd > 0/, 'a saving is only shown when there is one');
  assert.match(fn, /keeps you on the same plan/, 'and the no-saving case says so plainly');
  // The ≈ marker lives in the shared formatter, above loadCostEstimate.
  const money = code.slice(code.indexOf('function costMoney'), code.indexOf('async function loadCostEstimate'));
  assert.ok(money.length > 0, 'costMoney must be findable');
  assert.match(money, /est\.approximate \? '≈'/, 'converted figures are marked as approximations');
});

/* ══════════════ Re-encoding says what it costs (§C2) ══════════════ */

test('the video pane states that re-encoding is lossy and trashes the original', () => {
  const code = appCode();
  const fn = code.slice(code.indexOf('async function loadVideoCandidates'), code.indexOf('function confirmEncode'));
  assert.ok(fn.length > 0, 'loadVideoCandidates must be findable');
  assert.match(fn, /Re-encoding is lossy/, 'the irreversible half is said first');
  assert.match(fn, /Trash/, 'and where the original goes');
  assert.match(fn, /estimates/, 'and that the sizes are estimates');
  assert.match(fn, /!data\.available/, 'with the unavailable state handled');
});

test('the confirmation repeats the cost before anything runs', () => {
  const code = appCode();
  const fn = code.slice(code.indexOf('function confirmEncode'), code.indexOf('async function startEncode'));
  assert.ok(fn.length > 0, 'confirmEncode must be findable');
  assert.match(fn, /This is lossy/, 'the dialog does not soften it');
  assert.match(fn, /before<\/b> the original is moved to the Trash/s, 'and states the ordering guarantee');
  assert.match(fn, /left exactly as it is/, 'and what happens when a check fails');
  // The confirm flag is sent by startEncode, which the dialog calls.
  const start = code.slice(code.indexOf('async function startEncode'), code.indexOf('/* ── Empty Folders pane ── */'));
  assert.ok(start.length > 0, 'startEncode must be findable');
  assert.match(start, /confirm: true/, 'the endpoint is double-gated');
});

/* ══════════════ Shell integration is reversible from one place (§D2) ══════════════ */

test('the right-click entry is installed AND removed from the same control', () => {
  const code = appCode();
  const fn = code.slice(code.indexOf('async function renderShellIntegration'), code.indexOf('/* ───────────────────────────── Settings modal'));
  assert.ok(fn.length > 0, 'renderShellIntegration must be findable');
  // §D2: "an uninstall must not leave a dead context-menu entry behind".
  assert.match(fn, /Remove from right-click menu/, 'removal is offered');
  assert.match(fn, /Add to right-click menu/, 'and so is installation');
  assert.match(fn, /install: !data\.installed/, 'the one button toggles');
});

test('the button reflects what the OS really has, not what we asked for', () => {
  const code = appCode();
  const fn = code.slice(code.indexOf('async function renderShellIntegration'), code.indexOf('/* ───────────────────────────── Settings modal'));
  assert.match(fn, /await renderShellIntegration\(message\)/, 'the state is re-read after every action');
  assert.match(fn, /carryStatus/, 'and the confirmation survives that refresh');
  assert.match(fn, /!data\.supported/, 'a system with no file manager says so instead of offering a dead button');
});

/* ══════════════ A portable session says what it does (§D3) ══════════════ */

test('the portable screen names where it writes and what it never touches', () => {
  const code = appCode();
  const fn = code.slice(code.indexOf('function renderPortableScreen'), code.indexOf("/* ── Right-click menu (§D2)"));
  assert.ok(fn.length > 0, 'renderPortableScreen must be findable');
  assert.match(fn, /nothing is written to this computer/, 'the promise is stated up front');
  assert.match(fn, /Never touched/, 'and the host location is named');
  assert.match(fn, /p\.hostDataDir/, 'with the real path, not a description of it');
  assert.match(fn, /eject the drive/, 'and how the session ends');
});

test('a read-only portable drive is told plainly that nothing is saved', () => {
  const code = appCode();
  const fn = code.slice(code.indexOf('function renderPortableScreen'), code.indexOf("/* ── Right-click menu (§D2)"));
  assert.match(fn, /Nothing is saved/, 'the read-only case is not glossed');
  assert.match(fn, /p\.writable/, 'and it is driven by the real writability probe');
  assert.match(fn, /degraded/, 'the capabilities it loses are listed');
});

/* ══════════════ The fleet says what leaves this machine (§D1) ══════════════ */

test('the Fleet panel leads with what is shared and what never is', () => {
  const code = appCode();
  const fn = code.slice(code.indexOf('function renderFleet'), code.indexOf('async function setFleet'));
  assert.ok(fn.length > 0, 'renderFleet must be findable');
  // Read from the SERVER, so the promise on screen and the code that keeps it
  // cannot drift apart.
  assert.match(fn, /f\.shares/, 'what would be shared comes from the server');
  assert.match(fn, /f\.neverShares/, 'and so does what never can');
  assert.match(fn, /What other machines would see/);
  assert.match(fn, /What they can never see/);
});

test('an unpaired machine is shown as available to pair, never as connected', () => {
  const code = appCode();
  const fn = code.slice(code.indexOf('function renderFleet'), code.indexOf('async function setFleet'));
  assert.match(fn, /Available to pair/, '§D1’s exact requirement');
  assert.match(fn, /not paired — nothing is shared/, 'and the row says so');
  assert.match(fn, /!pairedIds\.has\(d\.instanceId\)/, 'paired machines are not listed twice');
});

test('the off state says plainly that nothing is being shared', () => {
  const code = appCode();
  const fn = code.slice(code.indexOf('function renderFleet'), code.indexOf('async function setFleet'));
  assert.match(fn, /is <b>off<\/b>/s, 'off is stated, not implied');
  // The sentence wraps inside the template literal, so match the claim rather
  // than a contiguous phrase (trap: never phrase-match template-built text).
  assert.match(fn, /announcing itself/, 'including that it is not advertising');
  assert.match(fn, /Nothing is being shared/);
});

/* ══════════════ Session restore (the app opens where it left off) ══════════════ */

test('boot restores the last scanned folder through the normal scan path', () => {
  const code = appCode();
  const start = code.indexOf('async function restoreLastSession');
  assert.ok(start !== -1, 'restoreLastSession must exist');
  const end = code.indexOf('void restoreLastSession()', start);
  assert.ok(end > start, 'and it must actually be invoked at boot');
  const fn = code.slice(start, end);
  assert.ok(fn.length > 0, 'restoreLastSession must be findable');
  assert.match(fn, /\/api\/scans/, 'history comes from the completed-scans endpoint');
  assert.match(fn, /\/api\/fs\/list\?path=/, 'a moved folder is pre-flighted, not errored at boot');
  assert.match(fn, /cloud:\/\//, 'cloud scans are never auto-restored');
  assert.match(fn, /state\.root \|\| state\.scanning/, 'a user action always wins the race');
  assert.match(fn, /startScan\(/, 'restore goes through the same path the Scan button takes');
});

/* ══════════════ Stopping a scan (the Scan button becomes Stop) ══════════════ */

test('the primary scan control is one button, in the Scan state at rest', () => {
  // Two buttons would mean one of them is always dead. The markup ships the
  // resting state; setScanButtonMode owns every change after boot.
  const buttons = [...INDEX.matchAll(/id="scanBtn"/g)];
  assert.equal(buttons.length, 1, 'exactly one scan control exists');
  assert.match(INDEX, /<button class="btn btn-primary" id="scanBtn"><span data-icon="play"><\/span>Scan<\/button>/,
    'and it starts as a primary Scan button');
});

test('a running scan turns the button into a red Stop, not a dead grey one', () => {
  const code = appCode();
  const start = code.indexOf('function setScanButtonMode');
  assert.ok(start !== -1, 'setScanButtonMode must exist');
  const end = code.indexOf('function cancelScanById', start);
  assert.ok(end > start, 'and cancelScanById must follow it');
  const fn = code.slice(start, end);
  assert.ok(fn.length > 100, 'the setScanButtonMode slice is non-empty');

  assert.match(fn, /classList\.toggle\('btn-danger', stop\)/, 'Stop is the danger style');
  assert.match(fn, /classList\.toggle\('btn-primary', !stop\)/, 'and Scan is not, at the same time');
  assert.match(fn, /btn\.disabled = false/, 'a disabled Stop could never be clicked');
  assert.match(fn, /icon\(stop \? 'stop' : 'play', 16\)/, 'the label is rebuilt through icon(), never a data-icon span');
  assert.match(fn, /aria-label/, 'and screen readers are told which action it is now');
});

test('the stop icon exists, so the button does not silently render a document', () => {
  // icon() falls back to PATHS.file for an unknown name — no error, no warning.
  // A typo here would ship a Stop button wearing a page icon.
  assert.match(appScript(), /\n {2}stop: '<rect /, 'PATHS carries a real stop glyph');
});

test('scanning chrome flips the button to Stop for background refreshes too', () => {
  const code = appCode();
  const start = code.indexOf('function beginScanChrome');
  assert.ok(start !== -1, 'beginScanChrome must exist');
  const end = code.indexOf('if (quiet)', start);
  assert.ok(end > start, 'the quiet branch marks the end of the shared preamble');
  const preamble = code.slice(start, end);
  assert.ok(preamble.length > 50, 'the preamble slice is non-empty');
  assert.match(preamble, /setScanButtonMode\('stop'\)/, 'a quiet whole-drive refresh is just as long, so it gets a Stop');
  assert.match(preamble, /state\.abortScan = null/, 'and the previous scan\'s stream handle never leaks into it');
});

test('the button returns to Scan from the one place a scan ever ends', () => {
  const code = appCode();
  const start = code.indexOf('function endScanChrome');
  assert.ok(start !== -1, 'endScanChrome must exist');
  const end = code.indexOf('function failScan', start);
  assert.ok(end > start, 'failScan must follow it');
  const fn = code.slice(start, end);
  assert.ok(fn.length > 50, 'the endScanChrome slice is non-empty');
  assert.match(fn, /setScanButtonMode\('scan'\)/, 'success and failure both restore the button');
  assert.match(fn, /state\.abortScan = null/, 'and release the finished scan\'s stream handle');
});

test('Stop severs the stream and the watchdog before it asks the server', () => {
  const code = appCode();
  const start = code.indexOf('async function stopScan');
  assert.ok(start !== -1, 'stopScan must exist');
  const end = code.indexOf('function skeletonRows', start);
  assert.ok(end > start, 'skeletonRows must follow it');
  const fn = code.slice(start, end);
  assert.ok(fn.length > 200, 'the stopScan slice is non-empty');

  const abortAt = fn.indexOf('state.abortScan()');
  const postAt = fn.indexOf('cancelScanById(scanId)');
  assert.ok(abortAt !== -1, 'the watchdog is settled');
  assert.ok(fn.indexOf('closeEventSource()') !== -1, 'and the stream is closed');
  assert.ok(postAt > abortAt, 'both happen BEFORE the request, so nothing in flight can repaint after it');
});

test('cancellation has exactly one route to the server', () => {
  // Both callers — Stop, and startScanRequest honouring a Stop that beat the
  // scan request — go through this, so the endpoint is pinned in one place.
  const code = appCode();
  const start = code.indexOf('function cancelScanById');
  assert.ok(start !== -1, 'cancelScanById must exist');
  const end = code.indexOf('async function stopScan', start);
  assert.ok(end > start, 'stopScan must follow it');
  const fn = code.slice(start, end);
  assert.ok(fn.length > 50, 'the cancelScanById slice is non-empty');
  assert.match(fn, /\/api\/scan\/\$\{scanId\}\/cancel/, 'the cancel goes to the scan cancel endpoint');
  assert.match(fn, /method: 'POST'/, 'as a POST');
});

test('a stopped scan reads as a choice, not as a failure', () => {
  const code = appCode();
  const start = code.indexOf('async function stopScan');
  const end = code.indexOf('function skeletonRows', start);
  const fn = code.slice(start, end);
  assert.ok(fn.length > 200, 'the stopScan slice is non-empty');
  assert.match(fn, /Scan stopped by user/, 'the status says exactly what happened');
  assert.match(fn, /status\.classList\.remove\('error'\)/, 'and it is not painted as an error');
  assert.ok(!/toast\([^)]*'error'/.test(fn), 'stopping never raises an error toast');
});

test('a stopped scan does not leave the dashboard showing skeletons forever', () => {
  // beginScanChrome swaps three dashboard panels for skeletons, and a stopped
  // scan never fills them. The dashboard's own mount() is a no-op, so
  // switchView cannot repaint them — this is why the restore is explicit.
  const code = appCode();
  const start = code.indexOf('function restoreDashboardPanels');
  assert.ok(start !== -1, 'restoreDashboardPanels must exist');
  const end = code.indexOf('function cancelScanById', start);
  assert.ok(end > start, 'cancelScanById must follow it');
  const fn = code.slice(start, end);
  assert.ok(fn.length > 150, 'the restoreDashboardPanels slice is non-empty');

  // Repaint what we still have; say so honestly only where we have nothing.
  assert.match(fn, /state\.largest\.length\) renderBigFiles\(\)/, 'held data is repainted, not thrown away');
  assert.match(fn, /state\.bigFolders\.length\) renderBigFolders\(\)/);
  assert.match(fn, /state\.types\.length\) \{ state\.donut\.animated = false; renderDonut\(\)/);
  assert.match(fn, /Run a scan to find your biggest files/, 'and an empty panel says why it is empty');

  // Both non-completion paths must use it — a stop and a failure leave the
  // dashboard in exactly the same half-painted state.
  const stop = code.slice(code.indexOf('async function stopScan'), code.indexOf('function skeletonRows'));
  assert.ok(stop.length > 200, 'the stopScan slice is non-empty');
  assert.match(stop, /restoreDashboardPanels\(\)/, 'Stop restores the panels');
  assert.match(stop, /switchView\(state\.view\)/, 'and puts the never-scanned empty state back');

  const failStart = code.indexOf('function failScan');
  const fail = code.slice(failStart, code.indexOf('function statsFromResult', failStart));
  assert.ok(fail.length > 100, 'the failScan slice is non-empty');
  assert.match(fail, /restoreDashboardPanels\(\)/, 'and a failed scan restores them the same way');
});

test('a cancel the server refuses is reported, never swallowed into a false "stopped"', () => {
  const code = appCode();
  const start = code.indexOf('async function stopScan');
  const end = code.indexOf('function skeletonRows', start);
  const fn = code.slice(start, end);
  assert.ok(fn.length > 200, 'the stopScan slice is non-empty');
  assert.match(fn, /catch \(e\)/, 'the request is awaited and its failure handled');
  assert.match(fn, /e\.status !== 404/, '404 means the record was already gone — that IS stopped');
  assert.match(fn, /Could not stop the scan/, 'anything else says the scan is still running');
});

test('Stop pressed before the scan request answers still cancels that scan', () => {
  // There is no scanId until the scan request returns, so the click can only
  // stop the chrome. The request has to honour it when it lands, or the walk
  // runs on server-side with nothing watching it — and worse, the stream would
  // repoint state.scanId and resurrect a scan the user already ended.
  const code = appCode();
  const start = code.indexOf('function abandonIfStopped');
  assert.ok(start !== -1, 'abandonIfStopped must exist');
  const end = code.indexOf('async function stopScan', start);
  assert.ok(end > start, 'stopScan must follow it');
  const fn = code.slice(start, end);
  assert.ok(fn.length > 80, 'the abandonIfStopped slice is non-empty');
  assert.match(fn, /cancelScanById\(scanId\)/, 'the orphan is cancelled');
  // The generation check is the part that is easy to lose. state.scanning
  // describes whichever scan is running NOW — so after Stop-then-Scan-again,
  // a bare flag check would let the FIRST request's reply be followed, leaving
  // two live streams and a state.scanId belonging to the abandoned scan.
  assert.match(fn, /state\.scanning && state\.scanGen === gen/, 'a superseded reply is abandoned too, not just a stopped one');
});

test('every scan request carries the generation it was started in', () => {
  const code = appCode();
  const begin = code.slice(code.indexOf('function beginScanChrome'), code.indexOf('if (quiet)'));
  assert.ok(begin.length > 50, 'the beginScanChrome slice is non-empty');
  assert.match(begin, /state\.scanGen\+\+/, 'starting a scan mints a new generation');

  for (const [name, anchor, endAnchor] of [
    ['disk', 'async function startScanRequest', 'function followScanProgress'],
    ['cloud', 'async function startCloudScan', 'function endScanChrome'],
  ] as const) {
    const start = code.indexOf(anchor);
    assert.ok(start !== -1, `${anchor} must exist`);
    const end = code.indexOf(endAnchor, start);
    assert.ok(end > start, `${endAnchor} must follow ${anchor}`);
    const fn = code.slice(start, end);
    assert.ok(fn.length > 200, `the ${name} slice is non-empty`);
    const captureAt = fn.indexOf('const gen = state.scanGen');
    const awaitAt = fn.indexOf('await api(');
    assert.ok(captureAt !== -1, `the ${name} path captures its generation`);
    assert.ok(awaitAt > captureAt, `and captures it BEFORE awaiting, or it would read the wrong one`);
  }
});

test('BOTH scan entry points honour a Stop that beat their request', () => {
  // startScanRequest and startCloudScan have the same await-then-follow shape.
  // The disk path guarding while the cloud path silently did not is exactly the
  // asymmetry this pins: a cloud Stop would resurrect itself.
  const code = appCode();

  const diskStart = code.indexOf('async function startScanRequest');
  assert.ok(diskStart !== -1, 'startScanRequest must exist');
  const diskEnd = code.indexOf('function followScanProgress', diskStart);
  assert.ok(diskEnd > diskStart, 'followScanProgress must follow it');
  const disk = code.slice(diskStart, diskEnd);
  assert.ok(disk.length > 200, 'the startScanRequest slice is non-empty');

  const cloudStart = code.indexOf('async function startCloudScan');
  assert.ok(cloudStart !== -1, 'startCloudScan must exist');
  const cloudEnd = code.indexOf('function endScanChrome', cloudStart);
  assert.ok(cloudEnd > cloudStart, 'endScanChrome must follow it');
  const cloud = code.slice(cloudStart, cloudEnd);
  assert.ok(cloud.length > 200, 'the startCloudScan slice is non-empty');

  for (const [name, fn] of [['disk', disk], ['cloud', cloud]] as const) {
    const guardAt = fn.indexOf('abandonIfStopped(resp.scanId, gen)');
    const followAt = fn.indexOf('followScanProgress(resp.scanId');
    assert.ok(guardAt !== -1, `the ${name} scan path must check for a Stop that beat its request`);
    assert.ok(followAt > guardAt, `and the ${name} path must check BEFORE it opens a stream`);
  }
});

test('Stop cancels the scan that is actually streaming, never the previous one', () => {
  // state.scanId is assigned only by followScanProgress, so during a quiet
  // background refresh it still holds the PREVIOUS scan's id. Cancelling on
  // state.scanId alone would stop the wrong scan.
  const code = appCode();
  const start = code.indexOf('async function stopScan');
  const end = code.indexOf('function skeletonRows', start);
  const fn = code.slice(start, end);
  assert.ok(fn.length > 200, 'the stopScan slice is non-empty');
  assert.match(fn, /state\.abortScan \? state\.scanId : null/, 'the stream handle is what proves the id is current');
});

test('followScanProgress hands Stop the closure only it can settle', () => {
  const code = appCode();
  const start = code.indexOf('function followScanProgress');
  assert.ok(start !== -1, 'followScanProgress must exist');
  const end = code.indexOf('async function startCloudScan', start);
  assert.ok(end > start, 'startCloudScan must follow it');
  const fn = code.slice(start, end);
  assert.ok(fn.length > 500, 'the followScanProgress slice is non-empty');
  assert.match(fn, /state\.abortScan = \(\) =>/, 'the handle is published');
  assert.match(fn, /finished = true; clearInterval\(watchdog\)/, 'and it settles both the frame gate and the watchdog');
});

test('the scan button routes to Stop mid-scan, and Enter never does', () => {
  const code = appCode();
  const start = code.indexOf("$('scanBtn').addEventListener('click'");
  assert.ok(start !== -1, 'the scan button has a click listener');
  const end = code.indexOf("$('pathInput').addEventListener('input'", start);
  assert.ok(end > start, 'the input listener follows it');
  const fn = code.slice(start, end);
  assert.ok(fn.length > 100, 'the listener slice is non-empty');

  assert.match(fn, /if \(state\.scanning\) \{ void stopScan\(\); return; \}/, 'clicking mid-scan stops it');
  // Enter used to be safe only because the button was disabled. Now that the
  // button is Stop, an unguarded Enter in the path field would cancel the scan.
  assert.match(fn, /e\.key === 'Enter' && !state\.scanning/, 'Enter starts a scan and only ever starts one');
});

test('an embedder can name the folder to scan, and it beats session restore', () => {
  // The VS Code extension frames this page in a webview, which is cross-origin
  // to it and so cannot script it. `?path=` is the only channel there is.
  const code = appCode();
  const start = code.indexOf('function requestedPath');
  assert.ok(start !== -1, 'requestedPath must exist');
  const end = code.indexOf('async function restoreLastSession', start);
  assert.ok(end > start, 'restoreLastSession must follow it');
  const fn = code.slice(start, end);
  assert.ok(fn.length > 60, 'the requestedPath slice is non-empty');
  assert.match(fn, /new URLSearchParams\(location\.search\)/, 'it reads the query string');
  assert.match(fn, /get\('path'\)/);

  const restoreStart = code.indexOf('async function restoreLastSession');
  const restoreEnd = code.indexOf('void restoreLastSession()', restoreStart);
  assert.ok(restoreEnd > restoreStart, 'restoreLastSession must be invoked at boot');
  const restore = code.slice(restoreStart, restoreEnd);
  assert.ok(restore.length > 200, 'the restoreLastSession slice is non-empty');

  const wantedAt = restore.indexOf('requestedPath()');
  const historyAt = restore.indexOf('/api/scans');
  assert.ok(wantedAt !== -1, 'restore consults the requested path');
  assert.ok(
    historyAt > wantedAt,
    'and does so BEFORE reading history — someone who named a folder did not ask for the last one',
  );
  assert.match(restore, /startScan\(wanted\)/, 'the request goes through the same path the Scan button takes');
  assert.match(restore, /!state\.root && !state\.scanning/, 'and still loses to a user who got there first');
});

test('the click is answered before the index probe, not after it', () => {
  // startScan asks the server whether the folder is indexed, and then may fetch
  // the whole indexed tree — measured at 400ms for the index probe alone on a
  // large root. Doing that before any UI change left the button reading "Scan"
  // with no spinner for the whole time, which reads as a missed click.
  const code = appCode();
  const start = code.indexOf('async function startScan(path');
  assert.ok(start !== -1, 'startScan must exist');
  const end = code.indexOf('async function startScanRequest', start);
  assert.ok(end > start, 'startScanRequest must follow it');
  const fn = code.slice(start, end);
  assert.ok(fn.length > 200, 'the startScan slice is non-empty');

  const chromeAt = fn.indexOf('beginScanChrome(');
  const probeAt = fn.indexOf('indexStatusFor(path)');
  assert.ok(chromeAt !== -1, 'startScan shows the scanning chrome itself');
  assert.ok(probeAt !== -1, 'and it probes the index');
  assert.ok(chromeAt < probeAt, 'the chrome must come FIRST — that is the whole fix');
  assert.match(fn, /message: 'Starting scan…'/, 'and it says what it is doing');
});

test('a tree painted from the index does not borrow another scan’s id', () => {
  // The index cannot grant a scanId. The one left in state belongs to a
  // different scan — possibly of another folder, possibly one the user just
  // stopped, which answers 500 SCAN_FAILED to every scanId-keyed endpoint.
  // finishScan would then fire three of those AND open a live-watch
  // EventSource on it, which reconnects on failure — a request storm against a
  // rate-limited server, immediately after every Stop-then-rescan.
  const code = appCode();
  const start = code.indexOf('async function openFromIndex');
  assert.ok(start !== -1, 'openFromIndex must exist');
  const end = code.indexOf('async function startScan(path', start);
  assert.ok(end > start, 'startScan must follow it');
  const fn = code.slice(start, end);
  assert.ok(fn.length > 200, 'the openFromIndex slice is non-empty');

  const clearAt = fn.indexOf('state.scanId = null');
  const finishAt = fn.indexOf('finishScan(');
  assert.ok(clearAt !== -1, 'the stale id is cleared');
  assert.ok(finishAt > clearAt, 'and cleared BEFORE finishScan runs on it');
});

test('finishScan does no scanId-keyed work when there is no scanId', () => {
  const code = appCode();
  const start = code.indexOf('async function finishScan');
  assert.ok(start !== -1, 'finishScan must exist');
  const end = code.indexOf('function renderBigFiles', start);
  assert.ok(end > start, 'renderBigFiles must follow it');
  const fn = code.slice(start, end);
  assert.ok(fn.length > 500, 'the finishScan slice is non-empty');

  const guardAt = fn.indexOf('if (!state.scanId) {');
  const listAt = fn.indexOf('/api/large-files?scanId=');
  assert.ok(guardAt !== -1, 'there is a no-scanId branch');
  assert.ok(listAt > guardAt, 'and it returns before the scanId-keyed calls');
  // The panels must not claim the folder is empty — it plainly is not.
  const branch = fn.slice(guardAt, listAt);
  assert.match(branch, /showListsPending\(\)/, 'the panels show loading, not "No files found."');
  assert.match(branch, /emit\(TOPIC\.scan, null\)/, 'views are told there is no scan yet');
});

/* ══════════════ Reclaim Score in the UI (v4 §3.2, §3.3) ══════════════ */

/**
 * §3.2 lists four rules the frontend has to keep, and each is a way the score
 * could quietly become an oracle:
 *
 *   - it is never displayed as a bare number;
 *   - a component that could not be computed is named, never counted as zero;
 *   - the weights are editable, with a reset;
 *   - nothing is ever auto-selected.
 *
 * They are asserted structurally because all four are invisible in a
 * screenshot: a score with a missing signal looks exactly like a score
 * without one until you read what produced it.
 */

test('a reclaim score is never rendered as a bare number', () => {
  const code = appCode();
  // Every score reaches the DOM through reclaimBadge, and that badge is a
  // button carrying the path its breakdown needs.
  assert.match(code, /function reclaimBadge\(path, fact\)/, 'one place builds every badge');
  const start = code.indexOf('function reclaimBadge');
  const fn = code.slice(start, code.indexOf('function reclaimWhyHtml', start));
  assert.ok(fn.length > 100, 'the reclaimBadge slice is non-empty');
  assert.match(fn, /<button type="button" class="rc-badge/, 'the badge is a control, not a label');
  assert.match(fn, /data-rc-why="\$\{escapeHtml\(path\)\}"/, 'and carries the path its breakdown needs');
  assert.match(fn, /aria-label="Reclaim score \$\{fact\.score\} out of 100/, 'and announces itself in full');
  // Confidence is never a letter glued to the number. Every other figure on
  // the same row is a byte count, so "66.4M" reads as 66.4 megabytes — the
  // wrong reading by default, not a subtle ambiguity.
  assert.match(fn, /const approx = fact\.confidence === 'high' \? '' : '~';/, 'uncertainty reads as "approximately"');
  assert.ok(!/rc-conf/.test(code), 'no confidence initial is rendered anywhere');

  // The tooltip is the one surface that shows a score without being a
  // button — a canvas cell has nothing to click. §3.2 still applies to it, so
  // it has to name the way to the reasoning rather than ending at a number.
  const tip = code.slice(code.indexOf('function reclaimTooltipLine'), code.indexOf('function hideTooltip'));
  assert.ok(tip.length > 200, 'the reclaimTooltipLine slice is non-empty');
  assert.match(tip, /right-click for the breakdown/, 'the tooltip points at its own reasoning');
  assert.match(tip, /fact\.missing\.length/, 'and says how many signals were unknown');
  // And the right-click menu it names actually opens that breakdown.
  assert.match(code, /data-act="score"/, 'the context menu offers the breakdown');
  assert.match(code, /if \(act === 'score'\)[^\n]*openReclaimWhy/, 'and wires it to the panel');
});

test('the breakdown names every component that could NOT be computed', () => {
  const code = appCode();
  const start = code.indexOf('function reclaimWhyHtml');
  assert.notEqual(start, -1, 'reclaimWhyHtml must exist');
  const fn = code.slice(start, code.indexOf('const RC_LABELS', start));
  assert.ok(fn.length > 200, 'the reclaimWhyHtml slice is non-empty');
  assert.match(fn, /fact\.missing\.length/, 'the missing list is rendered, not dropped');
  assert.match(fn, /escapeHtml\(m\.reason\)/, 'each carries its own reason, escaped');
  assert.match(fn, /not counted/, 'and is labelled as excluded rather than as zero');
  assert.match(fn, /never counted as zero/, 'the panel says so in words too');
  // §3.2: the score sorts and explains; it never selects.
  assert.match(fn, /never selects anything for deletion/, 'and states that it selects nothing');
});

test('an unscored path is distinguishable from a zero everywhere it appears', () => {
  const code = appCode();
  // The three-state map is the mechanism: absent / null / fact.
  assert.match(code, /function scoreFor\(path\)/, 'scoreFor exists');
  assert.match(code, /return hit === null \? undefined : hit;/, 'null (asked, unanswerable) never reads as a fact');
  assert.match(code, /function scoreKnown\(path\)/, 'and "asked" is separately answerable');
  // The treemap paints unscored cells outside the colour ramp.
  assert.match(code, /const C_RC_UNSCORED/, 'unscored has its own colour');
  const cell = code.slice(code.indexOf('function cellRgb'), code.indexOf('function cellRgb') + 700);
  assert.match(cell, /fact \? reclaimRgb\(fact\.score\) : C_RC_UNSCORED/, 'and it is used rather than the ramp floor');
});

test('sorting by reclaim puts unscored entries last, never at zero', () => {
  const code = appCode();
  const start = code.indexOf('function byReclaimDesc');
  assert.notEqual(start, -1, 'byReclaimDesc must exist');
  const fn = code.slice(start, start + 600);
  assert.match(fn, /if \(fa\) return -1;/, 'a scored entry outranks an unscored one');
  assert.match(fn, /if \(fb\) return 1;/, 'in both directions');
  // Everything that offers the order uses the one comparator.
  assert.match(code, /items\.sort\(byReclaimDesc/, 'the grid uses it');
  assert.match(code, /\.sort\(byReclaimDesc\(\(f\) => f\.path\)\)/, 'the dashboard list uses it');
  assert.match(code, /pairs\.sort\(byReclaimDesc/, 'Clean Up uses it');
});

test('re-ordering Clean Up cannot tick the wrong file', () => {
  const code = appCode();
  const start = code.indexOf('function smartItemsOf');
  assert.notEqual(start, -1, 'smartItemsOf must exist');
  const fn = code.slice(start, start + 500);
  // The checkbox's data-i is read back as smartGroups[g].items[i] by
  // updateCleanSummary, which decides what gets trashed. A re-ordered list
  // rendered with positional indices would select a different file than the
  // row the user ticked.
  assert.match(fn, /g\.items\.map\(\(it, i\) => \(\{ it, i \}\)\)/, 'each item keeps its index in g.items');
  assert.match(code, /smartItemsOf\(g\)\.map\(\(\{ it, i \}\) =>/, 'and the markup renders that index, not the position');
  assert.match(code, /class="smart-ck" data-g="\$\{gi\}" data-i="\$\{i\}"/, 'onto the checkbox');
});

test('the weights are editable, resettable, and the reset comes from the server', () => {
  const code = appCode();
  assert.match(code, /const RECLAIM_WEIGHT_ROWS/, 'the six weights are listed');
  assert.match(code, /function renderReclaimWeights/, 'and rendered as controls');
  assert.match(code, /function collectReclaimWeights/, 'and read back on save');
  assert.ok(INDEX.includes('id="reclaimResetBtn"'), 'there is a reset control');
  const reset = code.slice(code.indexOf("$('reclaimResetBtn')"), code.indexOf("$('reclaimResetBtn')") + 800);
  // Sending null asks the server's own normalizer for the defaults, so the
  // numbers exist in exactly one place and the button cannot drift from them.
  assert.match(reset, /reclaimWeights: null/, 'reset asks the server for its defaults');
  assert.match(reset, /reclaimReset\(\)/, 'and drops scores computed under the old weights');
});

test('changing the weights invalidates the cached scores', () => {
  const code = appCode();
  // The window covers the whole save handler; Phase 9 grew it (the
  // human-scale toggle rides the same PUT), so the slice is sized for the
  // handler it guards, not the one it was written against.
  const save = code.slice(code.indexOf("$('settingsSaveBtn')"), code.indexOf("$('settingsSaveBtn')") + 3000);
  assert.match(save, /reclaimWeights/, 'the weights are saved');
  assert.match(save, /reclaimReset\(\)/, 'and the cache is dropped, or old numbers sit beside new sliders');
});

test('a new scan drops every score, since they describe the previous tree', () => {
  const code = appCode();
  assert.match(code, /subscribe\(TOPIC\.scan, reclaimReset\)/, 'scores die with their scan');
  const fn = code.slice(code.indexOf('function reclaimReset'), code.indexOf('function scoreFor'));
  assert.match(fn, /reclaim\.scores\.clear\(\)/);
  assert.match(fn, /reclaim\.pending\.clear\(\)/, 'including anything in flight');
});

test('a score request that outlives its scan is discarded, not misfiled', () => {
  const code = appCode();
  const start = code.indexOf('async function ensureScores');
  const fn = code.slice(start, code.indexOf('function reclaimConfidenceWording', start));
  assert.ok(fn.length > 400, 'the ensureScores slice is non-empty');
  assert.match(fn, /if \(state\.scanId !== scanAtRequest\) return;/,
    'a scan that changed mid-flight must not have the previous tree’s verdicts filed against it');
  // The three-state contract: absent from `values` is recorded as null.
  assert.match(fn, /hasOwnProperty\.call\(values, p\) \? values\[p\] : null/,
    'a path the server could not score is remembered as null, not invented as 0');
  // The no-op return is what stops drawView -> fetchScoresForTreemap ->
  // ensureScores -> repaint -> drawView recursing forever once every visible
  // cell is already scored. Anchored on the code, not on the comment beside
  // it: appCode() strips comments.
  assert.match(fn, /if \(!wanted\.length\) return;/, 'a request with nothing to fetch fires no callback');
});

test('the reclaim colour mode has a legend that names the unscored band', () => {
  const code = appCode();
  const start = code.indexOf('function renderTmLegend');
  const fn = code.slice(start, code.indexOf('function treemapCanvasHeight', start));
  assert.ok(fn.length > 200, 'the renderTmLegend slice is non-empty');
  assert.match(fn, /colorMode === 'reclaim'/, 'the mode has its own legend');
  assert.match(fn, /not scored/, 'and the unscored band is named rather than left to be guessed');
  assert.match(fn, /rc-legend-note/, '§3.3 asks for a one-line explanation of what the colours mean');
  assert.match(fn, /reclaimCoverageNote\(\)/, 'and the legend states its own coverage');
});

test('a partly-scored map says how much of it is scored', () => {
  const code = appCode();
  const start = code.indexOf('function reclaimCoverageNote');
  assert.notEqual(start, -1, 'reclaimCoverageNote must exist');
  const fn = code.slice(start, code.indexOf('function treemapCanvasHeight', start));
  assert.ok(fn.length > 300, 'the coverage slice is non-empty');
  // §2.4: partial is stated, not hidden. Everything unscored paints the same
  // grey, so without this a cell TreeMap could not score is indistinguishable
  // from one it has not reached — 2,716 of 4,717 on a real repository.
  assert.match(fn, /Scored \$\{formatCount\(scored\)\} of \$\{formatCount\(total\)\}/, 'the count is stated, not implied');
  assert.match(fn, /could not be scored/, 'and genuinely unscorable cells are named separately');
  assert.match(fn, /drill in to score the rest/, 'a cap names what would lift it');
  // Silent when there is nothing to say — a line on every map is the noise
  // that stops the one that matters from being read.
  assert.match(fn, /scored \+ unscorable >= total/, 'a fully-scored map says nothing');
  assert.match(code, /const TM_SCORE_CAP/, 'the ceiling is a named constant, not a literal');
});

test('the score is reachable from the keyboard and returns focus', () => {
  const code = appCode();
  const fn = code.slice(code.indexOf('function openReclaimWhy'), code.indexOf('// One delegated listener'));
  assert.ok(fn.length > 400, 'the popover slice is non-empty');
  assert.match(fn, /\$\('rcPopClose'\)\.focus\(\)/, 'opening moves focus into the panel');
  assert.match(fn, /opener\.focus\(\); return;/, 'and closing puts it back where it came from');
  // Every list carrying these badges is rebuilt by innerHTML when the scores
  // land, so the button that opened the panel is usually gone by the time it
  // closes. Holding the element dropped focus to <body> — verified in the
  // real app before this was written. The path survives the repaint.
  assert.match(fn, /data-rc-why="\$\{escaped\}"/, 'the badge is re-found by path after a repaint');
  assert.match(fn, /CSS\.escape\(path\)/, 'and the path is escaped before it becomes a selector');
  assert.match(code, /e\.key === 'Escape' && !\$\('rcPopover'\)\.hidden/, 'Escape closes it');
  // position:fixed coordinates are viewport-relative while the anchor's rect
  // is wherever that row sits. Without a clamp, a badge below the fold put
  // the panel at y=2227 in an 820px window — open, populated, invisible.
  assert.match(fn, /Math\.max\(10, Math\.min\(preferred, maxTop\)\)/, 'the panel is clamped into the viewport vertically');
  assert.match(fn, /Math\.max\(10, Math\.min\(r\.left, window\.innerWidth - w - 10\)\)/, 'and horizontally');
  assert.ok(INDEX.includes('aria-label="Close the score breakdown"'), 'the close control is labelled');
});

/* ══════════ A view takes back every listener it puts down (§4.3) ══════════ */

/**
 * Slice out the body of `name() { … }` starting at `from`, by matching braces.
 *
 * Deliberately brace-matching rather than a regex: these bodies contain object
 * literals, arrow functions and template strings, and a non-greedy `\}` finds
 * the first of those instead of the end of the method.
 */
function methodBody(code: string, name: string, from: number): { body: string; end: number } | null {
  const at = code.indexOf(`${name}() {`, from);
  if (at === -1) return null;
  const open = code.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === '{') depth++;
    else if (code[i] === '}') {
      depth--;
      if (depth === 0) return { body: code.slice(open + 1, i), end: i };
    }
  }
  return null;
}

/** Every `mount()`/`unmount()` pair in the view registry, in file order. */
function viewLifecycles(): { mount: string; unmount: string; at: number }[] {
  const code = appCode();
  const out: { mount: string; unmount: string; at: number }[] = [];
  let from = 0;
  for (;;) {
    const mount = methodBody(code, 'mount', from);
    if (!mount) break;
    const unmount = methodBody(code, 'unmount', mount.end);
    if (!unmount) break;
    out.push({ mount: mount.body, unmount: unmount.body, at: mount.end });
    from = unmount.end;
  }
  return out;
}

test('a view that adds a listener on mount takes it off on unmount', () => {
  // The registry's whole reason for existing, and the one rule it could not
  // enforce from inside itself. Disk City is the only view that binds in
  // `mount()`, and it shipped with `pointerleave` added on every visit and
  // removed by nothing — measured going from one handler to four across three
  // visits to the tab. Every call was harmless and the total was unbounded,
  // which is exactly how a leak of this shape survives review.
  //
  // The canvases are static markup, so they outlive every mount; there is no
  // element teardown to launder a missed removal.
  const lifecycles = viewLifecycles();
  assert.ok(lifecycles.length > 0, 'the registry must have at least one mount/unmount pair to check');
  for (const { mount, unmount } of lifecycles) {
    const added = [...mount.matchAll(/addEventListener\('([a-z]+)'\s*,\s*([^,)]+)/g)];
    for (const [, event, handler] of added) {
      const name = handler.trim();
      // An inline closure cannot be passed to removeEventListener at all, so
      // this is not a style rule: an anonymous handler is unremovable by
      // construction, and the assertion below could never pass for one.
      assert.match(
        name,
        /^[A-Za-z_$][\w$]*$/,
        `the "${event}" listener must be a named function so unmount can take it off, not ${name}`,
      );
      assert.ok(
        unmount.includes(`removeEventListener('${event}', ${name})`),
        `unmount must removeEventListener('${event}', ${name})`,
      );
    }
  }
});

/* ══════════════ the treemap status line counts honestly ══════════════ */

/**
 * `updateTmStatus` really evaluated, so what is asserted is the sentence the
 * user reads. Its collaborators are stubbed to the smallest things that behave
 * like the originals.
 */
function runTmStatus(treemap: Record<string, unknown>): string {
  const code = appScript();
  const start = code.indexOf('function updateTmStatus()');
  assert.notEqual(start, -1, 'updateTmStatus exists');
  const end = code.indexOf('\n}', code.indexOf('nodes ·', start)) + 2;
  assert.ok(end > start, 'updateTmStatus closes');
  const src = code.slice(start, end);
  let written = '';
  const $ = (id: string) => (id === 'tmStatus'
    ? { set textContent(v: string) { written = v; } }
    : { textContent: '' });
  const make = new Function(
    '$', 'state', 'formatCount', 'formatBytes', 'tmPreview', 'isSun', 'isCells',
    `${src}; return updateTmStatus;`,
  );
  make(
    $,
    { treemap: { query: '', matches: 0, matchTotal: null, queryMode: 'bare', rootSize: 0, nodes: [], pxRects: [], history: { active: false }, ...treemap } },
    (n: number) => String(n),
    (n: number) => `${n} B`,
    { on: false },
    () => false,
    () => false,
  )();
  return written;
}

/**
 * The map draws what fits at the current folder and depth; the grammar query
 * is answered over the whole scan. So "1 match for “size>1gb”" stood above a
 * message reading "2 matches — 1 shown here": two numbers for one query, and
 * the prominent one was the wrong one. The status line owes the same
 * arithmetic the message beside it already tells the truth about.
 *
 * A bare word has no server total to compare against — the local filter IS
 * the answer there — so that sentence must stay exactly as it was.
 */
test('a grammar query whose matches outrun the map says so in the status line', () => {
  const partial = runTmStatus({ query: 'size>1gb', queryMode: 'grammar', matches: 1, matchTotal: 2, rootSize: 5 });
  assert.match(partial, /1 of 2 matches for “size>1gb”/,
    'the drawn count is named as a share of what the query actually matched');

  const all = runTmStatus({ query: 'size>1gb', queryMode: 'grammar', matches: 2, matchTotal: 2, rootSize: 5 });
  assert.match(all, /^2 matches for “size>1gb”/,
    'nothing to disclose when the map drew them all — no "2 of 2"');

  const bare = runTmStatus({ query: 'openapi', queryMode: 'bare', matches: 3, matchTotal: null, rootSize: 5 });
  assert.match(bare, /^3 matches for “openapi”/,
    'the local filter is the whole answer for a bare word');
});
