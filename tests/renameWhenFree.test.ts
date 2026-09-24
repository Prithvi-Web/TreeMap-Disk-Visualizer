import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { renameWhenFree, RENAME_ATTEMPTS } from './fixtures/renameWhenFree';

const refusal = (code: string): NodeJS.ErrnoException => Object.assign(new Error(code), { code });

test('a rename Windows refuses while a handle is held is tried again until it goes through, counted', () => {
  for (const code of ['EPERM', 'EBUSY', 'EACCES']) {
    let calls = 0;
    const refused = renameWhenFree('a', 'b', () => {
      calls++;
      if (calls <= 3) throw refusal(code);
    });
    assert.equal(refused, 3, code);
    assert.equal(calls, 4, `${code}: three refusals, then the rename`);
  }
});

test('any other error is thrown at once, and a folder that never comes free is given up on after the count', () => {
  let calls = 0;
  assert.throws(() => renameWhenFree('a', 'b', () => { calls++; throw refusal('ENOENT'); }), /ENOENT/);
  assert.equal(calls, 1, 'no retry for an error that is not a held handle');
  calls = 0;
  assert.throws(() => renameWhenFree('a', 'b', () => { calls++; throw refusal('EBUSY'); }, 7), /EBUSY/);
  assert.equal(calls, 7, 'exactly the attempts it was given');
  assert.ok(RENAME_ATTEMPTS >= 1_000_000, 'the default outlasts a small walk');
});

test('a real folder is renamed in one step, with nothing refused on this platform when nothing holds it', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-rename-free-'));
  try {
    fs.mkdirSync(path.join(base, 'from'));
    fs.writeFileSync(path.join(base, 'from', 'x'), 'x');
    assert.equal(renameWhenFree(path.join(base, 'from'), path.join(base, 'to')), 0);
    assert.equal(fs.existsSync(path.join(base, 'from')), false);
    assert.equal(fs.readFileSync(path.join(base, 'to', 'x'), 'utf8'), 'x');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
