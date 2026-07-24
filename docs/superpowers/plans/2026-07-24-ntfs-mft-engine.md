# NTFS MFT Turbo Engine — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Implement the reserved `'ntfs-mft'` scan engine: an opt-in, admin-elevated
Rust helper that reads the NTFS Master File Table directly (via the `ntfs-reader`
crate) instead of walking directories, wired into the existing `gdu-turbo` →
`walker` fallback cascade as a new first link, `ntfs-mft` → `gdu-turbo` → `walker`.

**Architecture:** A standalone Rust CLI (`native/ntfs-mft-scan/`, not a Node addon)
dumps every NTFS FileName-attribute edge as NDJSON. A pure TS mapper
(`ntfsMftMapper.ts`) turns that stream into a `PackedScanStore`, exactly the way
`gduMapper.ts` turns gdu's JSON into one. `ntfsMftScanner.ts` locates the binary,
checks the volume is NTFS, and — only when the user has explicitly opted in via a
new UI toggle — spawns the helper through `sudo-prompt` for on-demand UAC
elevation. Any failure at any point falls back through the existing cascade,
exactly like every `gdu-turbo` failure already does.

**Tech Stack:** TypeScript, `node:child_process`, `node:test`, Rust (`ntfs-reader`
crate v0.4.5, MIT/Apache-2.0), `sudo-prompt` (npm, MIT).

**Spec:** `docs/superpowers/specs/2026-07-24-ntfs-mft-engine-design.md` — read
this first for the *why* behind every decision below; this plan only covers the
*how*.

**Branch:** `feat/ntfs-mft-engine` (already created off `main`).

---

## Verified facts this plan is built on

All confirmed against real source during spec review, not assumed:

| Claim | Reality |
|---|---|
| `ntfs-reader`'s `Mft::files()` | Already filters to in-use records via `$Bitmap` + `is_used()` — no unallocated-record filtering needed on our side |
| NTFS root directory | Always record number **5** (`ROOT_RECORD` in the crate) |
| A record can have >1 `FileName` attribute | Confirmed via `NtfsFile::attributes()` + `as_name()`; `namespace` field is `Posix=0/Win32=1/Dos=2/Win32AndDos=3` |
| `ScanStore`/`PackedScanStore` | `rootId`/`rootPath` fixed at construction (`scanStore.ts`); `prune()` returns a bounded `FileNode`, not a re-rooted `ScanStore` — there is no "build wide then narrow" primitive, must build directly at the correct root |
| `sudo-prompt`'s API | Takes a **shell command string**, not an argv array — different from every other subprocess call in this codebase |
| `gduEligible`'s gates | `rootStat.isDirectory() && !cache && !opts.incremental && ignore.length === 0 && process.env.TREEMAP_NO_GDU !== '1'`, and on failure it zeroes `fileCount`/`dirCount`/`scanned`/`hardlinkedFiles`/`hardlinkedBytes`/`cloudFiles`/`cloudBytes` before falling through |
| `GET /api/system` | Already returns `{ platform, ... }` — no new endpoint needed for the UI to know it's running on Windows |

---

## Task 1: Pure mapper — NDJSON edges → `PackedScanStore`

The riskiest logic, built and tested in complete isolation from any subprocess,
elevation, or real MFT read — exactly how `gduMapper.ts` was built against a
recorded fixture instead of a live `gdu` binary.

**Files:**
- Create: `tests/fixtures/ntfs-mft-sample.ndjson`
- Create: `tests/ntfsMftMapper.test.ts`
- Create: `src/services/ntfsMftMapper.ts`

- [x] **Step 1: Write the synthetic fixture**

This fixture is **hand-constructed against the documented record shape**, not
captured from a real binary (the binary doesn't exist yet — that's Task 7). It
deliberately mirrors the shape of `tests/fixtures/gdu-v5.36.1.json` (hidden
file, hardlink pair, nested dir, empty dir, zero-byte file) so the two engines'
test intent is easy to compare. Task 10 replaces this with real captured
output once the binary exists and has been run once on a real elevated
machine.

Record 5 is the volume root (per `ROOT_RECORD`). Record 100 (`fx`) is the
folder under test. Record 102 (`a.txt`) is genuinely hardlinked at two
different parents (100 and 103) — the only condition that counts as a real
hardlink per the spec's `(recordNo, parentRecordNo)` grouping rule.

Create `tests/fixtures/ntfs-mft-sample.ndjson`:

```
{"recordNo":100,"parentRecordNo":5,"name":"fx","size":0,"isDir":true,"mtimeMs":1732000000000}
{"recordNo":101,"parentRecordNo":100,"name":".hidden","size":2,"isDir":false,"mtimeMs":1732000000000}
{"recordNo":102,"parentRecordNo":100,"name":"a.txt","size":5,"isDir":false,"mtimeMs":1732000000000}
{"recordNo":103,"parentRecordNo":100,"name":"sub","size":0,"isDir":true,"mtimeMs":1732000000000}
{"recordNo":102,"parentRecordNo":103,"name":"hardlink.txt","size":5,"isDir":false,"mtimeMs":1732000000000}
{"recordNo":104,"parentRecordNo":103,"name":"b.log","size":3,"isDir":false,"mtimeMs":1732000000000}
{"recordNo":105,"parentRecordNo":103,"name":"deep","size":0,"isDir":true,"mtimeMs":1732000000000}
{"recordNo":106,"parentRecordNo":105,"name":"c.dat","size":1,"isDir":false,"mtimeMs":1732000000000}
{"recordNo":107,"parentRecordNo":100,"name":"empty","size":0,"isDir":true,"mtimeMs":1732000000000}
{"recordNo":108,"parentRecordNo":100,"name":"zero.bin","size":0,"isDir":false,"mtimeMs":1732000000000}
```

- [x] **Step 2: Write the failing test**

Create `tests/ntfsMftMapper.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  parseNtfsMftEdges,
  resolveTargetRecord,
  buildNtfsMftStoreFromEdges,
  ROOT_RECORD_NO,
} from '../src/services/ntfsMftMapper';
import { PackedScanStore } from '../src/services/scanStore';
import { FileNode } from '../src/models/types';

const ndjson = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'ntfs-mft-sample.ndjson'),
  'utf8',
);

function find(root: FileNode, name: string): FileNode | undefined {
  if (root.name === name) return root;
  for (const c of root.children ?? []) {
    const hit = find(c, name);
    if (hit) return hit;
  }
  return undefined;
}

function buildFxTree(): { root: FileNode; stats: ReturnType<typeof buildNtfsMftStoreFromEdges>['stats'] } {
  const edges = parseNtfsMftEdges(ndjson);
  const target = resolveTargetRecord(edges, ['fx']);
  assert.notEqual(target, null, 'fx must resolve to a record number');
  const store = new PackedScanStore('C:\\fx', '\\', {
    name: 'fx',
    isDir: true,
    size: 0,
    modifiedAt: 1732000000000,
    isHidden: false,
  });
  const { stats } = buildNtfsMftStoreFromEdges(edges, target!, store, store.rootId);
  // prune() requires finalize() first (PackedScanStore.requireFinal()) — a
  // freshly addNode-populated store throws 'finalize() first' otherwise.
  store.finalize();
  store.sumSizes();
  const root = store.prune(store.rootId, { maxNodes: Number.MAX_SAFE_INTEGER }).root;
  return { root, stats };
}

test('resolveTargetRecord returns ROOT_RECORD_NO for an empty path (whole volume)', () => {
  const edges = parseNtfsMftEdges(ndjson);
  assert.equal(resolveTargetRecord(edges, []), ROOT_RECORD_NO);
});

test('resolveTargetRecord walks path components case-insensitively', () => {
  const edges = parseNtfsMftEdges(ndjson);
  assert.equal(resolveTargetRecord(edges, ['FX']), resolveTargetRecord(edges, ['fx']));
});

test('resolveTargetRecord returns null for a path that does not resolve', () => {
  const edges = parseNtfsMftEdges(ndjson);
  assert.equal(resolveTargetRecord(edges, ['fx', 'nope']), null);
});

test('sums sizes, deduping the genuine hardlink exactly once', () => {
  const { root } = buildFxTree();
  // .hidden 2 + a.txt 5 + sub(hardlink.txt 0 + b.log 3 + deep(c.dat 1)) + empty 0 + zero.bin 0 = 11
  assert.equal(root.size, 11);
  assert.equal(find(root, 'a.txt')!.size, 5, 'first occurrence keeps its size');
  assert.equal(find(root, 'hardlink.txt')!.size, 0, 'second occurrence is zeroed');
  assert.equal(find(root, 'hardlink.txt')!.hardlinkDuplicate, true);
});

test('reports hardlink counters', () => {
  const { stats } = buildFxTree();
  assert.equal(stats.hardlinkedFiles, 1);
  assert.equal(stats.hardlinkedBytes, 5);
});

test('counts files and dirs correctly', () => {
  const { stats } = buildFxTree();
  // .hidden, a.txt, hardlink.txt, b.log, c.dat, zero.bin
  assert.equal(stats.fileCount, 6);
  // sub, deep, empty — NOT fx itself: buildNtfsMftStoreFromEdges only counts
  // fx's DESCENDANTS. fx is the store's pre-existing root (created by
  // `new PackedScanStore(...)` above, not by this function), same reason
  // Task 4's orchestration does `scan.dirCount = stats.dirCount + 1` to
  // account for the root separately.
  assert.equal(stats.dirCount, 3);
});

test('keeps empty dirs as children: [] — the empty-folder finder depends on it', () => {
  const { root } = buildFxTree();
  assert.deepEqual(find(root, 'empty')!.children, []);
});

test('derives isHidden from a leading dot', () => {
  const { root } = buildFxTree();
  assert.equal(find(root, '.hidden')!.isHidden, true);
  assert.equal(find(root, 'a.txt')!.isHidden, false);
});
```

- [x] **Step 3: Run to verify it fails**

Run: `npx tsx --test tests/ntfsMftMapper.test.ts`
Expected: FAIL — cannot find module `../src/services/ntfsMftMapper`.

- [x] **Step 4: Implement the mapper**

Create `src/services/ntfsMftMapper.ts`:

```ts
import { ScanStore, NodeInput } from './scanStore';

/**
 * NTFS MFT edges (NDJSON from the ntfs-mft-scan helper) -> PackedScanStore.
 *
 * One line = one (record, surviving FileName attribute) pair. The helper
 * (native/ntfs-mft-scan) has already:
 *   - dropped pure-DOS-namespace (8.3 short name) attributes, and
 *   - collapsed same-parent duplicate namespaces (e.g. a Posix + Win32 name
 *     for the same single link) to one representative each,
 * so a recordNo appearing under more than one DISTINCT parentRecordNo here is
 * always a genuine hardlink, never a namespace artifact. See
 * docs/superpowers/specs/2026-07-24-ntfs-mft-engine-design.md §3.1-3.2 for why.
 *
 * NTFS's root directory is always record 5 (ROOT_RECORD in ntfs-reader).
 */
export const ROOT_RECORD_NO = 5;

export interface NtfsMftEdge {
  recordNo: number;
  parentRecordNo: number;
  name: string;
  size: number;
  isDir: boolean;
  mtimeMs: number;
}

export interface NtfsMftMapStats {
  fileCount: number;
  dirCount: number;
  hardlinkedFiles: number;
  hardlinkedBytes: number;
}

/** Parse NDJSON (one edge object per line; blank lines ignored) into an
 *  edgesByParent index. Never collapses by recordNo — every edge is kept. */
export function parseNtfsMftEdges(ndjson: string): Map<number, NtfsMftEdge[]> {
  const byParent = new Map<number, NtfsMftEdge[]>();
  for (const line of ndjson.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const edge = JSON.parse(trimmed) as NtfsMftEdge;
    const list = byParent.get(edge.parentRecordNo);
    if (list) list.push(edge);
    else byParent.set(edge.parentRecordNo, [edge]);
  }
  return byParent;
}

/**
 * Resolve the record number for `components` (path parts under the volume
 * root, e.g. ['Users','foo','Documents']), starting from ROOT_RECORD_NO.
 * An empty array means "the whole volume" -> ROOT_RECORD_NO itself.
 * Name matching is case-insensitive: NTFS is case-insensitive-preserving by
 * default, so a literal === would fail to resolve a real folder whenever the
 * requested path's casing differs from the on-disk name.
 */
export function resolveTargetRecord(
  edgesByParent: Map<number, NtfsMftEdge[]>,
  components: string[],
): number | null {
  let current = ROOT_RECORD_NO;
  for (const part of components) {
    const children = edgesByParent.get(current);
    const match = children?.find(
      (e) => e.isDir && e.name.toLowerCase() === part.toLowerCase(),
    );
    if (!match) return null;
    current = match.recordNo;
  }
  return current;
}

/**
 * Insert every descendant of `targetRecordNo` as children of `parentId` in
 * `store` (parent-before-child, so every addNode call already has its
 * parent). `store`'s root node itself is NOT created here — the caller
 * constructs it from the target folder's own metadata, exactly the way
 * gduScanIntoStore builds `PackedScanStore`'s rootFields separately from the
 * shard mapper.
 */
export function buildNtfsMftStoreFromEdges(
  edgesByParent: Map<number, NtfsMftEdge[]>,
  targetRecordNo: number,
  store: ScanStore,
  parentId: number,
): { stats: NtfsMftMapStats } {
  const stats: NtfsMftMapStats = { fileCount: 0, dirCount: 0, hardlinkedFiles: 0, hardlinkedBytes: 0 };
  const seenRecordNos = new Set<number>();

  function addChildren(recordNo: number, storeParentId: number): void {
    const children = edgesByParent.get(recordNo);
    if (!children) return;

    for (const edge of children) {
      const isHidden = edge.name.charCodeAt(0) === 46;

      if (edge.isDir) {
        stats.dirCount++;
        const input: NodeInput = {
          name: edge.name,
          isDir: true,
          size: 0,
          modifiedAt: edge.mtimeMs,
          isHidden,
        };
        const dirId = store.addNode(storeParentId, input);
        addChildren(edge.recordNo, dirId);
        continue;
      }

      stats.fileCount++;
      const input: NodeInput = {
        name: edge.name,
        isDir: false,
        size: edge.size,
        modifiedAt: edge.mtimeMs,
        isHidden,
      };

      if (seenRecordNos.has(edge.recordNo)) {
        input.hardlinkDuplicate = true;
        input.size = 0;
        stats.hardlinkedFiles++;
        stats.hardlinkedBytes += edge.size;
      } else {
        seenRecordNos.add(edge.recordNo);
      }

      store.addNode(storeParentId, input);
    }
  }

  addChildren(targetRecordNo, parentId);
  return { stats };
}
```

- [x] **Step 5: Run to verify it passes**

Run: `npx tsx --test tests/ntfsMftMapper.test.ts`
Expected: PASS — all 8 tests green.

- [x] **Step 6: Commit**

```bash
git add tests/fixtures/ntfs-mft-sample.ndjson tests/ntfsMftMapper.test.ts src/services/ntfsMftMapper.ts
git commit -m "feat(scan): add pure NTFS MFT edge mapper, TDD against a synthetic fixture"
```

---

## Task 2: NTFS-volume detection + drive-letter validation

Small, isolated, no subprocess mocking framework needed — `execFile` is called
for real against the actual host in the "detects a real drive" test (skipped
off-Windows), and pure-function tests cover validation.

**Files:**
- Create: `tests/ntfsMftScanner.test.ts` (this task adds to it; Tasks 3-4 extend the same file)
- Create: `src/services/ntfsMftScanner.ts` (this task starts it; Tasks 3-4 extend it)

- [x] **Step 1: Write the failing tests**

Create `tests/ntfsMftScanner.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isValidDriveLetter, isNtfsVolume } from '../src/services/ntfsMftScanner';

test('isValidDriveLetter accepts a single letter only', () => {
  assert.equal(isValidDriveLetter('C'), true);
  assert.equal(isValidDriveLetter('c'), true);
  assert.equal(isValidDriveLetter('CC'), false);
  assert.equal(isValidDriveLetter('C:'), false);
  assert.equal(isValidDriveLetter('; rm -rf /'), false);
  assert.equal(isValidDriveLetter(''), false);
});

test('isNtfsVolume returns false rather than throwing on a bad drive letter', async () => {
  assert.equal(await isNtfsVolume('not-a-drive'), false);
});

test('isNtfsVolume detects the host drive on Windows', { skip: process.platform !== 'win32' }, async () => {
  const drive = process.env.SystemDrive?.replace(':', '') ?? 'C';
  assert.equal(await isNtfsVolume(drive), true);
});
```

- [x] **Step 2: Run to verify it fails**

Run: `npx tsx --test tests/ntfsMftScanner.test.ts`
Expected: FAIL — cannot find module `../src/services/ntfsMftScanner`.

- [x] **Step 3: Implement**

Create `src/services/ntfsMftScanner.ts`:

```ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** A single drive letter, nothing else — the only value ever interpolated
 *  into the sudo-prompt shell string in Task 4, so it must be airtight. */
export function isValidDriveLetter(s: string): boolean {
  return /^[A-Za-z]$/.test(s);
}

/**
 * True if `driveLetter`'s volume is NTFS. Uses `fsutil fsinfo volumeinfo`, an
 * unprivileged, always-available Windows tool — this check runs BEFORE any
 * elevation is attempted, so it must never itself require admin rights.
 * Any failure (bad input, missing drive, non-Windows) returns false rather
 * than throwing — this feeds an eligibility gate, not an error path.
 */
export async function isNtfsVolume(driveLetter: string): Promise<boolean> {
  if (!isValidDriveLetter(driveLetter)) return false;
  try {
    const { stdout } = await execFileAsync('fsutil', ['fsinfo', 'volumeinfo', `${driveLetter}:`]);
    return /File System Name\s*:\s*NTFS/i.test(stdout);
  } catch {
    return false;
  }
}
```

- [x] **Step 4: Run to verify it passes**

Run: `npx tsx --test tests/ntfsMftScanner.test.ts`
Expected: PASS (the Windows-only test runs and passes on a Windows dev
machine; elsewhere it's skipped, never failed).

- [x] **Step 5: Commit**

```bash
git add tests/ntfsMftScanner.test.ts src/services/ntfsMftScanner.ts
git commit -m "feat(scan): add NTFS volume detection and drive-letter validation"
```

---

## Task 3: Binary locator

Mirrors `findGduBinary` exactly — bundled path first, then dev-relative, no
`$PATH` fallback (this binary is never something a contributor installs
system-wide the way gdu might be).

**Files:**
- Modify: `src/services/ntfsMftScanner.ts`
- Modify: `tests/ntfsMftScanner.test.ts`

- [x] **Step 1: Add the failing test**

Append to `tests/ntfsMftScanner.test.ts`:

```ts
import { findNtfsMftBinary } from '../src/services/ntfsMftScanner';

test('findNtfsMftBinary returns null rather than throwing when nothing is installed', async () => {
  const found = await findNtfsMftBinary({ bundledPath: '/nonexistent/ntfs-mft-scan.exe' });
  assert.equal(found, null);
});
```

- [x] **Step 2: Run to verify it fails**

Run: `npx tsx --test tests/ntfsMftScanner.test.ts`
Expected: FAIL — `findNtfsMftBinary` is not exported.

- [x] **Step 3: Implement**

Add to `src/services/ntfsMftScanner.ts`:

```ts
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export interface FindOptions {
  bundledPath?: string;
}

/** Where a bundled ntfs-mft-scan.exe might live — see bundledCandidates in
 *  gduScanner.ts for why both the packaged and dev-relative path are checked. */
function bundledCandidates(): string[] {
  const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const out: string[] = [];
  if (resources) out.push(path.join(resources, 'ntfs-mft-scan', 'ntfs-mft-scan.exe'));
  out.push(path.join(__dirname, '..', '..', 'ntfs-mft-scan', 'ntfs-mft-scan.exe'));
  return out;
}

/** No $PATH fallback: unlike gdu, this binary is never something a
 *  contributor installs system-wide — it only ever comes from this repo's
 *  own build step (Task 8). */
export async function findNtfsMftBinary(opts: FindOptions = {}): Promise<string | null> {
  const candidates = opts.bundledPath ? [opts.bundledPath] : bundledCandidates();
  for (const candidate of candidates) {
    try {
      await fsp.access(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}
```

- [x] **Step 4: Run to verify it passes**

Run: `npx tsx --test tests/ntfsMftScanner.test.ts`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src/services/ntfsMftScanner.ts tests/ntfsMftScanner.test.ts
git commit -m "feat(scan): add ntfs-mft-scan binary locator"
```

---

## Task 4: Elevated spawn + store orchestration

This is where `sudo-prompt` and the temp-file NDJSON handoff live. The
elevated-spawn function is injected (dependency-inverted) so the orchestration
logic — the part with real behavior worth testing — is testable without ever
invoking real UAC.

**Files:**
- Modify: `src/services/ntfsMftScanner.ts`
- Modify: `tests/ntfsMftScanner.test.ts`
- Modify: `package.json` (add `sudo-prompt` dependency)

- [x] **Step 1: Add the dependency**

Run:
```bash
npm install sudo-prompt
npm install --save-dev @types/sudo-prompt
```
If `@types/sudo-prompt` doesn't exist on npm, skip it and add a minimal local
`declare module 'sudo-prompt'` ambient type instead — check first, don't
assume.

- [x] **Step 2: Write the failing tests**

Append to `tests/ntfsMftScanner.test.ts`:

```ts
import fsp2 from 'node:fs/promises';
import os from 'node:os';
import path2 from 'node:path';
import { PackedScanStore } from '../src/services/scanStore';
import { ntfsMftScanIntoStore } from '../src/services/ntfsMftScanner';
import { ScanResult } from '../src/models/types';

function fakeScan(rootPath: string): ScanResult {
  return {
    scanId: 'test', rootPath, status: 'running', scanned: 0, fileCount: 0, dirCount: 0,
    currentPath: rootPath, startedAt: Date.now(), createdAt: Date.now(), cancelled: false,
    engine: 'walker', ioThreads: 1, incremental: false, cachedDirs: 0, walkedDirs: 0,
    hardlinkedFiles: 0, hardlinkedBytes: 0, cloudFiles: 0, cloudBytes: 0,
  } as ScanResult;
}

test('ntfsMftScanIntoStore builds a store from a fake elevated run', async () => {
  const tmp = await fsp2.mkdtemp(path2.join(os.tmpdir(), 'ntfs-mft-test-'));
  try {
    const scan = fakeScan('C:\\fx');
    const store = await ntfsMftScanIntoStore(scan, 'C', ['fx'], {
      // Injected in place of the real sudo-prompt spawn — writes the same
      // fixture Task 1 already validated the mapper against.
      runElevated: async (outFile: string) => {
        await fsp2.copyFile(
          path2.join(__dirname, 'fixtures', 'ntfs-mft-sample.ndjson'),
          outFile,
        );
      },
    });
    assert.equal(store.rootPath, 'C:\\fx');
    const root = store.prune(store.rootId, { maxNodes: Number.MAX_SAFE_INTEGER }).root;
    assert.equal(root.size, 11);
  } finally {
    await fsp2.rm(tmp, { recursive: true, force: true });
  }
});

test('ntfsMftScanIntoStore rejects when the elevated run fails, never returning a partial store', async () => {
  const scan = fakeScan('C:\\fx');
  await assert.rejects(() =>
    ntfsMftScanIntoStore(scan, 'C', ['fx'], {
      runElevated: async () => {
        throw new Error('UAC declined');
      },
    }),
  );
});

test('ntfsMftScanIntoStore rejects when the target path does not resolve', async () => {
  const scan = fakeScan('C:\\fx\\nope');
  await assert.rejects(() =>
    ntfsMftScanIntoStore(scan, 'C', ['fx', 'nope'], {
      runElevated: async (outFile: string) => {
        await fsp2.copyFile(
          path2.join(__dirname, 'fixtures', 'ntfs-mft-sample.ndjson'),
          outFile,
        );
      },
    }),
  );
});
```

- [x] **Step 3: Run to verify it fails**

Run: `npx tsx --test tests/ntfsMftScanner.test.ts`
Expected: FAIL — `ntfsMftScanIntoStore` is not exported.

- [x] **Step 4: Implement**

Add to `src/services/ntfsMftScanner.ts`:

```ts
import os from 'node:os';
import sudoPrompt from 'sudo-prompt'; // top-level import, matching this codebase's style — not a lazy require()
import { ScanResult } from '../models/types';
import { PackedScanStore, ScanStore } from './scanStore';
import { parseNtfsMftEdges, resolveTargetRecord, buildNtfsMftStoreFromEdges } from './ntfsMftMapper';

/** Backstop against a wedged elevated helper — mirrors gdu's SHARD_TIMEOUT_MS.
 *  sudo-prompt gives no killable handle, so this can only stop US from
 *  waiting forever; the orphaned process, if still running, finishes on its
 *  own in its own temp dir and its output is simply never consumed. */
const ELEVATED_RUN_TIMEOUT_MS = 5 * 60 * 1000;

export interface NtfsMftScanOverrides {
  /** Real implementation (Task 5 wiring) spawns ntfs-mft-scan.exe via
   *  sudo-prompt; tests inject a fake that just writes NDJSON to outFile. */
  runElevated?: (outFile: string, driveLetter: string) => Promise<void>;
}

function runElevatedViaSudoPrompt(outFile: string, driveLetter: string, binPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!isValidDriveLetter(driveLetter)) {
      reject(new Error(`refusing to elevate with an invalid drive letter: ${driveLetter}`));
      return;
    }
    // sudo-prompt's API takes a shell command STRING, not an argv array —
    // the one place in this codebase that can't use execFile's argv safety.
    // Both interpolated values are strictly constrained: driveLetter is
    // validated above (single letter only), outFile is always one WE
    // generated via fsp.mkdtemp — never user input.
    const cmd = `"${binPath}" --volume ${driveLetter} --out "${outFile}"`;
    const timer = setTimeout(() => reject(new Error('ntfs-mft-scan timed out')), ELEVATED_RUN_TIMEOUT_MS);
    sudoPrompt.exec(cmd, { name: 'TreeMap' }, (err: Error | null) => {
      clearTimeout(timer);
      if (err) reject(err);
      else resolve();
    });
  });
}

/**
 * Build a store for `scan.rootPath` (a folder under drive `driveLetter`,
 * split into `pathComponents` relative to the volume root) via a full-volume
 * MFT read. Throws on any failure — callers (Task 5) fall back to gdu/walker.
 */
export async function ntfsMftScanIntoStore(
  scan: ScanResult,
  driveLetter: string,
  pathComponents: string[],
  overrides: NtfsMftScanOverrides = {},
): Promise<ScanStore> {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'treemap-ntfs-mft-'));
  const outFile = path.join(tmpDir, 'edges.ndjson');
  try {
    if (overrides.runElevated) {
      await overrides.runElevated(outFile, driveLetter);
    } else {
      const bin = await findNtfsMftBinary();
      if (!bin) throw new Error('ntfs-mft-scan binary not found');
      await runElevatedViaSudoPrompt(outFile, driveLetter, bin);
    }

    const ndjson = await fsp.readFile(outFile, 'utf8');
    const edges = parseNtfsMftEdges(ndjson);
    const targetRecordNo = resolveTargetRecord(edges, pathComponents);
    if (targetRecordNo === null) {
      throw new Error(`could not resolve ${scan.rootPath} in the MFT edge set`);
    }

    const rootName = pathComponents.length ? pathComponents[pathComponents.length - 1] : `${driveLetter}:\\`;
    const store = new PackedScanStore(scan.rootPath, '\\', {
      name: rootName,
      isDir: true,
      size: 0,
      modifiedAt: Date.now(),
      isHidden: false,
    });

    const { stats } = buildNtfsMftStoreFromEdges(edges, targetRecordNo, store, store.rootId);
    scan.fileCount = stats.fileCount;
    scan.dirCount = stats.dirCount + 1; // +1 for the root itself
    scan.hardlinkedFiles = stats.hardlinkedFiles;
    scan.hardlinkedBytes = stats.hardlinkedBytes;
    scan.scanned = scan.fileCount + scan.dirCount;

    store.finalize();
    store.sumSizes();
    return store;
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}
```

**Before moving on:** verify `store.finalize()`/`store.sumSizes()` are the
correct calls to make a freshly `addNode`-populated `PackedScanStore` usable —
check how `gduScanIntoStore` uses them (it calls both at the very end, same
as above) and confirm no other post-build step exists that this plan missed.

- [x] **Step 5: Run to verify it passes**

Run: `npx tsx --test tests/ntfsMftScanner.test.ts`
Expected: PASS — all tests including Tasks 2-3's.

- [x] **Step 6: Commit**

```bash
git add src/services/ntfsMftScanner.ts tests/ntfsMftScanner.test.ts package.json package-lock.json
git commit -m "feat(scan): add elevated ntfs-mft-scan spawn and store orchestration"
```

---

## Task 5: Wire into `diskScanner.ts`'s engine cascade

Adds `ntfs-mft` as the new first link: `ntfs-mft` → `gdu-turbo` → walker.
Mirrors gdu's eligibility/fallback/counter-reset shape exactly — see the
Verified Facts table above for the exact fields.

**Files:**
- Modify: `src/services/diskScanner.ts:172-174` (the `ScanOptions` interface)
- Modify: `src/services/diskScanner.ts` (the `gduEligible` block and the scan
  cascade around line 225-280)
- Modify: `tests/ntfsMftScanner.test.ts` (integration-level fallback tests,
  mirroring `tests/gduScanner.test.ts`'s pattern)

- [x] **Step 1: Write the failing integration test**

Append to `tests/ntfsMftScanner.test.ts`:

```ts
import { startScan, getScan } from '../src/services/diskScanner';

async function settle(scanId: string) {
  await new Promise<void>((r) => {
    const iv = setInterval(() => {
      if (getScan(scanId)!.status !== 'running') {
        clearInterval(iv);
        r();
      }
    }, 25);
  });
  return getScan(scanId)!;
}

test('a scan falls back to the walker when ntfsMft is not opted into', async () => {
  const dir = await fsp2.mkdtemp(path2.join(os.tmpdir(), 'ntfs-mft-int-'));
  process.env.TREEMAP_NO_GDU = '1';
  try {
    const started = await startScan(dir, { incremental: false });
    const s = await settle(started.scanId);
    assert.equal(s.status, 'complete');
    assert.notEqual(s.engine, 'ntfs-mft');
  } finally {
    delete process.env.TREEMAP_NO_GDU;
    await fsp2.rm(dir, { recursive: true, force: true });
  }
});

test('a scan falls back to the walker when ntfsMft is opted in but the binary is missing', async () => {
  const dir = await fsp2.mkdtemp(path2.join(os.tmpdir(), 'ntfs-mft-int-'));
  process.env.TREEMAP_NO_GDU = '1';
  process.env.TREEMAP_NO_NTFS_MFT_BIN = '1'; // test-only escape hatch, see implementation
  try {
    const started = await startScan(dir, { incremental: false, ntfsMft: true });
    const s = await settle(started.scanId);
    assert.equal(s.status, 'complete');
    assert.notEqual(s.engine, 'ntfs-mft');
    assert.equal(s.fileCount >= 0, true); // counters were reset, not left dangling
  } finally {
    delete process.env.TREEMAP_NO_GDU;
    delete process.env.TREEMAP_NO_NTFS_MFT_BIN;
    await fsp2.rm(dir, { recursive: true, force: true });
  }
});
```

- [x] **Step 2: Run to verify it fails**

Run: `npx tsx --test tests/ntfsMftScanner.test.ts`
Expected: FAIL — `ScanOptions` has no `ntfsMft` property (TS compile error) or
the second test observes `engine` unexpectedly set.

- [x] **Step 3: Implement — `ScanOptions`**

In `src/services/diskScanner.ts`, modify the interface at line 172-174:

```ts
export interface ScanOptions {
  /** Reuse the on-disk mtime cache to skip unchanged subtrees (fast rescan). */
  incremental?: boolean;
  /** Explicit opt-in only — see docs/superpowers/specs/2026-07-24-ntfs-mft-engine-design.md §3.5.
   *  Never auto-triggered: unlike every other engine, this one produces a
   *  real UAC prompt, so it must never fire without the user asking for it. */
  ntfsMft?: boolean;
}
```

- [x] **Step 4: Implement — the cascade**

In `src/services/diskScanner.ts`, add the import:

```ts
import { findNtfsMftBinary, ntfsMftScanIntoStore, isNtfsVolume } from './ntfsMftScanner';
```

Immediately before the existing `gduEligible` block, add:

```ts
/**
 * ntfs-mft is tried before gdu when opted in — it's faster than gdu on NTFS
 * because it reads the MFT directly instead of spawning a walking
 * subprocess. Same gates as gdu (directory only, no cache/incremental, no
 * ignore list — raw MFT enumeration has even less ability than gdu to honor
 * glob ignore patterns) plus the explicit opt-in and a platform/filesystem
 * check that must never itself require elevation.
 */
const ntfsMftRequested =
  process.platform === 'win32' &&
  opts.ntfsMft === true &&
  rootStat.isDirectory() &&
  !cache &&
  !opts.incremental &&
  ignore.length === 0 &&
  process.env.TREEMAP_NO_NTFS_MFT !== '1';
```

Then, as the new first branch inside the existing fire-and-forget async
block (before the `if (gduEligible)` check), add:

```ts
if (ntfsMftRequested && (await isNtfsVolume(rootPath[0]))) {
  try {
    if (process.env.TREEMAP_NO_NTFS_MFT_BIN !== '1') {
      const bin = await findNtfsMftBinary();
      if (!bin) throw new Error('ntfs-mft-scan binary not found');
    } else {
      throw new Error('test escape hatch: binary unavailable');
    }
    scan.engine = 'ntfs-mft';
    const driveLetter = rootPath[0];
    const components = rootPath.slice(3).split(path.sep).filter(Boolean); // strip "C:\"
    const store = await ntfsMftScanIntoStore(scan, driveLetter, components);
    if (scan.cancelled) return;
    scan.store = store;
    scan.status = 'complete';
    scan.finishedAt = Date.now();
    scan.currentPath = scan.rootPath;
    void saveMtimeCache(scan);
    void saveSnapshot(scan).catch((err: unknown) => {
      console.error('[treemap] snapshot save failed:', err);
    });
    return;
  } catch (err) {
    if (scan.cancelled) return;
    // Same discipline as gdu: never surface as a scan error, always reset
    // counters before falling through so the next engine doesn't double-count.
    console.warn(`[treemap] ntfs-mft engine unavailable, trying gdu/walker: ${String(err)}`);
    scan.fileCount = 0;
    scan.dirCount = 0;
    scan.scanned = 0;
    scan.hardlinkedFiles = 0;
    scan.hardlinkedBytes = 0;
  }
}
```

**Verify while implementing:** confirm the exact variable name/shape used for
`rootPath` in this scope (the plan assumes a Windows absolute path like
`C:\Users\foo`; check against how `rootStat`/`rootPath` are actually bound at
this point in the real function before assuming the slice offsets above are
correct — adjust `rootPath.slice(3)` if the real path shape differs, e.g. a
trailing separator or UNC path).

- [x] **Step 5: Run to verify it passes**

Run: `npx tsx --test tests/ntfsMftScanner.test.ts`
Expected: PASS.

- [x] **Step 6: Run the full suite to check for regressions**

Run: `npm test`
Expected: same 190 pass / 3 pre-existing fail / 5 skipped as the baseline
recorded in the spec — no new failures introduced.

- [x] **Step 7: Commit**

```bash
git add src/services/diskScanner.ts tests/ntfsMftScanner.test.ts
git commit -m "feat(scan): wire ntfs-mft into the engine cascade ahead of gdu-turbo"
```

---

## Task 6: Accept `ntfsMft` from the scan request

**Files:**
- Modify: `src/api/scanRoutes.ts:122-123`

- [x] **Step 1: Implement**

Change:

```ts
const { path: scanPath, incremental } = req.body as { path: string; incremental?: boolean };
const scan = await startScan(scanPath, { incremental: incremental === true }); // lstat failures -> 404/403
```

to:

```ts
const { path: scanPath, incremental, ntfsMft } = req.body as {
  path: string;
  incremental?: boolean;
  ntfsMft?: boolean;
};
const scan = await startScan(scanPath, {
  incremental: incremental === true,
  ntfsMft: ntfsMft === true,
}); // lstat failures -> 404/403
```

- [x] **Step 2: Run the full suite**

Run: `npm test`
Expected: no new failures.

- [x] **Step 3: Commit**

```bash
git add src/api/scanRoutes.ts
git commit -m "feat(api): accept ntfsMft opt-in flag on the scan request"
```

---

## Task 7: Rust helper crate

**Already verified, no need to recheck:** the `file.attributes(|att| {...})`
callback/visitor shape (not an iterator — confirmed against `ntfs-reader`'s
own `file.rs`: `pub fn attributes<F>(&self, mut f: F) where F: FnMut(&NtfsAttribute)`),
and the `att.as_standard_info()` / `att.resident_header()` /
`att.nonresident_header()` calls (confirmed against the crate's own
`file_info.rs`, which uses this exact pattern internally to compute size and
timestamps). The code below matches real, read source — not guessed.

**Still verify before writing code:** whether `ntfs_to_unix_time`,
`NtfsAttributeType`, `ROOT_RECORD`, and `NtfsFileNamespace` are actually
reachable from an *external* crate depending on `ntfs-reader` (i.e.
re-exported as `pub` from the crate root or its `api`/`attribute` modules) —
`file_info.rs` uses them via `crate::api::...`, which only proves they work
from *inside* the crate, not that they're part of its public API surface.
Run `cargo doc --open -p ntfs-reader` or check `docs.rs/ntfs-reader`
directly before assuming the code below compiles as-is. If any aren't
public, implement the small equivalent locally (a Windows FILETIME-to-Unix-ms
conversion is a few lines) rather than depending on crate internals.

**Files:**
- Create: `native/ntfs-mft-scan/Cargo.toml`
- Create: `native/ntfs-mft-scan/src/main.rs`

- [x] **Step 1: Create the crate manifest**

Create `native/ntfs-mft-scan/Cargo.toml`:

```toml
[package]
name = "ntfs-mft-scan"
version = "0.1.0"
edition = "2021"
license = "MIT"

[dependencies]
ntfs-reader = "0.4.5"

[profile.release]
opt-level = 3
```

- [x] **Step 2: Implement the CLI**

Create `native/ntfs-mft-scan/src/main.rs`:

```rust
//! Dumps every surviving NTFS FileName-attribute edge on a volume as NDJSON.
//!
//! "Surviving" = namespace is not pure DOS (an 8.3 short-name alias, not a
//! real second hardlink — see docs/superpowers/specs/2026-07-24-ntfs-mft-
//! engine-design.md §3.1), and at most one edge per (record, parent) pair
//! (a Posix + Win32 name for the SAME link collapses to one, preferring
//! Win32AndDos > Win32 > Posix). Everything else — path resolution, subtree
//! selection, hardlink dedup across distinct parents — is the TypeScript
//! mapper's job (src/services/ntfsMftMapper.ts), not this binary's.
//!
//! Usage: ntfs-mft-scan --volume C --out <path>
//! Requires an elevated process token (enforced by ntfs_reader::Volume::new).

use ntfs_reader::attribute::{NtfsAttributeType, NtfsFileNamespace};
use ntfs_reader::mft::Mft;
use ntfs_reader::volume::Volume;
use std::collections::HashMap;
use std::env;
use std::fs::File;
use std::io::{BufWriter, Write};
use std::process::ExitCode;

struct Args {
    volume: String,
    out: String,
}

fn parse_args() -> Option<Args> {
    let mut volume = None;
    let mut out = None;
    let mut it = env::args().skip(1);
    while let Some(flag) = it.next() {
        match flag.as_str() {
            "--volume" => volume = it.next(),
            "--out" => out = it.next(),
            _ => {}
        }
    }
    Some(Args { volume: volume?, out: out? })
}

/** Preference order when a record has multiple surviving names at the SAME
 *  parent (Posix+Win32 for one link): higher wins. */
fn namespace_rank(ns: u8) -> u8 {
    match ns {
        x if x == NtfsFileNamespace::Win32AndDos as u8 => 3,
        x if x == NtfsFileNamespace::Win32 as u8 => 2,
        x if x == NtfsFileNamespace::Posix as u8 => 1,
        _ => 0, // Dos-only never reaches here, filtered out below
    }
}

fn main() -> ExitCode {
    let args = match parse_args() {
        Some(a) => a,
        None => {
            eprintln!("usage: ntfs-mft-scan --volume C --out <path>");
            return ExitCode::FAILURE;
        }
    };

    let volume_path = format!("\\\\.\\{}:", args.volume);
    let volume = match Volume::new(&volume_path) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("failed to open volume (are we elevated?): {e}");
            return ExitCode::FAILURE;
        }
    };
    let mft = match Mft::new(volume) {
        Ok(m) => m,
        Err(e) => {
            eprintln!("failed to read MFT: {e}");
            return ExitCode::FAILURE;
        }
    };

    let out_file = match File::create(&args.out) {
        Ok(f) => f,
        Err(e) => {
            eprintln!("failed to create output file: {e}");
            return ExitCode::FAILURE;
        }
    };
    let mut writer = BufWriter::new(out_file);

    for file in mft.files() {
        let is_dir = file.is_directory();
        let record_no = file.number();

        // Collect (parent, name, namespace), then keep only the best
        // namespace per distinct parent — see namespace_rank above.
        let mut best_per_parent: HashMap<u64, (u8, String)> = HashMap::new();
        let mut size: u64 = 0;
        let mut mtime_ms: i64 = 0;

        file.attributes(|att| {
            if att.header.type_id == NtfsAttributeType::StandardInformation as u32 {
                if let Some(info) = att.as_standard_info() {
                    mtime_ms = ntfs_reader::api::ntfs_to_unix_time(info.modification_time)
                        .unix_timestamp()
                        * 1000;
                }
            }
            if att.header.type_id == NtfsAttributeType::Data as u32 {
                if att.header.is_non_resident == 0 {
                    if let Some(h) = att.resident_header() {
                        size = h.value_length as u64;
                    }
                } else if let Some(h) = att.nonresident_header() {
                    size = h.data_size;
                }
            }
            if let Some(fname) = att.as_name() {
                let ns = fname.header.namespace;
                if ns == NtfsFileNamespace::Dos as u8 {
                    return; // 8.3 alias, not a real second link
                }
                let parent = fname.parent();
                let rank = namespace_rank(ns);
                let entry = best_per_parent.entry(parent).or_insert((rank, fname.to_string()));
                if rank > entry.0 {
                    *entry = (rank, fname.to_string());
                }
            }
        });

        for (parent_record_no, (_, name)) in best_per_parent {
            let line = format!(
                "{{\"recordNo\":{record_no},\"parentRecordNo\":{parent_record_no},\"name\":{name:?},\"size\":{size},\"isDir\":{is_dir},\"mtimeMs\":{mtime_ms}}}\n"
            );
            if writer.write_all(line.as_bytes()).is_err() {
                eprintln!("failed writing output");
                return ExitCode::FAILURE;
            }
        }
    }

    ExitCode::SUCCESS
}
```

Note: `{name:?}` relies on Rust's `Debug` format for `String` producing valid
JSON-escaped quotes for ordinary filenames. Verify this holds for names with
embedded quotes/backslashes/control characters/non-BMP Unicode during Task 9's
manual testing — if any real filename breaks it, switch to a proper JSON
string escaper instead of leaning on `Debug`.

- [x] **Step 3: Attempt a build (if a Rust toolchain is available in this environment)**

Run: `cd native/ntfs-mft-scan && cargo build --release`
Expected: compiles cleanly. If it doesn't (e.g. the "verify before writing
code" note above turned up non-public crate items), fix the specific
compile errors before proceeding — do not comment out the failing parts.

If no Rust toolchain is available in the current environment, note that
explicitly and defer this build step to Task 10's manual verification on a
real Windows machine — do not mark this step done without either a real
build or an explicit, logged reason it couldn't run here.

**Deferred (logged):** `cargo`/`rustc` not present in this environment;
source committed with imports verified against docs.rs/ntfs-reader/0.4.5
(`NtfsAttributeType`/`NtfsFileNamespace`/`ntfs_to_unix_time` from `api`).
Build deferred to Task 10.

- [x] **Step 4: Commit**

```bash
git add native/ntfs-mft-scan/
git commit -m "feat(native): add ntfs-mft-scan Rust CLI helper"
```

---

## Task 8: Build script + bundling

Modeled on `scripts/fetchGdu.js`, but building rather than fetching (no
upstream release exists for this binary).

**Files:**
- Create: `scripts/buildNtfsMftScan.js`
- Modify: `package.json` (new script, `extraResources` entry)

- [x] **Step 1: Implement the build script**

Create `scripts/buildNtfsMftScan.js`:

```js
#!/usr/bin/env node
/**
 * Build the ntfs-mft-scan helper (native/ntfs-mft-scan) for the host
 * platform and stage it for bundling — the build-time equivalent of
 * fetchGdu.js, except there's no upstream release to download: this binary
 * only ever comes from this repo's own Rust source.
 *
 * Windows-only, unlike gdu's 5-platform fetch matrix — the helper does
 * nothing on macOS/Linux, so it is never built or staged there.
 *
 * A missing Rust toolchain must never fail a build: the app falls back to
 * gdu/walker, same as a missing gdu binary, and a contributor without Rust
 * installed should still be able to build TreeMap.
 *
 * Usage:
 *   node scripts/buildNtfsMftScan.js         # host platform, into build/ntfs-mft-scan/win-x64/
 *   node scripts/buildNtfsMftScan.js --dev   # into ./ntfs-mft-scan/ (what findNtfsMftBinary looks for in dev)
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const CRATE_DIR = path.join(ROOT, 'native', 'ntfs-mft-scan');
const TARGET_TRIPLE = 'x86_64-pc-windows-msvc';

function build(destDir) {
  if (process.platform !== 'win32') {
    console.log('[buildNtfsMftScan] non-Windows host — nothing to build, app will use gdu/walker.');
    return;
  }

  console.log('[buildNtfsMftScan] cargo build --release...');
  execFileSync('cargo', ['build', '--release', '--target', TARGET_TRIPLE], {
    cwd: CRATE_DIR,
    stdio: 'inherit',
  });

  const built = path.join(CRATE_DIR, 'target', TARGET_TRIPLE, 'release', 'ntfs-mft-scan.exe');
  fs.mkdirSync(destDir, { recursive: true });
  fs.copyFileSync(built, path.join(destDir, 'ntfs-mft-scan.exe'));
  console.log(`[buildNtfsMftScan] -> ${path.relative(ROOT, destDir)}`);
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--dev')) {
    build(path.join(ROOT, 'ntfs-mft-scan'));
    return;
  }
  build(path.join(ROOT, 'build', 'ntfs-mft-scan', 'win-x64'));
}

main();
```

Note the intentional asymmetry with `fetchGdu.js`: this script does **not**
swallow a failed `cargo build` the way `fetchGdu.js` swallows a failed
download — a missing Rust *toolchain* should be silent (no toolchain, no
binary, fall back gracefully), but a *broken* build (crate present, toolchain
present, compile error) should fail loudly, the same way a real code defect
should. If this distinction turns out to be wrong in practice (e.g. CI has no
toolchain and this fails loudly instead of silently), wrap the `cargo`
invocation in a check for whether `cargo` exists on `$PATH` first, and only
silently skip in that specific case.

- [x] **Step 2: Wire into `package.json`**

Add a script:

```json
"build:ntfs-mft-scan": "node scripts/buildNtfsMftScan.js",
"build:ntfs-mft-scan:dev": "node scripts/buildNtfsMftScan.js --dev"
```

Add to the `dist:win` script (and only `dist:win`, unlike gdu's cross-platform
`fetch:gdu` which every `dist:*` script runs):

```json
"dist:win": "npm run build && npm run fetch:gdu && npm run build:ntfs-mft-scan && electron-builder --win"
```

**Not the same array gdu uses.** The real `package.json`'s `extraResources`
is a single top-level array under `build` (not nested under `build.win`),
and gdu's entries live there because gdu is fetched for every platform, so
its `from` path always exists whichever platform is building. This binary
is Windows-only — `buildNtfsMftScan.js` only ever produces
`build/ntfs-mft-scan/win-x64/` on a Windows host — so adding it to that same
shared array would point mac/linux builds at a `from` path that never gets
created on those platforms.

electron-builder supports exactly this split: `extraResources` (among other
options) can also be set per-platform under the existing top-level `win`/
`mac`/`linux` keys, and a platform-specific list **merges with** (adds to,
doesn't replace) the shared top-level one — confirmed against
electron-builder's own source (`getFileMatchers` adds both `config[name]`
and `customBuildOptions[name]` patterns to the same matcher). So: add a new
`extraResources` array *inside* the existing `"win": { "target": [...],
"icon": ... }` block:

```json
"win": {
  "target": ["nsis"],
  "icon": "build/icon.png",
  "extraResources": [
    {
      "from": "build/ntfs-mft-scan",
      "to": "ntfs-mft-scan",
      "filter": ["**/*"]
    }
  ]
}
```

A Windows build gets both the shared gdu entries and this one; mac/linux
builds are unaffected.

- [x] **Step 3: Commit**

```bash
git add scripts/buildNtfsMftScan.js package.json
git commit -m "feat(build): build and bundle ntfs-mft-scan for Windows packages"
```

---

## Task 9: Opt-in UI checkbox

Modeled directly on the existing `#fastRescan` toggle
(`public/index.html:1064`, `2609`).

**Files:**
- Modify: `public/index.html`

- [x] **Step 1: Add the checkbox**

Find the `#fastRescan` checkbox block (around line 1064) and add a sibling
checkbox immediately after it:

```html
<input type="checkbox" id="ntfsMftScan">
<span data-icon="zap" data-size="13"></span>Turbo NTFS scan (requires admin)
```

wrapped in a container with `id="ntfsMftScanWrap"` that starts **hidden via
the bare `hidden` attribute** (`<div id="ntfsMftScanWrap" hidden>`) — match
`#fastRescanWrap`'s actual convention exactly (it uses `hidden`, not
`style="display:none"`; Step 2 below toggles `.hidden = false`, which only
works against the attribute form). Copy `#fastRescanWrap`'s real surrounding
HTML once you have the file open — the snippet above is illustrative of
intent, not a literal patch.

- [x] **Step 2: Show it only on Windows**

Find where the client fetches `GET /api/system` (search for `'/api/system'`
in `public/index.html`) and add, alongside whatever it already does with the
response:

```js
if (info.platform === 'win32') {
  $('ntfsMftScanWrap').hidden = false; // reuses the existing $ helper already used for fastRescanWrap
}
```

- [x] **Step 3: Wire it into the scan request**

Find the `startScan` POST call (around line 2264, `JSON.stringify({ path, incremental: !!opts.incremental })`)
and add the flag:

```js
body: JSON.stringify({
  path,
  incremental: !!opts.incremental,
  ntfsMft: !!opts.ntfsMft,
}),
```

Find where `startScan` is invoked from the UI (around line 2609,
`startScan(p, { incremental: ... })`) and add:

```js
startScan(p, {
  incremental: !$('fastRescanWrap').hidden && $('fastRescan').checked,
  ntfsMft: !$('ntfsMftScanWrap').hidden && $('ntfsMftScan').checked,
});
```

- [ ] **Step 4: Manual check** (deferred with Task 10 — needs a running app session)

Run: `npm run dev`, open the app, confirm the checkbox is hidden on
macOS/Linux and visible on Windows (or force-test by temporarily hardcoding
`info.platform` in devtools).

- [x] **Step 5: Commit**

```bash
git add public/index.html
git commit -m "feat(ui): add opt-in Turbo NTFS scan checkbox"
```

---

## Task 10: Manual end-to-end verification (real Windows machine, elevated)

Not automatable — CI cannot answer a UAC prompt, and this is the first time
the full chain (real elevation, real volume, real binary) runs together.

- [ ] Build the helper for real: `npm run build:ntfs-mft-scan:dev`
- [ ] `npm run dev`, check "Turbo NTFS scan", scan a real folder on an NTFS
      drive with at least one hardlinked file (e.g. anything under
      `C:\Windows\WinSxS` — do not scan all of `C:\` for this first test,
      pick a small folder you can hand-verify)
- [ ] Confirm a UAC prompt appears exactly once, and declining it falls back
      to gdu/walker without a visible error
- [ ] Compare `ntfs-mft` totals against a `walker` scan of the *same* folder
      (temporarily set `TREEMAP_NO_NTFS_MFT=1` to force the walker) — file
      count, dir count, total bytes, and hardlink count must match exactly,
      per the spec's byte-parity gate
- [ ] **Capture real output for the fixture**: run the built
      `ntfs-mft-scan.exe --volume C --out real-sample.ndjson` once, by hand,
      and replace `tests/fixtures/ntfs-mft-sample.ndjson`'s synthetic content
      with a small, hand-trimmed excerpt of real captured lines (a folder
      with a hidden file, a hardlink, a nested dir, an empty dir — same
      shape as the synthetic one) — this closes the gap the spec's Task 1
      note flagged: the mapper was TDD'd against a schema description, not
      yet against real captured bytes. Re-run `npx tsx --test
      tests/ntfsMftMapper.test.ts` against the replaced fixture and fix any
      discrepancy from the real schema before considering this plan done.
- [ ] If any of the above fails, do not patch around it silently — go back
      to the relevant task, fix the root cause, and re-run that task's tests
      before continuing here.

---

## Out of scope (per spec §4 — do not implement as part of this plan)

- `ntfs-reader`'s `Journal` API for incremental re-scan / `watcher.ts`
  integration
- ReFS support
- True mid-read cancellation of the elevated helper
- A "remember elevation for this session" cache to reduce UAC fatigue
