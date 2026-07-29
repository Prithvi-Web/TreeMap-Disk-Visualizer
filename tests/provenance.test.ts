import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { readProvenance } from '../src/services/provenanceTracker';

/**
 * §C3 — download provenance.
 *
 * Acceptance, verbatim: "For a file downloaded by a mainstream browser on each
 * OS, the correct origin and date display; for one with no provenance data, the
 * UI says so rather than showing blanks."
 *
 * The second half is checked on every OS. The first half needs a file carrying
 * a real OS provenance record — on macOS this test WRITES one with `xattr`, the
 * same attribute Safari and Chrome write, so the parser is exercised against
 * the genuine format rather than a mock.
 */

const exec = promisify(execFile);
const IS_MAC = process.platform === 'darwin';

let dir: string;
function tmpdir(): string {
  if (!dir) dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-prov-'));
  return dir;
}
process.on('exit', () => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * Mark a file exactly as a browser does, with `com.apple.quarantine`:
 * `flags;hexUnixSeconds;agentName;uuid`.
 *
 * Deliberately NOT kMDItemWhereFroms: that is Spotlight metadata, and Spotlight
 * does not index temp volumes, so a test written against it passes or fails
 * depending on where the runner puts its scratch directory. The quarantine
 * xattr is read directly, is what carries the accurate date (the Spotlight
 * download date reads `(null)` even on genuine downloads), and is therefore
 * both the reliable mechanism and the honest thing to pin.
 */
async function markDownloaded(file: string, whenSeconds: number, agent: string): Promise<void> {
  const value = `0081;${whenSeconds.toString(16)};${agent};E30D49EA-1234-4C5E-9AAA-000000000001`;
  await exec('xattr', ['-w', 'com.apple.quarantine', value, file]);
}

test('a file a browser downloaded reports when, and by which mechanism', { skip: !IS_MAC }, async () => {
  const file = path.join(tmpdir(), 'installer.dmg');
  fs.writeFileSync(file, 'not really a dmg');
  const when = 1_782_365_986;
  await markDownloaded(file, when, 'Safari');

  const result = await readProvenance(file);
  assert.equal(result.supported, true, 'macOS records provenance');
  assert.equal(result.found, true, 'and this file has a record');
  assert.equal(result.downloadedAt, when * 1000, 'seconds in the record, milliseconds out');
  assert.equal(result.mechanism, 'com.apple.quarantine', 'the mechanism that answered is named');
  assert.equal(result.absentReason, undefined, 'no "nothing recorded" message when there is one');
});

test('a file nobody downloaded says so, and says why that is normal', async () => {
  // The blank-vs-honest case, on every OS.
  const file = path.join(tmpdir(), 'my-own-notes.txt');
  fs.writeFileSync(file, 'I made this myself');

  const result = await readProvenance(file);
  assert.equal(result.found, false);
  assert.equal(result.url, null);
  assert.equal(result.host, null);
  if (result.supported) {
    assert.ok(result.absentReason, 'an explanation is required, not a blank');
    assert.match(result.absentReason, /Nothing was recorded/);
    assert.ok(result.absentReason.length > 40, 'and it explains when that is expected');
  } else {
    assert.ok(result.unsupportedReason, 'an unsupported OS must say why');
  }
});

test('a path that does not exist is answered, not thrown', async () => {
  const result = await readProvenance(path.join(tmpdir(), 'no-such-file-' + process.pid));
  assert.equal(result.found, false);
  assert.equal(result.lastOpenedAt, null);
});

test('an atime that merely mirrors the mtime is reported as unknown', async () => {
  // Plenty of filesystems mount noatime, and plenty of tools rewrite it. An
  // atime equal to the mtime tells us nothing, and claiming "last opened" from
  // it would be inventing a fact.
  const file = path.join(tmpdir(), 'untouched.bin');
  fs.writeFileSync(file, 'x');
  const when = new Date(1_700_000_000_000);
  fs.utimesSync(file, when, when);
  assert.equal((await readProvenance(file)).lastOpenedAt, null);

  // A genuinely later read time IS reported.
  fs.utimesSync(file, new Date(1_700_000_600_000), when);
  assert.equal((await readProvenance(file)).lastOpenedAt, 1_700_000_600_000);
});

test('the absent-reason names the right mechanism for the running OS', async () => {
  const file = path.join(tmpdir(), 'plain.txt');
  fs.writeFileSync(file, 'x');
  const result = await readProvenance(file);
  if (!result.supported || result.found) return;
  const expected = process.platform === 'linux' ? /Firefox/ : process.platform === 'win32' ? /Windows/ : /macOS/;
  assert.match(result.absentReason!, expected, 'the explanation must match the OS the user is on');
});
