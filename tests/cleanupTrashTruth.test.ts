import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Hunt group C (24 Oct 2026): what Clean Up, the cart, the Trash sheet and
 * the Undo Vault say is true. Every test runs the shipped page's own code out
 * of public/index.html against stubs, or reads the sentence it ships.
 */

const ROOT = path.join(__dirname, '..');
const INDEX = readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

/** A slice of the built page between two exact anchors. */
function slice(startAnchor: string, endAnchor: string): string {
  const start = INDEX.indexOf(startAnchor);
  assert.notEqual(start, -1, `anchor "${startAnchor}" exists in index.html`);
  const end = INDEX.indexOf(endAnchor, start + startAnchor.length);
  assert.notEqual(end, -1, `anchor "${endAnchor}" follows it`);
  return INDEX.slice(start, end);
}

/** The block of a function or listener whose header is `anchor` (it ends at the `{` that opens it). */
function blockAt(anchor: string): string {
  const at = INDEX.indexOf(anchor);
  assert.notEqual(at, -1, `"${anchor}" is in the built page`);
  const open = at + anchor.length - 1;
  assert.equal(INDEX[open], '{', `"${anchor}" ends at its block's {`);
  let depth = 0;
  for (let i = open; i < INDEX.length; i++) {
    if (INDEX[i] === '{') depth++;
    else if (INDEX[i] === '}' && --depth === 0) return INDEX.slice(at, i + 1);
  }
  throw new Error(`unbalanced block at ${anchor}`);
}

type El = { hidden: boolean; innerHTML: string; textContent: string; style: Record<string, string>; classes: Set<string>; classList: { add(c: string): void; remove(c: string): void } };
function makeEls(): { $: (id: string) => El; els: Record<string, El> } {
  const els: Record<string, El> = {};
  const $ = (id: string): El => (els[id] ||= (() => {
    const classes = new Set<string>();
    return { hidden: false, innerHTML: '', textContent: '', style: {}, classes,
      classList: { add: (c: string) => { classes.add(c); }, remove: (c: string) => { classes.delete(c); } } };
  })());
  return { $, els };
}

/** Plain text of a fragment of page HTML. */
const text = (html: string): string => html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

/* ═════════ C03/C13 — online-only files: no "safe", and what deleting one does ═════════ */

async function cloudSafeSaid(groups: Array<{ provider: string; count: number; totalSize: number; files: unknown[] }>): Promise<string> {
  const src = `${slice('function treeScanId(', '\n}\n')}\n}\n` + slice('async function renderCloudSafe', 'async function renderGrowthProjection');
  const { $, els } = makeEls();
  const noop = (): void => {};
  const fn = new Function(
    '$', 'state', 'api', 'seedNodes', 'formatCount', 'formatBytes', 'escapeHtml', 'chipFor',
    'formatDate', 'icon', 'refreshCartButtons', 'cartButtonHtml',
    `'use strict'; ${src} return renderCloudSafe;`,
  )(
    $, { scanId: 's1' },
    async () => ({ scanId: 's1', totalCount: groups.reduce((s, g) => s + g.count, 0), totalSize: groups.reduce((s, g) => s + g.totalSize, 0), groups }),
    noop, (n: number) => String(n), (n: number) => `${n} B`, (s: string) => String(s),
    () => '', () => '', () => '', noop, () => '<button>cart</button>',
  ) as () => Promise<void>;
  await fn();
  return text(els.cloudResults.innerHTML);
}

const FILE = { name: 'a.mov', path: '/u/iCloud/a.mov', size: 1000, modifiedAt: 1 };

test('the Cloud-safe tab never calls removing an online-only file safe, and says deleting one deletes it from its cloud too (C03/C13)', async () => {
  const one = await cloudSafeSaid([{ provider: 'icloud', count: 1, totalSize: 1000, files: [FILE] }]);
  assert.match(one, /a\.mov/, 'control: the rows are painted');
  assert.doesNotMatch(one, /\bsafe\b/i, `no safety claim: ${one}`);
  assert.doesNotMatch(one, /keeps the original|local copy/i, 'there is no local copy of an online-only file to remove');
  assert.match(one, /removes it from iCloud Drive too/, 'what moving one to the Trash does, said as the tooltip says it');
  assert.match(one, /almost no space on this disk/, 'and that it frees almost nothing here');
  assert.match(one, /Undo Vault/, 'and that keeping its Undo Vault copy downloads it first');

  const two = await cloudSafeSaid([
    { provider: 'icloud', count: 1, totalSize: 1000, files: [FILE] },
    { provider: 'dropbox', count: 1, totalSize: 1000, files: [{ ...FILE, path: '/u/Dropbox/b.mov', name: 'b.mov' }] },
  ]);
  assert.match(two, /removes it from the cloud service it syncs with too/, 'more than one provider: the sentence names none wrongly');
  const generic = await cloudSafeSaid([{ provider: 'cloud', count: 1, totalSize: 1000, files: [FILE] }]);
  assert.match(generic, /removes it from the cloud service it syncs with too/, 'an unnamed provider is not called "Cloud"');
});

test('the Dashboard\'s cloud row claims nothing about safety (C13)', () => {
  const row = slice('id="cloudRow"', '</div>\n          </div>');
  assert.doesNotMatch(row, /\bsafe\b/i, `the row: ${row}`);
  assert.match(text(row), /deleting one removes it from the cloud too/i);
  const openapi = readFileSync(path.join(ROOT, 'src', 'api', 'openapi.ts'), 'utf8');
  assert.doesNotMatch(openapi, /safe to remove locally/, 'nor does the API description of the same list');
});

/* ═════════ C15 — a snapshot purge is for good, and the row and the sheet say so ═════════ */

test('the Dashboard\'s snapshot row says a purge deletes them for good, and its sheet says it cannot be undone (C15)', () => {
  const load = blockAt('async function loadSnapshots() {');
  const darwin = /\$\('snapHint'\)\.textContent = platformWord\(\{\s*darwin: '([^']+)'/.exec(load)?.[1] ?? '';
  assert.notEqual(darwin, '', 'control: the Mac sentence is read');
  assert.doesNotMatch(darwin, /\bsafe\b|recreates/i, `no safety claim, and Time Machine recreates nothing it deleted: ${darwin}`);
  assert.match(darwin, /deletes them for good/);
  assert.match(darwin, /files only they still hold/, 'and what goes with them');

  const { $, els } = makeEls();
  const block = blockAt("$('snapPurgeBtn').addEventListener('click', () => {");
  const body = block.slice(block.indexOf('{') + 1, -1);
  new Function('$', 'state', 'icon', 'formatCount', 'setConfirmButton', 'purgeSnapshotsAction', 'onConfirmTrash',
    `${body}`)($, { snapshots: { snapshots: [{}, {}] } }, () => '', String, () => {}, () => {}, null);
  const sheet = text(els.confirmText.innerHTML);
  assert.match(sheet, /Delete 2 local snapshots/, `control: the sheet was drawn: ${sheet}`);
  assert.match(sheet, /This cannot be undone\./, 'the purge is permanent, and the sheet says so as Empty the Trash does');
  assert.doesNotMatch(sheet, /create fresh ones on the next backup/, 'fresh ones are not the ones deleted');
});

/** A function declaration lifted from the page, in one scope with `deps` (and `pre`, extra declarations). */
function declared<T>(header: string, deps: Record<string, unknown>, pre = ''): T {
  const keys = Object.keys(deps);
  const name = /function (\w+)\(/.exec(header)?.[1] ?? '';
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function(...keys, `${pre}\n${blockAt(header)}\nreturn ${name};`)(...keys.map((k) => deps[k])) as T;
}

/* ═════════ C29 — a saved view run as a Clean Up rule ranks and counts files only ═════════ */

test('a saved view run from Clean Up asks the server for files only, so the 500 largest and the count are files (C29)', async () => {
  const sent: Array<Record<string, unknown>> = [];
  const find = declared<(scanId: string) => Promise<{ files: unknown[]; matched: number }>>('async function findBySavedView(scanId) {', {
    selectedSavedView: () => ({ q: 'size>100mb or ext:iso' }),
    toast: () => {},
    api: async (_url: string, opts: { body: string }) => {
      sent.push(JSON.parse(opts.body));
      return { hits: [{ name: 'a.iso', path: '/a.iso', size: 9, isDir: false, mtimeMs: 1 }], total: 1, truncated: false };
    },
  });
  const out = await find('s1');
  assert.equal(out.files.length, 1, 'control: the hit came back');
  assert.equal(sent[0].q, '(size>100mb or ext:iso) type:file', 'the view, grouped as it was written, and files only');
  assert.equal(sent[0].limit, 500);
});

/* ═════════ C30 — Smart suggestions: a path inside a chosen folder is not counted again ═════════ */

test('Smart suggestions count and send a folder once, never again for paths inside it (C30)', () => {
  const rows: Record<string, unknown[]> = {
    '#smartResults .smart-ck': [{ checked: true, dataset: { g: '0', i: '0' } }],
    '#packageOrphans .pkg-ck': [],
    '#browserProfiles .bp-ck': [
      { checked: true, dataset: { path: '/h/Library/Caches/Google/Chrome/Default/Cache', bytes: '2000' } },
      { checked: true, dataset: { path: '/h/Library/Caches/Google/Chrome/Default/Code Cache', bytes: '900' } },
      { checked: true, dataset: { path: '/h/Library/Caches/Google/Chromium/Cache', bytes: '50' } },
    ],
  };
  const select = declared<() => { paths: string[]; bytes: number; sizes: Map<string, number> }>('function activeCleanSelection() {', {
    document: { querySelectorAll: (q: string) => rows[q] || [] },
    $: () => ({ checked: true }), cleanMatches: [], cleanOnDisk: new Map(), emptyFolders: [], packageOrphans: [],
    smartGroups: [{ items: [{ path: '/h/Library/Caches/Google/Chrome', size: 2900 }] }],
  }, "let cleanPane = 'smart';");
  const sel = select();
  assert.deepEqual(sel.paths, ['/h/Library/Caches/Google/Chrome', '/h/Library/Caches/Google/Chromium/Cache'],
    'the folder goes whole, with what is inside it; a sibling whose name only begins the same is its own item');
  assert.equal(sel.bytes, 2950, 'and its bytes are counted once');
  assert.deepEqual([...sel.sizes.keys()], sel.paths, 'the sizes the completion toast adds up are the same items');
  const win = declared<() => { paths: string[] }>('function activeCleanSelection() {', {
    document: { querySelectorAll: (q: string) => ({ ...rows, '#browserProfiles .bp-ck': [{ checked: true, dataset: { path: 'C:\\U\\AppData\\Mozilla\\Firefox\\Profiles\\x\\cache2', bytes: '5' } }] } as Record<string, unknown[]>)[q] || [] },
    $: () => ({ checked: true }), cleanMatches: [], cleanOnDisk: new Map(), emptyFolders: [], packageOrphans: [],
    smartGroups: [{ items: [{ path: 'C:\\U\\AppData\\Mozilla\\Firefox\\Profiles', size: 10 }] }],
  }, "let cleanPane = 'smart';")();
  assert.deepEqual(win.paths, ['C:\\U\\AppData\\Mozilla\\Firefox\\Profiles'], 'a Windows path inside a chosen folder too');
});

/* ═════════ C34 — Shrink video says what its run did, and what it never reached ═════════ */

function encodeRun(paths: string[]) {
  const { $, els } = makeEls();
  const toasts: Array<[string, string | undefined]> = [];
  let stream: { onmessage?: (ev: { data: string }) => void; close(): void } | null = null;
  class FakeES { onmessage?: (ev: { data: string }) => void; onerror?: () => void; constructor() { stream = this; } close() {} }
  const start = declared<(p: string[]) => Promise<void>>('async function startEncode(paths) {', {
    $, EventSource: FakeES, api: async () => ({ jobId: 'j1' }), toast: (m: string, k?: string) => { toasts.push([m, k]); },
    rescan: () => {}, formatBytes: (n: number) => `${n} B`, formatCount: String, escapeHtml: (s: string) => String(s), baseName: (p: string) => p.split('/').pop(),
  }, 'let videoJobStream = null;');
  return {
    async complete(ev: Record<string, unknown>) {
      await start(paths);
      stream!.onmessage!({ data: JSON.stringify({ type: 'complete', ...ev }) });
      return { said: text(els.vidProgText.innerHTML), toasts };
    },
  };
}

test('Shrink video says the originals are in the Trash only of the files it re-encoded, and names a stop and the files never reached (C34)', async () => {
  const kept = await encodeRun(['/v/a.mov', '/v/b.mov']).complete({
    results: [{ path: '/v/a.mov', ok: false, error: 'Kept the original — the new file is not smaller' }, { path: '/v/b.mov', ok: false, error: 'Kept the original — x' }],
    savedBytes: 0,
  });
  assert.doesNotMatch(kept.said, /in the Trash/, `nothing went to the Trash: ${kept.said}`);
  assert.match(kept.said, /Nothing was re-encoded/);
  assert.doesNotMatch(kept.toasts.map((t) => t[0]).join(' | '), /Re-encoded 0|empty the Trash/, 'nor does the toast say so');

  const stopped = await encodeRun(['/v/a.mov', '/v/b.mov', '/v/c.mov', '/v/d.mov', '/v/e.mov']).complete({
    results: [{ path: '/v/a.mov', ok: true, savedBytes: 5 }, { path: '/v/b.mov', ok: true, savedBytes: 5 }],
    savedBytes: 10, error: 'b.mov is open in QuickTime Player',
  });
  assert.match(stopped.said, /2 re-encoded, 10 B smaller\. The 2 originals are in the Trash until you empty it\./, `control and count: ${stopped.said}`);
  assert.match(stopped.said, /It stopped: b\.mov is open in QuickTime Player/, 'the job\'s error is said');
  assert.match(stopped.said, /3 were not reached/, 'and the files it never tried');
  assert.ok(stopped.toasts.some(([m, k]) => k === 'error' && /stopped/i.test(m)), 'the toast says it stopped too');

  const one = await encodeRun(['/v/a.mov']).complete({ results: [{ path: '/v/a.mov', ok: true, savedBytes: 5 }], savedBytes: 5 });
  assert.match(one.said, /1 re-encoded, 5 B smaller\. The original is in the Trash until you empty it\.$/, `one is "the original": ${one.said}`);
});

/* ═════════ C35 — git gc is not "safe": it prunes for good ═════════ */

test('the git gc sheet says gc deletes unreachable objects for good, and never calls it safe (C35)', () => {
  const anchor = "document.addEventListener('click', (e) => {";
  const at = INDEX.lastIndexOf(anchor, INDEX.indexOf("e.target.closest('[data-gc]')"));
  assert.notEqual(at, -1, 'control: the git gc listener is in the built page');
  const block = INDEX.slice(at, INDEX.indexOf('\n});', at) + 4);
  const { $, els } = makeEls();
  const body = block.slice(block.indexOf('{') + 1, block.lastIndexOf('}'));
  new Function('$', 'icon', 'escapeHtml', 'setConfirmButton', 'runGitGcAction', 'onConfirmTrash', 'e', body)(
    $, () => '', String, () => {}, () => {}, null,
    { target: { closest: (sel: string) => (sel === '[data-gc]' ? { getAttribute: () => '/repos/site' } : null) } });
  const sheet = text(els.confirmText.innerHTML);
  assert.match(sheet, /git gc --aggressive on site/, `control: the sheet was drawn: ${sheet}`);
  assert.doesNotMatch(sheet, /\bSafe\b|without changing any commits/i, 'no safety claim');
  assert.match(sheet, /permanently deletes/, 'what it removes');
  assert.match(sheet, /do not go to the Trash/, 'where they do not go');
  assert.match(sheet, /cannot be undone/);
});

/* ═════════ C62 — a Smart suggestions badge counts every match, and says when the list is cut ═════════ */

test('a Smart suggestions badge counts every match, not the 200 listed, and says how many are listed (C62)', () => {
  const block = blockAt('function renderSmartGroups(catalog) {');
  const badge = /<span class="size-badge num" style="color:\$\{sizeInk\(g\.totalSize\)\}">([^<]+)<\/span>/.exec(block)?.[1] ?? '';
  assert.notEqual(badge, '', 'control: the badge is read');
  const render = new Function('g', 'formatCount', 'formatBytes', 'smartListedNote', `return \`${badge}\`;`);
  const items = Array.from({ length: 200 }, (_, i) => ({ path: `/p${i}/node_modules`, size: 1 }));
  assert.equal(render({ items, count: 1800, totalSize: 61 }, String, (n: number) => `${n} B`), '1800 · 61 B', 'every match');
  assert.equal(render({ items: items.slice(0, 3), totalSize: 3 }, String, (n: number) => `${n} B`), '3 · 3 B', 'an answer with no count is its list');
  const note = declared<(g: unknown) => string>('function smartListedNote(g) {', { formatCount: String });
  assert.match(text(note({ items, count: 1800 })), /^200 of 1800 listed/, 'a cut list says it is cut');
  assert.match(text(note({ items, count: 1800 })), /Select all picks only these/, 'and what Select all picks');
  assert.equal(note({ items: items.slice(0, 3), count: 3 }), '', 'a whole list says nothing');
  assert.match(block, /\$\{smartListedNote\(g\)\}/, 'and the group shows the note');
});

/* ═════════ C73 — "could not be trashed" says why ═════════ */

test('Clean Up\'s failure toast gives the reason, not only a count (C73)', async () => {
  const toasts: Array<[string, string | undefined]> = [];
  const { $ } = makeEls();
  const run = declared<(sel: unknown, opts: unknown) => Promise<void>>('async function runCleanTrash(selection, options) {', {
    $, REDUCED: true, icon: () => '', closeModal: () => {}, rescan: () => {}, formatBytes: (n: number) => `${n} B`,
    toast: (m: string, k?: string) => { toasts.push([m, k]); },
    trashPaths: async (chunk: string[]) => ({ deleted: [], failed: chunk.map((p) => ({ path: p, reason: 'The scan behind this has expired. Scan again first.' })) }),
  }, 'let cleanTrashing = false;');
  await run({ paths: ['/a', '/b'], sizes: new Map([['/a', 1], ['/b', 1]]) }, {});
  const failure = toasts.find(([, k]) => k === 'error')?.[0] ?? '';
  assert.match(failure, /^2 could not be trashed/, `control: ${failure}`);
  assert.match(failure, /The scan behind this has expired\. Scan again first\./, 'the reason the server gave');
});
