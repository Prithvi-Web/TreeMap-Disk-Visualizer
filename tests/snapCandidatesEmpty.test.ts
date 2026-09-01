import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * B4 — "Check snapshots" when every snapshot has been looked inside and none of
 * them holds the file.
 *
 * This is not a hypothetical shape. `findDeleted` in
 * `src/services/snapshotRecovery.ts` inspects each snapshot on a system that
 * can read them unprivileged (Linux/btrfs), marks the ones that do not contain
 * the path `'absent'`, and returns the **full** candidate list either way — with
 * a `reason` set precisely when nothing usable survives ("Checked N snapshots —
 * none of them contain that path."). A file created and deleted between two
 * snapshots produces exactly that: a non-empty list of candidates, every one of
 * them absent.
 *
 * The panel used to test `result.candidates.length` for emptiness and then read
 * `usable[0].snapshot.takenAt` off the narrowed list, so this ordinary answer —
 * one the server went out of its way to phrase for a reader — reached the user
 * as a TypeError and an empty panel. The emptiness test belongs on `usable`,
 * the list the panel actually reads from.
 *
 * The real shipped function is lifted out of `public/index.html` and driven
 * against stubbed collaborators and a two-method DOM, so this exercises the
 * code path rather than describing it.
 */

const INDEX = readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

/* ────────────────────────────── the harness ────────────────────────────── */

interface FakeEl {
  className: string;
  innerHTML: string;
  nextElementSibling: FakeEl | null;
  classList: { contains(c: string): boolean };
  after(el: FakeEl): void;
  querySelectorAll(sel: string): FakeEl[];
}

/** Enough DOM for a panel that only ever sets innerHTML and inserts itself. */
function el(): FakeEl {
  const node: FakeEl = {
    className: '',
    innerHTML: '',
    nextElementSibling: null,
    classList: { contains: (c: string) => node.className.split(/\s+/).includes(c) },
    after(next: FakeEl) { node.nextElementSibling = next; },
    querySelectorAll: () => [],
  };
  return node;
}

interface SnapCandidate {
  snapshot: { name?: string; takenAt: number | null };
  state: 'present' | 'possible' | 'absent';
  sizeBytes: number | null;
}
interface SnapResult {
  candidates: SnapCandidate[];
  confirmed?: boolean;
  stillPresent?: boolean;
  reason?: string;
}

type CheckFn = (targetPath: string, rowEl: FakeEl) => Promise<void>;

/** The shipped `checkSnapshotsFor`, wired to a scripted `/find-deleted` answer. */
function harness(result: SnapResult): { check: CheckFn; row: FakeEl; wired: number } {
  const start = INDEX.indexOf('async function checkSnapshotsFor');
  assert.notEqual(start, -1, 'checkSnapshotsFor is in the shipped page');
  const end = INDEX.indexOf('async function restoreFromSnapshot', start);
  assert.notEqual(end, -1, 'restoreFromSnapshot follows it');
  const src = INDEX.slice(start, end);

  const state = { wired: 0 };
  const row = el();
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const factory = new Function(
    'api', 'icon', 'escapeHtml', 'formatDate', 'formatCount', 'formatBytes',
    'wireSnapshotActions', 'document',
    `'use strict';\n${src}\nreturn checkSnapshotsFor;`,
  ) as (...deps: unknown[]) => CheckFn;

  const check = factory(
    () => Promise.resolve(result),
    () => '',                                   // icon(): markup we do not assert on
    (s: string) => String(s),                   // escapeHtml(): identity is enough here
    (t: number) => `date(${t})`,
    (n: number) => String(n),
    (b: number) => `${b}B`,
    () => { state.wired++; },
    { createElement: () => el() },
  );
  return { check, row, get wired() { return state.wired; } };
}

const panelOf = (row: FakeEl): string => {
  assert.ok(row.nextElementSibling, 'the panel was inserted after the row');
  return (row.nextElementSibling as FakeEl).innerHTML;
};

const absent = (takenAt: number): SnapCandidate =>
  ({ snapshot: { name: `snap-${takenAt}`, takenAt }, state: 'absent', sizeBytes: null });

/* ─────────────────────── the answer that used to throw ─────────────────────── */

test('a candidate list whose every entry is absent renders the reason, and does not throw', async () => {
  // The server's own words for this case, verbatim from findDeleted().
  const reason = 'Checked 3 snapshots — none of them contain that path.';
  const h = harness({
    candidates: [absent(3_000), absent(2_000), absent(1_000)],
    confirmed: true,
    stillPresent: false,
    reason,
  });

  await h.check('/Users/me/gone.txt', h.row);

  const html = panelOf(h.row);
  assert.ok(html.includes(reason), `the server's reason is what the user reads; got: ${html}`);
  // And the panel must not have quietly slipped into the found state on the
  // strength of a list that holds nothing recoverable.
  assert.ok(!/Found in/.test(html), 'nothing was found, so nothing may claim a find');
  assert.ok(!/data-snap-restore/.test(html), 'and there is nothing to offer recovering');
});

test('the absent-only answer falls back to plain words when the server sent no reason', async () => {
  // A reason is not guaranteed by the wire contract, and a blank panel is the
  // one outcome that leaves a person with no idea what happened.
  const h = harness({ candidates: [absent(2_000), absent(1_000)], confirmed: true, stillPresent: false });
  await h.check('/Users/me/gone.txt', h.row);
  const html = panelOf(h.row);
  assert.match(html, /snapshot/i, 'the empty state still says something about snapshots');
  assert.ok(html.replace(/<[^>]*>/g, '').trim().length > 10, 'and it is not an empty panel');
});

/* ────────── the states either side of it, so the guard is not over-eager ────────── */

test('a usable candidate still produces the found panel', async () => {
  const h = harness({
    candidates: [
      absent(3_000),
      { snapshot: { name: 'snap-2000', takenAt: 2_000 }, state: 'present', sizeBytes: 4_096 },
    ],
    confirmed: true,
    stillPresent: false,
  });
  await h.check('/Users/me/gone.txt', h.row);
  const html = panelOf(h.row);
  assert.match(html, /Found in 1 snapshot/, 'the absent one is not counted');
  assert.match(html, /date\(2000\)/, 'and the newest usable one is the one described');
  assert.match(html, /data-snap-restore/, 'recovery is offered');
  assert.equal(h.wired, 1, 'and the offered buttons are wired up');
});

test('a file that is still on disk is told so, even when every snapshot lacks it', async () => {
  // "It is right there" beats "no snapshot holds it": the second is true and
  // useless when the first is also true.
  const h = harness({
    candidates: [absent(2_000)],
    confirmed: true,
    stillPresent: true,
    reason: 'Checked 1 snapshot — none of them contain that path.',
  });
  await h.check('/Users/me/here.txt', h.row);
  assert.match(panelOf(h.row), /still on this disk/, 'the present-on-disk answer wins');
});

test('no snapshots at all keeps carrying the capability reason', async () => {
  const reason = 'No filesystem snapshots were found on /, so there is nothing older to recover from.';
  const h = harness({ candidates: [], confirmed: false, reason });
  await h.check('/Users/me/gone.txt', h.row);
  assert.ok(panelOf(h.row).includes(reason), 'the unavailable-capability reason survives the fix');
});
