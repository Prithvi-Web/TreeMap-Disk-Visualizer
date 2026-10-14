import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-offloadPickConfirm-data-');

import { INDEX } from './fixtures/liftFrontend';

/**
 * "Offload…" from the Grid's selection bar, the right-click menu and the duplicates bar (fourth browser
 * pass, E01) opened a picker on the home folder whose primary button POSTed /api/offload the moment a
 * folder was picked: no dry run, no manifest, no confirm — while the drive dock, a newer door onto the
 * same pipeline, had promised "a drop NEVER moves anything bare". Every door now goes through one
 * function: the pipeline's own dry run, its manifest behind the shared confirm, and only Confirm
 * reaching runOffloadJob. The picker opens on a connected drive, never on the disk the files are on.
 *
 * The page's own startOffloadFlow, offloadPicked and confirmOffloadPlan run here over a stubbed server.
 */

/** A named function declaration from the shipped page, by brace matching. */
function pageFunction(name: string): string {
  const at = INDEX.search(new RegExp(`(async )?function ${name}\\(`));
  assert.notEqual(at, -1, `${name} is in the page`);
  const open = INDEX.indexOf('{', INDEX.indexOf(')', at));
  let depth = 0;
  for (let i = open; i < INDEX.length; i++) {
    if (INDEX[i] === '{') depth++;
    else if (INDEX[i] === '}' && --depth === 0) return INDEX.slice(at, i + 1);
  }
  return assert.fail(`${name} does not close`);
}

interface Drive { name: string; path: string; freeBytes?: number | null }
interface Harness {
  start: (paths: string[]) => Promise<void>;
  picked: (paths: string[], dest: string) => Promise<void>;
  opened: unknown[][];
  posts: Array<Record<string, unknown>>;
  offloaded: Array<[string[], string]>;
  toasts: Array<[string, string | undefined]>;
  els: Record<string, { innerHTML: string; open: boolean }>;
  confirm: () => (() => Promise<void>) | null;
}

/**
 * `refuse`: the dry run answers with this error instead of a plan. `volumesReply`: what GET /api/volumes
 * answers in place of `{ volumes: drives }` — it may throw, as a failed call does.
 */
function harness(drives: Drive[], refuse: string | null = null, volumesReply: (() => unknown) | null = null): Harness {
  const opened: unknown[][] = [];
  const posts: Array<Record<string, unknown>> = [];
  const offloaded: Array<[string[], string]> = [];
  const toasts: Array<[string, string | undefined]> = [];
  const els: Record<string, { innerHTML: string; open: boolean; classList: { add: (c: string) => void } }> = {};
  const $ = (id: string) => (els[id] ??= { innerHTML: '', open: false, classList: { add: (c: string) => { if (c === 'open') els[id].open = true; } } });
  const deps: Record<string, unknown> = {
    state: { scanId: 's1', root: { path: '/Users/me' }, cart: new Set<string>(), pathIndex: new Set<string>() },
    api: async (url: string, opts?: { method?: string; body?: string }) => {
      if (url === '/api/volumes') return volumesReply ? volumesReply() : { volumes: drives };
      if (url === '/api/offload') {
        const body = JSON.parse(opts?.body ?? '{}');
        posts.push(body);
        if (body.dryRun !== true) return assert.fail('the page POSTed a real offload outside runOffloadJob');
        if (refuse) throw new Error(refuse);
        return { dryRun: true, fileCount: 2, bytesTotal: 3_000_000_000, dest: body.dest, wouldTrashAfterVerify: body.paths };
      }
      return assert.fail(`unexpected request ${url}`);
    },
    $, toast: (m: string, kind?: string) => { toasts.push([m, kind]); },
    hideCtxMenu: () => {}, openBrowse: (...a: unknown[]) => { opened.push(a); },
    icon: () => '', escapeHtml: (s: unknown) => String(s), formatBytes: (n: number) => `${n / 1e9} GB`, formatCount: String,
    resetOpenHandleWarning: () => {}, refreshDock: () => {},
    runOffloadJob: async (paths: string[], dest: string) => { offloaded.push([paths, dest]); },
    activeJob: null,
  };
  const names = ['startOffloadFlow', 'offloadPicked', 'confirmOffloadPlan', 'tmIsInside', 'lastPathSegment'];
  const keys = Object.keys(deps);
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const page = new Function(...keys, `'use strict'; let onConfirmTrash = null; let offloadPlanSeq = 0;
    ${names.map(pageFunction).join('\n')}
    return { start: startOffloadFlow, picked: offloadPicked, confirm: () => onConfirmTrash };`)(...keys.map((k) => deps[k])) as {
    start: Harness['start']; picked: Harness['picked']; confirm: Harness['confirm'];
  };
  return { ...page, opened, posts, offloaded, toasts, els, confirm: page.confirm };
}

const BACKUP: Drive = { name: 'Backup', path: '/Volumes/Backup', freeBytes: 5e11 };
const WORK: Drive = { name: 'Work', path: '/Volumes/Work', freeBytes: 1e11 };

test('Offload… opens its picker on a connected drive, never on the disk the files are on, with the other drives as its shortcuts and a line saying why (E01)', async () => {
  const h = harness([WORK, BACKUP]);
  await h.start(['/Users/me/Mail/Mailbox 23.mbox']);
  assert.equal(h.opened.length, 1, 'control: the picker opened');
  const [start, , title, label, opts] = h.opened[0] as [string | null, unknown, string, string, { chips: Drive[]; hint: string }];
  assert.equal(title, 'Offload to…');
  assert.equal(label, 'Offload to this folder');
  assert.equal(start, '/Volumes/Work', 'it opens on a connected drive — not the home folder the selection lives in');
  assert.deepEqual(opts.chips.map((c) => c.path), ['/Volumes/Work', '/Volumes/Backup'], 'the shortcuts are the connected drives, not Desktop or Documents');
  assert.match(opts.hint, /another drive/, 'the sheet says where to pick');
  assert.match(opts.hint, /frees nothing/, 'and why a folder on the files\' own drive will not do');
  assert.deepEqual(h.posts, [], 'opening the picker plans nothing');

  const fromWork = harness([WORK, BACKUP]);
  await fromWork.start(['/Volumes/Work/Projects/old']);
  const [startW, , , , optsW] = fromWork.opened[0] as [string, unknown, string, string, { chips: Drive[] }];
  assert.equal(startW, '/Volumes/Backup', 'a selection on a drive opens on another one');
  assert.deepEqual(optsW.chips.map((c) => c.path), ['/Volumes/Backup'], 'and the drive the files are on is not offered');
});

test('with no other drive connected, the picker says so and offers no folder on this disk as a shortcut (E01)', async () => {
  const h = harness([]);
  await h.start(['/Users/me/a.mov']);
  const [start, , , , opts] = h.opened[0] as [string | null, unknown, string, string, { chips: Drive[]; hint: string }];
  assert.equal(start, null, 'nothing to open on but where the picker starts');
  assert.deepEqual(opts.chips, [], 'no Desktop / Documents / Downloads shortcuts — each is on this disk');
  assert.match(opts.hint, /No other drive is connected/);
  assert.match(opts.hint, /frees nothing/);
});

/** What GET /api/volumes answers on Windows, where drive discovery is not implemented (services/volumes.ts). */
const WINDOWS_VOLUMES = {
  volumes: [],
  reason: 'Windows drive discovery is not implemented yet, so no drives are listed on this platform — not a statement that none are attached.',
};

test('where TreeMap cannot list the drives — the server says why, or the call fails — the picker never says no other drive is connected, and keeps its usual shortcuts (E01, review F1.2)', async () => {
  const cases: Array<[string, () => unknown]> = [
    ['the server cannot list drives on this platform', () => WINDOWS_VOLUMES],
    ['the drive list could not be fetched', () => { throw new Error('Network request failed'); }],
  ];
  for (const [label, reply] of cases) {
    const h = harness([], null, reply);
    await h.start(['/Users/me/a.mov']);
    assert.equal(h.opened.length, 1, `${label}: control, the picker opened`);
    const [start, , , , opts] = h.opened[0] as [string | null, unknown, string, string, { chips?: Drive[]; hint: string }];
    assert.doesNotMatch(opts.hint, /No other drive is connected/, `${label}: a drive list nobody read is not "none connected"`);
    assert.match(opts.hint, /can't list the drives/, `${label}: it says TreeMap cannot list them`);
    assert.match(opts.hint, /type the path of a folder on another drive/, `${label}: and what to do instead`);
    assert.match(opts.hint, /frees nothing/, `${label}: and why the files' own drive will not do`);
    assert.equal(opts.chips, undefined, `${label}: the usual shortcuts stay — TreeMap cannot tell which drive they are on`);
    assert.equal(start, null, `${label}: the picker starts where it always does`);
  }
});

test('a selection on the only connected drive opens the picker on this computer\'s own disk — another drive for it — with its usual shortcuts (E01)', async () => {
  const h = harness([WORK]);
  await h.start(['/Volumes/Work/Projects/old']);
  const [start, , , , opts] = h.opened[0] as [string | null, unknown, string, string, { chips?: Drive[]; hint: string }];
  assert.equal(start, null, 'the picker starts where it always does, on this computer\'s disk');
  assert.equal(opts.chips, undefined, 'with the home folder\'s shortcuts: they are on another drive than the files');
  assert.match(opts.hint, /Pick a folder on another drive/, 'and it does not claim no other drive is connected');
  assert.doesNotMatch(opts.hint, /No other drive is connected/);
});

test('a folder picked for an offload is never moved to bare: the pick asks the dry run, the manifest goes behind the shared confirm, and only Confirm offloads — the same paths, to the same folder (E01)', async () => {
  const h = harness([BACKUP]);
  const paths = ['/Users/me/Mail/Mailbox 23.mbox', '/Users/me/Mail/Mailbox 24.mbox'];
  await h.start(paths);
  const pick = (h.opened[0] as [unknown, (dest: string) => Promise<void>])[1];
  await pick('/Volumes/Backup/Mail archive');
  assert.deepEqual(h.posts, [{ scanId: 's1', paths, dest: '/Volumes/Backup/Mail archive', dryRun: true }], 'the pick asked the pipeline\'s own dry run, and only that');
  assert.deepEqual(h.offloaded, [], 'nothing was offloaded by the pick');
  assert.equal(h.els.confirmModal?.open, true, 'the shared confirm opened');
  assert.match(h.els.confirmTitle.innerHTML, /Offload to Mail archive\?/, 'naming the folder picked');
  assert.match(h.els.confirmText.innerHTML, /<b>2<\/b> files · <b>3 GB<\/b> will be copied to <b>\/Volumes\/Backup\/Mail archive<\/b>/, 'with the dry run\'s manifest');
  assert.match(h.els.confirmText.innerHTML, /only then moved to the Trash here/, 'and what happens to the originals');
  assert.match(h.els.confirmOk.innerHTML, /Copy, verify, then trash/, 'its OK names the action');
  await h.confirm()?.();
  assert.deepEqual(h.offloaded, [[paths, '/Volumes/Backup/Mail archive']], 'Confirm hands the same paths and folder to runOffloadJob');
});

test('a plan the server refuses — a folder on the files\' own drive — is said, and no sheet opens (E01)', async () => {
  const refusal = '"me" is on the same drive as "Mailbox 23.mbox". An offload copies each file and then moves the original to the Trash, so on the same drive it frees nothing';
  const h = harness([], refusal);
  await h.start(['/Users/me/Mail/Mailbox 23.mbox']);
  const pick = (h.opened[0] as [unknown, (dest: string) => Promise<void>])[1];
  await pick('/Users/me');
  assert.equal(h.posts.length, 1, 'control: the dry run was asked');
  assert.deepEqual(h.toasts, [[`Could not plan the offload: ${refusal}`, 'error']], 'the server\'s reason, in its words');
  assert.notEqual(h.els.confirmModal?.open, true, 'no confirm opened');
  assert.equal(h.confirm(), null, 'nothing waits for a Confirm');
  assert.deepEqual(h.offloaded, [], 'nothing was offloaded');
});

test('no door moves anything bare: runOffloadJob is called in one place — the shared confirm\'s Confirm — and every other POST to /api/offload is a dry run (E01)', () => {
  const calls = [...INDEX.matchAll(/runOffloadJob\(/g)].map((m) => m.index as number)
    .filter((at) => !INDEX.slice(Math.max(0, at - 15), at).includes('function'));
  const confirmAt = INDEX.indexOf('async function confirmOffloadPlan(');
  assert.notEqual(confirmAt, -1, 'the shared door exists');
  const confirmBody = pageFunction('confirmOffloadPlan');
  assert.equal(calls.length, 1, `runOffloadJob is called from exactly one place (found ${calls.length})`);
  assert.ok(calls[0] > confirmAt && calls[0] < confirmAt + confirmBody.length, 'and that place is inside confirmOffloadPlan');
  assert.match(confirmBody, /onConfirmTrash = async \(\) => \{ await runOffloadJob\(paths, dest\); \};/, 'behind the shared confirm\'s Confirm');
  const offloadPosts = [...INDEX.matchAll(/api\('\/api\/offload', \{/g)].map((m) => m.index as number);
  assert.equal(offloadPosts.length, 2, 'two POSTs to /api/offload in the page: the dry run and the run');
  const runBody = pageFunction('runOffloadJob');
  for (const at of offloadPosts) {
    const inRun = at > INDEX.indexOf('async function runOffloadJob(') && at < INDEX.indexOf('async function runOffloadJob(') + runBody.length;
    if (!inRun) assert.match(INDEX.slice(at, at + 300), /dryRun: true/, 'every POST outside runOffloadJob is a dry run');
  }
  for (const door of ['startOffloadFlow', 'offloadPicked', 'dockDrop']) {
    assert.doesNotMatch(pageFunction(door), /runOffloadJob\(/, `${door} never calls runOffloadJob itself`);
  }
  assert.match(pageFunction('offloadPicked'), /confirmOffloadPlan\(/, 'a picked folder goes through the shared door');
  assert.match(pageFunction('dockDrop'), /confirmOffloadPlan\(/, 'and so does a drop on a drive');
});
