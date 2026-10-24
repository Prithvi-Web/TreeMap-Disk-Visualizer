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

/** A function declaration of the page by its name, braces matched from its first `{`. */
function fnDecl(name: string): string {
  const at = INDEX.indexOf(`function ${name}(`);
  assert.notEqual(at, -1, `function ${name} is in the built page`);
  let depth = 0;
  for (let i = INDEX.indexOf('{', at); i < INDEX.length; i++) {
    if (INDEX[i] === '{') depth++;
    else if (INDEX[i] === '}' && --depth === 0) return INDEX.slice(at, i + 1);
  }
  throw new Error(`unbalanced function ${name}`);
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

test('the online-only files tab never calls removing an online-only file safe, and says deleting one deletes it from its cloud too (C03/C13)', async () => {
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

test('the tab that opens the online-only files is named for what they are, never "safe" (review F1.7/F1.19)', () => {
  const tab = /<button role="tab"[^>]* id="cleanTabCloud"[^>]*>(?:<span data-icon="[\w-]+"><\/span>)?([^<]+)<\/button>/.exec(INDEX)?.[1] ?? '';
  assert.notEqual(tab, '', 'control: the tab\'s label is read');
  assert.doesNotMatch(tab, /safe/i, `the label makes no safety claim over a pane that says deleting removes them from the cloud: ${tab}`);
  assert.equal(tab, 'Online-only files', 'it names what is listed, in sentence case');
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

test('a saved view whose quote is left open is closed where it ends, so grouping it does not swallow the bracket (review F1.21)', async () => {
  const sent: string[] = [];
  const findWith = (q: string) => declared<(scanId: string) => Promise<unknown>>('async function findBySavedView(scanId) {', {
    selectedSavedView: () => ({ q }), toast: () => {},
    api: async (_url: string, opts: { body: string }) => { sent.push(JSON.parse(opts.body).q); return { hits: [], total: 0, truncated: false }; },
  });
  await findWith('name:"my report')('s1');
  assert.equal(sent[0], '(name:"my report") type:file', 'the open quote closed at the end of the view, where it ends alone');
  await findWith('name:"my report" ext:pdf')('s1');
  assert.equal(sent[1], '(name:"my report" ext:pdf) type:file', 'control: a closed quote is left as written');
});

test('when the server refuses the query Clean Up built from a view, the message says the view was sent with type:file added (review F1.21)', async () => {
  const refusing = (err: Error) => declared<(scanId: string) => Promise<unknown>>('async function findBySavedView(scanId) {', {
    selectedSavedView: () => ({ q: `name:${'x'.repeat(3994)}` }), toast: () => {},
    api: async () => { throw err; },
  });
  const tooLong = Object.assign(new Error('That query is too long (4,011 characters; the limit is 4,000).'), { code: 'QUERY_PARSE_ERROR' });
  await assert.rejects(refusing(tooLong)('s1'), (e: Error & { code?: string }) => {
    assert.equal(e.message, 'Clean Up runs this view with \u201ctype:file\u201d added, to rank files only, and that query was refused: That query is too long (4,011 characters; the limit is 4,000).',
      'a view near the limit is told why a length it does not have was refused');
    assert.equal(e.code, 'QUERY_PARSE_ERROR', 'and the code is kept');
    return true;
  });
  const gone = Object.assign(new Error('The scan behind this has expired.'), { code: 'SCAN_NOT_FOUND', resultsExpired: true });
  await assert.rejects(refusing(gone)('s1'), (e: Error) => e === gone, 'control: any other failure is passed on as it came');
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
      // A sibling whose name begins with the chosen folder's whole name (review F1.17): "Chrome Beta" is not inside "Chrome".
      { checked: true, dataset: { path: '/h/Library/Caches/Google/Chrome Beta/Cache', bytes: '70' } },
    ],
  };
  const select = declared<() => { paths: string[]; bytes: number; sizes: Map<string, number> }>('function activeCleanSelection() {', {
    document: { querySelectorAll: (q: string) => rows[q] || [] },
    $: () => ({ checked: true }), cleanMatches: [], cleanOnDisk: new Map(), emptyFolders: [], packageOrphans: [],
    smartGroups: [{ items: [{ path: '/h/Library/Caches/Google/Chrome', size: 2900 }] }],
  }, "let cleanPane = 'smart';");
  const sel = select();
  assert.deepEqual(sel.paths, ['/h/Library/Caches/Google/Chrome', '/h/Library/Caches/Google/Chromium/Cache', '/h/Library/Caches/Google/Chrome Beta/Cache'],
    'the folder goes whole, with what is inside it; a sibling whose name only begins the same is its own item');
  assert.equal(sel.bytes, 3020, 'and its bytes are counted once, the sibling\'s too');
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

test('Shrink video says each original was kept only when each was; a run whose original may have left its place says nothing was replaced, and points at the list (review F1.4/F1.24)', async () => {
  const kept = await encodeRun(['/v/a.mov', '/v/b.mov']).complete({
    results: [{ path: '/v/a.mov', ok: false, error: 'Kept the original — the new file is not smaller' }, { path: '/v/b.mov', ok: false, error: 'Kept it — b.mov is a link' }],
    savedBytes: 0,
  });
  assert.ok(kept.toasts.some(([m, k]) => k === 'error' && m === 'Nothing was re-encoded — each original was kept'), `control: every original was kept: ${JSON.stringify(kept.toasts)}`);

  const moved = 'The original is in the Trash and the re-encoded file is at /v/.treemap-encode/encoded-1.mov, because it could not be renamed into place (EACCES). Nothing was lost.';
  const left = await encodeRun(['/v/a.mov', '/v/b.mov']).complete({
    results: [{ path: '/v/a.mov', ok: false, error: 'Kept the original — x' }, { path: '/v/b.mov', ok: false, error: moved }],
    savedBytes: 0,
  });
  const said = left.toasts.map((t) => t[0]).join(' | ');
  assert.doesNotMatch(said, /each original was kept/, `an original in the Trash was not kept: ${said}`);
  assert.ok(left.toasts.some(([m, k]) => k === 'error' && /Nothing was replaced — see the list for where each file is/.test(m)), `the toast points at the list: ${said}`);
  assert.doesNotMatch(left.said, /Nothing was re-encoded/, `a file was re-encoded and kept aside: ${left.said}`);
  assert.match(left.said, /^No file was replaced\. /, 'the pane says what is true of every file');
  assert.match(left.said, /b\.mov: The original is in the Trash/, 'and the row says where it is');
  const failedEncoder = await encodeRun(['/v/a.mov']).complete({ results: [{ path: '/v/a.mov', ok: false, error: 'ffmpeg exited with code 1' }], savedBytes: 0 });
  assert.doesNotMatch(failedEncoder.toasts.map((t) => t[0]).join(' | '), /each original was kept/, 'an error that does not say what became of the original claims nothing about it');
  // Nor does it say the row says where the file is (HC-L1): that row says only what went wrong.
  assert.match(failedEncoder.said, /^No file was replaced\./, `what is true of it is said: ${failedEncoder.said}`);
  assert.doesNotMatch(failedEncoder.said, /says where/, `its row does not say where the file is: ${failedEncoder.said}`);
  assert.doesNotMatch(failedEncoder.toasts.map((t) => t[0]).join(' | '), /where each file is/, 'nor does the toast');
});

test('an encoder that failed, or wrote no file, kept the original, and Shrink video says so (HC-L1)', async () => {
  const run = await encodeRun(['/v/a.mov', '/v/b.mov']).complete({
    results: [
      { path: '/v/a.mov', ok: false, error: 'Kept the original — the encoder failed (ffmpeg exited with 1).' },
      { path: '/v/b.mov', ok: false, error: 'Kept the original — the encoder produced no file.' },
    ],
    savedBytes: 0,
  });
  assert.match(run.said, /^Nothing was re-encoded\./, run.said);
  assert.ok(run.toasts.some(([m, k]) => k === 'error' && m === 'Nothing was re-encoded — each original was kept'), JSON.stringify(run.toasts));
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
  const note = declared<(g: unknown) => string>('function smartListedNote(g) {', { formatCount: String }, "let smartSort = 'size';");
  assert.match(text(note({ items, count: 1800 })), /^200 of 1800 listed/, 'a cut list says it is cut');
  assert.match(text(note({ items, count: 1800 })), /Select all picks only these/, 'and what Select all picks');
  assert.equal(note({ items: items.slice(0, 3), count: 3 }), '', 'a whole list says nothing');
  assert.match(block, /\$\{smartListedNote\(g\)\}/, 'and the group shows the note');
});

test('the cut-list note says the order the rows are in, and names Select all only where there is one (review F1.3/F1.18)', () => {
  const items = Array.from({ length: 200 }, (_, i) => ({ path: `/p${i}/node_modules`, size: 1 }));
  const noteIn = (sort: string) => declared<(g: unknown) => string>('function smartListedNote(g) {', { formatCount: String }, `let smartSort = '${sort}';`);
  const bySize = text(noteIn('size')({ items, count: 1800 }));
  assert.match(bySize, /listed, the first the scan found, largest first\./, `control: under Biggest first the rows are largest first: ${bySize}`);
  const byScore = text(noteIn('reclaim')({ items, count: 1800 }));
  assert.doesNotMatch(byScore, /largest first/, `under Safest to reclaim first they are not: ${byScore}`);
  assert.match(byScore, /listed, the first the scan found, safest to reclaim first\./, 'and the note says the order they are in');
  const advisory = text(noteIn('size')({ items, count: 1800, advisory: true }));
  assert.match(advisory, /^200 of 1800 listed/, `control: an advice-only group's list is cut too: ${advisory}`);
  assert.doesNotMatch(advisory, /Select all/, 'it has no Select all to name');
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

/* ═════════ The cart's sheet and its summary (C31, C32, C74, C78) ═════════ */

const base = (p: string): string => p.split(/[\\/]/).pop() ?? p;

function cartSummary(result: Record<string, unknown>): string {
  const { $, els } = makeEls();
  const run = declared<(r: unknown) => void>('function cartCommitSummary(result) {', {
    $, formatCount: String, formatBytes: (n: number) => `${n} B`, escapeHtml: (s: unknown) => String(s), icon: () => '', baseName: base, state: { cart: new Set() },
  }, `let confirmPaths = []; let onConfirmTrash = null;\n${fnDecl('cartSpaceSaid')}`);
  run({ trashed: [], bytesFreed: 0, runId: 'r1', ...result });
  return text(els.confirmText.innerHTML);
}

function cartSheet(plan: Record<string, unknown>): string {
  const keys = { formatCount: String, formatBytes: (n: number) => `${n} B`, escapeHtml: (s: unknown) => String(s), icon: () => '', baseName: base, state: { cart: new Set() } };
  const pre = ['cartSpaceSaid', 'installedProgramWarningHtml', 'installedProgramWords', 'installedProgramRemoval']
    .filter((n) => INDEX.includes(`function ${n}(`)).map(fnDecl).join('\n');
  const sheet = declared<(p: unknown, missing: number) => string>('function cartManifestHtml(plan, missingFromScan) {', keys, pre);
  return text(sheet({ bytesWouldFree: 0, bytesSkipped: 0, evicts: [], batches: 1, capsule: { available: true }, openHandles: { checked: true, complete: true, conflicts: [] }, ...plan }, 0));
}

test('an item the Trash refused is reported once, as not moved, never also as "left in place" (C31)', () => {
  const said = cartSummary({
    trashed: ['/c/a.bin'], bytesFreed: 5,
    skipped: [{ path: '/c/held.txt', code: 'NOT_DELETED', reason: 'TreeMap did not hand it to the Trash: Chrome has it open.' }],
    failedToTrash: [{ path: '/c/held.txt', reason: 'Chrome has it open' }],
  });
  assert.match(said, /1 could not be moved to the Trash\. It is untouched, its copy was discarded, and it is still in your cart: held\.txt Chrome has it open/, `control: ${said}`);
  assert.doesNotMatch(said, /left in place/, 'the same item is not reported a second time');
  const both = cartSummary({
    skipped: [{ path: '/c/big.iso', code: 'CAPSULE_FULL', reason: 'Too big for the Undo Vault.' }, { path: '/c/held.txt', code: 'NOT_DELETED', reason: 'x' }],
    failedToTrash: [{ path: '/c/held.txt', reason: 'Chrome has it open' }],
  });
  assert.match(both, /1 left in place/, 'an item only left in place is still reported');
  assert.match(both, /big\.iso/);
});

test('the cart\'s sheet counts the staged items open in another program, not the open files, and says "programs" when there are several (C32)', () => {
  const going = (paths: string[]) => paths.map((p) => ({ path: p, bytes: 1, willDelete: true }));
  const one = cartSheet({ items: going(['/c/project']), openHandles: { checked: true, complete: true, conflicts: [
    { path: '/c/project', pid: 7, processName: 'Code', openPath: '/c/project/a.ts' },
    { path: '/c/project', pid: 7, processName: 'Code', openPath: '/c/project/b.ts' },
    { path: '/c/project', pid: 7, processName: 'Code', openPath: '/c/project/c.ts' },
  ] } });
  assert.match(one, /It is open in another program right now, which will stop the move\./, `one item, three open files in one program: ${one}`);
  assert.doesNotMatch(one, /3 of these/);
  const two = cartSheet({ items: going(['/c/project', '/c/notes.txt', '/c/z.bin']), openHandles: { checked: true, complete: true, conflicts: [
    { path: '/c/project', pid: 7, processName: 'Code', openPath: '/c/project/a.ts' },
    { path: '/c/project', pid: 7, processName: 'Code', openPath: '/c/project/b.ts' },
    { path: '/c/notes.txt', pid: 9, processName: 'TextEdit', openPath: '/c/notes.txt' },
  ] } });
  assert.match(two, /2 of these are open in other programs right now, which will stop the whole batch\./, two);
  const shared = cartSheet({ items: going(['/c/notes.txt']), openHandles: { checked: true, complete: true, conflicts: [
    { path: '/c/notes.txt', pid: 9, processName: 'TextEdit', openPath: '/c/notes.txt' },
    { path: '/c/notes.txt', pid: 11, processName: 'Preview', openPath: '/c/notes.txt' },
  ] } });
  assert.match(shared, /It is open in other programs right now, which will stop the move\./, shared);
});

test('an item already gone is said to be gone, never "still on your disk", in the sheet and in the summary (C74)', () => {
  const GONE = 'It is no longer there — nothing to delete.';
  const said = cartSummary({
    trashed: ['/c/a.bin'], bytesFreed: 5,
    skipped: [{ path: '/c/gone.bin', code: 'ITEM_GONE', reason: GONE }, { path: '/c/big.iso', code: 'CAPSULE_FULL', reason: 'Too big.' }],
  });
  assert.match(said, /1 left in place — still on your disk, not deleted, and still in your cart: big\.iso/, `control: ${said}`);
  assert.match(said, /1 already gone — nothing to delete, and taken out of your cart: gone\.bin/, 'the gone item, apart');
  const only = cartSummary({ skipped: [{ path: '/c/gone.bin', code: 'ITEM_GONE', reason: GONE }] });
  assert.doesNotMatch(only, /still on your disk/, `a gone item is not on the disk: ${only}`);

  const sheet = cartSheet({ items: [{ path: '/c/a.bin', bytes: 5, willDelete: true }, { path: '/c/gone.bin', bytes: null, willDelete: false, code: 'ITEM_GONE', reason: GONE }] });
  assert.match(sheet, /1 already gone — nothing to delete: gone\.bin/, `the sheet says it before the commit: ${sheet}`);
  assert.doesNotMatch(sheet, /left in place/, 'and does not call it left in place');
});

test('with the Undo Vault off, the cart\'s sheet says why once, not again on every row (C78)', () => {
  const WHY = 'This portable session saves nothing, so there is nowhere to keep a recoverable copy. Deletions still go to the system Trash.';
  const items = Array.from({ length: 9 }, (_, i) => ({ path: `/c/f${i}.bin`, bytes: 1, willDelete: false, code: 'CAPSULE_UNAVAILABLE', reason: WHY }));
  const sheet = cartSheet({ items, capsule: { available: false, reason: WHY } });
  assert.match(sheet, /9 will be left in place/, `control: ${sheet}`);
  assert.match(sheet, /f0\.bin/, 'the rows are still named');
  assert.equal(sheet.split('This portable session saves nothing').length - 1, 1, `the reason is said once: ${sheet}`);
  const mixed = cartSheet({ items: [...items.slice(0, 1), { path: '/c/odd.bin', bytes: 1, willDelete: false, code: 'CAPSULE_UNREADABLE', reason: 'It could not be read.' }], capsule: { available: false, reason: WHY } });
  assert.match(mixed, /odd\.bin It could not be read\./, 'a row with a reason of its own keeps it');
});

test('a commit takes an item already gone out of the cart, as it does what went to the Trash (C74)', async () => {
  const cart = new Set(['/c/a.bin', '/c/gone.bin', '/c/gone2.bin', '/c/big.iso']);
  const { $ } = makeEls();
  const run = declared<(paths: string[], foreseen: unknown[]) => Promise<void>>('async function cartExecuteCommit(paths, foreseen = []) {', {
    $, state: { cart }, icon: () => '', REDUCED: true, formatCount: String, CART_COMMIT_CHUNK: 100, cartCommitKey: 'k', CART_PAGE: 50,
    api: async () => ({ runId: 'r1', trashed: ['/c/a.bin'], bytesFreed: 5, skipped: [{ path: '/c/gone.bin', code: 'ITEM_GONE', reason: 'It is no longer there — nothing to delete.' }], failedToTrash: [], unverified: [] }),
    toast: () => {}, saveCart: () => {}, renderCart: () => {}, refreshCartButtons: () => {}, cartCommitSummary: () => {}, rescan: () => {},
    tmIsInside: (p: string, dir: string) => p.startsWith(dir + '/'),
  }, `let cartLastRun = null; let cartShown = 0;\n${blockAt('function cartDropTrashed(trashed) {')}`);
  await run(['/c/a.bin', '/c/gone.bin'], [{ path: '/c/gone2.bin', code: 'ITEM_GONE', reason: 'It is no longer there — nothing to delete.' }, { path: '/c/big.iso', code: 'CAPSULE_FULL', reason: 'Too big.' }]);
  assert.deepEqual([...cart], ['/c/big.iso'], 'what went and what was already gone leave the cart; what was left in place stays');
});

test('each item the Trash refused is named, with its own reason (review F1.23)', () => {
  const said = cartSummary({
    trashed: ['/c/ok.bin'], bytesFreed: 5,
    skipped: [
      { path: '/c/a.bin', code: 'NOT_DELETED', reason: 'x' }, { path: '/c/b.bin', code: 'NOT_DELETED', reason: 'y' },
      { path: '/c/big.iso', code: 'CAPSULE_FULL', reason: 'Too big.' },
    ],
    failedToTrash: [{ path: '/c/a.bin', reason: 'Chrome has it open' }, { path: '/c/b.bin', reason: 'Permission denied' }],
  });
  assert.match(said, /2 could not be moved to the Trash\. Those are untouched, their copies were discarded, and they are still in your cart: a\.bin Chrome has it open b\.bin Permission denied/,
    `each by name, each with its own reason: ${said}`);
  assert.match(said, /1 left in place .*big\.iso Too big\./, 'control: the item only left in place, apart');
  const many = cartSummary({ failedToTrash: Array.from({ length: 8 }, (_, i) => ({ path: `/c/f${i}.bin`, reason: 'in use' })) });
  assert.match(many, /f5\.bin in use …and 2 more/, `a long list is cut as the others are: ${many}`);
  assert.doesNotMatch(many, /f6\.bin/);
});

test('the cart counts the programs holding staged items by name: two processes of one program are one program (review F1.11)', () => {
  const item = [{ path: '/c/node_modules', bytes: 1, willDelete: true }];
  const conflict = (pid: number, processName?: string) => ({ path: '/c/node_modules', pid, ...(processName ? { processName } : {}), openPath: `/c/node_modules/${pid}.js` });
  const oneProgram = cartSheet({ items: item, openHandles: { checked: true, complete: true, conflicts: [conflict(101, 'node'), conflict(102, 'node')] } });
  assert.match(oneProgram, /It is open in another program right now, which will stop the move\./, `a dev server and its worker are one program: ${oneProgram}`);
  const unnamed = cartSheet({ items: item, openHandles: { checked: true, complete: true, conflicts: [conflict(101), conflict(102)] } });
  assert.match(unnamed, /It is open in other programs right now/, `with no name, processes are told apart by their ids: ${unnamed}`);
});

test('a cart whose every item is already gone takes it out when the sheet says so, so the next press does not repeat it (review F1.22)', async () => {
  const GONE = 'It is no longer there — nothing to delete.';
  const cart = new Set(['/c/a.bin', '/c/big.iso']);
  let saves = 0;
  const { $, els } = makeEls();
  const trashAll = declared<() => Promise<void>>('async function cartTrashAll() {', {
    $, state: { cart }, ensureNodes: async () => {}, cartKnownPaths: () => [...cart], outermostPaths: (p: string[]) => p,
    icon: () => '', REDUCED: true, formatCount: String, toast: () => {}, resetOpenHandleWarning: () => {},
    cartDryRun: async () => ({ items: [{ path: '/c/a.bin', willDelete: false, code: 'ITEM_GONE', reason: GONE }, { path: '/c/big.iso', willDelete: false, code: 'CAPSULE_FULL', reason: 'Too big.' }] }),
    cartManifestHtml: () => 'manifest', cartExecuteCommit: async () => assert.fail('nothing to commit'),
    saveCart: () => { saves++; }, renderCart: () => {}, refreshCartButtons: () => {},
    tmIsInside: (p: string, dir: string) => p.startsWith(dir + '/'),
  }, `let confirmPaths = []; let onConfirmTrash = null; let cartCommitKey = '';\n${blockAt('function cartDropTrashed(trashed) {')}`);
  await trashAll();
  assert.match(els.confirmOk.innerHTML, /Close/, 'control: nothing can be moved, so the sheet only reports');
  assert.deepEqual([...cart], ['/c/big.iso'], 'the item already gone leaves the cart; the one left in place stays');
  assert.ok(saves > 0, 'and the cart is saved without it');
  assert.match(text(els.confirmText.innerHTML), /The item already gone was taken out of your cart\./, 'the sheet says so');
});

/* ═════════ C75 — an undo that stops part-way says what it put back, and the map catches up ═════════ */

test('an undo that stops part-way says how many it put back and rescans; one that put back none does neither (C75)', async () => {
  type Watched = { onSettled: (ev?: Record<string, unknown>) => void };
  const seen: { opts?: Watched } = {};
  const toasts: string[] = [];
  let rescans = 0;
  const undo = declared<(runId: string) => Promise<void>>('async function cartUndoRun(runId) {', {
    api: async () => ({ jobId: 'j1', entryCount: 5 }), closeModal: () => {}, toast: (m: string) => { toasts.push(m); },
    watchJob: (o: Watched) => { seen.opts = o; }, renderCart: () => {}, refreshCartButtons: () => {}, formatCount: String,
    rescan: () => { rescans++; }, passedOverToast: () => '',
  }, 'let cartLastRun = null;');
  await undo('r1');
  const opts = seen.opts;
  assert.ok(opts, 'control: the job is watched');
  opts.onSettled({ type: 'error', message: 'The disk stopped answering.', entriesDone: 3, entryCount: 5 });
  assert.ok(toasts.some((m) => /3 of the 5 items were put back before the undo stopped/.test(m)), `what came back is said: ${toasts.join(' | ')}`);
  assert.equal(rescans, 1, 'and the map is scanned again, as after a whole undo');
  toasts.length = 0;
  opts.onSettled({ type: 'cancelled', entriesDone: 1, entryCount: 5 });
  assert.ok(toasts.some((m) => /^1 of the 5 items was put back before the undo stopped/.test(m)), `one is "was": ${toasts.join(' | ')}`);
  assert.equal(rescans, 2, 'control: and rescanned');
  toasts.length = 0;
  opts.onSettled({ type: 'cancelled', entriesDone: 0, entryCount: 5 });
  opts.onSettled({ type: 'cancelled' });
  assert.deepEqual(toasts, [], 'nothing put back, nothing said');
  assert.equal(rescans, 2, 'and nothing rescanned');
});

test('the progress dialog hands a stopped job\'s event to the page that asked (C75)', () => {
  const { $ } = makeEls();
  let es: { onmessage?: (m: { data: string }) => void } | null = null;
  class FakeES { onmessage?: (m: { data: string }) => void; onerror?: () => void; readyState = 1; constructor() { es = this; } close() {} }
  const settled: unknown[] = [];
  const watch = declared<(o: unknown) => void>('function watchJob(opts) {', {
    $, icon: () => '', EventSource: Object.assign(FakeES, { CLOSED: 2 }), OFFLOAD_PHASE_LABEL: { checking: 'Checking' }, closeModal: () => {},
    FxBeam: { attach: () => {} }, toast: () => {}, formatCount: String, formatBytes: String,
  }, 'let activeJob = null;');
  const opts = { title: 't', footNote: '', progressUrl: '/p', cancelUrl: '/c', cancelledMessage: 'Cancelled', lostMessage: 'Lost', onComplete: () => {}, onSettled: (ev: unknown) => { settled.push(ev); } };
  for (const ev of [{ type: 'error', message: 'x', entriesDone: 2, entryCount: 4 }, { type: 'cancelled', entriesDone: 1, entryCount: 4 }]) {
    watch(opts);
    es!.onmessage!({ data: JSON.stringify(ev) });
  }
  assert.deepEqual(settled, [{ type: 'error', message: 'x', entriesDone: 2, entryCount: 4 }, { type: 'cancelled', entriesDone: 1, entryCount: 4 }]);
});

/* ═════════ C33/C60 — "Moved N items to Trash — X" counts what moved, once ═════════ */

async function trashToast(paths: string[], answer: (chunk: string[]) => Promise<unknown>, sizes: Record<string, number>): Promise<string[]> {
  const toasts: string[] = [];
  const run = declared<(p: string[], o?: unknown) => Promise<unknown>>('async function trashPaths(paths, { silent = false, ignoreOpenHandles = false, onlyEmptyFolders = false, ignoreJunk = true } = {}) {', {
    TRASH_CHUNK: 2, ensureNodes: async () => {}, nodeFor: (p: string) => (p in sizes ? { size: sizes[p] } : null),
    apiPaced: async (_u: string, o: { body: string }) => answer(JSON.parse(o.body).paths), toast: (m: string) => { toasts.push(m); },
    formatBytes: (n: number) => `${n} B`, rescan: () => {}, reofferBlockedTrash: () => {},
  });
  await run(paths);
  return toasts;
}

test('the shared Trash toast adds up what moved, not what was asked, and a file inside a moved folder once (C33/C60)', async () => {
  const sizes = { '/s/a': 1000, '/s/b': 1000, '/s/c': 1000, '/s/d': 1000, '/s/e': 1000 };
  const oneGone = await trashToast(Object.keys(sizes), async (chunk) => ({
    deleted: chunk.filter((p) => p !== '/s/e'), failed: chunk.filter((p) => p === '/s/e').map((p) => ({ path: p, reason: 'It is no longer there.' })),
  }), sizes);
  assert.ok(oneGone.includes('Moved 4 items to Trash — 4000 B'), `what moved: ${oneGone.join(' | ')}`);

  const blocked = await trashToast(['/s/a', '/s/b', '/s/c'], async (chunk) => {
    if (chunk.includes('/s/c')) throw Object.assign(new Error('open'), { code: 'OPEN_HANDLE_CONFLICT' });
    return { deleted: chunk, failed: [] };
  }, sizes);
  assert.ok(blocked.includes('Moved 2 items to Trash — 2000 B'), `a refused chunk is not counted: ${blocked.join(' | ')}`);

  const nested = await trashToast(['/s/f', '/s/f/x.bin', '/s/fx'], async (chunk) => ({ deleted: chunk, failed: [] }), { '/s/f': 5000, '/s/f/x.bin': 3000, '/s/fx': 700 });
  assert.ok(nested.includes('Moved 3 items to Trash — 5700 B'),
    `a file inside a folder that moved is in its size already; a sibling whose name only begins the same is not (review F1.17): ${nested.join(' | ')}`);
});

/* ═════════ C77 — the Trash sheet says when its list is cut ═════════ */

test('the Trash sheet says how many items it does not list, under a header that counts them all (C77)', () => {
  const { $, els } = makeEls();
  const open = declared<() => void>('function openTrashModal() {', {
    $, chipFor: () => '', escapeHtml: (s: unknown) => String(s), icon: () => '', formatBytes: (n: number) => `${n} B`, formatCount: String,
    state: { trash: { complete: true, totalBytes: 9000, itemCount: 1200, items: Array.from({ length: 500 }, (_, i) => ({ name: `f${i}.bin`, size: 1 })) } },
  });
  open();
  const body = text(els.trashModalBody.innerHTML);
  assert.match(text(els.trashModalMeta.textContent), /1200 items/, 'control: the header counts every item');
  assert.match(body, /f499\.bin/, 'control: the 500 listed');
  assert.match(body, /…and 700 more items, not listed here/, `the rest are said: ${body.slice(-120)}`);
  const whole = makeEls();
  declared<() => void>('function openTrashModal() {', {
    $: whole.$, chipFor: () => '', escapeHtml: (s: unknown) => String(s), icon: () => '', formatBytes: (n: number) => `${n} B`, formatCount: String,
    state: { trash: { complete: true, totalBytes: 2, itemCount: 2, items: [{ name: 'a', size: 1 }, { name: 'b', size: 1 }] } },
  })();
  assert.doesNotMatch(text(whole.els.trashModalBody.innerHTML), /not listed/, 'a whole list says nothing more');
});

/* ═════════ C92 — an unknown last-opened date is never "never opened" ═════════ */

async function provenanceSaid(data: Record<string, unknown>): Promise<string> {
  const { $, els } = makeEls();
  (els as Record<string, unknown>).pvOrigin = { hidden: true, innerHTML: '', querySelector: () => null };
  const load = declared<(p: string, id: number) => Promise<void>>('async function loadProvenance(filePath, reqId) {', {
    $, api: async () => data, escapeHtml: (s: unknown) => String(s), formatDate: () => 'Oct 2, 2026', icon: () => '',
    platformWord: (w: { darwin: string }) => w.darwin,
  }, 'let pvReqId = 1;');
  await load('/x/a.zip', 1);
  return text(((els as Record<string, unknown>).pvOrigin as { innerHTML: string }).innerHTML);
}

test('the preview pane says a last-opened date is not known, with why, rather than "never opened" (C92)', async () => {
  const unknown = await provenanceSaid({ supported: true, found: false, absentReason: 'Nothing was recorded.', lastOpenedAt: null, lastOpenedUnknown: 'This computer does not record when files are opened.' });
  assert.doesNotMatch(unknown, /never opened/i, `unknown is not never: ${unknown}`);
  assert.match(unknown, /When it was last opened is not known\. This computer does not record when files are opened\./);
  const never = await provenanceSaid({ supported: true, found: false, absentReason: 'Nothing was recorded.', lastOpenedAt: null });
  assert.match(never, /Never opened since it was saved, as far as this Mac records\./, 'control: where openings are recorded, the old sentence stands');
});
