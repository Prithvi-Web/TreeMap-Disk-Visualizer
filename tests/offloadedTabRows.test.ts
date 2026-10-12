import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { fileTempDir, isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-offloadedTabRows-data-');

import { INDEX } from './fixtures/liftFrontend';
import { getOffloadIndex } from '../src/services/offload';
import { writeJsonFile } from '../src/services/storage';

/**
 * The Offloaded tab draws at most 200 rows per destination (final review F2.4). TreeMap's record now keeps
 * every file still offloaded (F1.9), and the tab drew one row for each — 80,000 rows for a drive that
 * took a photo library in batches, every time the tab opened. Each destination shows its newest 200 and
 * says how many more it holds; the search box still finds any of them, so every file can be restored.
 *
 * Nothing is read from or written to the disk: the page's own renderOffloadIndex is evaluated with the
 * index it would be served.
 */

/** A named function from the shipped page, by brace matching. */
function pageFunction(name: string): string {
  const at = INDEX.indexOf(`function ${name}(`);
  assert.notEqual(at, -1, `${name} is in the page`);
  const open = INDEX.indexOf('{', INDEX.indexOf(')', at));
  let depth = 0;
  for (let i = open; i < INDEX.length; i++) {
    if (INDEX[i] === '{') depth++;
    else if (INDEX[i] === '}' && --depth === 0) return INDEX.slice(at, i + 1);
  }
  assert.fail(`${name} does not close`);
}

/** The page's constants that renderOffloadIndex reads, as declared there. */
function pageConstants(): string {
  return [...INDEX.matchAll(/^const OFFLOAD_[A-Z_]+ = [^;\n]+;$/gm)].map((m) => m[0]).join('\n');
}

interface Entry { id: string; name: string; originalPath: string; destPath: string; destRoot: string; size: number; hash: string; offloadedAt: number; restoredAt?: number; originalKept?: boolean }
interface Index { destinations: { root: string; mounted: boolean; lastSeenAt: number; totalBytes: number; activeCount: number; restoredCount: number }[]; entries: Entry[] }

/** `count` offloaded files on `root`, newest first, as GET /api/offload/index serves them. */
function entriesOn(root: string, count: number, name = (i: number): string => `photo-${i}.jpg`): Entry[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `${root}-${i}`, name: name(i), originalPath: `/Users/me/Pictures/${name(i)}`, destPath: `${root}/${name(i)}`, destRoot: root,
    size: 1000, hash: 'h', offloadedAt: 1_000_000 - i,
  }));
}

/** What the Offloaded tab draws for `index`, with `q` in its search box: its body, and the line above it. */
function drawn(index: Index, q = ''): { body: string; info: string } {
  const els: Record<string, { innerHTML: string; textContent: string; querySelectorAll: () => never[] }> = {};
  const $ = (id: string): (typeof els)[string] => (els[id] ??= { innerHTML: '', textContent: '', querySelectorAll: () => [] });
  const render = new Function(
    '$', 'state', 'formatCount', 'formatBytes', 'formatDate', 'escapeHtml', 'chipFor', 'icon', 'FxNum', 'api', 'runRestoreJob', 'toast',
    `${pageConstants()}\n${pageFunction('renderOffloadIndex')}; return renderOffloadIndex;`,
  )($, { offload: { index, q } }, String, (n: number) => `${n} B`, String, (s: string) => s, () => '', () => '',
    { rollHtml: (el: { innerHTML: string }, html: string) => { el.innerHTML = html; } }, async () => ({}), () => undefined, () => undefined) as () => void;
  render();
  return { body: $('offloadBody').innerHTML, info: $('offloadInfo').innerHTML };
}

/** What the Offloaded tab shows for `entries`, with `q` in its search box. */
function shown(entries: Entry[], q = ''): string {
  const roots = [...new Set(entries.map((e) => e.destRoot))];
  return drawn({
    destinations: roots.map((root) => ({ root, mounted: true, lastSeenAt: 1, totalBytes: 0, activeCount: entries.filter((e) => e.destRoot === root).length, restoredCount: 0 })),
    entries,
  }, q).body;
}

const rowIds = (html: string): string[] => [...html.matchAll(/data-offl-restore="([^"]+)"/g)].map((m) => m[1]);

test('a destination holding thousands of offloaded files draws its newest 200 and says how many more it holds', () => {
  const html = shown(entriesOn('/Volumes/Archive', 2_500));
  const ids = rowIds(html);
  assert.equal(ids.length, 200, 'the newest 200');
  assert.deepEqual(ids.slice(0, 2), ['/Volumes/Archive-0', '/Volumes/Archive-1'], 'newest first');
  assert.match(html, /…and 2300 more here — search by name or folder to find one\./, 'and the rest are counted, with the way to reach them');
});

test('the bound is per destination, and a search finds a file beyond it', () => {
  const both = [...entriesOn('/Volumes/A', 150), ...entriesOn('/Volumes/B', 150)];
  assert.equal(rowIds(shown(both)).length, 300, 'each destination under its bound shows every file');
  assert.doesNotMatch(shown(both), /more here/, 'and says nothing more');
  const many = entriesOn('/Volumes/Archive', 2_500, (i) => (i === 2_400 ? 'needle.mov' : `photo-${i}.jpg`));
  assert.deepEqual(rowIds(shown(many, 'needle')), ['/Volumes/Archive-2400'], 'the search reaches a file past the newest 200');
  const matches = shown(entriesOn('/Volumes/Archive', 2_500), 'photo-1');
  assert.equal(rowIds(matches).length, 200, 'a search matching more than the bound is bounded too');
  assert.match(matches, /more matches here — narrow the search to see them\./, matches.slice(-300));
});

/** The row drawn for the entry `id` in `body`. */
function rowOf(body: string, id: string): string {
  const row = body.split('<div class="bp-item').find((chunk) => chunk.includes(`data-offl-restore="${id}"`));
  assert.ok(row, `${id} is drawn`);
  return row;
}

/** The line above the list, as read: its markup dropped. */
const infoText = (index: Index): string => drawn(index).info.replace(/<[^>]+>/g, '');

test('the line above the list counts as freed only the originals that went to the Trash, and a copy whose original was kept says so (final review F3.2)', () => {
  const index = (entries: Entry[]): Index => ({
    destinations: [{ root: '/Volumes/A', mounted: true, lastSeenAt: 1, totalBytes: 0, activeCount: entries.length, restoredCount: 0 }],
    entries,
  });
  const [first, second, third, fourth] = entriesOn('/Volumes/A', 4);
  const one = index([first, second, { ...third, originalKept: true }]);
  assert.match(infoText(one), /^3 offloaded files across 1 destination — 2000 B freed locally\. 1 was copied with its original left in place, so it is not counted\.$/, infoText(one));
  assert.match(rowOf(drawn(one).body, third.id), /original left in place/, 'the row of the copy whose original was kept says so');
  assert.doesNotMatch(rowOf(drawn(one).body, first.id), /left in place/, 'a row whose original went to the Trash does not');

  const two = index([first, { ...second, originalKept: true }, { ...third, originalKept: true }, { ...fourth, restoredAt: 5, originalKept: true }]);
  assert.match(infoText(two), /^3 offloaded files across 1 destination — 1000 B freed locally\. 2 were copied with their originals left in place, so they are not counted\.$/, infoText(two));

  const none = index([first, second]);
  assert.match(infoText(none), /^2 offloaded files across 1 destination — 2000 B freed locally\.$/, infoText(none));
});

test('the index serves each destination\'s files newest first, whatever order its record holds them in - so the tab draws the newest 200 (final review F3.4)', async () => {
  // The record is appended to as each offload finishes, so it holds a drive's files oldest first.
  const appended = fileTempDir('treemap-offloadedTabRows-appended-');
  const shuffled = fileTempDir('treemap-offloadedTabRows-shuffled-');
  const tag = (root: string, at: number): string => `${path.basename(root)}-${at}`;
  const entry = (root: string, at: number): Entry => ({
    id: tag(root, at), name: `photo-${at}.jpg`, originalPath: `/Users/me/Pictures/photo-${at}.jpg`, destPath: path.join(root, `photo-${at}.jpg`),
    destRoot: root, size: 1000, hash: 'h', offloadedAt: 1_000_000 + at,
  });
  const ages = Array.from({ length: 500 }, (_, i) => i);
  await writeJsonFile('offload-manifest.json', {
    entries: [...ages.map((at) => entry(appended, at)), ...ages.map((i) => entry(shuffled, (i * 211) % 500))],
    destinations: {},
  });
  const index = (await getOffloadIndex()) as unknown as Index;
  const served = index.entries.map((e) => e.offloadedAt);
  assert.deepEqual(served, [...served].sort((a, b) => b - a), 'newest first');
  const ids = rowIds(drawn(index).body);
  for (const root of [appended, shuffled]) {
    assert.deepEqual(ids.filter((id) => id.startsWith(`${path.basename(root)}-`)), ages.slice(-200).reverse().map((at) => tag(root, at)), `${root} draws its newest 200, newest first`);
  }
});
