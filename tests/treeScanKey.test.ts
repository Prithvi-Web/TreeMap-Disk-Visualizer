import { test } from 'node:test';
import assert from 'node:assert/strict';

import { INDEX, lift as liftPage } from './fixtures/liftFrontend';

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
  for (const typed of ['~/Documents', '/Users/x/Documents/', '/Users/x//Documents', '/Users/x/Pictures/../Documents', '/Users/x/./Documents', '/users/X/documents',
    '  /Users/x/Documents', '\t~/Documents']) {
    assert.equal(comingFor(typed), true, `"${typed}" is a scan of the folder on screen (macOS folds case; leading whitespace off, review F3.6)`);
  }
  for (const typed of ['/Users/x/Desktop', '~/Desktop', 'Documents', '/Users/x/Documents/sub', '/Users/x/Documents ', '  /Users/x/Desktop']) {
    assert.equal(comingFor(typed), false, `"${typed}" is not`);
  }
  state.root = { path: '/Users/x', name: 'x', size: 1 };
  assert.equal(comingFor('~'), true, '"~" alone is the home folder: a scan of it over the home folder\'s saved index is a scan of the folder on screen (review F3.6)');
  state.root = { path: '/Users/x/Documents', name: 'Documents', size: 1 };
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

test('Duplicates: a search belongs to the scan the tree on screen came from — once another tree is on screen without a new search (another folder opened from its saved index, or the rescan landing while its lists load), the older scan\'s groups, failure or progress are not installed and its poll asks no more, though nothing reset the finder (review F3.7)', async () => {
  const OTHER = { path: '/b', name: 'b', size: 5 };
  // finishScan's index paint resets the exact finder and never the similar-image one ("state.near outlives a
  // scan"); its landing reaches the view only after the lists answer. Here neither finder is reset.
  const changes = [
    ['another folder opened from its saved index', STOPPED, { ...INDEX_RUNNING, root: OTHER }],
    ['the rescan landing, before the view is re-entered', HELD, LANDED],
  ] as const;
  for (const finder of ['exact', 'near'] as const) {
    for (const [how, from, to] of changes) {
      for (const kind of ['groups', 'failure', 'progress', 'a poll due'] as const) {
        const state: Record<string, unknown> = { root: TREE, dupMode: finder, dup: freshDup(), near: freshNear(), ...from };
        const held: Array<() => void> = [];
        const timers: Array<() => void> = [];
        let painted = 0;
        const progress = { status: 'running', hashed: 1, toHash: 4 };
        let polls = 0;
        const { fns, asks, $ } = dupPage(state, () => {
          polls++;
          if (kind === 'a poll due' && polls === 1) return progress; // answered at once: still hashing
          return new Promise((resolve, reject) => {
            held.push(() => (kind === 'failure' ? reject(new Error('Could not reach the server'))
              : resolve(kind === 'progress' ? progress
                : { status: 'complete', available: true, groups: [{ size: 1, files: [{ path: '/r/a' }, { path: '/r/b' }] }], clusters: [{ files: [{ path: '/r/x' }, { path: '/r/y' }] }] })));
          });
        }, { renderDuplicates: () => { painted++; }, renderNearDupes: () => { painted++; }, setTimeout: (fn: () => void) => { timers.push(fn); return 1; } });
        const label = `${finder}, ${how}, ${kind}`;
        const body = finder === 'exact' ? 'dupBody' : 'ndBody';
        await fns[finder]();
        await turns();
        assert.deepEqual(asks.map((a) => a.scanId), ['scan-old'], `${label}: control: the search asked the older scan, the tree's`);
        if (kind === 'a poll due') {
          assert.equal(timers.length, 1, `${label}: control: still hashing, its next poll is due`);
          Object.assign(state, to); // the tree changes before that poll
          timers[0]();
          await turns();
          assert.equal(asks.length, 1, `${label}: the poll due asks the older scan nothing once another tree is on screen`);
          continue;
        }
        Object.assign(state, to); // the tree changes while the poll is out
        $(body).innerHTML = '<i>the pane now</i>';
        held[0]();
        await turns();
        const pane = (finder === 'exact' ? state.dup : state.near) as { groups?: unknown[]; clusters?: unknown[] };
        assert.equal(painted, 0, `${label}: the older scan's answer is not painted over the tree on screen`);
        assert.equal((pane.groups ?? pane.clusters)!.length, 0, `${label}: nor kept — Auto-select and Compare are not offered over it`);
        assert.equal($(body).innerHTML, '<i>the pane now</i>', `${label}: nor its failure said there`);
        assert.equal(timers.length, 0, `${label}: and the search polls the older scan no more`);
      }
    }
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
    tmSetQueryMessage: (m: string) => { messages.push(m); }, tmStageable: () => ({ paths: [] }), seedNodes: noop, tmSyncQueryBar: noop,
    renderSearchOverlay: noop, presentView: noop, formatCount: String, tmUndrawnMessage: () => '',
    tmApplyQuery: (q: string) => { reasked.push(q); },
    fxTmPillBeamsSync: noop, loadTreemap: noop, loadSavedViews: noop, refreshDock: noop,
  };
  // The page's own tmClearHits and Stage button: what a cleared query takes down — the footer's total, the Stage offer —
  // is theirs, never a stand-in that does nothing (review F1.8).
  const { fns } = page<{ run: (q: string) => Promise<void>; mount: () => void; changed: () => void }>(
    ['async function tmRunGrammarQuery(', 'function tmRejudgeQuery(', 'function tmRejudgeQueryWait(', 'function tmNoScanQueryWords(', 'function tmQueryScanChanged(', 'function tmCancelQueries(',
      'function tmClearHits(', 'function tmSyncStageButton('],
    given, `{ run: tmRunGrammarQuery, mount: () => (${pageView('treemap')}).mount(), changed: tmQueryScanChanged }`);
  /** The Stage offer as the map's bar shows it: its button, and the hits it would stage. */
  const stage = () => ({ shown: !$('tmStageMatches').hidden, hits: (given.tmLastHits as { paths: string[] } | null)?.paths ?? null });
  /** An older scan's answer standing over the map: its matches, the footer's total, and "Stage 1 file". */
  const paintOlderMatches = (t: Record<string, unknown>) => {
    Object.assign(t, { matchedPaths: new Set(['/r/big']), matchTotal: 6 });
    given.tmLastHits = { q: String(t.query), paths: ['/r/big'], total: 6, truncated: false, stage: { paths: ['/r/big'], noun: 'file' } };
    $('tmStageMatches').hidden = false;
  };
  return { fns, messages, reasked, asks, given, cleared, stage, paintOlderMatches };
}

test('the highlight box\'s query typed over the saved index\'s tree is said again as that changes — "it runs once the scan finishes" once a scan of the folder starts, the saved index again after a Stop — and is asked of the scan that lands, never left saying "scan this folder" over a scanned one', async () => {
  const state: Record<string, unknown> = { root: TREE, ...INDEX_STOPPED, scanningPath: null, view: 'treemap',
    treemap: { rootPath: '/r', query: 'size>1gb', queryRoot: '/r', queryMode: 'bare', queryScanId: null, matches: 0, matchedPaths: null } };
  const { fns, messages, reasked, asks, stage, paintOlderMatches } = queryPage(state, () => ({ hits: [], total: 0 }));
  await fns.run('size>1gb');
  assert.equal(messages.at(-1), 'Opened from the saved index — scan this folder to search it.', 'control: a Stop left the saved index\'s tree');
  // The scan chrome begins for this folder: beginScanChrome re-enters the view (BQJ-1b (2)).
  Object.assign(state, { scanning: true, scanId: null, settledScanId: null, indexScanDue: false, scanningPath: '/r' });
  fns.mount();
  assert.equal(messages.at(-1), 'The search runs on a finished scan — it runs once the scan finishes.', 'once a scan of the folder starts, the box says the search waits for it — not "scan this folder"');
  Object.assign(state, INDEX_RUNNING); // the index painted, its scan answered
  const before = messages.length; // the step before said the same words: what this mount says is counted from here (review F3.3)
  fns.mount();
  assert.deepEqual(messages.slice(before), ['The search runs on a finished scan — it runs once the scan finishes.'],
    'the map entered once the scan\'s request has answered — its id on hand, no scan behind the tree — says again what the search waits for');
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
  // A query an earlier scan of this folder answered, when a rescan paints the folder from its saved index (TOPIC.scan,
  // null): its matches are of the older scan, not the tree on screen. They stayed painted for the whole scan — "6
  // matches", the footer's count, Stage 3 files — with no query sent (eighth browser pass K03). They go, and the box says
  // the search runs once the scan finishes; the scan that lands asks again, and so does a Stop that puts the older tree back.
  for (const after of ['lands', 'is stopped, the older tree back'] as const) {
    Object.assign(state, INDEX_RUNNING, { scanningPath: '/r' });
    const t = state.treemap as Record<string, unknown>;
    Object.assign(t, { query: 'size>1gb', queryRoot: '/r', queryMode: 'grammar', queryScanId: 'scan-old' });
    paintOlderMatches(t);
    const before: number = reasked.length;
    fns.changed();
    assert.deepEqual([t.queryScanId, t.matchedPaths], [null, null], `${after}: the older scan's matches go when the saved index's tree is painted`);
    assert.equal(t.matchTotal, null, `${after}: and the footer's total of them ("5 of 6 matches")`);
    assert.deepEqual(stage(), { shown: false, hits: [] }, `${after}: and the Stage offer`);
    assert.equal(messages.at(-1), 'The search runs on a finished scan — it runs once the scan finishes.', `${after}: and the box says the search waits for the scan`);
    assert.deepEqual(reasked.slice(before), [], `${after}: nothing is asked of the running scan`);
    Object.assign(state, after === 'lands' ? LANDED : STOPPED);
    fns.mount();
    assert.deepEqual(reasked.slice(before), ['size>1gb'], `${after}: the query is asked once, of the scan behind the tree now`);
  }
  // A scan of the same folder over its older scan's tree, with no index paint: those matches are the tree's still.
  Object.assign(state, HELD);
  const t = state.treemap as Record<string, unknown>;
  Object.assign(t, { queryMode: 'grammar', queryScanId: 'scan-old' });
  paintOlderMatches(t);
  fns.changed();
  assert.equal(t.queryScanId, 'scan-old', 'control: over the older scan\'s own tree its answer stands');
  assert.deepEqual([t.matchTotal, stage()], [6, { shown: true, hits: ['/r/big'] }], 'control: with its total and its Stage offer');
});

test('the older scan\'s matches go when a rescan paints the saved index\'s tree though the box holds a query that did not parse, or one still being asked — each left the last answer painted with no scan named, and K03\'s clear passed them by (review F1.3)', async () => {
  const PARSE = Object.assign(new Error('Expected a size after "size>"'), { offset: 5 });
  let respond: (url: string, signal: AbortSignal) => unknown = () => ({ hits: [{ path: '/r/big', name: 'big', size: 9 }], total: 6 });
  const signals: AbortSignal[] = [];
  for (const left of ['a query that does not parse', 'a query still being asked'] as const) {
    const state: Record<string, unknown> = { root: TREE, ...STOPPED, scanningPath: null, view: 'treemap',
      treemap: { rootPath: '/r', query: 'size>1gb', queryRoot: '/r', queryMode: 'bare', queryScanId: null, matches: 0, matchedPaths: null } };
    const { fns, messages, reasked, stage } = queryPage(state, (url, signal) => { signals.push(signal); return respond(url, signal); });
    const t = state.treemap as Record<string, unknown>;
    respond = () => ({ hits: [{ path: '/r/big', name: 'big', size: 9 }], total: 6 });
    await fns.run('size>1gb');
    assert.deepEqual([t.queryScanId, [...(t.matchedPaths as Set<string>)], t.matchTotal], ['scan-old', ['/r/big'], 6], `${left}: control: an answer of the scan behind the tree is painted`);
    // The box is edited: the new text does not parse (its answer keeps the last highlights), or its answer is still out.
    t.query = 'size>';
    if (left === 'a query that does not parse') {
      respond = () => { throw PARSE; };
      await fns.run('size>');
      assert.match(messages.at(-1)!, /at character 6/, `${left}: control: the box says where the query stops parsing`);
    } else {
      respond = () => new Promise(noop);
      void fns.run('size>');
      await turns();
    }
    assert.deepEqual([t.queryScanId, [...(t.matchedPaths as Set<string>)]], [null, ['/r/big']], `${left}: control: the last answer is painted, no scan named`);
    // A rescan of the folder paints it from its saved index (TOPIC.scan, null).
    Object.assign(state, INDEX_RUNNING, { scanningPath: '/r' });
    fns.changed();
    assert.equal(t.matchedPaths, null, `${left}: the older scan's highlights go`);
    assert.equal(t.matchTotal, null, `${left}: and the footer's total of them`);
    assert.deepEqual(stage(), { shown: false, hits: [] }, `${left}: and the Stage offer`);
    assert.equal(messages.at(-1), 'The search runs on a finished scan — it runs once the scan finishes.', `${left}: and the box says the search waits for the scan`);
    if (left === 'a query still being asked') assert.equal(signals.at(-1)!.aborted, true, `${left}: its request stops`);
    // The scan lands: the box's query is asked of it, once.
    Object.assign(state, LANDED);
    fns.mount();
    assert.deepEqual(reasked, ['size>'], `${left}: the scan that lands asks the box's query`);
  }
});

/**
 * The highlight box over a drawn map: the query's bookkeeping, as queryPage lifts it, with the page's own search
 * overlay, map footer and shapes' footer drawing what each state says — the scrim laid over each rectangle or shape
 * that did not match, and the line under the map. `cells` draws the map as circles (§6.2) instead of rectangles.
 */
function mapUnderQueryPage(state: Record<string, unknown>, answer: (url: string) => unknown, cells = false) {
  const $ = stubDom();
  const asks: Ask[] = [];
  const reasked: string[] = [];
  const messages: string[] = [];
  /** What the overlay's last draw dimmed on the search buffer: each rectangle or circle laid under the scrim. */
  const dimmed: string[] = [];
  let style = '';
  let path: string[] = [];
  const isScrim = (s: string) => /^rgba\(\d+,\d+,\d+,0\.\d+\)$/.test(s);
  const ctx = {
    setTransform: noop, strokeRect: noop, stroke: noop, closePath: noop, lineTo: noop, moveTo: noop,
    // Each draw of the overlay begins by clearing the whole buffer: what it dims is what that draw laid down.
    clearRect: (x: number, y: number, w: number, h: number) => { if (x === 0 && y === 0 && w === 200 && h === 100) dimmed.length = 0; },
    beginPath: () => { path = []; },
    arc: (x: number) => { path.push(`circle at ${x}`); },
    fillRect: (x: number) => { if (isScrim(style)) dimmed.push(`rect at ${x}`); },
    fill: () => { if (isScrim(style)) dimmed.push(...path); },
    set fillStyle(v: string) { style = v; }, get fillStyle() { return style; },
    strokeStyle: '', lineWidth: 1,
  };
  const given: Record<string, unknown> = {
    state, $, tmQuerySeq: 0, tmQueryAbort: null, tmQueryDeb: 0, tmLastHits: null, AbortController, clearTimeout: noop,
    api: async (url: string, init: { body: string }) => { asks.push({ url, scanId: scanOf(url, init.body) }); return answer(url); },
    tmSetQueryMessage: (m: string) => { messages.push(m); }, tmStageable: () => ({ paths: [] }), seedNodes: noop, tmSyncQueryBar: noop,
    presentView: noop, formatCount: String, tmUndrawnMessage: () => '',
    fxTmPillBeamsSync: noop, loadSavedViews: noop, refreshDock: noop,
    // The overlay and the footers over a 200 × 100 map, the search buffer's context recorded.
    tmSearchBuffer: { width: 200, height: 100 }, tmBuffer: { width: 200, height: 100 }, tmSearchCtx: ctx, window: { devicePixelRatio: 1 },
    document: { documentElement: { dataset: { theme: 'dark' } } }, cssVar: () => '#0A84FF', tmKidsOf: () => new Map(), altCellPath: noop,
    isSun: () => false, isCells: () => cells, tmPreview: { on: false }, formatWhen: String,
    formatBytes: (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${(n / 1e3).toFixed(1)} KB`),
  };
  const { fns } = page<{ run: (q: string) => Promise<void>; mount: () => void; changed: () => void; paint: () => void }>(
    ['async function tmRunGrammarQuery(', 'function tmRejudgeQuery(', 'function tmRejudgeQueryWait(', 'function tmNoScanQueryWords(', 'function tmQueryScanChanged(', 'function tmCancelQueries(',
      'function tmClearHits(', 'function tmSyncStageButton(', 'function treemapMatch(', 'function renderSearchOverlay(', 'function updateTmStatus(', 'function renderCellsStatus('],
    given, `{ run: tmRunGrammarQuery, mount: () => (${pageView('treemap')}).mount(), changed: tmQueryScanChanged,
      paint: () => { renderSearchOverlay(); if (isCells()) renderCellsStatus(); } }`);
  // A paint lays the map out afresh (loadTreemap → drawTreemap, or drawCells), then draws its overlay and footer over it.
  given.loadTreemap = () => fns.paint();
  // tmApplyQuery hands a grammar query to tmRunGrammarQuery (the bare-word path is mapColourPop's and indexSearch's).
  given.tmApplyQuery = (q: string) => { reasked.push(q); void fns.run(q.trim()); };
  return { fns, $, asks, reasked, messages, dimmed };
}

test('while a rescan paints the saved index\'s tree under a query in the highlight box, the map is drawn undimmed and its footer is the map\'s own line — never "0 matches": the query waits for the scan, and the box says so — and the scan that lands is asked once and dims the map again (ninth browser pass M01)', async () => {
  // corpus scanned, `ext:mov,mkv` answered (266 matches), then Scan pressed again: the saved index's tree was painted
  // while the scan ran, and K03 took the older scan's matches down, leaving the query in the box with no answer. The
  // overlay then judged "ext:mov,mkv" by the bare-word rule, which matches no name: every rectangle got the scrim, and
  // the footer read "0 matches for “ext:mov,mkv” · 9.5 GB in this folder", with no "· from the saved index".
  for (const cells of [false, true]) {
    const drawn = cells ? 'as circles' : 'as rectangles';
    const nodes = [{ path: '/r/a.mov' }, { path: '/r/b.txt' }];
    const a = { path: '/r/a.mov', name: 'a.mov', type: 'file', extension: 'mov', depth: 1 };
    const b = { path: '/r/b.txt', name: 'b.txt', type: 'file', extension: 'txt', depth: 1 };
    const state: Record<string, unknown> = { root: TREE, ...STOPPED, scanningPath: null, view: 'treemap',
      treemap: { rootPath: '/r', query: 'ext:mov,mkv', queryRoot: '/r', queryMode: 'bare', queryScanId: null, matches: 0, matchedPaths: null, matchTotal: null,
        mode: cells ? 'circles' : 'treemap', history: { active: false }, minSize: 4000, rootSize: 9.5e9, nodes, nodesFor: { scanId: 'scan-old', nodes },
        pxRects: [{ n: a, x: 0, y: 0, w: 100, h: 100 }, { n: b, x: 100, y: 0, w: 100, h: 100 }],
        cells: [{ n: { path: '/r' }, depth: 0, kind: 'circle', cx: 100, cy: 50, r: 50 }, { n: a, depth: 1, kind: 'circle', cx: 50, cy: 50, r: 40, leaf: true }, { n: b, depth: 1, kind: 'circle', cx: 150, cy: 50, r: 40, leaf: true }] } };
    const t = state.treemap as Record<string, unknown>;
    const c = mapUnderQueryPage(state, () => ({ hits: [{ path: '/r/a.mov', name: 'a.mov', size: 5e9 }], total: 266 }), cells);
    const footer = () => c.$('tmStatus').textContent;
    // b.txt; never the folder on screen's own circle, whose disc would dim every shape in it (hunt C25).
    const answered = cells ? ['circle at 150'] : ['rect at 100'];
    // Control: the older scan's tree, the query answered — what it did not match is dimmed, and the footer counts it.
    await c.fns.run('ext:mov,mkv');
    assert.deepEqual(c.dimmed, answered, `${drawn}: control: the answer dims what it did not match`);
    assert.equal(footer(), '1 of 266 matches for “ext:mov,mkv” · 9.5 GB in this folder', `${drawn}: control: the footer counts the answer`);
    // Scan pressed again: the saved index's tree is painted (TOPIC.scan, null), and shown again as the scan chrome re-enters the view.
    Object.assign(state, INDEX_RUNNING, { scanningPath: '/r' });
    t.nodesFor = { scanId: null, nodes };
    c.fns.changed();
    c.fns.paint();
    for (const when of ['painted', 're-entered']) {
      if (when === 're-entered') c.fns.mount();
      assert.deepEqual([t.queryMode, t.matchedPaths, t.matchTotal], ['grammar', null, null], `${drawn}, ${when}: control: the query waits, the older answer gone (K03)`);
      assert.equal(c.messages.at(-1), 'The search runs on a finished scan — it runs once the scan finishes.', `${drawn}, ${when}: control: the box says the search waits for the scan`);
      assert.deepEqual(c.dimmed, [], `${drawn}, ${when}: nothing is dimmed while the query waits`);
      assert.equal(t.matches, 0, `${drawn}, ${when}: and nothing is counted as a match`);
      assert.equal(footer(), cells ? '2 shapes · 2 without children · 9.5 GB total' : '2 items of 4.0 KB or more drawn · 9.5 GB in this folder · from the saved index',
        `${drawn}, ${when}: the footer is the map's own line, with no match count`);
    }
    // The scan lands (finishScan re-enters the view): the query is asked once, of it — nothing was asked of the running
    // scan — and its answer dims the map again and is counted under it.
    Object.assign(state, LANDED);
    t.nodesFor = { scanId: 'scan-new', nodes };
    c.fns.mount();
    await turns();
    assert.deepEqual([c.reasked, c.asks.map((x) => x.scanId), c.dimmed, footer()],
      [['ext:mov,mkv'], ['scan-old', 'scan-new'], answered, '1 of 266 matches for “ext:mov,mkv” · 9.5 GB in this folder'],
      `${drawn}: the scan that lands is asked the query, once, and its answer dims the map and is counted again`);
  }
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

/* ── The Clean Up sheet's panes (eighth browser pass K04) ── */

/** The page's own skeletonRows: the Clean Up sheet's working rows are checked as they ship (review F3.9). */
const CLEAN_SKELETON = liftPage<(n: number, h?: number, label?: string) => string>(['escapeHtml', 'skeletonRows'], 'skeletonRows');
/** What each pane's working rows say to assistive technology while its request is out (review F3.9). */
const SAYS_WORKING = {
  smart: /<div role="status" aria-label="Working out what Clean Up suggests…">(<div class="skeleton"[^>]*><\/div>)+<\/div>/,
  empty: /<div role="status" aria-label="Finding empty folders…">(<div class="skeleton"[^>]*><\/div>)+<\/div>/,
  video: /<div role="status" aria-label="Finding videos worth re-encoding…">(<div class="skeleton"[^>]*><\/div>)+<\/div>/,
  rules: /<div role="status" aria-label="Finding files that match…">(<div class="skeleton"[^>]*><\/div>)+<\/div>/,
};
/** Working rows left standing, or the notice that a pane waits for the scan. */
const LEFT_WORKING = /class="skeleton"|fills in/;

/**
 * The Clean Up sheet's panes, lifted whole, over a stub DOM with the sheet open and a server answering each pane;
 * `extra` lifts more of the page's functions, with what they need.
 */
function cleanUpPage(state: Record<string, unknown>, answer: (url: string) => unknown = cleanUpAnswer, extra: { decls?: string[]; given?: Record<string, unknown> } = {}) {
  const $ = stubDom();
  $('cleanModal').classList.add('open');
  const handlers: Record<string, () => Promise<void>> = {};
  ($('cleanFindBtn') as unknown as { addEventListener: (t: string, fn: () => Promise<void>) => void }).addEventListener =
    (t, fn) => { handlers[t] = fn; };
  // The Clean Up button: the page's own handler opens the sheet (review F1.9).
  ($('cleanupBtn') as unknown as { addEventListener: (t: string, fn: () => Promise<void>) => void }).addEventListener =
    (_t, fn) => { handlers.open = fn; };
  // The Find knobs as a person leaves them: one rule ticked, "Larger than 100 MB".
  Object.assign($('ruleSizeOn'), { checked: true }); $('ruleSizeMb').value = '100';
  const cloud: unknown[] = [];
  const toasts: string[] = [];
  let answered = 0;
  /** The page's TOPIC.scan subscribers the sheet registers. */
  const subs: Array<(scanId: string | null) => void> = [];
  const given: Record<string, unknown> = {
    subscribe: (_topic: string, fn: (scanId: string | null) => void) => { subs.push(fn); }, TOPIC: { scan: 'scan' },
    state, $, document: { activeElement: null, body: null }, escapeHtml: esc, icon: () => '', skeletonRows: CLEAN_SKELETON, formatCount: String, formatBytes: String, formatDate: String,
    chipFor: () => '', cartButtonHtml: () => '', refreshCartButtons: noop, updateCleanSummary: noop, seedNodes: noop, sizeInk: () => '',
    renderSmartGroups: noop, ecosystemLabel: String, renderCloudSafe: async () => { cloud.push(1); }, toast: (m: string) => { toasts.push(m); },
    reportError: (e: Error) => { toasts.push(e.message); }, selectedSavedView: () => ({ id: 'v', q: 'size>1gb' }), cleanOnDiskOf: async () => new Map(),
    whyLeftOut: () => '', MB: 1e6, cleanWaiting: new Set(), cleanFindWaiting: null, CLEAN_NO_SCAN: liftPage<Record<string, [string, string]>>(['CLEAN_NO_SCAN'], 'CLEAN_NO_SCAN'),
    emptyFolders: [], videoCandidates: [], smartGroups: [], packageOrphans: [], cleanMatches: [], cleanOnDisk: new Map(),
    loadEmptyFoldersSeq: 0, loadVideoSeq: 0, loadSmartSeq: 0, cleanRuleSource: 'simple', smartSort: 'size',
    cleanUpWhereItGoes: () => '', cleanFunnelDrop: noop, setCleanRuleSource: noop, cleanPane: 'rules', videoJobStream: null, cleanFindNoList: true,
    ...extra.given,
  };
  const { fns, asks } = page<{ empty: () => Promise<void>; video: () => Promise<void>; smart: () => Promise<void>; byView: () => Promise<void>; changed: () => void; pane: (p: string) => void }>([
    'function cleanNoScanHtml(', 'function cleanOpen(', 'function cleanAskAgain(', 'function cleanScanChanged(',
    'async function loadEmptyFolders(', 'async function loadVideoCandidates(', 'async function loadSmartSuggestions(',
    'async function renderGitRepos(', 'async function renderPackageOrphans(', 'async function renderBrowserProfiles(',
    'async function runCleanFind(', 'async function findBySavedView(', "$('cleanFindBtn').addEventListener('click', async () => {",
    'subscribe(TOPIC.scan, (scanId) => {\n  cleanScanChanged();', "$('cleanupBtn').addEventListener('click', () => {", 'function setCleanPane(',
    ...(extra.decls ?? []),
  ], given, '{ empty: loadEmptyFolders, video: loadVideoCandidates, smart: loadSmartSuggestions, byView: () => runCleanFind(findBySavedView), changed: cleanScanChanged, pane: setCleanPane }',
  // A pane that asks again without end — its answer never the tree's — is stopped: the sheet closes, and the
  // assertions about what it asked say why (a hand mutant made one ask forever, and the run ran out of memory).
  (url) => { if (++answered > 200) { $('cleanModal').classList.remove('open'); throw new Error('asked without end'); } return answer(url); });
  /** TOPIC.scan, as finishScan emits it: a scan landed (its id), or the index painted a tree (null). */
  const emitScan = (scanId: string | null) => { for (const fn of subs) fn(scanId); };
  return { fns, asks, $, given, cloud, toasts, find: () => handlers.click(), open: () => handlers.open(), emitScan };
}
function cleanUpAnswer(url: string): unknown {
  if (url.startsWith('/api/compression/candidates')) return { available: false, reason: 'No ffmpeg here.' };
  if (url.startsWith('/api/empty-folders')) return { folders: [], withheld: 0 };
  if (url.startsWith('/api/git/repos')) return { repos: [] };
  if (url.startsWith('/api/packages/orphans')) return { available: true, ecosystems: [] };
  if (url.startsWith('/api/cleanup/browser-profiles')) return { profiles: [] };
  if (url.startsWith('/api/cleanup/suggestions')) return { available: true, groups: [] };
  if (url.startsWith('/api/cleanup/rules')) return { files: [], matched: 0 };
  if (url === '/api/query') return { hits: [], total: 0 };
  return assert.fail(`unexpected ask ${url}`);
}
/** Each pane: how it is asked, and the host it paints. */
const CLEAN_PANES: Array<[string, (c: ReturnType<typeof cleanUpPage>) => Promise<void>, string]> = [
  ['Smart suggestions', (c) => c.fns.smart(), 'smartResults'],
  ['Empty folders', (c) => c.fns.empty(), 'emptyResults'],
  ['Shrink video', (c) => c.fns.video(), 'videoBody'],
  ['Custom rules › Find', (c) => c.find(), 'cleanResults'],
  ['Custom rules › Find, by a saved view', (c) => c.fns.byView(), 'cleanResults'],
];

test('Clean Up (K04): Smart suggestions, Empty folders, Shrink video and Custom rules › Find ask the scan the tree on screen came from — never the running scan, which answered 409 or 202 "Still working on that…" over a finished tree', async () => {
  for (const [label, load] of CLEAN_PANES) {
    const state: Record<string, unknown> = { root: TREE, notes: new Map(), ...HELD };
    const c = cleanUpPage(state);
    await throughThePhases(`Clean Up's ${label}`, state, c.asks, () => load(c), noop);
    assert.deepEqual(c.toasts, [], `${label}: nothing said as a failure`);
  }
});

test('Clean Up (K04): over the saved index\'s tree each pane asks nothing — it says it fills in once the scan finishes, and does once the scan lands; once nothing will land, that the tree is the saved index', async () => {
  for (const [label, load, host] of CLEAN_PANES) {
    const state: Record<string, unknown> = { root: TREE, notes: new Map(), ...INDEX_RUNNING, scanningPath: TREE.path };
    const c = cleanUpPage(state);
    c.$(host).innerHTML = '<i>another tree\'s results</i>';
    await load(c);
    await turns();
    assert.equal(c.asks.length, 0, `${label}: nothing is asked over the saved index's tree — not of the running scan (${c.asks.map((x) => x.url).join(', ')})`);
    assert.match(c.$(host).innerHTML, COMING, `${label}: it says it fills in once the scan finishes (${c.$(host).innerHTML})`);
    // The scan lands (TOPIC.scan): the pane is asked, of the scan that landed, and so is the cloud-safe list.
    Object.assign(state, LANDED);
    c.emitScan('scan-new');
    await turns();
    assert.equal(c.cloud.length, 1, `${label}: the cloud-safe list, whose tab the saved index's tree took down, is asked once a scan lands`);
    assert.ok(c.asks.length > 0, `${label}: once the scan lands, the pane is asked`);
    assert.deepEqual(c.asks.map((a) => a.scanId), c.asks.map(() => 'scan-new'), `${label}: of the scan that landed (${c.asks.map((a) => a.url).join(', ')})`);
    assert.doesNotMatch(c.$(host).innerHTML, COMING, `${label}: and no longer says it waits`);
    // Again over the saved index's tree, its scan Stopped: what it says changes, and nothing is asked.
    Object.assign(state, INDEX_RUNNING, { scanningPath: TREE.path });
    await load(c);
    await turns();
    const asked = c.asks.length;
    assert.match(c.$(host).innerHTML, COMING, `${label}: control: waiting again`);
    Object.assign(state, INDEX_STOPPED, { scanningPath: null });
    c.fns.changed();
    await turns();
    assert.equal(c.asks.length, asked, `${label}: a Stop asks nothing`);
    assert.match(c.$(host).innerHTML, /Opened from the saved index — scan this folder to /, `${label}: and says the tree is the saved index (${c.$(host).innerHTML})`);
    // The sheet closed: nothing is asked when a scan lands; opening it starts afresh.
    c.$('cleanModal').classList.remove('open');
    Object.assign(state, LANDED);
    c.fns.changed();
    await turns();
    assert.equal(c.asks.length, asked, `${label}: with the sheet closed nothing is asked`);
  }
});

test('Clean Up (K04): a pane\'s answer the older scan gives once the rescan has landed is not painted over the new tree — nor its failure — the pane is asked again of the scan now on screen', async () => {
  for (const fails of [false, true]) {
    for (const [label, load, host] of CLEAN_PANES) {
      const state: Record<string, unknown> = { root: TREE, notes: new Map(), ...HELD };
      const held: Array<() => void> = [];
      const c = cleanUpPage(state, (url) => new Promise((resolve, reject) => {
        if ((state as { scanId: string }).scanId === 'scan-new' && !state.scanning) { resolve(cleanUpAnswer(url)); return; }
        held.push(() => (fails ? reject(new Error('Scan is still running')) : resolve(url.startsWith('/api/empty-folders')
          ? { folders: [{ name: 'old', path: '/r/old' }], withheld: 0, totalCount: 1 } : cleanUpAnswer(url))));
      }));
      const out = load(c);
      await turns();
      assert.ok(c.asks.length > 0 && c.asks.every((a) => a.scanId === 'scan-old'), `${label}: control: asked of the older scan`);
      Object.assign(state, LANDED); // finishScan: the new tree is on screen before the answer
      while (held.length) held.shift()!();
      await out;
      await turns();
      const late = c.asks.filter((a) => a.scanId === 'scan-new');
      assert.ok(late.length > 0, `${label}${fails ? ', failing' : ''}: asked again of the scan now on screen`);
      assert.doesNotMatch(c.$(host).innerHTML, /\/r\/old|Scan is still running/, `${label}${fails ? ', failing' : ''}: the older scan's answer is not painted (${c.$(host).innerHTML})`);
      assert.deepEqual(c.toasts, [], `${label}${fails ? ', failing' : ''}: nor its failure said`);
    }
  }
});

/** Each request of the Smart pane's four, by its scan: the older scan's rows are named OLD, the new scan's NEW. */
const smartRows = (tag: string): Record<string, unknown> => ({
    git: { repos: [{ repoPath: `/r/${tag}-repo`, totalBytes: 2e6, packBytes: 1e6, looseObjectBytes: 1e6, lfsBytes: 0, canGC: false }] },
    packages: { available: true, orphanCount: 1, orphanBytes: 5, cacheBytes: 0, activeBytes: 0,
      ecosystems: [{ ecosystem: 'npm', orphanCount: 1, orphanBytes: 5, cacheCount: 0, cacheBytes: 0, activeCount: 0, activeBytes: 0,
        entries: [{ kind: 'orphan', path: `/r/${tag}-pkg/node_modules`, name: 'node_modules', size: 5, modifiedAt: 0, reason: 'No project file beside it', projectName: null }] }] },
    browser: { profiles: [{ browser: 'Chrome', profile: `${tag}-profile`, totalBytes: 10, items: [{ path: `/r/${tag}-cache`, bytes: 10, label: 'Cache' }] }] },
    suggestions: { available: true, groups: [{ label: `${tag}-group` }], catalog: {} },
});
/** Which of the Smart pane's four a request is. */
const smartKindOf = (url: string) => (url.startsWith('/api/git/repos') ? 'git' : url.startsWith('/api/packages/orphans') ? 'packages'
  : url.startsWith('/api/cleanup/browser-profiles') ? 'browser' : url.startsWith('/api/cleanup/suggestions') ? 'suggestions' : assert.fail(`unexpected ask ${url}`));

test('Clean Up (K04): Smart suggestions and its git, package and browser sections paint none of the older scan\'s rows once the rescan has landed — its suggestions, or a section, answering or failing late — and never take down the rows the scan now on screen gave; the pane is asked again of that scan (review F1.7)', async () => {
  const rows = smartRows;
  const kindOf = smartKindOf;
  const HOSTS = ['gitRepos', 'packageOrphans', 'browserProfiles', 'smartResults'];
  for (const [late, again] of [['suggestions', false], ['packages', false], ['browser', false], ['packages', true], ['browser', true]] as const) {
    for (const fails of [false, true]) {
      const name = `${late === 'suggestions' ? 'its suggestions' : `its ${late} section`} ${fails ? 'failing' : 'answering'} late${again ? ', the Smart tab chosen again first' : ''}`;
      const state: Record<string, unknown> = { root: TREE, notes: new Map(), ...HELD };
      // Held for the older scan: the late request, and the git section (never awaited), which answers last of all.
      const held = new Map<string, (fail: boolean) => void>();
      const hold = new Set<string>([late, 'git']);
      const c = cleanUpPage(state, (url) => {
        const kind = kindOf(url);
        const old = url.includes('scan-old');
        if (old && hold.has(kind)) {
          return new Promise((resolve, reject) => { held.set(kind, (fail) => (fail ? reject(new Error('Scan is still running')) : resolve(rows('OLD')[kind]))); });
        }
        return rows(old ? 'OLD' : 'NEW')[kind];
      });
      c.given.browserFav = () => '';
      c.given.renderSmartGroups = () => { c.$('smartResults').innerHTML = (c.given.smartGroups as Array<{ label: string }>).map((g) => g.label).join(', '); };
      const out = c.fns.smart();
      await turns();
      assert.ok(held.has(late), `${name}: control: the older scan's ${late} request is out (${c.asks.map((a) => a.url).join(', ')})`);
      Object.assign(state, LANDED); // finishScan: the new tree is on screen before the answer
      const landed = c.asks.length;
      // Or the section's late answer meets a load of the new tree first: the Smart tab chosen again, as a person does.
      if (again) { await c.fns.smart(); await turns(); }
      held.get(late)!(fails);
      held.delete(late);
      await turns();
      held.get('git')!(false); // the older scan's git answer, last of all
      await out;
      await turns();
      for (const host of HOSTS) {
        assert.doesNotMatch(c.$(host).innerHTML, /OLD|Scan is still running/, `${name}: #${host} paints none of the older scan's rows (${c.$(host).innerHTML})`);
        assert.match(c.$(host).innerHTML, /NEW/, `${name}: #${host} holds the rows of the scan now on screen (${c.$(host).innerHTML})`);
      }
      assert.deepEqual(['git', 'packages', 'browser', 'suggestions'].filter((k) => !c.asks.some((a) => a.scanId === 'scan-new' && kindOf(a.url) === k)), [],
        `${name}: each is asked of the scan now on screen`);
      assert.deepEqual(c.asks.slice(landed).filter((a) => a.scanId !== 'scan-new').map((a) => a.url), [], `${name}: and nothing more of the older scan once the rescan has landed`);
      assert.deepEqual(c.toasts, [], `${name}: nothing said as a failure`);
    }
  }
});

test('Clean Up (K04): a package or browser section whose request for the scan now on screen fails is cleared — rows an older scan painted there never stand under the new tree — and nothing is said as a failure (review F2.3)', async () => {
  // e33b17bf kept a failure for the tree on screen clearing its section, and only the opposite case was pinned: a
  // section that kept the older scan's rows on its own failure passed every test.
  for (const failing of [['packages'], ['browser'], ['packages', 'browser']]) {
    const name = `its ${failing.join(' and ')} request failing for the scan now on screen`;
    const state: Record<string, unknown> = { root: TREE, notes: new Map(), ...STOPPED };
    let failNew = false;
    const c = cleanUpPage(state, (url) => {
      const kind = smartKindOf(url);
      const old = url.includes('scan-old');
      if (!old && failNew && failing.includes(kind)) return Promise.reject(new Error('The scan could not be read'));
      return smartRows(old ? 'OLD' : 'NEW')[kind];
    });
    c.given.browserFav = () => '';
    c.given.renderSmartGroups = () => { c.$('smartResults').innerHTML = (c.given.smartGroups as Array<{ label: string }>).map((g) => g.label).join(', '); };
    await c.fns.smart();
    await turns();
    assert.match(c.$('packageOrphans').innerHTML + c.$('browserProfiles').innerHTML, /OLD-pkg[\s\S]*OLD-profile/, `${name}: control: the older scan's rows are painted`);
    Object.assign(state, LANDED); // the rescan lands; Smart is asked of it
    failNew = true;
    await c.fns.smart();
    await turns();
    for (const [kind, host] of [['packages', 'packageOrphans'], ['browser', 'browserProfiles']] as const) {
      if (failing.includes(kind)) assert.equal(c.$(host).innerHTML, '', `${name}: #${host} is cleared — none of the older scan's rows stand under the new tree (${c.$(host).innerHTML})`);
      else assert.match(c.$(host).innerHTML, /NEW/, `${name}: control: #${host} holds the new scan's rows`);
    }
    assert.match(c.$('smartResults').innerHTML, /NEW-group/, `${name}: control: the suggestions are the new scan's`);
    assert.deepEqual(c.toasts, [], `${name}: nothing said as a failure`);
  }
});

test('Clean Up (K04): once the scan lands, Smart suggestions and Custom rules › Find say they are working while their requests are out — not "this fills in once the scan finishes", which the scan has — and a Find that then fails leaves no rows loading (review F2.9)', async () => {
  // Smart: the waiting notice stood through the package and browser sections' requests, which come before its own.
  const state: Record<string, unknown> = { root: TREE, notes: new Map(), ...INDEX_RUNNING, scanningPath: TREE.path };
  const held: Array<() => void> = [];
  const c = cleanUpPage(state, (url) => {
    if (url.startsWith('/api/packages/orphans')) return new Promise((resolve) => { held.push(() => resolve(cleanUpAnswer(url))); });
    return cleanUpAnswer(url);
  });
  await c.fns.smart();
  assert.match(c.$('smartResults').innerHTML, COMING, 'control: Smart suggestions waits for the scan');
  Object.assign(state, LANDED);
  c.emitScan('scan-new');
  await turns();
  assert.equal(held.length, 1, 'control: its packages section is asked of the scan that landed, and is out');
  assert.doesNotMatch(c.$('smartResults').innerHTML, COMING, `Smart suggestions no longer says it waits for a scan that has finished (${c.$('smartResults').innerHTML})`);
  assert.match(c.$('smartResults').innerHTML, SAYS_WORKING.smart, `it says it is working, in words assistive technology reads (${c.$('smartResults').innerHTML})`);
  held.shift()!();
  await turns();
  assert.doesNotMatch(c.$('smartResults').innerHTML, LEFT_WORKING, `control: then it answers (${c.$('smartResults').innerHTML})`);
  // Custom rules › Find: the notice stood through the whole request; and a Find that fails must not leave rows loading.
  for (const fails of [false, true]) {
    const name = `Custom rules › Find${fails ? ', failing' : ''}`;
    const st: Record<string, unknown> = { root: TREE, notes: new Map(), ...INDEX_RUNNING, scanningPath: TREE.path };
    const out: Array<(fail: boolean) => void> = [];
    const r = cleanUpPage(st, (url) => new Promise((resolve, reject) => { out.push((fail) => (fail ? reject(new Error('The rules could not be matched')) : resolve(cleanUpAnswer(url)))); }));
    r.given.cleanFindNoList = false; // an earlier Find in this opening listed results; then another folder was opened from its saved index
    await r.find();
    assert.match(r.$('cleanResults').innerHTML, COMING, `${name}: control: waits for the scan`);
    Object.assign(st, LANDED);
    r.emitScan('scan-new');
    await turns();
    assert.deepEqual(r.asks.map((a) => a.scanId), ['scan-new'], `${name}: control: asked of the scan that landed, and out`);
    assert.doesNotMatch(r.$('cleanResults').innerHTML, COMING, `${name}: no longer says it waits for a scan that has finished (${r.$('cleanResults').innerHTML})`);
    assert.match(r.$('cleanResults').innerHTML, SAYS_WORKING.rules, `${name}: it says it is working, in words assistive technology reads`);
    out.shift()!(fails);
    await turns();
    assert.doesNotMatch(r.$('cleanResults').innerHTML, LEFT_WORKING, `${name}: once it ${fails ? 'fails' : 'answers'}, nothing is left loading (${r.$('cleanResults').innerHTML})`);
    assert.deepEqual(r.toasts, fails ? ['The rules could not be matched'] : [], `${name}: ${fails ? 'the failure is said, once' : 'nothing said as a failure'}`);
  }
  // Another tree on screen before the Find run on the landing answers: asked again, still working, and its failure leaves nothing loading.
  for (const late of ['fails', 'answers'] as const) {
    const name = `Custom rules › Find, the tree changing again while it is out, the older request ${late === 'fails' ? 'failing' : 'answering'}`;
    const st: Record<string, unknown> = { root: TREE, notes: new Map(), ...INDEX_RUNNING, scanningPath: TREE.path };
    const out: Array<(fail: boolean) => void> = [];
    const r = cleanUpPage(st, (url) => new Promise((resolve, reject) => { out.push((fail) => (fail ? reject(new Error('The rules could not be matched')) : resolve(cleanUpAnswer(url)))); }));
    r.given.cleanFindNoList = false; // as above: results listed earlier in this opening
    await r.find();
    Object.assign(st, STOPPED); // a scan stands behind the tree: the Find runs
    r.emitScan('scan-old');
    await turns();
    Object.assign(st, LANDED); // and another tree is on screen before it answers
    out.shift()!(late === 'fails');
    await turns();
    assert.deepEqual(r.asks.map((a) => a.scanId), ['scan-old', 'scan-new'], `${name}: control: asked again of the scan now on screen`);
    assert.match(r.$('cleanResults').innerHTML, SAYS_WORKING.rules, `${name}: still says it is working`);
    out.shift()!(true);
    await turns();
    assert.doesNotMatch(r.$('cleanResults').innerHTML, LEFT_WORKING, `${name}: and once that fails, nothing is left loading (${r.$('cleanResults').innerHTML})`);
    assert.deepEqual(r.toasts, ['The rules could not be matched'], `${name}: the failure for the tree on screen is said, once`);
  }
  // A fresh opening's list is blank: a Find pressed in it says it is working too, and so does one pressed after a failure
  // cleared the list; one pressed over results listed leaves them standing until the new ones come.
  const st: Record<string, unknown> = { root: TREE, notes: new Map(), ...LANDED };
  const out: Array<(fail: boolean) => void> = [];
  const r = cleanUpPage(st, (url) => new Promise((resolve, reject) => { out.push((fail) => (fail ? reject(new Error('The rules could not be matched')) : resolve({ files: [{ name: 'a.log', path: '/r/a.log', size: 5 }], matched: 1 }))); }));
  r.given.cleanFindNoList = false; // what an earlier opening left: results listed
  await r.open();
  const pressed = r.find();
  await turns();
  assert.match(r.$('cleanResults').innerHTML, SAYS_WORKING.rules, 'a Find pressed in a fresh opening says it is working over the blank list');
  out.shift()!(true);
  await pressed;
  await turns();
  assert.equal(r.$('cleanResults').innerHTML, '', 'control: it failed, and left nothing loading');
  const again = r.find();
  await turns();
  assert.match(r.$('cleanResults').innerHTML, SAYS_WORKING.rules, 'pressed again after that failure, it says it is working');
  out.shift()!(false);
  await again;
  await turns();
  assert.match(r.$('cleanResults').innerHTML, /a\.log/, 'control: then lists what matched');
  const third = r.find();
  await turns();
  assert.match(r.$('cleanResults').innerHTML, /a\.log/, 'pressed over results listed, they stand while it works, as before');
  out.shift()!(false);
  await third;
  // A source that says its own problem and answers nothing — Find by a saved view with none picked — leaves nothing loading either.
  const v = cleanUpPage({ root: TREE, notes: new Map(), ...LANDED });
  v.given.selectedSavedView = () => null;
  await v.open();
  await v.fns.byView();
  await turns();
  assert.deepEqual([v.asks.length, v.toasts], [0, ['Pick a saved view first']], 'control: nothing asked, and the source said why');
  assert.doesNotMatch(v.$('cleanResults').innerHTML, LEFT_WORKING, `Find by a saved view with none picked leaves no rows loading (${v.$('cleanResults').innerHTML})`);
  v.given.selectedSavedView = () => ({ id: 'v', q: 'size>1gb' });
  const viewed = v.fns.byView();
  assert.match(v.$('cleanResults').innerHTML, SAYS_WORKING.rules, 'and a view picked then says it is working over the blank list');
  await viewed;
});

test('every Clean Up pane says it is working in words assistive technology reads while its request is out — Smart suggestions, Empty folders, Shrink video and Find — never bare shimmer rows (review F3.9)', async () => {
  // d2938a83 made Smart suggestions and Find show skeletonRows with no label while their requests were out: bare rows
  // with no role and no words, so a screen reader heard nothing; Empty folders and Shrink video were the same.
  const out: string[] = [];
  const c = cleanUpPage({ root: TREE, notes: new Map(), ...LANDED }, (url) => { out.push(url.slice(0, url.indexOf('?') >>> 0)); return new Promise(() => {}); });
  void c.fns.smart();
  void c.fns.empty();
  void c.fns.video();
  void c.find();
  await turns();
  assert.ok(['/api/empty-folders', '/api/compression/candidates', '/api/cleanup/rules'].every((u) => out.includes(u)), `control: each pane's request is out (${out.join(', ')})`);
  for (const [pane, host] of [['smart', 'smartResults'], ['empty', 'emptyResults'], ['video', 'videoBody'], ['rules', 'cleanResults']] as const) {
    assert.match(c.$(host).innerHTML, SAYS_WORKING[pane], `${pane}: its working rows carry role="status" and a sentence (${c.$(host).innerHTML})`);
  }
});

/** A MutationObserver as a browser runs one over `childList`: told of a change a microtask later, and never after a disconnect. */
class FakeObserver {
  private queued = false;
  private readonly on = new Set<{ watchers: Set<FakeObserver> }>();
  constructor(private readonly cb: () => void) {}
  observe(target: { watchers: Set<FakeObserver> }, opts: { childList?: boolean }): void { assert.equal(opts.childList, true, 'it watches the host\'s children'); this.on.add(target); target.watchers.add(this); }
  disconnect(): void { for (const t of this.on) t.watchers.delete(this); this.on.clear(); this.queued = false; }
  notify(): void {
    if (this.queued) return;
    this.queued = true;
    queueMicrotask(() => { if (!this.queued) return; this.queued = false; this.cb(); });
  }
}

/**
 * A pane's host as a browser keeps it: each innerHTML write replaces its children — the rows written before leave the
 * page (isConnected false) — and is told to each observer watching it. Its first child answers getAttribute from the
 * markup written.
 */
function liveHost(el: El): void {
  const watchers = new Set<FakeObserver>();
  let html = el.innerHTML;
  let first: { isConnected: boolean; getAttribute: (k: string) => string | null } | null = null;
  Object.defineProperty(el, 'innerHTML', {
    get: () => html,
    set: (v: string) => {
      if (first) first.isConnected = false;
      html = v;
      const open = /^\s*<[a-z]+([^>]*)>/i.exec(v);
      first = open ? { isConnected: true, getAttribute: (k: string) => new RegExp(`\\s${k}="([^"]*)"`).exec(open[1])?.[1] ?? null } : null;
      for (const w of watchers) w.notify();
    },
  });
  Object.defineProperty(el, 'firstElementChild', { get: () => first });
  Object.assign(el, { watchers });
}

test('each Clean Up pane\'s working sentence reaches the text of a live region that is in the sheet from the start — a frame after its rows are written, so a screen reader announces it — and leaves once those rows are gone; a newer pane\'s rows take the region over (review F3.9)', async () => {
  // The working rows carry their sentence as the aria-label of a role="status" element that one innerHTML write puts on
  // screen already filled: a screen reader announces a live region's text as it changes, not its label, and seldom a
  // region that appears filled.
  const at = INDEX.indexOf('<div class="modal-backdrop" id="cleanModal"');
  const sheet = INDEX.slice(at, INDEX.indexOf('<!-- ═══════════', at));
  assert.match(sheet, /<div id="cleanWorking" class="sr-only" role="status" aria-live="polite" aria-atomic="true"><\/div>/,
    'the Clean Up sheet keeps a live region of its own, empty, in its markup from the start');
  const frames: Array<() => void> = [];
  const frame = () => { for (const fn of frames.splice(0)) fn(); };
  const HELD = ['/api/cleanup/suggestions', '/api/empty-folders', '/api/compression/candidates', '/api/cleanup/rules'];
  const held = new Map<string, Array<() => void>>(HELD.map((p) => [p, []]));
  const c = cleanUpPage({ root: TREE, notes: new Map(), ...LANDED }, (url) => {
    const prefix = HELD.find((p) => url.startsWith(p));
    return prefix ? new Promise((resolve) => { held.get(prefix)!.push(() => resolve(cleanUpAnswer(url))); }) : cleanUpAnswer(url);
  }, { decls: ['function sayWorking('], given: { requestAnimationFrame: (fn: () => void) => frames.push(fn), MutationObserver: FakeObserver, workingSaid: new Map() } });
  /** The pane's requests answer, and what they paint is painted. */
  const answer = async (prefix: string) => { for (const fn of held.get(prefix)!.splice(0)) fn(); await turns(); };
  for (const id of ['smartResults', 'emptyResults', 'videoBody', 'cleanResults']) liveHost(c.$(id));
  const said: string[] = [];
  let text = '';
  Object.defineProperty(c.$('cleanWorking'), 'textContent', { get: () => text, set: (v: string) => { text = v; said.push(v); } });
  const PANES = [
    ['Smart suggestions', () => c.fns.smart(), '/api/cleanup/suggestions', 'Working out what Clean Up suggests…'],
    ['Empty folders', () => c.fns.empty(), '/api/empty-folders', 'Finding empty folders…'],
    ['Shrink video', () => c.fns.video(), '/api/compression/candidates', 'Finding videos worth re-encoding…'],
    ['Custom rules › Find', () => c.find(), '/api/cleanup/rules', 'Finding files that match…'],
  ] as const;
  for (const [pane, ask, prefix, sentence] of PANES) {
    void ask();
    await turns();
    assert.equal(held.get(prefix)!.length, 1, `${pane}: control: its request is out`);
    frame();
    assert.equal(text, sentence, `${pane}: its sentence reaches the live region's text, a frame after its rows are written`);
    await answer(prefix);
    assert.equal(text, '', `${pane}: and leaves once the pane answered and its rows are gone`);
  }
  // Two panes at work: the newer pane's rows take the region over. The older pane's sentence, its frame not come yet, is
  // never said over the newer one's, and the older pane answering does not empty the region the newer one speaks in.
  said.length = 0;
  void c.fns.smart();
  void c.fns.video();
  await turns();
  frame();
  assert.deepEqual(said.filter(Boolean), ['Finding videos worth re-encoding…'], 'only the newer pane\'s sentence is said');
  await answer('/api/cleanup/suggestions');
  const afterOlder = text;
  await answer('/api/compression/candidates');
  assert.deepEqual([afterOlder, text], ['Finding videos worth re-encoding…', ''], 'the older pane answering leaves the newer pane\'s sentence; the newer one answering empties the region');
  // Asked again while its rows are on screen (the scan behind the tree changed under it, cleanAskAgain): the region is
  // emptied as the new rows are written and given the sentence a frame later — the same sentence again is a change, heard.
  void c.fns.empty();
  await turns();
  frame();
  const before = text;
  void c.fns.empty();
  await turns();
  const asWritten = text;
  frame();
  const nextFrame = text;
  await answer('/api/empty-folders'); // the older answer is passed over (a newer load owns the list), the newer one paints
  assert.deepEqual([before, asWritten, nextFrame, text], ['Finding empty folders…', '', 'Finding empty folders…', ''],
    'asked again, the region is emptied as the new rows are written, says the sentence again a frame later, and leaves once the newer load answers');
});

test('Clean Up (K04): Find asked again of the scan now on screen, after the older scan\'s request failed, holds its button while that request is out — the button was handed back as the re-ask began, so a second press started a second Find (review F1.4)', async () => {
  const FINDS: Array<[string, (c: ReturnType<typeof cleanUpPage>) => Promise<void>]> = [
    ['Custom rules › Find', (c) => c.find()], ['Custom rules › Find, by a saved view', (c) => c.fns.byView()]];
  for (const [label, press] of FINDS) {
    for (const outcome of ['fails', 'answers'] as const) {
      const state: Record<string, unknown> = { root: TREE, notes: new Map(), ...HELD };
      const held: Array<(fail: boolean) => void> = [];
      const c = cleanUpPage(state, (url) => new Promise((resolve, reject) => {
        held.push((fail) => (fail ? reject(new Error('Scan is still running')) : resolve(cleanUpAnswer(url))));
      }));
      const btn = c.$('cleanFindBtn');
      const out = press(c);
      await turns();
      assert.deepEqual([c.asks.map((a) => a.scanId), btn.disabled], [['scan-old'], true], `${label}: control: asked of the older scan, Find held`);
      Object.assign(state, LANDED); // finishScan: the new tree is on screen before the answer
      held.shift()!(outcome === 'fails'); // the older scan's request fails, or answers, after the landing
      await out;
      await turns();
      assert.deepEqual(c.asks.map((a) => a.scanId), ['scan-old', 'scan-new'], `${label}, the older request ${outcome === 'fails' ? 'failing' : 'answering'}: asked again of the scan now on screen`);
      assert.equal(btn.disabled, true, `${label}, the older request ${outcome === 'fails' ? 'failing' : 'answering'}: and Find stays held while that request is out`);
      held.shift()!(false);
      await turns();
      assert.equal(btn.disabled, false, `${label}: handed back once it answers`);
      assert.deepEqual(c.toasts, [], `${label}: nothing said as a failure`);
    }
  }
});

test('Clean Up (K04): with the sheet closed nothing is asked — not the panes a scan landing asks again, not an older answer\'s re-ask, not the cloud-safe list that walks the whole tree — and opening it starts every pane afresh, so a Find pressed over the saved index\'s tree in an earlier opening is not run on a later change (review F1.9)', async () => {
  // A scan lands with the sheet closed (TOPIC.scan, finishScan): its subscriber asks nothing.
  const state: Record<string, unknown> = { root: TREE, notes: new Map(), ...INDEX_RUNNING, scanningPath: TREE.path };
  const c = cleanUpPage(state);
  await c.fns.empty();
  await turns();
  assert.match(c.$('emptyResults').innerHTML, COMING, 'control: a pane waits for the scan');
  c.$('cleanModal').classList.remove('open');
  Object.assign(state, LANDED);
  c.emitScan('scan-new');
  await turns();
  assert.deepEqual([c.asks.map((a) => a.url), c.cloud.length], [[], 0], 'a scan landing with the sheet closed asks nothing — no pane, nor the cloud-safe list');
  // An older scan's answer arriving once the sheet has closed: not asked again (cleanAskAgain).
  const state2: Record<string, unknown> = { root: TREE, notes: new Map(), ...HELD };
  const held: Array<() => void> = [];
  const c2 = cleanUpPage(state2, (url) => (url.includes('scan-old') ? new Promise((resolve) => { held.push(() => resolve(cleanUpAnswer(url))); }) : cleanUpAnswer(url)));
  const out = c2.fns.empty();
  await turns();
  assert.deepEqual(c2.asks.map((a) => a.scanId), ['scan-old'], 'control: asked of the older scan');
  c2.$('cleanModal').classList.remove('open');
  Object.assign(state2, LANDED);
  held.shift()!();
  await out;
  await turns();
  assert.deepEqual(c2.asks.map((a) => a.scanId), ['scan-old'], 'its answer arriving once the sheet has closed is not asked again');
  // Over the saved index's tree: a pane and Find wait; the sheet closes, the scan lands, the sheet opens again.
  const state3: Record<string, unknown> = { root: TREE, notes: new Map(), ...INDEX_RUNNING, scanningPath: TREE.path };
  const c3 = cleanUpPage(state3);
  await c3.fns.empty();
  await c3.find();
  await turns();
  assert.match(c3.$('cleanResults').innerHTML, COMING, 'control: Find waits for the scan');
  c3.$('cleanModal').classList.remove('open');
  Object.assign(state3, LANDED);
  c3.emitScan('scan-new');
  await turns();
  assert.deepEqual(c3.asks.map((a) => a.url), [], 'control: nothing asked with the sheet closed');
  await c3.open(); // the Clean Up button
  assert.ok(c3.$('cleanModal').classList.contains('open'), 'control: the sheet is open again');
  assert.equal(c3.cloud.length, 1, 'control: opening it asks the cloud-safe list');
  c3.fns.changed(); // a later change: a scan of the folder starting, say (TOPIC.scan)
  await turns();
  assert.deepEqual(c3.asks.map((a) => a.url), [], 'what waited in the earlier opening is not asked — not the old Find with its old rules, nor its pane');
});

test('Clean Up: opening the sheet starts Shrink video and the Smart pane\'s sections afresh — the list an older scan gave goes, and choosing Shrink video asks the scan now on screen; a re-encode under way keeps its progress (review F2.8)', async () => {
  // Opening reset every pane but Shrink video, which loads only while it holds no list: over a newer tree it showed
  // the older scan's videos, asked nothing — after a re-encode, the files just re-encoded, offered again.
  const video = (tag: string) => ({ available: true, shortlisted: 1, unreadable: 0,
    candidates: [{ name: `${tag}.mov`, path: `/r/${tag}.mov`, size: 5e9, estimatedBytes: 2e9, estimatedSaving: 3e9, reason: 'h264' }] });
  /** The packages answer with a project still beside its folder too, which fills the section's projects fold. */
  const packages = (tag: string) => {
    const p = smartRows(tag).packages as { activeBytes: number; ecosystems: Array<{ activeCount: number; activeBytes: number; entries: unknown[] }> };
    p.activeBytes = 7; p.ecosystems[0].activeCount = 1; p.ecosystems[0].activeBytes = 7;
    p.ecosystems[0].entries.push({ kind: 'active', path: `/r/${tag}-proj/node_modules`, name: 'node_modules', size: 7, modifiedAt: 0, reason: `In ${tag}-proj`, projectName: `${tag}-proj` });
    return p;
  };
  const state: Record<string, unknown> = { root: TREE, notes: new Map(), ...STOPPED };
  const c = cleanUpPage(state, (url) => {
    const tag = url.includes('scan-old') ? 'OLD' : 'NEW';
    if (url.startsWith('/api/compression/candidates')) return video(tag);
    if (url.startsWith('/api/packages/orphans')) return packages(tag);
    return smartRows(tag)[smartKindOf(url)];
  });
  c.given.browserFav = () => '';
  c.given.renderSmartGroups = noop;
  c.given.sizeInk = () => '';
  await c.open();
  c.fns.pane('video');
  c.fns.pane('smart');
  await turns();
  for (const host of ['videoBody', 'gitRepos', 'packageOrphans', 'packageProjects', 'browserProfiles']) {
    assert.match(c.$(host).innerHTML, /OLD/, `control: #${host} holds the older scan's rows`);
  }
  c.$('cleanModal').classList.remove('open'); // closed; the rescan lands — or a re-encode's own rescan
  Object.assign(state, LANDED);
  c.emitScan('scan-new');
  await turns();
  const before = c.asks.length;
  await c.open();
  for (const host of ['videoBody', 'gitRepos', 'packageOrphans', 'packageProjects', 'browserProfiles']) {
    assert.doesNotMatch(c.$(host).innerHTML, /OLD/, `opening the sheet takes #${host}'s older rows down (${c.$(host).innerHTML})`);
  }
  c.fns.pane('video');
  await turns();
  assert.deepEqual(c.asks.slice(before).filter((a) => a.url.startsWith('/api/compression/candidates')).map((a) => a.scanId), ['scan-new'],
    'choosing Shrink video asks the scan now on screen');
  assert.match(c.$('videoBody').innerHTML, /NEW\.mov/, 'and lists its videos');
  assert.doesNotMatch(c.$('videoBody').innerHTML, /OLD\.mov/, 'and none of the older scan\'s');
  // A re-encode under way: its progress is in the pane, and opening the sheet keeps it.
  c.$('videoBody').innerHTML = '<div id="vidProgress">2 of 3 done</div>';
  c.given.videoJobStream = { close: noop };
  c.$('cleanModal').classList.remove('open');
  const asked = c.asks.length;
  await c.open();
  c.fns.pane('video');
  await turns();
  assert.match(c.$('videoBody').innerHTML, /2 of 3 done/, 'a re-encode under way keeps its progress in the pane');
  assert.equal(c.asks.slice(asked).filter((a) => a.url.startsWith('/api/compression/candidates')).length, 0, 'and its list is not asked again over it');
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
    ['function budgetFor(', 'async function loadBudgets(', 'async function currentSavedBudgets(', 'function renderBudgetWidget(', 'function paintBudgetWidget(', 'function fxBudgetGaugesDrop(', 'function openBudgetDialog('], {
      state, $, document: { activeElement: null, body: null }, loadBudgetsSeq: 0, budgetGauges: [], seedNodes: noop, isSun: () => false, presentView: noop, nodeFor: () => null,
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
    ['function budgetFor(', 'async function loadBudgets(', 'async function currentSavedBudgets(', 'function renderBudgetWidget(', 'function paintBudgetWidget(', 'function fxBudgetGaugesDrop('], {
      state, $, document: { activeElement: null, body: null }, loadBudgetsSeq: 0, budgetGauges: [], seedNodes: noop, isSun: () => false, presentView: noop,
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
  // Each half of that guard on its own (review F3.4): the settings reads answered out of order, by hand.
  const pending: Array<(v: unknown) => void> = [];
  const held = page<{ load: () => Promise<void>; budgetFor: (p: string) => { maxBytes: number } | null }>(
    ['function budgetFor(', 'async function loadBudgets(', 'async function currentSavedBudgets(', 'function renderBudgetWidget(', 'function paintBudgetWidget(', 'function fxBudgetGaugesDrop('], {
      state, $, document: { activeElement: null, body: null }, loadBudgetsSeq: 0, budgetGauges: [], seedNodes: noop, isSun: () => false, presentView: noop,
      formatBytes: (n: number) => `${n} B`, escapeHtml: esc, icon: () => '', budgetProjectionLine: () => '', FxCharts: { gauge: () => ({ destroy: noop }), ramp: noop },
    }, '{ load: loadBudgets, budgetFor }',
    (url) => (url === '/api/settings' ? new Promise((resolve) => { pending.push(resolve); }) : url.includes('budget-gauges') ? { gauges: [] } : { budgets: [measured] }));
  // Two loads over the saved index's tree (beginScanChrome's re-entry, then the index paint), a budget
  // removed between them: the newer read answers first, the older last.
  Object.assign(state, INDEX_RUNNING);
  const older = held.fns.load();
  await turns();
  const newer = held.fns.load();
  await turns();
  pending[1]({ budgets: [{ path: '/r/mail', maxBytes: 5_000_000_000 }] }); // /elsewhere removed since
  await newer;
  pending[0]({ budgets: SAVED });
  await older;
  await turns();
  assert.deepEqual([held.fns.budgetFor('/r/mail')?.maxBytes, held.fns.budgetFor('/elsewhere')], [5_000_000_000, null],
    'the newest load\'s answer is kept, and the older one answering last is not: the menu offers no "Remove budget" for a budget removed since');
  // A Stop puts the older tree back with its scan while the settings read is out, and no load follows here.
  const lone = held.fns.load();
  await turns();
  Object.assign(state, STOPPED);
  pending[2]({ budgets: SAVED });
  await lone;
  await turns();
  assert.equal(held.fns.budgetFor('/elsewhere'), null, 'a saved list answering once a scan stands behind the tree is not kept over it, though no newer load was made');
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
    ['async function tourLoadWins(', 'function tourRejudgeWins(', 'function tourScanStarted(', 'function tourScanFailed(', 'subscribe(TOPIC.scan, () => {\n  const landed'], {
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

  // Waiting, then a Stop puts the older tree back (putBackHeldTree emits TOPIC.scan): asked of that tree's scan. The
  // Stop is recorded first (stopScan, BQR-1 item 12a), so the emit is no landing: the wins are asked again all the same.
  Object.assign(state, INDEX_RUNNING);
  tour.step = 'map';
  await fns.wins();
  const put = asks.length;
  Object.assign(state, STOPPED, { scanGen: 4, lastStop: { gen: 4, noted: null } });
  landed();
  await turns();
  assert.deepEqual(asks.slice(put).map((a) => a.scanId), ['scan-old'], 'a Stop that puts the older tree back: asked of its scan');
  state.lastStop = null; // the scans below are begun after it
  cardHoldsFocus = false;
  Object.assign(state, INDEX_RUNNING);
  tour.step = 'map';
  await fns.wins();
  Object.assign(state, LANDED);
  landed();
  await turns();
  assert.equal(focused.at(-1), false, 'focus elsewhere — the map, a field — is not pulled to the card when a scan lands');
  cardHoldsFocus = true;

  // The emit asks waiting wins again whatever it is (95061ba9) — the index paint too, which is no landing: only the
  // card's own move to the map waits for a landing (review F1.6).
  Object.assign(tour, { winsAwaitScan: false, step: 'map' });
  Object.assign(state, INDEX_STOPPED);
  await fns.wins();
  assert.deepEqual([tour.step, tour.winsAwaitScan], ['unknown', true], 'control: nothing coming — the wins wait for a scan');
  Object.assign(state, INDEX_RUNNING); // finishScan's index paint: the saved index's tree, its scan due
  landed();
  await turns();
  assert.equal(tour.step, 'map', 'the index paint asks the waiting wins again: the scan they wait for is coming');

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
  const state: Record<string, unknown> = { root: TREE, ...HELD, expiredOffer: null };
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
  const state: Record<string, unknown> = { root: TREE, ...HELD, expiredOffer: null };
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

test('the map\'s expired scan is said as the sentence alone — once at rest, with Scan again; during a scan as a sentence, not as a failure — never "Treemap failed: These results have expired…"; a map that really failed still says so (eighth browser pass K05)', async () => {
  const DURING = 'These results have expired — the scan under way replaces them when it finishes.';
  const AT_REST = 'These results have expired — scan the folder again to refresh them.';
  const toasts: Array<[string, string | undefined]> = [];
  const offers: string[] = [];
  const state: Record<string, unknown> = { root: TREE, ...STOPPED, expiredOffer: null,
    treemap: { mode: 'treemap', rootPath: '/r', maxDepth: 4, kbSel: null, history: { scrubbing: false } } };
  let answer = { status: 404, body: { error: 'Unknown or expired scanId', code: 'SCAN_NOT_FOUND' } };
  // The server, as it answers a map of a scan it no longer holds (a restart emptied its memory).
  const fetch = async () => ({ status: answer.status, ok: false, text: async () => JSON.stringify(answer.body) });
  const { fns } = page<{ load: (p: string) => Promise<void> }>(['async function api(url', 'function scanResultsExpired(', 'function reportError(', 'async function loadTreemap('], {
    state, fetch, setTimeout, $: stubDom(), tmLoadSeq: 0, REDUCED: true, isSun: () => false, isCells: () => false, TM_MIN_SIZE: 4096,
    exitCartPreview: noop, altCircleFor: () => null,
    // The offer, still on screen (toastAction's handle): its going is the next test's.
    toast: (m: string, k?: string) => { toasts.push([m, k]); }, toastAction: (m: string) => { offers.push(m); return { isOpen: () => true }; }, startScan: noop,
  }, '{ load: loadTreemap }');
  await fns.load('/r');
  await fns.load('/r');
  assert.deepEqual(offers, [AT_REST], 'at rest: the sentence, offered once with Scan again');
  assert.deepEqual(toasts, [], 'and nothing more — not "Treemap failed: …", not the sentence twice');
  Object.assign(state, HELD, { expiredOffer: null });
  await fns.load('/r');
  assert.deepEqual(toasts, [[DURING, 'success']], 'during a scan: the sentence alone, said plainly — not as a failure');
  assert.deepEqual(offers, [AT_REST], 'and no Scan again over the scan under way');
  answer = { status: 500, body: { error: 'The drive stopped answering.', code: 'INTERNAL' } };
  await fns.load('/r');
  assert.deepEqual(toasts.at(-1), ['Treemap failed: The drive stopped answering.', 'error'], 'control: a map that really failed says so');
});

test('an expired scan is said again once its Scan again offer has gone — a click on the map, or Clean Up\'s Find, after the offer timed out or was dismissed said nothing and did nothing — while the offer is on screen nothing more is said, and Scan again is offered once per scan (review F1.1, F1.6)', async () => {
  const AT_REST = 'These results have expired — scan the folder again to refresh them.';
  const toasts: Array<[string, string | undefined]> = [];
  const offers: string[] = [];
  /** Whether the Scan again offer is on screen (toastAction's handle): it goes after 15 s, on Escape, or when chosen. */
  let offerUp = true;
  const state: Record<string, unknown> = { root: TREE, ...STOPPED, expiredOffer: null,
    treemap: { mode: 'treemap', rootPath: '/r', maxDepth: 4, kbSel: null, history: { scrubbing: false } } };
  // The server, as it answers about a scan it no longer holds (a restart emptied its memory, or a long idle).
  const fetch = async () => ({ status: 404, ok: false, text: async () => JSON.stringify({ error: 'Unknown or expired scanId', code: 'SCAN_NOT_FOUND' }) });
  const { fns } = page<{ load: (p: string) => Promise<void>; api: (url: string) => Promise<unknown>; report: (e: unknown) => void }>(
    ['async function api(url', 'function scanResultsExpired(', 'function reportError(', 'async function loadTreemap('], {
      state, fetch, setTimeout, $: stubDom(), tmLoadSeq: 0, REDUCED: true, isSun: () => false, isCells: () => false, TM_MIN_SIZE: 4096,
      exitCartPreview: noop, altCircleFor: () => null,
      toast: (m: string, k?: string) => { toasts.push([m, k]); },
      toastAction: (m: string) => { offers.push(m); return { isOpen: () => offerUp }; }, startScan: noop,
    }, '{ load: loadTreemap, api, report: reportError }');
  /** Clean Up's Custom rules › Find, as runCleanFind says what its request failed with. */
  const find = async () => { try { await fns.api(`/api/cleanup/rules?scanId=${String(state.scanId)}&limit=500`); } catch (e) { fns.report(e); } };
  await fns.load('/r');
  assert.deepEqual([offers, toasts], [[AT_REST], []], 'control: the map\'s failure offers Scan again, and says nothing more');
  await find();
  assert.deepEqual(toasts, [], 'while the offer is on screen, Find says nothing more — the offer says it');
  offerUp = false; // 15 s on: the offer has timed out, or was dismissed
  await fns.load('/r');
  assert.deepEqual(toasts, [[AT_REST, 'success']], 'once the offer has gone, a click on the map says the sentence, plainly — not nothing');
  await find();
  assert.deepEqual(toasts, [[AT_REST, 'success'], [AT_REST, 'success']], 'and so does Find');
  assert.deepEqual(offers, [AT_REST], 'Scan again is offered once for the scan, however many calls fail under it');
  // A later scan's results expiring are offered anew: the offer is the scan's.
  Object.assign(state, LANDED);
  offerUp = true;
  await fns.load('/r');
  assert.deepEqual(offers, [AT_REST, AT_REST], 'another scan\'s expiry offers Scan again for it');
  assert.equal(toasts.length, 2, 'with nothing more said beside it');
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
  // The Clean Up sheet's panes are not here: every one asks the tree's scan (eighth browser pass K04).
  // Read beside a call to a page function that asks — the audit follows calls (K04: a read that only
  // hands the scan on, or gates a call, asks as surely as one beside api()).
  stopScan: 'the scan\'s own lifecycle: cancels the running scan by its id, then puts back the tree\'s',
  failScan: 'the scan\'s own lifecycle: hands the scan on hand back to the tree\'s after a failure',
  finishScan: 'sets the scan on hand for the tree it paints, in the same breath, then asks of it',
  putBackHeldTree: 'puts the older tree back with its scan, then asks for its cards of that scan',
  armScanExpiry: 'warns before the landed scan\'s results expire, and says nothing while a scan runs',
  noteScanUsed: 'notes a read of the landed scan, which pushed its expiry on, and arms armScanExpiry\'s warning from it (hunt C17)',
  startOffloadFlow: 'a destructive act the server refuses for a running scan, in words',
  dockDrop: 'a destructive act the server refuses for a running scan, in words',
  "$('tmExportBtn').addEventListener('click', (e) => {": 'offers the report (downloadReport) only while no scan runs, when the scan on hand is the tree\'s',
};

test('no page function or top-level handler that asks the server reads the scan on hand, but those whose reason is stated — every other ask about the tree on screen goes through treeScanId', () => {
  const fns = pageFunctions();
  // Asks the server itself, or through any page function it calls that does (K04: a read of the scan on hand
  // that only gates a call, or hands the id to a loader, asked as surely as one beside api()).
  const code = (body: string) => body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/ .*$/gm, '');
  const direct = (body: string) => /\b(?:api|apiPaced|fetch)\(|new EventSource\(/.test(code(body));
  const asksServer = new Set(fns.filter((f) => direct(f.body)).map((f) => f.name));
  for (let grew = true; grew;) {
    grew = false;
    for (const f of fns) {
      if (asksServer.has(f.name)) continue;
      if ([...code(f.body).matchAll(/\b(\w+)\(/g)].some((m) => m[1] !== f.name && asksServer.has(m[1]))) { asksServer.add(f.name); grew = true; }
    }
  }
  const asks = (body: string) => direct(body) || [...code(body).matchAll(/\b(\w+)\(/g)].some((m) => asksServer.has(m[1]));
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
