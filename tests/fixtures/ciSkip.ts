import assert from 'node:assert/strict';

/**
 * Skip a test for something this machine lacks — or, on CI, fail it. CI builds
 * the native module and fetches gdu on every leg before the suite runs, so
 * there a missing one is a broken build, not a developer's machine without
 * Rust: a skip would leave the step green with the claim never checked (a
 * review of nativeEquivalence.test.ts found that gap once; the pre-landing
 * review of 23 Sep 2026 found it in five more files).
 */
export function skipOrFailOnCi(t: { skip(message?: string): void }, reason: string, env: NodeJS.ProcessEnv = process.env): void {
  if (env.CI) assert.fail(`on CI this is built or fetched on every leg, so this is a failure, not a skip: ${reason}`);
  t.skip(reason);
}
