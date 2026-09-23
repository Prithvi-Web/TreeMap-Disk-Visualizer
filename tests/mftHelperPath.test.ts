import { test } from 'node:test';
import assert from 'node:assert/strict';

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

test('a program the system owns, in a folder the system owns, may be started as administrator', { skip: process.getuid?.() === 0 && 'root may write anywhere' }, () => {
  const system = process.platform === 'win32'
    ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : ['/usr/bin/true', '/bin/sh'].find((p) => fs.existsSync(p));
  assert.ok(system && fs.existsSync(system), `a system program to try (${system})`);
  assert.equal(elevationRefusal(system), null);
});
