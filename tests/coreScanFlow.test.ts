import { test } from 'node:test';
import assert from 'node:assert/strict';

import { INDEX, lift as liftPage } from './fixtures/liftFrontend';

/**
 * The core scan flow, as the owner reported it on 17 Oct 2026: "When you open
 * TreeMap it automatically runs a scan of the entire disk but ideally users
 * should be able to pick the folder for example desktop or if they actually
 * want a full disk scan. Another thing is that a scan should work again after
 * being stopped."
 *
 *  (A) Opening the app never starts a walk on its own. A completed scan the
 *      server still holds is reopened (no walk); with nothing held, the start
 *      screen names the last folder from the history and offers it. This
 *      supersedes B38, which scanned the newest history folder again at boot
 *      — the owner's was `/`, so every launch walked the whole disk.
 *  (B) The start screen offers what to scan: the last folder first, then
 *      Desktop, Documents, Downloads and the home folder as the server found
 *      them, the whole drive as the folder picker names it, and "Choose a
 *      folder…", the one primary.
 *  (C) After a Stop or a failed scan with nothing on screen, the folder stays
 *      named with "Scan … again" first and focus on it, and a scan works again.
 *
 * Every function below is EXECUTED out of the built page — the boot restore,
 * the start screen, switchView, the scan's start, Stop and failure, focus —
 * with `fetch` stubbed under the page's own `api()`, EventSource and the
 * watchdog's interval counted, and a stub DOM whose controls paint only while
 * the part of the page they sit in is on screen. Nothing is timed: the tests
 * let counted turns of the event loop pass.
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

/* ───────────────────────────── a stub DOM ───────────────────────────── */

const decode = (s: string) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

class El {
  hidden = false;
  disabled = false;
  value = '';
  title = '';
  textContent = '';
  focused = 0;
  /** Taken out of the document by a rewrite of its parent's innerHTML: a browser paints it no more, and focus on it falls to <body>. */
  detached = false;
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  attrs: Record<string, string> = {};
  cls = new Set<string>();
  listeners: Record<string, Array<(e?: unknown) => void>> = {};
  children: El[] = [];
  private html = '';
  constructor(public dom: Dom, public id: string, public parent: El | null = null) {}
  classList = {
    add: (...c: string[]) => { for (const x of c) this.cls.add(x); },
    remove: (...c: string[]) => { for (const x of c) this.cls.delete(x); },
    toggle: (c: string, on?: boolean) => { const n = on === undefined ? !this.cls.has(c) : on; if (n) this.cls.add(c); else this.cls.delete(c); return n; },
    contains: (c: string) => this.cls.has(c),
  };
  get innerHTML(): string { return this.html; }
  /** Buttons written into it become children, found by id, class and attribute, as a browser's would. */
  set innerHTML(v: string) {
    for (const c of this.children) {
      c.detached = true;
      if (c.id && this.dom.els.get(c.id) === c) this.dom.els.delete(c.id);
    }
    this.children = [];
    this.html = v;
    for (const m of v.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)) {
      const attrs: Record<string, string> = {};
      for (const a of m[1].matchAll(/([\w-]+)="([^"]*)"/g)) attrs[a[1]] = decode(a[2]);
      const b = new El(this.dom, attrs.id || '', this);
      b.attrs = attrs;
      for (const c of (attrs.class || '').split(/\s+/).filter(Boolean)) b.cls.add(c);
      b.title = attrs.title || '';
      b.textContent = decode(m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
      this.children.push(b);
      if (b.id) this.dom.els.set(b.id, b);
    }
  }
  /** Painted: shown itself and inside something shown. The empty state paints only as `display: flex`. */
  painted(): boolean {
    if (this.detached) return false;
    if (this.id === 'emptyState') return this.style.display === 'flex';
    if (this.hidden || this.style.display === 'none') return false;
    return this.parent ? this.parent.painted() : true;
  }
  getClientRects(): unknown[] { return this.painted() ? [{}] : []; }
  focus(): void { this.focused++; this.dom.active = this; }
  addEventListener(n: string, fn: (e?: unknown) => void): void { (this.listeners[n] ??= []).push(fn); }
  click(): void { for (const fn of this.listeners.click ?? []) fn({ target: this }); }
  setAttribute(k: string, v: string): void { this.attrs[k] = v; }
  getAttribute(k: string): string | null { return k in this.attrs ? this.attrs[k] : null; }
  removeAttribute(k: string): void { delete this.attrs[k]; }
  contains(n: unknown): boolean { return n === this || this.children.includes(n as El); }
  closest(): null { return null; }
  querySelectorAll(sel: string): El[] {
    const attr = /^\[([\w-]+)\]$/.exec(sel);
    if (attr) return this.children.filter((c) => attr[1] in c.attrs);
    if (sel.startsWith('.')) return this.children.filter((c) => c.cls.has(sel.slice(1)));
    if (sel === 'button') return [...this.children];
    return [];
  }
  querySelector(sel: string): El | null { return this.querySelectorAll(sel)[0] ?? null; }
}

/** The Dashboard's controls in the page's order (activeViewControl takes the first on screen): the System card's Trash row, then the Scan card's path box and Scan/Stop. */
const DASHBOARD_CONTROLS = ['trashFact', 'pathInput', 'scanBtn'];

class Dom {
  els = new Map<string, El>();
  active: El | null = null;
  body: El;
  constructor() {
    this.body = new El(this, 'body');
    const empty = this.get('emptyState');
    for (const id of ['emptyHero', 'emptyForView', 'startLast', 'startChoices', 'emptyBrowseBtn']) this.get(id).parent = empty;
    const dash = this.get('view-dashboard');
    // The Dashboard's controls, in the page's order: the System card's Trash row (a role=button row) comes first.
    for (const id of DASHBOARD_CONTROLS) this.get(id).parent = dash;
    this.get('emptyForView').hidden = true;
    this.get('startLast').hidden = true;
    for (const c of ['btn', 'btn-primary']) this.get('emptyBrowseBtn').cls.add(c); // as the markup ships it
  }
  get(id: string): El {
    let e = this.els.get(id);
    if (!e) { e = new El(this, id); this.els.set(id, e); }
    return e;
  }
  /** What holds focus as a browser reports it: a control that stopped painting has handed it to <body>. */
  get activeElement(): El { return this.active && this.active.painted() ? this.active : this.body; }
}

/* ───────────────────────────── the page ───────────────────────────── */

type Answer = { status?: number; body?: unknown } | Promise<{ status?: number; body?: unknown }>;
type Route = (method: string, url: string, body: Record<string, unknown> | null) => Answer | undefined;

const MAC = {
  platform: 'darwin', homeDir: '/Users/x', hostname: 'h',
  commonDirs: ['/Users/x', '/Users/x/Desktop', '/Users/x/Documents', '/Users/x/Downloads', '/Users/x/Pictures'],
};
const TOPO_MAC = { logicalVolumes: [{ mountPoint: '/', name: 'Macintosh HD' }, { mountPoint: '/System/Volumes/Data', name: 'Data' }] };

/** The functions under test, lifted whole from the page, and the page-level bindings they share. */
const LIFTED = [
  'async function api(url', 'function escapeHtml(', 'function asPath(', 'function lastPathSegment(',
  'function viewBlockedReason(', 'function renderEmptyState(', 'function switchView(',
  'function startLanding(', 'function focusLanding(', 'function activeViewControl(', 'function withFocusKept(', 'function focusStartScreen(',
  'function closeEventSource(', 'function setScanButtonMode(', 'function cancelScanById(', 'function abandonIfStopped(',
  'async function stopScan(', 'function stopNotConfirmed(', 'function putBackHeldTree(', 'function beginScanChrome(', 'async function indexStatusFor(',
  'async function startScan(', 'async function startScanRequest(', 'function followScanProgress(',
  'function endScanChrome(', 'function failScan(', 'function noteLastFolder(', 'function noteStopUnconfirmed(',
  'function browseWholeDrives(', 'function topologyAnswer(',
  'function startChoiceList(', 'function startFolderName(', 'function startLastLine(', 'function renderStartChoices(', 'function scanStartChoice(', 'async function startNameDrives(',
  'async function startJudge(', 'function startNoteAllowed(',
  'function requestedPath(', 'async function restoreLastSession(', 'function showRestoredPath(', 'async function reopenScan(',
  'async function startCloudScan(', 'async function loadSystem(',
];
const OWN = new Set(LIFTED.map((d) => /function (\w+)\(/.exec(d)![1]));
/**
 * The index-first path, lifted whole for the pages that ask for it (`index`):
 * the instant paint from the saved index and the paint of a finished scan —
 * which together decide which tree, and which scan, are on screen after a
 * Stop (J05, J06).
 */
const LIFTED_INDEX = ['async function openFromIndex(', 'async function finishScan(', 'function quietRescanFailed('];

/**
 * A view object out of the page's VIEWS list, by its id, brace-matched: the
 * treemap view's own `mount` decides whether the map is drawn at all.
 */
function pageView(id: string): string {
  const at = INDEX.indexOf(`id: '${id}', label:`);
  assert.notEqual(at, -1, `the ${id} view is in the page`);
  const start = INDEX.lastIndexOf('{', at);
  let depth = 0;
  for (let i = start; i < INDEX.length; i++) {
    if (INDEX[i] === '{') depth++;
    else if (INDEX[i] === '}' && --depth === 0) return INDEX.slice(start, i + 1);
  }
  return assert.fail(`the ${id} view never closes`);
}

const formatBytes = liftPage<(n: number) => string>(['UNITS', 'UI_LOCALE', 'formatBytes'], 'formatBytes');
/** The page's own constants the lifted functions read. */
const START_FOLDERS = liftPage<string[]>(['START_FOLDERS'], 'START_FOLDERS');
const FOLDER_REFUSED_STATUSES = liftPage<number[]>(['FOLDER_REFUSED_STATUSES'], 'FOLDER_REFUSED_STATUSES');
const formatDate = liftPage<(ms: number) => string>(['UI_LOCALE', 'DATE_FMT', 'dateMemo', 'formatDate'], 'formatDate');

/** Let `n` turns of the event loop pass: a count, never a time. */
async function turns(n = 30): Promise<void> {
  for (let i = 0; i < n; i++) await new Promise((resolve) => setImmediate(resolve));
}

/** A draw the treemap view asked for (loadTreemap): the folder asked, and the tree and scan on screen as it asked. */
type Draw = { path: string; root: string | null; scanId: unknown };

function page(o: { route: Route; system?: unknown; search?: string; root?: unknown; settledScanId?: string | null; index?: boolean }) {
  const dom = new Dom();
  const $ = (id: string) => dom.get(id);
  const requests: string[] = [];
  const posts: Array<Record<string, unknown>> = [];
  const toasts: Array<[string, string?]> = [];
  const finished: unknown[] = [];
  /** Each failure of a quiet rescan behind an index paint the page reported (quietRescanFailed). */
  const quietFailed: unknown[] = [];
  const tourCalls: string[] = [];
  /** Every EventSource the page opened, and whether each is still open. */
  const streams: Array<{ url: string; readyState: number; close: () => void; onmessage: ((ev: { data: string }) => void) | null; onerror: (() => void) | null }> = [];
  class FakeEventSource {
    static CLOSED = 2;
    readyState = 0;
    onmessage: ((ev: { data: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(public url: string) { streams.push(this); }
    close() { this.readyState = 2; }
  }
  const intervals = new Set<number>();
  let nextInterval = 1;
  const fetchStub = async (url: string, options?: { method?: string; body?: string }) => {
    const method = options?.method ?? 'GET';
    const body = options?.body ? JSON.parse(options.body) as Record<string, unknown> : null;
    requests.push(`${method} ${url}`);
    if (method === 'POST' && url === '/api/scan') posts.push(body!);
    const a = await (o.route(method, url, body) ?? assert.fail(`unexpected ${method} ${url}`));
    const status = a.status ?? 200;
    return { status, ok: status >= 200 && status < 300, text: async () => (a.body === undefined ? '' : JSON.stringify(a.body)) };
  };
  const state: Record<string, unknown> = {
    view: 'dashboard', system: 'system' in o ? o.system : MAC, capabilities: null, scanId: o.settledScanId ?? null, settledScanId: o.settledScanId ?? null,
    scanning: false, es: null, abortScan: null, scanGen: 0, root: o.root ?? null, scanStats: null, whatsNew: { seq: 0 },
    lastFolder: null, scanningPath: null, scannedBefore: false, largest: [], bigFolders: [], types: [],
    // What finishScan and the treemap view read and write besides the tree.
    grid: { path: null, selection: new Set() }, treemap: { rootPath: null }, apps: { loadedFor: null }, live: { wanted: false, on: false },
    dup: {}, lastScan: null,
  };
  /** Every draw the treemap view asked for, in order (index pages). */
  const draws: Draw[] = [];
  /** Every scan id finishScan announced to the views (TOPIC.scan), in order: null is the index paint. */
  const emitted: unknown[] = [];
  const noop = () => {};
  const VIEW_BY_ID = new Map<string, unknown>([
    ['dashboard', { id: 'dashboard', label: 'Dashboard', icon: 'dashboard', needsScan: true, mount: noop }],
    ['grid', { id: 'grid', label: 'Grid', icon: 'grid', needsScan: true, mount: noop }],
    ['trends', { id: 'trends', label: 'Trends', icon: 'trendUp', needsScan: false, mount: noop }],
  ]);
  const document = {
    get activeElement() { return dom.activeElement; },
    get body() { return dom.body; },
    querySelector: (sel: string) => (sel === '.tabbar button[aria-selected="true"]' ? $('tab-dashboard') : null),
    querySelectorAll: (sel: string) => (sel === '.view' ? [$('view-dashboard'), $('view-grid'), $('view-trends'), $('view-treemap')]
      // activeViewControl's question: the controls of the view that is up, in the page's order.
      : sel.startsWith('.view.active ') ? DASHBOARD_CONTROLS.map($).filter((c) => !!c.parent && c.parent.cls.has('active')) : []),
  };
  const given: Record<string, unknown> = {
    state, $, document, fetch: fetchStub, EventSource: FakeEventSource, location: { search: o.search ?? '' },
    setInterval: () => { const id = nextInterval++; intervals.add(id); return id; },
    clearInterval: (id: number) => { intervals.delete(id); },
    console: { warn: noop, error: noop, log: noop },
    VIEW_BY_ID, tabs: [], mountedView: null, indexLineGen: 0, indexAutoMaxEntries: null, browseDrivesSeen: null, topologyShared: null,
    startDrivesAsked: false, startShown: [], startPainted: null, startVerdicts: new Map(), startAsking: new Set(), START_FOLDERS, FOLDER_REFUSED_STATUSES,
    TOPOLOGY_SHARE_MS: 3000, REDUCED: true, INSTANT_OPEN_NODES: 25000,
    EMPTY_VIEW_LEADS: {}, EMPTY_VIEW_LEAD_DEFAULT: 'Once a folder is scanned, this view fills in.', // another view's empty state (G02)
    formatBytes, formatDate, formatCount: String, icon: () => '', skeletonRows: () => '',
    toast: (m: string, k?: string) => { toasts.push([m, k]); },
    finishScan: async (root: unknown) => { finished.push(root); state.root = root; },
    maybeShowFastRescan: noop, rememberScannedRoot: noop, showFastRescanStat: noop, scanStatsFor: async () => ({}),
    restoreDashboardPanels: noop, renderIndexBadge: noop, renderIndexLine: noop, disableLive: noop, clearDonut: noop,
    fxStateBeam: noop, fxOrbShow: noop, fxOrbHide: noop, fxScanHeroSync: noop, fxDonutLoadingSync: noop, fxEmptyCtaSync: noop, fxViewEnter: noop,
    hideTooltip: noop, hideCtxMenu: noop, selectionBarFollowView: noop, renderCapabilityNotice: noop,
    scanAccessNotice: async () => false, clearScanQueue: noop, drainScanQueue: noop, quietRescanFailed: (e: unknown) => { quietFailed.push(e); },
    openFromIndex: async () => false,
    tourCardControl: () => null,
    // What loadSystem paints besides the start screen: the System card, the key names, the side panels.
    renderKeyNames: noop, paintDiskFacts: noop, loadTrash: noop, loadSnapshots: noop, loadCloudStatus: noop,
    tourScanStarted: () => tourCalls.push('started'), tourScanFailed: () => tourCalls.push('failed'),
    tourFollowView: noop, tourBootSettled: () => tourCalls.push('boot settled'),
    // The index-first path (`index`): what openFromIndex and finishScan call besides the lifted functions.
    ...(o.index ? {
      indexTree: noop, updateSelectionBar: noop, DUP_PAGE: 50, formatClock: String, countUp: noop, FxNum: { rollText: noop },
      renderDiskNotes: noop, fxScanDonePulse: noop, loadWhatsNew: noop, loadDriveHealth: noop, showListsPending: noop,
      emit: (_topic: unknown, id: unknown) => { emitted.push(id); }, TOPIC: { scan: 'scan' },
      loadDashboardLists: async () => true, loadCostEstimate: noop, buildIndexInBackground: noop, renderGrowthProjection: noop,
      loadBudgets: noop, refreshTimebar: noop, enableLive: noop, setTimeout: () => 0,
      // The treemap view's own mount and onScanChange are the page's; what they call is recorded here.
      loadTreemap: (p: string) => { const r = state.root as { path: string } | null; draws.push({ path: p, root: r ? r.path : null, scanId: state.scanId }); },
      fxTmPillBeamsSync: noop, loadSavedViews: noop, refreshDock: noop, tmRejudgeQuery: noop, exitHistoryState: noop,
    } : {}),
  };
  const own = new Set([...OWN, ...(o.index ? LIFTED_INDEX.map((d) => /function (\w+)\(/.exec(d)![1]) : [])]);
  const scope = new Proxy(given, {
    has: (t, k) => typeof k === 'string' && k in t && !own.has(k),
    get: (t, k) => (k === Symbol.unscopables ? undefined : t[k as string]),
    set: (t, k, v) => { t[k as string] = v; return true; },
  });
  const src = [...LIFTED, ...(o.index ? LIFTED_INDEX : [])].map(pageFn).join('\n');
  // The real treemap view, its unmount aside (it tears down canvas machinery this page has none of).
  const views = o.index ? `VIEW_BY_ID.set('treemap', { ...(${pageView('treemap')}), unmount() {} });` : '';
  const fns = new Function('scope', `with (scope) { ${src}\n${views}\n return { switchView, restoreLastSession, startScan, stopScan, failScan, renderStartChoices, startCloudScan, loadSystem }; }`)(scope) as {
    switchView: (v: string) => void; restoreLastSession: () => Promise<void>; startScan: (p: string, o?: unknown) => Promise<void>;
    stopScan: () => Promise<void>; failScan: (m: string, e?: unknown) => void; renderStartChoices: () => void;
    startCloudScan: (id: string, name: string) => Promise<void>; loadSystem: () => Promise<unknown>;
  };
  /** The start screen's choices as a person sees them: each button's words, in order. */
  const choices = () => $('startChoices').children.map((b) => b.textContent);
  const choice = (words: RegExp) => {
    const b = $('startChoices').children.find((c) => words.test(c.textContent));
    assert.ok(b, `a choice reads ${words} (${choices().join(' | ')})`);
    return b!;
  };
  const openStreams = () => streams.filter((s) => s.readyState !== 2);
  return { ...fns, dom, $, state, requests, posts, toasts, finished, quietFailed, tourCalls, streams, openStreams, intervals, choices, choice, given, draws, emitted };
}

/** A server: the history and the folders a test names, a scan request answered with the next id, and its cancel. */
function server(opts: {
  scans?: unknown[]; roots?: unknown[] | Error; missing?: string[]; topology?: unknown; indexed?: string[];
  scanAnswer?: (n: number, body: Record<string, unknown>) => Answer;
  /** The rules' refusal of a scan of each folder, in POST /api/scan's words, or null: GET /api/policy?scanRoot= judges by it. */
  refuse?: (p: string) => string | null;
  /** GET /api/policy?scanRoot= answered otherwise: held, or failing. */
  policyAnswer?: (asked: string[]) => Answer;
  /** The saved index's tree of each folder in `indexed` that has one (GET /api/index/tree), as the server sends it. */
  indexTrees?: Record<string, unknown>;
} = {}): Route {
  let n = 0;
  return (method, url, body) => {
    if (method === 'GET' && url.startsWith('/api/index/tree?path=')) {
      const p = decodeURIComponent(url.slice('/api/index/tree?path='.length).split('&')[0]);
      const tree = opts.indexTrees && opts.indexTrees[p];
      return tree ? { body: { path: p, rootPath: p, fileCount: 1, dirCount: 1, totalSize: 1, root: tree } } : { status: 404, body: { error: 'Not indexed', code: 'NOT_INDEXED' } };
    }
    if (method === 'GET' && url.startsWith('/api/policy?')) {
      const asked = url.slice('/api/policy?'.length).split('&').map((kv) => decodeURIComponent(kv.slice('scanRoot='.length)));
      if (opts.policyAnswer) return opts.policyAnswer(asked);
      const refuse = opts.refuse ?? (() => null);
      return { body: { policy: { allowedRoots: [], protectedPaths: [], maxBytesPerOperation: null }, file: '/data/agent-policy.json',
        scanRoots: asked.map((p) => (refuse(p) ? { path: p, allowed: false, code: 'POLICY_ROOT_NOT_ALLOWED', error: refuse(p) } : { path: p, allowed: true })) } };
    }
    if (method === 'GET' && url === '/api/scans') return { body: { scans: opts.scans ?? [] } };
    if (method === 'GET' && url === '/api/snapshots') {
      return opts.roots instanceof Error ? { status: 500, body: { error: opts.roots.message, code: 'INTERNAL' } } : { body: { roots: opts.roots ?? [] } };
    }
    if (method === 'GET' && url.startsWith('/api/fs/list?path=')) {
      const p = decodeURIComponent(url.slice('/api/fs/list?path='.length));
      return (opts.missing ?? []).includes(p)
        ? { status: 404, body: { error: 'Path does not exist', code: 'PATH_NOT_FOUND' } }
        : { body: { path: p, parent: null, dirs: [], total: 0 } };
    }
    if (method === 'GET' && url === '/api/platform/topology') return { body: opts.topology ?? TOPO_MAC };
    if (method === 'GET' && url.startsWith('/api/index/status?path=')) {
      const p = decodeURIComponent(url.slice('/api/index/status?path='.length));
      return (opts.indexed ?? []).includes(p)
        ? { body: { path: p, indexed: true, root: { path: p, state: 'ready', live: true } } }
        : { body: { indexed: false, root: null } };
    }
    if (method === 'POST' && url === '/api/scan') return opts.scanAnswer ? opts.scanAnswer(++n, body!) : { status: 202, body: { scanId: `scan-${++n}`, incremental: false } };
    if (method === 'POST' && /^\/api\/scan\/[\w-]+\/cancel$/.test(url)) return { body: { cancelled: true } };
    return undefined;
  };
}

const ROOT_HISTORY = { rootPath: '/', count: 7, latestAt: Date.UTC(2026, 9, 15, 9, 30), latestSize: 494_380_000_000 };

/** Boot as the page does: the Dashboard first (switchView), then the restore. */
async function boot(h: ReturnType<typeof page>): Promise<void> {
  h.switchView('dashboard');
  await h.restoreLastSession();
  await turns();
}

/** The start screen's primary-styled buttons, by id: G03 allows one, "Choose a folder…". */
const primaries = (h: ReturnType<typeof page>) => [...h.$('startChoices').children, h.$('emptyBrowseBtn')].filter((b) => b.cls.has('btn-primary')).map((b) => b.id);

/* ══════════════ (A) + (B) — opening the app ══════════════ */

test('(i) with `/` in the history and nothing held, boot sends no scan: the start screen names `/` as the startup disk with its last size and date, and offers the choices (supersedes B38)', async () => {
  const h = page({ route: server({ roots: [ROOT_HISTORY] }) });
  await boot(h);
  assert.equal(h.posts.length, 0, `no POST /api/scan: opening the app never starts a walk (${h.requests.join(', ')})`);
  assert.deepEqual(h.toasts, [], 'and nothing says a scan started — no "scanning it again"');
  assert.equal(h.$('emptyState').style.display, 'flex', 'the start screen is up over the Dashboard');
  assert.deepEqual(h.choices(), [
    `Scan Macintosh HD again ${formatBytes(494_380_000_000)} · ${formatDate(ROOT_HISTORY.latestAt)}`,
    'Desktop', 'Documents', 'Downloads', 'Home folder',
  ], 'the last folder first, by the startup disk\'s own name, with its size (decimal) and date; then the folders the server found; the whole drive once, as the last folder');
  assert.equal(formatBytes(494_380_000_000), '494.4 GB', 'control: decimal units');
  assert.equal(h.choice(/^Scan Macintosh HD again/).title, '/', 'the again choice names its path');
  assert.ok(h.choices().every((c) => !/Pictures/.test(c)), 'only the folders the start screen offers, not every one the picker lists');
  const primaries = [...h.$('startChoices').children, h.$('emptyBrowseBtn')].filter((b) => b.cls.has('btn-primary'));
  assert.deepEqual(primaries.map((b) => b.id), ['emptyBrowseBtn'], 'one primary: Choose a folder…');
  assert.equal(h.state.scannedBefore, true, 'the person has scanned before: the history says so');
  assert.deepEqual(h.tourCalls, ['boot settled'], 'and the tour hears that the restore has settled');
});

test('(ii) a completed scan the server still holds is reopened, with no POST /api/scan', async () => {
  const LAST = { scanId: 's9', rootPath: '/Users/x/corpus', totalSize: 8_800_000_000, finishedAt: 1_700_000_000_000 };
  const h = page({
    route: (m, url) => (url === '/api/scan/s9/stats' ? { body: { scanId: 's9', status: 'complete', durationMs: 200, fileCount: 3 } }
      : url === '/api/scan/s9/result' ? { body: { status: 'complete', scanId: 's9', root: { path: '/Users/x/corpus', size: 8_800_000_000 } } }
      : server({ scans: [LAST] })(m, url, null)),
  });
  await boot(h);
  assert.equal(h.posts.length, 0, `nothing walked (${h.requests.join(', ')})`);
  assert.equal(h.finished.length, 1, 'the held tree is painted');
  assert.equal(h.state.scanId, 's9');
});

test('a held scan that has gone when asked, or could not be reopened, is named and offered — never walked (supersedes D57\'s rescan)', async () => {
  const LAST = { scanId: 's9', rootPath: '/Users/x/corpus', totalSize: 8_800_000_000, finishedAt: 1_700_000_000_000 };
  for (const [what, stats, line] of [
    ['gone (404)', { status: 404, body: { error: 'Unknown or expired scanId', code: 'SCAN_NOT_FOUND' } }, null],
    ['the server did not answer', { status: 500, body: { error: 'The scan’s first frame could not be sent.', code: 'INTERNAL' } }, /^Couldn’t reopen your last scan of \/Users\/x\/corpus \(The scan’s first frame could not be sent\.\)\.$/],
  ] as const) {
    const h = page({ route: (m, url) => (url === '/api/scan/s9/stats' ? stats : server({ scans: [LAST] })(m, url, null)) });
    await boot(h);
    assert.equal(h.posts.length, 0, `${what}: nothing walked`);
    assert.equal(h.choices()[0], `Scan corpus again ${formatBytes(8_800_000_000)} · ${formatDate(LAST.finishedAt)}`, `${what}: offered first, with its size and date`);
    if (line) {
      assert.equal(h.$('startLast').hidden, false, `${what}: and said`);
      assert.match(h.$('startLast').textContent, line);
    } else assert.equal(h.$('startLast').hidden, true, `${what}: a scan that expired needs no sentence`);
  }
});

test('the start screen offers only folders that exist: a missing Downloads is not offered, the last folder only when the server can open it, and a cloud account stays as it was', async () => {
  const sys = { ...MAC, commonDirs: ['/Users/x', '/Users/x/Desktop', '/Users/x/Documents'] };
  const h = page({ system: sys, route: server({ roots: [{ rootPath: '/Volumes/Photos', count: 1, latestAt: 1_700_000_000_000, latestSize: 1 }], missing: ['/Volumes/Photos'] }) });
  await boot(h);
  assert.deepEqual(h.choices(), ['Desktop', 'Documents', 'Home folder', 'Macintosh HD Whole drive'],
    'no "Scan Photos again" for a folder that answers an error, no Downloads the server did not find; the whole drive by its name');
  assert.equal(h.$('startLast').hidden, false);
  assert.equal(h.$('startLast').textContent, 'Your last scan was of /Volumes/Photos, which cannot be opened now: Path does not exist.');
  assert.equal(h.choice(/Whole drive/).title, '/ — the whole drive');

  const cloud = page({ route: server({ roots: [{ rootPath: 'cloud://gdrive/', count: 1, latestAt: 1, latestSize: 1 }] }) });
  await boot(cloud);
  assert.deepEqual(cloud.choices(), ['Desktop', 'Documents', 'Downloads', 'Home folder', 'Macintosh HD Whole drive'], 'a cloud account is not offered again from the start screen');
  assert.equal(cloud.$('startLast').hidden, true, 'nor named');
  assert.equal(cloud.posts.length + h.posts.length, 0);
  const heldCloud = page({ route: server({ scans: [{ scanId: 'c1', rootPath: 'cloud://gdrive', totalSize: 1, finishedAt: 1 }] }) });
  await boot(heldCloud);
  assert.ok(!heldCloud.choices().some((c) => /again/.test(c)), 'nor a cloud account\'s scan the server still holds');
  assert.ok(!heldCloud.requests.some((r) => r.includes('/api/scan/c1/')), 'which is not reopened either — its sign-in may be gone');

  const first = page({ route: server({ roots: [] }) });
  await boot(first);
  assert.deepEqual(first.choices(), ['Desktop', 'Documents', 'Downloads', 'Home folder', 'Macintosh HD Whole drive'], 'a first run: the choices, nothing named');
  assert.equal(first.state.scannedBefore, false, 'and nobody has scanned before');
});

/** The words POST /api/scan refuses a folder outside agent-policy.json's allowedRoots with. */
const outsideRoots = (p: string) => `"${p}" is outside the allowed roots — edit agent-policy.json (allowedRoots) to widen them`;
/** A policy whose allowedRoots hold Downloads and a projects folder: every other folder a scan is refused. */
const onlyDownloads = (p: string) => (p === '/Users/x/Downloads' || p === '/Users/x/Projects' ? null : outsideRoots(p));
const policyAsks = (h: ReturnType<typeof page>) => h.requests.filter((r) => r.startsWith('GET /api/policy?'));

test('with an agent policy whose allowedRoots hold only Downloads, the start screen offers Downloads alone — never a folder a scan would refuse — and names the last folder with the server\'s reason (review F3.2)', async () => {
  // Review F3.2: the choices came from GET /api/system's commonDirs and the
  // drives, which no policy reads, so every one outside allowedRoots answered
  // 403 POLICY_ROOT_NOT_ALLOWED — offered, and refused only once clicked.
  const first = page({ route: server({ roots: [], refuse: onlyDownloads }) });
  await boot(first);
  assert.deepEqual(first.choices(), ['Downloads'], 'a first run: only the folder a scan may start at');
  assert.deepEqual(policyAsks(first), ['GET /api/policy?scanRoot=%2FUsers%2Fx%2FDesktop&scanRoot=%2FUsers%2Fx%2FDocuments&scanRoot=%2FUsers%2Fx%2FDownloads&scanRoot=%2FUsers%2Fx&scanRoot=%2F'],
    'the server judged every folder the start screen would offer, in one request');
  assert.equal(first.posts.length, 0, 'and nothing was walked to find out');

  const back = page({ route: server({ roots: [ROOT_HISTORY], refuse: onlyDownloads }) });
  await boot(back);
  assert.deepEqual(back.choices(), ['Downloads'], 'a returning person: no "Scan Macintosh HD again" either');
  assert.equal(back.$('startLast').textContent, `Your last scan was of /, which TreeMap may not scan now: ${outsideRoots('/')}.`, 'the last folder is still named, with the server\'s reason');
  assert.equal(back.$('startLast').hidden, false);
});

test('a folder is offered only once the server has said a scan may start there: nothing while it is asked, every folder when no policy limits them, each folder asked about once a page load (review F3.2)', async () => {
  let answer: (a: Answer) => void = () => {};
  const asking = server({ roots: [] });
  const h = page({ route: server({ roots: [], policyAnswer: (asked) => new Promise((r) => { answer = (a) => r(a); void asked; }) }) });
  h.switchView('dashboard');
  await turns();
  assert.deepEqual(h.choices(), [], 'nothing offered while the server is asked');
  assert.equal(policyAsks(h).length, 1, 'control: asked');
  answer(await asking('GET', policyAsks(h)[0].slice('GET '.length), null)!);
  await turns();
  assert.deepEqual(h.choices(), ['Desktop', 'Documents', 'Downloads', 'Home folder', 'Macintosh HD Whole drive'], 'no policy: every folder the server found');
  for (const v of ['grid', 'dashboard', 'grid', 'dashboard']) h.switchView(v);
  await turns();
  assert.equal(policyAsks(h).length, 1, 'repaints ask nothing more about folders already judged');

  // The folder the history names waits too: no Stop has just made it the person's own choice.
  const back = page({ route: server({ roots: [ROOT_HISTORY], policyAnswer: () => new Promise(() => {}) }) });
  await boot(back);
  assert.equal(back.state.lastFolder && (back.state.lastFolder as { path: string }).path, '/', 'control: the history names /');
  assert.deepEqual(back.choices(), [], 'no "Scan Macintosh HD again" while the server is asked either');
});

test('when the server cannot be asked, the folders are offered as the server found them, as before — asked once, never in a loop (review F3.2)', async () => {
  const h = page({ route: server({ roots: [], policyAnswer: () => ({ status: 500, body: { error: 'Internal server error', code: 'INTERNAL' } }) }) });
  await boot(h);
  assert.deepEqual(h.choices(), ['Desktop', 'Documents', 'Downloads', 'Home folder', 'Macintosh HD Whole drive'], 'the scan\'s own answer still judges each');
  for (const v of ['grid', 'dashboard']) h.switchView(v);
  await turns();
  assert.equal(policyAsks(h).length, 1, 'asked once');
});

test('a folder a scan was just accepted for needs no asking: after a Stop of a folder chosen in the picker, under a policy, "Scan … again" is there at once and takes focus (review F3.2)', async () => {
  const h = page({ route: server({ roots: [], refuse: onlyDownloads }) });
  await boot(h);
  assert.deepEqual(h.choices(), ['Downloads'], 'control: the policy holds');
  await h.startScan('/Users/x/Projects'); // as Choose a folder… scans it
  await turns();
  await pressStop(h);
  assert.equal(h.choices()[0], 'Scan Projects again', 'offered at once');
  assert.equal(h.dom.activeElement, h.$('startAgainBtn'), 'and focus lands on it, never on Choose a folder… for want of an answer');
  assert.ok(!policyAsks(h).some((r) => r.includes('Projects')), 'the server, which accepted the scan, was not asked again');
});

test('a folder whose scan was stopped before the server answered is offered again at once, with focus, while the rules are asked about it; their answer takes it away only if they refuse it (review F3.2, with (vii))', async () => {
  // The scan request had not answered, so nothing has judged the folder: it
  // is the person's own choice, offered as "Scan … again" with focus on it
  // the moment Stop is pressed, as with no policy anywhere.
  const scans: Array<(a: { status: number; body: unknown }) => void> = [];
  const asks: Array<{ asked: string[]; answer: (a: { status?: number; body?: unknown }) => void }> = [];
  const judge = server({ roots: [], refuse: onlyDownloads });
  const h = page({ route: server({ roots: [], scanAnswer: () => new Promise((r) => { scans.push(r); }),
    policyAnswer: (asked) => (asked.includes('/Users/x/Projects') || asked.includes('/Users/x/Pictures')
      ? new Promise((r) => { asks.push({ asked, answer: r }); })
      : judge('GET', '/api/policy?' + asked.map((p) => 'scanRoot=' + encodeURIComponent(p)).join('&'), null)!) }) });
  await boot(h);
  assert.deepEqual(h.choices(), ['Downloads'], 'control: the policy holds');
  void h.startScan('/Users/x/Projects'); // as Choose a folder… scans it; its request waits
  await turns();
  await pressStop(h);
  assert.equal(h.choices()[0], 'Scan Projects again', 'offered at once, the rules still being asked');
  assert.equal(h.dom.activeElement, h.$('startAgainBtn'), 'with focus on it');
  assert.equal(asks.length, 1, 'control: the rules are asked about it');
  asks[0].answer({ body: { scanRoots: [{ path: '/Users/x/Projects', allowed: true }] } });
  await turns();
  assert.equal(h.choices()[0], 'Scan Projects again', 'allowed: it stays');
  assert.equal(h.dom.activeElement, h.$('startAgainBtn'), 'and keeps focus');

  void h.startScan('/Users/x/Pictures');
  await turns();
  await pressStop(h);
  assert.equal(h.choices()[0], 'Scan Pictures again', 'control: offered at once');
  asks[1].answer({ body: { scanRoots: [{ path: '/Users/x/Pictures', allowed: false, code: 'POLICY_ROOT_NOT_ALLOWED', error: outsideRoots('/Users/x/Pictures') }] } });
  await turns();
  assert.deepEqual(h.choices(), ['Downloads'], 'refused: taken away');
  assert.equal(h.dom.activeElement, h.$('emptyBrowseBtn'), 'focus moving on to Choose a folder…, never <body>');
  assert.equal(h.$('startLast').textContent, 'You stopped the scan of /Users/x/Pictures.', 'the line, which said only that, stands');
});

test('the whole drive is named as the folder picker names it: "Startup disk" until the disk layout answers, drive letters on Windows, / on Linux', async () => {
  let answer: (v: { body: unknown }) => void = () => {};
  const waiting = page({ route: (m, url) => (url === '/api/platform/topology' ? new Promise((r) => { answer = r; }) : server({ roots: [] })(m, url, null)) });
  await boot(waiting);
  assert.equal(waiting.choices().at(-1), 'Startup disk Whole drive', 'before the layout answers: the name that needs none, never a guess');
  answer({ body: TOPO_MAC });
  await turns();
  assert.equal(waiting.choices().at(-1), 'Macintosh HD Whole drive', 'then the volume\'s own name');

  const win = page({
    system: { platform: 'win32', homeDir: 'C:\\Users\\x', commonDirs: ['C:\\Users\\x', 'C:\\Users\\x\\Desktop', 'C:\\Users\\x\\Documents', 'C:\\Users\\x\\Downloads'] },
    route: server({ roots: [], topology: { logicalVolumes: [{ mountPoint: 'C:\\', name: 'Windows' }, { mountPoint: 'D:\\', name: 'Data' }] } }),
  });
  await boot(win);
  assert.deepEqual(win.choices(), ['Desktop', 'Documents', 'Downloads', 'Home folder', 'Windows (C:) Whole drive', 'Data (D:) Whole drive'], 'each lettered drive');
  const linux = page({ system: { platform: 'linux', homeDir: '/home/x', commonDirs: ['/home/x', '/home/x/Desktop'] }, route: server({ roots: [] }) });
  await boot(linux);
  assert.deepEqual(linux.choices(), ['Desktop', 'Home folder', '/ Whole drive'], '/ on Linux, with no disk layout asked for');
  assert.ok(!linux.requests.includes('GET /api/platform/topology'));
});

test('each choice starts the scan the Scan button starts, as a person\'s: the path box names it and the request is interactive', async () => {
  const h = page({ route: server({ roots: [ROOT_HISTORY] }) });
  await boot(h);
  h.choice(/^Documents$/).click();
  await turns();
  assert.deepEqual(h.posts, [{ path: '/Users/x/Documents', incremental: false, interactive: true }]);
  assert.equal(h.$('pathInput').value, '/Users/x/Documents', 'the Scan card names the folder being scanned');
  assert.equal(h.streams.length, 1, 'and the scan is followed');
  assert.equal(h.$('emptyState').style.display, 'none', 'the start screen goes while it scans');
});

test('a choice is answered at once: the start screen goes and the Dashboard\'s Stop is on screen while the index is asked, and a second click as that scan starts neither toasts an error nor rewrites the path box (review F1.2, F1.12)', async () => {
  // Review F1.2: the quiet chrome left the start screen up, clickable, for the
  // whole index probe, with Stop in the hidden Dashboard; a double-click on a
  // choice earned "A scan is already running" in red. F1.12: a click on
  // another choice then rewrote the path box, which went on naming a folder
  // other than the one being scanned.
  let probe: (a: { body: unknown }) => void = () => {};
  const h = page({ route: (m, url, b) => (url.startsWith('/api/index/status?') ? new Promise((r) => { probe = r; }) : server({ roots: [] })(m, url, b)) });
  await boot(h);
  const desktop = h.choice(/^Desktop$/);
  const documents = h.choice(/^Documents$/);
  desktop.click();
  await turns();
  assert.equal(h.posts.length, 0, 'control: the index is still being asked');
  assert.equal(h.state.scanning, true, 'control: the scan has begun');
  assert.equal(h.$('emptyState').style.display, 'none', 'the start screen goes at the click');
  assert.equal(h.$('scanBtn').painted(), true, 'and the Dashboard\'s Stop is on screen');
  // A double-click lands its second click in the same instant, before the screen changes.
  desktop.click();
  documents.click();
  await turns();
  assert.deepEqual(h.toasts, [], 'no "A scan is already running" for a choice clicked again as its scan starts');
  assert.equal(h.$('pathInput').value, '/Users/x/Desktop', 'the path box names the folder being scanned');
  probe({ body: { indexed: false, root: null } });
  await turns();
  assert.deepEqual(h.posts.map((p) => p.path), ['/Users/x/Desktop'], 'one scan, of the folder clicked first');
});

test('a first run paints the choices when GET /api/system answers: the boot paints the start screen before it, with nothing yet to offer (review F1.6)', async () => {
  // Every launch starts with state.system null: switchView paints the start
  // screen before loadSystem's answer, and a first run has no history to
  // paint it again. loadSystem's own repaint is the one that offers Desktop.
  let answer: (a: { body: unknown }) => void = () => {};
  const h = page({ system: null, route: (m, url, b) => (url === '/api/system' ? new Promise((r) => { answer = r; }) : server({ roots: [] })(m, url, b)) });
  h.switchView('dashboard');
  const loading = h.loadSystem();
  await h.restoreLastSession();
  await turns();
  assert.deepEqual(h.choices(), [], 'before the system answers: no folder known, none offered — never a guess');
  assert.equal(h.$('emptyState').style.display, 'flex', 'control: the start screen is up, with Choose a folder…');
  answer({ body: MAC });
  await loading;
  await turns();
  assert.deepEqual(h.choices(), ['Desktop', 'Documents', 'Downloads', 'Home folder', 'Macintosh HD Whole drive'], 'the answer paints the choices, and the whole drive by its name');
});

test('a choice that holds focus through a repaint that changes the markup keeps it, on its new button — the disk layout naming the startup disk (review F1.9)', async () => {
  for (const [label, words, after] of [['Documents', /^Documents$/, /^Documents$/], ['the whole drive', /^Startup disk Whole drive$/, /^Macintosh HD Whole drive$/]] as const) {
    let answer: (a: { body: unknown }) => void = () => {};
    const h = page({ route: (m, url, b) => (url === '/api/platform/topology' ? new Promise((r) => { answer = r; }) : server({ roots: [] })(m, url, b)) });
    await boot(h);
    const before = h.choice(words);
    before.focus();
    assert.equal(h.dom.activeElement, before, `${label}: control: focused`);
    answer({ body: TOPO_MAC });
    await turns();
    assert.equal(h.choices().at(-1), 'Macintosh HD Whole drive', `${label}: control: the repaint changed the markup`);
    const now = h.choice(after);
    assert.notEqual(now, before, `${label}: control: the buttons were written anew`);
    assert.equal(h.dom.activeElement, now, `${label}: focus is on the new button for the same folder, never <body>`);
  }
});

test('the disk layout is asked for once a page load, however often the start screen repaints and however it answers — and never where the capability says it cannot answer (review F1.10)', async () => {
  const count = (h: ReturnType<typeof page>) => h.requests.filter((r) => r === 'GET /api/platform/topology').length;
  const repaint = async (h: ReturnType<typeof page>) => {
    for (let i = 0; i < 3; i++) { h.renderStartChoices(); await turns(); }
    h.switchView('grid'); await turns();
    h.switchView('dashboard'); await turns();
  };
  const failing = page({ route: (m, url, b) => (url === '/api/platform/topology' ? { status: 500, body: { error: 'The disk layout could not be read.', code: 'INTERNAL' } } : server({ roots: [] })(m, url, b)) });
  await boot(failing);
  await repaint(failing);
  assert.equal(count(failing), 1, 'a layout that failed is not asked for again at every repaint');
  assert.equal(failing.choices().at(-1), 'Startup disk Whole drive', 'and the name that needs none stands');

  const off = page({ route: server({ roots: [] }) });
  off.state.capabilities = { volumeTopology: { available: false, reason: 'This Mac does not report its disk layout.' } };
  await boot(off);
  await repaint(off);
  assert.equal(count(off), 0, 'a machine that cannot answer is not asked');
  assert.equal(off.choices().at(-1), 'Startup disk Whole drive');
});

test('a folder from the history keeps its last size and date on "Scan … again" after a scan of it is stopped (review F1.11)', async () => {
  const h = page({ route: server({ roots: [ROOT_HISTORY] }) });
  await boot(h);
  await startFrom(h, /^Scan Macintosh HD again/);
  assert.deepEqual(h.posts.map((p) => p.path), ['/'], 'control: the whole drive');
  await pressStop(h);
  assert.equal(h.$('startLast').textContent, 'You stopped the scan of /.');
  assert.equal(h.choices()[0], `Scan Macintosh HD again ${formatBytes(494_380_000_000)} · ${formatDate(ROOT_HISTORY.latestAt)}`, 'the size and date of its last finished scan stay with it');
});

/* ══════════════ (C) — a scan works again after a Stop ══════════════ */

/** Start a scan from a choice, as a click would, and let it reach its stream. */
async function startFrom(h: ReturnType<typeof page>, words: RegExp): Promise<void> {
  h.choice(words).click();
  await turns();
}
/** Press Stop as a person does: the Scan card's button, focused by the click. */
async function pressStop(h: ReturnType<typeof page>): Promise<void> {
  h.$('scanBtn').focus();
  await h.stopScan();
  await turns();
}

test('(iii)+(vii) start → Stop: the folder stays named, "Scan … again" comes first and takes focus, and it sends exactly one new scan of the same folder', async () => {
  const h = page({ route: server({ roots: [] }) });
  await boot(h);
  await startFrom(h, /^Desktop$/);
  assert.equal(h.posts.length, 1, 'control: the first scan');
  await pressStop(h);
  assert.ok(h.requests.includes('POST /api/scan/scan-1/cancel'), 'the scan is cancelled on the server');
  assert.equal(h.$('emptyState').style.display, 'flex', 'with nothing on screen, the start screen is back');
  assert.equal(h.$('startLast').hidden, false);
  assert.equal(h.$('startLast').textContent, 'You stopped the scan of /Users/x/Desktop.', 'the stopped folder stays named');
  assert.equal(h.choices()[0], 'Scan Desktop again', 'and is offered first');
  const again = h.$('startAgainBtn');
  assert.equal(again.textContent, 'Scan Desktop again', 'by id, for the focus rules');
  assert.equal(h.dom.activeElement, again, '(vii) focus lands on "Scan Desktop again", never <body>');
  assert.deepEqual(primaries(h), ['emptyBrowseBtn'], 'still one primary, Choose a folder… — the focused "Scan … again" is not styled as one (G03, review F1.7)');
  again.click();
  await turns();
  assert.equal(h.posts.length, 2, 'exactly one new scan');
  assert.deepEqual(h.posts[1], { path: '/Users/x/Desktop', incremental: false, interactive: true }, 'of the same folder, as a person\'s');
  assert.equal(h.state.scanId, 'scan-2', 'and it is the scan followed');
});

test('(iii) start → Stop → a quick choice scans that folder', async () => {
  const h = page({ route: server({ roots: [] }) });
  await boot(h);
  await startFrom(h, /Whole drive$/);
  assert.deepEqual(h.posts.map((p) => p.path), ['/'], 'control: the whole drive');
  await pressStop(h);
  assert.equal(h.choices()[0], 'Scan Macintosh HD again', 'the whole drive named as the startup disk');
  await startFrom(h, /^Downloads$/);
  assert.deepEqual(h.posts.map((p) => p.path), ['/', '/Users/x/Downloads'], 'one new scan, of the folder chosen');
});

/** A server whose cancel of scan-1 answers `status` — or is held until the test answers it. */
function cancelAnswers(status: number | 'held', held?: { answer: (a: { status: number; body: unknown }) => void }, scanAnswer?: (n: number) => Answer): Route {
  const base = server({ roots: [], scanAnswer });
  return (m, url, b) => {
    if (url !== '/api/scan/scan-1/cancel') return base(m, url, b);
    if (status === 'held') return new Promise((r) => { held!.answer = r; });
    return { status, body: status === 404 ? { error: 'Unknown or expired scanId', code: 'SCAN_NOT_FOUND' } : { error: 'Internal server error', code: 'INTERNAL' } };
  };
}

test('a Stop whose cancel the server refuses says so where the person is looking: the scan may still be running, its folder is offered nowhere, the failure is toasted, and focus lands on Choose a folder… (review F1.3, F1.13)', async () => {
  // Review F1.3: the start screen said "You stopped the scan of …" and
  // offered a focused "Scan … again" before the cancel answered; when it
  // failed, the only true words went to the Dashboard's status line, hidden
  // under the start screen, and "Scan … again" started a second walk.
  const h = page({ route: cancelAnswers(500) });
  await boot(h);
  await startFrom(h, /^Desktop$/);
  await pressStop(h);
  assert.ok(h.requests.includes('POST /api/scan/scan-1/cancel'), 'control: the cancel was asked for');
  assert.equal(h.$('emptyState').style.display, 'flex', 'control: the start screen is up');
  assert.equal(h.$('startLast').textContent, 'TreeMap could not stop the scan of /Users/x/Desktop, so it may still be running: Internal server error.');
  assert.deepEqual(offering(h, '/Users/x/Desktop').map((b) => b.textContent), [], `the folder still being walked is offered nowhere — neither "Scan Desktop again" nor Desktop (${h.choices().join(' | ')})`);
  assert.deepEqual(h.toasts, [['Could not stop the scan: Internal server error', 'error']], 'and the failure is said where it is heard, over every view');
  assert.equal(h.dom.activeElement, h.$('emptyBrowseBtn'), 'focus leaves the "Scan Desktop again" that went for Choose a folder…, never <body>');
  assert.equal(h.posts.length, 1, 'nothing more was walked');
  assert.equal(h.$('stopAnnounce').textContent, '', '"You stopped the scan" is not left for a screen reader to find: the toast says what happened (review F1.14)');

  const gone = page({ route: cancelAnswers(404) });
  await boot(gone);
  await startFrom(gone, /^Desktop$/);
  await pressStop(gone);
  assert.equal(gone.$('startLast').textContent, 'You stopped the scan of /Users/x/Desktop.', 'a 404: the record was already gone, so it IS stopped');
  assert.equal(gone.choices()[0], 'Scan Desktop again');
  assert.deepEqual(gone.toasts, []);
});

test('a refused cancel that answers after "Scan … again" was pressed leaves the new scan alone — its screen, its status line, its stream — and is still toasted (review F1.3)', async () => {
  const held = { answer: (_a: { status: number; body: unknown }) => {} };
  const h = page({ route: cancelAnswers('held', held) });
  await boot(h);
  await startFrom(h, /^Desktop$/);
  h.$('scanBtn').focus();
  void h.stopScan(); // its cancel is held
  await turns();
  assert.equal(h.$('startLast').textContent, 'You stopped the scan of /Users/x/Desktop.', 'control: said at once');
  h.$('startAgainBtn').click();
  await turns();
  assert.deepEqual(h.openStreams().map((s) => s.url), ['/api/scan/scan-2/progress'], 'control: the new scan is followed');
  held.answer({ status: 500, body: { error: 'Internal server error', code: 'INTERNAL' } });
  await turns();
  assert.equal(h.state.scanning, true, 'the new scan runs on');
  assert.equal(h.$('emptyState').style.display, 'none', 'with no start screen over it');
  assert.deepEqual(h.openStreams().map((s) => s.url), ['/api/scan/scan-2/progress'], 'still followed');
  assert.doesNotMatch(h.$('scanStatus').innerHTML, /Could not stop/, 'its status line is its own');
  assert.deepEqual(h.toasts, [['Could not stop the scan: Internal server error', 'error']], 'the first walk may still be running, and that is said');

  // A scan begun since that has already ended said its own words: those stand.
  const said = { answer: (_a: { status: number; body: unknown }) => {} };
  const f = page({ route: cancelAnswers('held', said, (n) => (n === 1 ? { status: 202, body: { scanId: 'scan-1', incremental: false } } : { status: 500, body: { error: 'The disk is busy.', code: 'INTERNAL' } })) });
  await boot(f);
  await startFrom(f, /^Desktop$/);
  void f.stopScan();
  await turns();
  f.$('startAgainBtn').click();
  await turns();
  assert.equal(f.$('startLast').textContent, 'The scan of /Users/x/Desktop failed: The disk is busy.', 'control: the second scan failed');
  assert.equal(f.state.scanning, false, 'control: and has ended, so no scan is running when the cancel answers');
  assert.match(f.$('scanStatus').innerHTML, /<span>The disk is busy\.<\/span>/, 'control: its status line says so');
  said.answer({ status: 500, body: { error: 'Internal server error', code: 'INTERNAL' } });
  await turns();
  assert.equal(f.$('startLast').textContent, 'The scan of /Users/x/Desktop failed: The disk is busy.', 'the start screen goes on describing the newer scan');
  assert.match(f.$('scanStatus').innerHTML, /<span>The disk is busy\.<\/span>/, 'and so does the status line: a scan begun since — ended or not — owns it (review F2.9)');
  assert.deepEqual(f.toasts.map((t) => t[0]), ['The disk is busy.', 'Could not stop the scan: Internal server error'], 'the refused cancel is still toasted');
});

test('a rescan stopped over an older tree whose cancel is refused says so on the Dashboard, where it is seen, and tells the start screen nothing (review F1.3)', async () => {
  const tree = { name: 'x', path: '/Users/x/old', size: 1, type: 'dir', children: [] };
  const h = page({ route: cancelAnswers(500), root: tree, settledScanId: 'scan-old' });
  h.switchView('dashboard');
  await h.startScan('/Users/x/Desktop');
  await turns();
  await pressStop(h);
  assert.equal(h.$('emptyState').style.display, 'none', 'control: the older tree stays on screen');
  assert.match(h.$('scanStatus').innerHTML, /Could not stop the scan: Internal server error/, 'the Dashboard\'s status line says it');
  assert.deepEqual(h.toasts, [['Could not stop the scan: Internal server error', 'error']]);
  assert.equal(h.state.lastFolder, null, 'and the start screen is told nothing');
  assert.equal(h.$('stopAnnounce').textContent, '', '"Scan stopped." is not left for a screen reader to find beside "Could not stop the scan": the toast says what happened (review F2.1, F2.8)');

  // A cloud account's listing, stopped with nothing on screen, names no folder — and is not left "stopped" either.
  const c = page({ route: (m, url, b) => (m === 'POST' && url === '/api/cloud/scan' ? { status: 202, body: { scanId: 'scan-1' } } : cancelAnswers(500)(m, url, b)) });
  await boot(c);
  await c.startCloudScan('gdrive', 'Google Drive');
  await turns();
  assert.deepEqual(c.openStreams().map((s) => s.url), ['/api/scan/scan-1/progress'], 'control: the listing is followed');
  await pressStop(c);
  assert.ok(c.requests.includes('POST /api/scan/scan-1/cancel'), 'control: its cancel was asked for');
  assert.deepEqual(c.toasts, [['Could not stop the scan: Internal server error', 'error']], 'control: refused, and toasted');
  assert.equal(c.$('stopAnnounce').textContent, '', 'and "Scan stopped." is taken back (review F2.1)');
});

test('a Stop with nothing on screen is announced: the start screen\'s sentence goes to a live region outside the views, always rendered, and cleared as the next scan begins (review F1.14)', async () => {
  // Review F1.14: #startLast is a role=status region inside the start screen,
  // which is display:none for the whole scan and is revealed with its text
  // already in it — a region revealed with its content is not announced, and
  // Stop said nothing else a screen reader would speak.
  const at = INDEX.indexOf('id="stopAnnounce"');
  assert.notEqual(at, -1, 'the region is in the page');
  const tag = INDEX.slice(INDEX.lastIndexOf('<', at), INDEX.indexOf('>', at) + 1);
  assert.match(tag, /role="status"/);
  assert.match(tag, /aria-live="polite"/);
  assert.doesNotMatch(tag, /\shidden\b/, 'rendered from the start, so its first change is spoken');
  // The <main> ELEMENT, after <body>: the page's stylesheet mentions "<main>" in comments far above it,
  // and the first literal match is one of those (review F2.7).
  const body = INDEX.search(/<body[\s>]/);
  assert.notEqual(body, -1, 'the page has a body');
  const mainRe = /<main[\s>]/g;
  mainRe.lastIndex = body;
  const mainTag = mainRe.exec(INDEX);
  assert.ok(mainTag, 'the <main> element is in the body');
  const main = mainTag!.index;
  const mainEnd = INDEX.indexOf('</main>', main);
  const startScreen = INDEX.indexOf('<section id="emptyState">');
  assert.ok(main < at && at < startScreen && startScreen < mainEnd, 'in <main>, before the start screen and every view');
  // A child of <main> itself: every element opened between <main> and the region is closed before it, so it
  // sits inside no container a view or a scan hides.
  const between = INDEX.slice(INDEX.indexOf('>', main) + 1, INDEX.lastIndexOf('<', at)).replace(/<!--[\s\S]*?-->/g, '');
  const opened = (between.match(/<(?!\/|!)(?!(?:br|hr|img|input|meta|link|wbr|source)\b)[a-z][\w-]*\b[^>]*>/gi) ?? []).length;
  const closed = (between.match(/<\/[a-z][\w-]*\s*>/gi) ?? []).length;
  assert.equal(opened, closed, `inside no element but <main> (${between.trim().slice(0, 120)})`);

  const h = page({ route: server({ roots: [] }) });
  await boot(h);
  await startFrom(h, /^Desktop$/);
  assert.equal(h.$('stopAnnounce').textContent, '', 'control: nothing said while it scans');
  await pressStop(h);
  assert.equal(h.$('stopAnnounce').textContent, 'You stopped the scan of /Users/x/Desktop.', 'the start screen\'s own words, spoken');
  h.$('startAgainBtn').click();
  await turns();
  assert.equal(h.$('stopAnnounce').textContent, '', 'cleared as the next scan begins, so the same words are spoken again after the next Stop');
  await pressStop(h);
  assert.equal(h.$('stopAnnounce').textContent, 'You stopped the scan of /Users/x/Desktop.');
});

test('(vii) a Stop that left focus on <body> — a mouse click that focuses nothing — still lands it on "Scan … again"', async () => {
  const h = page({ route: server({ roots: [] }) });
  await boot(h);
  await startFrom(h, /^Desktop$/);
  h.dom.active = null; // nothing focused
  await h.stopScan();
  await turns();
  assert.equal(h.dom.activeElement, h.$('startAgainBtn'));
});

test('(iv) three Stop / Scan again cycles each send exactly one scan, and leave no stream open, no watchdog ticking and no stale scan id', async () => {
  const h = page({ route: server({ roots: [] }) });
  await boot(h);
  await startFrom(h, /^Documents$/);
  for (let cycle = 1; cycle <= 3; cycle++) {
    await pressStop(h);
    assert.equal(h.openStreams().length, 0, `cycle ${cycle}: Stop closes the stream`);
    assert.equal(h.intervals.size, 0, `cycle ${cycle}: and the watchdog`);
    assert.equal(h.state.scanId, null, `cycle ${cycle}: no stopped scan's id is left for a view to ask with`);
    assert.equal(h.state.es, null, `cycle ${cycle}: nor its stream`);
    assert.equal(h.state.scanning, false, `cycle ${cycle}: nothing says a scan is running`);
    h.$('startAgainBtn').click();
    await turns();
    assert.equal(h.posts.length, cycle + 1, `cycle ${cycle}: exactly one scan more`);
    assert.equal(h.openStreams().length, 1, `cycle ${cycle}: one stream, the new scan's`);
    assert.equal(h.openStreams()[0].url, `/api/scan/scan-${cycle + 1}/progress`);
  }
  await pressStop(h);
  assert.deepEqual(h.requests.filter((r) => r.endsWith('/cancel')), ['POST /api/scan/scan-1/cancel', 'POST /api/scan/scan-2/cancel', 'POST /api/scan/scan-3/cancel', 'POST /api/scan/scan-4/cancel'], 'each scan cancelled once');
  assert.deepEqual([h.openStreams().length, h.intervals.size, h.state.scanId], [0, 0, null], 'and nothing left behind');
  assert.ok(h.posts.every((p) => p.path === '/Users/x/Documents'), 'every scan of the same folder');
});

test('(v) Stop pressed before POST /api/scan answers, then Scan again: the late answer is cancelled and the new scan is followed', async () => {
  const held: Array<(a: { status: number; body: unknown }) => void> = [];
  const h = page({ route: server({ roots: [], scanAnswer: () => new Promise((r) => { held.push(r); }) }) });
  await boot(h);
  await startFrom(h, /^Desktop$/);
  assert.equal(held.length, 1, 'control: the first request is out, unanswered');
  await pressStop(h);
  assert.equal(h.choices()[0], 'Scan Desktop again', 'stopped before the server answered: still named and offered');
  h.$('startAgainBtn').click();
  await turns();
  assert.equal(held.length, 2, 'the second request is out');
  held[0]({ status: 202, body: { scanId: 'scan-late', incremental: false } });
  await turns();
  assert.ok(h.requests.includes('POST /api/scan/scan-late/cancel'), 'the first scan, answering late, is cancelled (abandonIfStopped)');
  assert.ok(!h.streams.some((s) => s.url === '/api/scan/scan-late/progress'), 'and never followed');
  held[1]({ status: 202, body: { scanId: 'scan-new', incremental: false } });
  await turns();
  assert.deepEqual(h.openStreams().map((s) => s.url), ['/api/scan/scan-new/progress'], 'the new scan is followed, alone');
  assert.equal(h.state.scanId, 'scan-new');
});

/** A server whose scan requests wait for the test, and whose cancel of `late` answers `status`. */
function lateCancelAnswers(late: string, status: number, held: Array<(a: { status: number; body: unknown }) => void>): Route {
  const base = server({ roots: [], scanAnswer: () => new Promise((r) => { held.push(r); }) });
  return (m, url, b) => {
    if (m === 'POST' && url === '/api/cloud/scan') return new Promise((r) => { held.push(r); });
    if (url !== `/api/scan/${late}/cancel`) return base(m, url, b);
    return { status, body: status === 404 ? { error: 'Unknown or expired scanId', code: 'SCAN_NOT_FOUND' } : { error: 'Internal server error', code: 'INTERNAL' } };
  };
}

test('(v) a Stop pressed before POST /api/scan answers, whose late cancel the server refuses, says so as a refused cancel at Stop does: the scan may still be running, its folder is offered nowhere, the failure is toasted (review F2.2)', async () => {
  // Review F2.2: abandonIfStopped's cancel was fire-and-forget — a refusal
  // reached console.warn only, and the start screen went on saying "You
  // stopped the scan of …" with a focused "Scan … again" that would start a
  // second walk of a folder that may still be walking.
  const held: Array<(a: { status: number; body: unknown }) => void> = [];
  const h = page({ route: lateCancelAnswers('late-1', 500, held) });
  await boot(h);
  await startFrom(h, /^Desktop$/);
  await pressStop(h);
  assert.equal(h.$('startLast').textContent, 'You stopped the scan of /Users/x/Desktop.', 'control: said at once');
  assert.equal(h.$('stopAnnounce').textContent, 'You stopped the scan of /Users/x/Desktop.', 'control: and aloud');
  held[0]({ status: 202, body: { scanId: 'late-1', incremental: false } });
  await turns();
  assert.ok(h.requests.includes('POST /api/scan/late-1/cancel'), 'control: the late answer is cancelled');
  assert.ok(!h.streams.some((s) => s.url === '/api/scan/late-1/progress'), 'control: and never followed');
  assert.equal(h.$('startLast').textContent, 'TreeMap could not stop the scan of /Users/x/Desktop, so it may still be running: Internal server error.');
  assert.deepEqual(offering(h, '/Users/x/Desktop').map((b) => b.textContent), [], `the folder that may still be walking is offered nowhere (${h.choices().join(' | ')})`);
  assert.deepEqual(h.toasts, [['Could not stop the scan: Internal server error', 'error']], 'the failure is toasted');
  assert.match(h.$('scanStatus').innerHTML, /Could not stop the scan: Internal server error/, 'and the status line says it, not "Scan stopped by user"');
  assert.equal(h.$('stopAnnounce').textContent, '', '"You stopped …" is not left for a screen reader');
  assert.equal(h.dom.activeElement, h.$('emptyBrowseBtn'), 'focus on Choose a folder…, never <body>');

  // A 404: the record was already gone, so it IS stopped — nothing changes.
  const goneHeld: Array<(a: { status: number; body: unknown }) => void> = [];
  const gone = page({ route: lateCancelAnswers('late-1', 404, goneHeld) });
  await boot(gone);
  await startFrom(gone, /^Desktop$/);
  await pressStop(gone);
  goneHeld[0]({ status: 202, body: { scanId: 'late-1', incremental: false } });
  await turns();
  assert.ok(gone.requests.includes('POST /api/scan/late-1/cancel'), 'control: cancelled');
  assert.equal(gone.$('startLast').textContent, 'You stopped the scan of /Users/x/Desktop.');
  assert.equal(gone.choices()[0], 'Scan Desktop again');
  assert.deepEqual(gone.toasts, []);

  // A scan begun since keeps its screen and its status line; the refusal is still toasted.
  const newer: Array<(a: { status: number; body: unknown }) => void> = [];
  const n = page({ route: lateCancelAnswers('late-1', 500, newer) });
  await boot(n);
  await startFrom(n, /^Desktop$/);
  await pressStop(n);
  await startFrom(n, /^Documents$/);
  newer[1]({ status: 202, body: { scanId: 'scan-b', incremental: false } });
  await turns();
  newer[0]({ status: 202, body: { scanId: 'late-1', incremental: false } });
  await turns();
  assert.ok(n.requests.includes('POST /api/scan/late-1/cancel'), 'control: cancelled');
  assert.equal(n.state.scanning, true, 'the newer scan runs on');
  assert.equal(n.$('emptyState').style.display, 'none', 'with no start screen over it');
  assert.deepEqual(n.openStreams().map((s) => s.url), ['/api/scan/scan-b/progress'], 'still followed');
  assert.doesNotMatch(n.$('scanStatus').innerHTML, /Could not stop/, 'its status line is its own');
  assert.deepEqual(n.toasts, [['Could not stop the scan: Internal server error', 'error']], 'the first walk may still be running, and that is said');

  // Two Stops before either request answered: the older request's refusal takes back nothing the newer Stop said.
  const two: Array<(a: { status: number; body: unknown }) => void> = [];
  const t = page({ route: lateCancelAnswers('late-1', 500, two) });
  await boot(t);
  await startFrom(t, /^Desktop$/);
  await pressStop(t);
  await startFrom(t, /^Documents$/);
  await pressStop(t);
  assert.equal(t.$('startLast').textContent, 'You stopped the scan of /Users/x/Documents.', 'control: the newer Stop is named');
  two[0]({ status: 202, body: { scanId: 'late-1', incremental: false } });
  await turns();
  assert.ok(t.requests.includes('POST /api/scan/late-1/cancel'), 'control: the older request is cancelled');
  assert.deepEqual(t.toasts, [['Could not stop the scan: Internal server error', 'error']], 'control: refused, and toasted');
  assert.equal(t.$('startLast').textContent, 'You stopped the scan of /Users/x/Documents.', 'the start screen goes on naming the newer Stop');
  assert.equal(t.choices()[0], 'Scan Documents again', 'and offering its folder');
  // But the older request's folder may still be walking, whichever Stop the
  // start screen names now: it is offered nowhere (review F3.1). The Stop
  // that ended its request was overwritten by the newer one before it
  // answered; the request names its own folder.
  assert.deepEqual(offering(t, '/Users/x/Desktop').map((b) => b.textContent), [], `the folder whose late cancel was refused is offered nowhere (${t.choices().join(' | ')})`);

  // A cloud listing stopped before it answered: no folder to name, and the refusal is said.
  const cloudHeld: Array<(a: { status: number; body: unknown }) => void> = [];
  const c = page({ route: lateCancelAnswers('late-c', 500, cloudHeld) });
  await boot(c);
  void c.startCloudScan('gdrive', 'Google Drive');
  await turns();
  await pressStop(c);
  assert.equal(c.$('stopAnnounce').textContent, 'Scan stopped.', 'control: said aloud');
  cloudHeld[0]({ status: 202, body: { scanId: 'late-c' } });
  await turns();
  assert.ok(c.requests.includes('POST /api/scan/late-c/cancel'), 'control: the late listing is cancelled');
  assert.deepEqual(c.toasts, [['Could not stop the scan: Internal server error', 'error']], 'its refusal is toasted');
  assert.equal(c.$('stopAnnounce').textContent, '', 'and "Scan stopped." taken back');
});

test('(v) a Stopped request that FAILS late is no one\'s to report: a new scan begun since stays followed, on screen and stoppable, and a Stop with nothing after it stays a Stop (review F1.1, F1.4)', async () => {
  // Review F1.1: the success half of the race was guarded (abandonIfStopped),
  // the failure half was not — scan A's late 403 ran failScan against scan B:
  // the start screen came back over B, saying B's folder "failed" with A's
  // reason, and Stop could no longer reach B.
  const held: Array<(a: { status: number; body: unknown }) => void> = [];
  const h = page({ route: server({ roots: [], scanAnswer: () => new Promise((r) => { held.push(r); }) }) });
  await boot(h);
  await startFrom(h, /^Desktop$/);
  await pressStop(h);
  await startFrom(h, /^Documents$/);
  held[1]({ status: 202, body: { scanId: 'scan-b', incremental: false } });
  await turns();
  assert.deepEqual(h.openStreams().map((s) => s.url), ['/api/scan/scan-b/progress'], 'control: the new scan is followed');
  held[0]({ status: 403, body: { error: 'A could not be started.', code: 'FORBIDDEN' } });
  await turns();
  assert.equal(h.state.scanning, true, 'the new scan is still running');
  assert.deepEqual(h.openStreams().map((s) => s.url), ['/api/scan/scan-b/progress'], 'and still followed');
  assert.equal(h.$('emptyState').style.display, 'none', 'the start screen stays down over it');
  assert.deepEqual(h.toasts, [], 'no red toast for a scan the person already stopped');
  assert.equal(typeof h.state.abortScan, 'function', 'Stop can still reach it');
  await pressStop(h);
  assert.ok(h.requests.includes('POST /api/scan/scan-b/cancel'), 'and does');
  assert.equal(h.$('startLast').textContent, 'You stopped the scan of /Users/x/Documents.', 'the start screen names the scan the person stopped');

  // Stopped, nothing started since, and then the request fails: it was stopped.
  const late: Array<(a: { status: number; body: unknown }) => void> = [];
  const lone = page({ route: server({ roots: [], scanAnswer: () => new Promise((r) => { late.push(r); }) }) });
  await boot(lone);
  await startFrom(lone, /^Desktop$/);
  await pressStop(lone);
  late[0]({ status: 500, body: { error: 'Internal server error', code: 'INTERNAL' } });
  await turns();
  assert.equal(lone.$('startLast').textContent, 'You stopped the scan of /Users/x/Desktop.', 'a late failure does not rewrite the person\'s Stop as a failure');
  assert.equal(lone.choices()[0], 'Scan Desktop again');
  assert.deepEqual(lone.toasts, []);
});

test('(v) the same for a quiet rescan behind an index paint, and for a cloud account\'s scan: a late failure after Stop reports nothing (review F1.1, F1.4)', async () => {
  const held: Array<(a: { status: number; body: unknown }) => void> = [];
  const h = page({
    route: server({ roots: [], indexed: ['/Users/x/Desktop'], scanAnswer: (n) => (n === 1 ? new Promise((r) => { held.push(r); }) : { status: 202, body: { scanId: `scan-${n}`, incremental: false } }) }),
  });
  h.given.openFromIndex = async (p: string) => { h.state.root = { name: 'Desktop', path: p, size: 1, type: 'dir', children: [] }; return true; };
  await boot(h);
  await startFrom(h, /^Desktop$/);
  assert.equal(held.length, 1, 'control: painted from the index, its quiet rescan is out');
  await pressStop(h);
  await h.startScan('/Users/x/Documents');
  await turns();
  assert.deepEqual(h.openStreams().map((s) => s.url), ['/api/scan/scan-2/progress'], 'control: a new scan is followed');
  held[0]({ status: 500, body: { error: 'Internal server error', code: 'INTERNAL' } });
  await turns();
  assert.deepEqual(h.quietFailed, [], 'the stopped rescan\'s failure is not reported as "the refresh failed"');
  assert.equal(h.state.scanning, true, 'and the new scan runs on');

  const cloud: Array<(a: { status: number; body: unknown }) => void> = [];
  const c = page({ route: (m, url, b) => (m === 'POST' && url === '/api/cloud/scan' ? new Promise((r) => { cloud.push(r); }) : server({ roots: [] })(m, url, b)) });
  await boot(c);
  void c.startCloudScan('gdrive', 'Google Drive');
  await turns();
  assert.equal(cloud.length, 1, 'control: the cloud listing is asked for');
  await pressStop(c);
  await startFrom(c, /^Desktop$/);
  cloud[0]({ status: 500, body: { error: 'Google Drive did not answer.', code: 'INTERNAL' } });
  await turns();
  assert.deepEqual(c.openStreams().map((s) => s.url), ['/api/scan/scan-1/progress'], 'the disk scan begun since is still followed');
  assert.equal(c.$('emptyState').style.display, 'none');
  assert.deepEqual(c.toasts, []);

  // Stopped, nothing started since, and then the listing fails: it was stopped (review F2.6).
  const lonely: Array<(a: { status: number; body: unknown }) => void> = [];
  const lone = page({ route: (m, url, b) => (m === 'POST' && url === '/api/cloud/scan' ? new Promise((r) => { lonely.push(r); }) : server({ roots: [] })(m, url, b)) });
  await boot(lone);
  void lone.startCloudScan('gdrive', 'Google Drive');
  await turns();
  assert.equal(lonely.length, 1, 'control: the cloud listing is asked for');
  await pressStop(lone);
  assert.match(lone.$('scanStatus').innerHTML, /Scan stopped by user/, 'control: stopped');
  lonely[0]({ status: 500, body: { error: 'Google Drive did not answer.', code: 'INTERNAL' } });
  await turns();
  assert.deepEqual(lone.toasts, [], 'no red toast for a listing the person stopped');
  assert.match(lone.$('scanStatus').innerHTML, /Scan stopped by user/, 'the status line still says the person stopped it');
  assert.ok(!lone.$('scanStatus').cls.has('error'), 'and is not painted as a failure');
  assert.equal(lone.$('scanAnnounce').textContent, 'Scanning…', 'nothing announces a failure');
  assert.equal(lone.state.lastFolder, null, 'and the start screen is told nothing: a cloud account is named nowhere there');
  assert.equal(lone.$('emptyState').style.display, 'flex', 'control: the start screen the Stop put back stays up');
});

test('(vi) a failed scan offers "Scan … again" the same way; a folder the server refused is named with the reason, not offered', async () => {
  const walk = page({ route: server({ roots: [] }) });
  await boot(walk);
  await startFrom(walk, /^Desktop$/);
  walk.$('scanBtn').focus();
  walk.streams[0].onmessage!({ data: JSON.stringify({ type: 'error', message: 'The drive stopped answering.' }) });
  await turns();
  assert.equal(walk.$('startLast').textContent, 'The scan of /Users/x/Desktop failed: The drive stopped answering.');
  assert.equal(walk.choices()[0], 'Scan Desktop again', 'a walk that failed is offered again');
  assert.equal(walk.dom.activeElement, walk.$('startAgainBtn'), 'with focus on it, as after a Stop');
  assert.deepEqual(primaries(walk), ['emptyBrowseBtn'], 'and still one primary, Choose a folder… (G03, review F1.7)');
  walk.$('startAgainBtn').click();
  await turns();
  assert.equal(walk.posts.length, 2, 'and scans again');

  const down = page({ route: server({ roots: [], scanAnswer: () => ({ status: 500, body: { error: 'Internal server error', code: 'INTERNAL' } }) }) });
  await boot(down);
  await startFrom(down, /^Documents$/);
  assert.equal(down.choices()[0], 'Scan Documents again', 'a server error is offered again');

  const gone = page({ route: server({ roots: [], scanAnswer: () => ({ status: 404, body: { error: 'Path does not exist', code: 'PATH_NOT_FOUND' } }) }) });
  await boot(gone);
  await startFrom(gone, /^Documents$/);
  assert.equal(gone.$('startLast').textContent, 'The scan of /Users/x/Documents failed: Path does not exist.');
  assert.ok(!gone.choices().some((c) => /again/.test(c)), 'a folder the server refused is not offered again');
  assert.ok(!gone.$('startChoices').children.some((b) => b.id === 'startAgainBtn'), 'there is no "again" to focus');
  assert.equal(gone.dom.activeElement, gone.$('emptyBrowseBtn'), 'focus lands on the one primary, Choose a folder…');
});

/** The start screen's buttons that carry the path `p`: whichever name a choice gives it, its title names its path. */
const offering = (h: ReturnType<typeof page>, p: string) => h.$('startChoices').children.filter((b) => b.title === p || b.title === `${p} — the whole drive`);

test('(vi) a folder the server refused — 400, 403 or 404 — is named and offered nowhere, under any name, with focus on Choose a folder…; refusals add up, and a folder taken since is offered again (review F1.5, F1.8)', async () => {
  // Review F1.5: a refused folder lost its "Scan … again", and came straight
  // back one row below under its quick-choice name — "Documents" under "The
  // scan of …/Documents failed: That folder is outside the folders TreeMap
  // may scan." F1.8: only the 404 of FOLDER_REFUSED_STATUSES was tested.
  for (const [status, code, error] of [
    [400, 'PATH_BLOCKED', 'That path cannot be scanned.'],
    [403, 'POLICY_ROOT_NOT_ALLOWED', 'That folder is outside the folders TreeMap may scan.'],
    [404, 'PATH_NOT_FOUND', 'Path does not exist'],
  ] as const) {
    const h = page({ route: server({ roots: [], scanAnswer: () => ({ status, body: { error, code } }) }) });
    await boot(h);
    await startFrom(h, /^Documents$/);
    assert.equal(h.$('startLast').textContent, `The scan of /Users/x/Documents failed: ${error.endsWith('.') ? error : `${error}.`}`, `${status}: named, with the reason`);
    assert.deepEqual(offering(h, '/Users/x/Documents').map((b) => b.textContent), [], `${status}: offered nowhere — neither "Scan Documents again" nor Documents (${h.choices().join(' | ')})`);
    assert.ok(h.choices().includes('Desktop'), `${status}: control: the other choices stay`);
    assert.equal(h.dom.activeElement, h.$('emptyBrowseBtn'), `${status}: focus on the one primary, Choose a folder…`);
  }
  // The control: a server error says nothing about the folder, which is offered again.
  const down = page({ route: server({ roots: [], scanAnswer: () => ({ status: 500, body: { error: 'Internal server error', code: 'INTERNAL' } }) }) });
  await boot(down);
  await startFrom(down, /^Documents$/);
  assert.deepEqual(offering(down, '/Users/x/Documents').map((b) => b.textContent), ['Scan Documents again'], 'a 500 is offered again, once');

  const refuse = { status: 403, body: { error: 'That folder is outside the folders TreeMap may scan.', code: 'POLICY_ROOT_NOT_ALLOWED' } };
  const both = page({ route: server({ roots: [], scanAnswer: () => refuse }) });
  await boot(both);
  await startFrom(both, /^Documents$/);
  await startFrom(both, /^Downloads$/);
  assert.deepEqual(both.choices(), ['Desktop', 'Home folder', 'Macintosh HD Whole drive'], 'two folders refused: neither comes back');

  const later = page({ route: server({ roots: [], scanAnswer: (n) => (n === 1 ? refuse : { status: 202, body: { scanId: `scan-${n}`, incremental: false } }) }) });
  await boot(later);
  await startFrom(later, /^Documents$/);
  assert.deepEqual(offering(later, '/Users/x/Documents'), [], 'control: refused');
  await later.startScan('/Users/x/Documents'); // as Choose a folder… scans it
  await turns();
  await pressStop(later);
  assert.equal(later.choices()[0], 'Scan Documents again', 'a folder the server has taken since is offered again');
});

test('a last folder from the history that cannot be opened now is offered nowhere, not even under its quick-choice name (review F1.5)', async () => {
  const h = page({ route: server({ roots: [{ rootPath: '/Users/x/Documents', count: 2, latestAt: 1_700_000_000_000, latestSize: 5 }], missing: ['/Users/x/Documents'] }) });
  await boot(h);
  assert.equal(h.$('startLast').textContent, 'Your last scan was of /Users/x/Documents, which cannot be opened now: Path does not exist.');
  assert.deepEqual(h.choices(), ['Desktop', 'Downloads', 'Home folder', 'Macintosh HD Whole drive'], 'no Documents beside the sentence that says it cannot be opened');
});

test('a folder that cannot be opened, or whose Stop the server would not confirm, stays offered nowhere after another folder is stopped, until a scan of it is taken (review F2.5)', async () => {
  // Review F2.5: the fact lived only on state.lastFolder, so the next Stop of
  // any other folder overwrote it and the folder came back as a plain quick
  // choice — a second walk of a folder that may still be walking, or a path
  // that answers an error.
  const h = page({ route: cancelAnswers(500) });
  await boot(h);
  await startFrom(h, /^Documents$/);
  await pressStop(h);
  assert.equal(h.$('startLast').textContent, 'TreeMap could not stop the scan of /Users/x/Documents, so it may still be running: Internal server error.', 'control: its cancel was refused');
  assert.deepEqual(offering(h, '/Users/x/Documents'), [], 'control: offered nowhere');
  await startFrom(h, /^Desktop$/);
  await pressStop(h);
  assert.equal(h.$('startLast').textContent, 'You stopped the scan of /Users/x/Desktop.', 'control: another folder\'s Stop is named now');
  assert.deepEqual(h.choices(), ['Scan Desktop again', 'Downloads', 'Home folder', 'Macintosh HD Whole drive'], 'the folder that may still be walking is still offered nowhere');
  await h.startScan('/Users/x/Documents'); // as Choose a folder… scans it
  await turns();
  await pressStop(h);
  assert.equal(h.choices()[0], 'Scan Documents again', 'a scan of it taken since: offered again');

  const unopenable = page({ route: server({ roots: [{ rootPath: '/Users/x/Documents', count: 2, latestAt: 1_700_000_000_000, latestSize: 5 }], missing: ['/Users/x/Documents'] }) });
  await boot(unopenable);
  assert.deepEqual(offering(unopenable, '/Users/x/Documents'), [], 'control: the history folder that cannot be opened is offered nowhere');
  await startFrom(unopenable, /^Desktop$/);
  await pressStop(unopenable);
  assert.deepEqual(unopenable.choices(), ['Scan Desktop again', 'Downloads', 'Home folder', 'Macintosh HD Whole drive'], 'nor after another folder is stopped');
  await unopenable.startScan('/Users/x/Documents');
  await turns();
  await pressStop(unopenable);
  assert.equal(unopenable.choices()[0], 'Scan Documents again', 'a scan of it taken since: offered again');
});

test('a refused cancel that answers after another folder\'s Stop keeps its own folder offered nowhere, while the start screen goes on naming the newer Stop (review F3.1)', async () => {
  // Review F3.1: the pin was written only while the start screen still said
  // what this Stop said, so a slow cancel refused after another folder had
  // been stopped pinned nothing, and the folder that may still be walking
  // came back as a plain choice — one click from a second walk of it.
  const held = { answer: (_a: { status: number; body: unknown }) => {} };
  const h = page({ route: cancelAnswers('held', held) });
  await boot(h);
  await startFrom(h, /^Desktop$/);
  h.$('scanBtn').focus();
  void h.stopScan(); // Desktop's cancel is held
  await turns();
  assert.equal(h.choices()[0], 'Scan Desktop again', 'control: said and offered at once, before the cancel answers');
  await startFrom(h, /^Documents$/);
  await pressStop(h); // Documents' cancel is confirmed
  assert.equal(h.$('startLast').textContent, 'You stopped the scan of /Users/x/Documents.', 'control: the newer Stop is named');
  assert.deepEqual(h.choices(), ['Scan Documents again', 'Desktop', 'Downloads', 'Home folder', 'Macintosh HD Whole drive'], 'control: Desktop is a plain choice while its cancel is unanswered');
  held.answer({ status: 500, body: { error: 'Internal server error', code: 'INTERNAL' } });
  await turns();
  assert.deepEqual(h.toasts, [['Could not stop the scan: Internal server error', 'error']], 'control: refused, and toasted');
  assert.equal(h.$('startLast').textContent, 'You stopped the scan of /Users/x/Documents.', 'control: the start screen goes on naming the newer Stop');
  assert.deepEqual(offering(h, '/Users/x/Desktop').map((b) => b.textContent), [], `the folder that may still be walking is offered nowhere (${h.choices().join(' | ')})`);
});

test('stopping a rescan while an older tree is on screen keeps today\'s behaviour: the older results stay, no start screen', async () => {
  const tree = { name: 'x', path: '/Users/x/old', size: 1, type: 'dir', children: [] };
  const h = page({ route: server({ roots: [] }), root: tree, settledScanId: 'scan-old' });
  h.switchView('dashboard');
  await h.startScan('/Users/x/Desktop');
  await turns();
  await pressStop(h);
  assert.equal(h.$('emptyState').style.display, 'none', 'the tree on screen stays');
  assert.equal(h.state.scanId, 'scan-old', 'with its own scan behind it');
  assert.equal(h.state.lastFolder, null, 'and the start screen is not told about the stopped rescan');
});

/* ══════════════ (D) — a folder with a saved index (seventh browser pass, J05, J06) ══════════════
   TreeMap indexes any folder under a million items on its own, so most
   folders a person scans again have a saved index, and their "Scan … again"
   paints the index's tree at once while the scan runs behind it. These run
   the page's own openFromIndex, finishScan and the treemap view's mount. */

const MAIL = '/Users/x/Mail';
const CORPUS = '/Users/x/corpus';
const MAIL_HISTORY = { rootPath: MAIL, count: 3, latestAt: Date.UTC(2026, 9, 18, 21, 30), latestSize: 37_700_000 };
/** The saved index's tree of `p`, as GET /api/index/tree sends one: a folder holding one file. */
const indexTreeOf = (p: string, size: number) => ({
  name: p.slice(p.lastIndexOf('/') + 1), path: p, size, type: 'dir',
  children: [{ name: 'a.emlx', path: `${p}/a.emlx`, size, type: 'file', extension: 'emlx' }],
});
const pathOf = (root: unknown) => (root as { path: string } | null)?.path ?? null;

test('J05: "Scan … again" of a folder with a saved index draws the map from the index before its scan answers — never a blank canvas waiting for the scan', async () => {
  // Seventh browser pass, J05: the index-first paint never drew the map. The
  // map is laid out by the server for a scan, the paint has no scan yet, and
  // the treemap view's mount returned with nothing drawn: a 300×150 blank
  // canvas until the scan completed (374 ms for Mail, 1455 ms for corpus).
  const scans: Array<(a: { status: number; body: unknown }) => void> = [];
  const h = page({ index: true, route: server({ roots: [MAIL_HISTORY], indexed: [MAIL], indexTrees: { [MAIL]: indexTreeOf(MAIL, 37_700_000) },
    scanAnswer: () => new Promise((r) => { scans.push(r); }) }) });
  await boot(h);
  await startFrom(h, /^Scan Mail again/);
  assert.equal(pathOf(h.state.root), MAIL, 'control: painted from the saved index');
  assert.equal(h.state.scanId, null, 'control: with no scan behind it yet');
  assert.equal(scans.length, 1, 'control: its scan has been asked for and has not answered');
  h.switchView('treemap'); // where the tour takes a person as the tree lands
  assert.deepEqual(h.draws.at(-1), { path: MAIL, root: MAIL, scanId: null }, 'the treemap view draws the tree on screen, from the saved index');
});

test('J05: Stop at any moment of "Scan … again" for a folder with a saved index never leaves a blank map — before its tree is read the start screen is back with "Scan … again" focused; once drawn, the tree stays drawn and is said to be the saved index — and Scan works again', async () => {
  // Seventh browser pass, J05 (Mail 4/4, corpus 2/2): a Stop at 0–120 ms
  // left the Treemap view up over a blank canvas, no start screen, and the
  // Dashboard saying "Opened from the saved index — scan this folder…".
  for (const at of ['probe', 'tree', 'painted', 'followed'] as const) {
    const label = { probe: 'Stop while the index is asked about', tree: 'Stop while its tree is read', painted: 'Stop once the tree is drawn, its scan not yet answered', followed: 'Stop once its scan is followed' }[at];
    const held: Record<string, (a: { status?: number; body?: unknown }) => void> = {};
    const hold = (k: string) => new Promise<{ status?: number; body?: unknown }>((r) => { held[k] = r; });
    const base = server({ roots: [MAIL_HISTORY], indexed: [MAIL], indexTrees: { [MAIL]: indexTreeOf(MAIL, 37_700_000) } });
    const h = page({ index: true, route: (m, url, b) => {
      if (at === 'probe' && url.startsWith('/api/index/status?') && !held.probe) return hold('probe');
      if (at === 'tree' && url.startsWith('/api/index/tree?') && !held.tree) return hold('tree');
      if (at === 'painted' && m === 'POST' && url === '/api/scan' && !held.scan) return hold('scan');
      return base(m, url, b);
    } });
    await boot(h);
    await startFrom(h, /^Scan Mail again/);
    await pressStop(h);
    // Whatever was held answers after the Stop, as a slow server's would.
    held.probe?.({ body: { path: MAIL, indexed: true, root: { path: MAIL, state: 'ready', live: true } } });
    held.tree?.({ body: { path: MAIL, rootPath: MAIL, fileCount: 1, dirCount: 1, root: indexTreeOf(MAIL, 37_700_000) } });
    held.scan?.({ status: 202, body: { scanId: 'scan-held', incremental: false } });
    await turns();
    const startScreen = at === 'probe' || at === 'tree';
    if (startScreen) {
      assert.equal(h.state.root, null, `${label}: control: nothing was painted`);
      assert.equal(h.$('emptyState').style.display, 'flex', `${label}: the start screen is back`);
      assert.equal(h.dom.activeElement, h.$('startAgainBtn'), `${label}: with "Scan Mail again" focused`);
      assert.match(h.$('startAgainBtn').textContent, /^Scan Mail again/, `${label}: control: that is the button focused`);
    } else {
      assert.equal(pathOf(h.state.root), MAIL, `${label}: the saved index's tree stays on screen`);
      assert.equal(h.state.scanId, null, `${label}: control: with no scan behind it`);
      assert.equal(h.$('emptyState').style.display, 'none', `${label}: control: so no start screen`);
      assert.match(h.$('scanStatus').innerHTML, /saved index of \/Users\/x\/Mail/, `${label}: the status line says plainly that the tree is the saved index (${h.$('scanStatus').innerHTML})`);
      h.switchView('treemap');
      assert.deepEqual(h.draws.at(-1), { path: MAIL, root: MAIL, scanId: null }, `${label}: and the map draws it — never a blank canvas`);
      assert.ok(h.requests.includes(`POST /api/scan/${at === 'painted' ? 'scan-held' : 'scan-1'}/cancel`), `${label}: control: the scan behind it is cancelled`);
    }
    // Scan works again after Stop: "Scan Mail again" on the start screen, the Scan button over a tree.
    const before = h.posts.length;
    if (startScreen) h.$('startAgainBtn').click();
    else { h.switchView('dashboard'); void h.startScan(MAIL); }
    await turns();
    assert.equal(h.posts.length, before + 1, `${label}: Scan works again — exactly one new scan`);
    assert.equal(h.posts.at(-1)!.path, MAIL, `${label}: of the same folder`);
    assert.equal(h.state.scanning, true, `${label}: and it runs`);
  }
});

test('J06: Stop while a folder with a saved index is painted over an older scan puts the older tree back with its scan; the map never names one folder while drawing another', async () => {
  // Seventh browser pass, J06: Mail scanned to completion, then corpus (which
  // has a saved index), then Stop 40 ms after its tree appeared. state.root
  // was corpus's index tree, scanId and settledScanId null, Mail's held scan
  // abandoned — and the map still drew Mail under corpus's name. The A6 rule
  // (a Stopped rescan keeps the older tree and its scan) held only for a
  // folder with no saved index.
  for (const [what, target] of [['another folder', CORPUS], ['the same folder', MAIL]] as const) {
    for (const answered of [false, true]) {
      const label = `a rescan of ${what}, Stopped ${answered ? 'once its scan is followed' : 'before its scan answers'}`;
      const mail = { name: 'Mail', path: MAIL, size: 37_700_000, type: 'dir', children: [] };
      const scans: Array<(a: { status: number; body: unknown }) => void> = [];
      const h = page({ index: true, root: mail, settledScanId: 'scan-mail',
        route: server({ roots: [], indexed: [target], indexTrees: { [target]: indexTreeOf(target, 9_500_000_000) },
          scanAnswer: answered ? undefined : () => new Promise((r) => { scans.push(r); }) }) });
      h.switchView('treemap');
      assert.deepEqual(h.draws.at(-1), { path: MAIL, root: MAIL, scanId: 'scan-mail' }, `${label}: control: the older scan is drawn`);
      await h.startScan(target);
      await turns();
      assert.equal(pathOf(h.state.root), target, `${label}: control: painted from the saved index`);
      assert.deepEqual(h.draws.at(-1), { path: target, root: target, scanId: null },
        `${label}: the map draws the tree it names at once — never the older drawing under the new folder's name`);
      h.switchView('dashboard'); // where Stop is
      await pressStop(h);
      assert.equal(h.state.root, mail, `${label}: the older tree is back on screen`);
      assert.equal(h.state.scanId, 'scan-mail', `${label}: with its own scan behind it`);
      assert.equal(h.state.settledScanId, 'scan-mail', `${label}: which a later Stop or failure puts back too`);
      assert.equal(h.$('emptyState').style.display, 'none', `${label}: control: no start screen over it`);
      h.switchView('treemap');
      assert.deepEqual(h.draws.at(-1), { path: MAIL, root: MAIL, scanId: 'scan-mail' }, `${label}: and the map draws it, by its own name`);
      if (answered) assert.ok(h.requests.includes('POST /api/scan/scan-1/cancel'), `${label}: control: the rescan is cancelled`);
      else {
        scans[0]({ status: 202, body: { scanId: 'scan-late', incremental: false } });
        await turns();
        assert.ok(h.requests.includes('POST /api/scan/scan-late/cancel'), `${label}: control: its late answer is cancelled`);
        assert.equal(h.state.root, mail, `${label}: and changes nothing on screen`);
        assert.equal(h.state.scanId, 'scan-mail', `${label}: nor the scan behind it`);
      }
      for (const d of h.draws) assert.equal(d.path, d.root, `${label}: every draw asked for the tree on screen, by its own folder (${JSON.stringify(d)})`);
      // And Scan works again: the folder asked for is scanned once more.
      const before = h.posts.length;
      h.switchView('dashboard');
      void h.startScan(target);
      await turns();
      assert.equal(h.posts.length, before + 1, `${label}: Scan works again — exactly one new scan`);
    }
  }
});

test('J06: the older tree an index paint stood over is let go once that folder\'s scan lands, or its quiet rescan fails — it can be a quarter-million nodes — and a Stop after either puts nothing back', async () => {
  for (const outcome of ['lands', 'fails'] as const) {
    const label = `the scan behind the index paint ${outcome}`;
    const mail = { name: 'Mail', path: MAIL, size: 37_700_000, type: 'dir', children: [] };
    const h = page({ index: true, root: mail, settledScanId: 'scan-mail',
      route: server({ roots: [], indexed: [CORPUS], indexTrees: { [CORPUS]: indexTreeOf(CORPUS, 9_500_000_000) },
        scanAnswer: outcome === 'fails' ? () => ({ status: 500, body: { error: 'The drive stopped answering.', code: 'INTERNAL' } }) : undefined }) });
    h.switchView('dashboard');
    await h.startScan(CORPUS);
    await turns();
    assert.equal(pathOf(h.state.root), CORPUS, `${label}: control: painted from the saved index`);
    if (outcome === 'lands') {
      assert.notEqual(h.state.heldBehindIndex, null, `${label}: control: the older tree is held while the scan runs`);
      const scanned = { name: 'corpus', path: CORPUS, size: 9_500_000_000, type: 'dir', children: [] };
      h.streams[0].onmessage!({ data: JSON.stringify({ type: 'complete', root: scanned, stats: { fileCount: 1, dirCount: 1 } }) });
      await turns();
      assert.deepEqual(h.state.root, scanned, `${label}: control: the scan's tree is on screen`);
      assert.equal(h.state.scanId, 'scan-1', `${label}: control: with its scan`);
    } else {
      assert.match(h.$('scanStatus').innerHTML, /Showing the saved index — the refresh failed/, `${label}: control: the saved index stays, said to be`);
    }
    assert.equal(h.state.heldBehindIndex, null, `${label}: the older tree is let go`);
    // A Stop of the next scan puts nothing back: the tree on screen stays.
    const onScreen = h.state.root;
    void h.startScan('/Users/x/Desktop');
    await turns();
    await pressStop(h);
    assert.equal(h.state.root, onScreen, `${label}: a later Stop keeps the tree that was on screen`);
  }
});

/* ══════════════ (E) — the rest of the seventh browser pass (J01, J02, J03, J07) ══════════════ */

test('J01: a scan started from the start screen puts focus on the Dashboard\'s Stop — never on the Dashboard\'s first control, the System card\'s Trash row, whose next Enter opened the Trash sheet over the map', async () => {
  // Seventh browser pass, J01: with focus on "Scan corpus again", Enter left
  // document.activeElement on DIV#trashFact (4/4); a second Enter opened the
  // Trash sheet with "Empty Trash…" over the map. The same after a click on
  // Desktop or Whole drive.
  const h = page({ route: server({ roots: [MAIL_HISTORY] }) });
  await boot(h);
  for (const words of [/^Scan Mail again/, /^Desktop$/, /Whole drive$/]) {
    const b = h.choice(words);
    b.focus();
    b.click(); // Enter on the focused choice
    await turns();
    assert.equal(h.state.scanning, true, `${words}: control: the scan runs`);
    assert.equal(h.$('scanBtn').painted(), true, `${words}: control: the Dashboard's Stop is on screen`);
    assert.equal(h.$('trashFact').painted(), true, `${words}: control: and so is the Trash row, before it in the page`);
    assert.equal(h.dom.activeElement, h.$('scanBtn'), `${words}: focus lands on Stop (${h.dom.activeElement.id})`);
    await pressStop(h);
    assert.equal(h.dom.activeElement, h.$('startAgainBtn'), `${words}: control: after Stop, on "Scan … again"`);
  }
});

test('J01: Stop takes focus only while a scan runs and Stop is on screen and enabled — otherwise the view\'s first control, as before', () => {
  type C = { id: string; disabled: boolean; rects: number; getClientRects: () => unknown[] };
  const mk = (id: string, rects = 1): C => { const c: C = { id, disabled: false, rects, getClientRects: () => Array.from({ length: c.rects }) }; return c; };
  const pick = (o: { scanning: boolean; stopRects?: number; stopDisabled?: boolean }) => {
    const trash = mk('trashFact'); const stop = mk('scanBtn', o.stopRects ?? 1);
    stop.disabled = !!o.stopDisabled;
    const doc = { querySelectorAll: (sel: string) => (sel.startsWith('.view.active ') ? [trash, stop] : []) };
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const fn = new Function('state', '$', 'document', `'use strict'; ${pageFn('function activeViewControl(')} return activeViewControl;`)(
      { scanning: o.scanning }, (id: string) => (id === 'scanBtn' ? stop : null), doc) as () => C | null;
    return fn()?.id ?? null;
  };
  assert.equal(pick({ scanning: true }), 'scanBtn', 'a scan running, Stop on screen: Stop');
  assert.equal(pick({ scanning: true, stopRects: 0 }), 'trashFact', 'Stop off screen (another view is up): the view\'s first control, never a hidden button');
  assert.equal(pick({ scanning: true, stopDisabled: true }), 'trashFact', 'Stop disabled: the view\'s first control');
  assert.equal(pick({ scanning: false }), 'trashFact', 'no scan running: the view\'s first control, as before');
});

test('a scan that fails leaves no dead scan id behind, as a Stop leaves none: a failed rescan over an older tree puts back the older tree\'s scan, a failed first scan leaves none (review F2.3)', async () => {
  // Review F2.3: every scanId-keyed endpoint answers a failed scan with 500
  // SCAN_FAILED, and failScan left state.scanId on it — a pruned folder of
  // the older tree then loaded as nothing, and the Calendar said "Could not
  // build the calendar: <the scan's error>" instead of its empty state.
  // The id is put back BEFORE the views remount, as stopScan's is
  // (failurePaths: scanIdAtSwitch): a view mounted by failScan's switchView —
  // the Calendar asks /api/scan/<id>/calendar as it mounts — asks with the
  // id it finds then (review F3.3). Each view's mount records it.
  const mountedWith = (p: ReturnType<typeof page>, view: string): unknown[] => {
    const seen: unknown[] = [];
    (p.given.VIEW_BY_ID as Map<string, { mount: () => void }>).get(view)!.mount = () => { seen.push(p.state.scanId); };
    return seen;
  };
  const tree = { name: 'x', path: '/Users/x/old', size: 1, type: 'dir', children: [] };
  const h = page({ route: server({ roots: [] }), root: tree, settledScanId: 'scan-old' });
  h.switchView('dashboard');
  await h.startScan('/Users/x/Desktop');
  await turns();
  assert.equal(h.state.scanId, 'scan-1', 'control: the rescan is followed');
  const dashboardSaw = mountedWith(h, 'dashboard');
  h.streams[0].onmessage!({ data: JSON.stringify({ type: 'error', message: 'The drive stopped answering.' }) });
  await turns();
  assert.equal(h.state.scanning, false, 'control: it failed');
  assert.equal(h.$('emptyState').style.display, 'none', 'control: the older tree stays on screen');
  assert.equal(h.state.scanId, 'scan-old', 'with its own scan behind it, not the failed one');
  assert.deepEqual(dashboardSaw, ['scan-old'], 'and the Dashboard, remounted over the older tree, is mounted with the older tree\'s scan, never the failed one');

  const first = page({ route: server({ roots: [] }) });
  await boot(first);
  await startFrom(first, /^Desktop$/);
  assert.equal(first.state.scanId, 'scan-1', 'control: the first scan is followed');
  // A view that needs no scan mounts with nothing on screen: the person moved to it while the scan ran.
  first.switchView('trends');
  const trendsSaw = mountedWith(first, 'trends');
  first.streams[0].onmessage!({ data: JSON.stringify({ type: 'error', message: 'The drive stopped answering.' }) });
  await turns();
  assert.equal(first.state.scanning, false, 'control: it failed');
  assert.equal((first.state.lastFolder as { outcome: string }).outcome, 'failed', 'control: as a first scan, with no tree on screen');
  assert.equal(first.state.scanId, null, 'and no scan id is left for a view to ask with');
  first.switchView('dashboard');
  assert.equal(first.$('startLast').textContent, 'The scan of /Users/x/Desktop failed: The drive stopped answering.', 'control: the start screen names it');
  assert.deepEqual(trendsSaw, [null], 'nor is one there as the view is remounted: it is mounted with no scan id, never the failed scan\'s');
});

test('the start screen\'s sentence breaks a long path anywhere to fit its column, as a toast and a refused folder do: a path has no spaces to break at (review F2.10)', () => {
  // Review F2.10: #startLast embeds the raw path, under `#emptyState p { max-width: 460px }`
  // centred, with nothing that lets a long unbroken run of it wrap; past the
  // column it ran off centre, and <main> clips it at a narrow window — the end
  // of the path, the part that tells folders apart.
  const at = INDEX.indexOf('#emptyState .start-last {');
  assert.notEqual(at, -1, 'the start screen\'s sentence has a rule of its own');
  const rule = INDEX.slice(at, INDEX.indexOf('}', at));
  assert.match(rule, /overflow-wrap:\s*anywhere/, `and breaks a path anywhere to fit (${rule})`);
});

test('the start screen\'s page-level bindings are declared before the boot paints the first view: one read before its declaration throws, and stops the whole page script', () => {
  // Found in a browser on this build: switchView('dashboard') at boot runs
  // renderEmptyState → renderStartChoices, which read `startPainted` while
  // its `let` was still further down the script. The page stopped there —
  // no choices, no tour, no window.TreeMap. Function declarations hoist;
  // `let` and `const` do not.
  const boot = INDEX.indexOf("/* ───────────────────────────── Boot ───────────────────────────── */\nswitchView('dashboard');");
  assert.notEqual(boot, -1, 'the boot\'s first switchView is where this test thinks it is');
  for (const decl of ['const START_FOLDERS = ', 'let startDrivesAsked = ', 'let startShown = ', 'let startPainted = ', 'let startVerdicts = ', 'let startAsking = ', 'const FOLDER_REFUSED_STATUSES = ', 'let browseDrivesSeen = ']) {
    const at = INDEX.indexOf(decl);
    assert.notEqual(at, -1, `${decl.trim()} is in the page`);
    assert.ok(at < boot, `${decl.trim()} is declared before the boot paints the first view`);
  }
});
