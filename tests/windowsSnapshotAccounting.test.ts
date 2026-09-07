import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { STORAGE_SCRIPT, mapShadowStorage, parseInstallDate } from '../src/platform/windows/vss';
import { ELEVATE_HOW, NEEDS_ADMIN, measureWindowsSnapshots, windowsSnapshotsFrom } from '../src/services/snapshotAccounting';
import { CommandFailedError, CommandUnavailableError, runText } from '../src/platform/exec';

/**
 * Issue #33: on a Portuguese Windows, the Missing GB receipt and the Dashboard
 * could not size restore points, because snapshotAccounting.ts ran
 * `vssadmin list shadowstorage` and searched its output for the ENGLISH label
 * "Used Shadow Copy Storage space:" — a Portuguese Windows prints "Espaço de
 * armazenamento de cópias de sombra usado: 7,98 GB", with a comma for the
 * decimal point. vssadmin also refuses to run without administrator rights,
 * and the raw error text was shown as the reason.
 *
 * The measurement now goes through CIM (`Win32_ShadowStorage` for the bytes,
 * `Win32_ShadowCopy` for the count, `Win32_Volume` to scope both to one drive)
 * with `ConvertTo-Json`, like the rest of src/platform/windows: typed
 * properties, invariant names, no human text, no decimal separator. Elevation
 * is asked of Windows directly (IsInRole Administrator, a boolean) rather than
 * inferred from a translated error message; every refusal is carried as enum
 * names; and the reason a size is missing says what to do about it.
 *
 * ⚠ Not executed on Windows here: the mapping is pure and tested against the
 * shapes ConvertTo-Json produces (including the one the reporter posted); the
 * live round-trip is CI's — where, note, the runner is an administrator.
 */

const root = path.join(__dirname, '..');
const read = (...p: string[]) => readFileSync(path.join(root, ...p), 'utf8');

const VOL_C = '\\\\?\\Volume{cccc-0000}\\';
const VOL_D = '\\\\?\\Volume{dddd-0000}\\';
const VOLUMES = [{ DeviceID: VOL_C, DriveLetter: 'C:' }, { DeviceID: VOL_D, DriveLetter: 'D:' }];
const COPY_A = { ID: '{A}', VolumeName: VOL_C, InstallDate: '2026-09-01T10:00:00.0000000Z' };
const COPY_B = { ID: '{B}', VolumeName: VOL_C, InstallDate: null };
const COPY_D = { ID: '{D}', VolumeName: VOL_D, InstallDate: '2026-08-01T10:00:00Z' };
const STORE_C = { UsedSpace: 9335943168, AllocatedSpace: 9500000000, MaxSpace: 20000000000, Volume: VOL_C };
const STORE_D = { UsedSpace: 5000000000, AllocatedSpace: 6000000000, MaxSpace: 9000000000, Volume: VOL_D };
const DENIED = { id: 'HRESULT 0x80041003,Microsoft.Management.Infrastructure.CimCmdlets.GetCimInstanceCommand', category: 'PermissionDenied', native: 'AccessDenied', hresult: -2147217405 };
const BROKEN = { id: 'HRESULT 0x80041014,Microsoft.Management.Infrastructure.CimCmdlets.GetCimInstanceCommand', category: 'NotSpecified', native: 'ProviderFailure', hresult: -2147217388 };
/** The script's JSON for a healthy, elevated, two-drive PC; override what a case needs. */
const raw = (over: Record<string, unknown> = {}) => ({ elevated: true, volumes: VOLUMES, copies: [COPY_A, COPY_B, COPY_D], copiesFailure: null, storage: [STORE_C, STORE_D], failure: null, ...over });
const measured = (over: Record<string, unknown> = {}, mountPoint?: string) => windowsSnapshotsFrom(mapShadowStorage(raw(over)), mountPoint);

test('the Windows measurement is CIM + JSON, never the localised vssadmin table, and nothing in it can die unreported', () => {
  assert.match(STORAGE_SCRIPT, /Get-CimInstance -ClassName Win32_ShadowStorage -ErrorAction Stop -OperationTimeoutSec 10/);
  assert.match(STORAGE_SCRIPT, /Get-CimInstance -ClassName Win32_ShadowCopy -ErrorAction Stop -OperationTimeoutSec 10/);
  assert.match(STORAGE_SCRIPT, /Get-CimInstance -ClassName Win32_Volume/, 'the GUID → drive-letter map, so C: does not book D:’s storage');
  assert.match(STORAGE_SCRIPT, /try \{ \$elevated = \[bool\]\(\(\[Security\.Principal\.WindowsPrincipal\]/, 'the elevation probe is inside a try — ConstrainedLanguage mode forbids that type');
  assert.match(STORAGE_SCRIPT, /IsInRole\(\[Security\.Principal\.WindowsBuiltInRole\]::Administrator\)/, 'elevation is a boolean from Windows, not a translated error');
  assert.match(STORAGE_SCRIPT, /ToUniversalTime\(\)\.ToString\('o'\)/, 'dates leave as ISO text, not as PowerShell 5.1’s \\/Date(ms)\\/ wrapper');
  assert.match(STORAGE_SCRIPT, /e = \{ \$_\.Volume\.DeviceID \}/, 'each storage row names its volume');
  assert.match(STORAGE_SCRIPT, /ConvertTo-Json/);
  assert.doesNotMatch(STORAGE_SCRIPT, /vssadmin/);
  assert.equal((STORAGE_SCRIPT.match(/catch \{/g) ?? []).length, 5, 'the error reader, the probe, the map and both queries are each caught');
  // Comments may name vssadmin to say why it is not used; code may not.
  const service = read('src', 'services', 'snapshotAccounting.ts').replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
  assert.doesNotMatch(service, /vssadmin/, 'the human table is gone from the service');
  assert.doesNotMatch(service, /Used Shadow Copy Storage space/, 'and so is the English label');
  assert.doesNotMatch(service, /parseFloat/, 'no number is read out of prose any more');
});

test('parseInstallDate: ISO text, PowerShell 5.1’s wire format — bare or wrapped beside culture-formatted text — and nothing invented', () => {
  assert.equal(parseInstallDate('2026-09-01T10:00:00.0000000Z'), Date.parse('2026-09-01T10:00:00.0000000Z'));
  assert.equal(parseInstallDate('/Date(1756720800000)/'), 1756720800000, 'the 5.1 wire format, as JSON.parse hands it over');
  assert.equal(parseInstallDate('/Date(1756720800000+0100)/'), 1756720800000, 'an offset suffix is not part of the instant');
  assert.equal(parseInstallDate({ value: '/Date(1756720800000)/', DateTime: 'terça-feira, 1 de setembro de 2026 10:00:00' }), 1756720800000, 'the wrapper’s value, never its translated text');
  assert.equal(parseInstallDate({ value: undefined }), null);
  assert.equal(parseInstallDate('hoje'), null);
  assert.equal(parseInstallDate(null), null);
});

test('mapShadowStorage: an elevated two-drive PC — every field typed, every row naming its volume', () => {
  const m = mapShadowStorage(raw());
  assert.equal(m.elevated, true);
  assert.deepEqual(m.volumes, [{ deviceId: VOL_C, letter: 'C:' }, { deviceId: VOL_D, letter: 'D:' }]);
  assert.equal(m.copiesKnown, true);
  assert.deepEqual(m.copies.map((c) => [c.id, c.volume]), [['{A}', VOL_C], ['{B}', VOL_C], ['{D}', VOL_D]]);
  assert.equal(m.copies[0].takenAt, Date.parse(COPY_A.InstallDate), 'InstallDate is kept as a time');
  assert.equal(m.copies[1].takenAt, null, 'a missing date is null, not invented');
  assert.deepEqual(m.storage, [{ volume: VOL_C, usedBytes: 9335943168 }, { volume: VOL_D, usedBytes: 5000000000 }], 'the reporter’s own machine: ~9 GB on C:, as a number');
  assert.equal(m.failure, null);
  assert.equal(m.copiesFailure, null);
});

test('mapShadowStorage: ConvertTo-Json collapsing one result to an object changes nothing', () => {
  const m = mapShadowStorage(raw({ volumes: VOLUMES[0], copies: COPY_A, storage: STORE_C }));
  assert.equal(m.volumes.length, 1);
  assert.equal(m.copies.length, 1);
  assert.equal(m.storage!.length, 1);
});

test('mapShadowStorage: a UInt64 that arrives as a string still counts; one that is not a number leaves a hole in its row', () => {
  const m = mapShadowStorage(raw({ storage: [{ ...STORE_C, UsedSpace: '7' }, { ...STORE_D, UsedSpace: 'lots' }] }));
  assert.deepEqual(m.storage, [{ volume: VOL_C, usedBytes: 7 }, { volume: VOL_D, usedBytes: null }]);
  assert.deepEqual(mapShadowStorage(raw({ storage: [] })).storage, [], 'no associations reported is an answer, not an absence');
  assert.equal(mapShadowStorage(raw({ storage: null, failure: DENIED })).storage, null, 'a refused query is an absence');
});

test('mapShadowStorage: each refusal is carried as it came; a listing that failed is not an empty listing', () => {
  const m = mapShadowStorage(raw({ elevated: false, copies: null, copiesFailure: DENIED, storage: null, failure: DENIED }));
  assert.equal(m.elevated, false);
  assert.equal(m.copiesKnown, false);
  assert.deepEqual(m.copiesFailure, DENIED);
  assert.deepEqual(m.copies, []);
  assert.equal(m.storage, null);
  assert.deepEqual(m.failure, DENIED);
  assert.equal(mapShadowStorage(raw({ elevated: null })).elevated, null, 'a probe that could not run is unknown, not false');
  assert.equal(mapShadowStorage(raw({ elevated: 'yes' })).elevated, null, 'and so is anything that is not a boolean');
});

test('mapShadowStorage: nothing usable from PowerShell is reported as nothing — not as zero, not as "not elevated"', () => {
  for (const value of [[], null, undefined, 'garbage', 42]) {
    const m = mapShadowStorage(value);
    assert.equal(m.elevated, null, JSON.stringify(value));
    assert.equal(m.copiesKnown, false);
    assert.equal(m.storage, null);
    assert.ok(m.failure && m.copiesFailure, 'and says the output was unusable');
  }
});

test('windowsSnapshotsFrom: the Dashboard (no mount point) sees the whole PC; the receipt for a drive sees that drive alone', () => {
  const pc = measured();
  assert.equal(pc.available, true);
  assert.equal(pc.platform, 'win32');
  assert.deepEqual(pc.snapshots.map((s) => s.id), ['{A}', '{B}', '{D}']);
  assert.equal(pc.snapshots[0].date, new Date(Date.parse(COPY_A.InstallDate)).toISOString());
  assert.equal(pc.snapshots[1].date, null);
  assert.equal(pc.totalBytes, 9335943168 + 5000000000);
  assert.equal(pc.scope, undefined, 'nobody asked for a drive, so no scope is claimed');
  assert.equal(pc.canPurge, false, 'TreeMap never deletes restore points');
  assert.equal(pc.sizeReason, undefined);

  const c = measured({}, 'C:\\');
  assert.deepEqual(c.snapshots.map((s) => s.id), ['{A}', '{B}']);
  assert.equal(c.totalBytes, 9335943168, 'D:’s storage is not booked against C:');
  assert.equal(c.scope, 'volume');
  const d = measured({}, 'd:');
  assert.deepEqual(d.snapshots.map((s) => s.id), ['{D}']);
  assert.equal(d.totalBytes, 5000000000, 'a lower-case letter and no separator still find the drive');
  assert.equal(d.scope, 'volume');
});

test('windowsSnapshotsFrom: a drive Windows did not map falls back to the whole PC, and says so through scope', () => {
  const unknownLetter = measured({}, 'E:\\');
  assert.equal(unknownLetter.totalBytes, 9335943168 + 5000000000);
  assert.equal(unknownLetter.scope, 'machine');
  const noMap = measured({ volumes: [] }, 'C:\\');
  assert.equal(noMap.totalBytes, 9335943168 + 5000000000);
  assert.equal(noMap.scope, 'machine', 'without the GUID → letter map, nothing can be scoped honestly');
});

test('windowsSnapshotsFrom: not elevated and denied → the count is known, the size is not, and the reason says how to get it', () => {
  const acc = measured({ elevated: false, storage: null, failure: DENIED });
  assert.equal(acc.available, true, 'the tool ran; only the size is missing');
  assert.equal(acc.snapshots.length, 3);
  assert.equal(acc.totalBytes, null);
  assert.equal(acc.sizeReason, NEEDS_ADMIN);
  assert.match(NEEDS_ADMIN, /normally shows how much space restore points use only to an administrator/);
  assert.match(NEEDS_ADMIN, /right-click its icon in the system tray/, 'the steps, not the concept');
  assert.match(NEEDS_ADMIN, /choose Quit TreeMap/, 'the tray menu’s own label (electron/main.js)');
  assert.match(NEEDS_ADMIN, /Run as administrator/);
  assert.match(NEEDS_ADMIN, /administrator copy closes at once/, 'the trap: a copy still in the tray keeps the window, and the elevated one exits');
  assert.doesNotMatch(NEEDS_ADMIN, /0x8004|CimCmdlets|AccessDenied|elevat/, 'no provider text, no insider words');
  assert.ok(NEEDS_ADMIN.endsWith(ELEVATE_HOW), 'the same instruction every Windows sentence uses');
});

test('windowsSnapshotsFrom: elevating is advised only when a denial, or plain silence unelevated, says it would help', () => {
  const unelevatedNoReason = measured({ elevated: false, storage: null, failure: null });
  assert.equal(unelevatedNoReason.sizeReason, NEEDS_ADMIN, 'refused without a word while not an administrator: rights are the likeliest cause');
  const unelevatedBroken = measured({ elevated: false, storage: null, failure: BROKEN });
  assert.match(unelevatedBroken.sizeReason ?? '', /would not report the space its restore points hold \(ProviderFailure\)/);
  assert.doesNotMatch(unelevatedBroken.sizeReason ?? '', /administrator/i, 'a broken provider is not cured by elevating');
  const unknownDenied = measured({ elevated: null, storage: null, failure: DENIED });
  assert.equal(unknownDenied.sizeReason, NEEDS_ADMIN, 'elevation unknown, but the denial itself says what would help');
  const unknownSilent = measured({ elevated: null, storage: null, failure: null });
  assert.match(unknownSilent.sizeReason ?? '', /would not report/);
  assert.doesNotMatch(unknownSilent.sizeReason ?? '', /administrator/i, 'with neither fact, do not send anyone to elevate');
  const adminDenied = measured({ elevated: true, storage: null, failure: DENIED });
  assert.match(adminDenied.sizeReason ?? '', /would not report the space its restore points hold \(AccessDenied\)/);
  assert.doesNotMatch(adminDenied.sizeReason ?? '', /administrator/i, 'already an administrator — do not send the user round again');
  for (const acc of [unelevatedBroken, unknownSilent, adminDenied]) assert.equal(acc.totalBytes, null);
});

test('windowsSnapshotsFrom: an empty storage list is a zero only from an administrator whose listing also found nothing', () => {
  const adminNone = measured({ storage: [], copies: [] });
  assert.equal(adminNone.totalBytes, 0, 'no restore points and no storage, said by someone Windows tells everything: a measured zero');
  assert.deepEqual(adminNone.snapshots, []);
  const userNone = measured({ elevated: false, storage: [], copies: [] });
  assert.equal(userNone.totalBytes, null, 'a standard user may simply be shown nothing — not a measurement');
  assert.match(userNone.sizeReason ?? '', /may not be the whole picture/);
  assert.ok(userNone.sizeReason!.endsWith(ELEVATE_HOW));
  const userPoints = measured({ elevated: false, storage: [], copies: [COPY_A] });
  assert.equal(userPoints.totalBytes, null);
  assert.equal(userPoints.sizeReason, NEEDS_ADMIN, 'restore points listed but no storage shown: the usual unelevated silence');
  const userTrusted = measured({ elevated: false, storage: [STORE_C], copies: [COPY_A] }, 'C:\\');
  assert.equal(userTrusted.totalBytes, 9335943168, 'a number Windows did hand over unelevated is a number');
  const adminPoints = measured({ storage: [], copies: [COPY_A, COPY_B] });
  assert.equal(adminPoints.totalBytes, null);
  assert.match(adminPoints.sizeReason ?? '', /lists 2 restore points but reported no storage/, 'elevated, that is a contradiction worth saying');
});

test('windowsSnapshotsFrom: a storage list TreeMap cannot add up is unknown, and says so', () => {
  const acc = measured({ storage: [STORE_C, { ...STORE_D, UsedSpace: 'lots' }] });
  assert.equal(acc.totalBytes, null);
  assert.match(acc.sizeReason ?? '', /could not add up/);
  const scoped = measured({ storage: [STORE_C, { ...STORE_D, UsedSpace: 'lots' }] }, 'C:\\');
  assert.equal(scoped.totalBytes, 9335943168, 'a hole on another drive does not spoil this drive’s figure');
});

test('windowsSnapshotsFrom: a listing that failed is never an empty listing', () => {
  const nothing = measured({ elevated: false, copies: null, copiesFailure: DENIED, storage: null, failure: DENIED });
  assert.equal(nothing.available, false, 'neither query answered: nothing was measured');
  assert.match(nothing.reason ?? '', /would not list its restore points \(AccessDenied\)/);
  assert.ok(nothing.reason!.includes(NEEDS_ADMIN), 'and, denied while not an administrator, what to do');
  const adminNothing = measured({ copies: null, copiesFailure: BROKEN, storage: null, failure: BROKEN });
  assert.match(adminNothing.reason ?? '', /would not list its restore points \(ProviderFailure\)/);
  assert.doesNotMatch(adminNothing.reason ?? '', /administrator/i);
  const bytesOnly = measured({ copies: null, copiesFailure: BROKEN });
  assert.equal(bytesOnly.available, true);
  assert.equal(bytesOnly.totalBytes, 9335943168 + 5000000000, 'the bytes were measured even though the list was not');
  assert.deepEqual(bytesOnly.snapshots, [], 'and no restore point is invented');
  const garbage = windowsSnapshotsFrom(mapShadowStorage([]));
  assert.equal(garbage.available, false);
  assert.match(garbage.reason ?? '', /would not list its restore points/);
  assert.doesNotMatch(garbage.reason ?? '', /administrator/i, 'an unreadable answer says nothing about rights');
});

test('windowsSnapshotsFrom: a measured figure is kept even when no restore point is listed at that moment', () => {
  const acc = measured({ copies: [], storage: [STORE_C] }, 'C:\\');
  assert.deepEqual(acc.snapshots, []);
  assert.equal(acc.totalBytes, 9335943168, 'storage in use with nothing listed: the number stands, and the receipt must not turn it into a zero');
});

test('measureWindowsSnapshots: PowerShell missing or failing costs the line, with a plain reason, never a crash; the mount point is passed through', async () => {
  const missing = await measureWindowsSnapshots(() => Promise.reject(new CommandUnavailableError('powershell.exe', 'PowerShell is not available')));
  assert.equal(missing.available, false);
  assert.equal(missing.platform, 'win32');
  assert.match(missing.reason ?? '', /could not ask Windows about restore points/);
  assert.match(missing.reason ?? '', /PowerShell is not available/, 'the real cause follows');
  const ok = await measureWindowsSnapshots(() => Promise.resolve(raw()), 'D:\\');
  assert.equal(ok.available, true);
  assert.equal(ok.totalBytes, 5000000000, 'D:’s own figure');
  assert.equal(ok.scope, 'volume');
});

test('runText: a command that had to be killed says how long it was given, not its whole command line', async () => {
  await assert.rejects(
    runText(process.execPath, ['-e', 'setTimeout(function () {}, 20000)'], { timeoutMs: 300 }),
    (err: unknown) => {
      assert.ok(err instanceof CommandFailedError);
      assert.match(err.message, /did not answer within 0 s$|did not answer within \d+ s$/);
      assert.doesNotMatch(err.message, /setTimeout/, 'the script itself is not the message');
      assert.equal(err.exitCode, null);
      return true;
    },
  );
});

/* ═══════════════════ The words, per platform ═══════════════════ */

import { refusedPermissionNote, sparseLine } from '../src/services/missingGigabytes';
import { verdictFor } from '../src/services/allocationAccountant';
import { ffmpegInstallHint } from '../src/services/compressionAdvisor';

const UI = (part: string) => read('src', 'ui', 'app', part);

/** Evaluate platformWord from the prelude against a fake page state. */
function platformWordFor(platform: string | undefined) {
  const src = UI('000-prelude.js');
  const at = src.indexOf('function platformWord(');
  assert.notEqual(at, -1, 'the prelude defines platformWord');
  const end = src.indexOf('\n}\n', at);
  const fn = src.slice(at, end + 3);
  const state = platform === undefined ? undefined : { system: { platform } };
  return new Function('state', `'use strict'; ${fn} return platformWord;`)(state) as (words: Record<string, string>) => string;
}

/** Every `platformWord({ … })` table in a UI part, evaluated to plain objects. */
function wordTables(part: string): Record<string, string>[] {
  const src = UI(part);
  const tables: Record<string, string>[] = [];
  const re = /platformWord\(\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < src.length && depth > 0; i++) {
      if (src[i] === '{') depth += 1;
      else if (src[i] === '}') depth -= 1;
    }
    tables.push(new Function(`'use strict'; return ({${src.slice(m.index + m[0].length, i - 1)}});`)() as Record<string, string>);
  }
  assert.ok(tables.length > 0, `${part} uses platformWord`);
  return tables;
}

test('platformWord: the page picks the word for the OS /api/system named, and a neutral one before it answers', () => {
  const words = { darwin: 'This Mac', win32: 'This PC', other: 'This computer' };
  assert.equal(platformWordFor('darwin')(words), 'This Mac');
  assert.equal(platformWordFor('win32')(words), 'This PC');
  assert.equal(platformWordFor('linux')(words), 'This computer', 'an OS the table does not name gets the neutral word');
  assert.equal(platformWordFor(undefined)(words), 'This computer', 'before /api/system has answered, nothing is a Mac');
  assert.equal(platformWordFor('win32')({ darwin: 'a', win32: 'b', linux: 'c', other: 'd' }), 'b');
  assert.equal(platformWordFor('linux')({ darwin: 'a', win32: 'b', linux: 'c', other: 'd' }), 'c', 'a named Linux word wins over the neutral one');
});

test('every word table names all three homes: a Mac sentence, a Windows sentence, and a neutral one', () => {
  const parts = ['035-system-info.js', '120-cloud-accounts.js', '030-held-up-space.js', '180-quick-look-preview-pane.js', '170-guided-first-run.js'];
  for (const part of parts) {
    for (const table of wordTables(part)) {
      assert.ok('darwin' in table && 'win32' in table && 'other' in table, `${part}: ${JSON.stringify(table)}`);
      assert.doesNotMatch(table.win32, /\bMac\b|macOS|Time Machine|Finder|Full Disk Access/, `${part}: the Windows word must not name a Mac thing: ${table.win32}`);
      assert.doesNotMatch(table.other, /\bMac\b|macOS|Time Machine|Finder|Full Disk Access|Windows/, `${part}: the neutral word names no OS: ${table.other}`);
    }
  }
});

test('Dashboard: the snapshot row speaks of restore points on Windows and of Time Machine only on a Mac', () => {
  const [noun, hint] = wordTables('035-system-info.js');
  assert.equal(noun.win32, 'restore point');
  assert.equal(noun.darwin, 'local snapshot');
  assert.match(hint.darwin, /Time Machine recreates these/);
  assert.match(hint.win32, /Space held by Windows restore points \(Windows calls them shadow copies\)/);
  assert.match(hint.win32, /TreeMap does not delete them/, 'the purge button is macOS-only, and so is the sentence that justifies it');
  assert.match(UI('035-system-info.js'), /\+ \(s\.sizeReason \? ` \$\{s\.sizeReason\}` : ''\)/, 'when Windows withheld the size, the hint says why and what to do');
  assert.match(UI('035-system-info.js'), /\(s\.snapshots && s\.snapshots\.length > 0\) \|\| s\.totalBytes > 0/, 'a measured figure shows even when no restore point is listed');
});

test('All Storage: the local disk is "This PC" on Windows, "This Mac" on a Mac, "This computer" elsewhere', () => {
  const [label] = wordTables('120-cloud-accounts.js');
  assert.deepEqual(label, { darwin: 'This Mac', win32: 'This PC', other: 'This computer' });
  assert.doesNotMatch(UI('120-cloud-accounts.js'), /"nm">This Mac</, 'the bare label is gone');
});

test('the restart dialog, the provenance line and the first-run card name the OS they run on', () => {
  const [restart] = wordTables('030-held-up-space.js');
  assert.match(restart.darwin, /reopen Mac apps/);
  assert.match(restart.win32, /does not reopen programs on Windows/);
  const [records] = wordTables('180-quick-look-preview-pane.js');
  assert.deepEqual(records, { darwin: 'this Mac', win32: 'Windows', other: 'this computer' });
  const [refused] = wordTables('170-guided-first-run.js');
  assert.match(refused.darwin, /^macOS would not let TreeMap look inside this folder$/);
  assert.match(refused.win32, /^Windows would not let TreeMap look inside this folder$/);
  assert.equal((UI('170-guided-first-run.js').match(/refusedFolderWords\(\) \+/g) ?? []).length, 2, 'both first-run cards share the one table');
});

test('no UI part still carries a bare Mac sentence outside a word table', () => {
  const parts = ['035-system-info.js', '120-cloud-accounts.js', '030-held-up-space.js', '180-quick-look-preview-pane.js', '170-guided-first-run.js'];
  for (const part of parts) {
    const stripped = UI(part).replace(/platformWord\(\{[\s\S]*?\}\)/g, '').replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
    assert.doesNotMatch(stripped, /This Mac|Time Machine recreates|reopen Mac apps|this Mac records|macOS would not let/, `${part} still says it unconditionally`);
  }
});

test('server: the refusal note, the sparse-files detail and the allocation verdict speak the platform’s language', () => {
  assert.match(refusedPermissionNote(3, 'darwin'), /^3 refused permission — granting Full Disk Access/);
  assert.match(refusedPermissionNote(3, 'win32'), /^3 refused permission — running TreeMap as an administrator may let Windows read more of these\. /);
  assert.ok(refusedPermissionNote(3, 'win32').endsWith(ELEVATE_HOW), 'the one shared instruction, tray steps included');
  assert.match(refusedPermissionNote(1, 'linux'), /^1 refused permission — they belong to another user or to the system, so this account is not allowed to read them\.$/);
  assert.equal(refusedPermissionNote(2, 'freebsd'), '2 refused permission.');

  const scan = { engine: 'walker', sparseFiles: 1, sparseBytes: 4096, slackBytes: 0 } as unknown as Parameters<typeof sparseLine>[0];
  assert.match(sparseLine(scan, 'win32').detail, /Windows can store files compressed/);
  assert.match(sparseLine(scan, 'win32').detail, /ext4\.vhdx/, 'the usual reserving file on Windows, not Docker for Mac’s');
  assert.doesNotMatch(sparseLine(scan, 'win32').detail, /macOS|Docker\.raw|NTFS/);
  assert.match(sparseLine(scan, 'darwin').detail, /macOS stores many files compressed/);
  assert.match(sparseLine(scan, 'darwin').detail, /Docker\.raw/);
  assert.match(sparseLine(scan, 'linux').detail, /some filesystems store files compressed/);
  assert.doesNotMatch(sparseLine(scan, 'linux').detail, /macOS|Docker\.raw|Windows/);

  assert.match(verdictFor(10, 5, 'darwin'), /Finder’s duplicate command/);
  assert.match(verdictFor(10, 5, 'win32'), /files Windows stores compressed, OneDrive files kept online-only/);
  assert.doesNotMatch(verdictFor(10, 5, 'win32'), /Finder|hard links/, 'hard links are one file under several names, not copies that diverge');
  assert.match(verdictFor(10, 5, 'linux'), /Btrfs, XFS or ZFS/);
  assert.doesNotMatch(verdictFor(10, 5, 'freebsd'), /Finder|OneDrive|Btrfs/, 'an OS with no example of its own gets the neutral sentence');
  assert.match(verdictFor(10, 5, 'freebsd'), /share storage with each other, or take less room/);
  assert.equal(verdictFor(0, 0, 'win32'), verdictFor(0, 0, 'darwin'), 'the two calm verdicts are the same everywhere');
  assert.match(ffmpegInstallHint('darwin'), /Homebrew/);
  assert.match(ffmpegInstallHint('win32'), /winget install Gyan\.FFmpeg/);
  assert.doesNotMatch(ffmpegInstallHint('win32'), /Homebrew|Mac/);
  assert.match(ffmpegInstallHint('linux'), /your distribution/);
  assert.match(ffmpegInstallHint('freebsd'), /package manager/);
});

test('windowsSnapshotsFrom: a storage list TreeMap cannot add up is unknown, and says so', () => {
  const acc = windowsSnapshotsFrom(mapShadowStorage({ elevated: true, copies: [COPY_A], storage: [{ UsedSpace: 'lots' }], failure: null }));
  assert.equal(acc.totalBytes, null);
  assert.match(acc.sizeReason ?? '', /could not add up/);
});

test('CHANGELOG records the fix under the version that ships it', () => {
  const changelog = read('CHANGELOG.md');
  const version = (JSON.parse(read('package.json')) as { version: string }).version;
  const at = changelog.indexOf(`## [${version}]`);
  assert.notEqual(at, -1);
  const top = changelog.slice(at, changelog.indexOf('\n## [', at + 1));
  assert.match(top, /issues\/33/);
  assert.match(top, /measured in every language, and without\s+guessing/, 'the claim itself, not a word that also appears in the next bullet');
  assert.match(top, /`vssadmin`/, 'names what was wrong');
  assert.match(top, /system\s+tray/, 'the elevation trap is in the release notes too');
  assert.match(top, /This\s+Mac/, 'names the label that was wrong');
});
