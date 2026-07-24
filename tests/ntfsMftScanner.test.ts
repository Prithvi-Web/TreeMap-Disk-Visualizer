import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isValidDriveLetter, isNtfsVolume, findNtfsMftBinary } from '../src/services/ntfsMftScanner';

test('isValidDriveLetter accepts a single letter only', () => {
  assert.equal(isValidDriveLetter('C'), true);
  assert.equal(isValidDriveLetter('c'), true);
  assert.equal(isValidDriveLetter('CC'), false);
  assert.equal(isValidDriveLetter('C:'), false);
  assert.equal(isValidDriveLetter('; rm -rf /'), false);
  assert.equal(isValidDriveLetter(''), false);
});

test('isNtfsVolume returns false rather than throwing on a bad drive letter', async () => {
  assert.equal(await isNtfsVolume('not-a-drive'), false);
});

test('isNtfsVolume detects the host drive on Windows', { skip: process.platform !== 'win32' }, async () => {
  const drive = process.env.SystemDrive?.replace(':', '') ?? 'C';
  assert.equal(await isNtfsVolume(drive), true);
});

test('findNtfsMftBinary returns null rather than throwing when nothing is installed', async () => {
  const found = await findNtfsMftBinary({ bundledPath: '/nonexistent/ntfs-mft-scan.exe' });
  assert.equal(found, null);
});
