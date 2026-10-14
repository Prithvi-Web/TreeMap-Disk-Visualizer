import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

import { fileTempDir, isolatedDataDir } from './fixtures/dataDir';
const DATA = isolatedDataDir('treemap-offloadManifestLock-data-');
process.env.TREEMAP_NO_GDU = '1';

import { createScanRecord } from '../src/services/diskScanner';
import {
  getOffloadIndex, getOffloadJob, offloadManifestWaitersForTests, prepareOffload, setAfterManifestLoadForTests, setDestinationLookForTests,
  setDestManifestWriteForTests, startOffload, startRestore,
} from '../src/services/offload';
import { setTrashStepForTests } from '../src/services/cleaner';
import { protectItems } from '../src/services/timeCapsule';
import { abandonedCallsUnsettled, setHardLinkForTests, setStallTimerForTests } from '../src/utils/copyVerify';
import type { OffloadEntry, OffloadJob } from '../src/models/types';
import { waitFor, withinHangGuard } from './fixtures/waitFor';
import { withOpenFileCheck } from './fixtures/openFileCheck';
import { destinationsOnAnotherDrive } from './fixtures/offloadDrive';
destinationsOnAnotherDrive(); // every destination here stands for another drive (E01)

/**
 * FG3g M3 (the FG3f review's O1). An offload restore loaded offload-manifest.json when it started,
 * copied for as long as the copies took, and saved the document it had loaded — so an offload that
 * finished meanwhile was erased from the record: its originals were already in the Trash, its copies
 * sat at the destination with no record, and Restore could not list them. Two restores that
 * overlapped lost each other's "restored". Now every read-modify-write of the manifest holds one
 * lock, and a restore records what it put back on a fresh read at its end.
 *
 * Nothing here times anything: a restore is held at its first file's placement and the test waits on
 * conditions. Nothing reaches the machine's Trash: the trash step moves each original into this
 * file's own folder.
 */

const FAKE_TRASH = fileTempDir('treemap-offloadManifestLock-trash-');
let trashCalls = 0;

before(() => {
  setTrashStepForTests(async (p) => {
    fs.renameSync(p, path.join(FAKE_TRASH, `${trashCalls++}-${path.basename(p)}`));
  });
});

after(() => {
  setTrashStepForTests(null);
});

/** A complete scan of `src` listing `files`. */
function scanOf(src: string, files: string[]): ReturnType<typeof createScanRecord> {
  const scan = createScanRecord(src);
  scan.status = 'complete';
  scan.root = {
    name: path.basename(src), path: src, size: files.reduce((s, f) => s + fs.statSync(f).size, 0), type: 'dir', modifiedAt: Date.now(), isHidden: false,
    children: files.map((p) => ({ name: path.basename(p), path: p, size: fs.statSync(p).size, type: 'file' as const, modifiedAt: Date.now(), isHidden: false })),
  };
  return scan;
}

async function settled(jobId: string): Promise<OffloadJob> {
  await waitFor(() => getOffloadJob(jobId)?.status !== 'running', `the job ${jobId} settling`);
  return getOffloadJob(jobId) as OffloadJob;
}

/** Offloads `file` (in `src`) to `dest`, start to finish. */
async function offload(src: string, file: string, dest: string): Promise<OffloadJob> {
  const scan = scanOf(src, [file]);
  return withOpenFileCheck('clear', async () => {
    const prepared = await prepareOffload(scan, [file], dest);
    const job = await startOffload(scan, [file], dest, prepared);
    return settled(job.jobId);
  });
}

async function recordOf(original: string): Promise<OffloadEntry | undefined> {
  return (await getOffloadIndex()).entries.find((e) => e.originalPath === original);
}

/** Holds the first placement any restore makes until `release`; `reached` resolves when one gets there. */
function holdFirstPlacement(): { reached: Promise<void>; release: () => void; remove: () => void } {
  let arrive!: () => void;
  const reached = new Promise<void>((resolve) => { arrive = resolve; });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let held = false;
  const remove = setHardLinkForTests(async (existing, link) => {
    if (!held) {
      held = true;
      arrive();
      await gate;
    }
    await fs.promises.link(existing, link);
  });
  return { reached, release, remove };
}

function files(label: string, ...names: string[]): { src: string; paths: string[] } {
  const src = fileTempDir(`treemap-offloadManifestLock-${label}-src-`);
  const paths = names.map((n, i) => {
    const p = path.join(src, n);
    fs.writeFileSync(p, Buffer.alloc(4096, i + 1));
    return p;
  });
  return { src, paths };
}

test('an offload that finishes while a restore runs is still recorded once the restore has saved (FG3f review O1)', async () => {
  const { src, paths: [r, o] } = files('o1', 'r.bin', 'o.bin');
  const first = await offload(src, r, fileTempDir('treemap-offloadManifestLock-o1-dest1-'));
  assert.equal(first.status, 'complete', first.error);
  const rId = (await recordOf(r))?.id;
  assert.ok(rId);
  const hold = holdFirstPlacement();
  try {
    const restore = await startRestore([rId]);
    await withinHangGuard(hold.reached, 'the restore reaching its placement');
    const dest2 = fileTempDir('treemap-offloadManifestLock-o1-dest2-');
    const second = await offload(src, o, dest2); // a whole offload completes meanwhile
    assert.equal(second.status, 'complete', second.error);
    assert.equal(fs.existsSync(o), false, 'its original is in the Trash');
    hold.release();
    const done = await settled(restore.jobId);
    assert.equal(done.status, 'complete', done.error);
  } finally {
    hold.release();
    hold.remove();
  }
  const ofO = await recordOf(o);
  assert.ok(ofO, 'the second offload is still recorded: Restore can list its copies');
  assert.equal(ofO.restoredAt, undefined);
  assert.ok(fs.existsSync(ofO.destPath), 'and its copy is where the record says');
  assert.ok((await recordOf(r))?.restoredAt, 'and the restore recorded what it put back');
  assert.ok(fs.readFileSync(r).equals(Buffer.alloc(4096, 1)), 'r.bin is back');
});

test('two restores that overlap each keep what the other recorded', async () => {
  const { src, paths: [x, y] } = files('pair', 'x.bin', 'y.bin');
  const dest = fileTempDir('treemap-offloadManifestLock-pair-dest-');
  assert.equal((await offload(src, x, dest)).status, 'complete');
  assert.equal((await offload(src, y, dest)).status, 'complete');
  const xId = (await recordOf(x))?.id;
  const yId = (await recordOf(y))?.id;
  assert.ok(xId && yId);
  const hold = holdFirstPlacement();
  try {
    const first = await startRestore([xId]);
    await withinHangGuard(hold.reached, 'the first restore reaching its placement');
    const second = await startRestore([yId]); // passes the hold: only the first placement is held
    assert.equal((await settled(second.jobId)).status, 'complete');
    assert.ok((await recordOf(y))?.restoredAt, 'the second restore recorded y');
    hold.release();
    assert.equal((await settled(first.jobId)).status, 'complete');
  } finally {
    hold.release();
    hold.remove();
  }
  assert.ok((await recordOf(x))?.restoredAt, 'x is recorded as restored');
  assert.ok((await recordOf(y))?.restoredAt, 'and y still is: the first restore did not save over it');
});

test('an offload that finishes while the Offloaded tab is being read is still recorded: the tab\'s "last seen" never saves over it', async () => {
  const { src, paths: [seen, o] } = files('index', 'seen.bin', 'o.bin');
  const dest = fileTempDir('treemap-offloadManifestLock-index-dest-');
  assert.equal((await offload(src, seen, dest)).status, 'complete'); // a mounted destination: reading the tab writes its "last seen"
  let arrive!: () => void;
  const reached = new Promise<void>((resolve) => { arrive = resolve; });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  const unhook = setAfterManifestLoadForTests(async () => {
    if (++calls > 1) return; // only the tab's own read is held
    arrive();
    await gate;
  });
  let job: OffloadJob | null = null;
  try {
    const reading = getOffloadIndex(); // the tab reads the manifest, and is held before it saves
    await withinHangGuard(reached, 'the tab having read the manifest');
    const scan = scanOf(src, [o]);
    await withOpenFileCheck('clear', async () => {
      const prepared = await prepareOffload(scan, [o], dest);
      const started = await startOffload(scan, [o], dest, prepared);
      await waitFor(() => getOffloadJob(started.jobId)?.status !== 'running' || offloadManifestWaitersForTests() > 0,
        'the offload finishing, or its record waiting for the tab');
      release();
      await reading;
      job = await settled(started.jobId);
    });
  } finally {
    release();
    unhook();
  }
  assert.equal((job as OffloadJob | null)?.status, 'complete');
  assert.ok(await recordOf(o), 'the offload that finished meanwhile is recorded');
  assert.equal(fs.existsSync(o), false, 'its original is in the Trash, so the record is the only way back');
});

test('an offload that finishes while a restore is recording what it put back is kept as well', async () => {
  const { src, paths: [x, o] } = files('end', 'x.bin', 'o.bin');
  const dest = fileTempDir('treemap-offloadManifestLock-end-dest-');
  assert.equal((await offload(src, x, dest)).status, 'complete');
  const xId = (await recordOf(x))?.id;
  assert.ok(xId);
  let arrive!: () => void;
  const reached = new Promise<void>((resolve) => { arrive = resolve; });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  // The first read is the restore's look at what to restore; the second, its record at the end.
  const unhook = setAfterManifestLoadForTests(async () => {
    if (++calls !== 2) return;
    arrive();
    await gate;
  });
  let restoreJob = '';
  let offloadJob: OffloadJob | null = null;
  try {
    restoreJob = (await startRestore([xId])).jobId;
    await withinHangGuard(reached, 'the restore reading the manifest to record what it put back');
    const scan = scanOf(src, [o]);
    await withOpenFileCheck('clear', async () => {
      const prepared = await prepareOffload(scan, [o], dest);
      const started = await startOffload(scan, [o], dest, prepared);
      await waitFor(() => getOffloadJob(started.jobId)?.status !== 'running' || offloadManifestWaitersForTests() > 0,
        'the offload finishing, or its record waiting for the restore\'s');
      release();
      offloadJob = await settled(started.jobId);
    });
  } finally {
    release();
    unhook();
  }
  assert.equal((await settled(restoreJob)).status, 'complete');
  assert.equal((offloadJob as OffloadJob | null)?.status, 'complete');
  assert.ok(await recordOf(o), 'the offload that finished meanwhile is recorded');
  assert.ok((await recordOf(x))?.restoredAt, 'and so is what the restore put back');
});

test('every save of the offload manifest is inside its lock: no read-modify-write overlaps another', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'offload.ts'), 'utf8');
  const source = ts.createSourceFile('offload.ts', text, ts.ScriptTarget.Latest, true);
  const sites: { line: number; locked: boolean }[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'saveManifest') {
      let locked = false;
      for (let up: ts.Node | undefined = node.parent; up; up = up.parent) {
        if (ts.isCallExpression(up) && ts.isIdentifier(up.expression) && up.expression.text === 'withOffloadManifest') {
          locked = true;
          break;
        }
      }
      sites.push({ line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1, locked });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  // An offload's record, a restore's "put back", and the index's "last seen".
  assert.ok(sites.length >= 3, `found ${sites.length} saveManifest calls; expected at least 3`);
  assert.deepEqual(sites.filter((s) => !s.locked).map((s) => s.line), [], 'saveManifest outside withOffloadManifest');
});

/* ─────────────── FG3g review F1.2: the record on a destination drive is written outside the lock ─────────────── */

/** Holds each write of the record on `destRoot` until `release`; `reached` resolves when one gets there. */
function holdDestRecord(destRoot: string): { reached: Promise<void>; release: () => void; remove: () => void } {
  let arrive!: () => void;
  const reached = new Promise<void>((resolve) => { arrive = resolve; });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const remove = setDestManifestWriteForTests(async (root) => {
    if (root !== destRoot) return;
    arrive();
    await gate; // as a drive that stops answering
  });
  return { reached, release, remove };
}

test('an offload whose destination drive stops answering while its record is written there holds no other record: another offload finishing meanwhile is saved at once', async () => {
  const { src, paths: [a, b] } = files('dest-quiet', 'a.bin', 'b.bin');
  const destA = fileTempDir('treemap-offloadManifestLock-dest-quiet-a-');
  const destB = fileTempDir('treemap-offloadManifestLock-dest-quiet-b-');
  const hold = holdDestRecord(destA);
  let first: OffloadJob | null = null;
  try {
    const scanA = scanOf(src, [a]);
    let startedA = '';
    await withOpenFileCheck('clear', async () => {
      const prepared = await prepareOffload(scanA, [a], destA);
      startedA = (await startOffload(scanA, [a], destA, prepared)).jobId;
      await withinHangGuard(hold.reached, 'the first offload writing its record on its drive');
    });
    // Read from the file itself: the Offloaded tab's read takes the manifest's lock.
    const saved = JSON.parse(fs.readFileSync(path.join(DATA, 'offload-manifest.json'), 'utf8')) as { entries: OffloadEntry[] };
    assert.ok(saved.entries.some((e) => e.originalPath === a), 'its own record in app-data is saved before the drive is touched');
    // A second offload, to another drive, finishes start to end — its originals go to the Trash
    // before its record is saved, so the record is the only way back to them.
    const scanB = scanOf(src, [b]);
    let startedB = '';
    await withOpenFileCheck('clear', async () => {
      const prepared = await prepareOffload(scanB, [b], destB);
      startedB = (await startOffload(scanB, [b], destB, prepared)).jobId;
      await waitFor(() => getOffloadJob(startedB)?.status !== 'running' || offloadManifestWaitersForTests() > 0,
        'the second offload finishing, or its record waiting for the first one\'s drive');
    });
    assert.equal(offloadManifestWaitersForTests(), 0, 'nothing waits on the drive that stopped answering');
    assert.equal(getOffloadJob(startedB)?.status, 'complete', getOffloadJob(startedB)?.error);
    assert.ok(await recordOf(b), 'the second offload is recorded while the first drive is still quiet');
    assert.equal(getOffloadJob(startedA)?.status, 'running', 'the case is the one under test: the first is still writing to its drive');
    hold.release();
    first = await settled(startedA);
  } finally {
    hold.release();
    hold.remove();
  }
  assert.equal((first as OffloadJob | null)?.status, 'complete', (first as OffloadJob | null)?.error);
  const onDrive = JSON.parse(fs.readFileSync(path.join(destA, 'treemap-offload-manifest.json'), 'utf8')) as { entries: OffloadEntry[] };
  assert.deepEqual(onDrive.entries.map((e) => e.originalPath), [a], 'and the first drive\'s record, once it answered, holds its own entry');
});

test('an offload whose destination drive never answers while its record is written there finishes once the limit passes, saying so - its record in app-data kept', async () => {
  const { src, paths: [c] } = files('dest-never', 'c.bin');
  const dest = fileTempDir('treemap-offloadManifestLock-dest-never-');
  const timers: { ms: number; fire: () => void }[] = [];
  const untimer = setStallTimerForTests((ms, onExpire) => {
    timers.push({ ms, fire: onExpire });
    return () => {};
  });
  const hold = holdDestRecord(dest);
  let job: OffloadJob | null = null;
  try {
    const scan = scanOf(src, [c]);
    await withOpenFileCheck('clear', async () => {
      const prepared = await prepareOffload(scan, [c], dest);
      const started = await startOffload(scan, [c], dest, prepared);
      await withinHangGuard(hold.reached, 'the offload writing its record on its drive');
      await waitFor(() => timers.length > 0, 'the limit on the drive\'s record being armed');
      const before = abandonedCallsUnsettled();
      timers[timers.length - 1].fire(); // the limit passes with the drive still quiet
      job = await settled(started.jobId);
      // Not one of the Time Capsule's calls (final review F1.6): one write per drive at a time bounds it.
      assert.equal(abandonedCallsUnsettled(), before, 'the write left waiting on the drive is not counted as a call the Time Capsule left waiting');
      hold.release();
    });
  } finally {
    hold.release();
    hold.remove();
    untimer();
  }
  const done = job as OffloadJob | null;
  assert.equal(timers[0]?.ms, 60_000);
  assert.equal(done?.status, 'complete', done?.error);
  assert.match(done?.error ?? '', /did not answer for 60 seconds/, done?.error);
  assert.match(done?.error ?? '', /TreeMap's own record of them is kept/, done?.error);
  assert.ok(await recordOf(c), 'the app-data record, which Restore reads, is saved');
});

/* ─────────────── FG3g review F2.1: one drive's record is written one write at a time ─────────────── */

test('two offloads to one drive write its record one at a time: the second waits for the first, and the record lists both', async () => {
  const { src, paths: [one, two] } = files('dest-pair', 'one.bin', 'two.bin');
  const dest = fileTempDir('treemap-offloadManifestLock-dest-pair-');
  const timers: { ms: number; fire: () => void }[] = [];
  const untimer = setStallTimerForTests((ms, onExpire) => {
    timers.push({ ms, fire: onExpire });
    return () => {};
  });
  // Each write of the drive's record is held at its start until released; `began` counts those begun.
  let began = 0;
  const gates: (() => void)[] = [];
  const unhook = setDestManifestWriteForTests(async (root) => {
    if (root !== dest) return;
    began++;
    await new Promise<void>((resolve) => { gates.push(resolve); });
  });
  const jobs: string[] = [];
  try {
    for (const [i, f] of [one, two].entries()) {
      const scan = scanOf(src, [f]);
      await withOpenFileCheck('clear', async () => {
        const prepared = await prepareOffload(scan, [f], dest);
        jobs.push((await startOffload(scan, [f], dest, prepared)).jobId);
        // Its write of the drive's record is under way or waiting: either way it armed that write's limit.
        await waitFor(() => timers.length > i, `offload ${i + 1} at its write of the drive's record`);
      });
    }
    assert.equal(began, 1, 'one write of the drive\'s record is under way; the other waits its turn, so neither saves over the other');
    gates[0]();
    await waitFor(() => began === 2, 'the second write beginning once the first has finished');
    gates[1]();
    for (const id of jobs) {
      const job = await settled(id);
      assert.equal(job.status, 'complete', job.error);
      assert.equal(job.error, undefined, 'and each record was written');
    }
  } finally {
    for (const open of gates) open();
    unhook();
    untimer();
  }
  const onDrive = JSON.parse(fs.readFileSync(path.join(dest, 'treemap-offload-manifest.json'), 'utf8')) as { entries: OffloadEntry[] };
  assert.deepEqual(onDrive.entries.map((e) => e.originalPath).sort(), [one, two].sort(), 'the drive\'s own record lists both offloads');
});

/**
 * The final review, F1.6: each write of a drive's record left waiting at its limit was counted with the
 * calls the Time Capsule left waiting, and two of those stop every capsule copy - so two offloads to one
 * drive that stopped answering made every cart commit and Autopilot deletion, on every volume, refuse
 * as CAPSULE_COPY_FAILED until the drive answered or TreeMap restarted. The second was not even a call
 * on the drive: it waits its turn behind the first (one write of a drive's record at a time), which is
 * what bounds them.
 */
test('two offloads to a drive that never answers while its record is written leave the Time Capsule able to copy: a deletion elsewhere still goes', async () => {
  const { src, paths: [one, two] } = files('dest-quiet-pair', 'one.bin', 'two.bin');
  const dest = fileTempDir('treemap-offloadManifestLock-dest-quiet-pair-');
  await waitFor(() => abandonedCallsUnsettled() === 0, 'every earlier call left waiting returning');
  const timers: { ms: number; fire: () => void }[] = [];
  const untimer = setStallTimerForTests((ms, onExpire) => {
    timers.push({ ms, fire: onExpire });
    return () => {};
  });
  const gates: (() => void)[] = [];
  const unhook = setDestManifestWriteForTests(async (root) => {
    if (root !== dest) return;
    await new Promise<void>((resolve) => { gates.push(resolve); }); // a drive that stopped answering
  });
  try {
    for (const [i, f] of [one, two].entries()) {
      const scan = scanOf(src, [f]);
      const job = await withOpenFileCheck('clear', async () => {
        const prepared = await prepareOffload(scan, [f], dest);
        const started = await startOffload(scan, [f], dest, prepared);
        await waitFor(() => timers.length > i, `offload ${i + 1} at its write of the drive's record`);
        timers[i].fire(); // the limit passes with the drive still quiet
        return settled(started.jobId);
      });
      assert.equal(job.status, 'complete', job.error);
      assert.match(job.error ?? '', /did not answer for 60 seconds/, job.error);
    }
    assert.equal(abandonedCallsUnsettled(), 0, 'neither write left waiting is counted as a call the Time Capsule left waiting');
    const local = path.join(fileTempDir('treemap-offloadManifestLock-dest-quiet-pair-local-'), 'local.txt');
    fs.writeFileSync(local, 'a file on a disk that answers');
    const [outcome] = (await protectItems([{ path: local }])).outcomes;
    assert.equal(outcome.protected, true, `a copy is still made, so a deletion still goes: ${outcome.detail ?? ''}`);
  } finally {
    for (const open of gates) open();
    await waitFor(() => gates.length >= 2, 'the second write beginning once the first returned');
    for (const open of gates) open();
    unhook();
    untimer();
  }
});

/* ─────────────── FG3g review F2.6: the Offloaded tab looks at destinations with no lock held ─────────────── */

test('the Offloaded tab\'s look at a destination that does not answer holds no record: an offload finishing meanwhile is saved at once, and the tab shows that drive not connected at the limit', async () => {
  const { src, paths: [seen, o] } = files('look-quiet', 'seen.bin', 'o.bin');
  const quiet = fileTempDir('treemap-offloadManifestLock-look-quiet-a-');
  const other = fileTempDir('treemap-offloadManifestLock-look-quiet-b-');
  assert.equal((await offload(src, seen, quiet)).status, 'complete');
  const manifestFile = path.join(DATA, 'offload-manifest.json');
  const lastSeen = (root: string): number | undefined => (JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as { destinations: Record<string, { lastSeenAt: number }> }).destinations[root]?.lastSeenAt;
  const seenBefore = lastSeen(quiet);
  const timers: { ms: number; fire: () => void }[] = [];
  const untimer = setStallTimerForTests((ms, onExpire) => {
    timers.push({ ms, fire: onExpire });
    return () => {};
  });
  let asked = 0;
  /** Which of `timers` is the quiet look's: it is armed the moment its look is asked. */
  let quietTimer = -1;
  let answer!: (mounted: boolean) => void;
  const answered = new Promise<boolean>((resolve) => { answer = resolve; });
  const unlook = setDestinationLookForTests((root) => {
    if (root !== quiet) return null;
    asked++;
    quietTimer = timers.length;
    return answered; // a drive that stopped answering
  });
  let index: Awaited<ReturnType<typeof getOffloadIndex>> | null = null;
  try {
    const reading = getOffloadIndex();
    await waitFor(() => asked > 0, 'the tab looking at the quiet destination');
    const scan = scanOf(src, [o]);
    let job: OffloadJob | null = null;
    await withOpenFileCheck('clear', async () => {
      const prepared = await prepareOffload(scan, [o], other);
      const started = await startOffload(scan, [o], other, prepared);
      await waitFor(() => getOffloadJob(started.jobId)?.status !== 'running' || offloadManifestWaitersForTests() > 0,
        'the offload finishing, or its record waiting for the tab');
      assert.equal(offloadManifestWaitersForTests(), 0, 'nothing waits on the tab\'s look at the quiet drive');
      job = await settled(started.jobId);
    });
    assert.equal((job as OffloadJob | null)?.status, 'complete', (job as OffloadJob | null)?.error);
    assert.ok((JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as { entries: OffloadEntry[] }).entries.some((e) => e.originalPath === o),
      'its record is saved while the tab still waits on the quiet drive');
    const lookLimit = timers[quietTimer];
    assert.equal(lookLimit?.ms, 10_000, 'the look has a limit of its own');
    lookLimit.fire(); // the limit passes with the drive still quiet
    index = await withinHangGuard(reading, 'the tab answering once the limit passed');
  } finally {
    answer(true);
    unlook();
    untimer();
  }
  const ofQuiet = index?.destinations.find((d) => d.root === quiet);
  assert.equal(ofQuiet?.mounted, false, 'a drive that did not answer is shown not connected');
  assert.equal(lastSeen(quiet), seenBefore, 'and it is not recorded as seen');
  assert.ok(index?.entries.some((e) => e.originalPath === seen), 'the tab lists what the record held when it read it');
  // The drive answers now: it is recorded as seen when the tab is read again. A mark first, so the
  // write is seen whatever the clock reads.
  const marked = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as { destinations: Record<string, { lastSeenAt: number }> };
  marked.destinations[quiet] = { lastSeenAt: 1 };
  fs.writeFileSync(manifestFile, JSON.stringify(marked));
  const again = await getOffloadIndex();
  const quietNow = again.destinations.find((d) => d.root === quiet);
  assert.equal(quietNow?.mounted, true);
  assert.notEqual(quietNow?.lastSeenAt, 1);
  assert.equal(lastSeen(quiet), quietNow?.lastSeenAt, 'a destination that answers is recorded as seen');
  assert.ok((JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as { entries: OffloadEntry[] }).entries.some((e) => e.originalPath === o),
    'and saving "last seen" kept the offload saved meanwhile');
});

/* ─────────────── FG3g review F3.3: the tab's looks count against nothing else, and are one per drive ─────────────── */

test('the Offloaded tab\'s looks at drives that do not answer are not the Time Capsule\'s calls, and a view while one is out starts no other: a deletion still goes, and views look once per drive until it returns', async () => {
  const { src, paths: [a, b] } = files('look-shared', 'a.bin', 'b.bin');
  const nasA = fileTempDir('treemap-offloadManifestLock-look-shared-a-');
  const nasB = fileTempDir('treemap-offloadManifestLock-look-shared-b-');
  assert.equal((await offload(src, a, nasA)).status, 'complete');
  assert.equal((await offload(src, b, nasB)).status, 'complete');
  await waitFor(() => abandonedCallsUnsettled() === 0, 'every earlier call left waiting returning');
  const timers: { ms: number; fire: () => void }[] = [];
  const untimer = setStallTimerForTests((ms, onExpire) => {
    timers.push({ ms, fire: onExpire });
    return () => {};
  });
  const asked = new Map<string, number>();
  let answer!: (mounted: boolean) => void;
  const answered = new Promise<boolean>((resolve) => { answer = resolve; });
  const unlook = setDestinationLookForTests((root) => {
    if (root !== nasA && root !== nasB) return null;
    asked.set(root, (asked.get(root) ?? 0) + 1);
    return answered; // two drives that stopped answering
  });
  const mountedOf = (index: Awaited<ReturnType<typeof getOffloadIndex>>): (boolean | undefined)[] =>
    [nasA, nasB].map((root) => index.destinations.find((d) => d.root === root)?.mounted);
  try {
    const first = getOffloadIndex();
    await waitFor(() => asked.size === 2, 'the tab looking at both quiet drives');
    for (const timer of timers) timer.fire(); // both limits pass with the drives still quiet
    assert.deepEqual(mountedOf(await withinHangGuard(first, 'the tab answering once the limits passed')), [false, false]);
    assert.equal(abandonedCallsUnsettled(), 0, 'the looks left waiting are not counted as calls the Time Capsule left waiting');
    const local = path.join(fileTempDir('treemap-offloadManifestLock-look-shared-local-'), 'local.txt');
    fs.writeFileSync(local, 'a file on a disk that answers');
    const [outcome] = (await protectItems([{ path: local }])).outcomes;
    assert.equal(outcome.protected, true, `a copy is still made, so a deletion still goes: ${outcome.detail ?? ''}`);
    for (let view = 0; view < 3; view++) {
      // Any limit a later view arms passes at once, so a look it started is counted, never waited on.
      const armedBefore = timers.length;
      let answeredView = false;
      const viewing = getOffloadIndex().finally(() => { answeredView = true; });
      await waitFor(() => answeredView || timers.length > armedBefore, 'a later view answering, or arming a limit');
      for (const timer of timers.slice(armedBefore)) timer.fire();
      assert.deepEqual(mountedOf(await withinHangGuard(viewing, 'a later view answering')), [false, false], 'a later view shows them not connected');
    }
    assert.deepEqual([asked.get(nasA), asked.get(nasB)], [1, 1], 'and starts no other look at a drive whose look is still out');
  } finally {
    answer(true);
    unlook();
    untimer();
  }
  // The drives answer: their looks return, and the next view looks again.
  await waitFor(async () => mountedOf(await getOffloadIndex()).every((m) => m === true), 'a view after the looks returned seeing both drives');
});
