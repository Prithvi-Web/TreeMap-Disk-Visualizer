import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

import { isolatedDataDir } from './fixtures/dataDir';
const DATA = isolatedDataDir('treemap-undoVaultSavedWording-data-');
process.env.TREEMAP_NO_GDU = '1';

import { getCapsuleIndex } from '../src/services/timeCapsule';
import { listRuns } from '../src/services/autopilot';
import { LEGACY_PHRASES } from '../src/services/legacyWording';

/**
 * Review F1.2 of the Undo Vault rename. The sentences TreeMap saved before 5.2.0 — an Undo Vault
 * event's `detail`, an Autopilot run's `blockedReason` and `skipped[].reason` — still name the
 * feature by its old name on disk, and the page shows them as they are served: the Undo Vault tab's
 * "What the Undo Vault couldn't keep" list and the Autopilot run history. They are served in
 * today's words now, rewritten as they are read; the saved files are never changed.
 *
 * Only TreeMap's own phrases are rewritten. Every fixture below also carries the old words where
 * they are the user's own — a sparse bundle named after Apple's backup drive, a path on one, a
 * policy's name, a query, a note's folder, an error the system wrote — and those are served exactly
 * as saved: renaming them would make a true sentence false.
 *
 * Each saved sentence is word for word what a released or earlier build wrote (v5.0.1, and the
 * builds up to REL-79 10bfc29d); each expected one is what TreeMap writes now.
 */

const AT = Date.parse('2026-10-01T12:00:00Z');
const TRASH_SAID = 'The operation couldn’t be completed. (OSStatus error -8013.)';
const INDEX_UNREADABLE_REST =
  'record of a file it is holding. Do NOT delete or move it — the recovery folders beside it are ' +
  'named by entries in that file, and without it they cannot be matched to anything. A copy of the ' +
  'unreadable file is kept alongside it with a .corrupt suffix.';

/** [as saved, as served] for each event's detail. */
const EVENT_DETAILS: [string, string][] = [
  ['Removed from the Time Capsule to make room for Time Capsule Backup.sparsebundle. It can no longer be restored from here.',
    'Removed from the Undo Vault to make room for Time Capsule Backup.sparsebundle. It can no longer be restored from here.'],
  ['Kept for 30 days, then removed from the Time Capsule.',
    'Kept for 30 days, then removed from the Undo Vault.'],
  ["It could not be copied into the Time Capsule (EACCES: permission denied, open '/Volumes/Time Capsule/Data/a.mov'), so it was left alone.",
    "It could not be copied into the Undo Vault (EACCES: permission denied, open '/Volumes/Time Capsule/Data/a.mov'), so it was left alone."],
  ['Its copy is missing from the Time Capsule folder, so it can no longer be restored.',
    'Its copy is missing from the Undo Vault’s folder, so it can no longer be restored.'],
  ['That Time Capsule record is not one TreeMap made (its id is not one TreeMap gives), so it holds no copy that could be restored.',
    'That Undo Vault record is not one TreeMap made (its id is not one TreeMap gives), so it holds no copy that could be restored.'],
  ['Protecting it needs 12 GB, but the Time Capsule can only hold 5 GB. It was left alone rather than deleted without a backup.',
    'Protecting it needs 12 GB, but the Undo Vault can only hold 5 GB. It was left alone rather than deleted without a backup.'],
  // Already in today's words, and one that never named the feature: served as saved.
  ['Removed from the Undo Vault to make room for x.zip. It can no longer be restored from here.',
    'Removed from the Undo Vault to make room for x.zip. It can no longer be restored from here.'],
  ['It was left alone rather than deleted without a backup.', 'It was left alone rather than deleted without a backup.'],
];

/** [as saved, as served] for each skipped item's reason. */
const SKIPPED_REASONS: [string, string][] = [
  ['its Time Capsule copy is no longer there, and nothing is deleted without one',
    'its Undo Vault copy is no longer there, and nothing is deleted without one'],
  ["its Time Capsule copy could not be looked at (EIO: i/o error, lstat '/Volumes/Time Capsule/x'), and nothing is deleted without a copy that was seen",
    "its Undo Vault copy could not be looked at (EIO: i/o error, lstat '/Volumes/Time Capsule/x'), and nothing is deleted without a copy that was seen"],
  ["its Time Capsule copy's record is not one TreeMap wrote, and nothing is deleted without a copy that was seen",
    "its Undo Vault copy's record is not one TreeMap wrote, and nothing is deleted without a copy that was seen"],
  ['its Time Capsule copy is incomplete (2 of 40 files are missing), and nothing is deleted without a whole copy',
    'its Undo Vault copy is incomplete (2 of 40 files are missing), and nothing is deleted without a whole copy'],
  [`The Trash reported: ${TRASH_SAID}. TreeMap could not confirm whether it is still in place, so its Time Capsule copy was kept — an undo puts it back only if it is gone.`,
    `The Trash reported: ${TRASH_SAID}. TreeMap could not confirm whether it is still in place, so its Undo Vault copy was kept — an undo puts it back only if it is gone.`],
  ['Protecting it needs 12 GB, but the Time Capsule can only hold 5 GB. It will be left alone rather than deleted without a backup.',
    'Protecting it needs 12 GB, but the Undo Vault can only hold 5 GB. It will be left alone rather than deleted without a backup.'],
  ['It could not be copied into the Time Capsule (ENOSPC: no space left on device), so it was left alone.',
    'It could not be copied into the Undo Vault (ENOSPC: no space left on device), so it was left alone.'],
  ['The Time Capsule folder can’t be created (EACCES: permission denied), so automatic deletions cannot be protected.',
    'The Undo Vault’s folder can’t be created (EACCES: permission denied), so automatic deletions cannot be protected.'],
  ['TreeMap did not hand it to the Trash: it is open in Preview. It is still in place, untouched. Discarding its copy did not finish, so the Time Capsule may still list it.',
    'TreeMap did not hand it to the Trash: it is open in Preview. It is still in place, untouched. Discarding its copy did not finish, so the Undo Vault may still list it.'],
  // The user's own words: a query, a note's folder, a rule's description. Served as saved.
  ['matched your query: name:"Time Capsule" size>1gb', 'matched your query: name:"Time Capsule" size>1gb'],
  ['Left alone — your note on /Volumes/Time Capsule pauses automatic cleanup around it (3 matched items).',
    'Left alone — your note on /Volumes/Time Capsule pauses automatic cleanup around it (3 matched items).'],
];

/** [as saved, as served] for each run's blockedReason. */
const BLOCKED_REASONS: [string, string][] = [
  ['Discarding the Time Capsule copies of the 2 items the Trash refused did not finish (EIO: i/o error), so the Time Capsule may still list them. ' +
    'Everything listed as trashed was trashed, and can be put back until the Time Capsule removes its copies ' +
    '(after 30 days by default, or sooner to stay under its size cap).',
  'Discarding the Undo Vault copies of the 2 items the Trash refused did not finish (EIO: i/o error), so the Undo Vault may still list them. ' +
    'Everything listed as trashed was trashed, and can be put back until the Undo Vault removes its copies ' +
    '(after 30 days by default, or sooner to stay under its size cap).'],
  ['Nothing was deleted — the delete stopped: The Time Capsule index (timecapsule.json, in TreeMap\'s app-data folder) could not be read (Unexpected end of JSON input). ' +
    'TreeMap will not change the capsule until it is repaired, because every entry in it is the only ' + INDEX_UNREADABLE_REST,
  'Nothing was deleted — the delete stopped: The Undo Vault index (timecapsule.json, in TreeMap\'s app-data folder) could not be read (Unexpected end of JSON input). ' +
    'TreeMap will not change the Undo Vault until it is repaired, because every entry in it is the only ' + INDEX_UNREADABLE_REST],
  // A failed scan of a folder on Apple's backup drive: the system's words, served as saved.
  ["ENOENT: no such file or directory, scandir '/Volumes/Time Capsule/Backups'", "ENOENT: no such file or directory, scandir '/Volumes/Time Capsule/Backups'"],
  ['Waiting out its cooldown — next run in about 3 days.', 'Waiting out its cooldown — next run in about 3 days.'],
];

function event(i: number, detail: string): Record<string, unknown> {
  return { at: AT - i * 1000, kind: 'evicted', name: `Time Capsule ${i}.zip`, originalPath: `/Volumes/Time Capsule/Time Capsule ${i}.zip`, sizeBytes: 1_000_000 * (i + 1), detail };
}

function run(i: number, blockedReason: string | undefined, reasons: string[]): Record<string, unknown> {
  return {
    id: `run-${i}`, policyId: 'p1', policyName: 'Clear the Time Capsule share', at: AT - i * 1000, mode: 'live', status: 'blocked',
    ...(blockedReason === undefined ? {} : { blockedReason }),
    items: [{ path: '/Volumes/Time Capsule/old.dmg', name: 'old.dmg', bytes: 1, reason: 'matched your query: path:"Time Capsule"' }],
    bytesMatched: 1, bytesDeleted: 0,
    skipped: reasons.map((reason, j) => ({ path: `/Volumes/Time Capsule/item-${j}`, reason })),
  };
}

const CAPSULE_FILE = path.join(DATA, 'timecapsule.json');
const AUTOPILOT_FILE = path.join(DATA, 'autopilot.json');
writeFileSync(CAPSULE_FILE, JSON.stringify({ version: 1, entries: [], events: EVENT_DETAILS.map(([saved], i) => event(i, saved)) }, null, 2));
writeFileSync(AUTOPILOT_FILE, JSON.stringify({
  version: 1,
  policies: [],
  runs: [
    ...BLOCKED_REASONS.map(([saved], i) => run(i, saved, i === 0 ? SKIPPED_REASONS.map(([s]) => s) : [])),
    run(BLOCKED_REASONS.length, undefined, ['left for a later run — this run\'s limit of 1 GB was reached']),
  ],
}, null, 2));
const CAPSULE_BYTES = readFileSync(CAPSULE_FILE);
const AUTOPILOT_BYTES = readFileSync(AUTOPILOT_FILE);

test('the Undo Vault tab is served each saved event in today\'s words, the user\'s own names as they were saved', async () => {
  const { events } = await getCapsuleIndex();
  assert.deepEqual(events.map((e) => e.detail), EVENT_DETAILS.map(([, served]) => served));
  assert.deepEqual(events.map((e) => [e.name, e.originalPath]), EVENT_DETAILS.map((_, i) => [`Time Capsule ${i}.zip`, `/Volumes/Time Capsule/Time Capsule ${i}.zip`]),
    'a name and a path are the user\'s, never rewritten');
});

test('the Autopilot run history is served each saved reason in today\'s words, the user\'s own words as they were saved', async () => {
  const runs = await listRuns(50);
  assert.deepEqual(runs.map((r) => r.blockedReason), [...BLOCKED_REASONS.map(([, served]) => served), undefined]);
  assert.deepEqual(runs[0].skipped.map((s) => s.reason), SKIPPED_REASONS.map(([, served]) => served));
  assert.deepEqual(runs[0].skipped.map((s) => s.path), SKIPPED_REASONS.map((_, j) => `/Volumes/Time Capsule/item-${j}`));
  assert.ok(runs.every((r) => r.policyName === 'Clear the Time Capsule share'), 'a policy\'s name is the user\'s');
  assert.ok(runs.every((r) => r.items[0].reason === 'matched your query: path:"Time Capsule"'), 'an item\'s reason quotes the user\'s query');
  assert.deepEqual(runs[BLOCKED_REASONS.length].skipped, [{ path: '/Volumes/Time Capsule/item-0', reason: 'left for a later run — this run\'s limit of 1 GB was reached' }],
    'a run that never named the feature is served as saved');
});

/** The text of every string literal and template piece in src/services, legacyWording.ts left out. */
function stringsTreeMapWritesToday(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) { walk(full); continue; }
      if (!name.endsWith('.ts') || name === 'legacyWording.ts') continue;
      const sf = ts.createSourceFile(full, readFileSync(full, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      const visit = (n: ts.Node): void => {
        if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)
          || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) out.push(n.text);
        ts.forEachChild(n, visit);
      };
      visit(sf);
    }
  };
  walk(path.join(__dirname, '..', 'src', 'services'));
  return out;
}

test('each phrase rewritten is one an earlier build wrote under the old name, is shown served above, and becomes words TreeMap writes today', () => {
  const saved = [...EVENT_DETAILS, ...SKIPPED_REASONS, ...BLOCKED_REASONS].map(([s]) => s);
  const today = stringsTreeMapWritesToday();
  assert.ok(LEGACY_PHRASES.length >= 18, `the pairs are there (${LEGACY_PHRASES.length})`);
  for (const [before, now] of LEGACY_PHRASES) {
    assert.match(before, /Time Capsule|the capsule/, `"${before}" names the feature by its old name`);
    assert.doesNotMatch(now, /time capsule|\bcapsule\b/i, `"${now}" does not`);
    assert.match(now, /Undo Vault/, `"${now}" names the Undo Vault`);
    assert.ok(saved.some((s) => s.includes(before)), `a saved sentence above shows "${before}" served in today's words`);
    assert.ok(today.some((lit) => lit.includes(now)), `"${now}" is how TreeMap words it today (a string in src/services)`);
  }
});

test('reading rewrites nothing on disk: the saved files are byte for byte what they were', async () => {
  await getCapsuleIndex();
  await listRuns(50);
  assert.ok(readFileSync(CAPSULE_FILE).equals(CAPSULE_BYTES), 'the Undo Vault index on disk is unchanged');
  assert.ok(readFileSync(AUTOPILOT_FILE).equals(AUTOPILOT_BYTES), 'the Autopilot record on disk is unchanged');
});
