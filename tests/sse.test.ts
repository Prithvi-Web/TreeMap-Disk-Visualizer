import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Response } from 'express';
import { sseSend } from '../src/utils/sse';

/**
 * The shared SSE writer is the app's only defense between a huge scan tree
 * and an uncaught RangeError on a timer (issue #14 crashed v2.1.0 exactly
 * there). These tests pin both halves of the contract: normal events write
 * one well-formed frame, and an event whose serialization blows V8's string
 * ceiling is refused with `false` instead of a throw.
 */

function fakeRes(): Response & { chunks: string[] } {
  const chunks: string[] = [];
  return {
    chunks,
    write(frame: string) {
      chunks.push(frame);
      return true;
    },
  } as unknown as Response & { chunks: string[] };
}

test('sseSend writes one data: frame and returns true', () => {
  const res = fakeRes();
  const ok = sseSend(res, { type: 'progress', scanned: 42 });
  assert.equal(ok, true);
  assert.deepEqual(res.chunks, ['data: {"type":"progress","scanned":42}\n\n']);
});

test('sseSend refuses an event beyond the string ceiling instead of throwing', () => {
  const res = fakeRes();
  // A real >512 MB tree would cost gigabytes to build in a test; a toJSON
  // that throws the same RangeError exercises the identical catch path.
  const tooBig = {
    toJSON(): never {
      throw new RangeError('Invalid string length');
    },
  };
  const ok = sseSend(res, { type: 'complete', root: tooBig });
  assert.equal(ok, false);
  assert.equal(res.chunks.length, 0, 'an unserializable event must leave the stream untouched');
});

test('sseSend rethrows non-size serialization bugs', () => {
  const res = fakeRes();
  // BigInt is JSON.stringify's canonical TypeError — a coding bug, not a
  // payload-size condition, so it must surface loudly.
  assert.throws(() => sseSend(res, { type: 'progress', scanned: 1n }), TypeError);
  assert.equal(res.chunks.length, 0);
});
