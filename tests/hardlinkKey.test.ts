import { test } from 'node:test';
import assert from 'node:assert/strict';

import { hardlinkKey, type BigLstat } from '../src/services/diskScanner';

/**
 * The built-in walker keys a shared inode by `${dev}:${ino}` from Node's
 * `Stats`, whose ids are doubles. A double holds an id exactly only below
 * 2^53, and a Windows file id is often past it (a reused NTFS record keeps its
 * sequence number in bits 48..64), so two different hard-linked files could
 * share a key and one's bytes vanish as the other's duplicate (the
 * pre-landing review of 23 Sep 2026).
 */

const noSecondLook: BigLstat = async () => assert.fail('an id below 2^53 is exact as it is');

test('an id below 2^53 is keyed from the stat already taken', async () => {
  assert.equal(await hardlinkKey('/x', { dev: 16777234, ino: 123456 }, noSecondLook), '16777234:123456');
  assert.equal(await hardlinkKey('/x', { dev: 7, ino: 2 ** 53 - 1 }, noSecondLook), `7:${2 ** 53 - 1}`);
});

test('an id past 2^53 is read again exactly, so neighbouring files keep different keys', async () => {
  const a = (40n << 48n) | 4096n;
  const b = a + 1n;
  assert.equal(Number(a), Number(b), 'as doubles the two ids are one number');
  const exact = new Map<string, bigint>([['/a', a], ['/b', b]]);
  const lstatBig: BigLstat = async (p) => {
    const ino = exact.get(p);
    if (ino === undefined) throw new Error(`no such file ${p}`);
    return { dev: 7n, ino };
  };
  const keyA = await hardlinkKey('/a', { dev: 7, ino: Number(a) }, lstatBig);
  const keyB = await hardlinkKey('/b', { dev: 7, ino: Number(b) }, lstatBig);
  assert.equal(keyA, `7:${a}`);
  assert.equal(keyB, `7:${b}`);
  assert.notEqual(keyA, keyB);
});

test('a file gone before its second look keeps the key its first stat gave', async () => {
  const gone: BigLstat = async () => {
    throw Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });
  };
  assert.equal(await hardlinkKey('/a', { dev: 7, ino: 2 ** 60 }, gone), `7:${2 ** 60}`);
});
