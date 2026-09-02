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

const MB = 1024 * 1024;

/* ── the measured sentence ── */

type FreedText = (count: number, before: number | null, after: number | null) => string;

function freedText(): FreedText {
  return lift<FreedText>(
    ['dupFreedText', 'formatCount', 'formatBytes', 'UNITS', 'DUP_FREED_MIN'],
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
  assert.match(dupFreedText(1, 500 * MB, 500 * MB + 900 * 1024), /hasn’t changed/,
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
  assert.match(cloud, /renderDupNote\(\)/, 'and the panel is repainted so it actually goes');
});
