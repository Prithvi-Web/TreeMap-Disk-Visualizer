import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * A finished offload's note that a drive could not hold some copies' dates or permissions (hunt C45)
 * travelled as the job's warning (review F1.8): the page showed it as a red toast and held back
 * "Offloaded and verified — originals are in the Trash", whose silence beside a warning is for a
 * warning that may deny it. This note denies nothing, and the person was never told the originals
 * went to the Trash. It is now a note of its own (`note` on the job and the complete frame), shown
 * after the success line in the ordinary style; a restore's likewise.
 *
 * The page is read as built (public/index.html); `runOffloadJob`, `runRestoreJob`, `watchOffloadJob`
 * and `watchJob` run with stand-ins for the calls they make, fed the frame the stream sends.
 */

const INDEX = readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

function slice(from: string, to: string): string {
  const start = INDEX.indexOf(from);
  assert.notEqual(start, -1, `anchor not found: ${from}`);
  const end = INDEX.indexOf(to, start + from.length);
  assert.notEqual(end, -1, `end anchor not found: ${to}`);
  return INDEX.slice(start, end);
}

const NOTE = 'The dates or permissions of 1 copy could not be set at the destination (/d/a.txt: its dates (EPERM)); each copy\'s contents verified, and TreeMap\'s record keeps the originals\' dates and permissions for Restore.';

/** The toasts (message and kind) `run` shows when its job's stream sends `frame`. */
async function toastsFor(run: 'runOffloadJob' | 'runRestoreJob', frame: Record<string, unknown>): Promise<{ msg: string; kind: string }[]> {
  const toasts: { msg: string; kind: string }[] = [];
  const streams: { onmessage: ((m: { data: string }) => void) | null }[] = [];
  class FakeEventSource {
    static CLOSED = 2;
    readyState = 1;
    onmessage: ((m: { data: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    constructor() { streams.push(this); }
    close(): void { this.readyState = 2; }
  }
  const el = () => ({ innerHTML: '', textContent: '', style: {}, classList: { add() {}, remove() {} } });
  const source = [
    slice('function watchJob(opts)', "$('offloadCancelBtn')"),
    slice('async function runOffloadJob(paths, dest)', '/* ── v4 §8.3'),
    slice('async function runRestoreJob(ids)', '/** Progress modal driven'),
  ].join('\n');
  const deps: Record<string, unknown> = {
    EventSource: FakeEventSource, $: el, icon: () => '', OFFLOAD_PHASE_LABEL: { checking: 'Checking' }, FxBeam: { attach() {} }, closeModal: () => undefined,
    toast: (msg: string, kind = 'success') => toasts.push({ msg, kind }), formatCount: (n: number) => String(n), formatBytes: (n: number) => `${n} B`,
    loadOffloadIndex: () => undefined, activeJob: null, api: async () => ({ jobId: 'job-1' }),
    state: { scanId: 's', cart: new Set<string>() }, tmIsInside: () => false, saveCart: () => undefined, renderCart: async () => undefined,
    refreshCartButtons: () => undefined, refreshDock: () => undefined, rescan: () => undefined, restoreCancelledMessage: () => '',
  };
  const keys = Object.keys(deps);
  const fns = new Function(...keys, `${source}\nreturn { runOffloadJob, runRestoreJob };`)(...keys.map((k) => deps[k])) as Record<string, (...a: unknown[]) => Promise<void>>;
  await (run === 'runOffloadJob' ? fns.runOffloadJob(['/r/a.txt'], '/d') : fns.runRestoreJob(['id-1']));
  assert.equal(streams.length, 1, 'the job is followed');
  streams[0].onmessage?.({ data: JSON.stringify(frame) });
  return toasts;
}

test('an offload that finished with a note says the originals are in the Trash, then the note, in the ordinary style', async () => {
  const toasts = await toastsFor('runOffloadJob', { type: 'complete', filesDone: 1, bytesDone: 10, note: NOTE });
  assert.deepEqual(toasts, [
    { msg: 'Offloaded and verified — originals are in the Trash', kind: 'success' },
    { msg: NOTE, kind: 'success' },
  ]);
});

test('a restore that finished with a note says it restored, then the note', async () => {
  const note = 'The dates or permissions of 1 restored file could not be set back (/r/a.txt: its dates (EPERM)); each file\'s contents verified.';
  const toasts = await toastsFor('runRestoreJob', { type: 'complete', filesDone: 1, bytesDone: 10, note });
  assert.deepEqual(toasts, [{ msg: 'Restored and verified', kind: 'success' }, { msg: note, kind: 'success' }]);
});

test('a warning still stands alone, in red, with no success line beside it', async () => {
  const warning = 'Offloaded everything, but 1 original couldn\'t be moved to the Trash: it is locked';
  const toasts = await toastsFor('runOffloadJob', { type: 'complete', filesDone: 1, bytesDone: 10, warning });
  assert.deepEqual(toasts, [{ msg: warning, kind: 'error' }]);
});
