import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * B2, the chunked preflight's MERGE — what survives being stitched back together.
 *
 * `checkOpenHandlesFor` asks about the selection one chunk at a time and then
 * paints ONE report. Everything interesting about it lives in the seam between
 * those two halves, and two things can be dropped there:
 *
 *   1. **The conflicts an earlier chunk already found.** A reply with
 *      `checked: false` is the machine saying it has no way to look — `lsof`
 *      absent, Restart Manager unavailable — and the loop stops on it, because
 *      that is a property of the computer and asking sixteen times collects
 *      sixteen identical noes. But that reply carries `conflicts: []`, so
 *      rendering IT is rendering an empty list: the three files chunk 1 found
 *      open in Xcode vanish, the panel prints "couldn't check", and the user
 *      reads a dialog that names nothing in use and trashes files their editor
 *      is holding. That is the exact failure chunking was added to prevent,
 *      re-entered through the back door. What was found stays found; what was
 *      not reached is said out loud alongside it.
 *
 *   2. **The panel's owner.** `#confirmOpenHandles` is one element shared by
 *      every dialog, and `openHandleSeq` is how a slow answer is stopped from
 *      painting into a dialog that replaced it. The guard has to cover the
 *      failure path too: a run whose every chunk died still reaches the
 *      "get out of the way" line, and if it hides the panel without checking
 *      whose panel it now is, an abandoned check blanks the warning a NEWER
 *      dialog is already showing.
 *
 * Both are asserted by running the real guard out of the built page against a
 * scripted `api`, and by reading the merged report object itself rather than
 * the sentence rendered from it — the merge is the thing under test, and its
 * wording is free to change.
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
 * it to `setConfirmButton`, the first thing after it. Private helpers inside the
 * region may be added, renamed or dropped without these tests noticing.
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

interface Report {
  conflicts?: { path: string; pid: number; processName: string; openPath?: string }[];
  checked?: boolean;
  complete?: boolean;
  reason?: string;
}
type Reply = Report | Error;

interface Panel { hidden: boolean; className: string; textContent: string; innerHTML: string }

interface Harness {
  check(paths: string[]): Promise<void>;
  /** Stands in for the user closing this dialog and another opening. */
  reset(): void;
  requests: string[][];
  panel: Panel;
  buttons: string[];
  /** Every report the merge handed to the renderer, in order. */
  reports: Report[];
  /** The single report a run is allowed to paint. */
  report(): Report;
  text(): string;
}

/**
 * The guard, wired to a scripted `api` and a panel that records instead of
 * painting, plus a spy on the merged report.
 *
 * The spy REBINDS `renderOpenHandleWarning` inside the guard's own scope rather
 * than wrapping the returned function: a function declaration is a mutable
 * binding, and rebinding it is what puts the spy on the call
 * `checkOpenHandlesFor` actually makes. The real renderer still runs behind it,
 * so the panel assertions below exercise the shipped painting path too.
 */
function harness(reply: (paths: string[], index: number) => Reply | Promise<Reply>): Harness {
  const requests: string[][] = [];
  const reports: Report[] = [];
  const panel: Panel = { hidden: false, className: '', textContent: '', innerHTML: '' };
  const confirmOk = { innerHTML: '' };
  const buttons: string[] = [];

  const api = async (_url: string, options: { body: string }): Promise<unknown> => {
    const paths = (JSON.parse(options.body) as { paths: string[] }).paths;
    requests.push(paths);
    const out = await reply(paths, requests.length - 1);
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
     return {
       checkOpenHandlesFor,
       resetOpenHandleWarning,
       onReport(hook) {
         const real = renderOpenHandleWarning;
         renderOpenHandleWarning = (report, pathCount) => { hook(report, pathCount); real(report, pathCount); };
       },
     };`,
  ) as (...a: unknown[]) => {
    checkOpenHandlesFor: (p: string[]) => Promise<void>;
    resetOpenHandleWarning: () => void;
    onReport: (hook: (r: Report) => void) => void;
  };

  const built = factory(
    api,
    $,
    () => '',
    (s: string) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    (n: number) => (n ?? 0).toLocaleString(),
    (label: string) => { buttons.push(label); },
    CHUNK,
  );
  built.onReport((r) => { reports.push(r); });

  return {
    check: built.checkOpenHandlesFor,
    reset: built.resetOpenHandleWarning,
    requests,
    reports,
    panel,
    buttons,
    report() {
      assert.equal(reports.length, 1, `the run painted ${reports.length} reports; a chunked check paints exactly one`);
      return reports[0];
    },
    text: () => `${panel.textContent} ${panel.innerHTML}`,
  };
}

const paths = (n: number, prefix = '/Users/x/f'): string[] =>
  Array.from({ length: n }, (_, i) => `${prefix}${i}.bin`);

const CLEAR: Reply = { conflicts: [], checked: true, complete: true };
/** The machine has no way to look — and says so while carrying no conflicts. */
const NO_CHECKER: Reply = { conflicts: [], checked: false, complete: false, reason: 'lsof is not installed.' };

const busy = (p: string, processName: string): Report =>
  ({ conflicts: [{ path: p, pid: 404, processName }], checked: true, complete: true });

/* ═════════ 1. a chunk that could not be checked never erases what was found ═════════ */

test('conflicts found before the checker gave out survive into the report', async () => {
  // Chunk 1 finds a file open in Xcode. Chunk 2 comes back "could not check".
  // Rendering that second reply is rendering `conflicts: []` — the panel then
  // names nothing in use, which is the one thing this dialog must never say on
  // the strength of a check that stopped early.
  const set = paths(CHUNK * 3);
  const victim = set[1];
  const h = harness((_c, i) => (i === 0 ? busy(victim, 'Xcode') : NO_CHECKER));
  await h.check(set);

  const report = h.report();
  assert.deepEqual(report.conflicts?.map((c) => c.processName), ['Xcode'],
    'the program holding the file is still in the report the panel is painted from');
  assert.notEqual(report.checked, false,
    'a run that DID check part of the set is not reported as an unchecked one — that branch prints no conflicts at all');
  assert.equal(report.complete, false,
    'and the part nobody could look at makes the answer partial, whatever it says about it');

  assert.equal(h.panel.hidden, false);
  assert.match(h.text(), /Xcode/, 'the warning reaches the screen');
  const said = h.text();
  assert.ok(said.includes(CHUNK.toLocaleString()) && said.includes(set.length.toLocaleString()),
    `the panel names how much of the set the answer covers, said: ${said}`);
  assert.match(said, /lsof is not installed\./,
    'and why the rest could not be reached, in the machine’s own words');
  assert.ok(h.buttons.includes('Delete anyway'),
    'the button admits what it does, because something really is in use');
});

test('a checker that gives out after a clear chunk still refuses to imply the set is clear', async () => {
  // Same seam, nothing found in the part that was reachable. Silence here would
  // be read as "nothing is open" about paths nobody looked at.
  const set = paths(CHUNK * 2);
  const h = harness((_c, i) => (i === 0 ? CLEAR : NO_CHECKER));
  await h.check(set);

  assert.equal(h.panel.hidden, false, 'a half-checked set never renders as clear');
  assert.notEqual(h.report().complete, true, 'the report does not claim to have covered the set');
  assert.deepEqual(h.buttons, [], 'nothing was found, so the button is not escalated');
});

test('an unavailable checker on the very first chunk is still just "could not check"', async () => {
  // The fix must not overcorrect: when NOTHING was reached, "TreeMap couldn’t
  // check" is the whole truth, and dressing it up as a partial result with a
  // "0 of 800" count would be noise about a check that never started.
  const h = harness(() => NO_CHECKER);
  await h.check(paths(CHUNK * 2));

  assert.equal(h.requests.length, 1, 'a machine-wide no is asked once');
  assert.equal(h.report().checked, false, 'reported as the unchecked run it was');
  assert.equal(h.panel.hidden, false);
  assert.match(h.text(), /lsof is not installed\./);
});

/* ═════════ 2. a run that answered nothing must not blank a newer dialog ═════════ */

const NEWER_DIALOG = 'Checking whether anything has these files open…';

test('a stale run whose every chunk failed leaves the newer dialog’s panel alone', async () => {
  // `#confirmOpenHandles` is one element shared by every dialog. The surviving
  // sequence check only runs after a chunk SUCCEEDS, so a run that failed all
  // the way through reaches the "get out of the way" line still believing the
  // panel is its own — and hides a warning the dialog now on screen is showing.
  const set = paths(CHUNK * 2);
  const h: Harness = harness((_c, i) => {
    if (i === 0) {
      h.reset();                       // the user closed this dialog…
      h.panel.hidden = false;          // …and the one that replaced it owns the
      h.panel.className = 'checking';  //    panel now
      h.panel.textContent = NEWER_DIALOG;
    }
    return new Error('offline');
  });
  await h.check(set);

  assert.equal(h.panel.hidden, false,
    'an abandoned check does not hide the panel a live dialog is using');
  assert.equal(h.panel.textContent, NEWER_DIALOG,
    'and leaves what that dialog is saying exactly as it found it');
  assert.deepEqual(h.reports, [], 'a stale run paints nothing at all');
});

test('the current run whose every chunk failed still gets out of the way', async () => {
  // The other half of the same decision, and the reason the guard is a guard
  // and not a removal: the check is a courtesy, the server re-runs it on the
  // delete itself, so a preflight that could not run must not park an error in
  // front of a delete the user asked for.
  const h = harness(() => new Error('offline'));
  await h.check(paths(CHUNK * 2));
  assert.equal(h.panel.hidden, true, 'nobody else owns the panel, so it is cleared');
});

/* ═════════ 3. what an ordinary run reports must not change ═════════ */

test('a fully checked run reports every conflict it found and claims nothing more', async () => {
  const set = paths(CHUNK * 3);
  const h = harness((chunk, i) => (i === 2 ? busy(chunk[0], 'Blender') : i === 0 ? busy(chunk[0], 'Xcode') : CLEAR));
  await h.check(set);

  const report = h.report();
  assert.equal(h.requests.length, 3, 'every chunk was asked about');
  assert.deepEqual(report.conflicts?.map((c) => c.processName).sort(), ['Blender', 'Xcode'],
    'conflicts from separate requests arrive as one list');
  assert.notEqual(report.complete, false, 'the whole set was covered, so nothing is hedged');
  assert.equal(report.reason, undefined, 'and no caveat is invented for a check that had none');
  assert.match(h.text(), /Xcode/);
  assert.match(h.text(), /Blender/);
});

test('a fully checked, fully clear run still says nothing at all', async () => {
  const h = harness(() => CLEAR);
  await h.check(paths(CHUNK * 2));
  assert.equal(h.panel.hidden, true, 'silence is honest only here, and it must stay available');
  assert.deepEqual(h.buttons, []);
});
