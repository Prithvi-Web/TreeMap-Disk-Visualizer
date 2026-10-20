import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INDEX, lift } from './fixtures/liftFrontend';

/**
 * "Up to X reclaimable" is a promise the Duplicates view cannot keep, for two
 * separate reasons that were being conflated.
 *
 * On APFS a Finder ⌘D duplicate is a copy-on-write clone: same hash, same
 * size, its own inode, shared blocks. Trashing it frees nothing, ever. That is
 * about the FIGURE, and the server has computed the caveat for a while — it
 * just never reached a person, because /api/duplicates dropped the field.
 *
 * And separately: trashing frees nothing on ANY platform, clone or not,
 * because every delete TreeMap makes is a move into the OS trash on the same
 * volume. So a flat free-space reading after a duplicates trash must be
 * blamed on the Trash, not on shared storage — blaming clones for what the
 * Trash did would swap a wrong number for a wrong explanation.
 */

/** Sizes are decimal (QA D09): 1 MB is 1,000,000 bytes. */
const MB = 1_000_000;

/* ── the measured sentence ── */

type FreedText = (count: number, before: number | null, after: number | null) => string;

function freedText(): FreedText {
  return lift<FreedText>(
    ['dupFreedText', 'UI_LOCALE', 'formatCount', 'formatBytes', 'UNITS', 'DUP_FREED_MIN'],
    'dupFreedText',
  );
}

test('a duplicates trash reports what was measured, and blames the Trash rather than clones', () => {
  const dupFreedText = freedText();

  const flat = dupFreedText(3, 500 * MB, 500 * MB);
  assert.match(flat, /Moved 3 copies to the Trash/, 'it says what it did');
  assert.match(flat, /Free space hasn’t changed/, 'and what actually happened to the disk');
  assert.match(flat, /emptying it is what frees the space/, 'and what would change that');
  assert.doesNotMatch(flat, /shared|clone|storage until/,
    'a flat reading is the Trash holding the bytes — on every platform, for every file, clone or not');

  const freed = dupFreedText(2, 500 * MB, 500 * MB + 40 * MB);
  assert.match(freed, /Free space went up by 40\.0 MB/, 'a real change is stated at its real size');

  const unknown = dupFreedText(1, null, null);
  assert.match(unknown, /Moved 1 copy to the Trash/, 'the singular reads');
  assert.match(unknown, /still take up the same space until you empty it/,
    'an unmeasurable volume still gets a true sentence, never a fabricated number');
});

test('churn below a megabyte is never reported as a result, and a negative delta never prints 0 B', () => {
  const dupFreedText = freedText();
  // A disk in use drifts on its own; under a megabyte is noise, not an outcome.
  assert.match(dupFreedText(1, 500 * MB, 500 * MB + 900_000), /hasn’t changed/,
    'just under the floor is still "nothing happened"');
  assert.match(dupFreedText(1, 500 * MB, 500 * MB + MB), /went up by 1\.0 MB/, 'and the floor itself counts');
  // formatBytes prints '0 B' for anything negative, so the gate must be on the
  // raw delta — otherwise another process writing during the trash produces
  // "Free space went up by 0 B", a fabricated zero.
  assert.match(dupFreedText(1, 500 * MB, 400 * MB), /hasn’t changed/,
    'a disk that got fuller during the trash never reads as a gain');
  assert.doesNotMatch(dupFreedText(1, 500 * MB, 400 * MB), /0 B/, 'and never prints a fabricated zero');
});

/* ── the caveat about the figure ── */

type NoteLines = (platform: string, status: string, groupCount: number, outcome: string | null) => string[];

test('the clone caveat is shown beside a figure it qualifies, and only there', () => {
  const dupNoteLines = lift<NoteLines>(['dupNoteLines'], 'dupNoteLines');

  const mac = dupNoteLines('darwin', 'complete', 4, null);
  assert.equal(mac.length, 1);
  assert.match(mac[0], /Finder’s Duplicate share their storage/, 'the "up to" is explained where it is printed');
  assert.match(mac[0], /frees nothing/, 'in the plainest terms');

  assert.deepEqual(dupNoteLines('linux', 'complete', 4, null), [],
    'copy-on-write cloning through the file manager is an APFS story');
  assert.deepEqual(dupNoteLines('darwin', 'complete', 0, null), [],
    'no groups, no figure to qualify — standing alone it is a lecture nobody asked for');
  assert.deepEqual(dupNoteLines('darwin', 'running', 4, null), [],
    'and nothing is claimed while the hunt is still running');

  const both = dupNoteLines('darwin', 'complete', 4, 'Moved 2 copies to the Trash.');
  assert.deepEqual(both.length, 2, 'the caveat and the outcome are separate sentences');
  assert.equal(both[1], 'Moved 2 copies to the Trash.', 'the measured one comes second');
  assert.deepEqual(dupNoteLines('win32', 'complete', 4, 'Moved 2 copies to the Trash.').length, 1,
    'and off darwin the outcome stands alone');
});

/* ── what the hunt would have had to download ── */

type NoteLinesWithCloud = (platform: string, status: string, groupCount: number, outcome: string | null, notHashed?: { files: number; bytes: number }) => string[];

test('cloud files the hunt did not open are named in the note, even when no duplicate was found', () => {
  // The master prompt §3.2: never silently omit them. Opening one downloads it,
  // so the hunt leaves them alone — and a "No duplicates found" standing over
  // unchecked cloud files would be a claim nobody made.
  const dupNoteLines = lift<NoteLinesWithCloud>(['dupNoteLines', 'UI_LOCALE', 'formatCount', 'formatBytes', 'UNITS'], 'dupNoteLines');
  const many = dupNoteLines('linux', 'complete', 0, null, { files: 3, bytes: 3 * MB });
  assert.equal(many.length, 1);
  assert.match(many[0], /^3 cloud files \(3\.0 MB\) were not checked, because opening them would download them/);
  assert.match(many[0], /make them available offline first/);
  const one = dupNoteLines('win32', 'complete', 2, null, { files: 1, bytes: MB });
  assert.match(one[0], /^1 cloud file \(1\.0 MB\) was not checked, because opening it would download it/, 'the singular reads');
  assert.deepEqual(dupNoteLines('linux', 'complete', 0, null, { files: 0, bytes: 0 }), [], 'none left out, nothing said');
  assert.deepEqual(dupNoteLines('linux', 'running', 0, null, { files: 3, bytes: 3 * MB }), [], 'nothing claimed while the hunt runs');
  const mac = dupNoteLines('darwin', 'complete', 4, 'Moved 2 copies to the Trash.', { files: 2, bytes: 2 * MB });
  assert.equal(mac.length, 3, 'the clone caveat, then the cloud files, then the outcome');
  assert.match(mac[1], /^2 cloud files/);
  assert.equal(mac[2], 'Moved 2 copies to the Trash.');
});

test('the page keeps what the server reports about files it did not open', () => {
  assert.match(INDEX, /state\.dup\.notHashed = data\.notHashed/, 'the poll stores it');
  assert.match(INDEX, /dupNoteLines\(.*state\.dup\.notHashed\)/, 'the note is given it');
});

/* ── the wiring that makes the measurement mean anything ── */

test('the before reading is taken after the user confirms, not when the dialog opens', () => {
  const start = INDEX.indexOf("$('dupTrashBtn').addEventListener('click'");
  assert.notEqual(start, -1, 'the duplicates trash button is findable');
  const handler = INDEX.slice(start, INDEX.indexOf("$('dupMinSize').addEventListener", start));
  // Deliberately a region slice and not braced(): the callback's
  // `async ({ ignoreOpenHandles } = {}) =>` signature is exactly the shape
  // that closes braced() on its own parameter list.
  assert.match(handler, /onConfirmTrash = async \(\{ ignoreOpenHandles \} = \{\}\) => \{[\s\S]*?const before = await freeSpaceNow\(\);[\s\S]*?await trashPaths/,
    'the free-space reading is the first thing the confirmed action does — a person can sit on that dialog for minutes');
  assert.match(handler, /const sys = await loadSystem\(\);/,
    'and the after reading repaints the dashboard, which is otherwise painted once at boot and never again');
  assert.match(handler, /if \(isCloudScan\(\)\) return;/,
    'free space on this computer says nothing about a provider’s quota');
});

test('a confirm callback is told whether the user chose "Delete anyway"', () => {
  const start = INDEX.indexOf("$('confirmOk').addEventListener");
  assert.notEqual(start, -1);
  const handler = INDEX.slice(start, start + 1200);
  assert.match(handler, /if \(cb\) \{ await cb\(\{ ignoreOpenHandles \}\); return; \}/,
    'without this the callback path drops the flag and the server refuses the same batch for ever');
});

test('the trash toast no longer claims bytes were recovered', () => {
  // They were moved, not recovered. Saying "2.3 GB recovered" beside a note
  // reading "Free space hasn’t changed" is the app contradicting itself on one
  // screen — and the toast is the half that is wrong.
  assert.doesNotMatch(INDEX, /to Trash — \$\{formatBytes\(recovered\)\} recovered/,
    'the bytes are in the Trash until it is emptied');
  assert.match(INDEX, /to Trash — \$\{formatBytes\(recovered\)\}/, 'the size itself still gets said');
});

test('the free-space check covers a scan of a folder that CONTAINS home, not just one inside it', () => {
  // /api/system measures the home folder's volume, so the question is "is the
  // scanned tree on that volume?". Testing only `root.startsWith(home)` answers
  // a narrower one and says no for /, /Users and C:\ — roots that are on the
  // home volume and are among the commonest things anyone scans.
  const start = INDEX.indexOf('async function freeSpaceNow()');
  assert.notEqual(start, -1);
  const fn = INDEX.slice(start, INDEX.indexOf('\n}', start));
  assert.match(fn, /home\.startsWith\(/,
    'a root that contains the home folder is on the home volume too');
  assert.match(fn, /startsWith\(home\)/, 'and so is a root inside it');
});

test('a cloud scan does not inherit the previous local scan’s trash line', () => {
  // The duplicates view is disabled for cloud scans and its mount() returns
  // early — without unmount() running, because switchView only unmounts when
  // the view actually changes. The note would otherwise stand under "Not
  // available for cloud scans."
  const start = INDEX.indexOf("id: 'duplicates'");
  assert.notEqual(start, -1);
  const mount = INDEX.slice(start, INDEX.indexOf("id: 'trends'", start));
  const cloud = mount.slice(mount.indexOf('if (isCloudScan())'), mount.indexOf('state.dupMode'));
  assert.match(cloud, /dupTrashOutcome = null/, 'the measured line belongs to the scan that produced it');
  // The panel is repainted through the toolbar, which renders the note first (review F3.4).
  assert.match(cloud, /renderDupNote\(\)|updateDupToolbar\(\)/, 'and the panel is repainted so it actually goes');
  assert.match(source('updateDupToolbar'), /^function updateDupToolbar\(\) \{\s*renderDupNote\(\);/, 'the toolbar repaint renders the note');
});

/* ── the near-duplicate view: images not compared ── */

interface NearState {
  available: boolean;
  reason?: string;
  compared?: number;
  unreadable?: number;
  unreadableTypes?: { extension: string; count: number }[];
  clusters: unknown[];
  clusterCount: number;
  totalReclaimable: number;
  truncated: boolean;
}

/** The body of a named function in the built page, by brace matching. */
function source(name: string): string {
  const start = INDEX.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} is in the built page`);
  let depth = 0;
  for (let i = INDEX.indexOf('{', start); i < INDEX.length; i++) {
    if (INDEX[i] === '{') depth++;
    else if (INDEX[i] === '}' && --depth === 0) return INDEX.slice(start, i + 1);
  }
  return assert.fail(`${name} never closes`);
}

/** Run the page's own renderNearDupes over `near`; what the summary line and the body show. */
function renderNear(near: NearState): { summary: string; body: string; appended: number } {
  const els: Record<string, { textContent: string; innerHTML: string }> = {
    ndSummary: { textContent: '', innerHTML: '' },
    ndBody: { textContent: '', innerHTML: '' },
  };
  let appended = 0;
  const run = new Function(
    '$', 'state', 'icon', 'FxNum', 'formatCount', 'formatBytes', 'ndAppendClusters', 'updateNdToolbar',
    `let ndSentinelObserver = null;\n${source('escapeHtml')}\n${source('renderNearDupes')}\nrenderNearDupes();`,
  );
  run(
    (id: string) => els[id] ?? assert.fail(`renderNearDupes touched #${id}`),
    { near: { ...near, loadedFor: 'k' } },
    (name: string) => `[${name}]`,
    { rollHtml: (el: { innerHTML: string }, html: string) => { el.innerHTML = html; } },
    String,
    (n: number) => `${n} B`,
    () => { appended++; },
    () => {},
  );
  return { summary: els.ndSummary!.textContent + els.ndSummary!.innerHTML, body: els.ndBody!.innerHTML, appended };
}

const LEFT_OUT = '3 images were not compared: TreeMap could not confirm their data is on this disk, and opening one could download it.';
const none: NearState = { available: true, compared: 5, unreadable: 0, unreadableTypes: [], clusters: [], clusterCount: 0, totalReclaimable: 0, truncated: false };

test('near-duplicates: images the pass could not vouch for are named, and an empty result is not called tidy', () => {
  // The job leaves out any image it could not confirm is on this disk (opening
  // it could download it) and says how many in `reason`. "Your image library
  // looks tidy" over a result with a hole in it is the claim nobody checked.
  const empty = renderNear({ ...none, reason: LEFT_OUT });
  assert.ok(empty.body.includes(LEFT_OUT), `the reason is shown: ${empty.body}`);
  assert.doesNotMatch(empty.body, /tidy/, 'and the library is not called tidy');
  assert.match(empty.summary, /among the images compared/, `the summary says what was searched: ${empty.summary}`);

  const found = renderNear({ ...none, reason: LEFT_OUT, clusters: [{}], clusterCount: 1, totalReclaimable: 10 });
  assert.ok(found.body.includes(LEFT_OUT), `a result with groups names what it left out too: ${found.body}`);
  assert.equal(found.appended, 1, 'and still lists the groups');

  // Unchanged when nothing was left out.
  const tidy = renderNear(none);
  assert.match(tidy.body, /tidy/, 'with every image compared, an empty result is a finding');
  assert.equal(tidy.summary, 'No near-duplicate images found.');
  assert.ok(!renderNear({ ...none, clusters: [{}], clusterCount: 1 }).body.includes('not compared'), 'and no note is invented');
});

test('near-duplicates: the unreadable note names three types and counts the rest as others, never leaving types out unsaid (C14)', () => {
  // "(1,037 .heic, 1,009 .jpeg, 634 .png)" stood for six types: the three
  // others were dropped without a word, and the counts no longer added up.
  const six = [
    { extension: 'heic', count: 1037 }, { extension: 'jpeg', count: 1009 }, { extension: 'png', count: 634 },
    { extension: 'gif', count: 200 }, { extension: 'webp', count: 100 }, { extension: 'tiff', count: 12 },
  ];
  const many = renderNear({ ...none, compared: 40, unreadable: 2992, unreadableTypes: six });
  assert.match(many.body, /2992 images could not be read, so they were not compared \(1037 \.heic, 1009 \.jpeg, 634 \.png, and 312 others\)/,
    `the three named, and the other 312 counted: ${many.body}`);
  const oneMore = renderNear({ ...none, compared: 40, unreadable: 2681, unreadableTypes: [...six.slice(0, 3), { extension: 'tif', count: 1 }] });
  assert.match(oneMore.body, /\(1037 \.heic, 1009 \.jpeg, 634 \.png, and 1 other\)/, `one other is one: ${oneMore.body}`);
  const three = renderNear({ ...none, compared: 40, unreadable: 2680, unreadableTypes: six.slice(0, 3) });
  assert.match(three.body, /\(1037 \.heic, 1009 \.jpeg, 634 \.png\)\./, `every type named, nothing more said: ${three.body}`);
});

test('near-duplicates: images that could not be read are counted, and the library is not called tidy over them (B20)', () => {
  const heic = { ...none, compared: 40, unreadable: 5300, unreadableTypes: [{ extension: 'heic', count: 5300 }] };
  const empty = renderNear(heic);
  assert.match(empty.body, /5300 images could not be read, so they were not compared \(5300 \.heic\)/, `the gap is named: ${empty.body}`);
  assert.doesNotMatch(empty.body, /tidy/, 'and the library is not called tidy');
  assert.match(empty.summary, /among the images compared/, `the summary says what was searched: ${empty.summary}`);

  const one = renderNear({ ...none, unreadable: 1, unreadableTypes: [{ extension: 'png', count: 1 }], clusters: [{}], clusterCount: 1 });
  assert.match(one.body, /1 image could not be read, so it was not compared \(1 \.png\)/, `a result with groups names it too: ${one.body}`);
  assert.equal(one.appended, 1, 'and still lists the groups');

  // Nothing compared at all is not a finding either.
  const nothing = renderNear({ ...none, compared: 0 });
  assert.doesNotMatch(nothing.body, /tidy/, `no image compared is not a tidy library: ${nothing.body}`);
  assert.match(nothing.body, /no images here to compare/, 'it says there was nothing to compare');
  assert.equal(nothing.summary, 'No images were compared.');

  assert.ok(!renderNear(none).body.includes('could not be read'), 'and no note is invented when every image was read');

  // The loader carries the counts from the answer to the view.
  const load = source('loadNearDupes');
  for (const field of ['compared', 'unreadable', 'unreadableTypes']) {
    assert.match(load, new RegExp(`state\\.near\\.${field} = data\\.${field};`), `the loader keeps ${field}`);
  }
});

test('near-duplicates: a pass that hit its image cap does not call the library tidy — the smaller images were never compared (B20 review)', () => {
  // perceptualDupes keeps only the largest 8,000 images and says so with
  // truncated: true. An empty result over that is "none among the largest",
  // not a tidy library.
  const capped = renderNear({ ...none, compared: 8000, truncated: true });
  assert.doesNotMatch(capped.body, /tidy/, `the library is not called tidy when images were left out: ${capped.body}`);
  assert.match(capped.body, /Only the largest images were compared/, `and the cap is named: ${capped.body}`);
  assert.match(capped.summary, /among the images compared/, `the summary says what was searched: ${capped.summary}`);

  const found = renderNear({ ...none, compared: 8000, truncated: true, clusters: [{}], clusterCount: 1, totalReclaimable: 10 });
  assert.equal((found.body.match(/Only the largest images were compared/g) ?? []).length, 1, `a result with groups names the cap once: ${found.body}`);
  assert.equal(found.appended, 1, 'and still lists the groups');
});

test('near-duplicates: the reason is shown as text, never as markup', () => {
  const r = renderNear({ ...none, reason: '<img src=x onerror=alert(1)> were not compared' });
  assert.ok(r.body.includes('&lt;img src=x onerror=alert(1)&gt; were not compared'), `escaped: ${r.body}`);
  assert.ok(!r.body.includes('<img'), 'no element is made from it');
});

/* ══════════════ Auto-select says why it cannot act (fourth browser pass, E13) ══════════════ */

/**
 * The page's own updateNdToolbar over `near`: Auto-select's state and the reason it gives. `scanId`:
 * the scan the page holds — null after an instant open from the index, or a Stop with nothing settled.
 */
function ndToolbar(near: Record<string, unknown>, scanId: string | null = 's1'): { disabled: boolean; title: string } {
  const els: Record<string, { disabled: boolean; title: string; innerHTML: string }> = {};
  const $ = (id: string) => (els[id] ??= { disabled: false, title: '', innerHTML: '' });
  // With the app's one rule for the scan behind the tree on screen (treeScanId, treeScanComing).
  const helper = [INDEX.includes('function ndAutoSelectBlocked(') ? source('ndAutoSelectBlocked') : '', source('treeScanId'), source('treeScanComing')].join('\n');
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function('$', 'state', 'nodeFor', 'icon', 'formatBytes', `${helper}\n${source('updateNdToolbar')}\nupdateNdToolbar();`)(
    $, { scanId, near: { selection: new Set(), clusters: [], ...near } }, () => null, () => '', (n: number) => `${n} B`,
  );
  return { disabled: els.ndAutoBtn?.disabled ?? false, title: els.ndAutoBtn?.title ?? '' };
}

test('Auto-select is disabled, saying why, whenever there is nothing for it to select — no image compared above all (E13)', () => {
  const noneCompared = ndToolbar({ status: 'complete', available: true, compared: 0, clusters: [] });
  assert.equal(noneCompared.disabled, true, 'no image was compared: nothing to select');
  assert.match(noneCompared.title, /No images were compared/, 'and it says so');
  const noGroups = ndToolbar({ status: 'complete', available: true, compared: 40, clusters: [] });
  assert.equal(noGroups.disabled, true, 'images compared, no similar ones: nothing to select');
  assert.match(noGroups.title, /No similar images were found/);
  const unavailable = ndToolbar({ status: 'complete', available: false, reason: 'Image decoding is not available here.', clusters: [] });
  assert.equal(unavailable.disabled, true);
  assert.match(unavailable.title, /Image decoding is not available here/, 'an unavailable search gives its own reason');
  const running = ndToolbar({ status: 'loading', clusters: [] });
  assert.equal(running.disabled, true, 'while the search runs there is nothing to select yet');
  assert.match(running.title, /still looking/i);
  const failed = ndToolbar({ status: 'error', clusters: [] });
  assert.equal(failed.disabled, true);
  assert.match(failed.title, /failed/);
  const groups = ndToolbar({ status: 'complete', available: true, compared: 40, clusters: [{ files: [] }] });
  assert.equal(groups.disabled, false, 'control: with groups, Auto-select acts');
  assert.match(groups.title, /select all copies except the newest one/, 'and its title says what it does');
});

test('the failed search updates the toolbar too, so Auto-select never keeps the running reason (E13)', () => {
  const load = source('loadNearDupes');
  const failed = load.slice(load.indexOf("state.near.status = 'error';"));
  assert.match(failed.slice(0, 400), /updateNdToolbar\(\)/, 'the error branch refreshes the toolbar');
});

/** The page's own Auto-select click handler, run once over `state`; what it selected and said. */
function ndAutoClick(state: { scanId: string | null; near: Record<string, unknown> }): { selected: string[]; toasts: string[] } {
  const at = INDEX.indexOf("$('ndAutoBtn').addEventListener('click', () => {");
  assert.notEqual(at, -1, 'the Auto-select handler is in the page');
  let depth = 0;
  let end = -1;
  for (let i = INDEX.indexOf('{', at); i < INDEX.length; i++) {
    if (INDEX[i] === '{') depth++;
    else if (INDEX[i] === '}' && --depth === 0) { end = INDEX.indexOf(';', i) + 1; break; }
  }
  const toasts: string[] = [];
  let handler: () => void = () => assert.fail('no handler was bound');
  const el = { addEventListener: (_: string, fn: () => void) => { handler = fn; }, querySelectorAll: () => [], disabled: false, title: '', innerHTML: '' };
  // With the app's one rule for the scan behind the tree on screen (treeScanId, treeScanComing).
  const helper = [INDEX.includes('function ndAutoSelectBlocked(') ? source('ndAutoSelectBlocked') : '', source('treeScanId'), source('treeScanComing')].join('\n');
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function('$', 'state', 'nodeFor', 'icon', 'formatBytes', 'toast', `${helper}\n${source('updateNdToolbar')}\n${INDEX.slice(at, end)}`)(
    () => el, state, () => null, () => '', (n: number) => `${n} B`, (m: string) => { toasts.push(m); },
  );
  handler();
  return { selected: [...(state.near.selection as Set<string>)], toasts };
}

test('Auto-select never says it is still looking when nothing is, and with no completed scan it says so — and selects nothing, even over groups an earlier scan left (E13, review F1.4, F1.10)', () => {
  const idle = ndToolbar({ status: 'idle', clusters: [] });
  assert.equal(idle.disabled, true, 'before any search there is nothing to select');
  assert.doesNotMatch(idle.title, /still looking/i, 'and nothing is looking');
  assert.match(idle.title, /No search for similar images has run yet/, 'it says no search has run');

  const noScanIdle = ndToolbar({ status: 'idle', clusters: [] }, null);
  assert.equal(noScanIdle.disabled, true, 'with no completed scan there is nothing to select');
  assert.match(noScanIdle.title, /Needs a completed scan/, 'and it says what the card beside it says');
  assert.doesNotMatch(noScanIdle.title, /still looking/i);

  const staleGroups = { status: 'complete', available: true, compared: 40, clusters: [{ files: [{ path: '/old/a.jpg' }, { path: '/old/b.jpg' }] }] };
  const stale = ndToolbar(staleGroups, null);
  assert.equal(stale.disabled, true, 'groups an earlier scan left are not offered under "Needs a completed scan"');
  assert.match(stale.title, /Needs a completed scan/);
  assert.equal(ndToolbar(staleGroups).disabled, false, 'control: with the scan they came from, the same groups are offered');

  const clicked = ndAutoClick({ scanId: null, near: { ...staleGroups, selection: new Set<string>() } });
  assert.deepEqual(clicked.selected, [], 'a click with no completed scan selects nothing');
  assert.deepEqual(clicked.toasts, [], 'and no toast claims a selection');
  const control = ndAutoClick({ scanId: 's1', near: { ...staleGroups, selection: new Set<string>() } });
  assert.deepEqual(control.selected, ['/old/b.jpg'], 'control: with the scan, the click selects every copy but the newest');
});

/**
 * The page's own ndNeedsScan, updateNdToolbar and Trash handler over `state` (review F2.5): what the
 * Trash button shows, what is left selected, and what a press would send to the Trash.
 */
function ndNoScan(state: { scanId: string | null; near: Record<string, unknown> }, run: 'needsScan' | 'toolbar' | 'trashClick'): { disabled: boolean; label: string; selected: string[]; trashed: string[][] } {
  const els: Record<string, { disabled: boolean; title: string; innerHTML: string; textContent: string }> = {};
  const $ = (id: string) => (els[id] ??= { disabled: false, title: '', innerHTML: '', textContent: '' });
  const at = INDEX.indexOf("$('ndTrashBtn').addEventListener('click', () => {");
  assert.notEqual(at, -1, 'the Trash handler is in the page');
  let depth = 0;
  let end = -1;
  for (let i = INDEX.indexOf('{', at); i < INDEX.length; i++) {
    if (INDEX[i] === '{') depth++;
    else if (INDEX[i] === '}' && --depth === 0) { end = INDEX.indexOf(';', i) + 1; break; }
  }
  const trashed: string[][] = [];
  let handler: () => void = () => assert.fail('no handler was bound');
  const bindable = (id: string) => (id === 'ndTrashBtn'
    ? { addEventListener: (_: string, fn: () => void) => { handler = fn; } }
    : assert.fail(`the Trash handler is bound to #${id}`));
  // With the app's one rule for the scan behind the tree on screen (treeScanId, treeScanComing).
  const helper = [INDEX.includes('function ndAutoSelectBlocked(') ? source('ndAutoSelectBlocked') : '', source('treeScanId'), source('treeScanComing')].join('\n');
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function('$', '$bind', 'state', 'nodeFor', 'icon', 'formatBytes', 'toast', 'confirmTrash', 'run',
    `${helper}\n${source('updateNdToolbar')}\n${source('ndNeedsScan')}\n{ const $ = $bind; ${INDEX.slice(at, end)} }\n`
    + `if (run === 'needsScan') ndNeedsScan(); else if (run === 'toolbar') updateNdToolbar();`)(
    $, bindable, state, () => ({ size: 1000 }), () => '', (n: number) => `${n} B`, () => {}, (paths: string[]) => { trashed.push(paths); }, run,
  );
  if (run === 'trashClick') handler();
  return { disabled: els.ndTrashBtn?.disabled ?? false, label: els.ndTrashBtn?.innerHTML ?? '', selected: [...(state.near.selection as Set<string>)], trashed };
}

test('with no completed scan, images an earlier scan left selected cannot be moved to the Trash: the pane lets go of them, the button is disabled, and a press sends nothing (review F2.5)', () => {
  const fromFolderA = () => ({ status: 'complete', available: true, compared: 40, clusters: [{ files: [{ path: '/A/a.jpg' }, { path: '/A/b.jpg' }, { path: '/A/c.jpg' }, { path: '/A/d.jpg' }] }],
    selection: new Set(['/A/b.jpg', '/A/c.jpg', '/A/d.jpg']) });

  const pane = ndNoScan({ scanId: null, near: fromFolderA() }, 'needsScan');
  assert.deepEqual(pane.selected, [], '"Needs a completed scan" lets go of what an earlier scan left selected');
  assert.equal(pane.disabled, true, 'and its Trash button is disabled, never offering to trash images the pane no longer shows');

  const toolbar = ndNoScan({ scanId: null, near: fromFolderA() }, 'toolbar');
  assert.equal(toolbar.disabled, true, 'the toolbar itself offers no Trash without a completed scan, whatever is still selected');
  assert.doesNotMatch(toolbar.label, /Move 3 to Trash/, 'nor counts them');
  const withScan = ndNoScan({ scanId: 's1', near: fromFolderA() }, 'toolbar');
  assert.equal(withScan.disabled, false, 'control: with the scan they came from, the Trash button acts');
  assert.match(withScan.label, /Move 3 to Trash \(3000 B\)/, 'control: and counts them');

  const press = ndNoScan({ scanId: null, near: fromFolderA() }, 'trashClick');
  assert.deepEqual(press.trashed, [], 'a press with no completed scan sends nothing to the Trash');
  const control = ndNoScan({ scanId: 's1', near: fromFolderA() }, 'trashClick');
  assert.deepEqual(control.trashed, [['/A/b.jpg', '/A/c.jpg', '/A/d.jpg']], 'control: with the scan, the press asks to trash the selection');
});

/* ══════════════ A cloud scan lands on the Duplicates view (review F3.4) ══════════════ */

/** A `$('<id>').addEventListener('click', …);` statement of the page, by brace matching. */
function clickListener(id: string): string {
  const at = INDEX.indexOf(`$('${id}').addEventListener('click', `);
  assert.notEqual(at, -1, `the ${id} handler is in the page`);
  let depth = 0;
  for (let i = INDEX.indexOf('{', at); i < INDEX.length; i++) {
    if (INDEX[i] === '{') depth++;
    else if (INDEX[i] === '}' && --depth === 0) return INDEX.slice(at, INDEX.indexOf(';', i) + 1);
  }
  return assert.fail(`the ${id} handler never closes`);
}

/** The Duplicates view's own mount(), from the view registry, as a declaration named dupMount. */
function duplicatesMount(): string {
  const view = INDEX.indexOf("id: 'duplicates', label: 'Duplicates'");
  assert.notEqual(view, -1, 'the Duplicates view is in the registry');
  const open = INDEX.indexOf('{', INDEX.indexOf('mount() {', view));
  let depth = 0;
  for (let i = open; i < INDEX.length; i++) {
    if (INDEX[i] === '{') depth++;
    else if (INDEX[i] === '}' && --depth === 0) return `function dupMount() ${INDEX.slice(open, i + 1)}`;
  }
  return assert.fail('the Duplicates view\'s mount() never closes');
}

interface DupViewState {
  scanId: string | null;
  root: { path: string };
  dupMode: string;
  cloud: { providers: Array<{ id: string; name: string }> };
  dup: Record<string, unknown>;
  near: Record<string, unknown>;
}

/**
 * The page's own Duplicates view over `state`: both panes' toolbars painted as a local scan leaves them,
 * then `land` (what finishScan does for the next scan) and the view's own mount(), as switchView runs
 * it. What both toolbars show after it, what Similar images still holds selected, and what a press of
 * its Move to Trash or its Auto-select does.
 */
function cloudScanLands(state: DupViewState, land: (s: DupViewState) => void) {
  type El = { disabled: boolean; title: string; innerHTML: string; textContent: string; hidden: boolean;
    addEventListener: (type: string, fn: () => void) => void; querySelectorAll: () => unknown[] };
  const els: Record<string, El> = {};
  const handlers: Record<string, () => void> = {};
  const $ = (id: string) => (els[id] ??= { disabled: false, title: '', innerHTML: '', textContent: '', hidden: false,
    addEventListener: (_: string, fn: () => void) => { handlers[id] = fn; }, querySelectorAll: () => [] });
  const trashed: string[][] = [];
  const toasts: string[] = [];
  const loaded: string[] = [];
  // With the app's one rule for the scan behind the tree on screen (treeScanId, treeScanComing).
  const helper = [INDEX.includes('function ndAutoSelectBlocked(') ? source('ndAutoSelectBlocked') : '', source('treeScanId'), source('treeScanComing')].join('\n');
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const page = new Function('$', 'state', 'nodeFor', 'icon', 'formatBytes', 'escapeHtml', 'toast', 'confirmTrash', 'renderDupNote',
    'loadNearDupes', 'loadDuplicates', 'cartHas', 'dupFunnelDrop', 'FxCharts',
    `let dupTrashOutcome = 'Moved 2 copies to the Trash.'; let dupFunnelHandle = null;
     ${source('isCloudScan')}\n${source('cloudProviderOfScan')}\n${helper}\n${source('updateNdToolbar')}
     ${source('ndNeedsScan')}\n${source('dupNeedsScan')}\n${source('updateDupToolbar')}\n${duplicatesMount()}
     ${clickListener('ndAutoBtn')}\n${clickListener('ndTrashBtn')}
     return { dupMount, updateNdToolbar, updateDupToolbar };`)(
    $, state, () => ({ size: 1000 }), () => '', (n: number) => `${n} B`, (s: unknown) => String(s), (m: string) => { toasts.push(m); },
    (paths: string[]) => { if (paths.length) trashed.push(paths); }, () => {},
    () => { loaded.push('near'); }, () => { loaded.push('exact'); }, () => false, () => {}, { funnel: () => ({ update: () => {} }) },
  ) as { dupMount: () => void; updateNdToolbar: () => void; updateDupToolbar: () => void };
  page.updateNdToolbar();
  page.updateDupToolbar();
  const before = { ndTrash: $('ndTrashBtn').innerHTML, dupTrash: $('dupTrashBtn').innerHTML, ndAuto: $('ndAutoBtn').disabled };
  land(state);
  page.dupMount();
  const after = {
    ndSummary: $('ndSummary').textContent,
    ndTrash: { disabled: $('ndTrashBtn').disabled, label: $('ndTrashBtn').innerHTML },
    ndAuto: { disabled: $('ndAutoBtn').disabled, title: $('ndAutoBtn').title },
    dupTrash: { disabled: $('dupTrashBtn').disabled, label: $('dupTrashBtn').innerHTML },
    dupOffload: $('dupOffloadBtn').disabled,
    selected: [...(state.near.selection as Set<string>)],
  };
  const press = (id: 'ndTrashBtn' | 'ndAutoBtn') => {
    handlers[id]();
    return { trashed, toasts, selected: [...(state.near.selection as Set<string>)] };
  };
  return { before, after, press, loaded };
}

const PICS = '/Users/me/Pictures';
/** A local scan with one image ticked in Similar images and one copy in exact duplicates. */
const localDupScan = (): DupViewState => ({
  scanId: 'A', root: { path: PICS }, dupMode: 'near', cloud: { providers: [{ id: 'gdrive', name: 'Google Drive' }] },
  dup: { status: 'complete', groups: [], totalReclaimable: 2000, selection: new Set([`${PICS}/copy.jpg`]) },
  near: { loadedFor: 'A:10', status: 'complete', available: true, compared: 40, pollTimer: 0,
    clusters: [{ files: [{ path: `${PICS}/a.jpg` }, { path: `${PICS}/b.jpg` }] }], selection: new Set([`${PICS}/b.jpg`]) },
});
/** What finishScan does for a cloud scan: its root and id, and a fresh exact-duplicates state. */
const cloudLands = (s: DupViewState) => {
  s.scanId = 'C1';
  s.root = { path: 'cloud://gdrive' };
  s.dup = { status: 'idle', groups: [], totalReclaimable: 0, selection: new Set() };
};

test('a cloud scan landing on the Duplicates view lets go of what the local scan before it left: neither pane offers Move to Trash under "Not available for cloud scans", and Auto-select is disabled saying why (review F3.4)', () => {
  const { before, after } = cloudScanLands(localDupScan(), cloudLands);
  assert.match(before.ndTrash, /Move 1 to Trash \(1000 B\)/, 'control: on the local scan, Similar images offers the image ticked');
  assert.match(before.dupTrash, /Move 1 to Trash \(1000 B\)/, 'control: and so do exact duplicates');
  assert.equal(before.ndAuto, false, 'control: and Auto-select acts on its groups');
  assert.equal(after.ndSummary, 'Not available for cloud scans.', 'control: the cloud branch of mount() ran');

  assert.deepEqual(after.selected, [], 'Similar images lets go of the local scan\'s selection: it is not this account\'s');
  assert.equal(after.ndTrash.disabled, true, 'its Move to Trash is disabled under the notice');
  assert.doesNotMatch(after.ndTrash.label, /Move 1 to Trash/, 'and no longer counts the local image');
  assert.equal(after.ndAuto.disabled, true, 'Auto-select is disabled: there is nothing of this scan to select');
  assert.match(after.ndAuto.title, /cloud scans never download any/, 'and it says why, as the notice does');
  assert.equal(after.dupTrash.disabled, true, 'the exact-duplicates pane\'s Move to Trash is repainted disabled too');
  assert.doesNotMatch(after.dupTrash.label, /Move 1 to Trash/, 'and no longer counts the local copy');
  assert.equal(after.dupOffload, true, 'and so is its Offload');

  // control: a local scan landing instead still loads the pane the view shows, and the cloud reset is the cloud branch's alone.
  const local = cloudScanLands(localDupScan(), (s) => { s.scanId = 'B'; });
  assert.deepEqual(local.loaded, ['near'], 'control: a local scan\'s mount() loads Similar images');
});

test('after a cloud scan lands on the Duplicates view, a press of Similar images\' Move to Trash or Auto-select acts on nothing the local scan before it left (review F3.4)', () => {
  const trashPress = cloudScanLands(localDupScan(), cloudLands).press('ndTrashBtn');
  assert.deepEqual(trashPress.trashed, [], 'a press of Similar images\' Move to Trash sends no path to the Trash');
  const autoPress = cloudScanLands(localDupScan(), cloudLands).press('ndAutoBtn');
  assert.deepEqual(autoPress.selected, [], 'a press of Auto-select selects nothing of the local scan');
  assert.deepEqual(autoPress.toasts, [], 'and no toast claims a selection');
});
