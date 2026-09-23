import { test } from 'node:test';
import assert from 'node:assert/strict';

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { elevationRefusal, unpackedPath } from '../src/services/scan/mftHelperPath';
import { MFT_HELPER_FILE, mftHelperCandidates } from '../src/services/scan/nativeEngine';

/**
 * The NTFS turbo mode's helper is an executable the app asks Windows to start
 * elevated (`Start-Process -Verb RunAs`). In a packaged app the path the code
 * computes runs through `resources\app.asar`, which only Electron's own `fs`
 * can see into; Windows and PowerShell cannot, so the helper would never
 * start. The release unpacks `native/prebuilt` beside the archive
 * (`asarUnpack` in package.json), and `unpackedPath` turns the one path into
 * the other.
 */

test('a path through app.asar becomes the same path through app.asar.unpacked, whichever separator it uses', () => {
  assert.equal(
    unpackedPath('C:\\Program Files\\TreeMap\\resources\\app.asar\\native\\prebuilt\\win32-x64\\tm-mft-helper.exe'),
    'C:\\Program Files\\TreeMap\\resources\\app.asar.unpacked\\native\\prebuilt\\win32-x64\\tm-mft-helper.exe',
  );
  assert.equal(
    unpackedPath('/Applications/TreeMap.app/Contents/Resources/app.asar/native/prebuilt/darwin-arm64/x'),
    '/Applications/TreeMap.app/Contents/Resources/app.asar.unpacked/native/prebuilt/darwin-arm64/x',
  );
});

test('any other path is left exactly as it is', () => {
  for (const p of [
    'C:\\dev\\TreeMap\\native\\prebuilt\\win32-x64\\tm-mft-helper.exe', // a checkout
    'C:\\app\\resources\\app.asar.unpacked\\native\\tm-mft-helper.exe', // already unpacked
    'C:\\app\\resources\\my-app.asar\\native\\tm-mft-helper.exe', // another archive's name
    'C:\\app\\resources\\app.asarx\\native\\tm-mft-helper.exe', // a longer name
    'C:\\app\\resources\\app_asar\\native\\tm-mft-helper.exe', // a name the dot must not match
    'C:\\app\\resources\\app.asar', // the archive itself, nothing inside it
    '',
  ]) {
    assert.equal(unpackedPath(p), p, p);
  }
});

test('in a packaged app the helper is looked for under app.asar.unpacked, where Windows can start it', () => {
  const resources = path.join(path.sep === '\\' ? 'C:\\' : '/', 'TreeMap', 'resources');
  const [first, second] = mftHelperCandidates(path.join(resources, 'app.asar'), resources);
  assert.equal(first, path.join(resources, 'app.asar.unpacked', 'native', 'prebuilt', `${process.platform}-${process.arch}`, MFT_HELPER_FILE));
  assert.equal(second, path.join(resources, 'native', MFT_HELPER_FILE));
});

test('in a checkout the helper is looked for beside the prebuilt module, as it is', () => {
  const checkout = path.join(path.sep === '\\' ? 'C:\\' : '/', 'dev', 'TreeMap');
  const candidates = mftHelperCandidates(checkout, undefined);
  assert.deepEqual(candidates, [path.join(checkout, 'native', 'prebuilt', `${process.platform}-${process.arch}`, MFT_HELPER_FILE)]);
});

/**
 * What may be started as administrator on this user's say-so: only a program
 * no process running as this user could have changed — the third security
 * review of M6 found the helper (and PowerShell, found by bare name) in a
 * per-user install's own folder, where any malware running as the user could
 * swap them the moment before the person clicks yes. Tried, never inferred.
 */

test('a program in a folder that takes this user’s new files is refused, and the probe leaves nothing behind', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-elevation-'));
  try {
    const helper = path.join(dir, 'tm-mft-helper.exe');
    fs.writeFileSync(helper, 'stand-in');
    const writable = elevationRefusal(helper);
    assert.equal(writable, `the folder ${dir} lets any program running as you add or replace files in it`);
    assert.deepEqual(fs.readdirSync(dir), ['tm-mft-helper.exe'], 'the probe was removed');

    assert.match(elevationRefusal(path.join(dir, 'gone.exe')) ?? '', /gone\.exe could not be checked: ENOENT/);
    const link = path.join(dir, 'link.exe');
    fs.symlinkSync(helper, link);
    assert.equal(elevationRefusal(link), `${link} is a link, and what it leads to was not checked`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('in a folder that refuses new files, a program this user could still change is refused, read-only or not', { skip: (process.platform === 'win32' && 'Windows ignores a folder’s mode bits') || (process.getuid?.() === 0 && 'root may write anywhere') }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-elevation-'));
  const helper = path.join(dir, 'tm-mft-helper.exe');
  fs.writeFileSync(helper, 'stand-in');
  try {
    fs.chmodSync(dir, 0o555);
    assert.equal(elevationRefusal(helper), `${helper} could be changed by any program running as you`);
    // Read-only by mode is no protection: its owner may lift it.
    fs.chmodSync(helper, 0o444);
    assert.equal(elevationRefusal(helper), `${helper} could be changed by any program running as you`);
    assert.equal(fs.statSync(helper).mode & 0o777, 0o444, 'the no-op chmod left the mode as it was');
  } finally {
    fs.chmodSync(dir, 0o755);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * A Windows tool by its full path. CI runs these tests under Git's bash,
 * whose PATH puts Git's own tools first, and Node looks a bare name up in the
 * current folder and then PATH, never System32 first: a bare `whoami` there
 * is GNU's, which answers `/groups` with "extra operand" (the CI dry run of
 * 23 Sep 2026, which found it likely that the first Windows run's elevation
 * check read no groups for this reason: the next run will show).
 */
function system32(tool: string): string {
  return path.win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', tool);
}

/** `whoami /groups`; off Windows ''; and when it fails, why, so the failure is read rather than taken for "no groups". */
function windowsGroups(): string {
  if (process.platform !== 'win32') return '';
  try {
    return execFileSync(system32('whoami.exe'), ['/groups'], { encoding: 'utf8' });
  } catch (err) {
    return `whoami /groups failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/**
 * Whether this process holds a Windows administrator's full token: the high
 * or system mandatory level, or the Administrators group (S-1-5-32-544)
 * enabled rather than deny-only — which is how a runner image with UAC
 * turned off shows it, without the high label. CI's Windows runner wrote
 * into System32's folders while the label check alone said no (the first
 * Windows CI run, 23 Sep 2026). The app never runs so: it asks from an
 * unelevated process, where the group is deny-only and System32's folders
 * refuse a new file.
 */
function elevatedOnWindows(): boolean {
  const groups = windowsGroups();
  if (/S-1-16-(12288|16384)/.test(groups)) return true;
  return groups.split(/\r?\n/).some((line) => line.includes('S-1-5-32-544') && /Enabled group/i.test(line) && !/deny only/i.test(line));
}

test('a program the system owns, in a folder the system owns, may be started as administrator', {
  skip: (process.getuid?.() === 0 && 'root may write anywhere')
    || (elevatedOnWindows() && 'this process is an elevated administrator, who may add files to System32’s folders; the app asks from an unelevated one'),
}, () => {
  // Resolved to the real file: elevationRefusal rightly refuses a link, and
  // /bin/sh is one on Ubuntu (to dash), as /usr/bin/true may be where the
  // coreutils are a single program (the CI dry run of 23 Sep 2026).
  const system = process.platform === 'win32'
    ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : ['/usr/bin/true', '/bin/sh'].filter((p) => fs.existsSync(p)).map((p) => fs.realpathSync(p)).find((p) => fs.lstatSync(p).isFile());
  assert.ok(system && fs.existsSync(system), `a system program to try (${system})`);
  assert.equal(elevationRefusal(system), null, process.platform === 'win32' ? `not elevated by the checks above; whoami /groups:\n${windowsGroups()}` : undefined);
});

/** This user's security identifier (`whoami /user`), or null off Windows. */
function currentUserSid(): string | null {
  if (process.platform !== 'win32') return null;
  const row = execFileSync(system32('whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8' }).trim();
  const sid = row.split(',').pop()?.replace(/"/g, '').trim() ?? '';
  return /^S-1-\d+(-\d+)+$/.test(sid) ? sid : null;
}

test('on Windows each door is tried in turn: a folder that refuses new files, then a file that refuses a change of its attributes', {
  skip: process.platform !== 'win32' && 'deny entries in an access list are Windows’',
}, () => {
  // Deny entries hold even for an administrator, so this runs on the elevated
  // CI runner, which the System32 test above cannot: it is the one Windows
  // run of the answer "may be started". Node asks to write with every write
  // right at once (libuv's FILE_GENERIC_WRITE), so a file that refuses a
  // change of its attributes refuses the open for writing too; an access list
  // that allows writing the data while refusing the attributes would pass
  // (RISKS R68: the access list itself is not read).
  const sid = currentUserSid();
  assert.ok(sid, 'whoami /user names this user’s security identifier');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-elevation-acl-'));
  const helper = path.join(dir, 'tm-mft-helper.exe');
  fs.writeFileSync(helper, 'stand-in');
  const icacls = (...args: string[]): void => {
    execFileSync(system32('icacls.exe'), args, { encoding: 'utf8' });
  };
  try {
    icacls(dir, '/deny', `*${sid}:(WD)`);
    assert.equal(elevationRefusal(helper), `${helper} could be changed by any program running as you`, 'the folder refuses a new file; the file itself can still be changed');
    assert.deepEqual(fs.readdirSync(dir), ['tm-mft-helper.exe'], 'no probe was left, or made');
    icacls(helper, '/deny', `*${sid}:(WA)`);
    assert.equal(elevationRefusal(helper), null, 'the folder refuses a new file and the file refuses a change');
  } finally {
    icacls(helper, '/remove:d', `*${sid}`);
    icacls(dir, '/remove:d', `*${sid}`);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
