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

class Dom {
  els = new Map<string, El>();
  active: El | null = null;
  body: El;
  constructor() {
    this.body = new El(this, 'body');
    const empty = this.get('emptyState');
    for (const id of ['emptyHero', 'emptyForView', 'startLast', 'startChoices', 'emptyBrowseBtn']) this.get(id).parent = empty;
    const dash = this.get('view-dashboard');
    for (const id of ['scanBtn', 'pathInput']) this.get(id).parent = dash;
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
  'function startLanding(', 'function focusLanding(', 'function withFocusKept(', 'function focusStartScreen(',
  'function closeEventSource(', 'function setScanButtonMode(', 'function cancelScanById(', 'function abandonIfStopped(',
  'async function stopScan(', 'function beginScanChrome(', 'async function indexStatusFor(',
  'async function startScan(', 'async function startScanRequest(', 'function followScanProgress(',
  'function endScanChrome(', 'function failScan(', 'function noteLastFolder(',
  'function browseWholeDrives(', 'function topologyAnswer(',
  'function startChoiceList(', 'function startFolderName(', 'function startLastLine(', 'function renderStartChoices(', 'function scanStartChoice(', 'async function startNameDrives(',
  'function requestedPath(', 'async function restoreLastSession(', 'function showRestoredPath(', 'async function reopenScan(',
  'async function startCloudScan(',
];
const OWN = new Set(LIFTED.map((d) => /function (\w+)\(/.exec(d)![1]));

const formatBytes = liftPage<(n: number) => string>(['UNITS', 'UI_LOCALE', 'formatBytes'], 'formatBytes');
/** The page's own constants the lifted functions read. */
const START_FOLDERS = liftPage<string[]>(['START_FOLDERS'], 'START_FOLDERS');
const FOLDER_REFUSED_STATUSES = liftPage<number[]>(['FOLDER_REFUSED_STATUSES'], 'FOLDER_REFUSED_STATUSES');
const formatDate = liftPage<(ms: number) => string>(['UI_LOCALE', 'DATE_FMT', 'dateMemo', 'formatDate'], 'formatDate');

/** Let `n` turns of the event loop pass: a count, never a time. */
async function turns(n = 30): Promise<void> {
  for (let i = 0; i < n; i++) await new Promise((resolve) => setImmediate(resolve));
}

function page(o: { route: Route; system?: unknown; search?: string; root?: unknown; settledScanId?: string | null }) {
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
    view: 'dashboard', system: o.system ?? MAC, capabilities: null, scanId: o.settledScanId ?? null, settledScanId: o.settledScanId ?? null,
    scanning: false, es: null, abortScan: null, scanGen: 0, root: o.root ?? null, scanStats: null, whatsNew: { seq: 0 },
    lastFolder: null, scanningPath: null, scannedBefore: false, largest: [], bigFolders: [], types: [],
  };
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
    querySelectorAll: (sel: string) => (sel === '.view' ? [$('view-dashboard'), $('view-grid'), $('view-trends')] : []),
  };
  const given: Record<string, unknown> = {
    state, $, document, fetch: fetchStub, EventSource: FakeEventSource, location: { search: o.search ?? '' },
    setInterval: () => { const id = nextInterval++; intervals.add(id); return id; },
    clearInterval: (id: number) => { intervals.delete(id); },
    console: { warn: noop, error: noop, log: noop },
    VIEW_BY_ID, tabs: [], mountedView: null, indexLineGen: 0, indexAutoMaxEntries: null, browseDrivesSeen: null, topologyShared: null,
    startDrivesAsked: false, startShown: [], startPainted: null, START_FOLDERS, FOLDER_REFUSED_STATUSES,
    TOPOLOGY_SHARE_MS: 3000, REDUCED: true, INSTANT_OPEN_NODES: 25000,
    formatBytes, formatDate, formatCount: String, icon: () => '', skeletonRows: () => '',
    toast: (m: string, k?: string) => { toasts.push([m, k]); },
    finishScan: async (root: unknown) => { finished.push(root); state.root = root; },
    maybeShowFastRescan: noop, rememberScannedRoot: noop, showFastRescanStat: noop, scanStatsFor: async () => ({}),
    restoreDashboardPanels: noop, renderIndexBadge: noop, renderIndexLine: noop, disableLive: noop, clearDonut: noop,
    fxStateBeam: noop, fxOrbShow: noop, fxOrbHide: noop, fxScanHeroSync: noop, fxDonutLoadingSync: noop, fxEmptyCtaSync: noop, fxViewEnter: noop,
    hideTooltip: noop, hideCtxMenu: noop, selectionBarFollowView: noop, renderCapabilityNotice: noop,
    scanAccessNotice: async () => false, clearScanQueue: noop, drainScanQueue: noop, quietRescanFailed: (e: unknown) => { quietFailed.push(e); },
    openFromIndex: async () => false,
    activeViewControl: () => null, tourCardControl: () => null,
    tourScanStarted: () => tourCalls.push('started'), tourScanFailed: () => tourCalls.push('failed'),
    tourFollowView: noop, tourBootSettled: () => tourCalls.push('boot settled'),
  };
  const scope = new Proxy(given, {
    has: (t, k) => typeof k === 'string' && k in t && !OWN.has(k),
    get: (t, k) => (k === Symbol.unscopables ? undefined : t[k as string]),
    set: (t, k, v) => { t[k as string] = v; return true; },
  });
  const src = LIFTED.map(pageFn).join('\n');
  const fns = new Function('scope', `with (scope) { ${src}\n return { switchView, restoreLastSession, startScan, stopScan, failScan, renderStartChoices, startCloudScan }; }`)(scope) as {
    switchView: (v: string) => void; restoreLastSession: () => Promise<void>; startScan: (p: string, o?: unknown) => Promise<void>;
    stopScan: () => Promise<void>; failScan: (m: string, e?: unknown) => void; renderStartChoices: () => void;
    startCloudScan: (id: string, name: string) => Promise<void>;
  };
  /** The start screen's choices as a person sees them: each button's words, in order. */
  const choices = () => $('startChoices').children.map((b) => b.textContent);
  const choice = (words: RegExp) => {
    const b = $('startChoices').children.find((c) => words.test(c.textContent));
    assert.ok(b, `a choice reads ${words} (${choices().join(' | ')})`);
    return b!;
  };
  const openStreams = () => streams.filter((s) => s.readyState !== 2);
  return { ...fns, dom, $, state, requests, posts, toasts, finished, quietFailed, tourCalls, streams, openStreams, intervals, choices, choice, given };
}

/** A server: the history and the folders a test names, a scan request answered with the next id, and its cancel. */
function server(opts: {
  scans?: unknown[]; roots?: unknown[] | Error; missing?: string[]; topology?: unknown; indexed?: string[];
  scanAnswer?: (n: number, body: Record<string, unknown>) => Answer;
} = {}): Route {
  let n = 0;
  return (method, url, body) => {
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

test('the start screen\'s page-level bindings are declared before the boot paints the first view: one read before its declaration throws, and stops the whole page script', () => {
  // Found in a browser on this build: switchView('dashboard') at boot runs
  // renderEmptyState → renderStartChoices, which read `startPainted` while
  // its `let` was still further down the script. The page stopped there —
  // no choices, no tour, no window.TreeMap. Function declarations hoist;
  // `let` and `const` do not.
  const boot = INDEX.indexOf("/* ───────────────────────────── Boot ───────────────────────────── */\nswitchView('dashboard');");
  assert.notEqual(boot, -1, 'the boot\'s first switchView is where this test thinks it is');
  for (const decl of ['const START_FOLDERS = ', 'let startDrivesAsked = ', 'let startShown = ', 'let startPainted = ', 'const FOLDER_REFUSED_STATUSES = ', 'let browseDrivesSeen = ']) {
    const at = INDEX.indexOf(decl);
    assert.notEqual(at, -1, `${decl.trim()} is in the page`);
    assert.ok(at < boot, `${decl.trim()} is declared before the boot paints the first view`);
  }
});
