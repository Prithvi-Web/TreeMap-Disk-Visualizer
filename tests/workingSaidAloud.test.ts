import { test } from 'node:test';
import assert from 'node:assert/strict';

import { INDEX } from './fixtures/liftFrontend';

/**
 * What a part of the page is working on, said aloud (BQR-1 item 11; review F3.9 risk).
 *
 * skeletonRows carries its loading sentence as the aria-label of a role="status" element that one
 * innerHTML write puts on screen already filled: a screen reader announces a live region's text as it
 * changes, not its label, and seldom a region that appears filled. c42d3c23 fixed that for the Clean Up
 * sheet's panes; the same rows stood in the Dashboard's disk layout, held-up space, drive health and
 * cost cards, the History view's calendar and journal, the Undo Vault and Missing gigabytes. Each now
 * has a live region of its own beside it, in the page from the start, and sayWorking puts the sentence
 * in that region's text once the rows are on screen and takes it out once they are gone. The Apps,
 * Security, Photo and video libraries and Games views wrote rows with no sentence at all; they now
 * have one, said the same way (review F1.8).
 */

/** Every part outside Clean Up that writes labelled working rows: its loader, its host, its sentence, its region. */
const PARTS = [
  { loader: 'async function loadTopology(', host: 'topologyBody', sentence: 'Reading disk layout…', region: 'topologyWorking' },
  { loader: 'async function loadZombies(', host: 'zombieBody', sentence: 'Checking for held-up space…', region: 'zombieWorking' },
  { loader: 'async function loadDriveHealth(', host: 'driveHealthBody', sentence: 'Reading the drive’s own report…', region: 'driveHealthWorking' },
  { loader: 'async function loadCostEstimate(', host: 'costBody', sentence: 'Working out what keeping this online would cost…', region: 'costWorking' },
  { loader: 'async function loadCalendar(', host: 'calBody', sentence: 'Counting bytes per day…', region: 'calWorking' },
  { loader: 'async function loadJournal(', host: 'journalBody', sentence: 'Reading the journal…', region: 'journalWorking' },
  { loader: 'async function loadCapsule(', host: 'capsuleBody', sentence: 'Reading the Undo Vault…', region: 'capsuleWorking' },
  { loader: 'async function loadMissing(', host: 'missingBody', sentence: 'Reconciling this disk…', region: 'missingWorking' },
  // Their working rows had no sentence at all, so a screen reader heard nothing while they worked (review F1.8).
  { loader: 'async function loadApps(', host: 'appsBody', sentence: 'Working out what each application owns…', region: 'appsWorking' },
  { loader: 'async function loadSecurity(', host: 'securityBody', sentence: 'Looking for keys, credentials and wallets…', region: 'securityWorking' },
  { loader: 'async function loadMedia(', host: 'mediaBody', sentence: 'Reading photo and video libraries…', region: 'mediaWorking' },
  { loader: 'async function loadGames(', host: 'gamesBody', sentence: 'Reading game libraries…', region: 'gamesWorking' },
] as const;

/** The Clean Up sheet's panes, which speak in the sheet's own region (c42d3c23, tests/treeScanKey.test.ts). */
const CLEAN_UP = ['Working out what Clean Up suggests…', 'Finding empty folders…', 'Finding videos worth re-encoding…', 'Finding files that match…'];

/** A page function by its declaration, brace-matched. */
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

/** The markup of an empty live region with this id, as the page writes one. */
const regionMarkup = (id: string) => `<div id="${id}" class="sr-only" role="status" aria-live="polite" aria-atomic="true"></div>`;

test('every labelled skeleton in the page is one of the parts that say their sentence aloud — none is left with it only in a label (BQR-1 item 11)', () => {
  const labelled = [...INDEX.matchAll(/skeletonRows\(\d+, \d+, '([^']+)'\)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(labelled)].sort(), [...PARTS.map((p) => p.sentence), ...CLEAN_UP].sort(),
    'each labelled skeleton is a part listed here or a Clean Up pane');
});

test('every working row without a sentence is one of the Dashboard\'s lists a running scan paints, whose progress the scan says aloud — no other part works in silence (review F1.8)', () => {
  const bare = [...INDEX.matchAll(/skeletonRows\(\d+(?:, \d+)?\)/g)];
  assert.ok(bare.length > 0, 'control: the Dashboard\'s lists are painted with rows of no sentence while a scan runs');
  const into = bare.map((m) => {
    const before = INDEX.slice(Math.max(0, m.index - 80), m.index);
    return /\$\('(\w+)'\)\.innerHTML = $/.exec(before)?.[1] ?? `${before.slice(-50)}skeletonRows(…)`;
  });
  assert.deepEqual([...new Set(into)].sort(), ['bigFiles', 'bigFolders', 'donutLegend'],
    'each skeleton written without a sentence is the Dashboard\'s largest files, largest folders or file-type legend, which a scan paints as it starts (scanAnnounce says the scan)');
});

test('each part has a live region of its own beside its host, empty, in the page from the start — never inside the host, whose every write would take it away (BQR-1 item 11)', () => {
  for (const { host, region } of PARTS) {
    const open = INDEX.indexOf(`<div id="${host}"`);
    assert.notEqual(open, -1, `${host} is in the markup`);
    assert.equal(INDEX.split(regionMarkup(region)).length, 2, `${region}: exactly one empty live region in the markup`);
    // The host's line ends with its own closing tag: the region is the next element after it.
    const lineEnd = INDEX.indexOf('\n', open);
    assert.match(INDEX.slice(open, lineEnd), /<\/div>\s*$/, `${host}: control: its markup closes on its own line`);
    const next = INDEX.slice(lineEnd).replace(/^\s*(?:<!--[\s\S]*?-->\s*)*/, '');
    assert.ok(next.startsWith(regionMarkup(region)), `${region} stands right after ${host}, outside it: ${next.slice(0, 120)}`);
  }
});

test('each part, once it writes its working rows, hands them to sayWorking with its own region (BQR-1 item 11)', () => {
  for (const { loader, sentence, region } of PARTS) {
    const src = pageFn(loader);
    const write = new RegExp(`(\\w+)\\.innerHTML = skeletonRows\\(\\d+, \\d+, '${sentence}'\\);`).exec(src);
    assert.ok(write, `${loader}: control: it writes its labelled rows into a host`);
    const after = src.slice(write.index + write[0].length).replace(/^\s*(?:\/\/[^\n]*\s*)*/, '');
    assert.ok(after.startsWith(`if (typeof sayWorking === 'function') sayWorking(${write[1]}, '${region}');`),
      `${loader}: the rows it wrote go to sayWorking with ${region}, next: ${after.slice(0, 120)}`);
  }
});

/* ───────────────────────────── the page's own code, run ───────────────────────────── */

/** A MutationObserver over `childList`, as a browser runs one: told a microtask later, never after a disconnect. */
class FakeObserver {
  private queued = false;
  private readonly on = new Set<Host>();
  constructor(private readonly cb: () => void) {}
  observe(target: Host, opts: { childList?: boolean }): void { assert.equal(opts.childList, true, 'it watches the host\'s children'); this.on.add(target); target.watchers.add(this); }
  disconnect(): void { for (const t of this.on) t.watchers.delete(this); this.on.clear(); this.queued = false; }
  notify(): void {
    if (this.queued) return;
    this.queued = true;
    queueMicrotask(() => { if (!this.queued) return; this.queued = false; this.cb(); });
  }
}

/**
 * An element as a browser keeps it, as far as these loaders and sayWorking reach: each innerHTML write replaces its
 * children — the rows written before leave the page — and is told to each observer watching it; its first child
 * answers getAttribute from the markup written; a region's text is recorded as it is set.
 */
class Host {
  readonly watchers = new Set<FakeObserver>();
  readonly said: string[] = [];
  private html = '';
  private text = '';
  private first: { isConnected: boolean; getAttribute: (k: string) => string | null } | null = null;
  readonly classList = { add: () => {}, remove: () => {}, contains: () => false };
  get innerHTML(): string { return this.html; }
  set innerHTML(v: string) {
    if (this.first) this.first.isConnected = false;
    this.html = v;
    const open = /^\s*<[a-z]+([^>]*)>/i.exec(v);
    this.first = open ? { isConnected: true, getAttribute: (k: string) => new RegExp(`\\s${k}="([^"]*)"`).exec(open[1])?.[1] ?? null } : null;
    for (const w of this.watchers) w.notify();
  }
  get firstElementChild() { return this.first; }
  get textContent(): string { return this.text; }
  set textContent(v: string) { this.text = v; this.said.push(v); }
  /** What the loaders look for in a card they already filled: nothing, so a first load writes its rows. */
  querySelector(): null { return null; }
}

/** Let the microtasks and a few turns pass: a count, never a time. */
async function turns(n = 5): Promise<void> {
  for (let i = 0; i < n; i++) await new Promise((resolve) => setImmediate(resolve));
}

/**
 * The Dashboard's disk layout and held-up space cards, which load at once: their loaders, skeletonRows and sayWorking
 * lifted from the page, over Hosts, with each card's request held until answered and frames run by hand.
 */
function dashboard() {
  const els = new Map<string, Host>();
  const $ = (id: string) => { let e = els.get(id); if (!e) { e = new Host(); els.set(id, e); } return e; };
  const frames: Array<() => void> = [];
  const held: Record<string, Array<(v: unknown) => void>> = { topology: [], zombies: [] };
  const given: Record<string, unknown> = {
    $, state: { capabilities: null }, escapeHtml: (s: string) => s,
    MutationObserver: FakeObserver, requestAnimationFrame: (fn: () => void) => frames.push(fn),
    workingSaid: new Map(), topologyLoading: false, zombiesLoading: false,
    api: (url: string) => { assert.equal(url, '/api/zombie-handles', 'control: the held-up space card asks for its report'); return new Promise((r) => held.zombies.push(r)); },
    topologyAnswer: () => new Promise((r) => held.topology.push(r)),
    // What each card paints once it has its answer: rows of its own, which take the working rows' place.
    renderTopology: () => { $('topologyBody').innerHTML = '<div class="topo-disk">Macintosh HD</div>'; },
    renderZombies: () => { $('zombieBody').innerHTML = '<div class="zh-total">Nothing is held up.</div>'; },
  };
  const own = new Set(['loadTopology', 'loadZombies', 'skeletonRows', 'sayWorking']);
  const scope = new Proxy(given, {
    has: (t, k) => typeof k === 'string' && k in t && !own.has(k),
    get: (t, k) => (k === Symbol.unscopables ? undefined : t[k as string]),
    set: (t, k, v) => { t[k as string] = v; return true; },
  });
  const decls = ['async function loadTopology(', 'async function loadZombies(', 'function skeletonRows(', 'function sayWorking('];
  const fns = new Function('scope', `with (scope) { ${decls.map(pageFn).join('\n')}\n return { topology: loadTopology, zombies: loadZombies }; }`)(scope) as
    { topology: () => Promise<void>; zombies: () => Promise<void> };
  const frame = () => { for (const fn of frames.splice(0)) fn(); };
  const answer = async (card: 'topology' | 'zombies') => { for (const r of held[card].splice(0)) r({}); await turns(); };
  return { $, fns, frame, answer, held };
}

test('the Dashboard\'s disk layout and held-up space, loading at once, each say their sentence in their own region a frame after their rows are written, and each region is emptied once its own card has answered (BQR-1 item 11)', async () => {
  const d = dashboard();
  void d.fns.topology();
  void d.fns.zombies();
  await turns();
  assert.deepEqual([d.held.topology.length, d.held.zombies.length], [1, 1], 'control: both cards\' requests are out');
  assert.deepEqual([d.$('topologyWorking').textContent, d.$('zombieWorking').textContent], ['', ''], 'nothing is said before the frame');
  d.frame();
  assert.equal(d.$('topologyWorking').textContent, 'Reading disk layout…', 'the disk layout card says it is working, in its region\'s text');
  assert.equal(d.$('zombieWorking').textContent, 'Checking for held-up space…', 'and the held-up space card, at the same time, in its own');
  await d.answer('zombies');
  assert.equal(d.$('zombieWorking').textContent, '', 'the held-up space card answered: its region is emptied');
  assert.equal(d.$('topologyWorking').textContent, 'Reading disk layout…', 'and the disk layout card, still working, still says so');
  await d.answer('topology');
  assert.equal(d.$('topologyWorking').textContent, '', 'once it answers its region is emptied too');
});

test('a card asked again says its sentence again: the region is emptied before the sentence is set, so the same words are a change a screen reader hears (BQR-1 item 11)', async () => {
  const d = dashboard();
  void d.fns.zombies();
  await turns();
  d.frame();
  await d.answer('zombies');
  // Asked again with its rows gone (a Retry after an error paints none): it writes working rows once more.
  d.$('zombieBody').innerHTML = '';
  await turns();
  d.$('zombieWorking').said.length = 0;
  void d.fns.zombies();
  await turns();
  d.frame();
  assert.deepEqual(d.$('zombieWorking').said, ['', 'Checking for held-up space…'], 'emptied first, then said a frame later');
  await d.answer('zombies');
});
