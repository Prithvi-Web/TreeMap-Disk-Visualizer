# native — the Rust core

TreeMap's native core lives here: a Cargo workspace, the hand-written
declaration of what it exports to Node, and (once built) the module itself.
It is an accelerator. The app never needs it to run: when the module cannot be
loaded the legacy engines take over and the API says why.

```
native/
  treemap-core/          the Cargo workspace (edition 2024, Rust ≥ 1.85)
    crates/tm-governor   the resource governor: presets, the closed loop, the OS mechanisms — pure Rust
    crates/tm-walk       the native walker: one listing call per directory, a governed walk, columnar output
    crates/tm-node       the napi-rs bindings — the only crate Node touches
  index.d.ts             the module's TypeScript declaration, the one source of truth for its shapes
  prebuilt/<platform>-<arch>/treemap_core.node   the built module (gitignored)
  prebuilt/<platform>-<arch>/VERSION             the handshake value it was built for (gitignored)
```

## Building

You need Rust (https://rustup.rs). Then:

```
npm run build:native      cargo build --release -p tm-node, copy the library to native/prebuilt/<platform>-<arch>/treemap_core.node, write VERSION beside it, print the path
npm run test:native       cargo test --workspace (the Rust suites; the one-minute gate holds are #[ignore]d)
```

`scripts/build-native.js` runs cargo in `native/treemap-core` with cargo's own
target directory (`native/treemap-core/target`, or `CARGO_TARGET_DIR` when set)
and copies `libtm_node.dylib` / `libtm_node.so` / `tm_node.dll` from
`<target>/release/`. Without cargo it exits 1 with the install hint. Both
`native/prebuilt/` and the target directory are gitignored: nothing built is
ever committed.

Users never build anything. CI (`.github/workflows/test.yml`) builds the
module on every leg — macOS, Windows, Linux — after `cargo fmt --check`,
`cargo clippy --workspace --all-targets -- -D warnings` and `cargo test`, and
the release workflow builds it before `electron-builder`. `package.json`'s
`build.files` and `build.asarUnpack` both carry `native/prebuilt/**`, so the
bundle ships the module and Electron's `process.dlopen` redirect finds it in
`app.asar.unpacked` rather than inside the archive, which a dynamic loader
cannot open.

For iterating, a debug build is enough: `cargo build -p tm-node`, copy
`target/debug/libtm_node.dylib` (or `.so` / `.dll`) to any file named
`treemap_core.node`, and set `TREEMAP_NATIVE_MODULE` to that path. The loader
tries that path first, and `tests/nativeLoader.test.ts` uses it instead of
building. The name matters: Node only `dlopen`s a `.node` file.

The Phase 2 gate — the governor holding 25, 50 and 90 percent of this machine
for a minute each — is
`cargo test --release -p tm-governor --test hold -- --ignored --test-threads=1 --nocapture`
in the Rust suite and `npm run bench -- governor --preset=eco|balanced|turbo --seconds=60 --record`
through the module (see `bench/README.md`).

## The version handshake

Three numbers must agree: `nativeVersion` in `package.json`, the workspace
version in `native/treemap-core/Cargo.toml`, and what the module's `version()`
returns (the crate version, so the second and third cannot differ).

* `scripts/build-native.js` refuses to build when `package.json` and
  `Cargo.toml` disagree, naming both.
* `src/services/scan/native.ts` refuses to load a module whose `version()` is
  not `nativeVersion`, naming both, and the app runs without it.

Bump them together whenever the module's surface changes — that is, whenever
`native/index.d.ts` changes shape — so a prebuilt from an older contract can
never answer for a newer one.

## The fallback

`loadNative()` (`src/services/scan/native.ts`) tries, in order:

1. `TREEMAP_NATIVE_MODULE`, when set — and then nothing else: the variable
   is exclusive, so pointing it at a path that is not there forces the legacy
   engines (the reason names that path) and never falls through to a prebuilt;
2. `native/prebuilt/<platform>-<arch>/treemap_core.node` under the app root;
3. `<process.resourcesPath>/native/treemap_core.node` (an Electron layout).

It never throws. The outcome is decided once per process and cached: either
`{ available: true, module, version, path }` or `{ available: false, reason }`
with every candidate's reason joined — the file is not there for this
platform, `dlopen` refused it, it is not TreeMap's module, or its version is
not the one expected. Without the module `src/services/engineBudget.ts`
reports `source: 'node-shim'`, holds the budget with fixed duties and worker
caps as far as Node allows, and `GET /api/engine/capabilities` lists every
mechanism as unavailable with that reason. Nothing is guessed: a number the
core did not measure is not shown.

## What the module exports

The declaration is `native/index.d.ts`; `src/services/engineBudget.ts`
imports its types rather than re-declaring them. Every shape is the Rust type
serialised through serde with `rename_all = "camelCase"`: enums as lower-case
strings, `Option` as `null`, shares as fractions of the whole machine (0..1).

| Export | What it does |
| --- | --- |
| `version()` | the crate version, for the handshake |
| `governorCapabilities()` | the seven mechanisms (`qos`, `ioPolicy`, `priority`, `thermal`, `battery`, `interaction`, `machineCpu`), each `{ available, mechanism, reason }`; probed, never applied |
| `governorConfigure(budget, auto)` | sets the budget live: `{ preset: 'eco' \| 'balanced' \| 'turbo', cpuPercent?: 1..100 \| null }`; `auto` means Balanced that flips to Eco on battery or under serious heat; a bad budget throws and the one in force stays |
| `governorSnapshot()` | the Rust `Snapshot`: budget, effective preset, `targetShare`, `share1s`, `workers`, `duty`, thermal, battery, interaction, `machineBusyShare`, `paused`, `ticks`, the mechanisms last applied |
| `governorPause()` / `governorResume()` | block and release the workers; a thermal pause is the governor's own and stays |
| `governorHold(targetPercent, seconds)` | test-only: holds a percent of the machine with a synthetic load and resolves with the Rust `HoldReport` in shares |
| `scanProbe(root)` | `{ fastPath, reason }`: opens and lists `root` once with this platform's listing (`bulk` on macOS; `unavailable` with the reason on a file, a root that cannot be read, or a platform whose listing is not built yet); never throws |
| `scanStart(root, opts)` | starts a walk on `tm-walk`'s own threads, governed by the same process-wide governor, and returns a handle; `opts` is `{ neverDescend: string[], wantAtime: boolean, maxWorkers?: number, bufferBytes?: number }` (0 or absent lets the hill-climber decide); refuses a root that is not a folder or cannot be read with Node's errno spelling in front (`ENOENT: …`), and a platform without a listing |
| `scanPoll(handle)` | `{ done, error, entries, dirs, files, bytes, currentPath }` from the walk's atomics — no callback, no `ThreadsafeFunction` (decision P3-1); once done, how the walk ended is in `error` |
| `scanPause(handle)` / `scanResume(handle)` | stop the workers at their next check (between directories and every 256 entries inside one) and let them go on; nothing is re-listed |
| `scanCancel(handle)` | ends the walk; `scanTake` then throws the cancellation and frees the handle |
| `scanTake(handle)` | the columns (`WalkResult` in `native/index.d.ts`): typed arrays created from the Rust vectors without copying, the hard-link and refusal side tables, and the stats; frees the handle; throws in plain English when the walk failed or was cancelled (freeing it too) or when the handle is unknown |

The governor is one per process, started lazily on the first call with this
machine's sampler and signals, at the Automatic budget (the app's default);
the app configures it on every settings load. A walk obeys that same governor:
every worker calls its throttle after each directory and re-reads its worker
limit between directories, so the Scanning budget bounds the native engine
exactly as it bounds the legacy ones.

## The native walker (Phase 3)

`src/services/scan/nativeEngine.ts` drives a scan: `scanStart`, then
`scanPoll` from 1 ms doubling up to 100 ms (so a scan of a few dozen entries
settles in a couple of milliseconds and a long one is polled at the SSE
cadence), `scanPause`/`scanResume` the instant the Phase 2 pause gate closes
or opens (the scan's `Pausable`), `scanCancel` on the record's cancel flag,
then `scanTake` and an ingest into the same `PackedScanStore` every engine
writes, through the same `statToInput` (`src/services/scan/nodeInput.ts`).
The columns are in discovery order with every parent before its children;
the ingest emits each directory's children byte-sorted by name off Windows,
because libuv's `scandir` sorts the legacy walker's listing that way while
`getattrlistbulk` returns APFS's own hash order — with that, the JSON the app
emits is byte-identical to the walker's on the same tree
(`tests/nativeEngine.test.ts`). `cpuSeconds` is the walk's own thread CPU
(`CLOCK_THREAD_CPUTIME_ID`) plus the ingest's `process.cpuUsage()` delta, or
null where the platform has no thread clock — never zero.

A handle that is never taken is freed when the process exits; `scanTake` on
an unknown handle throws.

A hold replaces only the ceiling — the configured preset, and with it the QoS
class and I/O policy the OS gives the workers, stays what it was — and hands
the budget back when it ends, unless the app reconfigured meanwhile (then the
newer budget stays). A second hold while one runs is refused, as is a target
outside 1..100 percent or a length outside 1..600 seconds, by rejection with a
message. The report's `target` is the share the governor was holding when the
hold began: the target asked for, scaled by 0.7 while the user is interacting
(Eco and Balanced) and by 0.5 under serious heat. The bench refuses a report
whose target is not the one it asked for, so run the gate on a quiet machine
you are not touching.

## Threads

`governorHold` is a napi `AsyncTask`, so its `compute` runs on libuv's thread
pool (four threads by default). That is acceptable for a test-only measurement
of a few seconds — one pool thread is busy for the hold's length, and Node's
own file work shares the rest — and it is not how a scan runs: a walk runs on
`tm-walk`'s own threads (`tm-walk-driver` and `tm-walk-worker-N`, up to the
governor's limit) and Node reads its atomics through `scanPoll`, so libuv's
pool and the event loop are never in the walk's path. The governor's tick
thread is `tm-governor-tick`, the synthetic workers are `tm-governor-load-N`.

## Safety and lints

`tm-node` contains no `unsafe`. Every export is `#[napi(catch_unwind)]`, and
the hold's `compute` wraps the governor the same way, because libuv calls it
through an `extern "C"` boundary that a panic must never cross; a caught panic
becomes a JavaScript error with its message. The workspace lints deny
`unwrap`, `expect`, `panic`, `indexing_slicing`, `todo`, `unimplemented` and
`unreachable`, and `clippy::pedantic` is on. Nothing in this workspace touches
a GPU.

Windows and Linux are compile-checked here with
`cargo check --target x86_64-pc-windows-msvc` and
`cargo check --target x86_64-unknown-linux-gnu` and built for real by CI.
`napi-build` adds the linker arguments a Node addon needs on each platform;
napi-rs resolves the N-API symbols from the host at load, so no `node.lib` is
needed on Windows.
