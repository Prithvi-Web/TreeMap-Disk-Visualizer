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

/** A top-level statement of the page by its opening text (an event handler's), brace-matched through its closing `;`. */
function pageStatement(head: string): string {
  const start = INDEX.indexOf(head);
  assert.notEqual(start, -1, `${head} is in the page`);
  let depth = 0;
  for (let i = INDEX.indexOf('{', start); i < INDEX.length; i++) {
    if (INDEX[i] === '{') depth++;
    else if (INDEX[i] === '}' && --depth === 0) return INDEX.slice(start, INDEX.indexOf(';', i) + 1);
  }
  return assert.fail(`${head} never closes`);
}

/** Every top-level function declaration in the page: its name and whole source. */
function pageFunctions(): Array<{ name: string; body: string; at: number }> {
  const out: Array<{ name: string; body: string; at: number }> = [];
  for (const m of INDEX.matchAll(/^(?:async )?function (\w+)\(/gm)) {
    out.push({ name: m[1], body: pageFn(m[0]), at: m.index! });
  }
  return out;
}

/** Whether a page offset sits in a comment: inside a block comment, or after `//` on its line. */
function inComment(at: number): boolean {
  if (INDEX.lastIndexOf('/*', at) > INDEX.lastIndexOf('*/', at)) return true;
  return /(?:^|\s)\/\/ /.test(INDEX.slice(INDEX.lastIndexOf('\n', at) + 1, at));
}

/**
 * The top-level statements outside every function declaration that read
 * state.scanId in code — an event handler's arrow, a subscriber — each named
 * by its first line, with its whole source. The audit saw only function
 * declarations, and a click handler asking the running scan was invisible to
 * it (review F1.8).
 */
function pageStatementsReading(fns: Array<{ name: string; body: string; at: number }>): Array<{ name: string; body: string }> {
  const found = new Map<string, string>();
  for (const m of INDEX.matchAll(/state\.scanId\b/g)) {
    const at = m.index!;
    if (fns.some((f) => f.at <= at && at < f.at + f.body.length) || inComment(at)) continue;
    // Up to the statement's first line: the nearest line above that starts at column 0 with code.
    let start = INDEX.lastIndexOf('\n', at) + 1;
    while (!/[A-Za-z$_(]/.test(INDEX[start])) start = INDEX.lastIndexOf('\n', start - 2) + 1;
    let depth = 0; let end = -1;
    for (let i = INDEX.indexOf('{', start); i < INDEX.length && end === -1; i++) {
      if (INDEX[i] === '{') depth++;
      else if (INDEX[i] === '}' && --depth === 0) end = i + 1;
    }
    assert.ok(at < end, `the read at ${at} is inside the statement found for it`);
    found.set(INDEX.slice(start, INDEX.indexOf('\n', start)).trim(), INDEX.slice(start, end));
  }
  return [...found].map(([name, body]) => ({ name, body }));
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
  // A scan pressed over the saved index's tree before any paint (the index asked about): coming only if it is a scan of that tree.
  Object.assign(state, { scanning: true, indexScanDue: false, scanId: null, root: TREE, scanningPath: TREE.path });
  assert.equal(treeScanComing(), true, 'a scan of the folder on screen is coming for its tree');
  state.scanningPath = '/Users/x/Desktop';
  assert.equal(treeScanComing(), false, 'a scan of another folder is no scan of this tree: it replaces it, and "scan this folder" stays true of it');
  // The folder on screen typed another way: startScan keeps the box's text, the tree's path is the server's
  // spelling (sanitizePath: `~` expanded, path.resolve). Each is the folder on screen (review F1.3).
  state.system = { platform: 'darwin', homeDir: '/Users/x' };
  state.root = { path: '/Users/x/Documents', name: 'Documents', size: 1 };
  const comingFor = (typed: string) => { state.scanningPath = typed; return treeScanComing(); };
  for (const typed of ['~/Documents', '/Users/x/Documents/', '/Users/x//Documents', '/Users/x/Pictures/../Documents', '/Users/x/./Documents', '/users/X/documents']) {
    assert.equal(comingFor(typed), true, `"${typed}" is a scan of the folder on screen (macOS folds case)`);
  }
  for (const typed of ['/Users/x/Desktop', '~/Desktop', 'Documents', '/Users/x/Documents/sub', '/Users/x/Documents ']) {
    assert.equal(comingFor(typed), false, `"${typed}" is not`);
  }
  state.system = { platform: 'linux', homeDir: '/home/x' };
  state.root = { path: '/home/x/Documents', name: 'Documents', size: 1 };
  assert.equal(comingFor('~/Documents/'), true, 'Linux: the home folder and a trailing separator');
  assert.equal(comingFor('/home/x/documents'), false, 'Linux: case counts');
  state.system = { platform: 'win32', homeDir: 'C:\\Users\\x' };
  state.root = { path: 'C:\\Users\\x\\Documents', name: 'Documents', size: 1 };
  for (const typed of ['C:\\Users\\x\\Documents\\', 'c:/users/x/documents', '~\\Documents']) {
    assert.equal(comingFor(typed), true, `Windows: "${typed}" is the folder on screen`);
  }
  assert.equal(comingFor('D:\\Users\\x\\Documents'), false, 'Windows: another drive is another folder');
  state.root = { path: 'cloud://gdrive', name: 'Google Drive', size: 1 };
  assert.equal(comingFor('cloud://gdrive'), true, 'a cloud account\'s tree, rescanned: its own spelling, no folder to resolve');
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
  // A decl is a function declaration's head, or a top-level statement's (an event handler, `$(…)`, or a subscriber), which declares nothing.
  const own = new Set(all.flatMap((d) => { const m = /^(?:async )?function (\w+)\(/.exec(d); return m ? [m[1]] : []; }));
  // `given` itself is the scope, so what the page assigns to its own top-level bindings is read back from it.
  if (!('api' in given)) given.api = api;
  if (!('apiPaced' in given)) given.apiPaced = api;
  const scope = new Proxy(given, {
    has: (t, k) => typeof k === 'string' && k in t && !own.has(k),
    get: (t, k) => (k === Symbol.unscopables ? undefined : (t as Record<string, unknown>)[k as string]),
    set: (t, k, v) => { (t as Record<string, unknown>)[k as string] = v; return true; },
  });
  const fns = new Function('scope', `with (scope) { ${all.map((d) => (/^(?:\$|subscribe)\(/.test(d) ? pageStatement(d) : pageFn(d))).join('\n')}\n return ${returns}; }`)(scope) as T;
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
  const LAST = 'Based on your scan of <b>/other</b> — 3 apps own 9.0 GB'; // the last tree's line, as renderApps wrote it
  $('appsInfo').textContent = LAST;
  Object.assign(state, INDEX_RUNNING);
  fns.mount();
  await turns();
  assert.equal(asks.length, before, 'over the saved index\'s tree nothing is asked — not of the running scan');
  assert.match($('appsBody').innerHTML, COMING, 'it says it fills in once the scan finishes');
  assert.equal($('appsInfo').textContent, '', 'and the last tree\'s "Based on your scan of…" line goes (review F2.9)');
  $('appsInfo').textContent = LAST;
  Object.assign(state, INDEX_STOPPED);
  fns.mount();
  await turns();
  assert.equal(asks.length, before, 'nor once that scan is stopped');
  assert.match($('appsBody').innerHTML, OPENED, 'it says the tree is the saved index, and what would fill it');
  assert.equal($('appsInfo').textContent, '', 'its line gone then too');
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
  // The last tree's lines, as renderGames and renderMedia wrote them.
  const seed = () => { $('gamesInfo').textContent = '2 libraries in /other'; $('mediaInfo').textContent = '1 library in /other'; };
  seed();
  Object.assign(state, INDEX_RUNNING);
  fns.mount();
  await turns();
  assert.equal(asks.length, before, 'over the saved index\'s tree nothing is asked');
  assert.match($('gamesBody').innerHTML, COMING, 'the game libraries say they fill in once the scan finishes');
  assert.match($('mediaBody').innerHTML, COMING, 'and so do the media libraries');
  assert.equal($('gamesInfo').textContent, '', 'the last tree\'s game libraries line goes (review F2.9)');
  assert.equal($('mediaInfo').textContent, '', 'and its media libraries line');
  seed();
  Object.assign(state, INDEX_STOPPED);
  fns.mount();
  await turns();
  assert.equal(asks.length, before);
  assert.match($('gamesBody').innerHTML, OPENED, 'once nothing will land, the tree is said to be the saved index');
  assert.match($('mediaBody').innerHTML, OPENED);
  assert.deepEqual([$('gamesInfo').textContent, $('mediaInfo').textContent], ['', ''], 'their lines gone then too');
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
  const LAST = '2 findings in /other'; // the last tree's line, as renderSecurity wrote it
  $('securityInfo').textContent = LAST;
  Object.assign(state, INDEX_RUNNING);
  fns.mount();
  await turns();
  assert.equal(asks.length, quiet, 'over the saved index\'s tree nothing is asked');
  assert.match($('securityBody').innerHTML, COMING, 'it says it fills in once the scan finishes');
  assert.equal($('securityInfo').textContent, '', 'and the last tree\'s findings line goes (review F2.9)');
  $('securityInfo').textContent = LAST;
  Object.assign(state, INDEX_STOPPED);
  fns.mount();
  await turns();
  assert.equal(asks.length, quiet);
  assert.match($('securityBody').innerHTML, OPENED, 'then that the tree is the saved index');
  assert.equal($('securityInfo').textContent, '', 'its line gone then too');
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
  // Nor their failures: asked of the older scan, failing once the rescan landed, said over no tree of its own (review F1.9).
  for (const view of [
    { id: 'apps', decls: ['async function loadApps('], state: { apps: { loadedFor: null, list: [] } }, hosts: ['appsBody'], reports: [] as string[] },
    { id: 'games', decls: ['async function loadGames(', 'async function loadMedia('], state: { games: { loadedFor: null }, media: { loadedFor: null } },
      hosts: ['gamesBody', 'mediaBody'], reports: ['games', 'media'] },
    { id: 'security', decls: ['async function loadSecurity('], state: { security: { loadedFor: null, report: null } }, hosts: ['securityBody'], reports: ['security'] },
  ]) {
    const $ = stubDom();
    const state: Record<string, unknown> = { root: TREE, ...view.state, ...HELD };
    const failing: Array<(e: Error) => void> = [];
    const { fns } = page<{ mount: () => void }>(view.decls, {
      state, $, skeletonRows: () => '<i>loading</i>', appsScatterDrop: noop, escapeHtml: esc,
      renderApps: noop, renderGames: noop, renderMedia: noop, renderSecurity: noop,
    }, `{ mount: () => (${pageView(view.id)}).mount() }`, () => new Promise((_resolve, reject) => { failing.push(reject); }));
    fns.mount();
    await turns();
    assert.ok(failing.length > 0, `${view.id}: control: asked`);
    Object.assign(state, LANDED); // the new tree is on screen, painted by its own load
    for (const h of view.hosts) $(h).innerHTML = '<i>the new tree\'s report</i>';
    for (const r of view.reports) (state[r] as { report: unknown }).report = 'the new tree\'s';
    for (const fail of failing) fail(new Error('Scan is still running — try again when it completes'));
    await turns();
    for (const h of view.hosts) assert.equal($(h).innerHTML, '<i>the new tree\'s report</i>', `${view.id}: the older scan's failure is not said over the new tree (${h})`);
    for (const r of view.reports) assert.equal((state[r] as { report: unknown }).report, 'the new tree\'s', `${view.id}: nor does it drop the new tree's ${r} report`);
  }
});

/* ───────────────────────────── Duplicates ───────────────────────────── */

const DUP_COMING = /it starts once the scan finishes/;

/** The duplicate finders' page: both loaders, the view's mount, and the toolbar's rule. */
function dupPage(state: Record<string, unknown>, answer: (url: string) => unknown, extra: Record<string, unknown> = {}) {
  const $ = stubDom();
  const out = page<{ mount: () => void; exact: () => Promise<void>; near: () => Promise<void>; toolbar: () => void; open: (k: string, i: number) => Promise<void> }>(
    ['function dupNeedsScan(', 'function ndNeedsScan(', 'async function loadDuplicates(', 'async function loadNearDupes(',
      'function updateNdToolbar(', 'function ndAutoSelectBlocked(', 'async function openDupeViewer('], {
      state, $, escapeHtml: esc, icon: () => '', REDUCED: true, formatCount: String, formatBytes: (n: number) => `${n} B`,
      setTimeout: (fn: () => void) => { void Promise.resolve().then(fn); return 1; }, clearTimeout: noop,
      fxOrbHide: noop, fxOrbShow: noop, fxHuntBeamSync: noop, updateDupToolbar: noop, renderDupNote: noop, dupProgressText: () => '',
      seedNodes: noop, renderDuplicates: noop, renderNearDupes: noop, isCloudScan: () => false, nodeFor: () => null,
      dupeViewer: { kind: null, at: 0, keeper: 0, data: null, seq: 0, totalCopies: 0 }, dupeViewerKeys: noop, renderDupeViewer: noop,
      document: { addEventListener: noop }, ...extra,
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

test('Duplicates: an answer either finder\'s search gets from the older scan once the rescan has landed is not installed over the new tree — nor its failure — and neither is the side-by-side viewer\'s', async () => {
  for (const finder of ['exact', 'near'] as const) {
    for (const fails of [false, true]) {
      const state: Record<string, unknown> = { root: TREE, dupMode: finder, dup: freshDup(), near: freshNear(), ...HELD };
      const held: Array<() => void> = [];
      let painted = 0;
      const { fns, $ } = dupPage(state, () => new Promise((resolve, reject) => {
        held.push(() => (fails ? reject(new Error('Could not reach the server'))
          : resolve({ status: 'complete', available: true, groups: [{ size: 1, files: [{ path: '/r/a' }, { path: '/r/b' }] }],
            clusters: [{ files: [{ path: '/r/x' }, { path: '/r/y' }] }] })));
      }), { renderDuplicates: () => { painted++; }, renderNearDupes: () => { painted++; } });
      const label = `${finder}${fails ? ', failing' : ''}`;
      await fns[finder]();
      await turns();
      assert.equal(held.length, 1, `${label}: control: a poll is out to the older scan`);
      // finishScan: the new tree on screen, the finders' state reset, while the poll is out.
      Object.assign(state, LANDED, { dup: freshDup(), near: freshNear() });
      const body = finder === 'exact' ? 'dupBody' : 'ndBody';
      $(body).innerHTML = '<i>the new tree\'s pane</i>';
      held[0]();
      await turns();
      const pane = (finder === 'exact' ? state.dup : state.near) as { status: string; groups?: unknown[]; clusters?: unknown[] };
      assert.equal(painted, 0, `${label}: the older scan's groups are not painted over the new tree`);
      assert.deepEqual([pane.status, (pane.groups ?? pane.clusters)!.length], ['idle', 0], `${label}: nor kept — Auto-select and Compare are not offered over them`);
      assert.equal($(body).innerHTML, '<i>the new tree\'s pane</i>', `${label}: nor its failure said there`);
    }
  }
  // The viewer, opened during the rescan, answering — or failing — once it landed.
  for (const fails of [false, true]) {
    const state: Record<string, unknown> = { root: TREE, dupMode: 'exact', ...HELD, near: freshNear(),
      dup: { ...freshDup(), groups: [{ files: [{ path: '/r/a' }, { path: '/r/b' }] }] } };
    let settle: () => void = noop;
    let shown = 0;
    const viewer = { kind: null, at: 0, keeper: 0, data: null, seq: 0, totalCopies: 0 };
    const { fns, $ } = dupPage(state, () => new Promise((resolve, reject) => {
      settle = () => (fails ? reject(new Error('Could not reach the server')) : resolve({ files: [{ path: '/r/a' }], recommendedKeep: { index: 0 } }));
    }), { renderDupeViewer: () => { shown++; }, dupeViewer: viewer });
    const out = fns.open('exact', 0);
    await turns();
    Object.assign(state, LANDED);
    settle();
    await out;
    const label = fails ? 'the viewer, failing' : 'the viewer';
    assert.deepEqual([shown, viewer.data], [0, null], `${label}: the older scan's copies are not shown once the new tree is on screen`);
    assert.match($('dupeViewerSummary').textContent, /^The tree on screen changed while these copies were read/, `${label}: it says why — not "Reading the copies…" for good, nor the older scan's failure`);
  }
});

test('Duplicates: the similar-image Auto-select and Trash buttons act on nothing over the saved index\'s tree — the groups are an earlier scan\'s — even pressed past the toolbar', () => {
  const clicks: Record<string, () => void> = {};
  const els = stubDom();
  const $ = (id: string) => {
    const e = els(id);
    if (id === 'ndAutoBtn' || id === 'ndTrashBtn') e.addEventListener = ((_t: string, fn: () => void) => { clicks[id] = fn; }) as El['addEventListener'];
    return e;
  };
  const trashed: string[][] = [];
  const near = { ...freshNear(), status: 'complete', available: true, compared: 4,
    clusters: [{ files: [{ path: '/r/x' }, { path: '/r/y' }] }], selection: new Set<string>() };
  const state: Record<string, unknown> = { root: TREE, ...HELD, near };
  page<Record<string, never>>(['function ndAutoSelectBlocked(', "$('ndAutoBtn').addEventListener('click', () => {", "$('ndTrashBtn').addEventListener('click', () => {"], {
    state, $, updateNdToolbar: noop, toast: noop, confirmTrash: (paths: string[]) => { trashed.push(paths); },
  }, '{}');
  // Control: over the older scan's tree, its own groups.
  clicks.ndAutoBtn();
  assert.deepEqual([...near.selection], ['/r/y'], 'control: over the older scan\'s tree Auto-select selects in its own groups');
  clicks.ndTrashBtn();
  assert.deepEqual(trashed, [['/r/y']], 'control: and Trash offers what is selected');
  // The saved index's tree: the groups are an earlier scan's.
  Object.assign(state, INDEX_RUNNING);
  near.selection = new Set(['/r/x']);
  clicks.ndAutoBtn();
  assert.deepEqual([...near.selection], ['/r/x'], 'over the saved index\'s tree Auto-select selects nothing in an earlier scan\'s groups');
  clicks.ndTrashBtn();
  assert.equal(trashed.length, 1, 'and Trash offers nothing of them');
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
  // The last tree's legend and degraded note, as its calendar left them (review F2.8).
  const seed = () => { $('calLegend').hidden = false; $('calDegraded').hidden = false; };
  seed();
  Object.assign(state, INDEX_RUNNING);
  await fns.load();
  assert.equal(asks.length, before, 'over the saved index\'s tree nothing is asked — not of the running scan');
  assert.match($('calBody').innerHTML, COMING, 'it says it fills in once the scan finishes');
  assert.doesNotMatch($('calBody').innerHTML, /Choose a folder|Once a folder is scanned/, 'not the welcome\'s words, over a folder on screen');
  assert.equal($('calControls').hidden, true, 'with no days to pick from, no controls');
  assert.deepEqual([$('calLegend').hidden, $('calDegraded').hidden], [true, true], 'nor the last tree\'s legend and degraded note');
  seed();
  Object.assign(state, INDEX_STOPPED);
  await fns.load();
  assert.equal(asks.length, before);
  assert.match($('calBody').innerHTML, /Opened from the saved index — scan this folder to /, 'once nothing will land, the tree is said to be the saved index');
  assert.deepEqual([$('calLegend').hidden, $('calDegraded').hidden], [true, true], 'its legend and note gone then too');
  // A count asked of the older scan during a rescan, still out when another folder is opened from its saved index:
  // its answer is not painted over that folder's words (review F2.8).
  let release: (v: unknown) => void = noop;
  let painted = 0;
  const race = page<{ load: () => Promise<void> }>(['async function loadCalendar('], {
    state, $, calChannel: 'modified', calSeq: 0, calData: null, skeletonRows: () => '<i>loading</i>',
    renderCalendar: () => { painted++; $('calBody').innerHTML = '<i>the older tree\'s calendar</i>'; },
    escapeHtml: esc, icon: () => '', openBrowse: noop,
  }, '{ load: loadCalendar }', () => new Promise((resolve) => { release = resolve; }));
  Object.assign(state, HELD, { root: TREE });
  const out = race.fns.load();
  await turns();
  Object.assign(state, INDEX_RUNNING, { root: { path: '/other', name: 'other', size: 1 } }); // finishScan's index paint of another folder
  await race.fns.load();
  release({ modified: [{ date: '2026-10-01', bytes: 9, files: 1 }], degraded: [] });
  await out;
  await turns();
  assert.equal(painted, 0, 'the older scan\'s calendar, answering late, is not painted over another folder\'s saved index');
  assert.match($('calBody').innerHTML, COMING, 'whose words stand');
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
  // Nor its failure (review F1.9).
  Object.assign(state, HELD);
  let refuse: (e: Error) => void = noop;
  hold = (r: (v: unknown) => void) => { refuse = (e: Error) => r(Promise.reject(e)); };
  out = fns.load();
  await turns();
  Object.assign(state, LANDED);
  $('missingBody').innerHTML = '<i>the new tree\'s statement</i>';
  refuse(new Error('Scan is still running — try again when it completes'));
  await out;
  assert.equal($('missingBody').innerHTML, '<i>the new tree\'s statement</i>', 'the older scan\'s failure is not said over the new tree');
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
  const { fns, asks } = page<{ run: (q: string) => Promise<void>; rejudge: () => void }>(['async function tmRunGrammarQuery(', 'function tmRejudgeQuery(', 'function tmNoScanQueryWords('], {
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
  assert.equal(messages.at(-1), 'The search runs on a finished scan — it runs once the scan finishes.', 'it says what the search waits for');
  Object.assign(state, INDEX_STOPPED);
  await fns.run('size>1gb');
  assert.equal(asks.length, before);
  assert.equal(messages.at(-1), 'Opened from the saved index — scan this folder to search it.', 'once nothing will land, what would make it searchable');
  state.root = null;
  await fns.run('size>1gb');
  assert.equal(messages.at(-1), 'Scan a folder first — there is nothing to search yet.', 'with no tree at all, as before');
});

/** The highlight box over a tree, with the Treemap's own mount and the query's scan bookkeeping. */
function queryPage(state: Record<string, unknown>, answer: (url: string, signal: AbortSignal) => Promise<unknown> | unknown) {
  const $ = stubDom();
  const messages: string[] = [];
  const reasked: string[] = [];
  const asks: Ask[] = [];
  const cleared: unknown[] = [];
  const given: Record<string, unknown> = {
    state, $, tmQuerySeq: 0, tmQueryAbort: null, tmQueryDeb: 0, tmLastHits: null, AbortController, clearTimeout: (t: unknown) => { cleared.push(t); },
    api: async (url: string, init: { body: string; signal: AbortSignal }) => { asks.push({ url, scanId: scanOf(url, init.body) }); return answer(url, init.signal); },
    tmSetQueryMessage: (m: string) => { messages.push(m); }, tmStageable: () => ({ paths: [] }), seedNodes: noop, tmSyncStageButton: noop,
    renderSearchOverlay: noop, presentView: noop, formatCount: String, tmUndrawnMessage: () => '', tmClearHits: noop,
    tmApplyQuery: (q: string) => { reasked.push(q); },
    fxTmPillBeamsSync: noop, loadTreemap: noop, loadSavedViews: noop, refreshDock: noop,
  };
  const { fns } = page<{ run: (q: string) => Promise<void>; mount: () => void; changed: () => void }>(
    ['async function tmRunGrammarQuery(', 'function tmRejudgeQuery(', 'function tmRejudgeQueryWait(', 'function tmNoScanQueryWords(', 'function tmQueryScanChanged(', 'function tmCancelQueries('],
    given, `{ run: tmRunGrammarQuery, mount: () => (${pageView('treemap')}).mount(), changed: tmQueryScanChanged }`);
  return { fns, messages, reasked, asks, given, cleared };
}

test('the highlight box\'s query typed over the saved index\'s tree is said again as that changes — "it runs once the scan finishes" once a scan of the folder starts, the saved index again after a Stop — and is asked of the scan that lands, never left saying "scan this folder" over a scanned one', async () => {
  const state: Record<string, unknown> = { root: TREE, ...INDEX_STOPPED, scanningPath: null, view: 'treemap',
    treemap: { rootPath: '/r', query: 'size>1gb', queryRoot: '/r', queryMode: 'bare', queryScanId: null, matches: 0, matchedPaths: null } };
  const { fns, messages, reasked, asks } = queryPage(state, () => ({ hits: [], total: 0 }));
  await fns.run('size>1gb');
  assert.equal(messages.at(-1), 'Opened from the saved index — scan this folder to search it.', 'control: a Stop left the saved index\'s tree');
  // The scan chrome begins for this folder: beginScanChrome re-enters the view (BQJ-1b (2)).
  Object.assign(state, { scanning: true, scanId: null, settledScanId: null, indexScanDue: false, scanningPath: '/r' });
  fns.mount();
  assert.equal(messages.at(-1), 'The search runs on a finished scan — it runs once the scan finishes.', 'once a scan of the folder starts, the box says the search waits for it — not "scan this folder"');
  Object.assign(state, INDEX_RUNNING); // the index painted, its scan answered
  fns.mount();
  assert.equal(messages.at(-1), 'The search runs on a finished scan — it runs once the scan finishes.');
  assert.deepEqual(asks, [], 'and nothing is asked of the running scan');
  // Stopped: stopScan re-enters the view.
  Object.assign(state, INDEX_STOPPED);
  fns.mount();
  assert.equal(messages.at(-1), 'Opened from the saved index — scan this folder to search it.', 'a Stop says the saved index again');
  assert.deepEqual(reasked, [], 'control: nothing to ask yet');
  // Scanned again, and it lands: finishScan re-enters the view, and the query is asked of the scan that landed.
  Object.assign(state, LANDED);
  fns.mount();
  assert.deepEqual(reasked, ['size>1gb'], 'once a scan lands, the query typed over the saved index is asked of it');
  // A query an earlier scan of this folder answered, its tree now behind the saved index's paint: its answer stands,
  // for a Stop puts that scan's tree back, and "it runs once the scan finishes" would then be untrue of it.
  Object.assign(state, INDEX_RUNNING);
  Object.assign(state.treemap as object, { queryMode: 'grammar', queryScanId: 'scan-old' });
  const said = messages.length;
  fns.mount();
  assert.equal(messages.length, said, 'a query an earlier scan answered keeps its answer over the saved index\'s paint');
});

test('the highlight box\'s query asked of the older scan during a rescan is not installed over the new tree when it answers after the rescan landed — the new scan is asked — and a scan of the same folder landing stops it on the server', async () => {
  const tm = () => ({ rootPath: '/r', query: 'used>1y', queryRoot: '/r', queryMode: 'bare', queryScanId: null, matches: 0, matchedPaths: null });
  let release: (v: unknown) => void = noop;
  const signals: AbortSignal[] = [];
  const state: Record<string, unknown> = { root: TREE, ...HELD, view: 'treemap', treemap: tm() };
  const held = queryPage(state, (_url, signal) => { signals.push(signal); return new Promise((r) => { release = r; }); });
  const out = held.fns.run('used>1y');
  await turns();
  assert.deepEqual(held.asks.map((a) => a.scanId), ['scan-old'], 'control: asked of the scan the tree on screen came from');
  Object.assign(state, LANDED); // finishScan: the new tree is on screen before the answer
  held.fns.mount(); // re-entered: the query is asked of the scan that landed
  assert.deepEqual(held.reasked, ['used>1y'], 'a query still out when the rescan lands is asked of the new scan');
  release({ hits: [{ path: '/r/old', name: 'old', size: 1 }], total: 1 });
  await out;
  const t = state.treemap as { queryScanId: unknown; matchedPaths: unknown };
  assert.notEqual(t.queryScanId, 'scan-old', 'the older scan\'s answer is not installed over the new tree');
  assert.equal(t.matchedPaths, null, 'nor its matches highlighted');
  // Its failure, landing after the rescan landed: said over no tree of its own.
  Object.assign(state, HELD, { treemap: tm() });
  let fail: (e: unknown) => void = noop;
  const failing = queryPage(state, () => new Promise((_r, reject) => { fail = reject; }));
  const failed = failing.fns.run('used>1y');
  await turns();
  Object.assign(state, LANDED);
  fail(new Error('Scan is still running'));
  await failed;
  assert.deepEqual(failing.messages, [], 'the older scan\'s failure is not said under the box over the new tree');

  // A query answered by this tree's scan, then another typed and stopped while out (leaving the Treemap,
  // tmCancelQueries): coming back, the text in the box is asked — not taken as answered by the earlier one.
  Object.assign(state, LANDED, { treemap: { ...tm(), query: 'used>2y', queryMode: 'grammar', queryScanId: 'scan-new' } });
  const left = queryPage(state, () => new Promise(noop));
  void left.fns.run('used>2y');
  await turns();
  (left.given as { tmQuerySeq: number }).tmQuerySeq++; // the unmount's tmCancelQueries
  left.fns.mount();
  assert.deepEqual(left.reasked, ['used>2y'], 'a query stopped while out is asked again when the map is shown');

  // TOPIC.scan for the same folder (tmQueryScanChanged): the query still out is stopped, here and on the server.
  Object.assign(state, HELD, { treemap: tm() });
  const again = queryPage(state, (_url, signal) => { signals.push(signal); return new Promise(noop); });
  void again.fns.run('used>1y');
  await turns();
  assert.equal(signals.at(-1)!.aborted, false, 'control: out');
  Object.assign(state, LANDED);
  again.given.tmQueryDeb = 7; // the next text, typed and waiting out its debounce
  again.fns.changed();
  assert.equal(signals.at(-1)!.aborted, true, 'a rescan of the same folder landing stops the older scan\'s query on the server');
  assert.deepEqual(again.cleared, [], 'and leaves the text being typed to run');
});

test('opening an archive or disk image on the map asks the scan the tree on screen came from — never the running scan, which answers 409', async () => {
  const $ = stubDom();
  const state: Record<string, unknown> = { root: TREE, ...HELD, pathIndex: new Map() };
  const { fns, asks } = page<{ open: (n: unknown) => Promise<void> }>(['async function expandContainerNode('], {
    state, $, loadTreemap: noop, toast: noop, formatCount: String, updateTmStatus: noop,
  }, '{ open: expandContainerNode }', () => ({ children: [], entryCount: 0, truncated: false }));
  await throughThePhases('Opening a container', state, asks, () => fns.open({ path: '/r/a.zip', name: 'a.zip' }), noop);
});

/* ───────────────────────────── the tree's nodes, Clean Up ───────────────────────────── */

test('a path the pruned tree left out is resolved by the scan the tree on screen came from — never the running scan — and its answer kept only for that tree', async () => {
  const state: Record<string, unknown> = { root: TREE, ...HELD, pathIndex: new Map(), nodeCache: new Map() };
  const { fns, asks } = page<{ ensure: (p: string[]) => Promise<void> }>(['async function ensureNodes('], { state },
    '{ ensure: ensureNodes }', () => ({ nodes: { '/r/deep/x': { path: '/r/deep/x', size: 5 } } }));
  await throughThePhases('Resolving a node', state, asks, () => fns.ensure(['/r/deep/x']), () => { (state.nodeCache as Map<string, unknown>).clear(); });
  // During a rescan over the older scan's tree, its answer is that tree's: kept.
  Object.assign(state, HELD);
  (state.nodeCache as Map<string, unknown>).clear();
  await fns.ensure(['/r/deep/x']);
  assert.ok((state.nodeCache as Map<string, unknown>).has('/r/deep/x'), 'and the answer is kept for the tree on screen, the running scan\'s id on hand notwithstanding');
  (state.nodeCache as Map<string, unknown>).clear();
  const before = asks.length;
  Object.assign(state, INDEX_RUNNING);
  await fns.ensure(['/r/deep/x']);
  assert.equal(asks.length, before, 'over the saved index\'s tree nothing is asked of the running scan');
  // Asked of the older scan during the rescan, answered once it landed: not kept for the new tree (review F1.11).
  Object.assign(state, HELD);
  let answerLate: (v: unknown) => void = noop;
  const late = page<{ ensure: (p: string[]) => Promise<void> }>(['async function ensureNodes('], { state },
    '{ ensure: ensureNodes }', () => new Promise((resolve) => { answerLate = resolve; }));
  const out = late.fns.ensure(['/r/deep/x']);
  await turns();
  assert.deepEqual(late.asks.map((a) => a.scanId), ['scan-old'], 'control: asked of the tree\'s scan');
  Object.assign(state, LANDED);
  answerLate({ nodes: { '/r/deep/x': { path: '/r/deep/x', size: 5 } } });
  await out;
  assert.equal((state.nodeCache as Map<string, unknown>).has('/r/deep/x'), false, 'the older scan\'s node is not kept for the new tree');
});

test('Clean Up: what a match takes on its disk, and the cloud-safe list, are asked of the scan the tree on screen came from — never the running scan', async () => {
  const state: Record<string, unknown> = { root: TREE, ...HELD };
  const onDisk = page<{ measure: (f: unknown[]) => Promise<Map<string, number>> }>(['async function cleanOnDiskOf('], {
    state, isCloudScan: () => false, CLEAN_ON_DISK_CHUNK: 2000,
  }, '{ measure: cleanOnDiskOf }', () => ({ providers: { onDisk: { available: true, values: { '/r/a': { bytes: 4 } } } } }));
  await throughThePhases('Clean Up\'s on-disk sizes', state, onDisk.asks, () => onDisk.fns.measure([{ path: '/r/a' }]), noop);
  const $ = stubDom();
  const cloud = page<{ render: () => Promise<void> }>(['async function renderCloudSafe('], { state, $, seedNodes: noop },
    '{ render: renderCloudSafe }', () => ({ totalCount: 0, groups: [] }));
  await throughThePhases('Clean Up\'s cloud-safe list', state, cloud.asks, cloud.fns.render, noop);
  for (const phase of [INDEX_RUNNING, INDEX_STOPPED]) {
    Object.assign(state, phase);
    // Another tree's list on screen, its tab up (review F1.10: the phases before had left the tab hidden already).
    $('cleanTabCloud').hidden = false;
    $('cloudResults').innerHTML = '<i>another tree\'s cloud-safe list</i>';
    const asked = onDisk.asks.length + cloud.asks.length;
    assert.equal((await onDisk.fns.measure([{ path: '/r/a' }])).size, 0, 'over the saved index\'s tree no on-disk size is known');
    await cloud.fns.render();
    assert.equal(onDisk.asks.length + cloud.asks.length, asked, 'and nothing is asked — not of the running scan');
    assert.equal($('cleanTabCloud').hidden, true, 'the cloud-safe tab claims nothing');
    assert.equal($('cloudResults').innerHTML, '', 'and another tree\'s list is not left under it');
  }
});

test('Clean Up: the cloud-safe list asked of the older scan during a rescan is not painted once the rescan has landed — nor its "still counting" or its failure — the list is asked again of the scan now on screen', async () => {
  const OLD = { totalCount: 1, totalSize: 9, groups: [{ provider: 'icloud', count: 1, totalSize: 9, files: [{ name: 'old.mov', path: '/r/old.mov', size: 9, modifiedAt: 0 }] }] };
  for (const outcome of ['list', 'still counting', 'fails'] as const) {
    const $ = stubDom();
    const state: Record<string, unknown> = { root: TREE, ...HELD };
    const held: Array<() => void> = [];
    const { fns, asks } = page<{ render: () => Promise<void> }>(['async function renderCloudSafe('], {
      state, $, seedNodes: noop, formatCount: String, formatBytes: (n: number) => `${n} B`, formatDate: String, escapeHtml: esc,
      chipFor: () => '', cartButtonHtml: () => '', refreshCartButtons: noop,
    }, '{ render: renderCloudSafe }', (url) => (url.includes('scan-new') ? { totalCount: 0, groups: [] } : new Promise((resolve, reject) => {
      held.push(() => (outcome === 'list' ? resolve(OLD)
        : reject(Object.assign(new Error(outcome === 'fails' ? 'Could not reach the server' : 'Scan is still running'), { stillWorking: outcome === 'still counting' }))));
    })));
    // The new tree's tab as its own state left it: hidden, nothing listed.
    $('cleanTabCloud').hidden = true;
    const out = fns.render(); // Clean Up opened during the rescan
    await turns();
    assert.deepEqual(asks.map((a) => a.scanId), ['scan-old'], `${outcome}: control: asked of the tree's scan, during the rescan`);
    Object.assign(state, LANDED); // finishScan, before the answer
    held[0]();
    await out;
    await turns();
    assert.doesNotMatch($('cloudResults').innerHTML, /old\.mov|Still counting|safe/, `${outcome}: the older scan's answer is not painted over the new tree`);
    assert.deepEqual(asks.map((a) => a.scanId), ['scan-old', 'scan-new'], `${outcome}: the list is asked again of the scan now on screen`);
    assert.equal($('cleanTabCloud').hidden, true, `${outcome}: and the tab is as that scan's answer leaves it — nothing online-only to list`);
  }
});

/* ───────────────────────────── the Dashboard's cards, the tour ───────────────────────────── */

test('the Dashboard\'s folder budgets, cost to keep and drive health are asked of the scan the tree on screen came from — never the running scan — and over the saved index\'s tree ask nothing', async () => {
  const $ = stubDom();
  const state: Record<string, unknown> = { root: TREE, view: 'dashboard', ...HELD, budgets: { list: [], overPaths: new Set(), gauges: new Map() } };
  const { fns, asks } = page<{ budgets: () => Promise<void>; cost: () => Promise<void>; health: () => Promise<void> }>(
    ['async function loadBudgets(', 'async function currentSavedBudgets(', 'async function loadCostEstimate(', 'async function loadDriveHealth('], {
      state, $, loadBudgetsSeq: 0, seedNodes: noop, renderBudgetWidget: noop, isSun: () => false, presentView: noop,
      skeletonRows: () => '<i>loading</i>', costMoney: () => '', costSavingHtml: () => '', fxBarStyle: () => '', formatBytes: String,
      escapeHtml: esc, FxNum: { rollHtml: noop }, fxBarsIn: noop,
      smartDeviceFor: () => null, topologyAnswer: async () => null, renderDriveHealth: noop, fxDriveGaugeDrop: noop,
    }, '{ budgets: loadBudgets, cost: loadCostEstimate, health: loadDriveHealth }',
    (url) => (url.includes('/budgets') ? { budgets: [] } : url.includes('budget-gauges') ? { gauges: [] }
      : url.includes('suggestions') ? { groups: [] } : url.includes('/cost/') ? { providers: [], asOf: '2026-10-01', approximate: false } : {}));
  await throughThePhases('The budgets', state, asks, fns.budgets, noop);
  await throughThePhases('Cost to keep', state, asks, fns.cost, noop);
  await throughThePhases('Drive health', state, asks, fns.health, noop);
  for (const [phase, words, said] of [[INDEX_RUNNING, COMING, 'it fills in once the scan finishes'], [INDEX_STOPPED, OPENED, 'the tree is the saved index']] as const) {
    // The last folder's figures on the cards, as a scan of it left them (review F1.12).
    $('costBody').innerHTML = '<div class="cost-row">another folder\'s prices</div>';
    $('driveHealthBody').innerHTML = '<div class="dh-kv">another folder\'s drive</div>';
    state.driveHealth = { available: true, smart: {} };
    state.budgets = { list: [{ path: '/other', overBy: 1 }], overPaths: new Set(['/other']), gauges: new Map([['/other', {}]]) };
    Object.assign(state, phase);
    const before = asks.length;
    await fns.budgets(); await fns.cost(); await fns.health();
    await turns();
    // What the person saved is asked for (GET /api/settings, review F2.1); no scan is.
    assert.deepEqual(asks.slice(before).filter((a) => a.url !== '/api/settings'), [], 'over the saved index\'s tree nothing is asked of a scan — not of the running scan');
    assert.match($('costBody').innerHTML, words, `Cost to keep says ${said} — not the last folder's prices beside this one's map`);
    assert.match($('driveHealthBody').innerHTML, words, `Drive health says ${said} — not the last folder's drive`);
    assert.equal(state.driveHealth, null, 'and the drive report it held goes: a re-entry of the Dashboard repaints from it');
    const b = state.budgets as { list: unknown[]; overPaths: Set<string>; gauges: Map<string, unknown> };
    assert.deepEqual([b.list, [...b.overPaths], b.gauges.size], [[], [], 0], 'the budget meters, and the map\'s over-budget borders, are no other scan\'s');
  }
});

test('a folder budget the person saved stays known over the saved index\'s tree — the right-click menu and the dialog still offer to edit and remove it — while the Dashboard\'s meters, which a scan measures, leave the card', async () => {
  const $ = stubDom();
  const measured = { path: '/r/mail', name: 'mail', actualBytes: 9, maxBytes: 10, overBy: 0 };
  const state: Record<string, unknown> = { root: TREE, view: 'dashboard', ...HELD,
    budgets: { list: [measured], overPaths: new Set(), gauges: new Map(), saved: null } };
  // Saved in settings: 5 GB on /r/mail, and a budget elsewhere no scan of /r measures.
  const SAVED = [{ path: '/r/mail', maxBytes: 5_000_000_000 }, { path: '/elsewhere', maxBytes: 1_000_000 }];
  const { fns, asks } = page<{ load: () => Promise<void>; budgetFor: (p: string) => { maxBytes: number } | null; dialog: (n: unknown) => void }>(
    ['function budgetFor(', 'async function loadBudgets(', 'async function currentSavedBudgets(', 'function renderBudgetWidget(', 'function fxBudgetGaugesDrop(', 'function openBudgetDialog('], {
      state, $, loadBudgetsSeq: 0, budgetGauges: [], seedNodes: noop, isSun: () => false, presentView: noop, nodeFor: () => null,
      formatBytes: (n: number) => `${n} B`, escapeHtml: esc, icon: () => '', budgetProjectionLine: () => '', budgetTarget: null,
      FxCharts: { gauge: () => ({ destroy: noop }), ramp: noop }, GB: 1e9, MB: 1e6, KB: 1e3, setTimeout: noop,
    }, '{ load: loadBudgets, budgetFor, dialog: openBudgetDialog }',
    (url) => (url === '/api/settings' ? { budgets: SAVED } : url.includes('budget-gauges') ? { gauges: [] } : { budgets: [measured] }));
  assert.equal(fns.budgetFor('/r/mail'), measured, 'control: over a tree its scan stands behind, the budget is the one that scan measured');
  for (const phase of [INDEX_RUNNING, INDEX_STOPPED]) {
    // The last folder's meters on the card, as a scan of it left them (review F1.12).
    $('budgetCard').hidden = false;
    $('budgetList').innerHTML = '<div class="budget-row">old: 9 B / 10 B</div>';
    Object.assign(state, phase);
    const before = asks.length;
    await fns.load();
    await turns();
    assert.equal($('budgetCard').hidden, true, 'the meters, a scan\'s measure, leave the card — not the last folder\'s beside this one\'s map (review F2.7)');
    assert.equal($('budgetList').innerHTML, '', 'and their rows with it');
    assert.deepEqual(asks.slice(before).map((a) => [a.url, a.scanId]), [['/api/settings', null]], 'what the person saved is asked for — of no scan');
    assert.equal(fns.budgetFor('/r/mail')?.maxBytes, 5_000_000_000, 'the saved budget is known: the right-click menu offers "Edit budget…" and "Remove budget" (review F2.1)');
    assert.equal(fns.budgetFor('/r/other'), null, 'control: a folder with none has none');
    fns.dialog({ path: '/r/mail', name: 'mail', type: 'dir', size: null });
    assert.deepEqual([$('budgetValue').value, $('budgetUnit').value], ['5', '1000000000'], 'the dialog opens on the saved 5 GB — not blank');
    assert.equal($('budgetRemoveBtn').style.display, '', 'and offers to remove it');
  }
  // A scan lands: what it measured is the budget again, and what was saved elsewhere is not offered as this tree's.
  Object.assign(state, LANDED);
  await fns.load();
  await turns();
  assert.equal(fns.budgetFor('/r/mail'), measured, 'once a scan stands behind the tree, its measured budget');
  assert.equal(fns.budgetFor('/elsewhere'), null, 'and nothing the saved list holds beyond it');
  // The settings read still out when a scan lands: its answer is not kept over the scanned tree.
  let release: (v: unknown) => void = noop;
  const slow = page<{ load: () => Promise<void>; budgetFor: (p: string) => unknown }>(
    ['function budgetFor(', 'async function loadBudgets(', 'async function currentSavedBudgets(', 'function renderBudgetWidget(', 'function fxBudgetGaugesDrop('], {
      state, $, loadBudgetsSeq: 0, budgetGauges: [], seedNodes: noop, isSun: () => false, presentView: noop,
      formatBytes: (n: number) => `${n} B`, escapeHtml: esc, icon: () => '', budgetProjectionLine: () => '', FxCharts: { gauge: () => ({ destroy: noop }), ramp: noop },
    }, '{ load: loadBudgets, budgetFor }',
    (url) => (url === '/api/settings' ? new Promise((resolve) => { release = resolve; }) : url.includes('budget-gauges') ? { gauges: [] } : { budgets: [measured] }));
  Object.assign(state, INDEX_RUNNING);
  const out = slow.fns.load();
  await turns();
  Object.assign(state, LANDED);
  await slow.fns.load();
  release({ budgets: SAVED });
  await out;
  await turns();
  assert.equal(slow.fns.budgetFor('/elsewhere'), null, 'a saved list asked for over the saved index\'s tree, answering once a scan landed, is not kept');
});

test('the Dashboard\'s cards keep no answer the older scan gives once the rescan has landed — folder budgets, cost to keep and drive health asked during a rescan and answered after it are not put over the new tree, nor their failures said there', async () => {
  const fresh = () => ({ list: [], overPaths: new Set(), gauges: new Map() });
  const old = { budgets: [{ path: '/r/old', name: 'old', actualBytes: 1, maxBytes: 2, overBy: 0 }], groups: [], gauges: [],
    providers: [{ bytes: 1, current: { tier: null } }], asOf: '2026-01-01', available: true, smart: { modelName: 'old' } };
  type Case = { name: string; fn: 'budgets' | 'cost' | 'health'; landsOn: string; fails?: boolean; asks: number; host?: string };
  const cases: Case[] = [
    { name: 'budgets', fn: 'budgets', landsOn: '/budgets', asks: 1 },
    { name: 'cost to keep, landing while its what-if is asked', fn: 'cost', landsOn: '/cleanup/suggestions', asks: 1 },
    { name: 'cost to keep, landing while its prices are asked', fn: 'cost', landsOn: '/cost/estimate', asks: 2 },
    { name: 'cost to keep, failing once landed', fn: 'cost', landsOn: '/cost/estimate', fails: true, asks: 2, host: 'costBody' },
    { name: 'drive health', fn: 'health', landsOn: '/health/smart', asks: 1 },
    { name: 'drive health, failing once landed', fn: 'health', landsOn: '/health/smart', fails: true, asks: 1, host: 'driveHealthBody' },
  ];
  for (const c of cases) {
    const $ = stubDom();
    const state: Record<string, unknown> = { root: TREE, view: 'dashboard', ...HELD, budgets: fresh(), cost: null, driveHealth: null };
    const { fns, asks } = page<Record<'budgets' | 'cost' | 'health', () => Promise<void>>>(
      ['async function loadBudgets(', 'async function currentSavedBudgets(', 'async function loadCostEstimate(', 'async function loadDriveHealth('], {
        state, $, loadBudgetsSeq: 0, seedNodes: noop, renderBudgetWidget: noop, isSun: () => false, presentView: noop,
        skeletonRows: () => '<i>loading</i>', costMoney: () => '', costSavingHtml: () => '', fxBarStyle: () => '', formatBytes: String,
        escapeHtml: esc, FxNum: { rollHtml: noop }, fxBarsIn: noop,
        smartDeviceFor: () => null, topologyAnswer: async () => null, renderDriveHealth: noop, fxDriveGaugeDrop: noop,
      }, '{ budgets: loadBudgets, cost: loadCostEstimate, health: loadDriveHealth }', (url) => {
        if (!url.includes(c.landsOn)) return old;
        Object.assign(state, LANDED); // finishScan put the new tree on screen while this was out
        if (c.fails) throw new Error('Scan is still running — try again when it completes');
        return old;
      });
    if (c.host) $(c.host).innerHTML = '<i>the new tree\'s card</i>';
    await fns[c.fn]();
    await turns();
    assert.equal(asks[0].scanId, 'scan-old', `${c.name}: control: asked of the tree's scan, during the rescan`);
    assert.equal(asks.length, c.asks, `${c.name}: nothing more is asked of the older scan once the new tree is on screen`);
    const kept = { budgets: (state.budgets as { list: unknown[] }).list.length ? state.budgets : null, cost: state.cost, health: state.driveHealth }[c.fn];
    assert.equal(kept, null, `${c.name}: the older scan's answer is not kept once the new tree is on screen`);
    if (c.host) assert.equal($(c.host).innerHTML, '<i>the new tree\'s card</i>', `${c.name}: its failure is not said over the new tree's card`);
  }
});

test('Cost to keep, waiting on a landed scan\'s list walk when another folder is opened from its saved index, leaves the index paint\'s words standing — not "Run a scan to see…" over a folder on screen', async () => {
  const $ = stubDom();
  const state: Record<string, unknown> = { root: TREE, ...LANDED };
  const { fns, asks } = page<{ cost: (after?: Promise<unknown>) => Promise<void> }>(['async function loadCostEstimate('], {
    state, $, skeletonRows: () => '<i>loading</i>', costMoney: () => '', costSavingHtml: () => '', fxBarStyle: () => '', formatBytes: String,
    escapeHtml: esc, FxNum: { rollHtml: noop }, fxBarsIn: noop,
  }, '{ cost: loadCostEstimate }', () => ({ groups: [], providers: [], asOf: '2026-01-01' }));
  let listsAnswer: (v: unknown) => void = noop;
  const out = fns.cost(new Promise((resolve) => { listsAnswer = resolve; })); // finishScan: the card waits on the lists' walk
  await turns();
  // Another folder opened from its saved index meanwhile (finishScan's index branch): its card says what it waits for.
  Object.assign(state, { root: { path: '/other', name: 'other', size: 1 }, scanning: false, scanId: null, settledScanId: null, indexScanDue: true });
  await fns.cost();
  assert.match($('costBody').innerHTML, COMING, 'control: the index paint\'s card says it fills in once the scan finishes');
  listsAnswer(true);
  await out;
  assert.match($('costBody').innerHTML, COMING, 'the landed scan\'s card, superseded, leaves those words standing');
  assert.equal(asks.length, 0, 'and asks nothing');
  // Superseded by a newer scan's tree instead, it settles on its own empty state as before (review of U-16, finding 3).
  Object.assign(state, { root: TREE, ...LANDED });
  let again: (v: unknown) => void = noop;
  const later = fns.cost(new Promise((resolve) => { again = resolve; }));
  await turns();
  Object.assign(state, { scanId: 'scan-newer', settledScanId: 'scan-newer' });
  again(true);
  await later;
  assert.match($('costBody').innerHTML, /Run a scan to see what this data would cost to keep online/, 'control: a newer scan\'s tree: the card\'s own empty state, unchanged');
});

test('a Stop or a failure that leaves the saved index\'s tree on screen says the Dashboard\'s scan-backed cards again — the saved index\'s now, not "fills in once the scan finishes" — and one that leaves a scanned tree asks nothing again', () => {
  const asked: string[] = [];
  const state: Record<string, unknown> = { root: TREE, ...INDEX_STOPPED, largest: [], bigFolders: [], types: [], scanStats: null, donut: {} };
  // Focus on a budget's Edit button, which the budgets card takes away as it says the saved index (review F2.5).
  const landing = { focused: 0, focus() { this.focused++; }, getClientRects: () => [{}] };
  const edit = { gone: false, getClientRects() { return this.gone ? [] : [{}]; } };
  const document = { activeElement: edit as unknown, body: {} };
  const { fns } = page<{ restore: () => void }>(['function restoreDashboardPanels(', 'function withFocusKept('], {
    state, $: stubDom(), renderBigFiles: noop, renderBigFolders: noop, renderDonut: noop, clearDonut: noop, fxDonutLoadingSync: noop,
    renderDiskNotes: noop, countUp: noop, formatBytes: String, renderGrowthProjection: noop, document, focusLanding: () => landing,
    loadCostEstimate: () => { asked.push('cost'); }, loadDriveHealth: () => { asked.push('health'); },
    loadBudgets: () => { asked.push('budgets'); edit.gone = true; },
  }, '{ restore: restoreDashboardPanels }');
  fns.restore(); // stopScan, failScan, quietRescanFailed
  assert.deepEqual(asked.sort(), ['budgets', 'cost', 'health'], 'over the saved index\'s tree each card is said again');
  assert.equal(landing.focused, 1, 'and focus on a control the budgets card took away moves on — not to <body> (review F2.5)');
  asked.length = 0;
  Object.assign(state, STOPPED);
  fns.restore();
  assert.deepEqual(asked, [], 'over a tree its scan stands behind, the cards it painted stand');
});

test('the welcome tour\'s cleanup wins are asked of the scan the tree on screen came from — never the running scan — and over the saved index\'s tree, its scan running, the card waits on the map and asks once that scan lands; with nothing coming it says why there is nothing to suggest, and asks once a scan lands', async () => {
  const tour: Record<string, unknown> = { active: true, step: 'map', wins: [], winIx: 0, unknownReason: '', winsAwaitScan: false };
  const state: Record<string, unknown> = { root: TREE, ...HELD, scanRefused: null, scanningPath: '/r' };
  const renders: string[] = [];
  const focused: unknown[] = [];
  let cardHoldsFocus = true;
  let landed: () => void = noop;
  const { fns, asks } = page<{ wins: () => Promise<void>; started: () => void; failed: () => void }>(
    ['async function tourLoadWins(', 'function tourRejudgeWins(', 'function tourScanStarted(', 'function tourScanFailed(', 'subscribe(TOPIC.scan, () => {\n  if (tour.deferred'], {
      state, tour, tourRender: (takeFocus?: boolean) => { renders.push(String(tour.step)); focused.push(takeFocus); }, refusedFolderWords: () => '',
      subscribe: (_topic: unknown, fn: () => void) => { landed = fn; }, TOPIC: { scan: 'scan' }, switchView: noop, queueMicrotask: noop,
      $: () => ({ contains: () => cardHoldsFocus }), document: { activeElement: null },
    }, '{ wins: tourLoadWins, started: tourScanStarted, failed: tourScanFailed }', () => ({ groups: [] }));
  await throughThePhases('The tour\'s wins', state, asks, fns.wins, () => { tour.step = 'map'; });

  // The saved index's tree, its scan running: nothing asked; the card stays on the map, saying the wins wait for it.
  const before = asks.length;
  Object.assign(state, INDEX_RUNNING);
  tour.step = 'map';
  await fns.wins();
  assert.equal(asks.length, before, 'over the saved index\'s tree nothing is asked — not of the running scan');
  assert.equal(tour.step, 'map', 'the card stays on the map — not a dead-end "still running" card with only Finish');
  assert.equal(tour.winsAwaitScan, true, 'it waits for the scan');
  Object.assign(state, LANDED); // finishScan, then TOPIC.scan
  landed();
  await turns();
  assert.deepEqual(asks.slice(before).map((a) => a.scanId), ['scan-new'], 'once the scan lands, the wins are asked of it');
  assert.equal(tour.step, 'clean', 'and the card says what they are');
  assert.equal(tour.winsAwaitScan, false);
  assert.equal(focused.at(-1), true, 'the card held focus: it keeps it, on what it now offers');

  // Waiting, then a Stop puts the older tree back (putBackHeldTree emits TOPIC.scan): asked of that tree's scan.
  Object.assign(state, INDEX_RUNNING);
  tour.step = 'map';
  await fns.wins();
  const put = asks.length;
  Object.assign(state, STOPPED);
  landed();
  await turns();
  assert.deepEqual(asks.slice(put).map((a) => a.scanId), ['scan-old'], 'a Stop that puts the older tree back: asked of its scan');
  cardHoldsFocus = false;
  Object.assign(state, INDEX_RUNNING);
  tour.step = 'map';
  await fns.wins();
  Object.assign(state, LANDED);
  landed();
  await turns();
  assert.equal(focused.at(-1), false, 'focus elsewhere — the map, a field — is not pulled to the card when a scan lands');
  cardHoldsFocus = true;

  // Nothing coming: said; a scan of the folder starting, a Stop, and its landing each re-judge the card.
  const quiet = asks.length;
  Object.assign(state, INDEX_STOPPED);
  tour.step = 'map';
  await fns.wins();
  assert.equal(asks.length, quiet);
  assert.equal(tour.step, 'unknown');
  assert.equal(tour.unknownReason, 'This folder was opened from its saved index, and suggestions need a scan of it.');
  Object.assign(state, { scanning: true, scanId: null, settledScanId: null, indexScanDue: false, scanningPath: '/r' });
  fns.started(); // beginScanChrome
  await turns();
  assert.equal(tour.step, 'map', 'a scan of the folder starting: the card waits for it — "needs a scan of it" is no longer true');
  Object.assign(state, INDEX_STOPPED);
  fns.failed(); // stopScan, failScan, quietRescanFailed
  await turns();
  assert.deepEqual([tour.step, tour.unknownReason], ['unknown', 'This folder was opened from its saved index, and suggestions need a scan of it.'],
    'a Stop: nothing will land, said again');
  Object.assign(state, LANDED);
  landed();
  await turns();
  assert.deepEqual(asks.slice(quiet).map((a) => a.scanId), ['scan-new'], 'a scan of it landing later: the wins are asked of it');
  assert.equal(tour.step, 'clean');
  // A card that never waited is left where it is by a scan landing (only the welcome and scanning steps move).
  tour.step = 'cart';
  landed();
  assert.equal(tour.step, 'cart', 'control: a card that asked for nothing is not moved');
  // A tour finished while its wins waited asks nothing when a scan starts or stops.
  Object.assign(tour, { active: false, winsAwaitScan: true, step: 'map' });
  const done = asks.length;
  Object.assign(state, LANDED);
  fns.started();
  fns.failed();
  await turns();
  assert.equal(asks.length, done, 'a finished tour asks for no wins');
});

test('the welcome tour\'s cleanup wins asked of the older scan during a rescan are not shown once the rescan has landed — nor its refusal or its failure — the card is asked again of the scan now on screen', async () => {
  const OLD = { groups: [{ title: 'old-cache', advisory: false, totalSize: 9_000_000_000, items: [{ path: '/r/old' }] }] };
  const NEW = { groups: [{ title: 'new-cache', advisory: false, totalSize: 1_000_000_000, items: [{ path: '/r/new' }] }] };
  for (const outcome of ['wins', 'refused', 'fails', 'finished'] as const) {
    const tour: Record<string, unknown> = { active: true, step: 'map', wins: [], winIx: 0, unknownReason: '', winsAwaitScan: false };
    const state: Record<string, unknown> = { root: TREE, ...HELD, scanRefused: null, scanningPath: '/r' };
    const held: Array<() => void> = [];
    const { fns, asks } = page<{ wins: () => Promise<void> }>(['async function tourLoadWins('], {
      state, tour, tourRender: noop, refusedFolderWords: () => '',
    }, '{ wins: tourLoadWins }', (url) => (url.includes('scan-new') ? NEW : new Promise((resolve, reject) => {
      held.push(() => (outcome === 'fails' ? reject(new Error('Could not reach the server'))
        : resolve(outcome === 'refused' ? { available: false, reason: 'The rule catalog could not be read.' } : OLD)));
    })));
    const out = fns.wins(); // "Show me what I could free", pressed on the map card during the rescan
    await turns();
    assert.deepEqual(asks.map((a) => a.scanId), ['scan-old'], `${outcome}: control: asked of the tree's scan, during the rescan`);
    Object.assign(state, LANDED); // finishScan: the new tree is on screen before the answer
    if (outcome === 'finished') tour.active = false; // Finish pressed while the answer was out
    held[0]();
    await out;
    await turns();
    if (outcome === 'finished') {
      assert.equal(asks.length, 1, 'a tour finished meanwhile asks for no wins again');
      continue;
    }
    assert.deepEqual(asks.map((a) => a.scanId), ['scan-old', 'scan-new'], `${outcome}: the card is asked again of the scan now on screen`);
    assert.deepEqual([tour.step, (tour.wins as Array<{ title: string }>).map((g) => g.title), tour.unknownReason], ['win', ['new-cache'], ''],
      `${outcome}: what the card says is the new tree's — not the older scan's answer over it`);
  }
});

test('the welcome tour started, or restarted from Settings, over a tree no scan stands behind starts at the map — the tree is on screen — and the restart puts the map on screen', async () => {
  const tour: Record<string, unknown> = { active: false, booted: true, wanted: false, deferred: false };
  const switched: string[] = [];
  let press: () => void = noop;
  const state: Record<string, unknown> = { root: TREE, view: 'dashboard', scannedBefore: true, ...INDEX_STOPPED };
  const { fns } = page<{ start: (done: unknown, o?: unknown) => void }>(['function tourMaybeStart(', "$('tourResetBtn').addEventListener('click', () => {"], {
    state, tour, tourRender: noop, toast: noop, closeModal: noop, switchView: (v: string) => { switched.push(v); },
    $: () => ({ addEventListener: (_t: string, fn: () => void) => { press = fn; } }),
  }, '{ start: tourMaybeStart }', () => ({}));
  for (const [name, phase, root, want] of [
    ['the saved index\'s tree, a Stop or a failure left on screen', INDEX_STOPPED, TREE, 'map'],
    ['the saved index\'s tree, its scan running', INDEX_RUNNING, TREE, 'map'],
    ['a scanned tree', STOPPED, TREE, 'map'],
    ['a first scan running, no tree yet', { ...HELD, settledScanId: null }, null, 'scanning'],
    ['nothing on screen', INDEX_STOPPED, null, 'welcome'],
  ] as const) {
    Object.assign(state, phase, { root });
    tour.active = false;
    fns.start(false, { asked: true });
    assert.equal(tour.step, want, `${name}: the tour starts at the ${want} card`);
  }
  Object.assign(state, INDEX_STOPPED, { root: TREE, view: 'dashboard' });
  press(); // Settings › Show the welcome tour again
  await turns();
  assert.deepEqual(switched, ['treemap'], 'the restart puts the map it narrates on screen — the tree is there, scan or none');
  assert.equal(tour.step, 'map', 'and the card it restarts at is the map');
});

/* ───────────────────────────── expired results ───────────────────────────── */

test('the older scan\'s results expiring during a rescan read as a sentence — the views ask that scan, and its 404 said "Unknown or expired scanId" — with no Scan again offered over the scan under way; at rest the sentence offers one, once', () => {
  const offers: string[] = [];
  const state: Record<string, unknown> = { root: TREE, ...HELD, expiredOffered: null };
  const { fns } = page<{ expired: (e: { message: string }, url: string) => void }>(['function scanResultsExpired('], {
    state, toastAction: (m: string) => { offers.push(m); }, startScan: noop,
  }, '{ expired: scanResultsExpired }');
  const notFound = () => ({ code: 'SCAN_NOT_FOUND', status: 404, message: 'Unknown or expired scanId' });
  // During a rescan over the older scan's tree: every view asks that scan (treeScanId), and it expired.
  const e1 = notFound();
  fns.expired(e1, '/api/apps?scanId=scan-old');
  assert.equal(e1.message, 'These results have expired — the scan under way replaces them when it finishes.',
    'the older scan\'s 404 reads as what it means — not "Unknown or expired scanId"');
  assert.deepEqual(offers, [], 'and no Scan again is offered over the scan already under way');
  const e2 = notFound();
  fns.expired(e2, '/api/scan/scan-new/stats');
  assert.equal(e2.message, 'Unknown or expired scanId', 'control: an id that is not the tree\'s is not rewritten');
  // The saved index's tree: no scan behind it, nothing of its own to expire.
  Object.assign(state, INDEX_RUNNING);
  const e3 = notFound();
  fns.expired(e3, '/api/apps?scanId=scan-new');
  assert.equal(e3.message, 'Unknown or expired scanId', 'over the saved index\'s tree the running scan\'s id is not the tree\'s');
  // At rest — after a Stop, the older tree's: the sentence, and Scan again offered once.
  Object.assign(state, STOPPED);
  const e4 = notFound();
  fns.expired(e4, '/api/apps?scanId=scan-old');
  fns.expired(notFound(), '/api/media?scanId=scan-old');
  assert.equal(e4.message, 'These results have expired — scan the folder again to refresh them.', 'at rest it says to scan again');
  assert.deepEqual(offers, ['These results have expired — scan the folder again to refresh them.'], 'and offers it once, however many calls fail');
});

test('the tree\'s scan expiring reads as a sentence when a request names it in its body — the highlight box\'s query and opening an archive POST their scan, and api() judged the URL alone, leaving "Unknown or expired scanId" under the box, during a rescan and at rest (review F3.2)', async () => {
  const DURING = 'These results have expired — the scan under way replaces them when it finishes.';
  const AT_REST = 'These results have expired — scan the folder again to refresh them.';
  const RAW = 'Unknown or expired scanId';
  const offers: string[] = [];
  const state: Record<string, unknown> = { root: TREE, ...HELD, expiredOffered: null };
  // The server, as it answers a scan it no longer holds (POST /api/query, execute.ts; every scanId-keyed route).
  const fetch = async () => ({ status: 404, ok: false, text: async () => JSON.stringify({ error: RAW, code: 'SCAN_NOT_FOUND' }) });
  const { fns } = page<{ api: (url: string, init?: unknown) => Promise<unknown> }>(['async function api(url', 'function scanResultsExpired('], {
    state, fetch, setTimeout, toastAction: (m: string) => { offers.push(m); }, startScan: noop,
  }, '{ api }');
  /** What the page says of a request the server answered 404 SCAN_NOT_FOUND: its URL, and its POST body when it has one. */
  const said = async (url: string, body?: unknown): Promise<string> => {
    try {
      await fns.api(url, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) });
    } catch (e) { return (e as Error).message; }
    return assert.fail(`${url} answered`);
  };
  // During a rescan over the older scan's tree: the views ask that scan, and it expired.
  assert.equal(await said('/api/query', { scanId: 'scan-old', q: 'size>1gb' }), DURING, 'the highlight box\'s query, its scan in the body, reads as what it means');
  assert.equal(await said('/api/container/expand', { scanId: 'scan-old', path: '/r/a.zip' }), DURING, 'and opening an archive on the map');
  assert.equal(await said('/api/apps?scanId=scan-old'), DURING, 'control: a scan named in the URL, as before');
  assert.equal(await said('/api/query', { scanId: 'scan-new', q: 'size>1gb' }), RAW, 'a body naming another scan is not the tree\'s: its 404 is not rewritten');
  assert.equal(await said('/api/facts', { paths: ['/r/scan-old'], providers: ['size'] }), RAW, 'nor a body that names no scan, whatever its paths spell');
  assert.equal(await said('/api/query', 'scan-old'), RAW, 'nor a body that is not JSON');
  assert.deepEqual(offers, [], 'no Scan again is offered over the scan under way');
  // At rest, after a Stop: the older tree's scan, and Scan again offered once.
  Object.assign(state, STOPPED);
  assert.equal(await said('/api/query', { scanId: 'scan-old', q: 'size>1gb' }), AT_REST, 'at rest the query\'s 404 says to scan again');
  assert.equal(await said('/api/container/expand', { scanId: 'scan-old', path: '/r/a.zip' }), AT_REST, 'and the archive\'s');
  assert.deepEqual(offers, [AT_REST], 'Scan again is offered once, however many fail');
});

/* ───────────────────────────── Live mode ───────────────────────────── */

test('Live: the toggle watches the scan the tree on screen came from once it has landed — never a scan still walking, which answers its watch 409 — and pressed while a scan runs says Live starts once the scan finishes, and finishScan starts it; over the saved index\'s tree it says what would make the folder watchable', () => {
  const watched: string[] = [];
  const toasts: Array<[string, string | undefined]> = [];
  let press: () => void = noop;
  const els = stubDom();
  const $ = (id: string) => {
    const e = els(id);
    if (id === 'tmLiveToggle') e.addEventListener = ((_type: string, fn: () => void) => { press = fn; }) as El['addEventListener'];
    return e;
  };
  class Watch { readyState = 0; onmessage = null; onerror = null; static CLOSED = 2; constructor(url: string) { watched.push(url); } close(): void {} }
  const state: Record<string, unknown> = {
    root: TREE, view: 'dashboard', ...HELD,
    live: { on: false, wanted: false, es: null, window: [], dirty: 0, pulses: new Set(), pulseRaf: 0, feedTimer: 0, relayoutTimer: 0 },
    treemap: { history: { active: false }, rootPath: '/r' },
  };
  const { fns } = page<{ enable: () => void; disable: () => void }>(['function enableLive(', 'function disableLive(', 'function liveQueuedSync(', "$('tmLiveToggle').addEventListener('click', () => {"], {
    state, $, EventSource: Watch, isCloudScan: () => false, toast: (m: string, k?: string) => { toasts.push([m, k]); },
    fxTmPillBeamsSync: noop, fxLiveLineDrop: noop, setInterval: () => 0, clearInterval: noop, cancelAnimationFrame: noop,
    renderLiveFeed: noop, liveRelayout: noop, LIVE_RELAYOUT_MS: 1, setHistoryIndex: noop, presentView: noop,
  }, '{ enable: enableLive, disable: disableLive }');
  const live = state.live as { on: boolean; wanted: boolean };

  // A rescan over the older scan's tree, its request answered: the running scan's id is on hand.
  press();
  assert.deepEqual(watched, [], 'pressed during a rescan, no watch is opened on the scan still walking (it answers 409 SCAN_RUNNING)');
  assert.deepEqual(toasts.at(-1), ['Live mode starts once the scan finishes.', undefined], 'it says when Live starts — not an error');
  assert.equal(live.wanted, true, 'and keeps the wish, for finishScan');
  const pill = $('tmLiveToggle');
  assert.deepEqual([pill.cls.has('queued'), pill.attrs['aria-pressed']], [true, 'true'], 'the pill shows the wish — pressed, its dot lit — not a toast alone (review F2.14)');
  assert.equal(pill.cls.has('active'), false, 'and not as Live running');
  press(); // pressed again while the scan still runs
  assert.equal(live.wanted, false, 'pressed again, the wish goes');
  assert.deepEqual([pill.cls.has('queued'), pill.attrs['aria-pressed']], [false, 'false'], 'and the pill shows it gone');
  assert.deepEqual(toasts.at(-1), ['Live mode will not start when the scan finishes.', undefined], 'said, as the first press was');
  press(); // wished for again
  fns.enable(); // a stray caller while the scan runs
  assert.deepEqual(watched, [], 'Live opens no watch while a scan runs, whoever asks');
  Object.assign(state, LANDED); // finishScan: `if (state.live.wanted) enableLive()`
  fns.enable();
  assert.deepEqual(watched, ['/api/watch/scan-new'], 'once the rescan lands, Live watches the new scan');
  assert.equal(live.on, true);
  assert.deepEqual([pill.cls.has('queued'), pill.cls.has('active'), pill.attrs['aria-pressed']], [false, true, 'true'], 'and the pill shows Live running, no longer waiting');
  press(); // off
  assert.equal(live.on, false, 'control: pressed again, Live is off');

  Object.assign(state, STOPPED);
  press();
  assert.deepEqual(watched.slice(1), ['/api/watch/scan-old'], 'after a Stop, the older scan whose tree is on screen');
  press();

  // The saved index's tree, its scan running: nothing to watch yet; Live starts when it lands.
  live.wanted = false;
  Object.assign(state, INDEX_RUNNING);
  press();
  assert.deepEqual(watched.slice(2), [], 'over the saved index\'s tree no watch is opened on its running scan');
  assert.deepEqual(toasts.at(-1), ['Live mode starts once the scan finishes.', undefined]);
  assert.equal(live.wanted, true);
  // A cloud account's scan running over the local tree: Live never watches a cloud tree, so it promises nothing.
  live.wanted = false;
  Object.assign(state, HELD, { scanningPath: 'cloud://gdrive' });
  press();
  assert.deepEqual(toasts.at(-1), ['Live mode watches your local disk — cloud accounts can’t stream changes', 'error'],
    'a cloud account\'s scan running: Live will not start when it lands, and it says why');
  assert.equal(live.wanted, false, 'nor is it wished for');
  // Stopped: nothing will land.
  live.wanted = false;
  Object.assign(state, INDEX_STOPPED, { scanningPath: null });
  press();
  assert.deepEqual(watched.slice(2), [], 'nor once that scan is stopped');
  assert.deepEqual(toasts.at(-1), ['Opened from the saved index — scan this folder to watch it live.', undefined],
    'it says the tree is the saved index, and what would make it watchable — not "Run a scan first" as an error over a folder on screen');
  assert.equal(live.wanted, false, 'and promises nothing');
});

/* ───────────────────────────── the audit, held ───────────────────────────── */

/**
 * The page functions that ask the server something and still read
 * state.scanId — the scan on hand, which is the running scan's id once its
 * request answers — each for its reason. Everything else that asks about the
 * tree on screen goes through treeScanId (BQJ-1b's audit). A new function
 * that reads state.scanId beside a request fails here until it is routed, or
 * added with its reason.
 */
const SCAN_ON_HAND: Record<string, string> = {
  // The scan's own lifecycle: following, stopping, finishing or reopening the scan itself.
  showFinishedAfterStop: 'reads the scan a Stop proved had finished, by its own id',
  openFromIndex: 'clears the scan on hand for the saved index\'s tree',
  followScanProgress: 'follows the running scan — its stream and its watchdog',
  reopenScan: 'reopens the scan the server still holds at boot',
  // The Dashboard's own cards for the scan that just landed: run by finishScan or TOPIC.scan once no
  // scan runs, blanked when one starts, and a late answer is dropped once another scan is on hand.
  loadDashboardLists: 'the lists finishScan paints for the scan that landed; a scan starting blanks them',
  loadWhatsNew: 'files the landed scan\'s coverage under its own id',
  loadBoundary: 'the landed scan\'s drives row (TOPIC.scan), dropped once another scan is on hand',
  probeRefusedFolders: 'the landed scan\'s refused folders (TOPIC.scan)',
  openRefusedList: 'the refused row describes the scan whose stats painted it — the running scan\'s progress while one runs',
  // Live mode watches a landed scan: startScan turns it off, enableLive refuses while any scan runs, and
  // this returns while one does — so the scan on hand is the tree's own here.
  liveRelayout: 'Live mode, off while a scan runs',
  // Refuses while a scan runs, before asking anything.
  downloadReport: 'refuses in words while a scan runs, before it asks',
  // Acts on files: the server refuses a running scan in words ("Wait for the scan to finish"), and a
  // move or a trash against the older scan while a walk runs would race the rescan the move starts.
  cloudTrashPaths: 'a destructive act the server refuses for a running scan, in words',
  confirmOffloadPlan: 'a destructive act the server refuses for a running scan, in words',
  runOffloadJob: 'a destructive act the server refuses for a running scan, in words',
  // 220-clean-up-modal.js is BQL-b1's file in this batch: only cleanOnDiskOf's key was routed here.
  loadVideoCandidates: 'Clean Up (220), left for after BQL-b1',
  loadEmptyFolders: 'Clean Up (220), left for after BQL-b1',
  renderGitRepos: 'Clean Up (220), left for after BQL-b1',
  renderPackageOrphans: 'Clean Up (220), left for after BQL-b1',
  renderBrowserProfiles: 'Clean Up (220), left for after BQL-b1',
  loadSmartSuggestions: 'Clean Up (220), left for after BQL-b1',
  findBySavedView: 'Clean Up (220), left for after BQL-b1',
  // Top-level statements (review F1.8), named by their first line.
  "$('cleanFindBtn').addEventListener('click', async () => {": 'Clean Up (220): its Find button, left for after BQL-b1',
};

test('no page function or top-level handler that asks the server reads the scan on hand, but those whose reason is stated — every other ask about the tree on screen goes through treeScanId', () => {
  const asks = (body: string) => /\b(?:api|apiPaced|fetch)\(|new EventSource\(/.test(body);
  const fns = pageFunctions();
  const asking = [
    ...fns.filter((f) => /state\.scanId\b/.test(f.body) && asks(f.body)).map((f) => f.name),
    // Event handlers and subscribers are no function declarations: seen too (review F1.8).
    ...pageStatementsReading(fns).filter((st) => asks(st.body)).map((st) => st.name),
  ];
  const unlisted = asking.filter((n) => !(n in SCAN_ON_HAND));
  assert.deepEqual(unlisted, [], `these ask the server and read state.scanId, the running scan's id once its request answers: ${unlisted.join(', ')}`);
  const gone = Object.keys(SCAN_ON_HAND).filter((n) => !asking.includes(n));
  assert.deepEqual(gone, [], `listed as reading the scan on hand, but no longer do (take them off the list): ${gone.join(', ')}`);
});
