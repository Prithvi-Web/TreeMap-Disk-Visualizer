import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * B2, the preflight's honesty about its own reach.
 *
 * `POST /api/files/open-handles` answers only about the paths it was handed —
 * its `complete` flag describes that request's set, nothing wider. The client
 * has to send the selection in chunks because the API bounds a body at 500
 * paths, so "what the dialog knows" and "what the user selected" are two
 * different sets the moment a selection passes one chunk.
 *
 * The bug these pin: the preflight sent the FIRST chunk and then rendered the
 * answer against `paths.length`, so selecting 5,000 files whose in-use ones sat
 * past index 400 produced a dialog with no warning at all — indistinguishable,
 * to the person reading it, from "nothing here is open". They then trashed
 * files a program was holding.
 *
 * The invariant, stated once and asserted from several directions: the panel
 * may say "nothing is in use" ONLY about a set it actually looked at. Whether
 * it earns that by checking every chunk or by naming what it skipped is the
 * implementation's choice — test 1 accepts either, and the rest pin the
 * behaviour that was chosen.
 *
 * The guard is extracted from the shipped page and run against a scripted
 * `api`, so these exercise the real code path rather than a description of it.
 */

const INDEX = readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

/** The server's own body cap, read from the page rather than duplicated here. */
const CHUNK = (() => {
  const m = /const TRASH_CHUNK = (\d+);/.exec(INDEX);
  assert.ok(m, 'the page states the per-request path cap it chunks to');
  return Number(m[1]);
})();

/**
 * The whole open-file-guard region, sliced by landmarks that belong to the
 * feature rather than to any one function: from the sequence counter that opens
 * it to `setConfirmButton`, which is the first thing after it. Sliced this way
 * on purpose — a fix is free to add, rename or drop private helpers inside the
 * region without these tests noticing, which is what stops them from becoming a
 * transcript of one particular implementation.
 */
function guardSource(): string {
  const start = INDEX.indexOf('let openHandleSeq = 0;');
  assert.notEqual(start, -1, 'the open-file guard region starts at its sequence counter');
  const end = INDEX.indexOf('function setConfirmButton(label)', start);
  assert.notEqual(end, -1, 'setConfirmButton closes the region');
  const src = INDEX.slice(start, end);
  assert.ok(src.includes('renderOpenHandleWarning'), 'the slice really contains the guard');
  return src;
}

type Reply =
  | { conflicts?: unknown[]; checked?: boolean; complete?: boolean; reason?: string; elapsedMs?: number }
  | Error;

interface Panel {
  hidden: boolean;
  className: string;
  textContent: string;
  innerHTML: string;
}

interface Harness {
  check(paths: string[]): Promise<void>;
  /** Stands in for a newer dialog opening over this one. */
  reset(): void;
  requests: string[][];
  panel: Panel;
  buttons: string[];
  /** Everything the panel is currently saying, however it was painted. */
  text(): string;
}

/**
 * The guard, wired to a scripted `api` and a panel that records instead of
 * painting. `reply` is called per request with the paths that request carried,
 * so a test can put an in-use file in any chunk it likes.
 */
function harness(reply: (paths: string[], index: number) => Reply | Promise<Reply>): Harness {
  const requests: string[][] = [];
  const panel: Panel = { hidden: false, className: '', textContent: '', innerHTML: '' };
  const confirmOk = { innerHTML: '' };
  const buttons: string[] = [];

  const api = async (_url: string, options: { body: string }): Promise<unknown> => {
    const paths = (JSON.parse(options.body) as { paths: string[] }).paths;
    const index = requests.length;
    requests.push(paths);
    const out = await reply(paths, index);
    if (out instanceof Error) throw out;
    return out;
  };
  const $ = (id: string): unknown => {
    if (id === 'confirmOpenHandles') return panel;
    if (id === 'confirmOk') return confirmOk;
    return assert.fail(`the guard asked for an unexpected element: ${id}`);
  };

  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const factory = new Function(
    'api', '$', 'icon', 'escapeHtml', 'formatCount', 'setConfirmButton', 'TRASH_CHUNK',
    `'use strict';
     ${guardSource()}
     return { checkOpenHandlesFor, resetOpenHandleWarning };`,
  ) as (...a: unknown[]) => { checkOpenHandlesFor: (p: string[]) => Promise<void>; resetOpenHandleWarning: () => void };

  const built = factory(
    api,
    $,
    () => '',
    (s: string) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    (n: number) => (n ?? 0).toLocaleString(),
    (label: string) => { buttons.push(label); },
    CHUNK,
  );

  return {
    check: built.checkOpenHandlesFor,
    reset: built.resetOpenHandleWarning,
    requests,
    panel,
    buttons,
    text: () => `${panel.textContent} ${panel.innerHTML}`,
  };
}

const paths = (n: number, prefix = '/Users/x/f'): string[] =>
  Array.from({ length: n }, (_, i) => `${prefix}${i}.bin`);

const CLEAR: Reply = { conflicts: [], checked: true, complete: true, elapsedMs: 3 };

/* ═════════════════ the invariant ═════════════════ */

test('a selection bigger than one request is either checked in full or says it was not', async () => {
  const set = paths(CHUNK * 3 + 7);
  const h = harness(() => CLEAR);
  await h.check(set);

  const seen = new Set(h.requests.flat());
  for (const p of h.requests) {
    assert.ok(p.length <= CHUNK, `a request carried ${p.length} paths, past the server's cap`);
  }
  if (seen.size >= set.length) return; // it looked at everything; silence is honest

  // It did not. Then the dialog must say so — a hidden panel here reads as
  // "nothing in these 1,207 items is open", which is a claim the check never
  // made and the reason someone trashes a file their editor is holding.
  assert.equal(h.panel.hidden, false,
    `the check covered ${seen.size} of ${set.length} paths and said nothing about the rest`);
  const said = h.text();
  assert.ok(said.includes(seen.size.toLocaleString()) && said.includes(set.length.toLocaleString()),
    `a partial answer has to name both counts, said: ${said}`);
});

test('a file in use past the first request still reaches the dialog', async () => {
  // The exact shape of the reported bug: the in-use file sits at index 500, so
  // the first chunk is genuinely clear and the truth is in the second.
  const set = paths(CHUNK + 200);
  const victim = set[CHUNK + 100];
  const h = harness((chunk) => chunk.includes(victim)
    ? { conflicts: [{ path: victim, pid: 91, processName: 'Blender' }], checked: true, complete: true, elapsedMs: 4 }
    : CLEAR);
  await h.check(set);

  assert.equal(h.panel.hidden, false, 'a set with an open file in it never renders as clear');
  assert.match(h.text(), /Blender/, 'the program holding the file is named');
  assert.ok(h.buttons.includes('Delete anyway'),
    'the button admits what it does once the warning is on screen');
});

test('a request that never answers is not silently counted as checked', async () => {
  // Chunk two dies in transport. Its paths were never looked at, and "we asked
  // and got nothing back" is not "we asked and it was clear".
  const set = paths(CHUNK * 2);
  const h = harness((_c, i) => (i === 1 ? new Error('Couldn’t reach TreeMap') : CLEAR));
  await h.check(set);

  assert.equal(h.panel.hidden, false, 'the half that was never checked has to be admitted');
  assert.ok(h.text().includes(CHUNK.toLocaleString()) && h.text().includes(set.length.toLocaleString()),
    `the panel names how much of the set was actually reached, said: ${h.text()}`);
});

test('a selection past the preflight budget is bounded, and says how far it got', async () => {
  // 80,000 paths is 200 chunks, and each chunk costs the server a full
  // enumeration of every open handle on the machine. Spending all 200 behind a
  // dialog nobody is looking at any more is not a kindness; stopping and saying
  // where it stopped is.
  const set = paths(CHUNK * 200);
  const h = harness(() => CLEAR);
  await h.check(set);

  assert.ok(h.requests.length < 200, `the preflight fired ${h.requests.length} requests, unbounded`);
  const seen = new Set(h.requests.flat()).size;
  assert.equal(h.panel.hidden, false, 'a budgeted check that stopped early must not read as clear');
  const said = h.text();
  assert.ok(said.includes(seen.toLocaleString()) && said.includes(set.length.toLocaleString()),
    `the panel names both counts, said: ${said}`);
  assert.deepEqual(h.buttons, [],
    'nothing was found, so the button is not escalated to "Delete anyway"');
});

/* ═════════════════ what must not change ═════════════════ */

test('a selection inside one request is unchanged: one request, and silence when clear', async () => {
  const h = harness(() => CLEAR);
  await h.check(paths(CHUNK));
  assert.equal(h.requests.length, 1, 'no extra round-trip for a set that fits');
  assert.equal(h.panel.hidden, true, 'a fully checked, fully clear set says nothing at all');
  assert.deepEqual(h.buttons, []);
});

test('a set the server itself could only partly cover is still reported as partial', async () => {
  // Windows' Restart Manager truncates at RM_MAX_RESOURCES: the request was
  // answered, but not about everything in it. That flag must survive the merge.
  const h = harness(() => ({ conflicts: [], checked: true, complete: false, reason: 'Only some files could be checked.', elapsedMs: 2 }));
  await h.check(paths(CHUNK * 2));
  assert.equal(h.panel.hidden, false);
  assert.match(h.text(), /Only some files could be checked\./);
});

test('an unavailable checker is reported once, not once per chunk', async () => {
  // `lsof` missing is a property of the machine, not of the chunk. Asking 16
  // times gets 16 identical noes.
  const h = harness(() => ({ conflicts: [], checked: false, complete: false, reason: 'lsof is not installed.', elapsedMs: 0 }));
  await h.check(paths(CHUNK * 4));
  assert.equal(h.requests.length, 1, 'a machine-wide no is asked once');
  assert.equal(h.panel.hidden, false);
  assert.match(h.text(), /lsof is not installed\./);
});

test('every request failing leaves the panel out of the way, as before', async () => {
  // The check is a courtesy and the server re-runs it on the delete itself, so
  // a preflight that could not run at all must not park an error in front of a
  // delete the user asked for.
  const h = harness(() => new Error('offline'));
  await h.check(paths(CHUNK * 2));
  assert.equal(h.panel.hidden, true, 'a preflight that answered nothing gets out of the way');
});

test('a newer dialog stops the chunk loop rather than painting into it', async () => {
  // The sequence guard existed for one request. With several it also has to end
  // the loop, or a dismissed dialog keeps hammering the server and lands its
  // answer in the panel the next dialog is using.
  const set = paths(CHUNK * 4);
  const h: Harness = harness((_c, i) => {
    if (i === 0) h.reset(); // the user closed this dialog and opened another
    return CLEAR;
  });
  await h.check(set);
  assert.equal(h.requests.length, 1, 'an abandoned check stops asking');
  assert.equal(h.panel.hidden, true, 'and never paints over the dialog that replaced it');
});
