# Tauri 2 facts for TreeMap's desktop shell (T-13 spike)

Established 29–30 Sep 2026 on the owner's Mac (macOS 27.0 build 26A428, arm64, 8 cores, 16 GB) by a
throwaway spike (`scratchpad/tauri-spike/`, identifier `com.prithviweb.treemap.spike`). Nothing was
written into the TreeMap repository. Every fact below comes from one of:

- **src**: the crate source cargo downloaded to `~/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/`,
  cited as `crate-version/path:line`;
- **run**: an experiment in the spike. Each run has `logs/<name>.summary.json` (app log + server log + harness events);
  the experiment definition is `exp/<name>.json`, the page is `server/page.html`, the shell is `app/src/main.rs`;
- **cmd**: a shell command, with its output quoted.

Verdict per item: **confirmed** (the plan's assumption holds), **changed** (the plan must change), **blocked**
(could not be settled here; says why), **CI** (needs Windows or Linux; the exact experiment is listed at the end).

| # | topic | verdict | one line |
|---|---|---|---|
| 1 | versions, Rust, macOS floor | confirmed | tauri 2.12.0 + plugins build on the repo's Rust 1.98.1; pin `=`, avoid 3.0 alphas; build with `tauri/custom-protocol` |
| 2 | size, build cost | confirmed (better than hoped) | shell binary 3.07 MB (`opt-level="s"`, LTO, 1 CGU, strip, abort) … 4.7 MB with 5 plugins; `.app` = binary + 27 KB |
| 2 | macOS signing of the bundle | **changed** | Tauri's default (no identity) leaves the bundle unsealed; macOS 27 refused its 2nd launch. Ad hoc (`signingIdentity "-"`) works |
| 3 | SSE, cookie, localStorage (D-3) | confirmed / **changed** | all work; D-3 confirmed; add an SSE budget (WebKit 6 conns/host) and a 1 s timer granularity when hidden |
| 4 | capabilities for 127.0.0.1:* | confirmed | port wildcard works; runtime capability also works; exact JSON below |
| 5 | navigation + new-window guards, FDA link | confirmed, D-2 simplified | `on_navigation`, `on_new_window`; the page's `window.open('x-apple…')` reaches the handler verbatim |
| 6 | init script, IPC origin, CSP | confirmed | origin check inside the script; IPC `ipc://localhost` / `http://ipc.localhost`, falls back to postMessage under TreeMap's CSP |
| 7 | downloads | confirmed + **changed** | `on_download` works for same-origin and `blob:`; without it WebKit writes to `~/Downloads`; save panel via rfd |
| 8 | native file drop | **changed** (by source) | enabled handler hides every drag from WebKit on macOS too; hand check listed |
| 9 | sidecar stdin EOF on kill -9 | confirmed | child saw EOF and exited < 1.5 s |
| 10 | FDA covers the sidecar | confirmed | responsible pid of child and grandchild = the .app when launched by LaunchServices |
| 11 | Opened, single instance, progress, attention, tray, 3 buttons, panic hook | confirmed with caveats | single-instance socket is in shared `/tmp`; notifications have no click on desktop |
| 12a | `window.prompt` | **changed** | returns `null` in WKWebView under Tauri; TreeMap's 3 `prompt()` flows need an in-page dialog |
| 12c | plugins inject JS into the page | **changed** | dialog plugin makes `confirm()` a truthy Promise; register only single-instance + updater |
| 12b | hardened Node | settled | needs `allow-jit` at minimum |
| – | camera/mic permission default | **changed** | wry grants media requests unless `on_permission_request` denies |

---

## 1. Versions, toolchain, minimum OS

| crate | pinned (newest 2.x on 29 Sep 2026) | rust-version |
|---|---|---|
| tauri | 2.12.0 | 1.90 |
| tauri-build | 2.7.0 | 1.90 |
| tauri-plugin-notification | 2.5.0 | 1.90 |
| tauri-plugin-dialog | 2.8.0 (pulls tauri-plugin-fs 2.6.0) | 1.90 |
| tauri-plugin-opener | 2.7.0 | 1.90 |
| tauri-plugin-single-instance | 2.5.1 | 1.90 |
| tauri-plugin-updater | 2.13.1 | 1.90 |
| tauri-cli | 2.12.0 | 1.90 |
| underneath: tauri-runtime-wry 2.12.0, wry 0.57.0, tao 0.37.1, muda 0.20.0, tray-icon 0.25.1, tauri-utils 2.10.0, rfd 0.16.0, tauri-bundler 2.10.0 | | wry/tao 1.85 |

- Evidence: `cargo info <crate>@2` (each printed `version: 2.x.y (latest 3.0.0-alpha.N)`); `rust-version` lines from each
  crate's Cargo.toml. **Tauri 3 is in alpha** (tauri 3.0.0-alpha.3, plugins 3.0.0-alpha.1): `cargo add tauri` without
  `@2` would pick the alpha. Pin with `=` and commit Cargo.lock.
- **The repo's pinned Rust 1.98.1 builds all of it**: spike `rust-toolchain.toml` = `channel = "1.98.1"`; every build
  (debug with all five plugins, debug without plugins, five release profiles, `cargo install tauri-cli`, two
  tauri-cli bundles) finished with 0 errors; the only warnings were two in the spike's own code (unused under the
  no-plugins configuration). No dependency warning stopped a build.
- Minimum macOS: tauri-utils' default `bundle.macOS.minimumSystemVersion` is **10.13**
  (`tauri-utils-2.10.0/src/config.rs:694-696`), but the Rust target `aarch64-apple-darwin` itself needs 11.0, WKDownload
  needs 11.3 (`wry-0.57.0/src/wkwebview/navigation.rs:57-59`), `data_store_identifier` and `background_throttling` need
  14 (`wry-0.57.0/src/wkwebview/mod.rs:239-242, 485-497`), and unprefixed `backdrop-filter` needs a recent WebKit
  (section 3). The spike set 12.0. Choose the floor deliberately and write it in tauri.conf.json; only macOS 27 was
  tested here.
- `tauri::is_dev()` is `!cfg!(feature = "custom-protocol")` (`tauri-2.12.0/src/lib.rs:317-319`): a plain
  `cargo build --release` is a *dev* build unless `tauri/custom-protocol` is enabled (tauri-cli enables it). The
  release pipeline must build with that feature (the spike used a `prod = ["tauri/custom-protocol"]` feature).
- Dependency download: Cargo.lock has 537 registry packages (all platforms); their `.crate` files total 92,302,126 B
  and unpack to 751,252,189 B in `~/.cargo/registry/src` (cmd: python over Cargo.lock + registry cache).
- Plan impact: **confirmed** (versions pinned; 1.98.1 works). Add: pin exact versions, avoid 3.0 alphas, build release
  with `tauri/custom-protocol`.

## 2. Sizes and build cost (macOS arm64)

All numbers measured on this Mac with `stat -f %z` (bytes) and `du -sk` (KB), `cargo -j2`, Rust 1.98.1, arm64 only,
crates already downloaded, other helpers' builds sometimes running (times are indicative). Script: `sizes.sh`,
raw rows `logs/sizes.tsv`. "minimal" = `mini/` (one window, one embedded page, tauri default features, `tauri/custom-protocol`);
"spike" = `app/` with notification, dialog, opener, single-instance, updater, rfd, `tray-icon`, `image-png`.

| app | profile | settings | binary bytes | build s |
|---|---|---|---|---|
| minimal | `release` (cargo default) | opt 3, no LTO, 16 CGU, unwind, debuginfo stripped, symbols kept | 9,757,216 | 370 |
| minimal | `release`, then `strip` | same + symbols removed | 6,492,216 | – |
| minimal | `rel-3` | opt 3, `lto=true`, 1 CGU, `panic=abort`, `strip=true` | 3,844,160 | 198 |
| minimal | **`rel-s`** | opt `"s"`, `lto=true`, 1 CGU, `panic=abort`, `strip=true` | **3,068,464** | 230 |
| minimal | `rel-z` | opt `"z"`, `lto=true`, 1 CGU, `panic=abort`, `strip=true` | 2,266,496 | 193 |
| minimal | `rel-s-unwind` | opt `"s"`, `lto=true`, 1 CGU, unwind, `strip=true` | 4,175,952 | 215 |
| spike (5 plugins) | `release` | cargo default | 13,882,880 | 468 |
| spike (5 plugins) | **`rel-s`** | as above | **4,707,392** | 307 |
| spike | debug (dev profile) | with the 5 plugins / without plugins | 42,474,040 / 35,162,360 | 720 cold / 227 |

`.app` bundles built by `cargo tauri build --bundles app` (tauri-cli 2.12.0; `bundles.sh`, logs `logs/bundle-*.log`):

| bundle | `du -sk` | contents |
|---|---|---|
| minimal, `release`, no signing identity | 9,560 KB | `MacOS/tmmini` 9,757,344 B, `Info.plist` 973 B, `Resources/icon.icns` 23,555 B |
| minimal, `rel-s`, no signing identity | 3,028 KB | exe 3,068,464 B + same two files |
| minimal, `rel-s`, `signingIdentity "-"`, `hardenedRuntime false` | 3,012 KB | exe 3,050,752 B (re-signed) + `_CodeSignature/CodeResources` 2,440 B |

- The binary links only system frameworks (WebKit, AppKit, Foundation, CoreGraphics, …; `otool -L`), so the shell adds
  nothing else to the bundle. **Stage T estimate** (plan §0.1): Electron Framework 228,592 KB + helpers is replaced by a
  3–5 MB shell; Stage T ≈ Node arm64 slice 120,573,328 B + shell ≈ 4.7–5.9 MB + the backend files.
- `panic=abort` saves 1,107,488 B on the minimal app (`rel-s-unwind` − `rel-s`) but changes behaviour: with unwind a
  panic in a background task is survivable (run `e11`), with abort any panic in any thread ends the process right after
  the hook (Rust semantics; not run — an aborting GUI app would put a crash report dialog on the owner's screen).
  **Recommendation: `opt-level="s"`, `lto=true`, `codegen-units=1`, `strip=true`, `panic="unwind"`** (≈ 4.2 MB minimal;
  ≈ 5.8 MB with the plugins, estimated as 4,707,392 B + the measured unwind delta) — the crash net (T-22) needs to
  survive a panic long enough to show its one dialog.
- Build cost: first **debug** build with all five plugins, cold `target/`: **12 min 00 s**, 385 s user CPU, peak RSS
  1,013,694,464 B, `target/` = 2,104,220 KB (`logs/build-debug-plugins.log`). Each extra release profile: 3–8 min.
  `cargo install tauri-cli --version =2.12.0 --locked -j2`: **26 min 10 s**, 653 crates, peak RSS 1.25 GB,
  40,056,496 B binary (`logs/install-tauri-cli.log`) — CI should cache it (or `cargo binstall`). Disk at the end:
  `target/` 10,316,512 KB (debug 3,229,652; release 1,749,396; rel-s 1,515,192; each other profile ≈ 800,000;
  tauri-cli build 1,422,964); `tools/` 39,128 KB; registry sources of the lock 751,252,189 B.

**Signing and Gatekeeper on macOS 27 (the coordinator's question).**
- tauri-bundler signs only when a signing identity is configured (`tauri-bundler-2.10.0/src/bundle/macos/sign.rs:19-44`,
  `app.rs:115-131`). Without one, the `.app` holds the linker's ad-hoc signature on the executable and no sealed
  resources: `codesign --verify --deep --strict` → "code has no resources but signature indicates they must be present"
  (checked on the tauri-cli output and on my hand-assembled test bundle).
- **The hand-assembled unsealed bundle (`bundles/TMSpikeDev.app`, bundle id `com.prithviweb.treemap.spike`) launched once
  (22:42:24, run `b1-probe`) and was refused on the next launch** (22:42:52, `open -n -g … TMSpikeDev.app <folder>`):
  `The application cannot be opened for an unexpected reason … RBSRequestErrorDomain Code=5 "Launch failed." …
  NSPOSIXErrorDomain Code=162 … Launchd job spawn failed`; `launchctl error 162` → "Codesigning issue". Per the owner's
  rule I stopped that step: no retry of that bundle, no re-signing it, no xattr/spctl changes. I could not see whether
  a dialog appeared on the screen.
- **A locally built, ad-hoc-signed Tauri `.app` launches without any Gatekeeper refusal**: tauri-cli with
  `{"bundle":{"macOS":{"signingIdentity":"-","hardenedRuntime":false}}}` → `codesign --verify --deep --strict`:
  "valid on disk / satisfies its Designated Requirement"; launched with `open -n -g` three times (plain 23:24:45, plain
  23:25:07, with a folder argument 23:25:21): each started (pid seen), each stopped with SIGTERM, `open` exit 0 each time;
  syspolicyd logged `GK evaluateScanResult: 2 … (bundle_id: com.prithviweb.treemap.spike.mini)` and created provenance
  data, as for any local app. (The bundle carries `com.apple.provenance`, never `com.apple.quarantine`.)
- **A downloaded copy would be blocked**: `spctl --assess -vv --type execute` (read-only query) on the ad-hoc bundle →
  `rejected`. Gatekeeper assesses quarantined (downloaded) apps, so users downloading an unsigned/ad-hoc TreeMap should
  expect a Gatekeeper block on first open and need System Settings → Privacy & Security to allow it (not tested — adding
  quarantine to a local build would itself be an xattr edit and would put the dialog on the owner's screen). Only
  Developer ID signing + notarization removes it. (The owner's recent Electron dialog was XProtect's "contains
  malware", a different check.)
- The ad-hoc designated requirement is the cdhash (`codesign -d -r-` → `designated => cdhash H"4fd2fd72…"`), different
  for every build.
- `hardenedRuntime` defaults to **true** (`tauri-utils-2.10.0/src/config.rs:659, 685`) and the bundler applies one
  entitlements file and `--options runtime` to every target it signs (`sign.rs:46-72`,
  `tauri-macos-sign-2.4.0/src/keychain.rs:221-226`) — frameworks, `externalBin` sidecars, the app. A Node sidecar signed
  that way without `allow-jit` dies at start (12.b). The bundler does **not** sign Mach-O files placed as resources
  (`.node` addons, libvips, gdu): the plan's own innermost-first signing script is still needed.
- Plan impact: **changed** — "unsigned as today" must mean "ad hoc" (`signingIdentity "-"`, `hardenedRuntime false`,
  plus the script signing every nested Mach-O first); never ship the bundler's unsealed default.

## 3. External page on http://127.0.0.1:<port>: SSE, cookie, localStorage (D-3)

Window: `WebviewWindowBuilder::new(app, "main", WebviewUrl::External("http://127.0.0.1:<port>/…"))`. Test server:
`server/server.mjs` (node:http only), page `server/page.html`.

- **SSE streams incrementally.** run `e1-main-nocsp`: 10 events sent 100 ms apart arrived at
  150, 242, 361, 458, 560, 664, 764, 867, 977, 1097 ms after `new EventSource()`; under TreeMap's exact CSP
  (run `e2-csp`) at 12, 112, …, 919 ms. Hidden window (runs `e5`, `e6`): SSE kept 10 events/s.
- **The HttpOnly SameSite=Strict cookie is sent on fetch, EventSource and downloads.** The server set
  `tmsid=<random>; HttpOnly; SameSite=Strict; Path=/` on `GET /`; then `GET /api/whoami` (fetch), `GET /sse`
  (EventSource) and `GET /download/report.csv` (`<a download>`) all arrived with it (`cookieSent: true` in
  `logs/e1-main-nocsp.summary.json`); `document.cookie` was `""`. The session cookie was **not** sent on the next
  launch's first `GET /` (runs `e13-ls-2`: `anyCookie: null`), so each launch starts clean.
- **localStorage persists per origin, and the origin includes the port** (D-3 confirmed):
  `e13-ls-1` port 47831 → before `null`, wrote a value; `e13-ls-2` same port 47831 → read
  `launch=e13-ls-1 origin=http://127.0.0.1:47831`; `e13-ls-3` port 47832 → `null`.
- **A new port per launch also grows WebKit's data folder forever**: each origin gets its own hashed folder under
  `~/Library/WebKit/<bundle id or exe name>/WebsiteData/Default/` (22 hashed folders + `salt` after the spike's
  22 distinct test origins; cmd `ls ~/Library/WebKit/tmspike/WebsiteData/Default`).
- Where WebKit keeps data: bundled app `~/Library/WebKit/<bundle id>/` + `~/Library/Caches/<bundle id>/`
  (run `b1-probe`); unbundled binary `~/Library/WebKit/<exe name>/` + `~/Library/Caches/<exe name>/`; plus
  per-user XPC folders `$(getconf DARWIN_USER_CACHE_DIR)com.apple.WebKit.{GPU,Networking,WebContent}+<code id>`
  and the same under `DARWIN_USER_TEMP_DIR`.
- Page environment in WKWebView on macOS 27 (run `e1`): `isSecureContext: true` on `http://127.0.0.1` and
  `http://localhost`; `navigator.clipboard.writeText` resolved inside a click; `CSS.supports('backdrop-filter')`
  **and** `-webkit-backdrop-filter` both true (older macOS WebKit needs the prefix); User-Agent is
  `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)` (no `Version/`/`Safari/`
  token — anything sniffing for Safari will miss it); a `blob:` Worker runs under TreeMap's CSP (`worker-src blob:`,
  run `e18-csp-worker`: result 42).
- **WebKit's 6-connections-per-host limit applies** (run `e7-conn`): with 8 `EventSource`s to one origin only 6
  reached the server, and a plain `fetch('/api/whoami')` made while they were open never started (aborted at 5,000 ms).
  `127.0.0.1` and `localhost` are separate hosts. The page must never hold more than ~4 long-lived streams.
- **Hidden-window throttling** (runs `e5-throttle-default`, `e6-throttle-disabled`): after `window.hide()`,
  `document.visibilityState` became `hidden`, `setInterval(…,100)` dropped from 10 ticks/s to **1 tick/s**, SSE stayed
  at 10 events/s. `background_throttling(BackgroundThrottlingPolicy::Disabled)` did **not** change the 1 tick/s. Any
  page watchdog built on timers is coarsened to ~1 s while the window is hidden; one built on SSE arrival is not.
- Plan impact: SSE/cookie/token design **confirmed**. D-3 **confirmed**, and OQ12 (reuse the last port) now also
  avoids unbounded WebKit folders. **Changed**: add a stream budget (≤ 4 concurrent SSE per origin) and make the scan
  watchdog tolerate 1 s timer granularity while hidden.

## 4. Capabilities for the remote page

- A page from a non-app origin is `Origin::Remote`, and then **every** command — app or plugin — must be allowed by a
  capability; there is no implicit allowance (`tauri-2.12.0/src/webview/mod.rs:2048-2087`, the comment reads
  "remote content can never reach custom commands unless an explicit `remote` capability has been configured").
  "Local" means `tauri://`, the `devUrl`/`frontendDist` URL, or a registered custom scheme (`…/webview/mod.rs:1966-2006`)
  — so **do not set `devUrl`/`frontendDist` to the sidecar URL**, or the page becomes local.
- App commands get ACL permissions only when build.rs declares them:
  `tauri_build::try_build(Attributes::new().app_manifest(AppManifest::new().commands(&["ping", …])))` generates
  `allow-ping`/`deny-ping` (`tauri-build-2.7.0/src/acl.rs:102-107`); a declared app command without a granted
  permission is refused even for local pages.
- Exact capability used (`app/capabilities/main.json`):

```json
{
  "identifier": "main-remote",
  "local": false,
  "windows": ["main", "foreign"],
  "remote": { "urls": ["http://127.0.0.1:*"] },
  "permissions": ["core:event:allow-listen", "core:event:allow-unlisten", "allow-ping", "allow-report-result"]
}
```

- **The port wildcard works.** `remote.urls` entries are WHATWG URLPatterns (`tauri-utils-2.10.0/src/acl/mod.rs:282-321`,
  urlpattern 0.6.0). run `e1`: the page on `http://127.0.0.1:47811` called `ping` → ok; the same page served as
  `http://localhost:47811` → `ping not allowed on window "foreign", webview "foreign", URL: http://localhost:47811/ …
  allowed on: [windows: "foreign", "main", URL: http://127.0.0.1:*]`. Unit test `app/src/main.rs::tests::port_wildcard_pattern` (`cargo test -p tmspike --features plugins`, `logs/unit-pattern.log`):
  `http://127.0.0.1:1/`, `:4280/`, `:65535/x?y#z`, `http://127.0.0.1/` → match; `http://localhost:4280/`,
  `https://127.0.0.1:4280/`, `http://127.0.0.2:4280/`, `http://127.0.0.1.evil.test:4280/`, `http://[::1]:4280/` → no match.
- **Adding the capability at run time also works** (`dynamic-acl` is a default feature): run `e9-runtime-cap`,
  `app.add_capability(CapabilityBuilder::new("runtime-cap").remote("http://127.0.0.1:47819".into()).local(false)
  .window("rt").permission("allow-ping")…)` → `ping` ok; negative control `e10-nocap` (window with no capability) →
  refused. Either form is fine; the static wildcard is simpler.
- **Do not use `core:event:default`** — it also grants `emit` and `emit-to`
  (`tauri-2.12.0/permissions/event/autogenerated/reference.md:1-12`); list `allow-listen` and `allow-unlisten`.
- **How to confirm the page has nothing else** (run `e1`, page on the allowed origin): `ping` ok; `event.listen` ok
  (and an event emitted from Rust arrived); refused with a named reason: `secret_command` (declared app command, no
  permission), `event.emit`, `app.version`, `window.title`, `path.resolve_directory`, `opener.reveal_item_in_dir`,
  `notification.is_permission_granted`, `dialog.<anything>`. The self-test should keep this matrix as a test: invoke
  one command of every registered plugin and every core module and expect "not allowed".
- Plan impact: **confirmed** (static capability with `http://127.0.0.1:*`, TreeMap's commands + event listen/unlisten).

## 5. Navigation and new-window guards; the Full Disk Access link (D-2)

- API (tauri 2.12.0): `WebviewWindowBuilder::on_navigation<F: Fn(&Url) -> bool + Send + 'static>`
  (`webview_window.rs:266`), `on_new_window<F: Fn(Url, NewWindowFeatures) -> NewWindowResponse<R> + Send + 'static>`
  (`webview_window.rs:315`) returning `NewWindowResponse::{Allow, Create { window }, Deny}` (`webview/mod.rs:243-262`).
- `on_navigation` sees the initial load too, and every top-level navigation (run `e1`: `http://127.0.0.1:47811/…`
  allowed; `location.href='x-apple.systempreferences:…'`, `'mailto:…'`, `'https://example.com/nav'` each reached the
  handler and were cancelled by returning `false`; the page stayed).
- `on_new_window` received, verbatim, every `window.open` made inside a click (trusted click, `userActivation: true`):
  `https://example.com/popup`, **`x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles`**,
  `mailto:someone@example.com`, `http://127.0.0.1:47811/page2`, `file:///etc/hosts`; `Deny` made `window.open`
  return `null`. TreeMap's own form `window.open(url, '_blank', 'noopener')` (settings modal OAuth) also reached it
  (run `e1b-links`). A `window.open` with **no** user gesture also reached the handler (both windows logged
  `https://example.com/nogesture`), so the handler — not WebKit's popup rule — is the guard.
- Without `on_new_window`, wry's UI delegate returns `nil` and nothing opens
  (`wry-0.57.0/src/wkwebview/class/wry_web_view_ui_delegate.rs:180-291`); run `e4-nohandlers` confirmed: the
  x-apple URL, https, mailto, file — nothing opened, System Settings not launched (`pgrep` before/after).
  **This is exactly D-2: WKWebView drops the FDA link unless the shell handles it.**
- Opening the URL from Rust: `tauri_plugin_opener::open_url(url, None::<&str>)` is a free function
  (`tauri-plugin-opener-2.7.0/src/open.rs:9-36`) → `open::that_detached` → `/usr/bin/open <url>`
  (`open-5.4.4/src/macos.rs:4`); the plugin does not need to be registered for this (and should not be — see 12.c).
  LaunchServices resolves the exact URL to System Settings (cmd, read-only, nothing opened:
  `NSWorkspace.URLForApplicationToOpenURL(x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles)`
  → `/System/Applications/System Settings.app`). I did not open System Settings on the owner's screen.
- Recommended guard (both handlers): own origin → allow navigation / deny new window (or load in place);
  `http`/`https`/`mailto` → `open_url` + deny; the one fixed FDA URL → `open_url` + deny; everything else → deny.
  The bridge's `openPrivacySettings` can stay, but the page's existing `window.open('x-apple…')` already reaches the
  handler, so D-2 is fixed in the shell without a page change.
- `<a target=_blank>` links: with the plugins registered they reached neither handler, because **tauri-plugin-opener
  injects a click interceptor into every page** (see 12.c) that called `plugin:opener|open_url`, which the ACL refused
  (runs `e1`, `e1b`). Without plugins (run `e22-noplugins`), a trusted click on a `target=_blank` link goes to
  **`on_navigation` first** (cross-origin `rel=opener` and `rel=noopener` links: `on_navigation https://example.com/…`,
  returning `false` cancelled them, no window), and for a same-origin link `on_navigation` (allowed) was followed by
  `on_new_window`. So external links must be handled in `on_navigation` as well as in `on_new_window` — the recommended
  guard above already does that. TreeMap's UI has no `target=_blank` anchors today (`grep`, src/ui).
- Plan impact: **confirmed** (handlers exist with those names) and D-2 fix **simplified**.

## 6. Initialization script, IPC origin, CSP

- `initialization_script(js)` injects into the main frame of **every** page the webview loads, whatever its origin;
  `initialization_script_for_all_frames` adds iframes (`webview_window.rs:1008, 1053`). There is no origin filter, so
  the bridge must test `location.origin` itself. run `e1` (second window on `http://localhost:47811`, bridge armed for
  `http://127.0.0.1:47811`): main page `treemapDesktop = ["shell","ping"]`, foreign page `treemapDesktop = null`.
- Tauri's own scripts (`__TAURI_INTERNALS__`, invoke key, event system) are injected into every main-frame page
  unconditionally (`tauri-2.12.0/src/manager/webview.rs:160-200`): the foreign page had `__TAURI_INTERNALS__`, and the
  ACL was what refused it. `window.__TAURI__` stays undefined with `withGlobalTauri: false`.
- **IPC transport on macOS** (`tauri-2.12.0/scripts/ipc-protocol.js:25-85`): first `fetch('ipc://localhost/<cmd>')`
  (POST, headers `Tauri-Callback`, `Tauri-Error`, `Tauri-Invoke-Key`); if that throws (CSP or WebView refusal) it logs
  "IPC custom protocol failed, Tauri will now use the postMessage interface instead" and switches the page to
  `window.ipc.postMessage` for good.
  - No CSP (run `e1`): `ping` arrived with headers `tauri-callback, tauri-invoke-key, origin, …` → custom protocol.
  - **TreeMap's exact CSP** (`connect-src 'self'`, run `e2-csp`): one `securitypolicyviolation` (`blockedURI
    ipc://localhost/…`, `connect-src`), then `ping` arrived with no headers → postMessage. Everything still worked.
  - CSP with `connect-src 'self' ipc: http://ipc.localhost` (run `e3-csp-ipc`): no violation, custom protocol used.
  - So the origins are **`ipc://localhost`** (macOS, Linux) and **`http://ipc.localhost`** (Windows, Android)
    (`core.js:13-19`). Adding `ipc: http://ipc.localhost` to `connect-src` under `TREEMAP_SHELL=tauri` is optional:
    without it IPC still works via postMessage after one violation per page load.
- Custom-scheme proxy for the API is impossible for SSE: `UriSchemeResponder::respond` takes one complete
  `http::Response<Cow<[u8]>>` (`tauri-2.12.0/src/app.rs:2625-2633`) — no streaming body. The plan's rejection stands.
- Plan impact: **confirmed**; T-12 may add exactly `ipc: http://ipc.localhost`.

## 7. Downloads

- `on_download(|webview, DownloadEvent| -> bool)`; `DownloadEvent::Requested { url, destination: &mut PathBuf }` and
  `Finished { url, path, success }` (`tauri-2.12.0/src/webview/mod.rs:79-107, 650`). On macOS `path` in `Finished` is
  always `None` (documented there, and seen: `"path": null`).
- run `e1`: a click on `<a download href="/download/report.csv">` (same origin, cookie sent) and on
  `<a download="blob-export.csv" href="blob:…">` each produced `Requested` with default destination
  `~/Downloads/<suggested name>` (`wry-0.57.0/src/wkwebview/download.rs:57-60`); the handler replaced it with a scratch
  path; `Finished success: true`; files correct.
- **Without an `on_download` handler WebKit still downloads — straight into `~/Downloads`** (run `e4-nohandlers`: two
  files appeared in the owner's `~/Downloads`; I moved them out to `downloads-e4-from-home/`). This contradicts wry's
  intent (`navigation.rs:68-74` cancels only the `shouldPerformDownload` path). TreeMap must always install the handler.
- Downloaded files get `com.apple.quarantine: 0083;…` (cmd `xattr -l`), harmless for CSV/PDF/XLSX.
- Save dialog: the handler must decide `destination` synchronously on the main thread. run `e14-save-dialog`: calling
  `rfd::FileDialog::save_file()` (synchronous NSSavePanel) inside `Requested` worked (a nested modal; Tauri's event
  loop still processed an `exit` request during it; returned `None` when closed). `tauri-plugin-dialog`'s
  `blocking_save_file` would deadlock there (it dispatches to the main thread and waits). Recommended T-17 design:
  `Requested` → synchronous rfd save panel (tested app-modal, without a parent; a sheet via `set_parent` is untested),
  or cancel and let the bridge route exports through a Rust command that fetches from the sidecar with the token.
  My in-process Escape key did not dismiss the panel, so T-17's self-test needs another way to close it (e.g. a
  test-only destination override).
- Plan impact: **confirmed** (handler exists) with two **changes**: the handler is mandatory, and the save dialog
  comes from rfd directly.

## 8. Native file drop (macOS)

- Event: `WindowEvent::DragDrop(DragDropEvent::{Enter { paths, position }, Over { position }, Drop { paths, position },
  Leave})` (`tauri-runtime-wry-2.12.0/src/lib.rs:4798-4834`).
- **When the handler is enabled (the default), WebKit receives no drag events at all on macOS**: wry overrides
  `draggingEntered:/draggingUpdated:/performDragOperation:/draggingExited:` on its WKWebView subclass and only calls
  `super` when the handler returns `false` (`wry-0.57.0/src/wkwebview/drag_drop.rs:35-104`), and Tauri's closure
  always returns `true` (`tauri-runtime-wry-2.12.0/src/lib.rs:4832`). So on macOS HTML5 file drops into the page stop,
  and **in-page HTML5 drags (the cleanup cart's row dragging) very likely stop too** — WebKit routes in-page drags
  through the same `NSDraggingDestination` methods. `disable_drag_drop_handler()` restores WebKit's behaviour
  (`drag_drop.rs` default handler returns `false`, `wkwebview/mod.rs:305-308`).
- Not run: a real drag needs the owner's mouse; I did not drive it. **Hand check (2 minutes)**: run the spike with
  `drag_drop_disabled` false/true, drag a Finder folder onto the window and drag a `draggable=true` element inside the
  page; the app log shows `drag-drop` events, the page log shows `dragstart/drop`.
- Plan impact: **changed** — the risk the plan listed for Windows applies to macOS too (by source). Options: keep the
  native handler off and read dropped paths in the page (WebKit gives no paths → still need a native path source), or
  keep it on and move the cart's drag to pointer events. Decide in T-18 after the hand check.

## 9. Sidecar lifecycle

run `e8-sidecar-kill` (shell `app/src/main.rs::spawn_sidecar`, child `server/sidecar.sh` standing in for Node):
`Command::new("/bin/sh").env_clear().env("PATH",…).env("TREEMAP_SHELL","tauri")…stdin(piped).stdout(piped)`,
token written as the first stdin line.
- Child saw only the custom env (`HOME: unset`, `USER: unset`, `TREEMAP_SHELL: tauri`) and a 28-char token line.
- stdout lines arrived in the shell (`sidecar-stdout` events) — the ready-line protocol works.
- **`kill -9` of the shell → the child read EOF on stdin, logged `stdin-eof pid=12352 ppid_now=1`, and was gone within
  1.5 s** (`sidecarAliveAfter1500ms: false`). Graceful exit (run `b1-probe`) also produced EOF.
- Plan impact: **confirmed** (stdin EOF is a reliable orphan signal on macOS).

## 10. Full Disk Access attribution (TCC responsible process)

Method: `probe/src/main.rs` resolves the private `responsibility_get_pid_responsible_for_pid` with
`dlsym(RTLD_DEFAULT, …)` and prints its own pid, parent, and responsible pid + path. No privacy setting was read or
changed, no protected folder touched, no prompt appeared.
- Baseline (cmd, from this terminal): responsible = `…/claude.app/Contents/MacOS/claude`, not zsh — the method works.
- run `b1-probe` (bundle launched by LaunchServices, `open -n -g`): app pid 88621;
  the app's direct child → responsible **88621** (`…/TMSpikeDev.app/Contents/MacOS/tmspike`);
  a grandchild spawned by the `/bin/sh` sidecar → responsible **88621**.
- run `e8` (same binary started directly from a shell): child and grandchild → responsible = the app that owns the
  shell (here `claude.app`, pid 31573), not the spike.
- Meaning: **macOS attributes the sidecar's (and its children's) file access to TreeMap.app**, so Full Disk Access
  granted to TreeMap.app covers the Node sidecar, as long as the app was launched normally (Finder, Dock, `open`).
  A `cargo run`/terminal launch attributes to the terminal instead — dev runs are not a test of FDA.
- Plan impact: **confirmed**. Caveat for Q5: an ad-hoc signature's designated requirement is its cdhash, which changes
  every build, so a grant made to one build does not match the next (`codesign -d -r-` on the ad-hoc bundle: `designated => cdhash H"4fd2fd72…"`). Not tested against TCC (that
  would need an FDA grant); it follows from TCC storing the designated requirement. Same bundle id does not help.

## 11. macOS integration APIs

- **RunEvent::Opened { urls: Vec<Url> }** exists on macOS (`tauri-2.12.0/src/app.rs:257-266, 2797`); also
  `RunEvent::Reopen { has_visible_windows }` (`app.rs:279`). run `e20-odoc-menu-zoom`: an `odoc` Apple Event (the event LaunchServices sends for a dock drop or "Open With")
  sent by the running spike to itself from a background thread → `RunEvent::Opened { urls:
  ["file:///…/folders/opened-while-running/"] }` 1 ms later (folder URL, trailing slash). Sending it from inside a
  main-thread callback hung the main thread (first attempt, stopped by the harness), so real delivery by
  LaunchServices (queued to the run loop) is the relevant path. The ad-hoc bundle also launched with a folder argument
  (section 2). Also needed in Info.plist: `CFBundleDocumentTypes` with `public.folder` — tauri-bundler merges an
  `Info.plist` placed next to tauri.conf.json (used in `app/Info.plist`).
- **Single instance (tauri-plugin-single-instance 2.5.1, macOS)**: a Unix socket at
  `/tmp/<identifier with . and - replaced by _>_si.sock` (`platform_impl/macos.rs:61-72`); the second process connects,
  sends `cwd\0\0argv…` and `exit(0)`s inside plugin setup (`macos.rs:20-54, 78-93`). run `e15-single`: second process
  (argv `[exe, <folder>, --flag]`) exited 0; the first got `args` = full argv incl. `argv[0]`, `cwd` = the second
  process's cwd; socket `srwxr-xr-x prithvivinay /tmp/com_prithviweb_treemap_spike_si.sock`, removed on exit.
  Caveats: `/tmp` is shared by all users — a second macOS user's TreeMap either cannot connect (permission) and runs
  without single-instance, or finds a stale/foreign socket it cannot remove (sticky bit); with the `semver` feature the
  name also carries the version. On macOS a second *LaunchServices* launch normally never happens (the running app
  gets `Reopen`/`Opened` instead); the plugin matters for CLI launches ("Scan with TreeMap" running the binary).
  Recommendation: keep the plugin but consider a per-user socket path (small fork) — the scan-queue input is a
  path that becomes a scanned root.
- **set_progress_bar** (`window/mod.rs:2432`; macOS draws into the Dock tile, `tao-0.37.1/src/platform_impl/macos/
  window.rs:1549-1551`) and **request_user_attention(Some(UserAttentionType::Informational|Critical))**
  (`window/mod.rs:2044`; `NSApp.requestUserAttention`, `tao …/macos/window.rs:1425-1436`): both returned `Ok` in run
  `e1` (not verified visually — a screenshot would have needed Screen Recording permission).
- **Tray**: `TrayIconBuilder::icon_as_template(true)` and `.title("42%")` (macOS menu-bar text) exist
  (`tauri-2.12.0/src/tray/mod.rs:280, 295`); run `e1` built one from a 32×32 black-alpha PNG (`tray-built`,
  `rect: Some(…)`). Needs feature `tray-icon` (+ `image-png` to load a PNG).
- **Dialog with 3 custom buttons**: `MessageDialogButtons::YesNoCancelCustom(String, String, String)`
  (`tauri-plugin-dialog-2.8.0/src/models.rs:66`), result `MessageDialogResult::Custom(label)` (mapping
  `desktop.rs:223-256`); with `.parent(&window)` rfd shows a **sheet** (`rfd-0.16.0/src/backend/macos/
  message_dialog.rs:88-101`). But see 12.c: use rfd directly rather than registering the plugin.
- **Panic hook** (`std::panic::set_hook`, runs `e11`, `e12`, debug profile = unwind): a panic in an async task ran the
  hook on `tokio-rt-worker` and the app kept running (exited 0 later); a panic on the main thread ran the hook and the
  process exited with code **101**. With `panic = "abort"` the hook still runs first, then the process aborts — even for the
  async-task panic (Rust semantics; deliberately not run, see section 2). So the crash net's dialog cannot rely on
  surviving a panic under abort.
- **Notifications (tauri-plugin-notification 2.5.0, desktop)**: fire-and-forget — `show()` spawns `notification.show()`
  and drops the result (`desktop.rs:203-243`); there is **no click callback on desktop**, and
  `permission_state`/`request_permission` always answer `Granted` (`desktop.rs:89-99`). In a dev build it posts as
  `com.apple.Terminal` (`desktop.rs:232-236`). The macOS backend is `mac-notification-sys` 0.6.15 on the deprecated
  `NSUserNotification` (`objc/notify.m:79-81`). Not sent (would risk a permission prompt on the owner's screen).
  "Click shows the window" needs either `mac-notification-sys`'s `wait_for_click` directly or UNUserNotificationCenter.
- **Zoom**: `Webview::set_zoom(f64)` exists (`webview/mod.rs:2359`); `zoom_hotkeys_enabled(true)` works by injecting a
  script that calls `plugin:webview|set_webview_zoom` from the page (`webview/scripts/zoom-hotkey.js`), i.e. it would
  need a page permission. Do zoom from Rust menu items instead. run `e20`: `webview.set_zoom(1.5)` from a background thread returned `Ok` (wry calls `WKWebView.setPageZoom`,
  `wry-0.57.0/src/wkwebview/mod.rs:954-958`); not verified visually.
- **Menu accelerators vs page shortcuts** (plan Q4 "double-firing"): run `e20` built the default menu plus an item with accelerator
  `CmdOrCtrl+K`, made the window key without activating the app, and posted ⌘K into the app's own event queue → the
  menu item fired (`menu-event spike-cmd`) and **the page received no `keydown`**. Control run `e21` (no menu item for
  ⌘K) → the page received `keydown k meta:true isTrusted:true`. So on macOS a menu accelerator takes the key before
  the page: no double firing, but the page's own handler for that key never runs — the menu item must forward its
  command to the page (`treemap:command`), which is the plan's design.
- **Permissions (plan 1.1 item 7)**: Tauri 2.12 has `on_permission_request(|webview, PermissionKind| -> PermissionResponse)`
  (`webview/mod.rs:720-756`). **Without it, wry on macOS grants every camera/microphone request from any page**
  (`wry_web_view_ui_delegate.rs:164-166`: `else { WKPermissionDecision::Grant }`) — macOS TCC would then prompt for the
  app. The shell must install a handler returning `Deny` for everything (the spike did; nothing requested media).
  Geolocation/notification/clipboard kinds are "not yet supported" on macOS (`tauri-runtime-2.12.0/src/
  webview_permissions.rs:8-38`). The page's `Notification.permission` read `default`.
- Plan impact: mostly **confirmed**; **changed**: permission handler mandatory; notification click needs its own code.

## 12. Other "to verify" items settled on macOS

a. **`window.prompt` returns `null` immediately in Tauri on macOS** (run `e19-dialogs-plugins`: `promptReturned: null`,
   4 ms, no panel): wry's WKUIDelegate implements no JavaScript alert/confirm/prompt panels. TreeMap uses `prompt()`
   in three places — `src/ui/app/105-query-grammar-in-the-highlight-box.js:508` ("Name this view"),
   `230-allocation-diagnostic.js:226` (pairing code), `:250` (folder to scan) — all three would silently cancel.
   **Plan change**: replace them with an in-page dialog (works in every shell) before T-26. With no plugin registered (run `e22-noplugins`, TreeMap's CSP): `prompt()` → `null` (5 ms),
   `confirm()` → `false` (boolean), `alert()` → returns at once; all three are WebKit's native functions and show nothing.
b. **Hardened runtime and Node (plan Q1 "to verify")**: official Node v24.16.0 is signed by Team HX7739G8FX with
   hardened runtime and entitlements `allow-jit`, `allow-unsigned-executable-memory`,
   `disable-executable-page-protection`, `disable-library-validation`, `allow-dyld-environment-variables`,
   `get-task-allow` (cmd `codesign -d --entitlements - /usr/local/bin/node`). Experiment on a thin arm64 copy
   (`nodesign/`, 120,573,328 B): original signature → runs; ad hoc, no runtime → runs; **ad hoc + hardened runtime,
   no entitlements → dies at start** (`Fatal process out of memory: Failed to reserve virtual memory for CodeRange`,
   exit 133); ad hoc + runtime + `allow-jit` only → runs (JIT loop of 2e7 calls ok). So a hardened Node needs at least
   `com.apple.security.cs.allow-jit`; `disable-library-validation` is needed only if a loaded `.node`/dylib carries a
   different Team ID (not tested — no Developer ID on this Mac).
c. **Registering a plugin injects JavaScript into every page, including the remote TreeMap page**:
   - `tauri-plugin-dialog` 2.8.0 always replaces `window.alert` and **`window.confirm` with an async function**
     (`src/init-iife.js`, injected at `src/lib.rs:210`). run `e19`: `confirm()` returned a **Promise (truthy)**, later
     rejected `dialog.confirm not allowed. Command not found`. Any `if (confirm(…))` guarding a delete would proceed. TreeMap's UI has no
     `confirm()` today, but this must never be possible in a deletion tool.
   - `tauri-plugin-opener` 2.7.0 (with default `open_js_links_on_click`) intercepts clicks on `target=_blank`
     http/https/mailto/tel links, `preventDefault()`s them and invokes `plugin:opener|open_url` (`src/init-iife.js`,
     `src/lib.rs:258-260`).
   - `tauri-plugin-notification` 2.5.0 replaces `window.Notification` and calls `is_permission_granted` on every page
     load (`src/init-iife.js`, `src/lib.rs:252`) — that call is what tripped TreeMap's CSP in run `e2`.
   - single-instance and updater inject nothing.
   **Plan change**: do not `.plugin()` dialog, opener or notification. Use their Rust layers directly: `rfd` for
   dialogs, `tauri_plugin_opener::open_url` (free function) or the `open` crate, `mac-notification-sys`/`notify-rust`
   (or UNUserNotificationCenter) for notifications. Register only single-instance and updater.
d. **Updater (Q5)**: `plugins.updater.pubkey` (minisign) is required; `require_signed_version` (default false) makes
   the signature's trusted comment pin the version and blocks downgrade-by-replayed-metadata — turn it on from the first
   release (`tauri-plugin-updater-2.13.1/src/config.rs:106-135`). macOS install replaces the `.app` by `rename`, falling
   back to an AppleScript "with administrator privileges" prompt when the folder is not writable
   (`src/updater.rs:1390-1450`). Check-and-offer = call `check()` only.
e. **An unsealed bundle (Tauri's output without a signing identity) was refused on its second launch; ad hoc works** —
   see "Signing and Gatekeeper on macOS 27" in section 2.
f. **Custom-scheme proxy** — no streaming (section 6). **Clipboard** — secure context, works (section 3).
   **blob: worker** — works under TreeMap's CSP (section 3). **backdrop-filter** — both spellings on macOS 27 (section 3).

## Needs Windows / Linux (CI) — exact experiments

| # | question | exact experiment (CI leg) |
|---|---|---|
| W1 | WebView2 native file drop vs in-page HTML5 dragging (the cart) | Windows: build the spike, page with a `draggable=true` row and a drop zone; run once with `disable_drag_drop_handler()` and once without; drive with `SendInput` mouse down/move/up inside the window (no other app); log `dragstart/dragover/drop` in the page and `DragDrop` in Rust. |
| W2 | `window.open` / `target=_blank` / downloads in WebView2 | Windows: run `server/harness.mjs exp/e1-main-nocsp.json` (clicks via `SendInput` or `ExecuteScript` + a user-gesture shim); expect the same handler log as macOS; check the default download folder without `on_download`. |
| W3 | IPC origin `http://ipc.localhost` under TreeMap's CSP | Windows: `exp/e2-csp.json` and `exp/e3-csp-ipc.json`; `ping` headers show which transport ran. |
| W4 | data directory / portable (D-4) | Windows: `data_directory(<portable>/TreeMap-Data/webview)` + `incognito`; diff `%LOCALAPPDATA%` and `%APPDATA%` before/after one launch (Tauri defaults `data_directory` to `app_local_data_dir` on Windows/Linux: `tauri-2.12.0/src/manager/webview.rs:562-570`). |
| W5 | sidecar orphaning | Windows: Job Object `KILL_ON_JOB_CLOSE` + `TerminateProcess` of the shell → child gone; Linux: `PR_SET_PDEATHSIG` + `kill -9` → child gone; both also check stdin EOF (`exp/e8-sidecar-kill.json` with a `.cmd`/sh stand-in). |
| W6 | node.exe keeps its Authenticode signature when bundled as a sidecar | Windows: `Get-AuthenticodeSignature` on the staged node.exe before and after `cargo tauri build` (NSIS). |
| W7 | NSIS migration from the electron-builder install (T-25) | Windows VM: install the Electron build, then the Tauri NSIS with the uninstall hook; compare `%APPDATA%\TreeMap` byte for byte. |
| W8 | single instance | Windows (named mutex/pipe) and Linux (D-Bus): `exp/e15-single.json` with the platform binary; expect the callback with argv + cwd. |
| L1 | `set_progress_bar` on Linux | Linux: needs `libunity.so.{4,6,9}` via dlopen and a `.desktop` id (`tao-0.37.1/src/platform_impl/linux/taskbar.rs:53-70`); run under xvfb with and without libunity, expect `Ok` and no crash. |
| L2 | WebKitGTK: SSE, 6-connection limit, hidden throttling, `prompt()` | Linux xvfb: `exp/e1`, `e5`, `e7`, `e19` with the Linux binary. |
| L3 | tray on Linux (appindicator) | Linux: build with `tray-icon`, run under xvfb + a StatusNotifier host, expect `tray-built`. |
| A | notification click → show window | macOS by hand (a notification needs a permission answer): `mac-notification-sys` with `wait_for_click(true)`; Windows: toast activation. |

## What the spike left on this Mac

Everything is spike-named; the real app's `com.prithviweb.treemap` folders were not created or modified (the only two
real-identifier entries, `~/Library/Preferences/com.prithviweb.treemap.plist` and `$DARWIN_USER_CACHE_DIR/com.prithviweb.treemap`,
date from 28 Jul and 11 Jun). `~/Library/Application Support/TreeMap` untouched. No process left running (the B2 harness
had orphaned its test server on 47851; stopped). `~/Downloads` back to its 15 entries (the two files WebKit wrote there in
run `e4` were moved to `downloads-e4-from-home/`). No `/tmp/*_si.sock` left.

Left behind, safe to delete when the spike is no longer needed (not deleted by me):
- `~/Library/WebKit/{com.prithviweb.treemap.spike, com.prithviweb.treemap.spike.mini, tmspike, tmspike-dsid, tmspike-noplugins}` (≈ 3.8 MB)
- `~/Library/Caches/{com.prithviweb.treemap.spike, com.prithviweb.treemap.spike.mini, tmspike, tmspike-noplugins}` (≈ 0.3 MB)
- `$(getconf DARWIN_USER_CACHE_DIR)` and `$(getconf DARWIN_USER_TEMP_DIR)`: `com.apple.WebKit.{GPU,Networking,WebContent}+{tmspike-58dabb511c23476c, tmspike-ee4df80a8fa43240, com.prithviweb.treemap.spike.mini}`, `com.prithviweb.treemap.spike`, `com.prithviweb.treemap.spike.mini`, `tmspike`, `tmspike-noplugins`
- LaunchServices registrations of `bundles/TMSpikeDev.app` (declares `public.folder`, so it may appear in Finder's "Open With" for folders) and `bundles-out/rels-adhoc/TMMini.app`; remove with
  `/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -u <path>` or by deleting the scratch folder.
- the scratch folder itself (`target/` ≈ 10 GB).

## How to reproduce

```
cd scratchpad/tauri-spike            # rust-toolchain.toml pins 1.98.1
export CARGO_TARGET_DIR=$PWD/target
cargo build -j2 -p tmspike --features plugins -p probe
node server/harness.mjs exp/e1-main-nocsp.json      # any exp/*.json; results in logs/<name>.summary.json
./sizes.sh                                          # size matrix -> logs/sizes.tsv
./bundles.sh                                        # tauri-cli bundles (needs tools/bin/cargo-tauri)
```
