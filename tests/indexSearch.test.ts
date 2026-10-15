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

test('two nested indexes, neither current — as every root is after a restart: a search reads what it matches, never the inner folder whole (review F2.1 of fifth browser pass F08)', (t) => {
  // Review F2.1: review F1.2 kept each path once by walking the inner folder in the index built
  // earlier in step with the one built later — a recursive walk SQLite built in full before the
  // first row, on every search, whatever the search matched: 0.5 s a search at 100,000 files an
  // index and about 5 s at the 1,000,000-entry cap, the server blocked throughout. Rows are
  // inserted directly, as above; the question is the work, and the plans and counts answer it.
  deleteIndex();
  const db = openIndex();
  const DIRS = 200;
  const FILES = 500; // 100,000 files in each index
  const COUNT_CAP = 5_000; // SEARCH_COUNT_CAP: a full page counts this many matches at most
  const rootAt = (p: string, builtAt: number) => {
    db.prepare("INSERT INTO roots (path, state, mechanism, built_at) VALUES (?, 'stale', 'synthetic', ?)").run(p, builtAt);
    const id = (db.prepare('SELECT id FROM roots WHERE path = ?').get(p) as { id: number }).id;
    return { id, top: add(id, null, path.basename(p), true, 0) };
  };
  const insert = db.prepare('INSERT INTO nodes (root_id, parent_id, name, ext, is_dir, size, mtime, flags) VALUES (?,?,?,?,?,?,1,0)');
  const add = (root: number, parent: number | null, name: string, dir: boolean, size: number): number =>
    Number(insert.run(root, parent, name, dir ? '' : extensionOf(name), dir ? 1 : 0, size).lastInsertRowid);
  // Spelled the platform's way (review F3.1): the engine joins and splits paths on path.sep, so a literal
  // '/nest/inner' is not inside '/nest' on the Windows CI leg, and every path came back twice there.
  const NEST = path.resolve(path.sep, 'nest');
  const INNER = path.join(NEST, 'inner');
  const outer = rootAt(NEST, 1_000_000);
  const inner = rootAt(INNER, 2_000_000); // built later: it answers for a path both hold
  db.transaction(() => {
    const outerAtInner = add(outer.id, outer.top, 'inner', true, 0);
    for (let d = 0; d < DIRS; d++) {
      const o = add(outer.id, outerAtInner, `dir${d}`, true, 0);
      const i = add(inner.id, inner.top, `dir${d}`, true, 0);
      for (let f = 0; f < FILES; f++) {
        add(outer.id, o, `file${f}.dat`, false, d * FILES + f);
        add(inner.id, i, `file${f}.dat`, false, d * FILES + f);
      }
    }
    add(outer.id, outerAtInner, 'only-outer.bin', false, 7); // gone from the folder since the outer build
    add(inner.id, inner.top, 'only-inner.bin', false, 7); // made after it
  })();
  assert.deepEqual(listRoots().map((r) => [r.path, r.state, r.live]), [[NEST, 'stale', false], [INNER, 'stale', false]],
    'control: two nested indexes, neither current');

  /** Searches `q`, counting every row any statement reads while it does, and keeping the hit query and its arguments. */
  const work = (q: string, opts = {}) => {
    const handle = db as unknown as { prepare: (sql: string) => unknown };
    const original = handle.prepare;
    let rows = 0;
    let hit: { sql: string; args: unknown[] } | null = null;
    handle.prepare = function (this: unknown, sql: string) {
      const stmt = original.call(this, sql) as Record<string | symbol, unknown>;
      const isHit = /ORDER BY n\.size DESC/.test(sql);
      return new Proxy(stmt, {
        get(target, key) {
          const f = target[key];
          if (typeof f !== 'function') return f;
          if (key === 'get') return (...a: unknown[]) => { const row = f.apply(target, a); if (row !== undefined) rows++; return row; };
          if (key === 'all') return (...a: unknown[]) => { if (isHit) hit = { sql, args: a }; const all = f.apply(target, a) as unknown[]; rows += all.length; return all; };
          if (key === 'iterate') {
            return function* (...a: unknown[]) {
              if (isHit) hit = { sql, args: a };
              for (const row of f.apply(target, a) as Iterable<unknown>) { rows++; yield row; }
            };
          }
          return f.bind(target);
        },
      });
    } as typeof handle.prepare;
    try {
      const result = searchIndex(q, opts);
      assert.ok(hit, `control: "${q}" ran one hit query`);
      return { result, rows, hit: hit as { sql: string; args: unknown[] } };
    } finally {
      handle.prepare = original;
    }
  };
  const planOf = (hit: { sql: string; args: unknown[] }): string[] =>
    (db.prepare(`EXPLAIN QUERY PLAN ${hit.sql}`).all(...hit.args) as { detail: string }[]).map((row) => row.detail);
  const scans = (plan: string[]): string[] => plan.filter((step) => step.startsWith('SCAN'));

  const ext = work('*.dat', { limit: 50 }); // the extension seek: 200,000 rows match, 100,000 paths
  const name = work('file7.dat', { limit: 50 }); // the name scan: one file in each folder, in both indexes
  const only = work('only-'); // a path only one index holds, in each
  const none = work('zzz'); // nothing

  // The answers: each path once, the one built later answering where both hold it.
  assert.equal(new Set(ext.result.hits.map((h) => h.path)).size, 50, 'the extension seek: a page of 50 paths, each once');
  assert.deepEqual([ext.result.hits[0].path, ext.result.hits[0].rootPath], [path.join(INNER, `dir${DIRS - 1}`, `file${FILES - 1}.dat`), INNER],
    'the biggest first, from the index built later');
  assert.deepEqual([ext.result.total, ext.result.countCapped], [COUNT_CAP, true], 'and counted to the cap');
  assert.deepEqual([new Set(name.result.hits.map((h) => h.path)).size, name.result.total, name.result.countCapped], [50, DIRS, false],
    'the name scan: a page of 50 paths, and the folders\' 200 counted once each');
  assert.deepEqual(only.result.hits.map((h) => `${h.path} ← ${h.rootPath}`).sort(), [`${path.join(INNER, 'only-inner.bin')} ← ${INNER}`, `${path.join(INNER, 'only-outer.bin')} ← ${NEST}`],
    'a path only one index holds is found, from it');
  assert.equal(none.result.total, 0, 'control: "zzz" matches nothing');

  // No walk is built before the first row: the plans are the ones a single index gets (above).
  for (const [label, run] of [['the extension seek', ext], ['the name scan', name], ['a name nothing matches', none]] as const) {
    const plan = planOf(run.hit);
    assert.ok(!plan.some((step) => /RECURSIVE|MATERIALIZE/.test(step)), `${label}: the hit query walks no tree before its first row: ${plan.join(' | ')}`);
  }
  const extPlan = planOf(ext.hit);
  assert.deepEqual(scans(extPlan), [], `the extension seek scans nothing: ${extPlan.join(' | ')}`);
  assert.ok(!extPlan.some((step) => step.includes('TEMP B-TREE')), `it reads in size order, with nothing to sort: ${extPlan.join(' | ')}`);
  const namePlan = planOf(name.hit);
  assert.deepEqual(scans(namePlan), ['SCAN n'], `the name scan is one scan of the nodes: ${namePlan.join(' | ')}`);

  // And what is read to keep each path once is a few rows for each row the search matches, never the
  // folder: a search with two matches, or none, reads less than a row for each folder of the inner
  // index; the name scan, a few for each of its 400 matches; the extension seek stops where its count does.
  assert.ok(only.rows < DIRS && none.rows < DIRS,
    `a search with two matches read ${only.rows} rows, one that matches nothing ${none.rows}: fewer than the inner index's ${DIRS} folders`);
  assert.ok(name.rows <= 4 * 2 * DIRS, `the name scan read ${name.rows} rows for its ${2 * DIRS} matches`);
  assert.ok(ext.rows <= 4 * COUNT_CAP, `the extension seek read ${ext.rows} rows for a page of 50 and a count to ${COUNT_CAP} (each index holds ${DIRS * FILES} files)`);

  /** For the log only, as above: the fastest of three runs. */
  const ms = (q: string, opts = {}): number => {
    let best = Infinity;
    for (let i = 0; i < 3; i++) {
      const started = performance.now();
      searchIndex(q, opts);
      best = Math.min(best, performance.now() - started);
    }
    return best;
  };
  t.diagnostic(`two nested stale indexes, ${DIRS * FILES} files each — extension ${ms('*.dat', { limit: 50 }).toFixed(2)}ms, ` +
    `name ${ms('file7.dat', { limit: 50 }).toFixed(2)}ms, no match ${ms('zzz').toFixed(2)}ms; rows read ${ext.rows}, ${name.rows}, ${none.rows}`);

  deleteIndex();
});

test('a current inner index beside a stale outer one: the outer one\'s rows there are left out without a walk of the folder either (review F2.1 of fifth browser pass F08)', async () => {
  // The other half of review F2.1: where the inner index answers alone (current, as a rescan of it
  // leaves it after a restart) the outer one's rows under it were left out by a walk of that whole
  // folder in the outer index, built before the first row on every search, as the tie's was.
  const { dir, mail, deep, roots } = await nestedCorpus(true);
  try {
    setRootState(dir, 'stale'); // the inner indexes are current, the outer one stale
    const db = openIndex() as unknown as { prepare: (sql: string) => unknown };
    const original = db.prepare;
    const hits: Array<{ sql: string; args: unknown[] }> = [];
    db.prepare = function (this: unknown, sql: string) {
      const stmt = original.call(this, sql) as Record<string | symbol, unknown>;
      if (!/ORDER BY n\.size DESC/.test(sql)) return stmt;
      return new Proxy(stmt, {
        get(target, key) {
          const f = target[key];
          if (typeof f !== 'function') return f;
          if (key === 'all' || key === 'iterate') return (...a: unknown[]) => { hits.push({ sql, args: a }); return f.apply(target, a); };
          return f.bind(target);
        },
      });
    } as typeof db.prepare;
    let found: string[];
    try {
      found = answered('Info');
    } finally {
      db.prepare = original;
    }
    assert.deepEqual(found, [path.join(mail, 'Mailbox 03.mbox', 'Info.plist'), path.join(mail, 'Mailbox 04.mbox', 'Info.plist')].map((p) => `${p} ← ${mail}`),
      'control: the current inner index answers for its folder, each path once');
    assert.equal(hits.length, 1, 'control: one hit query ran');
    const plan = (openIndex().prepare(`EXPLAIN QUERY PLAN ${hits[0].sql}`).all(...hits[0].args) as { detail: string }[]).map((row) => row.detail);
    assert.ok(!plan.some((step) => /RECURSIVE|MATERIALIZE/.test(step)), `the hit query walks no tree before its first row: ${plan.join(' | ')}`);
    assert.deepEqual(plan.filter((step) => step.startsWith('SCAN')), ['SCAN n'], `the name scan is one scan of the nodes: ${plan.join(' | ')}`);
    assert.deepEqual(answered('level100'), [`${path.join(deep, 'level1', 'level100.txt')} ← ${deep}`], 'and the other inner folder answers for its own');
  } finally {
    for (const root of roots) deleteIndex(root);
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

/* ══════════════ Nested indexes written row by row: deep folders, three holders (review F3.3, F3.4) ══════════════ */

/**
 * Indexes made of rows written directly — no files, no watcher — as the two tests above make theirs.
 * Every root is stale or ready and unwatched, so none is current (as each is after a restart): a path
 * two of them hold is one hit, from the one built later, the outer of two built together. A path is
 * written '/'-separated below the base folder and spelled the platform's way (review F3.1).
 */
type RowRoot = { rel: string; path: string; id: number; builtAt: number; nodes: Map<string, { id: number; size: number }> };
function rowIndex() {
  deleteIndex();
  const db = openIndex();
  const base = path.resolve(path.sep, 'rows');
  const abs = (rel: string): string => (rel === '' ? base : path.join(base, ...rel.split('/')));
  const insert = db.prepare('INSERT INTO nodes (root_id, parent_id, name, ext, is_dir, size, mtime, flags) VALUES (?,?,?,?,?,?,1,0)');
  const roots: RowRoot[] = [];
  const root = (rel: string, builtAt: number, state: 'stale' | 'ready' = 'stale'): RowRoot => {
    const p = abs(rel);
    db.prepare("INSERT INTO roots (path, state, mechanism, built_at) VALUES (?, ?, 'synthetic', ?)").run(p, state, builtAt);
    const id = (db.prepare('SELECT id FROM roots WHERE path = ?').get(p) as { id: number }).id;
    const top = Number(insert.run(id, null, path.basename(p), '', 1, 0).lastInsertRowid);
    const r = { rel, path: p, id, builtAt, nodes: new Map([[rel, { id: top, size: 0 }]]) };
    roots.push(r);
    return r;
  };
  /** Writes `rel` into `r`'s index, with every folder between: a file when it has a size, else a folder. */
  const put = (r: RowRoot, rel: string, size?: number): void => {
    assert.ok(r.rel === '' || rel.startsWith(r.rel + '/'), `control: ${rel} is inside ${r.rel}`);
    const parts = rel.split('/');
    for (let i = r.rel === '' ? 1 : r.rel.split('/').length + 1; i <= parts.length; i++) {
      const at = parts.slice(0, i).join('/');
      if (r.nodes.has(at)) continue;
      const file = i === parts.length && size !== undefined;
      const name = parts[i - 1];
      const id = Number(insert.run(r.id, r.nodes.get(parts.slice(0, i - 1).join('/'))!.id, name, file ? extensionOf(name) : '', file ? 0 : 1, file ? size : 0).lastInsertRowid);
      r.nodes.set(at, { id, size: file ? size! : 0 });
    }
  };
  /** Writes `rel` into each of `holders`' indexes. */
  const hold = (holders: RowRoot[], rel: string, size?: number): void => { for (const r of holders) put(r, rel, size); };
  /** Runs `fill` as one transaction: thousands of rows written one commit at a time took seconds. */
  const batch = (fill: () => void): void => { db.transaction(fill)(); };
  return { db, base, abs, root, put, hold, batch, roots };
}

test('two nested indexes, neither current: a path four or five folders below the inner folder is one hit, from the index built later that holds it — the walk down from the region\'s folder goes outermost folder first (review F3.3 of fifth browser pass F08)', () => {
  // Review F3.3: the walk from a region's folder down to a row's folder looks each folder up by name in
  // the other index, outermost first. Walked the other way it looks up the row's own folder under the
  // region's folder, finds nothing, and keeps the row: every path both hold, deeper than one folder below
  // the inner folder, came back twice. No test put a row more than one folder below a region's folder.
  for (const [outerBuilt, innerBuilt] of [[1_000_000, 2_000_000], [2_000_000, 1_000_000]]) {
    const ix = rowIndex();
    const outer = ix.root('', outerBuilt);
    const inner = ix.root('inner', innerBuilt);
    const later = innerBuilt > outerBuilt ? inner : outer;
    const world = later === inner ? 'the inner built later' : 'the outer built later';
    // Each folder's name is its own, so a folder looked up under the wrong one is not found by chance.
    const both: Array<[string, number]> = [['inner/lvl1/lvl2/lvl3/both3.dat', 901], ['inner/lvl1/lvl2/lvl3/lvl4/both4.dat', 902],
      ['inner/lvl1/lvl2/lvl3/lvl4/lvl5/both5.dat', 903]];
    const outerOnly: Array<[string, number]> = [['inner/lvl1/lvl2/lvl3/outer3.dat', 801], ['inner/lvl1/lvl2/lvl3/lvl4/outer4.dat', 802],
      ['inner/lvl1/old2/old3/old4/gone5.dat', 803]]; // under folders only the outer index holds: gone since its build
    const innerOnly: Array<[string, number]> = [['inner/lvl1/lvl2/lvl3/lvl4/inner4.dat', 701],
      ['inner/new1/new2/new3/new4/new5.dat', 702]]; // the second under folders only it holds
    for (const [rel, size] of both) ix.hold([outer, inner], rel, size);
    for (const [rel, size] of outerOnly) ix.put(outer, rel, size);
    for (const [rel, size] of innerOnly) ix.put(inner, rel, size);
    const want = [
      ...both.map(([rel, size]) => [size, `${ix.abs(rel)} ← ${later.path}`] as const),
      ...outerOnly.map(([rel, size]) => [size, `${ix.abs(rel)} ← ${outer.path}`] as const),
      ...innerOnly.map(([rel, size]) => [size, `${ix.abs(rel)} ← ${inner.path}`] as const),
    ].sort((x, y) => y[0] - x[0]).map(([, line]) => line);
    assert.deepEqual(answered('*.dat'), want, `${world}: every path once, from the index built later that holds it (the extension seek)`);
    assert.deepEqual(answered('dat'), want, `${world}: the same by the name scan`);
    assert.deepEqual(answered('both'), want.filter((line) => /both\d\.dat/.test(line)), `${world}: the paths both hold, once each`);
    assert.deepEqual(searchIndex('*.dat').total, want.length, `${world}: counted once each`);
    // The folders are paths too: one row each, from the index built later where both hold it.
    assert.deepEqual(answered('lvl4'), [`${ix.abs('inner/lvl1/lvl2/lvl3/lvl4')} ← ${later.path}`], `${world}: a folder both hold, four folders down, is one row`);
    assert.deepEqual(answered('old4'), [`${ix.abs('inner/lvl1/old2/old3/old4')} ← ${outer.path}`], `${world}: one only the outer index holds, from it`);
    assert.deepEqual(answered('new4'), [`${ix.abs('inner/new1/new2/new3/new4')} ← ${inner.path}`], `${world}: and one only the inner index holds, from it`);
  }
  deleteIndex();
});

test('three nested indexes, none current: a path two older indexes hold and the newest does not is one hit, from the newer of the two — however the three were built (review F3.4 of fifth browser pass F08)', () => {
  // Review F3.4: with three holders of a folder, a row of the oldest is left out where any earlier one —
  // either of the other two — holds the same path. No test had a path the newest index lacked and two
  // older ones held, so a rule that asked only the first holder found, or asked that all of them hold
  // it, or let each older index defer to the other, passed: a path lost, or found twice.
  const orders: Array<[string, [number, number, number]]> = [
    ['C newest, then B, then A', [1_000, 2_000, 3_000]],
    ['B newest, then A, then C', [2_000, 3_000, 1_000]],
    ['A newest, then C, then B', [3_000, 1_000, 2_000]],
  ];
  for (const [what, [aBuilt, bBuilt, cBuilt]] of orders) {
    const ix = rowIndex();
    const a = ix.root('', aBuilt);
    const b = ix.root('B', bBuilt);
    const c = ix.root('B/C', cBuilt);
    const newestOf = (holders: RowRoot[]) => [...holders].sort((x, y) => y.builtAt - x.builtAt)[0];
    // In C's folder — the region all three hold — and folders below it, C holding the folders but not every file.
    const cases: Array<[RowRoot[], string, number]> = [
      [[a, b], 'B/C/ab.dat', 610], // two older indexes hold it, the newest does not
      [[a, b, c], 'B/C/abc.dat', 620],
      [[a, c], 'B/C/ac.dat', 630],
      [[b, c], 'B/C/bc.dat', 640],
      [[a], 'B/C/a-only.dat', 650],
      [[a, b], 'B/C/sub/deeper/ab-deep.dat', 660], // C holds sub/deeper, not this file
      [[a, c], 'B/C/sub/deeper/ac-deep.dat', 670],
      [[a, b, c], 'B/C/sub/abc-sub.dat', 680],
      [[a, b], 'B/b-region.dat', 690], // in B's own folder, which C does not hold
    ];
    ix.put(c, 'B/C/sub/deeper/c-own.dat', 600);
    ix.put(a, 'B/C/sub/deeper/a-own.dat', 590);
    for (const [holders, rel, size] of cases) ix.hold(holders, rel, size);
    const want = [...cases, [[c], 'B/C/sub/deeper/c-own.dat', 600] as const, [[a], 'B/C/sub/deeper/a-own.dat', 590] as const]
      .sort((x, y) => y[2] - x[2])
      .map(([holders, rel]) => `${ix.abs(rel)} ← ${newestOf([...holders]).path}`);
    assert.deepEqual(answered('*.dat'), want, `${what}: every path once, from the newest index that holds it (the extension seek)`);
    assert.deepEqual(answered('dat'), want, `${what}: the same by the name scan`);
    assert.equal(searchIndex('*.dat').total, want.length, `${what}: counted once each`);
  }
  deleteIndex();
});

test('a seeded oracle: three or four nested indexes over a deep tree, none current — each path once, from the newest build that holds it, the outer of two built together, paged and counted as one index is (review F3.3, F3.4 of fifth browser pass F08)', () => {
  // The rule, stated without the engine: every path any index holds is one hit; it comes from the
  // index with the latest build among those that hold it, the outer one on a tie; hits are in size
  // order, then the order the rows were written; a page is a slice of that list, and a short page's
  // total is its offset plus its rows. Trees up to seven folders deep, each index holding a random
  // part of what lies inside its folder, sizes that tie and differ between indexes, builds that tie.
  let seed = 0x5eed_f34;
  const rnd = (): number => { seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0; return seed / 2 ** 32; };
  const pick = <T,>(list: readonly T[]): T => list[Math.floor(rnd() * list.length)];
  const FOLDERS = ['a', 'a/b', 'a/b/c', 'a/b/c/d', 'a/b/c/d/e', 'a/b/c/d/e/f', 'a/b/c/d/e/f/g', 'a/h', 'a/h/c', 'a/h/c/i', 'a/h/c/i/j', 'k', 'k/l', 'k/l/m'];
  const FILES = ['f1.dat', 'f2.dat', 'g3.dat', 'q.bin'];
  const parentOf = (rel: string): string => rel.split('/').slice(0, -1).join('/');
  const inside = (rel: string, folder: string): boolean => folder === '' || rel === folder || rel.startsWith(folder + '/');
  let checked = 0;
  let chains = 0; // rounds with three indexes in a line, each inside the one before
  let fours = 0;
  for (let round = 0; round < 40; round++) {
    const ix = rowIndex();
    const nested = FOLDERS.filter(() => rnd() < 0.3).slice(0, 3);
    if (nested.length < 2) nested.push(...['a/b', 'a/b/c/d'].filter((f) => !nested.includes(f)).slice(0, 2 - nested.length));
    for (const rel of ['', ...nested]) ix.root(rel, pick([1_000, 2_000, 2_000, 3_000]), pick(['stale', 'ready'] as const));
    if (nested.some((x) => nested.some((y) => y !== x && inside(y, x)))) chains++;
    if (ix.roots.length === 4) fours++;
    for (const r of ix.roots) {
      const folders = [r.rel, ...FOLDERS.filter((f) => f !== r.rel && inside(f, r.rel))];
      for (const folder of folders) {
        if (folder !== r.rel && (!r.nodes.has(parentOf(folder)) || rnd() < 0.2)) continue;
        if (folder !== r.rel) ix.put(r, folder);
        for (const file of FILES) if (rnd() < 0.5) ix.put(r, folder === '' ? file : `${folder}/${file}`, pick([100, 200, 200, 300]) + (rnd() < 0.3 ? 1 : 0));
        if (rnd() < 0.25) ix.put(r, `${folder === '' ? '' : folder + '/'}s1/s2${rnd() < 0.5 ? '/s3' : ''}/f1.dat`, 250);
      }
    }
    // The oracle: for each path, the newest index holding it (the outer one on a tie).
    const every = new Set<string>();
    for (const r of ix.roots) for (const rel of r.nodes.keys()) every.add(rel);
    const rows = [...every].map((rel) => {
      const from = ix.roots.filter((r) => r.nodes.has(rel)).sort((x, y) => y.builtAt - x.builtAt || x.rel.length - y.rel.length)[0];
      return { rel, from, ...from.nodes.get(rel)! };
    }).sort((x, y) => y.size - x.size || x.id - y.id);
    const label = `round ${round}: ${ix.roots.map((r) => `${r.rel || '.'}@${r.builtAt}`).join(' ')}`;
    const queries: Array<[string, (rel: string) => boolean]> = [
      ['*.dat', (rel) => rel.endsWith('.dat')],
      ['f', (rel) => path.posix.basename(rel === '' ? 'rows' : rel).includes('f')],
      ['s', (rel) => path.posix.basename(rel === '' ? 'rows' : rel).includes('s')],
    ];
    for (const [q, matched] of queries) {
      const list = rows.filter((row) => matched(row.rel)).map((row) => `${ix.abs(row.rel)} ← ${row.from.path}`);
      const whole = searchIndex(q, { limit: 500 });
      assert.deepEqual(whole.hits.map((h) => `${h.path} ← ${h.rootPath}`), list, `${label}, "${q}": each path once, from the newest index holding it, in size order`);
      assert.deepEqual([whole.total, whole.countCapped], [list.length, false], `${label}, "${q}": counted once each`);
      for (let offset = 0; offset <= list.length + 7; offset += 7) {
        const page = searchIndex(q, { limit: 7, offset });
        const slice = list.slice(offset, offset + 7);
        assert.deepEqual(page.hits.map((h) => `${h.path} ← ${h.rootPath}`), slice, `${label}, "${q}" at ${offset}: the page is that slice`);
        assert.equal(page.total, slice.length < 7 ? offset + slice.length : list.length, `${label}, "${q}" at ${offset}: counted as one index counts`);
      }
      checked++;
    }
  }
  assert.ok(chains >= 20 && fours >= 20 && checked === 120, `control: of 40 rounds, ${chains} had three indexes in a line and ${fours} had four; ${checked} queries checked`);
  deleteIndex();
});

test('two nested indexes, neither current: a page past the count cap, a short last page and a page past the end are the pages and counts one index gives (review F3.5 of fifth browser pass F08)', () => {
  // Review F3.5: where rows are kept one at a time, the page and the capped count are worked out as the
  // search reads (keptPage), not by LIMIT/OFFSET and a capped COUNT(*). Only offset 0, and one page of
  // one at offset 1, were tested: reading only to the count cap past it, a short page counting only its
  // rows, or a count left uncapped all passed. GET /api/search takes an offset up to 100,000. The same
  // paths are searched in two nested indexes and in one, and every page must be the same.
  const DIRS = 12;
  const FILES = 500; // 6,000 paths, each in both indexes
  const COUNT_CAP = 5_000; // SEARCH_COUNT_CAP
  const fill = (ix: ReturnType<typeof rowIndex>, holders: RowRoot[]) => ix.batch(() => {
    for (let d = 0; d < DIRS; d++) for (let f = 0; f < FILES; f++) ix.hold(holders, `inner/dir${d}/file${f}.dat`, d * FILES + f + 1);
  });
  const SEVENS = DIRS * Array.from({ length: FILES }, (_, f) => `file${f}.dat`).filter((name) => name.includes('file7')).length;
  const asks: Array<[string, number, number]> = [
    ['*.dat', 50, 0], // a full page: counted to the cap
    ['*.dat', 100, 5_200], // a page past the cap
    ['*.dat', 500, 5_900], // the last page, short, past the cap
    ['*.dat', 100, 7_000], // past the end
    ['file7', 50, 0],
    ['file7', 50, SEVENS - 10], // a short last page
    ['file7', 50, SEVENS + 40], // past the end
  ];
  const pages = () => asks.map(([q, limit, offset]) => {
    const r = searchIndex(q, { limit, offset });
    return { hits: r.hits.map((h) => h.path), total: r.total, countCapped: r.countCapped, truncated: r.truncated };
  });

  const nested = rowIndex();
  const outer = nested.root('', 1_000_000);
  const inner = nested.root('inner', 2_000_000);
  fill(nested, [outer, inner]);
  const twice = pages();
  assert.ok(searchIndex('*.dat', { limit: 500 }).hits.every((h) => h.rootPath === inner.path), 'control: the index built later answers for every path');
  const single = rowIndex();
  fill(single, [single.root('', 1_000_000)]);
  const once = pages();
  assert.equal(SEVENS, 132, 'control: "file7" matches 132 paths');

  // What one index gives, stated: the pages each arm of the reading must match.
  const biggest = (n: number) => { const size = DIRS * FILES - n; return nested.abs(`inner/dir${Math.floor((size - 1) / FILES)}/file${(size - 1) % FILES}.dat`); };
  assert.deepEqual(once.map((p) => [p.hits.length, p.total, p.countCapped]), [
    [50, COUNT_CAP, true], [100, COUNT_CAP, true], [100, 6_000, false], [0, 7_000, false], [50, SEVENS, false], [10, SEVENS, false], [0, SEVENS + 40, false],
  ], 'control: one index\'s pages and counts');
  assert.equal(once[1].hits[0], biggest(5_200), 'control: the page at 5,200 starts at the 5,201st biggest');

  asks.forEach(([q, limit, offset], i) => {
    assert.deepEqual(twice[i], once[i], `"${q}", ${limit} at ${offset}: two nested indexes give the page and count one index gives`);
  });
  deleteIndex();
});

test('two nested indexes, neither current: a broad name keeps a sorted top of what the page and count need, never a sort of every match — and reads on, from where it stopped, when the rows kept fall short (review F3.2 of fifth browser pass F08)', () => {
  // Review F3.2: rows another index may answer for are decided as the search reads them, so the hit
  // statement had no LIMIT, and SQLite sorted every match by size before handing over the first row:
  // a broad first keystroke ("e") over a 500,000-file outer index and a 100-file inner one took about
  // five times what the same search took without the inner index, and the server waited throughout.
  // Bounded, SQLite keeps a top-N of LIMIT + OFFSET rows as it scans. A statement that comes back full
  // without enough rows kept is followed by one that reads on from where it stopped.
  const COUNT_CAP = 5_000; // SEARCH_COUNT_CAP
  type Statement = { limit: number; offset: number; gave: number };
  /** Searches, recording each statement that reads the nodes in size order: its LIMIT, its OFFSET and the rows it gave. */
  const reading = (q: string, opts: { limit?: number; offset?: number } = {}) => {
    const db = openIndex() as unknown as { prepare: (sql: string) => unknown };
    const original = db.prepare;
    const statements: Statement[] = [];
    db.prepare = function (this: unknown, sql: string) {
      const stmt = original.call(this, sql) as Record<string | symbol, unknown>;
      if (!/ORDER BY n\.size DESC/.test(sql)) return stmt;
      const bounded = /LIMIT \? OFFSET \?\s*$/.test(sql);
      // A negative LIMIT is none, to SQLite.
      const asked = (a: unknown[]): Statement => {
        const limit = bounded ? Number(a.at(-2)) : -1;
        return { limit: limit >= 0 ? limit : Infinity, offset: bounded ? Number(a.at(-1)) : 0, gave: 0 };
      };
      return new Proxy(stmt, {
        get(target, key) {
          const f = target[key];
          if (typeof f !== 'function') return f;
          if (key === 'all') {
            return (...a: unknown[]) => {
              const all = f.apply(target, a) as unknown[];
              statements.push({ ...asked(a), gave: all.length });
              return all;
            };
          }
          if (key === 'iterate') {
            return function* (...a: unknown[]) {
              const s = asked(a);
              statements.push(s);
              for (const row of f.apply(target, a) as Iterable<unknown>) { s.gave++; yield row; }
            };
          }
          return f.bind(target);
        },
      });
    } as typeof db.prepare;
    try {
      const r = searchIndex(q, opts);
      return { page: { hits: r.hits.map((h) => h.path), total: r.total, countCapped: r.countCapped }, statements };
    } finally {
      db.prepare = original;
    }
  };
  const show = (list: Statement[]): string =>
    list.map((x) => (Number.isFinite(x.limit) ? `LIMIT ${x.limit} OFFSET ${x.offset} gave ${x.gave}` : `no LIMIT, gave ${x.gave}`)).join('; ');
  const matchedRows = (needle: string): number =>
    (openIndex().prepare("SELECT COUNT(*) c FROM nodes WHERE name LIKE ?").get(`%${needle}%`) as { c: number }).c;

  // A big outer index and a small inner one inside it, both stale: the common case after a restart.
  const OUT_FILES = 30_000;
  const IN_FILES = 100;
  const fillBig = (ix: ReturnType<typeof rowIndex>, outerIx: RowRoot, innerIx: RowRoot | null) => ix.batch(() => {
    for (let i = 0; i < OUT_FILES; i++) ix.put(outerIx, `out/dir${i % 60}/file${i}.dat`, 3 * i + 1);
    for (let i = 0; i < IN_FILES; i++) ix.hold(innerIx ? [outerIx, innerIx] : [outerIx], `inner/file-in${i}.dat`, 3 * i + 2);
  });
  const big = rowIndex();
  const bigOuter = big.root('', 1_000_000);
  fillBig(big, bigOuter, big.root('inner', 2_000_000));
  const broad = reading('file', { limit: 50 });
  const rowsMatched = matchedRows('file');
  const nestedPages = [broad.page, reading('file', { limit: 50, offset: 4_990 }).page, reading('*.dat', { limit: 50 }).page];
  const alone = rowIndex();
  fillBig(alone, alone.root('', 1_000_000), null);
  const onePages = [reading('file', { limit: 50 }).page, reading('file', { limit: 50, offset: 4_990 }).page, reading('*.dat', { limit: 50 }).page];
  assert.equal(rowsMatched, OUT_FILES + 2 * IN_FILES, 'control: "file" matches 30,200 rows in the two indexes');
  assert.deepEqual(nestedPages, onePages, 'the pages and counts are the ones one index gives');
  assert.ok(broad.statements.length >= 1 && broad.statements.every((s) => s.limit + s.offset <= 2 * COUNT_CAP),
    `each statement keeps at most ${2 * COUNT_CAP} rows in order — twice what the page and the count need — of the ${rowsMatched} it matches: ${show(broad.statements)}`);
  assert.equal(broad.statements.length, 1, 'with the inner index small, one statement reads enough');

  // Three nested indexes holding the same 6,000 paths: a third of what is read is kept, so the first
  // statement comes back full with too few, and the next reads on from where it stopped — every row once.
  const fillSame = (ix: ReturnType<typeof rowIndex>, holders: RowRoot[]) => ix.batch(() => {
    for (let i = 0; i < 6_000; i++) ix.hold(holders, `B/C/dir${i % 12}/file${i}.dat`, i + 1);
  });
  const three = rowIndex();
  fillSame(three, [three.root('', 1_000), three.root('B', 2_000), three.root('B/C', 3_000)]);
  const asks: Array<[string, { limit: number; offset: number }]> = [['*.dat', { limit: 50, offset: 0 }], ['file', { limit: 50, offset: 0 }], ['file', { limit: 500, offset: 5_900 }]];
  const threeRuns = asks.map(([q, opts]) => reading(q, opts));
  const one = rowIndex();
  fillSame(one, [one.root('', 1_000)]);
  const oneRuns = asks.map(([q, opts]) => reading(q, opts));
  asks.forEach(([q, opts], i) => {
    const label = `"${q}", ${opts.limit} at ${opts.offset}`;
    assert.deepEqual(threeRuns[i].page, oneRuns[i].page, `${label}: three nested indexes give the page and count one index gives`);
    const s = threeRuns[i].statements;
    assert.ok(s.length >= 2, `${label}: the first statement came back full with too few rows kept, and another read on: ${show(s)}`);
    assert.ok(s.slice(1).every((next, k) => next.offset === s[k].offset + s[k].gave && s[k].gave === s[k].limit),
      `${label}: each reads on from where the one before stopped, which had given all it was asked for: ${show(s)}`);
    assert.ok(s[0].offset === 0 && s[0].limit <= 2 * Math.max(opts.offset + opts.limit, COUNT_CAP), `${label}: the first keeps twice what the page and count need: ${show(s)}`);
    assert.ok(s.slice(1).every((next, k) => next.limit > s[k].limit), `${label}: and each reads more than the one before, so a search that keeps little takes a few statements, not one per page: ${show(s)}`);
  });
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
