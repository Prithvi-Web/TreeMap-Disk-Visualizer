# Phase 2: gdu Turbo Engine — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `gdu-turbo` scan engine that reaches ~120k items/sec (vs the walker's 69–97k) with **zero loss of accuracy or features**, falling back to the walker transparently whenever gdu is unavailable or fails.

**Architecture:** `gduScanner.ts` locates a gdu binary (bundled → `$PATH`), spawns it per top-level directory with `execFile` + argv, and maps each shard's JSON into the existing `FileNode` shape. Sharding costs 8% and buys live progress, bounded memory, and cancellation — all of which the single-shot design lacks. `startScan` tries gdu first and falls back to `walk()` on any failure.

**Tech Stack:** TypeScript, `node:child_process`, gdu v5.36.1 (MIT), `tsx --test`.

---

## Verified facts this plan is built on

All measured against real gdu v5.36.1 on this machine — **several contradict the
master prompt, which was written from a different version and a one-child sample.**

| Claim | Reality |
|---|---|
| Dir shape | **`[meta, ...children]` flat** — NOT `[meta, childrenArray]` |
| Dir size | **Absent** — must be summed from children |
| `mtime` | Unix **seconds** → ×1000 for `modifiedAt` (ms) |
| `asize` | **Omitted entirely when 0** → `c.asize \|\| 0` |
| `dsize` | Omitted when 0 → cloud-placeholder signal |
| `notreg: true` | Non-regular file (symlink/socket/fifo) |
| **`ino` + `hlnkc: true`** | **Inode + hardlink flag ARE emitted** (only when nlink>1) |
| Streaming parse (prompt req. 4) | **Reject.** `JSON.parse` = 5M nodes in 1.68s / 1.7 GB; `stream-json` would cost 8–20s |
| Mapping cost | 787ms/458k with `path.join`+`extname`; **39ms without** (20×) |
| Progress in `-n` mode | **None when piped** — gdu only prints to a TTY, and writes its output file all-at-once at the end (0 bytes until done) |
| Throughput | gdu **3.54/3.55/3.69s** on 458k (~124–129k/s) vs walker 4.74–6.60s (69–97k/s) |
| Sharded (33 shards, sequential) | 3.83s — **8% overhead** |
| Hardlink dedup on `ino` | **Byte-exact vs walker**: 30,070,595,907 == 30,070,595,907; 21,499 == 21,499 |

**Why shard rather than one gdu run:** gdu emits no progress when piped and writes
its JSON only at the very end, so a single run at 5M means a **~40-second blind
spinner** — replacing the walker's live "313,602 items · 79,289/s" counter with
nothing. The July 16 rollback was caused by *perceived* slowness; shipping a blind
spinner is the same mistake in new clothes. Sharding by top-level directory costs
8% (still ~112k/s, clearing the 100k target) and delivers live progress, per-shard
memory release, and a cancellation point between shards.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/services/gduScanner.ts` | locate binary, spawn, orchestrate shards, progress | Create |
| `src/services/gduMapper.ts` | gdu JSON → `FileNode` (pure, no I/O) | Create |
| `src/services/diskScanner.ts` | `startScan` tries gdu, falls back to `walk()` | Modify |
| `src/models/types.ts` | add `'gdu-turbo'` to `engine` | Modify |
| `public/index.html` | engine label map | Modify |
| `tests/gduMapper.test.ts` | mapper against a recorded real fixture | Create |
| `tests/fixtures/gdu-v5.36.1.json` | recorded real gdu output | Create |
| `tests/gduScanner.test.ts` | locator + fallback behavior | Create |

---

## Task 1: The mapper (pure, fixture-driven)

The riskiest logic, and the part the prompt got wrong. Build it first, in isolation,
against **recorded real output** — no subprocess needed.

**Files:**
- Create: `tests/fixtures/gdu-v5.36.1.json`
- Create: `tests/gduMapper.test.ts`
- Create: `src/services/gduMapper.ts`

- [ ] **Step 1: Save the recorded fixture**

Create `tests/fixtures/gdu-v5.36.1.json` with this **exact** content (recorded from
real gdu v5.36.1 against a tree containing a hidden file, a zero-byte file, a
symlink, a hard-link pair, a nested dir and an empty dir):

```json
[1,2,{"progname":"gdu","progver":"v5.36.1","timestamp":1784255815},
[{"name":"/fx","mtime":1784255815},
{"name":".hidden","asize":2,"dsize":4096,"mtime":1784255815},
{"name":"a.txt","asize":5,"dsize":4096,"mtime":1784255815,"ino":58240928,"hlnkc":true},
{"name":"hardlink.txt","asize":5,"dsize":4096,"mtime":1784255815,"ino":58240928,"hlnkc":true},
{"name":"link.txt","asize":5,"mtime":1784255815,"notreg":true},
{"name":"zero.bin","mtime":1784255815},
[{"name":"sub","mtime":1784255815},
{"name":"b.log","asize":3,"dsize":4096,"mtime":1784255815},
[{"name":"deep","mtime":1784255815},
{"name":"c.dat","asize":1,"dsize":4096,"mtime":1784255815}]],
[{"name":"empty","mtime":1784255815}
]]]
```

- [ ] **Step 2: Write the failing test**

Create `tests/gduMapper.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mapGduTree } from '../src/services/gduMapper';
import { FileNode } from '../src/models/types';

/**
 * The mapper is built against RECORDED real gdu v5.36.1 output, because the
 * integration prompt's description of the schema was wrong in ways a
 * hand-written fixture would have preserved:
 *
 *  - a directory is [meta, ...children] (FLAT), not [meta, childrenArray]
 *  - directories carry no size at all; it must be summed
 *  - mtime is Unix SECONDS; FileNode.modifiedAt is milliseconds
 *  - asize is OMITTED when zero
 *  - ino/hlnkc ARE present, so hardlink dedup is possible and required
 */

const fixture = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'gdu-v5.36.1.json'), 'utf8'),
);

function find(root: FileNode, name: string): FileNode | undefined {
  if (root.name === name) return root;
  for (const c of root.children ?? []) {
    const hit = find(c, name);
    if (hit) return hit;
  }
  return undefined;
}

test('maps a flat [meta, ...children] directory, not [meta, childrenArray]', () => {
  const { root } = mapGduTree(fixture, '/fx');
  assert.equal(root.type, 'dir');
  assert.equal(root.name, 'fx');
  // 6 files/links + sub + empty = 8 direct children. A [meta, childrenArray]
  // reading would see 1.
  assert.equal(root.children!.length, 8);
});

test('reconstructs full paths from the parent chain', () => {
  const { root } = mapGduTree(fixture, '/fx');
  const deep = find(root, 'c.dat')!;
  assert.equal(deep.path, '/fx/sub/deep/c.dat');
});

test('converts mtime from seconds to milliseconds', () => {
  const { root } = mapGduTree(fixture, '/fx');
  assert.equal(find(root, 'a.txt')!.modifiedAt, 1784255815 * 1000);
});

test('treats a missing asize as zero rather than NaN', () => {
  const { root } = mapGduTree(fixture, '/fx');
  assert.equal(find(root, 'zero.bin')!.size, 0);
});

test('sums directory sizes, deduping hard links exactly once', () => {
  const { root } = mapGduTree(fixture, '/fx');
  // .hidden 2 + a.txt 5 + hardlink.txt 0 (same ino as a.txt) + link.txt 5
  // + zero.bin 0 + sub(b.log 3 + deep(c.dat 1)) = 16
  assert.equal(root.size, 16);
  assert.equal(find(root, 'hardlink.txt')!.size, 0);
  assert.equal(find(root, 'hardlink.txt')!.hardlinkDuplicate, true);
  assert.equal(find(root, 'a.txt')!.size, 5); // first occurrence keeps its size
});

test('reports hardlink counters for the scan record', () => {
  const { stats } = mapGduTree(fixture, '/fx');
  assert.equal(stats.hardlinkedFiles, 1);
  assert.equal(stats.hardlinkedBytes, 5);
});

test('flags a symlink via notreg and never gives it children', () => {
  const { root } = mapGduTree(fixture, '/fx');
  const link = find(root, 'link.txt')!;
  assert.equal(link.isSymlink, true);
  assert.equal(link.type, 'file');
});

test('keeps empty dirs as children: [] — the empty-folder finder depends on it', () => {
  const { root } = mapGduTree(fixture, '/fx');
  const empty = find(root, 'empty')!;
  assert.equal(empty.type, 'dir');
  assert.deepEqual(empty.children, []);
});

test('derives isHidden and extension without path.extname', () => {
  const { root } = mapGduTree(fixture, '/fx');
  assert.equal(find(root, '.hidden')!.isHidden, true);
  assert.equal(find(root, '.hidden')!.extension, undefined); // leading dot is not an ext
  assert.equal(find(root, 'b.log')!.extension, 'log');
  assert.equal(find(root, 'a.txt')!.isHidden, false);
});

test('counts files and dirs for the scan record', () => {
  const { stats } = mapGduTree(fixture, '/fx');
  assert.equal(stats.fileCount, 6);   // .hidden a.txt hardlink.txt link.txt zero.bin b.log c.dat = 7? see note
  assert.equal(stats.dirCount, 4);    // /fx, sub, deep, empty
});
```

Note: fix the `fileCount` expectation to the true count while implementing —
`.hidden`, `a.txt`, `hardlink.txt`, `link.txt`, `zero.bin`, `b.log`, `c.dat` = **7**.

- [ ] **Step 3: Run to verify it fails**

Run: `npx tsx --test tests/gduMapper.test.ts`
Expected: FAIL — cannot find module `../src/services/gduMapper`.

- [ ] **Step 4: Implement the mapper**

Create `src/services/gduMapper.ts`:

```ts
import { FileNode } from '../models/types';
import { detectContainerKind } from '../utils/containerKind';

/**
 * gdu's JSON -> FileNode.
 *
 * Schema verified against real gdu v5.36.1 output (tests/fixtures):
 *   document = [1, 2, {header}, <dirNode>]
 *   dirNode  = [metaObj, ...children]   <-- FLAT. The integration prompt claimed
 *                                           [meta, childrenArray]; its sample had
 *                                           one child per dir, which hid the bug.
 *   fileNode = { name, asize?, dsize?, mtime, notreg?, ino?, hlnkc? }
 *
 * Notes that cost real debugging time:
 *   - `asize`/`dsize` are OMITTED when zero, so always default them.
 *   - directories carry NO size; it is summed here.
 *   - `mtime` is Unix seconds; FileNode.modifiedAt is milliseconds.
 *   - `ino`+`hlnkc` appear only when the link count is >1 — the same optimization
 *     the walker makes. Deduping on them reproduces the walker's byte totals
 *     exactly, so this is required, not optional.
 *
 * Hot path: no path.join and no path.extname. Both are ~20x slower than the raw
 * string ops here (787ms vs 39ms per 458k nodes) and this runs once per node.
 */

export interface GduMapStats {
  fileCount: number;
  dirCount: number;
  hardlinkedFiles: number;
  hardlinkedBytes: number;
  cloudFiles: number;
  cloudBytes: number;
}

interface GduMeta { name: string; mtime: number }
interface GduFile {
  name: string; asize?: number; dsize?: number; mtime: number;
  notreg?: boolean; ino?: number; hlnkc?: boolean;
}
type GduDir = [GduMeta, ...(GduDir | GduFile)[]];

export interface GduMapOptions {
  /** Shared across shards so hard links are deduped across the whole scan. */
  seenInodes?: Set<number>;
  /** Path -> cloud provider, or undefined. Injected to keep this module pure. */
  cloudProviderFor?: (p: string) => 'icloud' | 'onedrive' | 'dropbox' | undefined;
}

/**
 * @param doc     the parsed gdu document, or a bare dir node (shard)
 * @param rootPath absolute path the tree is rooted at
 */
export function mapGduTree(
  doc: unknown,
  rootPath: string,
  opts: GduMapOptions = {},
): { root: FileNode; stats: GduMapStats } {
  const stats: GduMapStats = {
    fileCount: 0, dirCount: 0,
    hardlinkedFiles: 0, hardlinkedBytes: 0,
    cloudFiles: 0, cloudBytes: 0,
  };
  const seen = opts.seenInodes ?? new Set<number>();
  const cloudFor = opts.cloudProviderFor;

  // [1, 2, {header}, dirNode] vs a bare dirNode
  const arr = doc as unknown[];
  const dirNode = (Array.isArray(arr) && typeof arr[0] === 'number' ? arr[3] : arr) as GduDir;

  // gdu names the root with its full path; children carry bare names.
  const parentOf = rootPath.endsWith('/') ? rootPath.slice(0, -1) : rootPath;

  function buildFile(o: GduFile, parent: string): FileNode {
    stats.fileCount++;
    const name = o.name;
    const p = parent === '/' ? '/' + name : parent + '/' + name;
    let size = o.asize || 0;

    const node: FileNode = {
      name,
      path: p,
      size,
      type: 'file',
      modifiedAt: o.mtime * 1000,
      isHidden: name.charCodeAt(0) === 46,
    };

    const dot = name.lastIndexOf('.');
    if (dot > 0 && dot < name.length - 1) node.extension = name.slice(dot + 1).toLowerCase();

    const container = detectContainerKind(name, false);
    if (container) node.container = container;

    if (o.notreg) {
      // Non-regular: symlink/socket/fifo. The walker records symlinks as leaves
      // and never follows them; gdu (without -L) does the same.
      node.isSymlink = true;
      return node;
    }

    // Hard links: gdu emits ino only when the link count is >1, so presence of
    // hlnkc IS the nlink>1 test. Deduping here matches the walker byte-for-byte.
    if (o.hlnkc && o.ino !== undefined) {
      if (seen.has(o.ino)) {
        node.hardlinkDuplicate = true;
        stats.hardlinkedFiles++;
        stats.hardlinkedBytes += size;
        node.size = 0; // first occurrence already counted
        return node;
      }
      seen.add(o.ino);
    }

    // Cloud placeholder: reports a logical size but occupies no disk blocks.
    // gdu omits dsize when it is zero. Gated on a known cloud folder so sparse
    // files (VM images, DBs) are never mislabelled "safe to delete".
    if (size > 0 && !o.dsize && cloudFor) {
      const provider = cloudFor(p);
      if (provider) {
        node.cloudPlaceholder = true;
        node.cloudProvider = provider;
        stats.cloudFiles++;
        stats.cloudBytes += size;
      }
    }
    return node;
  }

  function buildDir(d: GduDir, parent: string | null): FileNode {
    stats.dirCount++;
    const meta = d[0];
    // The shard root carries its own absolute path; children carry bare names.
    const p = parent === null ? parentOf : (parent === '/' ? '/' + meta.name : parent + '/' + meta.name);
    const name = parent === null
      ? (parentOf.slice(parentOf.lastIndexOf('/') + 1) || parentOf)
      : meta.name;

    const children: FileNode[] = [];
    let total = 0;
    for (let i = 1; i < d.length; i++) {
      const c = d[i];
      const child = Array.isArray(c) ? buildDir(c as GduDir, p) : buildFile(c as GduFile, p);
      total += child.size;
      children.push(child);
    }

    const node: FileNode = {
      name,
      path: p,
      size: total,
      type: 'dir',
      modifiedAt: meta.mtime * 1000,
      isHidden: name.charCodeAt(0) === 46,
      children, // MUST stay [] when empty — the empty-folder finder depends on it
    };
    if (children.some((c) => c.name === '.git')) node.gitRepo = true;
    const container = detectContainerKind(name, true);
    if (container) node.container = container;
    return node;
  }

  const root = buildDir(dirNode, null);
  return { root, stats };
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx tsx --test tests/gduMapper.test.ts`
Expected: PASS (all tests). Fix the `fileCount` expectation to 7 if it trips.

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck
git add src/services/gduMapper.ts tests/gduMapper.test.ts tests/fixtures/gdu-v5.36.1.json
git commit -m "feat(scan): map gdu JSON to FileNode, verified against recorded output"
```

---

## Task 2: Prove parity against the real walker

Before wiring anything in, prove the mapper agrees with the walker on a real tree.
This is what replaces the (now unnecessary) hardlink badge.

**Files:**
- Create: `tests/gduParity.test.ts`

- [ ] **Step 1: Write the parity test, skipped unless gdu is available**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mapGduTree } from '../src/services/gduMapper';
import { findGduBinary } from '../src/services/gduScanner';
import { startScan, getScan } from '../src/services/diskScanner';

/**
 * gdu and the walker must agree EXACTLY on a real tree. Measured on
 * /Applications this session: 30,070,595,907 == 30,070,595,907 and 21,499 ==
 * 21,499 hardlinked files. Naive (non-deduped) counting is 1.972% high, so this
 * test is what keeps the turbo engine honest instead of a UI caption.
 */
test('gdu and walker report identical bytes on the same tree', async (t) => {
  const bin = await findGduBinary();
  if (!bin) return t.skip('gdu not available');

  // A tree we control, containing a hard link so dedup is actually exercised.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gdu-parity-'));
  try {
    fs.mkdirSync(path.join(dir, 'sub'));
    fs.writeFileSync(path.join(dir, 'sub', 'big.bin'), Buffer.alloc(50_000, 1));
    fs.writeFileSync(path.join(dir, 'other.bin'), Buffer.alloc(1_234, 2));
    fs.linkSync(path.join(dir, 'sub', 'big.bin'), path.join(dir, 'hard.bin'));

    const out = path.join(dir, '..', `parity-${process.pid}.json`);
    execFileSync(bin, ['-n', '-o', out, dir], { stdio: 'ignore' });
    const { root: gduRoot, stats } = mapGduTree(
      JSON.parse(fs.readFileSync(out, 'utf8')), dir,
    );
    fs.unlinkSync(out);

    const scan = await startScan(dir, { incremental: false });
    await new Promise<void>((r) => {
      const iv = setInterval(() => { if (getScan(scan.scanId)!.status !== 'running') { clearInterval(iv); r(); } }, 25);
    });
    const walkerRoot = getScan(scan.scanId)!.root!;

    assert.equal(gduRoot.size, walkerRoot.size, 'total bytes must match exactly');
    assert.equal(stats.hardlinkedFiles, getScan(scan.scanId)!.hardlinkedFiles);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run it**

Run: `npx tsx --test tests/gduParity.test.ts`
Expected: PASS once Task 3 provides `findGduBinary` (until then it fails to
import — write Task 3 first if you prefer, the order is not load-bearing).

- [ ] **Step 3: Commit**

```bash
git add tests/gduParity.test.ts
git commit -m "test(scan): assert gdu and walker byte totals agree exactly"
```

---

## Task 3: Binary locator + safe spawn

**Files:**
- Create: `src/services/gduScanner.ts`
- Create: `tests/gduScanner.test.ts`

- [ ] **Step 1: Write the failing locator/fallback test**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findGduBinary, runGdu } from '../src/services/gduScanner';

test('findGduBinary returns null rather than throwing when nothing is installed', async () => {
  const found = await findGduBinary({ bundledPath: '/nonexistent/gdu', pathLookup: false });
  assert.equal(found, null);
});

test('runGdu rejects a non-zero exit instead of returning a partial tree', async () => {
  await assert.rejects(
    () => runGdu('/bin/false', '/tmp', '/tmp/should-not-exist.json'),
    /gdu (exited|failed)/i,
  );
});
```

- [ ] **Step 2: Implement the locator and spawn**

Create `src/services/gduScanner.ts`:

```ts
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * Locate the gdu binary: the bundled copy first, then $PATH so `npm run dev`
 * works for contributors without the bundling step.
 *
 * Never interpolates into a shell: callers spawn with execFile + an argv array,
 * because the scan root is user input.
 */
export interface FindOptions {
  bundledPath?: string;
  pathLookup?: boolean;
}

function bundledDefault(): string {
  // electron-builder places extraResources next to the app; in dev this simply
  // does not exist and we fall through to $PATH.
  const base = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
    ?? path.join(__dirname, '..', '..');
  const exe = process.platform === 'win32' ? 'gdu.exe' : 'gdu';
  return path.join(base, 'gdu', exe);
}

export async function findGduBinary(opts: FindOptions = {}): Promise<string | null> {
  const bundled = opts.bundledPath ?? bundledDefault();
  try {
    await fsp.access(bundled, fs.constants.X_OK);
    return bundled;
  } catch { /* not bundled — try PATH */ }

  if (opts.pathLookup === false) return null;

  const exe = process.platform === 'win32' ? 'gdu.exe' : 'gdu';
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, exe);
    try {
      await fsp.access(candidate, fs.constants.X_OK);
      return candidate;
    } catch { /* keep looking */ }
  }
  return null;
}

/** Spawn gdu for one directory, writing JSON to `outFile`. Resolves on exit 0. */
export function runGdu(
  bin: string,
  dir: string,
  outFile: string,
  opts: { signal?: AbortSignal; ignoreDirs?: string[] } = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = ['-n', '-o', outFile];
    if (opts.ignoreDirs?.length) args.push('-i', opts.ignoreDirs.join(','));
    args.push(dir);
    // execFile + argv array: no shell, no interpolation of the user's path.
    execFile(bin, args, { signal: opts.signal, maxBuffer: 1 << 20 }, (err) => {
      if (err) return reject(new Error(`gdu failed: ${err.message}`));
      resolve();
    });
  });
}
```

- [ ] **Step 3: Run the tests**

Run: `npx tsx --test tests/gduScanner.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/services/gduScanner.ts tests/gduScanner.test.ts
git commit -m "feat(scan): locate and safely spawn the gdu binary"
```

---

## Task 4: Sharded scan with live progress

- [ ] **Step 1: Add the orchestrator to `src/services/gduScanner.ts`**

Shard by top-level directory so progress is live, memory is released per shard,
and cancellation has a checkpoint. Files directly under the root are stat'ed
directly (there are few, and it avoids a whole extra gdu run).

```ts
// (append to src/services/gduScanner.ts)
import { FileNode, ScanResult } from '../models/types';
import { mapGduTree } from './gduMapper';

/** Bytes above which a shard's JSON is refused (V8 caps a string at ~512 MB). */
const MAX_SHARD_BYTES = 450 * 1024 * 1024;

export async function gduScan(
  scan: ScanResult,
  bin: string,
  cloudProviderFor: (p: string) => 'icloud' | 'onedrive' | 'dropbox' | undefined,
): Promise<FileNode> {
  const rootPath = scan.rootPath;
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'treemap-gdu-'));
  const seenInodes = new Set<number>();

  try {
    const entries = await fsp.readdir(rootPath, { withFileTypes: true });
    const dirs = entries.filter((e) => e.isDirectory() && !e.isSymbolicLink());
    const rootStat = await fsp.lstat(rootPath);

    const children: FileNode[] = [];
    let total = 0;

    // Files sitting directly under the root: few, so stat them rather than
    // paying for another gdu process.
    for (const e of entries) {
      if (e.isDirectory() && !e.isSymbolicLink()) continue;
      const p = rootPath === '/' ? '/' + e.name : rootPath + '/' + e.name;
      try {
        const st = await fsp.lstat(p);
        const node: FileNode = {
          name: e.name, path: p, size: st.size, type: 'file',
          modifiedAt: Math.round(st.mtimeMs), isHidden: e.name.charCodeAt(0) === 46,
        };
        const dot = e.name.lastIndexOf('.');
        if (dot > 0 && dot < e.name.length - 1) node.extension = e.name.slice(dot + 1).toLowerCase();
        if (e.isSymbolicLink()) node.isSymlink = true;
        children.push(node);
        total += node.size;
        scan.fileCount++;
        scan.scanned++;
      } catch { /* vanished mid-scan */ }
    }

    // One gdu per top-level directory: live progress, bounded memory, and a
    // cancellation checkpoint between shards. Costs ~8% vs a single run and
    // buys back the progress gdu refuses to emit when piped.
    for (let i = 0; i < dirs.length; i++) {
      if (scan.cancelled) throw new Error('cancelled');
      const d = dirs[i];
      const dirPath = rootPath === '/' ? '/' + d.name : rootPath + '/' + d.name;
      scan.currentPath = dirPath;

      const outFile = path.join(tmpDir, `shard-${i}.json`);
      await runGdu(bin, dirPath, outFile);

      const st = await fsp.stat(outFile);
      if (st.size > MAX_SHARD_BYTES) {
        throw new Error(
          `gdu output for ${dirPath} is ${Math.round(st.size / 1048576)} MB, ` +
          `beyond the ~512 MB single-string ceiling — falling back to the walker`,
        );
      }

      const parsed = JSON.parse(await fsp.readFile(outFile, 'utf8'));
      const { root: sub, stats } = mapGduTree(parsed, dirPath, { seenInodes, cloudProviderFor });
      await fsp.unlink(outFile).catch(() => {});

      children.push(sub);
      total += sub.size;
      scan.fileCount += stats.fileCount;
      scan.dirCount += stats.dirCount;
      scan.hardlinkedFiles = (scan.hardlinkedFiles ?? 0) + stats.hardlinkedFiles;
      scan.hardlinkedBytes = (scan.hardlinkedBytes ?? 0) + stats.hardlinkedBytes;
      scan.cloudFiles = (scan.cloudFiles ?? 0) + stats.cloudFiles;
      scan.cloudBytes = (scan.cloudBytes ?? 0) + stats.cloudBytes;
      scan.scanned = scan.fileCount + scan.dirCount;
    }

    scan.dirCount++; // the root itself
    scan.scanned = scan.fileCount + scan.dirCount;

    const name = rootPath.slice(rootPath.lastIndexOf('/') + 1) || rootPath;
    return {
      name, path: rootPath, size: total, type: 'dir',
      modifiedAt: Math.round(rootStat.mtimeMs),
      isHidden: name.charCodeAt(0) === 46,
      children,
    };
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/services/gduScanner.ts
git commit -m "feat(scan): shard gdu by top-level dir for live progress and bounded memory"
```

---

## Task 5: Wire into startScan with mandatory fallback

**Files:**
- Modify: `src/models/types.ts` — add `'gdu-turbo'` to the `engine` union
- Modify: `src/services/diskScanner.ts` — try gdu, fall back to `walk()`

- [ ] **Step 1: Widen the engine union**

```ts
  engine?: 'walker' | 'turbo-walker' | 'gdu-turbo' | 'ntfs-mft' | 'cloud';
```

- [ ] **Step 2: Try gdu first inside the existing fire-and-forget path**

In `startScan`, replace the `void walk(...)` call with a runner that prefers gdu.
**Fallback is mandatory:** any gdu failure logs and falls through to the walker;
only a walker failure surfaces to the user.

```ts
  void (async () => {
    // gdu is preferred (~120k items/s vs the walker's 69–97k) but is strictly
    // best-effort: a missing binary, a spawn failure, a non-zero exit or an
    // oversized shard all fall through to the walker rather than failing a scan.
    if (!opts.incremental && rootStat.isDirectory() && process.env.TREEMAP_NO_GDU !== '1') {
      try {
        const bin = await findGduBinary();
        if (bin) {
          scan.engine = 'gdu-turbo';
          scan.root = await gduScan(scan, bin, cloudProviderFor);
          scan.status = 'complete';
          scan.finishedAt = Date.now();
          return;
        }
      } catch (err) {
        if (scan.cancelled) { /* fall through to the normal cancel path */ }
        // eslint-disable-next-line no-console
        console.warn(`[scan] gdu engine unavailable, using walker: ${String(err)}`);
        // Reset anything the aborted gdu attempt accumulated.
        scan.fileCount = 0; scan.dirCount = 0; scan.scanned = 0;
        scan.hardlinkedFiles = 0; scan.hardlinkedBytes = 0;
        scan.cloudFiles = 0; scan.cloudBytes = 0;
      }
    }
    scan.engine = IO_THREADS > 4 ? 'turbo-walker' : 'walker';
    await walk(scan, rootStat.isDirectory(), ignore, cache);
  })().catch((err: unknown) => {
    scan.status = 'error';
    scan.error = err instanceof Error ? err.message : String(err);
    scan.finishedAt = Date.now();
  });
```

Remove the now-unconditional `engine:` assignment from the `ScanResult` literal
(leave it unset until an engine is chosen), and import `findGduBinary` / `gduScan`.

- [ ] **Step 3: Test the fallback**

Add to `tests/gduScanner.test.ts`:

```ts
test('a scan still completes via the walker when gdu is disabled', async () => {
  process.env.TREEMAP_NO_GDU = '1';
  try {
    const scan = await startScan(os.tmpdir(), { incremental: false });
    await new Promise<void>((r) => {
      const iv = setInterval(() => { if (getScan(scan.scanId)!.status !== 'running') { clearInterval(iv); r(); } }, 25);
    });
    const s = getScan(scan.scanId)!;
    assert.equal(s.status, 'complete');
    assert.ok(s.engine === 'walker' || s.engine === 'turbo-walker');
  } finally { delete process.env.TREEMAP_NO_GDU; }
});
```

- [ ] **Step 4: Verify and commit**

```bash
npm run typecheck && npm test 2>&1 | grep -E "^ℹ (pass|fail)"
git add src/models/types.ts src/services/diskScanner.ts tests/gduScanner.test.ts
git commit -m "feat(scan): prefer the gdu turbo engine, fall back to the walker"
```

---

## Task 6: UI engine label

**Files:**
- Modify: `public/index.html` (~line 2337, the engine label map)

- [ ] **Step 1: Add the label**

```js
      const label = { 'turbo-walker': 'Turbo walker', 'gdu-turbo': 'Turbo engine (gdu)', 'ntfs-mft': 'NTFS MFT reader', walker: 'Standard walker', cloud: 'Cloud metadata listing' }[s.engine] || s.engine;
```

- [ ] **Step 2: Commit**

```bash
git add public/index.html
git commit -m "feat(ui): label the gdu turbo engine on the dashboard"
```

---

## Task 7: Bundling

**Files:**
- Create: `scripts/fetchGdu.js`
- Modify: `package.json` (`extraResources`, a `postinstall`/`prepare` hook)
- Create: `build/gdu/LICENSE.md` (gdu's MIT licence, vendored — required)

- [ ] **Step 1: Vendor the licence**

gdu is MIT. Download `LICENSE.md` from the pinned release tag and commit it to
`build/gdu/LICENSE.md`. **Shipping the binary without it violates the licence.**

- [ ] **Step 2: Fetch script**

Create `scripts/fetchGdu.js` that downloads the correct asset for the target
platform/arch from `https://github.com/dundee/gdu/releases/download/v5.36.1/` —
`gdu_darwin_arm64.tgz`, `gdu_darwin_amd64.tgz`, `gdu_linux_amd64.tgz`,
`gdu_windows_amd64.exe.zip` — verifies it against the release checksum, extracts
it to `build/gdu/<platform>-<arch>/gdu`, and is a no-op if already present.

- [ ] **Step 3: Wire into electron-builder**

In `package.json` `build`, add:

```json
    "extraResources": [
      { "from": "build/gdu/${platform}-${arch}", "to": "gdu", "filter": ["**/*"] },
      { "from": "build/gdu/LICENSE.md", "to": "gdu/LICENSE.md" }
    ]
```

- [ ] **Step 4: Verify the packaged app finds it**

Build (`npm run dist:mac`) and confirm `Contents/Resources/gdu/gdu` exists and is
executable. Note from prior sessions: `dmg-builder/templates/` is empty so the DMG
step fails at `ENOENT background.tiff` — the `.app` is already packaged by then, so
`ditto release/mac-arm64/TreeMap.app /Applications/TreeMap.app` still works.

- [ ] **Step 5: Commit**

```bash
git add scripts/fetchGdu.js package.json build/gdu/LICENSE.md
git commit -m "build: bundle the gdu binary per platform with its MIT licence"
```

---

## Task 8: Verify at scale

- [ ] **Step 1: Full suite**

Run: `npm run typecheck && npm test && npm run build`
Expected: all green; test count ≥ 130.

- [ ] **Step 2: Throughput on a real tree**

Scan `/Applications` in the running app. Confirm:
- engine reads "Turbo engine (gdu)"
- **throughput ≥ 100k items/sec** (the target; measured ~120k in isolation)
- **counts and bytes match the walker exactly** (408,498 files / 458,193 items /
  30,070,595,907 bytes on this machine at the time of writing — re-measure, the
  tree drifts)

- [ ] **Step 3: Progress never goes dead**

Watch the status line during a large scan: it must keep moving (shard by shard)
rather than sitting blank. This is the requirement the single-shot design failed.

- [ ] **Step 4: Fallback is real**

Run with `TREEMAP_NO_GDU=1` and confirm scans still complete via the walker with
identical numbers.

- [ ] **Step 5: Report**

Throughput, parity numbers, suite result, and what was verified live.

---

## Out of scope

- `ntfs-mft` engine — as the prompt states, a separate effort.
- Scan cancellation UI. Phase 1 verification found TreeMap has **no user-facing
  scan cancel** (only `offloadCancelBtn`; `cancelAllScans` is shutdown-only). The
  sharded loop above adds a real cancellation *checkpoint*, so the plumbing is
  ready — but wiring a button is its own change.
- Incremental (`--incremental`) scans keep using the walker: the mtime cache is
  built around the walker's per-directory reuse and gdu has no equivalent.
