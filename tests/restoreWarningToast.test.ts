import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * FG3g L9 (the FG3f review's L9). A restore that put every byte back but could not set a date or a
 * permission back finishes with a warning (FG3f #10): the progress dialog shows it as an error
 * toast — and then each restore's own completion showed its green "Restored and verified" or
 * "Everything from that run is back" beside it, saying the opposite. The offload restore already
 * held its green toast back when the job carried a warning (125-offload.js, `!ev.warning`); the Time
 * Capsule restore, the cart's undo and Autopilot's undo now do the same. A whole undo with no
 * warning still says everything is back.
 *
 * The page is read as built (public/index.html); each function runs with stand-ins for the calls it
 * makes, and `watchJob`'s completion is called with the event the stream sends.
 */

const INDEX = readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

function slice(from: string, to: string): string {
  const start = INDEX.indexOf(from);
  assert.notEqual(start, -1, `anchor not found: ${from}`);
  const end = INDEX.indexOf(to, start + from.length);
  assert.notEqual(end, -1, `end anchor not found: ${to}`);
  const out = INDEX.slice(start, end);
  assert.ok(out.length > 100 && out.length < 8000, `the slice ${from} → ${to} is the function named (${out.length} characters)`);
  return out;
}

const WARNING = 'Everything was put back byte for byte, but the dates of /x/a.txt (EPERM) could not be set back.';
type Done = { onComplete: (ev?: Record<string, unknown>) => void };

/** Runs `name` (sliced from the page) with `answer` as the server's reply, completes it with `ev`, and answers the toasts. */
async function toastsOf(source: string, name: string, params: string[], stand: (watch: (o: Done) => void, toast: (m: string) => void) => unknown[], ev?: Record<string, unknown>): Promise<string[]> {
  const toasts: string[] = [];
  let watched: Done | null = null;
  const fn = new Function(...params, `${source}; return ${name};`)(...stand((o) => { watched = o; }, (m) => toasts.push(m))) as (id: string) => unknown;
  await fn('id-1');
  for (let i = 0; i < 10 && watched === null; i++) await new Promise((r) => setImmediate(r));
  assert.ok(watched, 'the restore is followed');
  (watched as Done).onComplete(ev);
  return toasts;
}

const passedOverToast = slice('function passedOverToast', 'function restoreFromCapsule');

async function capsuleRestore(ev?: Record<string, unknown>): Promise<string[]> {
  return toastsOf(slice('function restoreFromCapsule', 'function forgetCapsuleEntry'), 'restoreFromCapsule',
    ['api', 'watchJob', 'toast', 'loadCapsule'],
    (watch, toast) => [() => Promise.resolve({ jobId: 'j' }), watch, toast, () => undefined], ev);
}

async function autopilotUndo(ev?: Record<string, unknown>): Promise<string[]> {
  return toastsOf(`${passedOverToast}; ${slice('function undoAutopilotRun', 'function deletePolicy')}`, 'undoAutopilotRun',
    ['api', 'watchJob', 'toast', 'loadAutopilot', 'formatCount'],
    (watch, toast) => [() => Promise.resolve({ jobId: 'j', entryCount: 2 }), watch, toast, () => undefined, (n: number) => String(n)], ev);
}

async function cartUndo(ev?: Record<string, unknown>): Promise<string[]> {
  return toastsOf(`${passedOverToast}; ${slice('async function cartUndoRun', '// Drawer + delegated row-button wiring.')}`, 'cartUndoRun',
    ['api', 'closeModal', 'watchJob', 'toast', 'formatCount', 'rescan', 'renderCart', 'refreshCartButtons', 'cartLastRun'],
    (watch, toast) => [() => Promise.resolve({ jobId: 'j', entryCount: 2, bytesTotal: 10 }), () => undefined, watch, toast,
      (n: number) => String(n), () => undefined, () => undefined, () => undefined, null], ev);
}

for (const [label, run, success] of [
  ['a Time Capsule restore', capsuleRestore, /Restored and verified/],
  ['an Autopilot undo', autopilotUndo, /Everything from that run is back/],
  ['a cart undo', cartUndo, /Everything from that run is back/],
] as const) {
  test(`${label} that finishes with a warning shows no green "all is well" beside it`, async () => {
    const warned = (await run({ type: 'complete', warning: WARNING })).join(' | ');
    assert.doesNotMatch(warned, success, `the warning stands alone (${warned})`);
  });

  test(`${label} that finishes without one still says so`, async () => {
    const clean = (await run({ type: 'complete' })).join(' | ');
    assert.match(clean, success, clean);
  });
}
