import { test } from 'node:test';
import assert from 'node:assert/strict';
import { neverDescend } from '../src/utils/mountBoundaries';

/**
 * The descent guard is what keeps a full-disk scan from wandering into
 * /System/Volumes (re-counting the whole Data volume) or into automount /
 * dead-mount triggers whose open()/stat() block forever. It gates descent
 * only — any of these paths chosen directly as a scan root is never asked.
 */

test('darwin: mount re-entry points and automount triggers are refused', () => {
  for (const p of ['/System/Volumes', '/Volumes', '/dev', '/home', '/net', '/Network']) {
    assert.equal(neverDescend(p, 'darwin'), true, `${p} must not be descended into`);
  }
});

test('darwin: real content roots pass', () => {
  for (const p of ['/System', '/Users', '/Applications', '/private', '/Library', '/opt']) {
    assert.equal(neverDescend(p, 'darwin'), false, `${p} must be walkable`);
  }
});

test('darwin: children of a skipped dir are unaffected (root-scan case)', () => {
  // Scanning /Volumes/Backup directly starts AT that path — the guard is
  // only consulted for children found on the way down, so the entry itself
  // must not match.
  assert.equal(neverDescend('/Volumes/Backup', 'darwin'), false);
  assert.equal(neverDescend('/System/Volumes/Data', 'darwin'), false);
});

test('linux: pseudo-filesystems are refused, real roots pass', () => {
  for (const p of ['/proc', '/sys', '/dev', '/run']) {
    assert.equal(neverDescend(p, 'linux'), true);
  }
  assert.equal(neverDescend('/home', 'linux'), false, 'linux /home is real user data');
  assert.equal(neverDescend('/var', 'linux'), false);
});

test('windows: no descent restrictions', () => {
  assert.equal(neverDescend('C:\\Windows', 'win32'), false);
});
