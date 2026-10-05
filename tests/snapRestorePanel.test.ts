import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * B4 — what the snapshot panel says once "Recover it" has been clicked (FG4e, review L4).
 *
 * The real shipped `restoreFromSnapshot` is lifted out of `public/index.html` and driven against a
 * scripted `/api/system/snapshots/restore` answer and a two-method DOM, as snapCandidatesEmpty.test.ts
 * drives the panel before it: this exercises the code path rather than describing it.
 */

const INDEX = readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

interface FakeHost {
  innerHTML: string;
  querySelector(sel: string): { innerHTML: string } | null;
}

function host(): FakeHost {
  return { innerHTML: '<div class="snap-actions"></div>', querySelector: () => ({ innerHTML: '' }) };
}

type RestoreFn = (targetPath: string, host: FakeHost) => Promise<void>;

/** The shipped `restoreFromSnapshot` (and the helper it calls), wired to `answer`. */
function harness(answer: () => Promise<unknown>): { restore: RestoreFn; toasts: string[]; wired: number } {
  const start = INDEX.indexOf('async function restoreFromSnapshot');
  assert.notEqual(start, -1, 'restoreFromSnapshot is in the shipped page');
  const end = INDEX.indexOf('function wireSnapshotActions', start);
  assert.notEqual(end, -1, 'wireSnapshotActions follows it');
  const src = INDEX.slice(start, end);
  const state = { toasts: [] as string[], wired: 0 };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const factory = new Function(
    'api', 'icon', 'escapeHtml', 'formatBytes', 'formatCount', 'wireSnapshotActions', 'toast',
    `'use strict';\n${src}\nreturn restoreFromSnapshot;`,
  ) as (...deps: unknown[]) => RestoreFn;
  const restore = factory(
    answer,
    () => '',
    (s: string) => String(s),
    (b: number) => `${b}B`,
    (n: number) => String(n),
    () => { state.wired++; },
    (msg: string) => { state.toasts.push(msg); },
  );
  return { restore, get toasts() { return state.toasts; }, get wired() { return state.wired; } };
}

const restored = (extra: Record<string, unknown> = {}) => async () => ({
  restored: true, originalPath: '/Users/me/a.txt', restoredTo: '/Users/me/a (recovered).txt', fromSnapshotId: 'snap-1', sizeBytes: 5, ...extra,
});

test('a copy restored from an older snapshot says newer ones could not be opened, and why', async () => {
  const h = harness(restored({ newerUnread: { count: 1, reason: 'mount_apfs: Resource busy' } }));
  const panel = host();
  await h.restore('/Users/me/a.txt', panel);
  assert.match(panel.innerHTML, /Recovered/);
  assert.match(panel.innerHTML, /1 newer snapshot could not be opened \(mount_apfs: Resource busy\)/, panel.innerHTML);
  assert.match(panel.innerHTML, /may not be the newest/, 'the copy is not passed off as the newest');

  const two = harness(restored({ newerUnread: { count: 2, reason: 'mount_apfs: Resource busy' } }));
  const panel2 = host();
  await two.restore('/Users/me/a.txt', panel2);
  assert.match(panel2.innerHTML, /2 newer snapshots could not be opened/);
});

test('a copy restored from the newest snapshot says nothing about older ones', async () => {
  const h = harness(restored());
  const panel = host();
  await h.restore('/Users/me/a.txt', panel);
  assert.match(panel.innerHTML, /Recovered/);
  assert.doesNotMatch(panel.innerHTML, /newer snapshot|may not be the newest/);
});
