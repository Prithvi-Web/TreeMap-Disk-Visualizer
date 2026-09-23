import { test } from 'node:test';
import assert from 'node:assert/strict';
import { skipOrFailOnCi } from './fixtures/ciSkip';

test('off CI a missing module or binary skips, with the reason; on CI it fails', () => {
  const skipped: string[] = [];
  const t = { skip: (m?: string) => { skipped.push(m ?? ''); } };
  skipOrFailOnCi(t, 'no gdu here', {});
  assert.deepEqual(skipped, ['no gdu here']);
  assert.throws(() => skipOrFailOnCi(t, 'no gdu here', { CI: 'true' }), /on CI .* a failure, not a skip: no gdu here/);
  assert.deepEqual(skipped, ['no gdu here'], 'and it did not skip as well');
});
