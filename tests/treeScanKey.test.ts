import { test } from 'node:test';
import assert from 'node:assert/strict';

import { INDEX } from './fixtures/liftFrontend';

/**
 * Every page request about the tree on screen names the scan that tree came
 * from — never the scan running behind it (the owner, 20 Oct 2026: "I want
 * all errors fixed"; BQJ-1b).
 *
 * While a scan runs, its id is on hand once its request answers
 * (followScanProgress), but the tree on screen is still the one before it:
 * an older scan's (settledScanId), or the saved index's (none). A scan still
 * walking answers nothing about a tree — 202, 409 SCAN_RUNNING, or every path
 * "unavailable" — so a view that asked it said a server error, or nothing,
 * over a tree it could have described, and after a Stop showed another
 * folder's data. Three review rounds of BQJ-1 each found more views asking
 * the running scan, each with its own copy of the rule. Here the rule has one
 * home, `treeScanId()`, and each view is held to it:
 *
 *  - during a rescan over an older scan's tree, the request names that scan;
 *  - once the rescan lands, the new scan;
 *  - after a Stop, the older tree's scan again;
 *  - over the saved index's tree, which no scan stands behind, nothing is
 *    asked: the view says it fills in once the scan finishes while one is
 *    coming, and that the tree is the saved index once nothing will land.
 *
 * Every function is EXECUTED out of the built page, with the server stubbed
 * under it and a stub DOM. The phases below are the (scanning, scanId,
 * settledScanId) triples the page's own lifecycle produces — coreScanFlow
 * drives the real startScan, followScanProgress, finishScan and stopScan
 * through them ("the scan the tree on screen came from, through a real
 * rescan").
 */

/** A page function by its declaration, brace-matched, out of the built page. */
function pageFn(decl: string): string {
  const start = INDEX.indexOf(decl);
  assert.notEqual(start, -1, `${decl} is in the page`);
  let depth = 0;
  for (let i = INDEX.indexOf('{', INDEX.indexOf(')', start)); i < INDEX.length; i++) {
    if (INDEX[i] === '{') depth++;
    else if (INDEX[i] === '}' && --depth === 0) return INDEX.slice(start, i + 1);
  }
  return assert.fail(`${decl} never closes`);
}

/** Every top-level function declaration in the page: its name and whole source. */
function pageFunctions(): Array<{ name: string; body: string; at: number }> {
  const out: Array<{ name: string; body: string; at: number }> = [];
  for (const m of INDEX.matchAll(/^(?:async )?function (\w+)\(/gm)) {
    out.push({ name: m[1], body: pageFn(m[0]), at: m.index! });
  }
  return out;
}

/** The top-level function a page offset sits in, or '(top level)'. */
function enclosing(fns: Array<{ name: string; body: string; at: number }>, at: number): string {
  const f = fns.find((x) => x.at <= at && at < x.at + x.body.length);
  return f ? f.name : '(top level)';
}

/* ───────────────────────────── the phases ───────────────────────────── */

type Phase = { scanning: boolean; scanId: string | null; settledScanId: string | null; indexScanDue: boolean };
/** A rescan over the older scan's tree, its request answered (followScanProgress). */
const HELD: Phase = { scanning: true, scanId: 'scan-new', settledScanId: 'scan-old', indexScanDue: false };
/** The rescan landed (finishScan). */
const LANDED: Phase = { scanning: false, scanId: 'scan-new', settledScanId: 'scan-new', indexScanDue: false };
/** A rescan over the older scan's tree, Stopped (stopScan): the older scan is back. */
const STOPPED: Phase = { scanning: false, scanId: 'scan-old', settledScanId: 'scan-old', indexScanDue: false };
/** The saved index's tree on screen, its scan running (openFromIndex, finishScan, followScanProgress). */
const INDEX_RUNNING: Phase = { scanning: true, scanId: 'scan-new', settledScanId: null, indexScanDue: true };
/** The saved index's tree on screen, its scan Stopped: nothing will land (endScanChrome). */
const INDEX_STOPPED: Phase = { scanning: false, scanId: null, settledScanId: null, indexScanDue: false };

/** The rule's own two functions, lifted with whatever is under test. */
const RULE = ['function treeScanId(', 'function treeScanComing('];

/* ───────────────────────────── the rule ───────────────────────────── */

test('the scan the tree on screen came from is decided in one place, treeScanId — no page code spells the rule itself', () => {
  const fns = pageFunctions();
  const spelled = [...INDEX.matchAll(/state\.scanning\s*\?\s*state\.settledScanId\s*:\s*state\.scanId/g)]
    .map((m) => enclosing(fns, m.index!));
  assert.deepEqual(spelled, ['treeScanId'], `the rule is spelled out in: ${spelled.join(', ')}`);
  // Nor under the name an earlier round gave it: one helper, not two (reclaimTreeScan was Reclaim's own).
  assert.ok(!/function reclaimTreeScan\(/.test(INDEX), 'a second helper for the same rule is back');
});

test('treeScanId names the scan behind the tree on screen through a rescan, a landing and a Stop, and none for the saved index\'s tree', () => {
  const state: Record<string, unknown> = {};
  const { treeScanId, treeScanComing } = new Function('state', `${RULE.map(pageFn).join('\n')}\nreturn { treeScanId, treeScanComing };`)(state) as
    { treeScanId: () => string | null; treeScanComing: () => boolean };
  const at = (p: Phase) => { Object.assign(state, p); return treeScanId(); };
  assert.equal(at(HELD), 'scan-old', 'during a rescan, the older scan whose tree is on screen — never the running one');
  assert.equal(at(LANDED), 'scan-new', 'once it lands, the new scan');
  assert.equal(at(STOPPED), 'scan-old', 'after a Stop, the older scan again');
  assert.equal(at(INDEX_RUNNING), null, 'the saved index\'s tree: no scan stands behind it, while its scan runs');
  assert.equal(treeScanComing(), true, 'and one is coming');
  assert.equal(at(INDEX_STOPPED), null, 'nor once that scan is stopped');
  assert.equal(treeScanComing(), false, 'and none is coming');
  Object.assign(state, { scanning: false, indexScanDue: true });
  assert.equal(treeScanComing(), true, 'the index paint, its scan due but not yet requested, has one coming too');
});

/* ───────────────────────────── a stub DOM and the page ───────────────────────────── */

/** An element as these views write it: what they set is read back. */
class El {
  innerHTML = '';
  textContent = '';
  hidden = false;
  disabled = false;
  title = '';
  value = '';
  childElementCount = 0;
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  attrs: Record<string, string> = {};
  cls = new Set<string>();
  classList = {
    add: (...c: string[]) => { for (const x of c) this.cls.add(x); },
    remove: (...c: string[]) => { for (const x of c) this.cls.delete(x); },
    toggle: (c: string, on?: boolean) => { const n = on === undefined ? !this.cls.has(c) : on; if (n) this.cls.add(c); else this.cls.delete(c); return n; },
    contains: (c: string) => this.cls.has(c),
  };
  /** Whatever a view looks for inside an element it just wrote is there, as a browser's would be. */
  querySelector(): El | null { return new El(); }
  querySelectorAll(): El[] { return []; }
  addEventListener(): void {}
  setAttribute(k: string, v: string): void { this.attrs[k] = v; }
  removeAttribute(k: string): void { delete this.attrs[k]; }
  focus(): void {}
  closest(): null { return null; }
}

function stubDom(): (id: string) => El {
  const els = new Map<string, El>();
  return (id: string) => {
    let e = els.get(id);
    if (!e) { e = new El(); els.set(id, e); }
    return e;
  };
}

/** One request a page function made: the URL, and the scan it names (in the URL or the body). */
type Ask = { url: string; scanId: string | null };

function scanOf(url: string, body: string | undefined): string | null {
  const q = /[?&]scanId=([^&]*)/.exec(url);
  if (q) return decodeURIComponent(q[1]);
  const p = /^\/api\/scan\/([^/?]+)\//.exec(url);
  if (p) return decodeURIComponent(p[1]);
  if (body) {
    const b = JSON.parse(body) as { scanId?: string | null };
    if ('scanId' in b) return b.scanId ?? null;
  }
  return null;
}

/** A view object out of the page's VIEWS list or a registerView call, by its id, brace-matched. */
function pageView(id: string): string {
  let at = INDEX.indexOf(`id: '${id}', label:`);
  if (at === -1) at = INDEX.indexOf(`registerView({\n  id: '${id}',`);
  assert.notEqual(at, -1, `the ${id} view is in the page`);
  const start = INDEX.lastIndexOf('{', at + (INDEX.startsWith('registerView', at) ? 13 : 0));
  let depth = 0;
  for (let i = start; i < INDEX.length; i++) {
    if (INDEX[i] === '{') depth++;
    else if (INDEX[i] === '}' && --depth === 0) return INDEX.slice(start, i + 1);
  }
  return assert.fail(`the ${id} view never closes`);
}

/**
 * The page's functions `decls` (and the rule's), in one scope over `given`,
 * with every request recorded in `asks` and answered by `answer`. A name the
 * code reaches that neither the page's lifted functions nor `given` hold is a
 * ReferenceError, so nothing is stubbed by accident.
 */
function page<T>(decls: string[], given: Record<string, unknown>, returns: string, answer: (url: string) => unknown = () => ({})):
  { fns: T; asks: Ask[] } {
  const asks: Ask[] = [];
  const api = async (url: string, init?: { body?: string }) => {
    asks.push({ url, scanId: scanOf(url, init?.body) });
    return answer(url);
  };
  const all = [...RULE, ...decls];
  const own = new Set(all.map((d) => /function (\w+)\(/.exec(d)![1]));
  // `given` itself is the scope, so what the page assigns to its own top-level bindings is read back from it.
  if (!('api' in given)) given.api = api;
  if (!('apiPaced' in given)) given.apiPaced = api;
  const scope = new Proxy(given, {
    has: (t, k) => typeof k === 'string' && k in t && !own.has(k),
    get: (t, k) => (k === Symbol.unscopables ? undefined : (t as Record<string, unknown>)[k as string]),
    set: (t, k, v) => { (t as Record<string, unknown>)[k as string] = v; return true; },
  });
  const fns = new Function('scope', `with (scope) { ${all.map(pageFn).join('\n')}\n return ${returns}; }`)(scope) as T;
  return { fns, asks };
}

/** Let `n` turns of the event loop pass: a count, never a time. */
async function turns(n = 10): Promise<void> {
  for (let i = 0; i < n; i++) await new Promise((resolve) => setImmediate(resolve));
}

const COMING = /fills in once the scan finishes/;
const OPENED = /^<div class="muted">Opened from the saved index — scan this folder to /;
const noop = () => {};
const esc = (s: string) => s;
const TREE = { path: '/r', name: 'r', size: 1000 };

/**
 * A view's scan-backed report through the phases: during a rescan over the
 * older scan's tree it is asked of that scan; once the rescan lands, of the
 * new one; after a Stop, of the older one again — each from a fresh mount,
 * nothing cached. `load` mounts the view; `fresh` forgets what it holds.
 */
async function throughThePhases(label: string, state: Record<string, unknown>, asks: Ask[], load: () => Promise<unknown>, fresh: () => void) {
  for (const [name, phase, want] of [['during a rescan over the older scan\'s tree', HELD, 'scan-old'],
    ['once the rescan lands', LANDED, 'scan-new'], ['after a Stop', STOPPED, 'scan-old']] as const) {
    Object.assign(state, phase);
    fresh();
    const before = asks.length;
    await load();
    await turns();
    const made = asks.slice(before);
    assert.ok(made.length > 0, `${label}, ${name}: the report is asked for`);
    assert.deepEqual(made.map((a) => a.scanId), made.map(() => want), `${label}, ${name}: asked of ${want} (${made.map((a) => a.url).join(', ')})`);
  }
}

/* ───────────────────────────── Apps, Libraries, Security ───────────────────────────── */

test('Apps: what each application owns is asked of the scan the tree on screen came from — never the running scan — and over the saved index\'s tree nothing is asked: it says it fills in once the scan finishes, then that the tree is the saved index', async () => {
  const $ = stubDom();
  const state: Record<string, unknown> = { root: TREE, apps: { loadedFor: null, list: [] }, ...HELD };
  const { fns, asks } = page<{ mount: () => void; loadApps: () => Promise<void>; scatter: () => Promise<void> }>(['async function loadApps(', 'async function loadAppsScatter('], {
    state, $, skeletonRows: () => '<i>loading</i>', appsScatterDrop: noop, renderApps: noop, escapeHtml: esc, appsScatterSeq: 0,
  }, `{ mount: () => (${pageView('apps')}).mount(), loadApps, scatter: loadAppsScatter }`,
  (url) => (url === '/api/facts' ? { providers: { subtreeCount: { available: false } } } : { apps: [], otherBytes: 0, totalBytes: 0 }));
  await throughThePhases('Apps', state, asks, async () => fns.mount(), () => { (state.apps as { loadedFor: unknown }).loadedFor = null; });
  // The chart's file counts, of the apps on screen: asked of the scan they came from.
  Object.assign(state, HELD);
  (state.apps as { list: unknown[] }).list = Array.from({ length: 5 }, (_, i) => ({ locations: [{ path: `/r/app${i}` }] }));
  const asked = asks.length;
  await fns.scatter();
  assert.deepEqual(asks.slice(asked).map((a) => a.scanId), ['scan-old'], 'the chart\'s file counts are asked of the scan the apps came from');
  // The saved index's tree: no scan behind it.
  const before = asks.length;
  Object.assign(state, INDEX_RUNNING);
  fns.mount();
  await turns();
  assert.equal(asks.length, before, 'over the saved index\'s tree nothing is asked — not of the running scan');
  assert.match($('appsBody').innerHTML, COMING, 'it says it fills in once the scan finishes');
  Object.assign(state, INDEX_STOPPED);
  fns.mount();
  await turns();
  assert.equal(asks.length, before, 'nor once that scan is stopped');
  assert.match($('appsBody').innerHTML, OPENED, 'it says the tree is the saved index, and what would fill it');
});

test('Libraries: the game and media libraries are asked of the scan the tree on screen came from — never the running scan — and over the saved index\'s tree nothing is asked, said as loading, then as the saved index', async () => {
  const $ = stubDom();
  const state: Record<string, unknown> = { root: TREE, games: { loadedFor: null }, media: { loadedFor: null }, ...HELD };
  const { fns, asks } = page<{ mount: () => void }>(['async function loadGames(', 'async function loadMedia('], {
    state, $, skeletonRows: () => '<i>loading</i>', renderGames: noop, renderMedia: noop, escapeHtml: esc,
  }, `{ mount: () => (${pageView('games')}).mount() }`, () => ({ libraries: [] }));
  const fresh = () => { (state.games as { loadedFor: unknown }).loadedFor = null; (state.media as { loadedFor: unknown }).loadedFor = null; };
  await throughThePhases('Libraries', state, asks, async () => fns.mount(), fresh);
  const before = asks.length;
  Object.assign(state, INDEX_RUNNING);
  fns.mount();
  await turns();
  assert.equal(asks.length, before, 'over the saved index\'s tree nothing is asked');
  assert.match($('gamesBody').innerHTML, COMING, 'the game libraries say they fill in once the scan finishes');
  assert.match($('mediaBody').innerHTML, COMING, 'and so do the media libraries');
  Object.assign(state, INDEX_STOPPED);
  fns.mount();
  await turns();
  assert.equal(asks.length, before);
  assert.match($('gamesBody').innerHTML, OPENED, 'once nothing will land, the tree is said to be the saved index');
  assert.match($('mediaBody').innerHTML, OPENED);
});

test('Security: the findings, and the next page of them, are asked of the scan the tree on screen came from — never the running scan — and over the saved index\'s tree nothing is asked, said as loading, then as the saved index', async () => {
  const $ = stubDom();
  const state: Record<string, unknown> = { root: TREE, security: { loadedFor: null, report: null }, ...HELD };
  const { fns, asks } = page<{ mount: () => void; more: () => Promise<void> }>(['async function loadSecurity(', 'async function loadMoreSecurity('], {
    state, $, skeletonRows: () => '<i>loading</i>', renderSecurity: noop, escapeHtml: esc, toast: noop, securityMoreFor: null,
  }, `{ mount: () => (${pageView('security')}).mount(), more: loadMoreSecurity }`,
  () => ({ findings: [{ path: '/r/a' }], counts: {}, total: 2, truncated: false }));
  await throughThePhases('Security', state, asks, async () => fns.mount(), () => { (state.security as { loadedFor: unknown }).loadedFor = null; });
  // The next page, while a rescan runs over the older scan's tree whose findings are shown.
  Object.assign(state, HELD);
  const report = { findings: [{ path: '/r/a' }], counts: {}, total: 2, truncated: true };
  (state.security as { report: unknown }).report = report;
  const before = asks.length;
  await fns.more();
  assert.deepEqual(asks.slice(before).map((a) => a.scanId), ['scan-old'], 'the next page of findings is asked of the scan they came from');
  assert.notEqual((state.security as { report: unknown }).report, report, 'and kept, the tree on screen being that scan\'s still');
  const quiet = asks.length;
  Object.assign(state, INDEX_RUNNING);
  fns.mount();
  await turns();
  assert.equal(asks.length, quiet, 'over the saved index\'s tree nothing is asked');
  assert.match($('securityBody').innerHTML, COMING, 'it says it fills in once the scan finishes');
  Object.assign(state, INDEX_STOPPED);
  fns.mount();
  await turns();
  assert.equal(asks.length, quiet);
  assert.match($('securityBody').innerHTML, OPENED, 'then that the tree is the saved index');
});

test('Apps, Libraries and Security keep no answer that lands once another tree is on screen — asked of the older scan during a rescan, an answer landing after the rescan landed is not painted over the new tree', async () => {
  for (const view of [
    { id: 'apps', decls: ['async function loadApps('], state: { apps: { loadedFor: null, list: [] } }, kept: (s: Record<string, any>) => s.apps.loadedFor },
    { id: 'games', decls: ['async function loadGames(', 'async function loadMedia('], state: { games: { loadedFor: null }, media: { loadedFor: null } },
      kept: (s: Record<string, any>) => s.games.loadedFor ?? s.media.loadedFor },
    { id: 'security', decls: ['async function loadSecurity('], state: { security: { loadedFor: null, report: null } }, kept: (s: Record<string, any>) => s.security.loadedFor },
  ]) {
    const $ = stubDom();
    const state: Record<string, unknown> = { root: TREE, ...view.state, ...HELD };
    const held: Array<(v: unknown) => void> = [];
    let painted = 0;
    const { fns } = page<{ mount: () => void }>(view.decls, {
      state, $, skeletonRows: () => '<i>loading</i>', appsScatterDrop: noop, escapeHtml: esc,
      renderApps: () => { painted++; }, renderGames: () => { painted++; }, renderMedia: () => { painted++; }, renderSecurity: () => { painted++; },
    }, `{ mount: () => (${pageView(view.id)}).mount() }`, () => new Promise((resolve) => { held.push(resolve); }));
    fns.mount();
    await turns();
    assert.ok(held.length > 0, `${view.id}: control: asked`);
    Object.assign(state, LANDED); // finishScan: the new tree is on screen before the answer
    for (const answer of held) answer({ apps: [], libraries: [], findings: [] });
    await turns();
    assert.equal(painted, 0, `${view.id}: the older scan's answer is not painted over the new tree`);
    assert.equal(view.kept(state), null, `${view.id}: nor kept as what the view holds`);
  }
});

/* ───────────────────────────── Duplicates ───────────────────────────── */

const DUP_COMING = /it starts once the scan finishes/;

/** The duplicate finders' page: both loaders, the view's mount, and the toolbar's rule. */
function dupPage(state: Record<string, unknown>, answer: (url: string) => unknown) {
  const $ = stubDom();
  const out = page<{ mount: () => void; exact: () => Promise<void>; near: () => Promise<void>; toolbar: () => void; open: (k: string, i: number) => Promise<void> }>(
    ['function dupNeedsScan(', 'function ndNeedsScan(', 'async function loadDuplicates(', 'async function loadNearDupes(',
      'function updateNdToolbar(', 'function ndAutoSelectBlocked(', 'async function openDupeViewer('], {
      state, $, escapeHtml: esc, icon: () => '', REDUCED: true, formatCount: String, formatBytes: (n: number) => `${n} B`,
      setTimeout: (fn: () => void) => { void Promise.resolve().then(fn); return 1; }, clearTimeout: noop,
      fxOrbHide: noop, fxOrbShow: noop, fxHuntBeamSync: noop, updateDupToolbar: noop, renderDupNote: noop, dupProgressText: () => '',
      seedNodes: noop, renderDuplicates: noop, renderNearDupes: noop, isCloudScan: () => false, nodeFor: () => null,
      dupeViewer: { kind: null, at: 0, keeper: 0, data: null, seq: 0, totalCopies: 0 }, dupeViewerKeys: noop, renderDupeViewer: noop,
      document: { addEventListener: noop },
    }, `{ mount: () => (${pageView('duplicates')}).mount(), exact: loadDuplicates, near: loadNearDupes, toolbar: updateNdToolbar, open: openDupeViewer }`, answer);
  return { ...out, $ };
}

const freshDup = () => ({ loadedFor: null, status: 'idle', groups: [], selection: new Set(), pollTimer: 0 });
const freshNear = () => ({ loadedFor: null, status: 'idle', clusters: [], selection: new Set(), pollTimer: 0 });

test('Duplicates: both finders ask the scan the tree on screen came from — through the poll of a search still hashing too — never the running scan, and over the saved index\'s tree ask nothing and say they start once the scan finishes, then that a scan of the folder is needed', async () => {
  const state: Record<string, unknown> = { root: TREE, dupMode: 'exact', dup: freshDup(), near: freshNear(), ...HELD };
  const { fns, asks, $ } = dupPage(state, () => ({ status: 'complete', groups: [], clusters: [], available: true }));
  await throughThePhases('Duplicates', state, asks, async () => { await fns.exact(); await fns.near(); }, () => { state.dup = freshDup(); state.near = freshNear(); });

  // A search started before the rescan's request answered keeps asking the tree's scan as it polls:
  // the request answering (followScanProgress) puts the running scan's id on hand mid-search.
  for (const finder of ['exact', 'near'] as const) {
    let polls = 0;
    const raceState: Record<string, unknown> = { root: TREE, dupMode: 'exact', dup: freshDup(), near: freshNear(),
      scanning: true, scanId: 'scan-old', settledScanId: 'scan-old', indexScanDue: false };
    const racing = dupPage(raceState, () => {
      polls++;
      if (polls === 1) raceState.scanId = 'scan-new'; // the rescan's request answers while the first poll is out
      return polls < 3 ? { status: 'running', hashed: 1, toHash: 4 } : { status: 'complete', groups: [], clusters: [], available: true };
    });
    await racing.fns[finder]();
    await turns(20);
    assert.equal(racing.asks.length, 3, `${finder}: control: the search polled until it settled`);
    assert.deepEqual(racing.asks.map((a) => a.scanId), ['scan-old', 'scan-old', 'scan-old'],
      `${finder}: every poll asks the scan the tree on screen came from, never the one whose request answered meanwhile`);
  }

  // The saved index's tree: nothing asked, both panes say what they wait for.
  const before = asks.length;
  Object.assign(state, INDEX_RUNNING);
  fns.mount();
  await turns();
  assert.equal(asks.length, before, 'over the saved index\'s tree nothing is asked — not of the running scan');
  assert.match($('dupBody').innerHTML, DUP_COMING, 'the duplicate finder says it starts once the scan finishes');
  assert.match($('ndBody').innerHTML, DUP_COMING, 'and so does the similar-image finder');
  assert.equal($('dupSummary').textContent, 'Waiting for the scan to finish.');
  Object.assign(state, INDEX_STOPPED);
  fns.mount();
  await turns();
  assert.equal(asks.length, before);
  assert.match($('dupBody').innerHTML, /needs a finished scan of this folder\. Press Scan to run one\./, 'once nothing will land, a scan is what it needs');
  assert.equal($('dupSummary').textContent, 'Needs a completed scan.');
});

test('Duplicates: the side-by-side viewer asks the scan the tree on screen came from; over the saved index\'s tree it asks nothing, and the similar-image toolbar offers nothing an earlier scan left — Auto-select is blocked and nothing is offered to the Trash', async () => {
  const state: Record<string, unknown> = {
    root: TREE, dupMode: 'near', ...HELD,
    dup: { ...freshDup(), groups: [{ files: [{ path: '/r/a' }, { path: '/r/b' }] }] },
    near: { ...freshNear(), status: 'complete', available: true, clusters: [{ files: [{ path: '/r/x' }, { path: '/r/y' }] }], selection: new Set(['/r/y']) },
  };
  const { fns, asks, $ } = dupPage(state, () => ({ files: [], recommendedKeep: null }));
  await fns.open('exact', 0);
  assert.deepEqual(asks.map((a) => a.scanId), ['scan-old'], 'the viewer asks the scan the copies on screen came from');
  fns.toolbar();
  assert.equal($('ndAutoBtn').disabled, false, 'control: over the older scan\'s tree, its own groups can be auto-selected');
  assert.match($('ndTrashBtn').innerHTML, /Move 1 to Trash/, 'control: and what is selected in them offered to the Trash');
  Object.assign(state, INDEX_RUNNING);
  fns.toolbar();
  assert.equal($('ndAutoBtn').disabled, true, 'over the saved index\'s tree Auto-select is blocked: the groups are an earlier scan\'s');
  assert.equal($('ndTrashBtn').disabled, true, 'and nothing they hold is offered to the Trash');
  await fns.open('exact', 0);
  assert.equal(asks.length, 1, 'nor does the viewer ask anything — not of the running scan');
});

/* ───────────────────────────── Calendar, Missing GB ───────────────────────────── */

test('Calendar: bytes per day are counted by the scan the tree on screen came from — never the running scan — and over the saved index\'s tree nothing is asked: it says it fills in once the scan finishes, then that the tree is the saved index', async () => {
  const $ = stubDom();
  const state: Record<string, unknown> = { root: TREE, view: 'history', ...HELD };
  const { fns, asks } = page<{ load: () => Promise<void> }>(['async function loadCalendar('], {
    state, $, calChannel: 'modified', calSeq: 0, calData: null, skeletonRows: () => '<i>loading</i>', renderCalendar: noop,
    escapeHtml: esc, icon: () => '', openBrowse: noop,
  }, '{ load: loadCalendar }', () => ({ modified: [], degraded: [] }));
  await throughThePhases('Calendar', state, asks, fns.load, noop);
  const before = asks.length;
  Object.assign(state, INDEX_RUNNING);
  await fns.load();
  assert.equal(asks.length, before, 'over the saved index\'s tree nothing is asked — not of the running scan');
  assert.match($('calBody').innerHTML, COMING, 'it says it fills in once the scan finishes');
  assert.doesNotMatch($('calBody').innerHTML, /Choose a folder|Once a folder is scanned/, 'not the welcome\'s words, over a folder on screen');
  assert.equal($('calControls').hidden, true, 'with no days to pick from, no controls');
  Object.assign(state, INDEX_STOPPED);
  await fns.load();
  assert.equal(asks.length, before);
  assert.match($('calBody').innerHTML, /Opened from the saved index — scan this folder to /, 'once nothing will land, the tree is said to be the saved index');
});

test('Missing GB: the statement is asked of the scan the tree on screen came from — never the running scan — an answer is kept only for that scan, and over the saved index\'s tree nothing is asked: loading, then the saved index', async () => {
  const $ = stubDom();
  const state: Record<string, unknown> = { root: TREE, ...HELD };
  const given: Record<string, unknown> = {
    state, $, missingSeq: 0, missingData: null, missingAsking: null, missingUpdating: false, missingCache: new Map(), MISSING_CACHE_SCANS: 4,
    renderMissing: noop, skeletonRows: () => '<i>loading</i>', escapeHtml: esc,
  };
  let hold: ((r: (v: unknown) => void) => void) | null = null;
  const { fns, asks } = page<{ load: () => Promise<void> }>(['async function loadMissing(', 'function mgRemember('], given, '{ load: loadMissing }',
    () => (hold ? new Promise((resolve) => { const h = hold!; hold = null; h(resolve); }) : { lines: [] }));
  await throughThePhases('Missing GB', state, asks, fns.load, noop);
  // A statement asked while the rescan's request is out, landing after it answered (followScanProgress): the
  // tree on screen is still that scan's, so it is kept — not dropped as "another scan's".
  let release: (v: unknown) => void = noop;
  Object.assign(state, { scanning: true, scanId: 'scan-old', settledScanId: 'scan-old', indexScanDue: false });
  hold = (r: (v: unknown) => void) => { release = r; };
  let out = fns.load();
  await turns();
  state.scanId = 'scan-new';
  const theTrees = { lines: ['scan-old, asked during the rescan'] };
  release(theTrees);
  await out;
  assert.equal(given.missingData, theTrees, 'a statement of the tree on screen is kept when the rescan\'s request answers meanwhile');
  // One asked of the older scan that lands once the rescan landed: not put on screen over the new tree.
  Object.assign(state, HELD);
  hold = (r: (v: unknown) => void) => { release = r; };
  out = fns.load();
  await turns();
  Object.assign(state, LANDED);
  const stale = { lines: ['scan-old, landing after scan-new'] };
  release(stale);
  await out;
  assert.notEqual(given.missingData, stale, 'the older scan\'s statement is not put on screen over the new tree');
  const before = asks.length;
  Object.assign(state, INDEX_RUNNING);
  await fns.load();
  assert.equal(asks.length, before, 'over the saved index\'s tree nothing is asked');
  assert.match($('missingBody').innerHTML, COMING, 'it says it fills in once the scan finishes');
  Object.assign(state, INDEX_STOPPED);
  await fns.load();
  assert.equal(asks.length, before);
  assert.match($('missingBody').innerHTML, OPENED, 'then that the tree is the saved index');
});

/* ───────────────────────────── the highlight box's query, opening a container ───────────────────────────── */

test('the highlight box\'s query runs on the scan the tree on screen came from — never the running scan — is asked again only of a scan that has not answered it, and over the saved index\'s tree says what it waits for instead of "Scan a folder first"', async () => {
  const $ = stubDom();
  const messages: string[] = [];
  const reasked: string[] = [];
  const state: Record<string, unknown> = { root: TREE, ...HELD, treemap: { rootPath: '/r', query: 'size>1gb', queryMode: 'bare', queryScanId: null, matches: 0 } };
  const { fns, asks } = page<{ run: (q: string) => Promise<void>; rejudge: () => void }>(['async function tmRunGrammarQuery(', 'function tmRejudgeQuery('], {
    state, $, tmQuerySeq: 0, tmQueryAbort: null, tmLastHits: null, AbortController,
    tmSetQueryMessage: (m: string) => { messages.push(m); }, tmStageable: () => ({ paths: [] }), seedNodes: noop, tmSyncStageButton: noop,
    renderSearchOverlay: noop, presentView: noop, formatCount: String, tmUndrawnMessage: () => '', tmClearHits: noop,
    tmApplyQuery: (q: string) => { reasked.push(q); },
  }, '{ run: tmRunGrammarQuery, rejudge: tmRejudgeQuery }', () => ({ hits: [], total: 0 }));
  await throughThePhases('The highlight query', state, asks, () => fns.run('size>1gb'), noop);
  // A query the older scan answered during the rescan is that tree's: not asked again of the running scan.
  Object.assign(state, HELD);
  await fns.run('size>1gb');
  assert.equal((state.treemap as { queryScanId: unknown }).queryScanId, 'scan-old', 'control: answered by the scan the tree came from');
  fns.rejudge();
  assert.deepEqual(reasked, [], 'the tree on screen already has its answer: nothing is asked of the running scan');
  Object.assign(state, LANDED);
  fns.rejudge();
  assert.deepEqual(reasked, ['size>1gb'], 'once the rescan lands, its tree is asked');
  // The saved index's tree.
  const before = asks.length;
  Object.assign(state, INDEX_RUNNING);
  await fns.run('size>1gb');
  assert.equal(asks.length, before, 'over the saved index\'s tree nothing is asked — not of the running scan');
  assert.equal(messages.at(-1), 'The search runs on a finished scan — search again once the scan finishes.', 'it says what the search waits for');
  Object.assign(state, INDEX_STOPPED);
  await fns.run('size>1gb');
  assert.equal(asks.length, before);
  assert.equal(messages.at(-1), 'Opened from the saved index — scan this folder to search it.', 'once nothing will land, what would make it searchable');
  state.root = null;
  await fns.run('size>1gb');
  assert.equal(messages.at(-1), 'Scan a folder first — there is nothing to search yet.', 'with no tree at all, as before');
});

test('opening an archive or disk image on the map asks the scan the tree on screen came from — never the running scan, which answers 409', async () => {
  const $ = stubDom();
  const state: Record<string, unknown> = { root: TREE, ...HELD, pathIndex: new Map() };
  const { fns, asks } = page<{ open: (n: unknown) => Promise<void> }>(['async function expandContainerNode('], {
    state, $, loadTreemap: noop, toast: noop, formatCount: String, updateTmStatus: noop,
  }, '{ open: expandContainerNode }', () => ({ children: [], entryCount: 0, truncated: false }));
  await throughThePhases('Opening a container', state, asks, () => fns.open({ path: '/r/a.zip', name: 'a.zip' }), noop);
});
