# Platform notes

Every OS-native mechanism TreeMap uses, which tier of §2.3's preference order it
sits in, what happens when it is unavailable, and — where it matters — the
measured behaviour that contradicts what the documentation or the common
implementation would lead you to expect.

The rule this document exists to serve: **TreeMap never prints a number it
cannot vouch for.** Where a mechanism is missing, the feature says so in plain
language rather than degrading into a confident wrong answer.

## Mechanism preference order (§2.3)

1. A well-maintained npm package wrapping the syscall.
2. A small N-API addon, prebuilt in CI — never compiled on a user's machine.
3. A bundled or system binary, always in a structured output mode.

TreeMap currently ships **no native addons**. Everything below is tier 1 (a
plain Node call) or tier 3 (a system binary in a structured mode). Where that
costs a capability, it is stated rather than hidden.

## Verification status — read this first

| Platform | How this code was verified |
|---|---|
| **macOS** | Written and executed on macOS 15 (Darwin 25.5, arm64). Every mechanism was probed against the live system, and the behaviours in "Measured surprises" below were found that way. |
| **Windows** | **Written on macOS; never executed on Windows by the author.** Pure logic is unit-tested in `tests/platformCrossOs.test.ts`; the live round-trips run in CI on `windows-latest`. |
| **Linux** | **Written on macOS; never executed on Linux by the author.** `/proc` walking is tested against a synthetic `/proc` fixture that runs on any OS; the rest is unit-tested and exercised in CI on `ubuntu-latest`. |

`.github/workflows/test.yml` runs the suite plus `npm run capabilities:report`
on all three. The report is a record, not an assertion — an honest "unavailable"
state passes every test by design, so a capability that silently regresses is
only visible by reading it.

---

## macOS

| Capability | Mechanism | Tier | When unavailable |
|---|---|---|---|
| Fast enumeration | `readdir` + `lstat` | 1 | Always available (degraded — see below) |
| Live changes | `fs.watch(recursive)` → FSEvents | 1 | Watch cannot be established → index staleness guard |
| Open handles | `lsof -F` | 3 | `lsof` missing → delete proceeds without the warning |
| Zombie handles | `lsof -F` + inode comparison | 3 | as above |
| Allocated size | `lstat().blocks × 512` | 1 | Always available, exact |
| Placeholders | allocated blocks + `.icloud` stubs | 1 | Always available |
| Provenance | `mdls -plist` + `com.apple.quarantine` | 3 | Spotlight off → quarantine record still answers |
| Topology | `diskutil list`/`info -plist` → `plutil`, + `statfs` | 3 + 1 | — |
| Snapshots | `tmutil` + `mount_apfs` | 3 | No local snapshots → stated plainly |
| Clone families | **none reachable** | — | Sizes labelled approximate |
| SMART | `smartctl --json` | 3 | Not installed → install instructions shown |
| Shell menu | Finder Quick Action in `~/Library/Services` | 3 | — |

### Why `getattrlistbulk` is not used

A1 specifies `getattrlistbulk` for macOS enumeration. It is unreachable from
Node and has no CLI equivalent, so it would need a native addon. Two reasons it
is not one yet: TreeMap already bundles **`gdu`**, measured at 116–129k items/s
with exact walker parity (see the README), which is the fast path the scanner
actually uses; and an addon could not be verified on the two platforms whose
addons would matter most. `probeFastEnumeration` reports *degraded* with the
reason, rather than claiming a mechanism that is not there.

### Why clone-family detection is absent

A2 needs `getattrlist` with `ATTR_CMNEXT_CLONEID`. No Node API and no macOS
binary exposes clone identity — `diskutil` does not report it at all. Rather
than infer clone membership from size and mtime coincidence (which would be
guessing), `getCloneFamily` returns `null` and sizing falls back to
allocated blocks reconciled against `statfs`. The volume total is therefore
right; a folder full of clones may read larger than it is, and the UI says so.
This is §10's "if clone detection failed, say the size is approximate".

**Measured, so the limitation is precise rather than vague** (macOS 15, APFS):

| Operation | Free space consumed | `st.blocks` reports |
|---|---|---|
| Write a 50 MB file | 54,853,632 | full size |
| `cp -c` clone it | **−4,096** (nothing) | **full size** |
| `cp` a real copy | 52,436,992 | full size |

A clone receives its **own inode** and `nlink` stays 1, so it is
indistinguishable from a real copy through every interface reachable without
native code. `du` gets this wrong identically. In that measurement the naive
allocated sum was 157,286,400 against 107,286,528 actually consumed — a
49,999,872-byte gap, exactly the cloned file.

What A2 therefore does: measure exactly what is measurable, and quantify the
rest **in aggregate** rather than guessing per file.

| Case | Detected exactly? | How |
|---|---|---|
| Hard link | **Yes** | same inode, `nlink > 1` |
| Sparse file | **Yes** | allocated blocks |
| Compressed file | **Yes** | allocated blocks (Windows: `GetCompressedFileSize`) |
| Clone / reflink | **No** | reported in the volume reconciliation delta |

### The exclusivity scope rule (A2)

"Exclusive" is meaningless without a scope, and choosing one loosely makes the
same folder report different numbers depending on where the user started
scanning. One rule, applied everywhere:

> **Exclusivity is computed within the scanned root.** A file's bytes are
> *exclusive* when deleting it from that root would free them, and *shared* when
> another name for the same data also lives in the root. When a family's `nlink`
> exceeds the names found inside the root, the family reaches outside it —
> deleting everything in scope would still free nothing — and that is flagged
> (`extendsOutsideRoot`) rather than silently counted as exclusive.

Telling someone they can reclaim space that deleting the file would not actually
free is the specific failure this rule exists to prevent.

### Reconciliation is offered only for a whole volume

`statfs` describes a filesystem, not a folder. A subfolder's contribution to
used space cannot be isolated from outside, so a "delta" computed for one would
consist of everything else on the disk. `isMountPoint()` gates it, and a
subfolder is told plainly why no comparison is shown.

### Why a Quick Action rather than a Finder Sync extension

D2 offers either. A Finder Sync extension must be embedded in a **code-signed**
host app, and TreeMap ships ad-hoc signed. An extension that cannot load fails
*silently*, which is worse than not having one. A Quick Action needs no signing,
no admin rights, and uninstalls by deleting one directory.

### Measured surprises (macOS)

These were found by testing against the live system. Each would otherwise have
shipped a confidently wrong answer.

1. **`lsof` emits no `(deleted)` marker.** The Linux behaviour of appending
   `(deleted)` to an unlinked-but-open file does not happen on macOS: the output
   for a descriptor is byte-identical before and after `unlink()` — same path,
   same size, same inode. B5 therefore compares lsof's `i` (inode) field against
   the inode currently at that path. The `(deleted)` marker is still honoured
   where it appears, so Linux takes the cheap path and macOS the correct one.

2. **`lsof` exits 1 when any path argument is missing — while still printing
   valid records for the rest.** An earlier version of `runText` discarded stdout
   on rejection, which silently turned the entire open-file guard into "nothing
   has this open" the moment a delete batch contained one already-deleted path.
   `CommandFailedError` now carries `stdout`, and `tests/platform.test.ts` pins
   the behaviour.

3. **`lsof` reports symlink-resolved paths.** A handle on `/tmp/x` comes back as
   `/private/tmp/x`. Matching against a delete set compares realpaths, and
   results are mapped back to the caller's path so warnings name the file the
   user is looking at.

4. **`SEEK_DATA`/`SEEK_HOLE` are not needed** (and are unreachable from Node —
   `fs.read` exposes no `whence`). `lstat().blocks × 512` answers TreeMap's
   actual question exactly: a 50 MB truncate-only sparse file reports
   `size = 52428800`, `blocks = 0`. Hole *positions*, the only thing SEEK_HOLE
   adds, are not displayed anywhere. **Deviation from A3 as written.**

5. **`kMDItemDownloadedDate` is `(null)` even on genuine downloads.** The
   accurate source is `com.apple.quarantine`
   (`flags;hexUnixSeconds;appName;uuid`), which also yields the downloading
   application — something no `kMDItem*` key exposes. **Deviation from C3 as
   written**, in the direction of more accurate data.

6. **`diskutil` and `mdls` have no `--json`, but do have `-plist`.** Output is
   piped through `plutil -convert json` (`src/platform/macos/plist.ts`) rather
   than hand-parsed, so §10's no-regex-over-human-output rule holds. Also:
   `diskutil list -plist` answers the whole topology question in one call, and
   synthesised APFS containers (`disk1`…) are told from real hardware by
   carrying `APFSPhysicalStores`. A container's drive is its physical store with
   the partition suffix stripped — and `disk3s1s1` must reduce to `disk3`, not
   `disk3s1`, or a one-SSD Mac appears to have four drives.

7. **Per-volume usage on APFS (A5): `CapacityInUse`, never size − free.** Every
   volume in a container reports the *container's* size as its own and shares
   the container's free space, so both `Size` and any statfs-derived "used"
   describe the pool, not the volume. `diskutil list -plist` carries the one
   per-volume truth, `CapacityInUse` — the only figure `usedBytes` may sum. Two
   measured wrinkles, both handled in the pure mapper (fixture-tested):
   - **A booted Mac lists the system volume twice** — the volume (`disk3s1`)
     and the sealed snapshot it boots from (`disk3s1s1`), with identical
     `CapacityInUse`. One store, two views; the mapper keeps the mounted one,
     or a disk bar would count the OS twice.
   - `diskutil list` names a physical disk by its partition scheme
     (`GUID_partition_scheme`). `diskutil info -plist <disk>` — once per
     *physical disk*, so the subprocess-per-volume trap does not apply — fills
     the product name (`MediaName`) and `SolidState`.
   Free space comes from `statfs` per mounted volume with A2's exact semantics
   (free = `bavail`; a statfs-derived used, taken only for non-APFS partitions,
   uses `bfree` so the root reserve is not booked as data). Sum of
   `CapacityInUse` across this Mac's container reconciles with `df` within
   ~1.5% — the residue is container metadata and snapshot overhead, which
   belongs to the container, not to any volume.

8. **`ps -o comm=` prints the full executable path on macOS** (measured:
   `/Applications/Google Chrome.app/Contents/…/Google Chrome Helper (Renderer)`)
   — unlike Linux, where `comm` is the kernel's 15-character name. B5's restart
   action uses it twice: to verify a pid still belongs to the process the panel
   showed (pids are recycled), and to find the enclosing `.app` bundle so
   "restart" can genuinely mean quit-and-reopen via `open`. The identity check
   tolerates prefix matches only for names ≥ 9 characters, because older `lsof`
   builds truncate command names at 9 and Linux truncates at 15 — while a short
   name like `node` must match exactly (`nodemon` reusing its pid is realistic).
   Two adjacent subtleties, both unit-tested: `process.kill(pid, 0)` throws
   `EPERM` for a *live* process owned by someone else (only `ESRCH` means gone),
   and the `.app` test matches the **first** `.app/` path segment so a Chrome
   helper resolves to Chrome itself, which is the thing `open` can reopen.

---

## Windows

| Capability | Mechanism | Tier | When unavailable |
|---|---|---|---|
| Fast enumeration | `readdir` + `lstat` | 1 | Always available (degraded — no MFT) |
| Live changes | `fs.watch(recursive)` → ReadDirectoryChangesW | 1 | staleness guard |
| Open handles | Restart Manager (`RmGetList`) via PowerShell P/Invoke | 1 | PowerShell missing → no warning |
| Allocated size | `GetCompressedFileSize`, batched | 1 | falls back to logical size |
| Placeholders | NTFS cloud reparse attributes, batched | 1 | — |
| Provenance | `Zone.Identifier` alternate data stream | 1 | Non-NTFS volume → no record exists |
| Topology | `Get-PhysicalDisk` / `Get-VirtualDisk` / `Get-Volume` | 3 | — |
| Snapshots | `Win32_ShadowCopy` (+ `mklink` to read) | 3 | System Protection off → stated plainly |
| SMART | `smartctl --json` | 3 | Not installed → download link shown |
| Shell menu | `reg.exe` under `HKCU` | 3 | — |
| Zombie handles | **not implemented** | — | Explained in the UI |

### Why MFT parsing is not implemented

A1's headline claim rests on reading `$MFT` through a raw volume handle. It is
reachable in principle from pure Node (`fs.read` on `\\.\C:`), but it is roughly
1,500 lines of binary structure parsing — boot sector, record headers, attribute
lists, non-resident run-lists, path reconstruction — that **could not be
executed even once** from the development machine. Shipping untested binary
parsing that reports disk sizes would violate the prompt's own core rule.
`probeFastEnumeration` reports *degraded* with a plain-language reason that also
notes the boundary WizTree itself has: the technique does not apply to FAT32,
exFAT or network paths at all.

### Why zombie-handle detection is absent

B5 requires picking **one** implementation and finishing it. Both candidates are
out of reach: `NtQuerySystemInformation` handle enumeration is undocumented and
needs a native addon, and Sysinternals' `handle.exe` may not be redistributed.
Rather than half-build both, `getZombieHandles` returns nothing and the
capability explains what the user can do instead (restart the program, or the
PC). This is the one capability where Windows is genuinely behind macOS and
Linux, and it is labelled as such rather than hidden.

### Why `Win32_ShadowCopy` rather than `vssadmin`

Two reasons, both load-bearing. `vssadmin list shadows` prints a **localised**
human table — its field labels are translated on non-English Windows, so a
parser written against the English output silently finds nothing. And it
**requires elevation**, whereas `Win32_ShadowCopy` can be enumerated without it,
so the UI can honestly say "3 restore points cover this file" before asking for
anything (§3.8). Elevation is requested only for the restore itself, which needs
`mklink /d` to name the shadow device.

### Why `HKCU\Software\Classes` rather than `HKLM`

It is the per-user half of the same merged view Explorer reads, so the menu
entry behaves identically — but needs **no administrator rights**. Three keys
are installed, because Explorer treats them as three surfaces:
`Directory\shell` (right-click a folder), `Directory\Background\shell`
(right-click inside one) and `Drive\shell`. The background variant must use
`%V`; `%1` is empty there, so copying the folder command verbatim yields a menu
item that launches TreeMap with no path.

### Windows traps encoded in the code

- **`ConvertTo-Json` unwraps a single-element array.** A one-disk machine returns
  an object where a two-disk machine returns an array. Every caller goes through
  `asArray()`, or single-disk machines — the common case — silently produce zero
  results.
- **`ConvertTo-Json -Depth` defaults to 2**, replacing anything deeper with a
  type name and no error.
- **`RmGetList` must be called twice**: once to learn the count (it returns
  `ERROR_MORE_DATA`), then again with a correctly-sized buffer. One call
  silently truncates the answer.
- **`lstat().blocks` is 0 on Windows.** The base implementation's allocated size
  would be the logical size — right for ordinary files, wrong by the entire
  saving for every compressed, sparse or cloud-backed one. Hence
  `GetCompressedFileSize`.
- Paths are passed to PowerShell **through the environment**, never interpolated
  into script text, so a path containing `'`, `$(...)` or a backtick cannot be
  interpreted as syntax.

---

## Linux

| Capability | Mechanism | Tier | When unavailable |
|---|---|---|---|
| Fast enumeration | `readdir` + `lstat`, concurrency from sysfs | 1 | Always available |
| Live changes | per-directory inotify | 1 | Watch limit → staleness guard |
| Open handles | `/proc/<pid>/fd` — no subprocess | 1 | `/proc` absent → no warning |
| Zombie handles | `/proc` + kernel's `(deleted)` marker | 1 | as above |
| Allocated size | `lstat().blocks × 512` | 1 | Always available, exact |
| Topology | `lsblk --json` (+ `zpool list -j`) | 3 | `lsblk` missing → stated |
| Provenance | `getfattr user.xdg.origin.url` | 3 | Firefox records nothing — see below |
| Snapshots | `btrfs subvolume list -s` | 3 | Not Btrfs → stated plainly |
| SMART | `smartctl --json` | 3 | Not installed → apt/dnf instructions |
| Shell menu | Nautilus / Dolphin / Thunar, per-user | 3 | None present → stated |
| Reflink groups | **none reachable** | — | Sizes labelled approximate |

### Why per-directory inotify rather than `fanotify`

A1 specifies `fanotify` with `FAN_REPORT_FID`, which covers a whole mount with
one descriptor. It requires `CAP_SYS_ADMIN` — root — and §3.8 forbids requiring
elevation for anything achievable without it. Node's recursive `fs.watch` is
*emulated* on Linux and, critically, **does not watch directories created after
the watch starts** — for a live disk index that is the single most important
case. So `LinuxProvider` watches each directory and adds a watch when a new one
appears. The trade is stated in the capability: very large trees can exhaust
`max_user_watches`, and TreeMap rechecks the folder rather than silently missing
changes.

### Why `filefrag` is not used for whole-tree sizing

A2 suggests `FS_IOC_FIEMAP` for reflink detection; it is an ioctl, unreachable
from Node. `filefrag -v` exposes the same extent map from userspace, but at one
subprocess per file — fine for an on-demand "what does this file really cost"
tooltip, hopeless for sizing a tree. Whole-tree sizing therefore uses allocated
blocks (exact per file, counting shared extents once per referencing file) and
labels the total approximate, exactly as the macOS clone case does.

### Firefox records no provenance, and the UI must say so

`user.xdg.origin.url` is a freedesktop convention Chromium-based browsers honour
and **Firefox does not**. A Firefox download has no origin attribute and never
will. C3 asks that this be noted rather than implying data exists, so the
capability distinguishes *nothing was ever recorded* from *we could not look* —
the first is a true statement about a Firefox download, the second would be
false.

### Open-file checking descends into folders (B2)

`getOpenHandlesBatch(paths)` answers for the paths **and anything beneath
them**. That contract exists because of a measured surprise: `lsof /some/dir`
reports only processes whose own cwd or descriptor *is* that directory and says
nothing about a file open inside it — so the obvious implementation silently
passed a folder full of open files, which is most of what TreeMap's Clean Up
view deletes.

Each platform meets the contract differently, and each is a full enumeration
intersected against the delete set in memory (§B2's own prescription), so the
cost is flat in the size of the batch:

| Platform | Mechanism | Descendants |
|---|---|---|
| macOS | one unfiltered `lsof -F` dump | prefix match |
| Linux | the existing `/proc/*/fd` walk | prefix match |
| Windows | Restart Manager, which has no enumerate-everything mode | folders walked into files and registered, capped at `RM_MAX_RESOURCES` (2,000) |

Measured on this Mac: ~152 ms for one path and ~378 ms for 1,000 — the same
enumeration either way, against §B2's one-second budget. Prefix matching
carries a trailing separator so deleting `/a/logs` never claims
`/a/logs-archive/x`; a false warning is how a guard trains people to click
through it.

Windows is the one platform that can hit its cap. When it does,
`expandForRegistration` reports `complete: false` rather than letting a partial
answer read as a clean one.

### Reading a snapshot needs root on macOS — measured, not assumed (B4)

Listing local snapshots is unprivileged and works fine. Reading one does not:

```
tmutil listlocalsnapshots /                  → works as an ordinary user
tmutil localsnapshot                         → works as an ordinary user (!)
mount_apfs -s <snap> /                       → "Resource busy"
mount_apfs -s <snap> /System/Volumes/Data    → "Operation not permitted"
```

The first failure is the boot volume refusing to have its own snapshot mounted
over itself; the second is the real answer — mounting needs root. There is no
unprivileged route: APFS has no `.snapshot` directory (that is ZFS and NetApp),
and nothing is pre-mounted under `/Volumes`. Windows is the same story for a
different reason (naming a shadow device with `mklink /d` needs administrator
rights or Developer Mode). **Btrfs is the exception**: a snapshot is an ordinary
subvolume already in the tree, so Linux confirms and restores with no
privileges at all.

That asymmetry is why `findDeleted` reports three states rather than two:
`present` (looked inside — Linux), `possible` (a snapshot exists that covers the
period, and confirming costs a password), and `absent`. Claiming `present`
without having looked would be exactly the confident-wrong-answer §10 bans.

Consequences encoded in the code:

- **One prompt, not one per snapshot.** Searching six snapshots as six
  privileged calls would ask for the password six times, so the whole
  mount → look → copy → unmount → next loop runs inside a single elevated
  script (`platform/macos/snapshotRecover.ts`).
- **The script is a fixed file that interpolates nothing**, written to a
  0700 temp file at run time and handed every value as argv through
  AppleScript's `quoted form of`. `do shell script` takes a *string*, which is
  the classic route from "restore my file" to "run my command".
- **It is inlined in the .ts rather than shipped as a sibling `.sh`** because
  the desktop build packs into `app.asar`, and `/bin/sh` cannot execute a path
  inside an asar archive — a bug that would appear only in the packaged app.
- **A dismissed prompt is `AUTHORIZATION_DECLINED`, not an error.** The user was
  asked and answered.

**Not executed:** the elevated branch itself, which needs a real password. The
helper is verified unprivileged (every mount fails → `NOTFOUND`, exit 0, no
leaked mount points, nothing written) and its argv quoting is unit-tested.

### `mdadm` is deliberately not shelled out to

It has no JSON mode, but `lsblk --json` already reports md devices with their
`children`, which is the mapping A5 needs. Parsing `mdadm --detail` prose would
add a §10 violation for no information gain.

### Per-volume usage (A5): `FSUSED`, never `fssize − fsavail`

`fsavail` excludes ext4's root-reserved blocks (5% by default), so the
subtraction would book the reserve as the user's data. `lsblk -O` exposes the
kernel's own `FSUSED`; a build without that column yields `usedBytes: null`,
shown as unknown rather than zero. ZFS pools take `zpool list -j`'s own
`allocated` property — raw pool space, the counterpart of its `free`. Windows
is the one platform where `Size − SizeRemaining` *is* correct (an NTFS volume
owns its space outright), and the Windows mapper says so where it does it.

### Linux traps encoded in the code

- **A filename can legitimately end in `" (deleted)"`.** Trusting the kernel's
  suffix blindly reports a live file as reclaimable and invites the user to kill
  the process holding it. The stripped path is confirmed against the inode
  behind the descriptor; when the descriptor cannot be stat'ed at all, the code
  stays silent rather than claiming something unverified.
- **`/proc` is a live view.** ENOENT while walking it is the normal case, not an
  error, and never aborts the pass.
- **Concurrency is read from `/sys/block/<dev>/queue/rotational`,** not guessed.
  Partitions carry no `queue/` directory, so the lookup walks up to the whole
  device — otherwise every partition falls back to the default. Rotational media
  gets a deliberately *narrow* walk: the README's existing finding that
  oversized concurrency is slower through kernel metadata-lock contention
  applies here in both directions.

---

## API surface

Platform capabilities are served at **`GET /api/platform/capabilities`**, not at
`GET /api/capabilities` as §2.2 suggests. That path was already taken by the
agent-facing manifest, which is generated from the `ENDPOINTS` registry,
documented in `AGENTS.md`, and pinned by `tests/discoverability.test.ts` — and
§4 requires every existing endpoint to keep its shape. The existing manifest
gains one **additive** optional `platform` key carrying an on/off summary and a
pointer to the detail endpoint.

Also available:

- `POST /api/platform/capabilities/refresh` — re-probe after granting a
  permission or installing a missing tool, rather than waiting out the 30-second
  cache or restarting.
- `GET /api/platform/topology` — physical disks and the volumes on each;
  `409 CAPABILITY_UNAVAILABLE` with a reason when it cannot be read.
- `GET /api/system/snapshots/find-deleted?path=` and
  `POST /api/system/snapshots/restore` — B4. §B4 names these
  `/api/snapshots/*`, but that namespace is already TreeMap's **scan
  history** (Trends, Compare). These are *filesystem* snapshots, which
  already live at `/api/system/snapshots`, so they stay there rather than
  leaving two meanings of "snapshot" under one path — the same resolution as
  `/api/platform/capabilities` in A5.
- `POST /api/files/open-handles` — B2 pre-flight: which of these paths, or
  files inside them, a program is holding open. Read-only. `DELETE /api/files`
  runs the same check itself and answers `409 OPEN_HANDLE_CONFLICT` (with the
  processes in `conflicts`) unless the caller passes `ignoreOpenHandles: true`.
- `GET /api/zombie-handles` — B5: space still held by files deleted while a
  process kept them open, grouped by process; `409 CAPABILITY_UNAVAILABLE`
  with the honest reason on Windows. `POST /api/zombie-handles/restart`
  (destructive, in the manifest's pinned list) asks one holder to quit —
  SIGTERM only, identity-checked against pid reuse, never TreeMap itself,
  never escalated to SIGKILL — and reopens it where that is genuinely
  supported (a macOS `.app`, via `open`, after the exit is confirmed).

---

## Last-opened dates (v4 §1.1)

Measured on this Mac before the implementation was written, because the
obvious design does not work here.

### macOS — Spotlight is on, and has nothing to say

- `mdutil -s /` → **"Indexing enabled"**.
- `mdimport -A` lists `kMDItemLastUsedDate` as a known attribute.
- `mdfind 'kMDItemLastUsedDate > "2020-01-01"'` matches **zero files on the
  entire machine**, and `mdls` returns an empty dict for every path tried,
  including `/Applications/Safari.app`. Apple no longer populates it.

A capability probe based on `mdutil` alone would therefore have reported this
feature *available* and then answered "unknown" for every file forever. So
availability is decided by whether Spotlight actually **answers** — probed once
per process against up to 128 real paths — not by whether it is switched on.
What that probe concludes is worded as what it is: "Spotlight returned no last
opened dates for a sample of N files here."

Cost, measured: `mdls -plist -` batched costs **~0.36 ms/path** (2,000 paths in
717 ms, which alone exceeds §2.5's 400 ms sidecar budget). `lstat` costs
**~0.0015 ms/path** (5,000 paths in 7.4 ms). Access time is therefore the
default source and Spotlight is an enrichment that must earn its 240x cost.
Access time is live here: a read advanced `atime` by two seconds on APFS,
verified directly.

**Three `mdls` batching traps**, all paid for:

1. `mdls -plist - a b c` emits an **array of dicts positionally matching the
   input paths**. Nothing else ties an answer to a file.
2. **One missing path destroys the whole batch.** With any nonexistent
   argument, `mdls` abandons the plist, prints `could not find /x.` as plain
   text, and **exits 0** — every valid path in that batch loses its answer,
   silently. Paths are stat'd first and only survivors are sent; a result whose
   length does not match the request is discarded rather than mis-zipped.
3. An attribute with no value is **absent from the dict**, not null. An empty
   dict is the normal case.

### Linux — a per-mount question

Read from `/proc/mounts`, taking the **longest** matching mount point, because
mounts nest: a `noatime` data drive under a `relatime` root would otherwise be
read through the root's options. Mount points are octal-escaped by the kernel
(`/mnt/my\040disk`), which matters for any drive named with a space.

`relatime` (the modern default) is treated as **usable** with its ~24-hour
precision stated — refusing it would throw away a good signal to avoid a
rounding error. `noatime` is fatal and reported as such.

### Windows — a two-bit field, not a boolean

`fsutil behavior query DisableLastAccess` returns 0–3:

| Value | Meaning | atime |
| --- | --- | --- |
| 0 | User Managed, Updates Enabled | usable |
| 1 | User Managed, Updates Disabled | frozen |
| 2 | System Managed, Updates Enabled | usable |
| 3 | System Managed, Updates Disabled | frozen |

Bit 0 is the disable flag; bit 1 only records who decides. **"Non-zero means
off" would wrongly blank this feature on every machine reporting 2**, a common
modern default. Updates have been off by default since Vista; Windows 10 1803
added the System Managed modes, which keep them on for smaller volumes.

When updates are off, TreeMap reports nothing and **does not fall back to
mtime**. On macOS and Linux the fallback to access time is honest because
access time really does track opening; on Windows with tracking off there is no
such fallback, so the honest answer is nothing.

**Not verified live:** neither the Linux nor the Windows path has run on its
own OS. Both are covered through their parse seams against captured tool
output, including every `DisableLastAccess` value and the `noatime`,
`relatime`, escaped-mount-point and nested-mount forms.

---

## Backup membership (v4 §1.2b)

**The rule: `pathCovered` is never promoted to `'yes'` by inference.** A false
"this is backed up" is the one error in TreeMap that directly destroys data —
someone reads it, deletes their only copy, and the backup never had the file.
Every mechanism available without mounting the backup destination (which §1.2b
forbids) can establish only two things: that a backup exists, and that a path is
not on the exclusion list. Neither is proof of coverage.

### macOS — measured on this Mac, which has no Time Machine

- `tmutil destinationinfo` → `tmutil: No destinations configured.`, **exit 0**.
- `tmutil latestbackup` → `Failed to mount destination…`, **also exit 0**.
  Exit codes are worthless here; the text is what is parsed.
- `tmutil isexcluded a b c` **batches, and echoes each path back** on its own
  `[Included]`/`[Excluded]` line — so answers are matched by name, not by array
  position. That makes it immune to the alignment trap that makes `mdls`
  batching dangerous.

And the finding that decided the design: with **no destination configured at
all**, `tmutil isexcluded ~/Desktop` still answers **`[Included]`**. "Included"
means "not on the exclusion list", nothing more. Reading it as "backed up"
would tell someone with no backups whatsoever that their files are safe.

Only `[Excluded]` yields a definite verdict (`'no'`). Everything else is
`'unknown'`, including the tempting case of a configured destination that
completed an hour ago and does not exclude the path.

### Linux — presence is not coverage

restic / borg / borgmatic / Timeshift are detected from config in their
documented locations plus `RESTIC_REPOSITORY`. `pathCovered` is **always**
`'unknown'`: there is no exclusion list to prove even a negative, and §1.2b is
explicit that a repository's existence is not proof a given file is inside it.
The reason string says exactly that to the user.

### Windows — File History

`%LOCALAPPDATA%\Microsoft\Windows\FileHistory\Configuration\Config1.xml`
records whether it is on and which folders it protects. Needs no elevation and
touches no backup volume. A protected folder still yields `'unknown'`: File
History runs on a schedule, so a file created since the last cycle is inside a
protected folder and absent from the backup.

**Not verified live:** this Mac has no Time Machine destination, so the
populated macOS paths have never run here — only the not-configured path has.
Linux and Windows have never run at all. All three are covered through their
parse seams against captured tool output.

---

## Git recoverability (v4 §1.2a)

The distinction the feature exists to draw: *4.2 GB fully pushed to origin*
(deleting costs one `git clone`) versus *4.2 GB with three uncommitted files*
(deleting is permanent). Same size, categorically different objects.

**A hole in the obvious design, found by testing it.** `git status --porcelain`
**does not list ignored files**. A repository containing `node_modules/` and
`build/` behind a `.gitignore` reports *completely clean* — verified directly —
so `fullyPushed` comes back true, and the UI would tell the user that deleting
their 4 GB `node_modules` "costs one git clone". It is not in the remote at
all. Every path is therefore also run through `git check-ignore`, batched per
repository over stdin, and an ignored path carries `pathTracked: false` — git
proves nothing about it.

**Finding the repo root is a filesystem walk, not `git rev-parse`.** Asking
`rev-parse --show-toplevel` once per directory cost **1.4 ms per path** — a
2,000-path batch would have spent most of a second spawning git before doing
any work. Walking up for a `.git` entry (which may be a *file*, for linked
worktrees and submodules) with a shared memo per batch brings a 2,000-path
batch to **75 ms**.

Every invocation uses `execFile` with an argv array, `--porcelain`/`-z` forms
only, and a timeout. Paths reach `check-ignore` on **stdin**, so a path
beginning with `-` cannot become a flag.
