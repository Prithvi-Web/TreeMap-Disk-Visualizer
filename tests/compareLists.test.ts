import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-compareLists-data-');

import { INDEX } from './fixtures/liftFrontend';

/**
 * History › Compare (browser re-check C08). The Before and After lists named
 * no folder — corpus, Mail, Projects and a single file were told apart only
 * by size once a list was closed — and after new scans the lists went back to
 * the newest pair while the comparison below still described the old one.
 *
 * The page's own loadCompareOptions, cmpSyncResult and the Compare button's
 * handler run here over a stubbed server, with selects that behave as a
 * browser's do (a value that is no option reads as "").
 */

function matchingBrace(open: number): number {
  let depth = 0;
  for (let i = open; i < INDEX.length; i++) {
    if (INDEX[i] === '{') depth++;
    else if (INDEX[i] === '}' && --depth === 0) return i;
  }
  return assert.fail(`the block opening at ${open} never closes`);
}

function declOf(name: string): string {
  const m = new RegExp(`(?:async\\s+)?function ${name}\\s*\\(`).exec(INDEX);
  assert.ok(m, `function ${name} exists in the built page`);
  const open = INDEX.indexOf(') {', m!.index) + 2;
  return INDEX.slice(m!.index, matchingBrace(open) + 1);
}

/** The statement `$('cmpRunBtn').addEventListener('click', async () => {…});`. */
function runButtonSource(): string {
  const start = INDEX.indexOf("$('cmpRunBtn').addEventListener('click'");
  assert.notEqual(start, -1, 'the Compare button is wired');
  return INDEX.slice(start, matchingBrace(INDEX.indexOf('{', start)) + 1) + ');';
}

/** A <select> as a browser keeps one: its options come from innerHTML, and a value that is no option reads as "". */
function fakeSelect() {
  const sel = {
    options: [] as Array<{ value: string; text: string }>,
    chosen: '',
    disabled: false,
    listeners: {} as Record<string, () => void>,
    set innerHTML(html: string) {
      sel.options = [...html.matchAll(/<option(?: value="([^"]*)")?>([^<]*)<\/option>/g)].map((m) => ({ value: m[1] ?? m[2], text: m[2] }));
      sel.chosen = sel.options[0]?.value ?? '';
    },
    get innerHTML() { return ''; },
    get value() { return sel.chosen; },
    set value(v: string) { sel.chosen = sel.options.some((o) => o.value === v) ? v : ''; },
    addEventListener(type: string, fn: () => void) { sel.listeners[type] = fn; },
    /** A person picking an option. */
    pick(v: string) { sel.value = v; sel.listeners.change?.(); },
    textOf(v: string) { return sel.options.find((o) => o.value === v)?.text ?? ''; },
  };
  return sel;
}

interface Scan { scanId: string; rootPath: string; finishedAt: number; totalSize: number }
interface Snap { id: string; rootPath: string; takenAt: number; totalSize: number }

/** `clock`: the page's two date formatters, a minute's and a second's; by default each names the moment exactly. */
function harness(scans: Scan[], snapshots: Snap[] = [], clock: { minute: (t: number) => string; second: (t: number) => string } = { minute: (t) => `t${t}`, second: (t) => `t${t}s` }) {
  const cmpA = fakeSelect();
  const cmpB = fakeSelect();
  const body = { innerHTML: 'PROMPT' };
  const info = { textContent: '' };
  const button: { click?: () => Promise<void> } = {};
  const compared: string[] = [];
  const els: Record<string, unknown> = {
    cmpA, cmpB, cmpBody: body, cmpInfo: info,
    cmpRunBtn: { addEventListener: (_t: string, fn: () => Promise<void>) => { button.click = fn; } },
  };
  // `fail`: every comparison the server is asked for fails with this message.
  const server = { scans: [...scans], snapshots: [...snapshots], fail: null as string | null };
  const state = { root: { path: '/c/corpus' }, compare: { options: [] as unknown[], result: null as unknown } };
  const noop = () => {};
  const deps: Record<string, unknown> = {
    state, $: (id: string) => els[id] ?? assert.fail(`the compare view touched #${id}`),
    api: async (url: string) => {
      if (url === '/api/scans') return { scans: server.scans };
      if (url.startsWith('/api/snapshots?')) return { snapshots: server.snapshots };
      if (url.startsWith('/api/compare?') || url.startsWith('/api/snapshots/compare?')) {
        compared.push(url);
        if (server.fail) throw new Error(server.fail);
        if (url.startsWith('/api/compare?')) return { entries: [], totalDelta: 0, truncated: false };
        const at = (id: string | null) => ({ takenAt: server.snapshots.find((x) => x.id === id)!.takenAt });
        const q = new URLSearchParams(url.slice(url.indexOf('?') + 1));
        return { entries: [], totalDelta: 0, a: at(q.get('a')), b: at(q.get('b')) };
      }
      return assert.fail(`unexpected request ${url}`);
    },
    formatWhen: clock.minute, formatWhenSeconds: clock.second, formatBytes: (n: number) => `${n} B`, escapeHtml: (s: unknown) => String(s),
    toast: (m: string) => assert.fail(`the page reported: ${m}`), icon: () => '', REDUCED: true,
    cmpCountsDrop: noop, fxHuntBeamSync: noop, coverageRules: () => null, cmpCoverage: () => null,
    renderCompare: (r: { whenA: number; whenB: number }) => { body.innerHTML = `RESULT t${r.whenA} → t${r.whenB}`; },
  };
  const names = ['lastPathSegment', 'loadCompareOptions', 'parseCmp', ...(/function cmpSyncResult\s*\(/.test(INDEX) ? ['cmpSyncResult'] : []),
    'cmpOptionLabels'];
  const keys = Object.keys(deps);
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const page = new Function(...keys, `'use strict';\n${names.map(declOf).join('\n')}\n${runButtonSource()}\n` +
    `return { load: loadCompareOptions, sync: typeof cmpSyncResult === 'function' ? cmpSyncResult : null };`)(...keys.map((k) => deps[k])) as {
    load: () => Promise<void>; sync: (() => void) | null;
  };
  // As the page wires them (the last test pins that wiring).
  if (page.sync) { cmpA.addEventListener('change', page.sync); cmpB.addEventListener('change', page.sync); }
  return { ...page, cmpA, cmpB, body, server, compared, click: () => button.click!() };
}

const scan = (scanId: string, rootPath: string, finishedAt: number, totalSize = 1000): Scan => ({ scanId, rootPath, finishedAt, totalSize });
const snap = (id: string, rootPath: string, takenAt: number, totalSize = 1000): Snap => ({ id, rootPath, takenAt, totalSize });

test('C08: each entry in Before and After names its folder, so scans of different folders are told apart without opening the list', async () => {
  const h = harness([
    scan('s1', '/c/corpus', 100, 900_000_000), scan('s2', '/c/corpus/Mail', 200, 37_700_000),
    scan('s3', '/c/Projects', 300, 5_000_000), scan('s4', '/c/x/Installer.dmg', 400, 2_000_000_000),
  ]);
  await h.load();
  for (const [value, name] of [['scan:s1', 'corpus'], ['scan:s2', 'Mail'], ['scan:s3', 'Projects'], ['scan:s4', 'Installer.dmg']]) {
    assert.match(h.cmpA.textOf(value), new RegExp(`^${name.replace('.', '\\.')} · `), `Before names ${name}: ${h.cmpA.textOf(value)}`);
    assert.match(h.cmpB.textOf(value), new RegExp(`^${name.replace('.', '\\.')} · `), `After names ${name}`);
  }
});

test('C08: new scans do not move the lists off the pair the comparison below describes', async () => {
  const h = harness([scan('s1', '/c/corpus', 100), scan('s2', '/c/corpus', 200), scan('s3', '/c/corpus', 300)]);
  await h.load();
  assert.deepEqual([h.cmpA.value, h.cmpB.value], ['scan:s2', 'scan:s3'], 'control: the newest pair by default');
  h.cmpA.pick('scan:s1');
  h.cmpB.pick('scan:s2');
  await h.click();
  assert.equal(h.body.innerHTML, 'RESULT t100 → t200', 'control: s1 and s2 compared');

  h.server.scans.push(scan('s4', '/c/corpus', 400)); // a new scan lands
  await h.load(); // the panel reloads its lists
  assert.deepEqual([h.cmpA.value, h.cmpB.value], ['scan:s1', 'scan:s2'], 'the lists still show the pair the result is about');
  assert.equal(h.body.innerHTML, 'RESULT t100 → t200', 'and the result stays, because it still agrees with them');
});

test('C08: when a compared scan is gone from the lists, the old result goes too, rather than sitting under a pair it is not about', async () => {
  const h = harness([scan('s1', '/c/corpus', 100), scan('s2', '/c/corpus', 200), scan('s3', '/c/corpus', 300)]);
  await h.load();
  h.cmpA.pick('scan:s1');
  h.cmpB.pick('scan:s2');
  await h.click();
  h.server.scans = h.server.scans.filter((s) => s.scanId !== 's1'); // expired from memory
  await h.load();
  assert.deepEqual([h.cmpA.value, h.cmpB.value], ['scan:s2', 'scan:s3'], 'control: the lists fall back to the newest pair');
  assert.doesNotMatch(h.body.innerHTML, /RESULT/, 'the comparison of s1 and s2 is not left under s2 and s3');
  assert.match(h.body.innerHTML, /press Compare/, `and the panel says how to get one: ${h.body.innerHTML}`);
});

test('C08: picking another scan after a comparison takes the comparison down, so lists and result never disagree', async () => {
  const h = harness([scan('s1', '/c/corpus', 100), scan('s2', '/c/corpus', 200), scan('s3', '/c/corpus', 300)]);
  await h.load();
  await h.click();
  assert.equal(h.body.innerHTML, 'RESULT t200 → t300', 'control');
  h.cmpA.pick('scan:s1');
  assert.doesNotMatch(h.body.innerHTML, /RESULT/, 'the result of s2 → s3 is gone once Before says s1');
  h.cmpA.pick('scan:s2'); // back to the compared pair: nothing to bring back, nothing invented
  assert.doesNotMatch(h.body.innerHTML, /RESULT/);
});

test('C08: a comparison that lands after the picks changed is not drawn under them', async () => {
  const h = harness([scan('s1', '/c/corpus', 100), scan('s2', '/c/corpus', 200), scan('s3', '/c/corpus', 300)]);
  await h.load();
  const landing = h.click(); // s2 → s3 asked for
  h.cmpA.pick('scan:s1'); // changed while the server answers
  await landing;
  assert.doesNotMatch(h.body.innerHTML, /RESULT/, 'the answer for s2 → s3 is dropped');
});

test('C08: a history comparison that lands after the picks changed is not drawn under them either — the pair a person compares once their scans have left memory', async () => {
  const h = harness([], [snap('h1', '/c/corpus', 100), snap('h2', '/c/corpus', 200), snap('h3', '/c/corpus', 300)]);
  await h.load();
  assert.deepEqual([h.cmpA.value, h.cmpB.value], ['snap:h2', 'snap:h3'], 'control: the newest two snapshots');
  await h.click();
  assert.equal(h.body.innerHTML, 'RESULT t200 → t300', 'control: a history comparison is drawn when nothing changed');
  const landing = h.click(); // h2 → h3 asked for again
  h.cmpA.pick('snap:h1'); // changed while the server answers
  await landing;
  assert.doesNotMatch(h.body.innerHTML, /RESULT/, 'the answer for h2 → h3 is dropped');
  assert.match(h.body.innerHTML, /press Compare/, 'and the picks-changed notice stays');
});

const failureCases: Array<[string, () => ReturnType<typeof harness>, string]> = [
  ['scans', () => harness([scan('s1', '/c/corpus', 100), scan('s2', '/c/corpus', 200), scan('s3', '/c/corpus', 300)]), 'scan:s1'],
  ['history', () => harness([], [snap('h1', '/c/corpus', 100), snap('h2', '/c/corpus', 200), snap('h3', '/c/corpus', 300)]), 'snap:h1'],
];
for (const [kind, make, other] of failureCases) {
  test(`C08: a comparison of ${kind} that fails after the picks changed does not write "Compare failed" over the picks-changed notice`, async () => {
    const unchanged = make();
    await unchanged.load();
    unchanged.server.fail = 'the record is gone';
    await unchanged.click();
    assert.match(unchanged.body.innerHTML, /Compare failed: the record is gone/, 'control: a failure under the same picks is said');

    const h = make();
    await h.load();
    h.server.fail = 'the record is gone';
    const landing = h.click();
    h.cmpA.pick(other);
    await landing;
    assert.doesNotMatch(h.body.innerHTML, /Compare failed/, 'the failure of a pair no longer picked is not reported over the new picks');
    assert.match(h.body.innerHTML, /press Compare/, 'the picks-changed notice stays');
  });
}

test('C08: the lists are wired to keep the result honest when a person changes them', () => {
  assert.match(INDEX, /\$\('cmpA'\)\.addEventListener\('change', cmpSyncResult\);/);
  assert.match(INDEX, /\$\('cmpB'\)\.addEventListener\('change', cmpSyncResult\);/);
});

/* ══════════════ two scans in one minute read as two ══════════════ */

/** A minute's label and a second's, as the page's formatters resolve them — no more, so equal ones collide as they do on screen. */
const MINUTE_CLOCK = { minute: (t: number) => `m${Math.floor(t / 60_000)}`, second: (t: number) => `s${Math.floor(t / 1000)}` };
const T = 1_760_000_040_000; // a minute boundary: T … T + 59.999 s is one minute

test('two scans of a folder made in the same minute read differently in both lists — to the second, and past that by an ordinal (QA third pass)', async () => {
  // QA third pass: two scans made in the same minute both read "Scan (full
  // diff) · Oct 13, 3:30 PM · 9.5 GB" in Before and in After, and a closed
  // list shows one line — nobody could tell which one was picked.
  const GB = 9_500_000_000;
  const h = harness([
    scan('s1', '/c/corpus', T + 5_000, GB), scan('s2', '/c/corpus', T + 41_000, GB), // one minute, two seconds
    scan('s3', '/c/corpus', T + 50_100, GB), scan('s4', '/c/corpus', T + 50_700, GB), // one second
    scan('s5', '/c/corpus', T + 3_600_000, GB), // an hour later, alone in its minute
  ], [snap('h1', '/c/corpus', T + 3_600_000, GB)], MINUTE_CLOCK); // a history record of that same moment
  await h.load();
  const texts = h.cmpA.options.map((o) => o.text);
  assert.equal(new Set(texts).size, texts.length, `every pick reads differently: ${texts.join(' | ')}`);
  assert.deepEqual(h.cmpB.options.map((o) => o.text), texts, 'and After reads as Before');
  const sec = (t: number) => `s${Math.floor(t / 1000)}`;
  assert.equal(h.cmpA.textOf('scan:s1'), `corpus · Scan (full diff) · ${sec(T + 5_000)} · ${GB} B`, 'the same minute: its seconds');
  assert.equal(h.cmpA.textOf('scan:s2'), `corpus · Scan (full diff) · ${sec(T + 41_000)} · ${GB} B`);
  assert.equal(h.cmpA.textOf('scan:s3'), `corpus · Scan (full diff) · ${sec(T + 50_100)} · ${GB} B (1 of 2)`, 'the same second: in order of time');
  assert.equal(h.cmpA.textOf('scan:s4'), `corpus · Scan (full diff) · ${sec(T + 50_700)} · ${GB} B (2 of 2)`);
  assert.equal(h.cmpA.textOf('scan:s5'), `corpus · Scan (full diff) · m${Math.floor((T + 3_600_000) / 60_000)} · ${GB} B`, 'a label that is already its own keeps its minute');
  assert.equal(h.cmpA.textOf('snap:h1'), `corpus · History · m${Math.floor((T + 3_600_000) / 60_000)} · ${GB} B`, 'and so does a record of another kind at that moment');
});

test('two folders with one name, scanned in the same minute, read differently too — a closed list does not show the folder\'s path (QA third pass)', async () => {
  const h = harness([scan('a', '/c/one/Mail', T + 1_000, 100), scan('b', '/c/two/Mail', T + 2_000, 100)], [], MINUTE_CLOCK);
  await h.load();
  assert.notEqual(h.cmpA.textOf('scan:a'), h.cmpA.textOf('scan:b'), `${h.cmpA.textOf('scan:a')} | ${h.cmpA.textOf('scan:b')}`);
});

test('the comparison\'s heading names its two moments apart when they share a minute (QA third pass)', () => {
  const src = [lift(['cmpWhenPair'])].join('');
  const pair = new Function('formatWhen', 'formatWhenSeconds', `${src}\nreturn cmpWhenPair;`)(MINUTE_CLOCK.minute, MINUTE_CLOCK.second) as (a: number, b: number) => string[];
  assert.deepEqual(pair(T + 5_000, T + 41_000), [`s${Math.floor((T + 5_000) / 1000)}`, `s${Math.floor((T + 41_000) / 1000)}`], 'one minute: the seconds');
  assert.deepEqual(pair(T, T + 3_600_000), [`m${Math.floor(T / 60_000)}`, `m${Math.floor((T + 3_600_000) / 60_000)}`], 'two minutes: as before');
  assert.match(declOf('renderCompare'), /cmpWhenPair\(r\.whenA, r\.whenB\)/, 'the heading says them through it');
});

/**
 * The split view of two History snapshots, from the page's own initCmpSplit
 * and cmpSplitDraw over a stubbed /api/snapshots/tree: its footer's captions
 * and its divider's spoken position, as they read once it has drawn. The
 * stub answers as closestSnapshot does — with the stored tree nearest the
 * moment asked for, out of `stored` — or, with none given, holds a tree at
 * every moment asked for.
 */
async function splitView(whenA: number, whenB: number, stored?: number[]): Promise<{ caption: string; spoken: string }> {
  const foot = { innerHTML: '' };
  const range = {
    value: '50', attrs: {} as Record<string, string>,
    setAttribute(k: string, v: string) { range.attrs[k] = v; }, addEventListener() {},
  };
  const ctx = { setTransform() {}, fillRect() {}, strokeRect() {}, save() {}, restore() {}, beginPath() {}, rect() {}, clip() {}, fillStyle: '', strokeStyle: '' };
  const els: Record<string, unknown> = {
    cmpSplitNote: { textContent: '' }, cmpSplitCard: { hidden: false }, cmpSplitFoot: foot, cmpSplitRange: range,
    cmpSplitCanvas: { clientWidth: 200, clientHeight: 100, width: 0, height: 0, getContext: () => ctx },
  };
  const deps: Record<string, unknown> = {
    $: (id: string) => els[id] ?? assert.fail(`the split view touched #${id}`),
    api: async (url: string) => {
      const at = Number(/[?&]at=(\d+)/.exec(url)![1]);
      const nearest = stored ? stored.reduce((best, t) => (Math.abs(t - at) < Math.abs(best - at) ? t : best)) : at;
      return { snapshot: { takenAt: nearest }, nodes: [] };
    },
    formatWhen: MINUTE_CLOCK.minute, formatWhenSeconds: MINUTE_CLOCK.second,
    window: { devicePixelRatio: 1 }, cssVar: () => '', sizeColor: () => '',
  };
  const keys = Object.keys(deps);
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const init = new Function(...keys, `let cmpSplit = null; let cmpSplitSeq = 0;
    ${lift(['cmpWhenPair', 'initCmpSplit', 'cmpSplitDraw'])}
    return initCmpSplit;`)(...keys.map((k) => deps[k])) as (root: string, a: number, b: number) => Promise<void>;
  await init('/c/corpus', whenA, whenB);
  return { caption: foot.innerHTML.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(), spoken: range.attrs['aria-valuetext'] ?? '' };
}

test('the split view\'s captions and its divider\'s spoken position name two moments in one minute apart, as the heading does (review F1.3 of QA third pass)', async () => {
  // Two History snapshots 28 s apart: the heading read "3:30:12 PM → 3:30:40
  // PM", but the picture's captions both read "◀ 3:30 PM" / "3:30 PM ▶" and
  // the divider told a screen reader "left of the divider: 3:30 PM, right:
  // 3:30 PM" — nothing said which side was which moment.
  const a = T + 12_000, b = T + 40_000;
  const s = (t: number) => `s${Math.floor(t / 1000)}`, m = (t: number) => `m${Math.floor(t / 60_000)}`;
  const same = await splitView(a, b);
  assert.equal(same.caption, `◀ ${s(a)} ${s(b)} ▶`, 'one minute: the captions to the second');
  assert.equal(same.spoken, `50 percent — left of the divider: ${s(a)}, right: ${s(b)}`, 'and what the divider says');
  // Control: an hour apart, the minute tells them apart, as before.
  const apart = await splitView(T, T + 3_600_000);
  assert.equal(apart.caption, `◀ ${m(T)} ${m(T + 3_600_000)} ▶`, 'two minutes: as before');
  assert.equal(apart.spoken, `50 percent — left of the divider: ${m(T)}, right: ${m(T + 3_600_000)}`);
});

test('the split view names the two stored trees it draws, the older on the left — not the moments picked, and not in the order they were picked (review F2.4 of QA third pass: RD7, H11)', async () => {
  // The server answers each pick with the nearest STORED tree, so what the
  // canvas shows can be another moment than the one picked (H11): the
  // footer and the divider speak for the canvas. And left of the divider is
  // promised to be the older, whichever order the pair was picked in (RD7).
  // A stub that echoed the pick, called oldest-first, could tell neither
  // from the picks themselves.
  const s = (t: number) => `s${Math.floor(t / 1000)}`;
  const stored = [T + 2_000, T + 50_000];
  const [early, late] = [T + 12_000, T + 40_000]; // each nearest its own stored tree
  const shown = {
    caption: `◀ ${s(stored[0])} ${s(stored[1])} ▶`,
    spoken: `50 percent — left of the divider: ${s(stored[0])}, right: ${s(stored[1])}`,
  };
  assert.deepEqual(await splitView(early, late, stored), shown,
    'the captions and the divider name the stored trees the canvas shows, not the picks');
  assert.deepEqual(await splitView(late, early, stored), shown,
    'picked newest-first, the older is still on the left, and the divider says them in that order');
});

/** The source of named function declarations, for the heading helper. */
function lift(names: string[]): string {
  return names.map((n) => {
    assert.ok(new RegExp(`function ${n}\\s*\\(`).test(INDEX), `function ${n} exists in the built page`);
    return declOf(n);
  }).join('\n');
}
