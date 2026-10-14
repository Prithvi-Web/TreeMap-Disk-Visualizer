import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp, readFileSync } from 'node:fs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Loaded for its effect: a plain run of this file is guarded too (src/services/realMachineGuard.ts).
// The data folder is this file's own (tests/testDataIsolation.test.ts, OWN_DATA_DIR).
import './fixtures/dataDir';
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-search-data-'));
process.env.TREEMAP_DATA_DIR = DATA_DIR;

import { buildIndex, searchIndex, deleteIndex, openIndex, closeIndex, listRoots } from '../src/services/indexEngine';
import { parseQuery, matches, extensionOf } from '../src/utils/searchQuery';

/**
 * A4 — instant, size-aware search.
 *
 * The rule this file exists to defend: §A4 says to match the treemap's
 * existing search syntax **exactly** and not invent a second query language.
 * Two boxes that look alike and disagree about what `*.zip` means would be
 * worse than either alone, so the parity suite below drives both
 * implementations over the same cases — including reading the frontend's own
 * source, so a future edit to one and not the other fails here.
 */

const mkTmp = (): Promise<string> => fsp.mkdtemp(path.join(os.tmpdir(), 'tm-search-'));
const INDEX_HTML = readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

after(() => {
  closeIndex();
  // maxRetries: Windows briefly holds locks on just-closed SQLite WAL and
  // watcher handles, and a bare rmSync throws EBUSY into the after() hook —
  // which node:test reports as the whole FILE failing (CI, first real
  // Windows runs). Retrying is the documented cure and free elsewhere.
  fs.rmSync(DATA_DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/* ══════════════════════ Syntax parity with the treemap box ══════════════════════ */

/**
 * The frontend's rule, transcribed from `treemapMatch` in public/index.html.
 * If that function changes, `the frontend still implements exactly these three
 * rules` below fails and this transcription must be revisited.
 */
function frontendMatch(nameLower: string, extension: string, isDir: boolean, rawQuery: string): boolean {
  const q = rawQuery.trim().toLowerCase();
  if (q.startsWith('*.')) return !isDir && extension === q.slice(2);
  if (q.startsWith('.') && q.length > 1) return !isDir && extension === q.slice(1);
  return nameLower.includes(q);
}

test('the frontend still implements exactly these three rules', () => {
  // Reading the source is the only way to notice the frontend drifting: it is
  // plain JS in one HTML file, so nothing else links the two implementations.
  const fn = INDEX_HTML.slice(INDEX_HTML.indexOf('function treemapMatch('), INDEX_HTML.indexOf('function renderSearchOverlay'));
  assert.ok(fn.length > 50, 'treemapMatch was located');
  assert.match(fn, /q\.startsWith\('\*\.'\)/, 'rule 1: *.ext');
  assert.match(fn, /q\.startsWith\('\.'\) && q\.length > 1/, 'rule 2: .ext');
  assert.match(fn, /name\.toLowerCase\(\)\.includes\(q\)/, 'rule 3: name substring');
  assert.match(fn, /n\.type === 'file'/, 'extension queries are files-only');
  // And the caller lower-cases before matching, which is why the backend can
  // compare stored (already lower-case) extensions with plain equality.
  assert.match(INDEX_HTML, /state\.treemap\.query\.trim\(\)\.toLowerCase\(\)/);
});

test('backend and frontend agree on every query shape', () => {
  const corpus: { name: string; isDir: boolean }[] = [
    { name: 'holiday.zip', isDir: false },
    { name: 'Holiday.ZIP', isDir: false },
    { name: 'archive.tar.gz', isDir: false },
    { name: '.gitignore', isDir: false },
    { name: 'archive.', isDir: false },
    { name: 'noextension', isDir: false },
    { name: 'zip', isDir: false },
    { name: 'my.zip.backup', isDir: false },
    { name: 'zipped-folder', isDir: true },
    { name: 'photos.zip', isDir: true },
  ];
  const queries = ['*.zip', '.zip', 'zip', 'ZIP', 'holiday', '.gz', '*.gz', 'archive', '.', '*.', 'nothing'];

  for (const q of queries) {
    for (const entry of corpus) {
      const ext = extensionOf(entry.name);
      const expected = frontendMatch(entry.name.toLowerCase(), ext, entry.isDir, q);
      const actual = matches(parseQuery(q), entry.name, entry.isDir);
      assert.equal(
        actual,
        expected,
        `query "${q}" against ${entry.isDir ? 'dir' : 'file'} "${entry.name}" — backend said ${String(actual)}, frontend says ${String(expected)}`,
      );
    }
  }
});

test('extensionOf follows the scanner rule for dotfiles and trailing dots', () => {
  assert.equal(extensionOf('report.pdf'), 'pdf');
  assert.equal(extensionOf('archive.tar.gz'), 'gz', 'only the last segment');
  assert.equal(extensionOf('.gitignore'), '', 'a leading dot is a hidden file, not an extension');
  assert.equal(extensionOf('archive.'), '', 'a trailing dot is not an extension');
  assert.equal(extensionOf('noextension'), '');
  assert.equal(extensionOf('Report.PDF'), 'pdf', 'lower-cased');
});

/* ══════════════════════ Against a real index ══════════════════════ */

async function buildCorpus(): Promise<string> {
  const dir = await mkTmp();
  await fsp.mkdir(path.join(dir, 'media'), { recursive: true });
  await fsp.mkdir(path.join(dir, 'docs'), { recursive: true });
  await fsp.writeFile(path.join(dir, 'media', 'holiday.mp4'), Buffer.alloc(9000));
  await fsp.writeFile(path.join(dir, 'media', 'wedding.mp4'), Buffer.alloc(5000));
  await fsp.writeFile(path.join(dir, 'docs', 'holiday-plan.pdf'), Buffer.alloc(3000));
  await fsp.writeFile(path.join(dir, 'docs', 'taxes.pdf'), Buffer.alloc(1000));
  await fsp.writeFile(path.join(dir, 'backup.zip'), Buffer.alloc(7000));
  await buildIndex(dir, { live: false });
  return dir;
}

test('an extension query finds only files with that extension', async () => {
  const dir = await buildCorpus();
  try {
    const result = searchIndex('*.mp4');
    assert.equal(result.total, 2);
    assert.deepEqual(result.hits.map((h) => h.name), ['holiday.mp4', 'wedding.mp4'], 'largest first');
    assert.ok(result.hits.every((h) => h.type === 'file'));
  } finally {
    deleteIndex(dir);
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('the shorthand form means the same thing', async () => {
  const dir = await buildCorpus();
  try {
    assert.deepEqual(
      searchIndex('.mp4').hits.map((h) => h.name),
      searchIndex('*.mp4').hits.map((h) => h.name),
    );
  } finally {
    deleteIndex(dir);
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('a substring query matches the filename, not the folder path', async () => {
  // Matching the path would make every file under a "holiday" folder match
  // "holiday", drowning the file actually called that.
  const dir = await buildCorpus();
  try {
    const result = searchIndex('holiday');
    assert.equal(result.total, 2);
    assert.deepEqual(result.hits.map((h) => h.name), ['holiday.mp4', 'holiday-plan.pdf']);
  } finally {
    deleteIndex(dir);
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('results are size-descending — this is a search for disk hogs', async () => {
  const dir = await buildCorpus();
  try {
    const sizes = searchIndex('.').hits.map((h) => h.size);
    const substringHits = searchIndex('a').hits.map((h) => h.size);
    for (const list of [sizes, substringHits]) {
      assert.deepEqual(list, [...list].sort((a, b) => b - a), 'largest first');
    }
  } finally {
    deleteIndex(dir);
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('each hit carries the folder holding it, for grouping', async () => {
  const dir = await buildCorpus();
  try {
    const hit = searchIndex('wedding').hits[0];
    assert.equal(hit.parentPath, path.join(dir, 'media'));
    assert.equal(hit.rootPath, dir);
  } finally {
    deleteIndex(dir);
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('filters narrow the result without changing the ordering', async () => {
  const dir = await buildCorpus();
  try {
    assert.equal(searchIndex('.', { minSize: 6000 }).total, 2, 'only holiday.mp4 and backup.zip');
    assert.equal(searchIndex('.', { type: 'dir' }).total, 0, 'no directory has a dot in its name here');
    const scoped = searchIndex('.', { scope: path.join(dir, 'docs') });
    assert.ok(scoped.hits.every((h) => h.path.startsWith(path.join(dir, 'docs'))));
  } finally {
    deleteIndex(dir);
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('an empty query returns nothing rather than everything', async () => {
  // The search box starts empty; answering with the entire disk would be both
  // useless and expensive.
  const dir = await buildCorpus();
  try {
    for (const q of ['', '   ']) {
      const result = searchIndex(q);
      assert.equal(result.total, 0);
      assert.deepEqual(result.hits, []);
    }
  } finally {
    deleteIndex(dir);
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('LIKE wildcards in a query are literal, not patterns', async () => {
  // Searching for "100%" must not match everything, and "a_b" must not match
  // "axb". Both are ordinary characters in filenames.
  const dir = await mkTmp();
  try {
    await fsp.writeFile(path.join(dir, '100% complete.txt'), Buffer.alloc(500));
    await fsp.writeFile(path.join(dir, 'unrelated.txt'), Buffer.alloc(400));
    await fsp.writeFile(path.join(dir, 'a_b.txt'), Buffer.alloc(300));
    await fsp.writeFile(path.join(dir, 'axb.txt'), Buffer.alloc(200));
    await buildIndex(dir, { live: false });

    assert.equal(searchIndex('100%').total, 1, '% is a literal percent sign');
    assert.deepEqual(searchIndex('a_b').hits.map((h) => h.name), ['a_b.txt'], '_ is a literal underscore');
  } finally {
    deleteIndex(dir);
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('a stale index is searched, but reported as stale', async () => {
  // §A1's guard: results from an index that stopped watching may name a file
  // that has moved. Hiding them would be worse; labelling them is the answer.
  const dir = await buildCorpus();
  try {
    openIndex().prepare("UPDATE roots SET state = 'stale' WHERE path = ?").run(dir);
    const result = searchIndex('holiday');
    assert.ok(result.total > 0, 'stale results are still returned');
    assert.deepEqual(result.staleRoots, [dir], 'and flagged so the UI can say so');
  } finally {
    deleteIndex(dir);
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('searching with nothing indexed answers empty, not an error', async () => {
  deleteIndex();
  const result = searchIndex('anything');
  assert.equal(result.total, 0);
  assert.deepEqual(result.roots, []);
});

/* ══════════════════════ Nested indexed folders (fifth browser pass F08) ══════════════════════ */

/**
 * A folder and two folders inside it, each indexed — what scanning each of them leaves: every entry
 * under Mail or Deep is in two indexes, the rest in one. QA fifth pass F08: "Mailbox 03" showed two
 * identical rows (one from the outer index, one from Mail's) and /api/search counted it twice.
 *
 * `watched`: each index is built live — ready, its watcher attached, "current" — as a scan leaves it.
 * (On macOS a watch attached marks the others stale for a moment of the shared stream; they are put
 * back to ready, which their watchers keep them.) Unwatched, each is built in turn and given a build
 * time a second apart, outer first, as scans made one after another leave them.
 */
async function nestedCorpus(watched: boolean): Promise<{ dir: string; mail: string; deep: string; roots: string[] }> {
  const dir = await mkTmp();
  const mail = path.join(dir, 'Mail');
  const deep = path.join(dir, 'Deep');
  await fsp.mkdir(path.join(mail, 'Mailbox 03.mbox'), { recursive: true });
  await fsp.mkdir(path.join(mail, 'Mailbox 04.mbox'), { recursive: true });
  await fsp.mkdir(path.join(deep, 'level1'), { recursive: true });
  await fsp.writeFile(path.join(dir, 'holiday.mp4'), Buffer.alloc(9000));
  await fsp.writeFile(path.join(mail, 'Mailbox 03.mbox', 'Info.plist'), Buffer.alloc(2000));
  await fsp.writeFile(path.join(mail, 'Mailbox 04.mbox', 'Info.plist'), Buffer.alloc(1500));
  await fsp.writeFile(path.join(deep, 'level1', 'level100.txt'), Buffer.alloc(500));
  const roots = [dir, mail, deep];
  for (const root of roots) await buildIndex(root, { live: watched });
  roots.forEach((root, i) => {
    setRootState(root, 'ready');
    setBuiltAt(root, 1_000_000 + i * 1000);
  });
  if (watched) {
    const ours = listRoots().filter((r) => roots.includes(r.path));
    assert.ok(ours.length === roots.length && ours.every((r) => r.live), 'control: every index is watched');
  }
  return { dir, mail, deep, roots };
}
const setRootState = (root: string, state: 'ready' | 'stale') => {
  openIndex().prepare('UPDATE roots SET state = ? WHERE path = ?').run(state, root);
};
/** When `root`'s index was built, as the roots table records it (ms since the epoch). */
const setBuiltAt = (root: string, ms: number) => {
  openIndex().prepare('UPDATE roots SET built_at = ? WHERE path = ?').run(ms, root);
};
/** Each hit as path ← the root that answered for it. */
const answered = (q: string, opts = {}) => searchIndex(q, opts).hits.map((h) => `${h.path} ← ${h.rootPath}`);

test('a path two indexed folders hold is one row, and counted once — an index of a folder inside another index is not searched twice, watched or not (fifth browser pass F08, review F1.2)', async () => {
  for (const watched of [true, false]) {
    const { dir, mail, deep, roots } = await nestedCorpus(watched);
    const world = watched ? 'watched' : 'unwatched';
    try {
      const box3 = path.join(mail, 'Mailbox 03.mbox');
      const plists = [path.join(box3, 'Info.plist'), path.join(mail, 'Mailbox 04.mbox', 'Info.plist')];
      const cases: Array<[string, Record<string, unknown>, string[]]> = [
        ['Mailbox 03', {}, [box3]],
        ['level100', {}, [path.join(deep, 'level1', 'level100.txt')]],
        ['*.plist', {}, plists], // the extension seek
        ['Info', {}, plists], // the name scan
        ['Info', { scope: mail }, plists], // scoped to the inner folder
        ['Info', { scope: dir }, plists], // scoped to the outer one
        ['holiday', {}, [path.join(dir, 'holiday.mp4')]], // in one index only
      ];
      for (const [q, opts, want] of cases) {
        const result = searchIndex(q, opts);
        const label = `${world}, "${q}"${Object.keys(opts).length ? ' ' + JSON.stringify(opts) : ''}`;
        assert.deepEqual(result.hits.map((h) => h.path), want, `${label}: one row per path`);
        assert.equal(result.total, want.length, `${label}: counted once each`);
        assert.deepEqual([...result.roots].sort(), [...roots].sort(), `${label}: control — all three indexes were searched`);
      }
      if (watched) {
        // Both current: the outer index answers, and the inner one is left out by its id — the search walks no subtree.
        assert.deepEqual(answered('Mailbox 03'), [`${box3} ← ${dir}`], 'watched: with both indexes current, the outer one answers');
      } else {
        // Neither current: each path once, from the index built later where both hold it (review F1.2).
        assert.deepEqual(answered('Mailbox 03'), [`${box3} ← ${mail}`], 'unwatched: the index built later answers for a path both hold');
        assert.deepEqual(answered('holiday'), [`${path.join(dir, 'holiday.mp4')} ← ${dir}`], 'unwatched: and the other for a path only it holds');
      }
      // A full page counts with its own query: that count is of paths too, and the next page is the other path.
      const first = searchIndex('Info', { limit: 1 });
      const second = searchIndex('Info', { limit: 1, offset: 1 });
      assert.deepEqual([first.total, first.truncated, second.total], [2, true, 2], `${world}: a page of one: two matches, more to come`);
      assert.deepEqual([...first.hits, ...second.hits].map((h) => h.path), plists, `${world}: and the two pages hold the two paths, once each`);
    } finally {
      for (const root of roots) deleteIndex(root);
      await fsp.rm(dir, { recursive: true, force: true });
    }
  }
});

test('a path a current index and a stale one both hold is answered by the current one — whichever is the inner folder (fifth browser pass F08)', async () => {
  const { dir, mail, deep, roots } = await nestedCorpus(true);
  try {
    const box3 = path.join(mail, 'Mailbox 03.mbox');
    setRootState(mail, 'stale'); // the outer index is current, the inner one stale
    assert.deepEqual(answered('Mailbox 03'), [`${box3} ← ${dir}`], 'the outer, current index answers for the stale inner folder');
    assert.deepEqual(searchIndex('Mailbox 03').staleRoots, [mail], 'control: Mail\'s index is stale and still searched');
    setRootState(mail, 'ready');
    setRootState(dir, 'stale'); // the inner indexes are current, the outer one stale
    assert.deepEqual(answered('Mailbox 03'), [`${box3} ← ${mail}`], 'the inner, current index answers for its own folder');
    assert.deepEqual(answered('*.plist'), [
      `${path.join(box3, 'Info.plist')} ← ${mail}`, `${path.join(mail, 'Mailbox 04.mbox', 'Info.plist')} ← ${mail}`,
    ], 'every path in it, by the extension seek too');
    assert.deepEqual(answered('level100'), [`${path.join(deep, 'level1', 'level100.txt')} ← ${deep}`], 'and the other inner folder for its own');
    assert.deepEqual(answered('holiday'), [`${path.join(dir, 'holiday.mp4')} ← ${dir}`], 'a path only the stale index holds is still found, from it');
    setRootState(mail, 'stale'); // both stale: still one row, from the one built later
    assert.deepEqual(answered('Mailbox 03'), [`${box3} ← ${mail}`], 'two stale indexes holding a path answer it once, from the one built later');
  } finally {
    for (const root of roots) deleteIndex(root);
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('a file only one of two nested indexes holds is always found, once — when neither is current, as after every restart, whichever was built later (review F1.2 of fifth browser pass F08)', async () => {
  // Review F1.2: a tie in liveness (both stale — every root is, after a restart — or both ready with no
  // watcher) gave the inner folder to the outer index whole, so a file only the inner index held, made
  // after the outer index was built, was not found at all: "new.bin" answered total 0.
  const a = await mkTmp();
  const b = path.join(a, 'B');
  try {
    await fsp.mkdir(b);
    await fsp.writeFile(path.join(b, 'old.bin'), Buffer.alloc(100));
    await fsp.writeFile(path.join(b, 'removed.bin'), Buffer.alloc(150));
    await buildIndex(a, { live: false }); // A holds old.bin and removed.bin
    await fsp.rm(path.join(b, 'removed.bin'));
    await fsp.writeFile(path.join(b, 'new.bin'), Buffer.alloc(200));
    await buildIndex(b, { live: false }); // B holds old.bin and new.bin
    const states: Array<['ready' | 'stale', string]> = [['stale', 'both stale'], ['ready', 'both ready, neither watched']];
    for (const [state, what] of states) {
      for (const [aBuilt, bBuilt, later] of [[1_000_000, 2_000_000, b], [3_000_000, 2_000_000, a]] as const) {
        setRootState(a, state); setRootState(b, state);
        setBuiltAt(a, aBuilt); setBuiltAt(b, bBuilt);
        const label = `${what}, ${later === b ? 'the inner' : 'the outer'} built later`;
        assert.deepEqual(answered('new.bin'), [`${path.join(b, 'new.bin')} ← ${b}`], `${label}: a file only the inner index holds is found, from it`);
        assert.deepEqual(answered('removed.bin'), [`${path.join(b, 'removed.bin')} ← ${a}`], `${label}: one only the outer index holds is found, from it`);
        assert.deepEqual(answered('old.bin'), [`${path.join(b, 'old.bin')} ← ${later}`], `${label}: one both hold is one row, from the index built later`);
        const all = searchIndex('*.bin');
        assert.deepEqual([all.hits.map((h) => h.path).sort(), all.total], [['new.bin', 'old.bin', 'removed.bin'].map((n) => path.join(b, n)), 3],
          `${label}: every path once, counted once`);
      }
    }
  } finally {
    for (const root of [a, b]) deleteIndex(root);
    await fsp.rm(a, { recursive: true, force: true });
  }
});

test('three nested indexes: a folder the outermost one holds empty is answered by the next one that listed it, never by an index left out itself (review F1.2 of fifth browser pass F08)', async () => {
  // Review F1.2: A, B inside it and C inside B, A holding C empty. A answered for B and left B out
  // whole; B answered for C and left C out; and A had nothing under C — "needle" answered 0 hits.
  for (const watched of [true, false]) {
    const a = await mkTmp();
    const b = path.join(a, 'B');
    const c = path.join(b, 'C');
    const world = watched ? 'watched' : 'unwatched';
    try {
      await fsp.mkdir(c, { recursive: true });
      await fsp.writeFile(path.join(a, 'a-own.bin'), Buffer.alloc(100));
      await fsp.writeFile(path.join(b, 'b-own.bin'), Buffer.alloc(100));
      await buildIndex(a, { live: watched }); // A holds C empty
      await fsp.writeFile(path.join(c, 'needle.bin'), Buffer.alloc(300));
      await buildIndex(b, { live: watched });
      await buildIndex(c, { live: watched });
      [a, b, c].forEach((root, i) => { setRootState(root, 'ready'); setBuiltAt(root, 1_000_000 + i * 1000); });
      if (watched) {
        const ours = listRoots().filter((r) => [a, b, c].includes(r.path));
        assert.ok(ours.length === 3 && ours.every((r) => r.live), 'control: every index is watched');
      }
      // Watched, B and C are both current and both listed C: the outer of the two answers. Unwatched, C was built last.
      const needleFrom = watched ? b : c;
      assert.deepEqual(answered('needle'), [`${path.join(c, 'needle.bin')} ← ${needleFrom}`], `${world}: the file in C is found once, from ${path.basename(needleFrom)}`);
      const bOwnFrom = watched ? a : b;
      assert.deepEqual(answered('b-own'), [`${path.join(b, 'b-own.bin')} ← ${bOwnFrom}`], `${world}: B's own file once, from ${path.basename(bOwnFrom)}`);
      assert.deepEqual(answered('a-own'), [`${path.join(a, 'a-own.bin')} ← ${a}`], `${world}: and A's from A`);
      assert.equal(searchIndex('*.bin').total, 3, `${world}: three files, counted once each`);
    } finally {
      for (const root of [a, b, c]) deleteIndex(root);
      await fsp.rm(a, { recursive: true, force: true });
    }
  }
});

test('an inner folder the outer index never listed is still searched from its own index — the outer one does not answer for what it never saw (fifth browser pass F08)', async () => {
  const dir = await mkTmp();
  const later = path.join(dir, 'Later'); // made after the outer index was built: it holds no row for it
  const filled = path.join(dir, 'Filled'); // empty when the outer index was built: it holds the folder, nothing in it
  const hollow = path.join(dir, 'Hollow'); // empty in both indexes
  try {
    await fsp.mkdir(filled);
    await fsp.mkdir(hollow);
    await fsp.writeFile(path.join(dir, 'top.bin'), Buffer.alloc(100));
    await buildIndex(dir, { live: false });
    await fsp.mkdir(later);
    await fsp.writeFile(path.join(later, 'late-file.bin'), Buffer.alloc(300));
    await fsp.writeFile(path.join(filled, 'late-fill.bin'), Buffer.alloc(200));
    await buildIndex(later, { live: false });
    await buildIndex(filled, { live: false });
    await buildIndex(hollow, { live: false });
    [dir, later, filled, hollow].forEach((root, i) => setBuiltAt(root, 1_000_000 + i * 1000));
    assert.deepEqual(answered('late-file'), [`${path.join(later, 'late-file.bin')} ← ${later}`], 'a folder the outer index has no row for');
    assert.deepEqual(answered('late-fill'), [`${path.join(filled, 'late-fill.bin')} ← ${filled}`], 'a folder the outer index holds empty');
    assert.deepEqual(answered('Filled'), [`${filled} ← ${filled}`], 'and the folder itself is one row, from the index that listed what is in it');
    assert.deepEqual(answered('Hollow'), [`${hollow} ← ${hollow}`], 'a folder empty in both is one row, from the index built later');
  } finally {
    for (const root of [dir, later, filled, hollow]) deleteIndex(root);
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

/* ══════════════════════ The acceptance criterion ══════════════════════ */

test('500,000 files: an extension query seeks its index, a substring query scans once, and filters add no scan', async (t) => {
  // §A4 acceptance, measured rather than asserted by construction. Rows are
  // inserted directly: creating half a million real files would take far longer
  // than the query being measured and would exercise the same query path.
  deleteIndex();
  const db = openIndex();
  const N = 500_000;

  db.prepare("INSERT INTO roots (path, state, mechanism) VALUES ('/bench', 'ready', 'synthetic')").run();
  const rootId = (db.prepare("SELECT id FROM roots WHERE path = '/bench'").get() as { id: number }).id;

  const EXTS = ['zip', 'mp4', 'ts', 'js', 'png', 'pdf', 'log', 'tmp', 'iso', 'dmg'];
  const WORDS = ['report', 'holiday', 'backup', 'project', 'invoice', 'render', 'archive', 'dataset', 'sample', 'build'];
  // v3 schema: no path column, and exactly one parent_id-IS-NULL top node per
  // root — so the synthetic corpus hangs every file off a real top node, and
  // search reconstructs hit paths through it.
  const insert = db.prepare(
    'INSERT INTO nodes (root_id, parent_id, name, ext, is_dir, size, mtime, flags) VALUES (?,?,?,?,0,?,?,0)',
  );
  db.transaction(() => {
    const top = db
      .prepare("INSERT INTO nodes (root_id, parent_id, name, ext, is_dir, size, mtime, flags) VALUES (?, NULL, 'bench', '', 1, 0, ?, 0)")
      .run(rootId, Date.now());
    const topId = Number(top.lastInsertRowid);
    for (let i = 0; i < N; i++) {
      const name = `${WORDS[i % WORDS.length]}-${String(i)}.${EXTS[i % EXTS.length]}`;
      insert.run(rootId, topId, name, extensionOf(name), (i * 7919) % 5_000_000_000, Date.now());
    }
  })();

  /**
   * The query `searchIndex` would run for `q`, captured instead of run, and
   * SQLite's plan for it: the machine-independent account of the work a
   * query does. The hit query is found by its ORDER BY, and exactly one must
   * have been prepared — a rewrite of it fails here rather than planning
   * nothing. Nothing is executed, so a regression that made a query
   * quadratic fails on its plan instead of running for hours.
   */
  const planOf = (q: string, opts = {}): string[] => {
    const handle = db as unknown as { prepare: (sql: string) => unknown };
    const original = handle.prepare;
    const seen: { sql: string; args: unknown[] }[] = [];
    handle.prepare = function (this: unknown, sql: string) {
      if (!/ORDER BY n\.size DESC/.test(sql)) return original.call(this, sql);
      return { all: (...args: unknown[]) => { seen.push({ sql, args }); return []; } };
    } as typeof handle.prepare;
    try {
      searchIndex(q, opts);
    } finally {
      handle.prepare = original;
    }
    assert.equal(seen.length, 1, `searchIndex prepared one hit query for ${q}`);
    return (db.prepare(`EXPLAIN QUERY PLAN ${seen[0].sql}`).all(...seen[0].args) as { detail: string }[]).map((row) => row.detail);
  };
  const extensionPlan = planOf('*.zip');
  const substringPlan = planOf('holiday');
  const filteredPlan = planOf('backup', { minSize: 1_000_000_000 });
  const scans = (plan: string[]): string[] => plan.filter((step) => step.startsWith('SCAN'));

  // An extension query is an index seek that reads its hits already in size
  // order, so the first page costs the page: no table scan, and no sort of
  // every match (a TEMP B-TREE would be one).
  assert.deepEqual(scans(extensionPlan), [], `an extension query scanned a table — the ext index is not being used: ${extensionPlan.join(' | ')}`);
  assert.ok(extensionPlan.some((step) => /^SEARCH n USING (?:COVERING )?INDEX idx_nodes_ext \(ext=\?\)/.test(step)), `the extension query seeks idx_nodes_ext: ${extensionPlan.join(' | ')}`);
  assert.ok(!extensionPlan.some((step) => step.includes('TEMP B-TREE')), `the ext index hands hits back in size order, with nothing to sort: ${extensionPlan.join(' | ')}`);
  // A substring query is one scan of the nodes and nothing more expensive;
  // a filter narrows that scan, never adds another.
  assert.deepEqual(scans(substringPlan), ['SCAN n'], `a substring query is a single scan of the nodes: ${substringPlan.join(' | ')}`);
  assert.ok(!substringPlan.some((step) => step.includes('CORRELATED')), `no per-row subquery: ${substringPlan.join(' | ')}`);
  assert.deepEqual(scans(filteredPlan), ['SCAN n'], `filters narrow the one scan, never add one: ${filteredPlan.join(' | ')}`);
  assert.ok(!filteredPlan.some((step) => step.includes('CORRELATED')), `no per-row subquery: ${filteredPlan.join(' | ')}`);

  /**
   * For the log only: the fastest of several runs on a sub-millisecond
   * clock (`Date.now()` reports a one-millisecond query as 0, 1 or 2), the
   * sample least disturbed by everything that is not the code.
   */
  const measure = (q: string, opts = {}): number => {
    searchIndex(q, opts); // warm the page cache
    let best = Infinity;
    for (let i = 0; i < 5; i++) {
      const started = performance.now();
      searchIndex(q, opts);
      best = Math.min(best, performance.now() - started);
    }
    return best;
  };

  const extensionMs = measure('*.zip');
  const substringMs = measure('holiday');
  const filteredMs = measure('backup', { minSize: 1_000_000_000 });

  // The measured numbers are printed on every run, so a slowdown is visible
  // in the log.
  t.diagnostic(
    `500k files — extension ${extensionMs.toFixed(2)}ms, substring ${substringMs.toFixed(2)}ms, ` +
      `filtered ${filteredMs.toFixed(2)}ms (A4 target: 100ms on a quiet machine)`,
  );

  assert.ok(searchIndex('*.zip').hits.length > 0, 'the corpus is actually searchable');

  /* The figures above are reported, never asserted. A4's target is 100ms,
   * and this machine meets it comfortably — about 1ms for an extension query,
   * ~58ms for a substring scan — but an absolute wall-clock figure measures
   * the runner, not the code (the same query took 121ms with two type-checks
   * running alongside it), and even a ratio of two timings flaked on shared
   * runners. What only an algorithmic regression can change — dropping the
   * ext index, a per-row subquery, a second scan — is asserted above, on the
   * query plans. */

  deleteIndex();
});

test('a very broad match reports a capped count rather than paying for an exact one', () => {
  // An uncapped COUNT(*) is a second full scan — 17ms over 500k rows, and
  // linear from there, so at 5M it would exceed the entire latency budget on
  // its own. "5,000+" is as useful to someone hunting a file as "431,902".
  deleteIndex();
  const db = openIndex();
  db.prepare("INSERT INTO roots (path, state, mechanism) VALUES ('/many', 'ready', 'synthetic')").run();
  const rootId = (db.prepare("SELECT id FROM roots WHERE path = '/many'").get() as { id: number }).id;
  const insert = db.prepare(
    'INSERT INTO nodes (root_id, parent_id, name, ext, is_dir, size, mtime, flags) VALUES (?,?,?,?,0,?,?,0)',
  );
  db.transaction(() => {
    const top = db
      .prepare("INSERT INTO nodes (root_id, parent_id, name, ext, is_dir, size, mtime, flags) VALUES (?, NULL, 'many', '', 1, 0, ?, 0)")
      .run(rootId, Date.now());
    const topId = Number(top.lastInsertRowid);
    for (let i = 0; i < 6_000; i++) {
      insert.run(rootId, topId, `common-${String(i)}.txt`, 'txt', i, Date.now());
    }
  })();

  const broad = searchIndex('common', { limit: 10 });
  assert.equal(broad.countCapped, true, 'the count stopped at the cap');
  assert.equal(broad.total, 5_000, 'and reports the cap, which the UI shows as "5,000+"');
  assert.equal(broad.truncated, true);

  const narrow = searchIndex('common-42.txt', { limit: 10 });
  assert.equal(narrow.countCapped, false, 'a short page needs no counting query at all');
  assert.equal(narrow.total, 1, 'and its count is exact');

  deleteIndex();
});
