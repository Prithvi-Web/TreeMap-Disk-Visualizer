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
 * have one, said the same way (review F1.8). The Fleet view shipped its rows in the markup with the
 * sentence only in their label, and its loader never spoke; its loader now writes them and says them,
 * and no live region anywhere in the page carries a sentence in a label but skeletonRows' own (review F2.1).
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
  // Its rows shipped in the markup with the sentence only in their label, and its loader never spoke (review F2.1).
  { loader: 'async function loadFleet(', host: 'fleetBody', sentence: 'Looking for TreeMaps on your network…', region: 'fleetWorking' },
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

test('the two checks above see every working row in the page: no live region carries a sentence in its label but skeletonRows\' own, working rows are drawn only by skeletonRows, and every call of it is one they read (review F2.1)', () => {
  // A live region is told by its role or its aria-live; a label on one is never announced as it changes.
  const labelledLive = [...INDEX.matchAll(/<[a-z][a-z0-9]*\b[^<>]*>/gi)].map((m) => m[0])
    .filter((tag) => /\srole="(?:status|alert|log)"|\saria-live="/.test(tag) && /\saria-label(?:ledby)?="/.test(tag));
  assert.deepEqual(labelledLive, ['<div role="status" aria-label="${escapeHtml(label)}">'],
    'the only live region with a label is skeletonRows\' template, which each part hands to sayWorking (the Fleet view shipped one in its markup)');
  const drawn = INDEX.split('class="skeleton"').length - 1;
  assert.equal(drawn, 1, 'working rows are drawn in one place, skeletonRows, so no markup or loader holds rows the checks above cannot see');
  assert.ok(pageFn('function skeletonRows(').includes('class="skeleton"'), 'control: that place is skeletonRows');
  const calls = [...INDEX.matchAll(/skeletonRows\(([^)]*)\)/g)].map((m) => m[0]).filter((c) => c !== 'skeletonRows(n, h = 38, label = \'\')');
  assert.deepEqual(calls.filter((c) => !/^skeletonRows\(\d+(?:, \d+)?\)$|^skeletonRows\(\d+, \d+, '[^']+'\)$/.test(c)), [],
    'every call passes its count, height and sentence as the checks above read them: a sentence held in a variable would go unseen');
});

/**
 * The live regions still left hidden while they have nothing to say, each waiting for the batch that owns its writer,
 * with why. Named here so that nothing else can join them; the batch's fix takes its name off.
 */
const WAITING: ReadonlyMap<string, string> = new Map([
  ['tmEmpty', 'its writer, tmSetEmpty (050-treemap-view.js), is another batch\'s, which fixes it there; until that batch merges it is the one live region left hidden'],
]);

/** Every opening tag in the page — the markup and the script's own templates. */
const TAGS = [...INDEX.matchAll(/<[a-z][a-z0-9]*\b[^<>]*>/gi)].map((m) => m[0]);
/** A live region is told by its role or its aria-live. */
const isLive = (tag: string) => /\srole="(?:status|alert|log)"|\saria-live="/.test(tag);
const idOf = (tag: string) => / id="([^"]+)"/.exec(tag)?.[1] ?? tag;

/** The source of the page's top-level function that holds `at`, or the 2,000 characters from `at` where none does (a listener). */
function enclosingFn(at: number): string {
  for (const m of INDEX.matchAll(/\n(?:async )?function \w+\(/g)) {
    if (m.index > at) break;
    const open = INDEX.indexOf('{', INDEX.indexOf(')', m.index));
    let depth = 0;
    for (let i = open; i < INDEX.length; i++) {
      if (INDEX[i] === '{') depth++;
      else if (INDEX[i] === '}' && --depth === 0) { if (i > at) return INDEX.slice(m.index, i + 1); break; }
    }
  }
  return INDEX.slice(at, at + 2000);
}

/**
 * Each script statement that shows or hides the element with this id — through `$('id')` or a constant that holds it.
 * A write is `.hidden =`, or the hidden attribute set, removed or toggled.
 */
function hidingsOf(id: string): string[] {
  const out: string[] = [];
  const show = String.raw`(?:\.hidden\s*=(?!=)|\.(?:setAttribute|removeAttribute|toggleAttribute)\(\s*'hidden')`;
  for (const m of INDEX.matchAll(new RegExp(String.raw`\$\('${id}'\)${show}[^\n]{0,40}`, 'g'))) out.push(m[0]);
  for (const m of INDEX.matchAll(new RegExp(String.raw`(?:const|let) (\w+) = \$\('${id}'\);`, 'g'))) {
    for (const w of enclosingFn(m.index).matchAll(new RegExp(String.raw`\b${m[1]}${show}[^\n]{0,40}`, 'g'))) out.push(`${m[1]} = $('${id}') … ${w[0]}`);
  }
  return out;
}

test('no live region in the page is hidden while it has nothing to say, and no script shows or hides one: a box that comes and goes is plain text, its words said in a region of its own (BQS; review F2.2)', () => {
  // A box hidden while it has nothing to say goes from not displayed to displayed with its words already in it. A
  // screen reader announces a live region's text as it changes, and seldom a region that appears filled: the words
  // go unsaid. Said aloud as well, from a region of their own (sayAloud), they would be heard twice by a reader that
  // does announce a box shown filled. So the box is plain text, and sayAloud says its words a frame after it shows them.
  const hidden = TAGS.filter((t) => isLive(t) && /\shidden(?:[\s>=])/.test(t)).map(idOf);
  assert.ok(hidden.every((id) => !id.startsWith('<')), `control: each hidden live region has an id: ${hidden.join(', ')}`);
  assert.deepEqual(hidden.filter((id) => !WAITING.has(id)), [],
    'no live region ships hidden but those waiting for their batch, named with why (#tmEmpty)');
  const live = [...new Set(TAGS.filter(isLive).map(idOf).filter((id) => !id.startsWith('<')))];
  assert.ok(['stopAnnounce', 'scanAnnounce', 'tmKbAnnounce', 'tmQuerySaid', 'toasts'].every((id) => live.includes(id)), `control: the page's live regions are found by their ids (${live.join(', ')})`);
  const shown = live.filter((id) => !WAITING.has(id)).flatMap((id) => hidingsOf(id).map((w) => `#${id}: ${w}`));
  assert.deepEqual(shown, [], 'nor does the script show or hide one: it would be shown already filled, as a box hidden in the markup is');
  assert.ok(hidingsOf('tmEmpty').length > 0, 'control: the check sees a live region the script shows and hides — #tmEmpty, which waits for its batch');
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

/**
 * The Fleet view's loader, skeletonRows and sayWorking lifted from the page, over Hosts: its request held until
 * answered, frames run by hand, the five-second refresh left to the test to call.
 */
function fleet() {
  const els = new Map<string, Host>();
  const $ = (id: string) => { let e = els.get(id); if (!e) { e = new Host(); els.set(id, e); } return e; };
  const frames: Array<() => void> = [];
  const held: Array<(v: unknown) => void> = [];
  const given: Record<string, unknown> = {
    $, state: { view: 'fleet', fleet: { data: null, timer: 0 } }, escapeHtml: (s: string) => s,
    MutationObserver: FakeObserver, requestAnimationFrame: (fn: () => void) => frames.push(fn), workingSaid: new Map(),
    api: (url: string) => { assert.equal(url, '/api/fleet', 'control: the Fleet view asks for the fleet'); return new Promise((r) => held.push(r)); },
    // What the view paints once it has its answer: the panel, which takes the working rows' place.
    renderFleet: () => { $('fleetBody').innerHTML = '<div class="fleet-off"><p>Seeing other TreeMaps on your network is off.</p></div>'; },
    setTimeout: () => 1, clearTimeout: () => {},
  };
  const own = new Set(['loadFleet', 'skeletonRows', 'sayWorking']);
  const scope = new Proxy(given, {
    has: (t, k) => typeof k === 'string' && k in t && !own.has(k),
    get: (t, k) => (k === Symbol.unscopables ? undefined : t[k as string]),
    set: (t, k, v) => { t[k as string] = v; return true; },
  });
  const decls = ['async function loadFleet(', 'function skeletonRows(', 'function sayWorking('];
  const load = new Function('scope', `with (scope) { ${decls.map(pageFn).join('\n')}\n return loadFleet; }`)(scope) as () => Promise<void>;
  const frame = () => { for (const fn of frames.splice(0)) fn(); };
  const answer = async (v: unknown) => { for (const r of held.splice(0)) r(v); await turns(); };
  return { $, load, frame, answer, held };
}

test('the Fleet view, looking for the first time, says so in its own region a frame after its rows are written and empties it once answered; a refresh with the answer on screen writes no rows and says nothing (review F2.1)', async () => {
  const f = fleet();
  void f.load();
  await turns();
  assert.equal(f.held.length, 1, 'control: the first look is out');
  assert.equal(f.$('fleetBody').firstElementChild?.getAttribute('aria-label'), 'Looking for TreeMaps on your network…', 'its working rows are on screen, with their sentence');
  assert.equal(f.$('fleetWorking').textContent, '', 'nothing is said before the frame');
  f.frame();
  assert.equal(f.$('fleetWorking').textContent, 'Looking for TreeMaps on your network…', 'a frame later its region says it, in its text');
  await f.answer({ enabled: false, shares: [], neverShares: [] });
  assert.equal(f.$('fleetWorking').textContent, '', 'answered: the region is emptied');
  const shown = f.$('fleetBody').innerHTML;
  f.$('fleetWorking').said.length = 0;
  void f.load(); // the refresh it makes every five seconds while the view is open
  await turns();
  f.frame();
  assert.equal(f.held.length, 1, 'control: the refresh is out');
  assert.deepEqual(f.$('fleetWorking').said, [], 'the refresh says nothing: a look every five seconds is no news');
  assert.equal(f.$('fleetBody').innerHTML, shown, 'and keeps the answer on screen: no working rows over it');
  await f.answer({ enabled: false, shares: [], neverShares: [] });
});
