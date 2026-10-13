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

function harness(scans: Scan[]) {
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
  const server = { scans: [...scans] };
  const state = { root: { path: '/c/corpus' }, compare: { options: [] as unknown[], result: null as unknown } };
  const noop = () => {};
  const deps: Record<string, unknown> = {
    state, $: (id: string) => els[id] ?? assert.fail(`the compare view touched #${id}`),
    api: async (url: string) => {
      if (url === '/api/scans') return { scans: server.scans };
      if (url.startsWith('/api/snapshots?')) return { snapshots: [] };
      if (url.startsWith('/api/compare?')) { compared.push(url); return { entries: [], totalDelta: 0, truncated: false }; }
      return assert.fail(`unexpected request ${url}`);
    },
    formatWhen: (t: number) => `t${t}`, formatBytes: (n: number) => `${n} B`, escapeHtml: (s: unknown) => String(s),
    toast: (m: string) => assert.fail(`the page reported: ${m}`), icon: () => '', REDUCED: true,
    cmpCountsDrop: noop, fxHuntBeamSync: noop, coverageRules: () => null, cmpCoverage: () => null,
    renderCompare: (r: { whenA: number; whenB: number }) => { body.innerHTML = `RESULT t${r.whenA} → t${r.whenB}`; },
  };
  const names = ['lastPathSegment', 'loadCompareOptions', 'parseCmp', ...(/function cmpSyncResult\s*\(/.test(INDEX) ? ['cmpSyncResult'] : [])];
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

test('C08: the lists are wired to keep the result honest when a person changes them', () => {
  assert.match(INDEX, /\$\('cmpA'\)\.addEventListener\('change', cmpSyncResult\);/);
  assert.match(INDEX, /\$\('cmpB'\)\.addEventListener\('change', cmpSyncResult\);/);
});
