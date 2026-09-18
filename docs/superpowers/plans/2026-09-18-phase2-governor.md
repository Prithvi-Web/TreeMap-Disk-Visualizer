# Phase 2 — The resource governor, the native workspace, and the budget the app obeys

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

## Progress (kept current so a context compaction loses nothing — 18 Sep 2026, 14:40)

Owner's answers recorded in DESIGN.md §0: fresh core (no mobile code), D6–D9 approved, crates download approved. Work is on `main`, unpushed.

| Task | State | Evidence |
| --- | --- | --- |
| Workspace skeleton + crates fetched | committed `2d55883` | `native/treemap-core/Cargo.lock` |
| Loader `src/services/scan/native.ts` + `tests/nativeLoader.test.ts` | committed `cbc78e2`, `4254d32` | 5/5, handshake mutant red |
| CI (`test.yml`, `release.yml`) + `SECURITY.md` names the module | committed `6e42e37` | releasePipeline 42/42, polishDocs 19/19 |
| Task 6 UI (Settings row, Dashboard note) | committed `ef6ba6d` | `tests/engineBudgetUi.test.ts` 11/11 |
| Task 7 bench governor suite | committed `d633d54` | `tests/benchGovernor.test.ts` 10/10 |
| Task 1 + 3 (preset, controller, governor, loadgen, gate) | **in flight** — the implementer was killed by a usage limit after writing `tests/controller.rs`, then resumed; `lib.rs` is still the placeholder | watch `crates/tm-governor/src/{preset,controller,governor,loadgen}.rs` appear |
| Task 2 (sample, signals, enforce) | **in flight** — files written (525/404/708 lines + `tests/platform.rs`), not yet compiled; resumed, waits for Task 1's `controller.rs` | |
| Task 5 (engineBudget service, routes, walker shim, golden re-record, scheduler, electron) | **in flight** — tests written, service half-written, `types.ts` edited; resumed | uncommitted files under `src/services/engineBudget.ts`, `tests/engine*.test.ts`, `tests/fixtures/engineBudgetChild.ts` |
| Task 4 (tm-node napi bindings, `scripts/build-native.js`, `native/index.d.ts`, `native/README.md`, package.json scripts `build:native`/`test:native`) | **not started** — needs the crate to compile | then package.json `build.files` + `asarUnpack` gain `native/prebuilt/**` |
| After all tasks | review fleet (ECC reviewers + adversaries incl. a Rust reviewer), fix round, mutants, full gate (`npm run typecheck`, `npm test`, `cargo test`, cross-target checks), `npm run bench -- governor --preset=eco|balanced|turbo --seconds=60 --record` ×3 on a quiet machine, HANDOFF Session 16 addendum, preview server (`preview_start` name `treemap`, http://127.0.0.1:4280) left running for the owner, check-in | |

Unit decision for Task 4: `governorHold(targetPercent, seconds)` takes percent and returns the report in SHARES (0..1) exactly as the Rust `HoldReport`; the bench suite accepts either and verifies `target`.

**Goal:** the app has a user-selectable resource budget (Eco / Balanced / Turbo, plus a numeric override) that a native Rust governor holds within ±5 percentage points of machine CPU using real OS mechanisms and a closed loop; the legacy engines obey it as far as Node allows; the setting, the live state and the machine's mechanisms are visible through the API and a Settings row; and the whole thing degrades to the legacy behaviour with a stated reason when the native module cannot load.

**Architecture:** `native/treemap-core/` is a Cargo workspace (edition 2024, Rust ≥ 1.85, the strict lint set already in its `Cargo.toml`). `tm-governor` is pure Rust with platform modules behind `cfg`; `tm-node` is the only napi crate. `scripts/build-native.js` builds the release library and copies it to `native/prebuilt/<platform>-<arch>/treemap_core.node`; `src/services/scan/native.ts` loads it with a version handshake and falls back with a reason. `src/services/engineBudget.ts` owns the setting and drives either the native governor or the Node shim. Every measured pass of the gate (25/50/90 held for 60 s) is recorded by `npm run bench -- governor`.

**Tech stack:** Rust 1.97 (`cargo`), napi 3.4 / napi-derive 3.3 / napi-build 2.2 (already in `native/treemap-core/Cargo.lock`), objc2-foundation 0.3 (macOS thermal state), windows-sys 0.61, libc 0.2; TypeScript strict, node:test through tsx; the existing `bench/` harness.

**House rules that bind every task:** test first and watch it fail; one recorded mutant per new behaviour (assert the anchor count inside the mutation step); `cargo fmt` clean and `cargo clippy --workspace --all-targets -- -D warnings` clean; every `unsafe` block carries a `// SAFETY:` comment; no `unwrap`/`expect`/`panic` in shipped code (the lint set denies them); Windows and Linux code paths are compile-checked with `cargo check --target x86_64-pc-windows-msvc` and `cargo check --target x86_64-unknown-linux-gnu` (both targets are installed; check needs no linker); never run the whole Node suite (`npm test`) — only your own test files; Rust workers use their own `CARGO_TARGET_DIR` under the session scratchpad so concurrent builds never share a target directory; never touch the owner's real folders; the app must never print a number it did not measure — a mechanism that is unavailable says so.

---

## File structure

| File | Responsibility | Task |
| --- | --- | --- |
| `native/treemap-core/crates/tm-governor/src/lib.rs` | public surface: re-exports, `Preset`, `Budget`, `profile()` | 1 |
| `.../tm-governor/src/preset.rs` | the preset table (ceiling, I/O class, QoS class, worker range, interaction scale) | 1 |
| `.../tm-governor/src/controller.rs` | the pure closed loop: `Controller`, `Sample`, `Decision`, `Thermal` | 1 |
| `.../tm-governor/src/sample.rs` | `CpuSampler` trait, `platform_sampler()`, `FakeSampler`; own CPU via `getrusage`/`GetProcessTimes`; machine CPU via `host_statistics64` / `GetSystemTimes` / `/proc/stat` | 2 |
| `.../tm-governor/src/signals.rs` | `Signals` trait: thermal (NSProcessInfo / `/sys/class/thermal` / none), battery (IOKit `IOPSGetTimeRemainingEstimate` / `GetSystemPowerStatus` / `/sys/class/power_supply`), user interaction (CoreGraphics `CGEventSourceSecondsSinceLastEventType` / `GetLastInputInfo` / none); `FakeSignals` | 2 |
| `.../tm-governor/src/enforce.rs` | `apply_to_current_thread(preset)` (QoS, I/O policy, priority per platform) and `capabilities()` (probes, no side effects) | 2 |
| `.../tm-governor/src/governor.rs` | `Governor`: the 100 ms ticking thread, shared state, `throttle()`, `worker_limit()`, pause/resume, `configure()`, `snapshot()`, the auto-Eco rule | 3 |
| `.../tm-governor/src/loadgen.rs` | `SyntheticLoad` (spinning workers that obey the governor) and `hold()` — the gate measurement | 3 |
| `.../tm-governor/tests/*.rs` | simulation tests (Task 1), platform tests (Task 2), the held-band gate as `#[ignore]` 60 s tests plus a 10 s default (Task 3) | 1–3 |
| `.../tm-node/src/lib.rs` | napi exports (`version`, `governorCapabilities`, `governorConfigure`, `governorSnapshot`, `governorPause/Resume`, `governorHold`) | 4 |
| `native/index.d.ts` | the hand-written TypeScript declaration of the module | 4 |
| `native/README.md` | how to build, where prebuilds go, the version handshake, the fallback | 4 |
| `scripts/build-native.js` | `cargo build --release -p tm-node`, copy to `native/prebuilt/<platform>-<arch>/treemap_core.node`, write `native/prebuilt/<...>/VERSION` | 4 |
| `src/services/scan/native.ts` | `loadNative()` → `{ module, version, path } \| { available: false, reason }`; handshake against `package.json` `nativeVersion` | 4 |
| `src/services/engineBudget.ts` | the budget setting, the effective preset (auto → Eco on battery/thermal), the native governor or the Node shim, `budgetSnapshot()`, `throttleBatch()`, `workerCap()`, gdu child priority | 5 |
| `src/services/settings.ts`, `src/models/types.ts` | `engineBudget: { preset: 'auto'\|'eco'\|'balanced'\|'turbo'; cpuPercent: number \| null }` | 5 |
| `src/api/engineRoutes.ts` | `GET /api/engine/capabilities`, `GET /api/engine/budget`, `PUT /api/engine/budget`, `POST /api/scan/:id/pause`, `POST /api/scan/:id/resume` | 5 |
| `src/api/openapi.ts`, `src/api/scanRoutes.ts` (`buildScanStats` gains `budget`), `tests/fixtures/golden/responses.json` (re-recorded) | the additive API change D6 approved | 5 |
| `src/services/diskScanner.ts` (walker: throttle per batch, pause flag, worker cap), `src/services/gduScanner.ts` (`os.setPriority` on shards, SIGSTOP/SIGCONT pause on POSIX), `src/services/scheduler.ts` (scheduled scans run Eco), `electron/main.js` (powerMonitor suspend → pause, resume → resume) | the legacy engines obey the budget | 5 |
| `src/ui/markup/…settings…`, `src/ui/app/235-settings-modal.js`, `src/ui/manifest.json` | the Settings row "Scanning budget" with the three presets and one plain-language line each; the Dashboard engine note shows the effective budget | 6 |
| `bench/lib/governorSuite.ts`, `bench/run.ts` (`governor` command), `bench/README.md` | `npm run bench -- governor [--preset=eco\|balanced\|turbo] [--seconds=60]` records the held share series and passes only inside ±5 points | 7 |
| `.github/workflows/test.yml`, `release.yml`, `package.json` (`build:native`, `test:native`) | Rust on every CI leg: fmt, clippy, `cargo test`, `npm run build:native`, cross-target checks; prebuilds on the release legs | 8 |

---

## The public interfaces (fixed here so the tasks can run in parallel)

```rust
// tm-governor — lib.rs re-exports everything below.
pub enum Preset { Eco, Balanced, Turbo }
pub struct Budget { pub preset: Preset, pub cpu_percent: Option<u8> } // 1..=100 overrides the ceiling
pub enum IoClass { Throttle, Utility, Normal }
pub enum QosClass { Background, Utility, UserInitiated }
pub struct PresetProfile { pub preset: Preset, pub cpu_ceiling: f64, pub io: IoClass, pub qos: QosClass, pub min_workers: u32, pub max_workers: u32, pub interaction_scale: f64 }
pub fn profile(preset: Preset, cores: u32, cpu_percent: Option<u8>) -> PresetProfile
//   Eco: ceiling 0.25, Throttle, Background, workers 1..=min(2, cores), scale 0.7
//   Balanced: 0.50, Utility, Utility, 1..=max(1, cores/2), 0.7
//   Turbo: 0.90, Normal, UserInitiated, 1..=cores, 1.0 (still yields; thermal still applies)
//   cpu_percent replaces the ceiling (clamped 0.01..=1.0) and leaves the rest of the preset.

pub enum Thermal { Nominal, Fair, Serious, Critical, Unknown }
pub struct Sample { pub interval_s: f64, pub own_cpu_s: f64, pub machine_busy_share: Option<f64>, pub thermal: Thermal, pub on_battery: Option<bool>, pub interacting: Option<bool> }
pub struct Decision { pub target_share: f64, pub workers: u32, pub duty: f64, pub paused_for_thermal: bool, pub share_measured: f64 }
pub struct Controller { /* private */ }
impl Controller {
    pub fn new(profile: PresetProfile, cores: u32) -> Self;
    pub fn set_profile(&mut self, profile: PresetProfile);
    pub fn step(&mut self, sample: &Sample) -> Decision;   // called every tick (100 ms nominal; interval_s is the truth)
    pub fn decision(&self) -> Decision;
}
// Controller rules: share = own_cpu_s / (interval_s × cores), smoothed EMA α=0.3; target = ceiling,
// ×0.5 when thermal is Serious, paused when Critical, ×interaction_scale when interacting;
// PI on duty (Kp 1.5, Ki 0.3 per tick, anti-windup, clamp 0.05..=1.0); workers start at
// max_workers; after 20 consecutive ticks with duty < 0.25 and workers > min, drop one worker
// and rescale duty; after 20 ticks with duty ≥ 0.98 and share < target − 0.05 and workers < max,
// add one worker and rescale duty. Every constant is a named const with its unit.

pub trait CpuSampler: Send { fn own_cpu_seconds(&mut self) -> f64; fn machine_busy_share(&mut self) -> Option<f64>; fn cores(&self) -> u32; }
pub fn platform_sampler() -> Box<dyn CpuSampler>;
pub struct FakeSampler { /* scripted */ }   // new(cores), push_cpu(seconds), set_machine(share)

pub trait Signals: Send { fn thermal(&mut self) -> Thermal; fn on_battery(&mut self) -> Option<bool>; fn interacting(&mut self) -> Option<bool>; }
pub fn platform_signals() -> Box<dyn Signals>;
pub struct FakeSignals { pub thermal: Thermal, pub on_battery: Option<bool>, pub interacting: Option<bool> }

pub struct Mechanism { pub available: bool, pub mechanism: String, pub reason: Option<String> }
pub struct Capabilities { pub qos: Mechanism, pub io_policy: Mechanism, pub priority: Mechanism, pub thermal: Mechanism, pub battery: Mechanism, pub interaction: Mechanism, pub machine_cpu: Mechanism }
pub fn capabilities() -> Capabilities;                 // probes only, never changes the calling thread
pub struct EnforceReport { pub qos: Mechanism, pub io: Mechanism, pub priority: Mechanism }
pub fn apply_to_current_thread(profile: &PresetProfile) -> EnforceReport;

pub struct Snapshot { pub budget: Budget, pub effective: Preset, pub target_share: f64, pub share_1s: f64, pub workers: u32, pub duty: f64, pub thermal: Thermal, pub on_battery: Option<bool>, pub interacting: Option<bool>, pub paused: bool, pub ticks: u64, pub mechanisms: EnforceReport }
pub struct Governor { /* Arc<inner> — Clone */ }
impl Governor {
    pub fn start(budget: Budget, auto: bool, sampler: Box<dyn CpuSampler>, signals: Box<dyn Signals>) -> Governor;   // spawns the 100 ms tick thread
    pub fn configure(&self, budget: Budget, auto: bool);   // live; auto=true means Balanced that flips to Eco on battery or thermal Serious+
    pub fn throttle(&self);        // workers call it after each unit of work: sleeps (1−duty)/duty × elapsed-since-last-call, capped at 1 s; blocks while paused
    pub fn worker_limit(&self) -> u32;
    pub fn pause(&self);  pub fn resume(&self);
    pub fn snapshot(&self) -> Snapshot;
    pub fn stop(&self);            // stops the tick thread; idempotent
}

pub struct HoldReport { pub target: f64, pub samples: Vec<f64>, pub mean: f64, pub mean_last_half: f64, pub p95_abs_error: f64, pub within_band: bool /* |mean_last_half − target| ≤ 0.05 */, pub workers_final: u32, pub duty_final: f64 }
pub fn hold(governor: &Governor, seconds: f64, sampler: &mut dyn CpuSampler) -> HoldReport;   // spins `worker_limit()` threads that call throttle(); samples the share every 100 ms independently of the governor's own sampler
```

```ts
// native/index.d.ts — what tm-node exports
export function version(): string;
export function governorCapabilities(): { qos: Mechanism; ioPolicy: Mechanism; priority: Mechanism; thermal: Mechanism; battery: Mechanism; interaction: Mechanism; machineCpu: Mechanism };
export function governorConfigure(budget: { preset: 'eco' | 'balanced' | 'turbo'; cpuPercent?: number | null }, auto: boolean): void;
export function governorSnapshot(): Snapshot;          // fields as the Rust Snapshot, camelCase, enums as lower-case strings
export function governorPause(): void;
export function governorResume(): void;
export function governorHold(targetPercent: number, seconds: number): Promise<HoldReport>;   // runs on a Rust thread, never the libuv pool
export interface Mechanism { available: boolean; mechanism: string; reason: string | null }
```

---

### Task 1: presets and the pure controller (Rust)

**Files:** Create `crates/tm-governor/src/preset.rs`, `controller.rs`, replace `lib.rs`; Test `crates/tm-governor/tests/controller.rs`

- [ ] **Step 1: failing tests** (a `SimulatedEngine` in the test: `share = workers × duty × per_worker_share + noise`, `per_worker_share = 1/cores`, noise ±0.02 from a seeded LCG; a `run(controller, engine, ticks)` loop feeding `Sample { interval_s: 0.1, own_cpu_s: share × 0.1 × cores, ... }`)

```rust
#[test] fn eco_holds_a_quarter_on_eight_cores()      // 600 ticks, mean of the last 300 within ±0.05 of 0.25; workers ≤ 2
#[test] fn balanced_holds_half_on_eight_cores()
#[test] fn turbo_holds_ninety_percent_on_eight_cores()
#[test] fn eco_holds_a_quarter_on_two_cores()        // 0.25 of 2 cores = one worker at duty 0.5; workers must reach 1
#[test] fn serious_thermal_halves_the_target()       // after 200 ticks flip Thermal::Serious: mean settles near 0.125 for Eco… use Balanced: 0.25
#[test] fn critical_thermal_pauses()                  // decision.paused_for_thermal, duty irrelevant
#[test] fn interaction_scales_every_preset_but_turbo()
#[test] fn a_numeric_override_replaces_the_ceiling()  // cpu_percent 40 on Balanced → target 0.40
#[test] fn workers_drop_when_duty_stays_low_and_return_when_saturated()
#[test] fn the_preset_table_is_the_prompts_table()    // ceilings 0.25/0.5/0.9, worker ranges, IoClass/QosClass per preset for cores 2, 4, 8, 16
#[test] fn every_decision_is_clamped()                // duty in 0.05..=1, workers in min..=max, target in 0..=1, for random samples incl. NaN/negative CPU
```

- [ ] **Step 2: run** `cargo test -p tm-governor --test controller` → FAIL (types missing)
- [ ] **Step 3: implement** `preset.rs`, `controller.rs` exactly to the interface above; every constant named (`TICK_NOMINAL_S`, `SHARE_EMA_ALPHA`, `KP_PER_TICK`, `KI_PER_TICK`, `DUTY_MIN`, `DUTY_MAX`, `WORKER_DROP_DUTY`, `WORKER_ADD_DUTY`, `WORKER_CHANGE_TICKS`, `THERMAL_SERIOUS_SCALE`, `SHARE_MARGIN`); a NaN or negative `own_cpu_s` is treated as 0 and counted in `Decision`… no: sanitise to 0 and expose nothing false — document in the doc comment.
- [ ] **Step 4: run → PASS; `cargo clippy -p tm-governor --all-targets -- -D warnings` clean; `cargo fmt --check` clean.**
- [ ] **Step 5: mutants** — (a) set `THERMAL_SERIOUS_SCALE = 1.0` → the thermal test goes red; (b) remove the worker-drop rule → the two-core test goes red; (c) swap Kp's sign → every hold test goes red. Restore; `git diff --stat` shows only your files.
- [ ] **Step 6: commit** `native(governor): presets and the closed loop, proven in simulation`

### Task 2: platform sampling, signals, enforcement (Rust)

**Files:** Create `crates/tm-governor/src/sample.rs`, `signals.rs`, `enforce.rs`; Test `crates/tm-governor/tests/platform.rs`

- [ ] **Step 1: failing tests**

```rust
#[test] fn proc_stat_busy_share_is_parsed_from_two_readings()          // pure parser: fixture strings → busy share; a garbled line → None
#[test] fn linux_power_supply_status_is_parsed()                        // "Discharging" → Some(true), "Charging"/"Full" → Some(false), missing → None
#[test] fn linux_thermal_zone_temperatures_map_to_states()             // pure: 45 °C → Nominal, 85 → Serious, 95 → Critical, unreadable → Unknown (thresholds named consts)
#[test] fn the_platform_sampler_reports_this_machines_cores_and_advances() // live: cores == available_parallelism; own_cpu grows after a 50 ms spin; machine share in 0..=1 or None with a reason
#[test] fn capabilities_never_change_the_calling_thread()               // live: read QoS/priority before and after capabilities(); equal
#[test] fn apply_to_current_thread_reports_what_it_did()                // live on macOS: qos.available true and mechanism names pthread_set_qos_class_self_np; io.available true (setiopolicy_np); each Mechanism unavailable elsewhere carries a reason
#[test] fn signals_are_never_a_confident_guess()                        // live: thermal ∈ {Nominal, Fair, Serious, Critical} on macOS else Unknown; on_battery is Some on macOS/Windows/Linux-with-a-battery else None
```

- [ ] **Step 2: run → FAIL. Step 3: implement.** macOS: own CPU `libc::getrusage(RUSAGE_SELF)`; machine CPU `host_statistics64(mach_host_self(), HOST_CPU_LOAD_INFO)` via `libc` (declare the struct and constants if `libc` lacks them, with `// SAFETY:`); thermal `objc2_foundation::NSProcessInfo::processInfo().thermalState()`; battery `extern "C" { fn IOPSGetTimeRemainingEstimate() -> f64; }` linked with `#[link(name = "IOKit", kind = "framework")]` — `-2.0` means on AC (`kIOPSTimeRemainingUnlimited`), anything else on battery; interaction `extern "C" { fn CGEventSourceSecondsSinceLastEventType(source: u32, event_type: u32) -> f64; }` from CoreGraphics with `kCGEventSourceStateCombinedSessionState = 0` and `kCGAnyInputEventType = !0u32`, interacting = seconds < 2.0 (named const); QoS `pthread_set_qos_class_self_np`; I/O `setiopolicy_np(IOPOL_TYPE_DISK, IOPOL_SCOPE_THREAD, class)`; priority: none needed beyond QoS (report the mechanism as "QoS carries priority on macOS"). Windows (`windows-sys`, compile-checked only): `GetProcessTimes`, `GetSystemTimes`, `GetSystemPowerStatus`, `GetLastInputInfo`, `SetThreadPriority(THREAD_MODE_BACKGROUND_BEGIN)` for Eco / `THREAD_PRIORITY_BELOW_NORMAL` for Balanced, `SetThreadInformation(ThreadPowerThrottling)` for Eco; thermal Unknown with the reason "Windows exposes no thermal state to user processes". Linux: `getrusage`, `/proc/stat`, `/sys/class/thermal/thermal_zone*/temp`, `/sys/class/power_supply/*/status`, `ioprio_set` via `libc::syscall(SYS_ioprio_set, IOPRIO_WHO_PROCESS, 0, class<<13|level)`, `setpriority`, `sched_setscheduler(SCHED_BATCH)`; interaction None with the reason "no portable input-idle source on Linux". Every unavailable mechanism is a `Mechanism { available: false, reason: Some(...) }`, never a silent default.
- [ ] **Step 4: run → PASS on macOS; `cargo check -p tm-governor --target x86_64-pc-windows-msvc` and `--target x86_64-unknown-linux-gnu` clean; clippy and fmt clean.** **Step 5: mutants** — the `/proc/stat` parser returns idle instead of busy (red); `-2.0` treated as on battery (red on the live macOS battery test only if on AC — instead unit-test the pure mapping `ac_from_estimate(f64)`). **Step 6: commit** `native(governor): the machine's own numbers and the OS mechanisms that hold a budget`

### Task 3: the governor, the synthetic load, the gate (Rust)

**Files:** Create `crates/tm-governor/src/governor.rs`, `loadgen.rs`; Test `crates/tm-governor/tests/governor.rs`, `tests/hold.rs`

- [ ] **Step 1: failing tests** — `governor.rs`: `throttle()` sleeps in proportion to the duty the controller chose (FakeSampler scripted to a share above target → duty falls → a spin loop's measured cadence slows); `pause()` blocks `throttle()` within 200 ms and `resume()` releases it; `configure()` takes effect on the next tick; auto mode flips Balanced → Eco when `FakeSignals.on_battery = Some(true)` or thermal ≥ Serious and back; `snapshot()` reports the effective preset, the last-second share and the mechanisms applied; `stop()` ends the thread (join within 500 ms). `hold.rs`: `#[test] fn holds_ten_percent_of_this_machine_for_ten_seconds()` (default, runs in CI: target 0.10 avoids saturating a 2-vCPU runner; band ±5 points); `#[ignore]` tests `holds_eco_for_sixty_seconds`, `holds_balanced_for_sixty_seconds`, `holds_turbo_for_sixty_seconds` — the Phase 2 gate, run explicitly with `cargo test --release -p tm-governor --test hold -- --ignored --test-threads=1`, each asserting `within_band` and printing the sample series.
- [ ] **Step 2: run → FAIL. Step 3: implement** the tick thread (`std::thread`, 100 ms cadence measured with `Instant`, never assumed), shared state in `Arc<Mutex<State>>` plus atomics for the hot path (`AtomicU32` workers, `AtomicU32` duty×10_000, `AtomicBool` paused, a `Condvar` for pause), the workers' `throttle()` with per-thread last-call `Instant` in a `thread_local!`, `apply_to_current_thread(profile)` called by every worker on its first `throttle()` and again after `configure()`; the independent sampler in `hold()`.
- [ ] **Step 4: run → PASS; the three ignored gate tests run once on this machine with their series pasted into the commit message; clippy, fmt, cross-target checks clean. Step 5: mutants** — `throttle()` never sleeps → the cadence test and the 10 s hold go red; auto mode ignores battery → red. **Step 6: commit** `native(governor): the governor holds 25, 50 and 90 percent of this machine for 60 seconds (series in the message)`

### Task 4: the napi module, the build, the loader (Rust + Node)

**Files:** Replace `crates/tm-node/src/lib.rs`; Create `native/index.d.ts`, `native/README.md`, `scripts/build-native.js`, `src/services/scan/native.ts`; Modify `package.json` (`nativeVersion`, scripts `build:native`, `test:native`), `.gitignore` (`/native/prebuilt/`, `/native/treemap-core/target/`); Test `tests/nativeLoader.test.ts`

- [ ] **Step 1: failing tests** — `loadNative()` on a path that does not exist returns `{ available: false, reason }` naming the path and the platform; on a file that is not a module returns a reason from `dlopen`; a version mismatch (stub the module's `version()` through an injected loader) is refused with both versions in the reason; when `native/prebuilt/<platform>-<arch>/treemap_core.node` exists (build it first in the test with `scripts/build-native.js` — skipped with a reason if `cargo` is absent) `loadNative()` returns the module, `version()` equals `package.json`'s `nativeVersion`, `governorCapabilities()` returns seven mechanisms each `{ available, mechanism, reason }`, `governorSnapshot()` after `governorConfigure({ preset: 'eco' }, false)` reports `effective: 'eco'` and a `targetShare` of 0.25, and `governorHold(10, 2)` resolves with `samples.length ≈ 20` and a `mean` within ±10 points (a two-second smoke, not the gate).
- [ ] **Step 2: run → FAIL. Step 3: implement.** `tm-node`: `#[napi]` functions over a process-wide `OnceLock<Governor>` started lazily with `platform_sampler()`/`platform_signals()`; `governorHold` as an `AsyncTask` whose `compute` runs `hold()` — read `napi`'s fetched source under `~/.cargo/registry/src/*/napi-3.4.0/` to confirm the 3.x `Task` trait shape (`type Output`, `type JsValue`, `compute`, `resolve`) before writing it, and note in `native/README.md` that `AsyncTask` runs on the libuv pool, which is acceptable for a test-only measurement but not for a scan (Phase 3 uses a dedicated thread plus a `ThreadsafeFunction`). `scripts/build-native.js`: `cargo build --release -p tm-node` with `cwd: native/treemap-core`, copy `target/release/libtm_node.{dylib,so}` / `tm_node.dll` to `native/prebuilt/<process.platform>-<process.arch>/treemap_core.node`, write `VERSION` beside it, print the path; refuse when `cargo` is missing with the install hint. `src/services/scan/native.ts`: `loadNative(opts?: { path?: string; expectedVersion?: string; requireModule?: (p: string) => unknown })`; candidates in order: `TREEMAP_NATIVE_MODULE` env, `<repo>/native/prebuilt/<platform>-<arch>/treemap_core.node`, `process.resourcesPath/native/treemap_core.node` (Electron); the result is cached per process; a failed load is remembered with its reason. Never throws.
- [ ] **Step 4: run → PASS (`npm run build:native` first); `npm run typecheck` clean. Step 5: mutant** — the version handshake accepts a mismatch → red. **Step 6: commit** `native: the napi module, its build, and a loader that falls back with a reason`

### Task 5: the budget in the app (TypeScript)

**Files:** Create `src/services/engineBudget.ts`, `src/api/engineRoutes.ts`; Modify `src/services/settings.ts`, `src/models/types.ts`, `src/api/openapi.ts`, `src/api/scanRoutes.ts`, `src/server.ts` (mount), `src/services/diskScanner.ts`, `src/services/gduScanner.ts`, `src/services/scheduler.ts`, `electron/main.js`, `tests/fixtures/golden/responses.json`; Test `tests/engineBudget.test.ts`, `tests/engineRoutes.test.ts`, and the updated golden

- [ ] **Step 1: failing tests** — settings: `engineBudget` defaults to `{ preset: 'auto', cpuPercent: null }`; `PUT /api/settings` and `PUT /api/engine/budget` accept the four presets and `cpuPercent` 1–100 or null, reject anything else with 400 `BAD_SETTING`; `GET /api/engine/budget` returns `{ setting, effective: { preset, targetShare, source: 'native' | 'node-shim' }, native: { available, version, reason }, snapshot }`; `GET /api/engine/capabilities` returns the native status and the seven mechanisms (or `{ available: false, reason }` for each when native is absent); `GET /api/scan/:id/stats` gains `budget: { preset, effective, source }` (update `buildScanStats`, `openapi.ts`'s `ScanStats` with `budget` required, and re-record `tests/fixtures/golden/responses.json` — the commit message states why, per D6); the walker under `eco` on this machine keeps its process's CPU share (cpu delta / wall / cores, measured over a scan of a 20k-entry synthetic tree in a child process) at or under 0.30 and under `turbo` finishes faster than under `eco`; `POST /api/scan/:id/pause` makes `scanned` stop advancing within 200 ms and `resume` makes it advance again; a scheduled scan runs with `effective.preset === 'eco'` whatever the setting; gdu shards are started with `os.setPriority(pid, 10)` under Eco (assert through the `onSpawn` hook the scanner already has).
- [ ] **Step 2: run → FAIL. Step 3: implement.** `engineBudget.ts`: reads the setting, computes the effective preset (auto → balanced; → eco when the native governor reports `on_battery` or thermal ≥ serious; without native, auto → balanced with `source: 'node-shim'`), configures the native governor when loaded; exports `throttleBatch(): Promise<void>` (native: `governorSnapshot().duty` → sleep `(1−duty)/duty × elapsed` capped 1 s, measured per caller like the Rust `throttle`; shim: a fixed duty per preset — eco 0.25, balanced 0.5, turbo 1.0 — documented as best effort), `workerCap(): number` (native `snapshot.workers`, shim: the preset's range on `os.cpus().length`), `budgetSnapshot()`, `childPriority(): number` (eco 10, balanced 5, turbo 0), `pauseScan(scanId)`/`resumeScan(scanId)` (walker flag + gdu `SIGSTOP`/`SIGCONT` on POSIX, `{ supported: false, reason }` on Windows). diskScanner: `processDirectory` awaits `throttleBatch()` after each `STAT_BATCH` and awaits a `paused` promise; `CONCURRENCY` becomes `min(CONCURRENCY, workerCap())` read at scan start and re-read every 1,000 entries. Stats: `budget` from the scan record (captured at start). Scheduler: `startScan(root, { budget: 'eco' })`. Electron: `powerMonitor.on('suspend')` → pause every running scan, `'resume'` → resume them.
- [ ] **Step 4: run → PASS; `npm run typecheck`; `node scripts/build-ui.js --check` unaffected. Step 5: mutants** — the shim's eco duty set to 1.0 → the CPU-share test goes red; `buildScanStats` drops `budget` → the golden and the discoverability tests go red. **Step 6: commit** `feat(engine): the scanning budget — Eco, Balanced, Turbo — the app obeys, with or without the native governor`

### Task 6: the Settings row and the Dashboard note (UI)

**Files:** Modify the Settings markup part and `src/ui/app/235-settings-modal.js`, the Dashboard engine-note part; `src/ui/manifest.json` if a part is added; Test `tests/frontendContract.test.ts` additions (or a new `tests/engineBudgetUi.test.ts` that lifts the shipped functions)

- [ ] **Step 1: failing tests** — the built page contains a "Scanning budget" section with three labelled radio inputs (`eco`, `balanced`, `turbo`) and an "Automatic" default, each with one plain-language sentence, saved through the one `api()` wrapper to `PUT /api/engine/budget`; the Dashboard engine note shows `budget: Balanced` (or the effective preset) next to the engine name; no new script, style or font (the existing contract test proves it); the section is reachable from the ⌘K palette registry like the other Settings sections.
- [ ] **Step 2: run → FAIL. Step 3: implement** in the house style (sentence case, "folder" not "directory", no jargon). **Step 4: rebuild (`node scripts/build-ui.js`), run → PASS.** **Step 5: mutant** — the save handler posts to `/api/settings` instead → red. **Step 6: commit** `ui: the scanning budget in Settings, and the budget beside the engine name`

### Task 7: the governor suite in the harness

**Files:** Create `bench/lib/governorSuite.ts`; Modify `bench/run.ts` (`governor` command), `bench/README.md`; Test `tests/benchGovernor.test.ts`

- [ ] **Step 1: failing tests** — `runGovernor({ preset: 'eco', seconds: 2 })` returns a `BenchResult` with `suite: 'governor'`, `entriesUnit: 'samples'`, `correctness.ok === within ±5 points`, the series in the result; a missing native module gives `{ ok: false, notes: [reason] }`, never a fake series. (Extend `SuiteName`/`EntriesUnit` unions in `bench/lib/report.ts` and their validation.)
- [ ] **Step 2 → 6** as the pattern above; the 60 s runs for the three presets are recorded with `--record` as the Phase 2 gate evidence; commit `bench: the governor suite records the held bands`.

### Task 8: CI (done by the coordinator)

- [ ] `.github/workflows/test.yml`: after `npm ci`, `dtolnay/rust-toolchain@stable` with `Swatinem/rust-cache@v2` (`workspaces: native/treemap-core`), then `cargo fmt --check`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo test --workspace` (the ignored 60 s tests excluded), `npm run build:native`, and the existing `npm run typecheck` / `npm test` (the loader test now finds the module). `release.yml`: `npm run build:native` before `electron-builder`, `native/prebuilt/**` in `build.files` and `asarUnpack`. A leg that cannot build the module fails the run.

## Self-review

* Spec coverage: Section 8.1 presets (Task 1), 8.2 mechanisms per platform (Task 2), 8.3 closed loop (Task 1/3), 8.4 GPU policy (nothing here touches a GPU; stated in `native/README.md`), 8.5 pause/resume/scheduled-Eco/sleep (Task 5), Section 11.3 budget endpoints (Task 5), 11.4 budget selector (Task 6), 12.4 governor tests (Tasks 3, 5, 7), 12.5 CI (Task 8), 3.5 no toolchain for users (Task 4 loader + fallback), 4.2 engine selection reporting (`source` in the budget; the full engine chain is Phase 3).
* Types: `Snapshot`/`HoldReport` field names are the ones `tm-node` serialises and `native/index.d.ts` declares; `Mechanism` is the same shape in Rust, the `.d.ts` and the API.
