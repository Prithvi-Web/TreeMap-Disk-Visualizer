
---

## 📥 Installing

**macOS** — `TreeMap-x.y.z-arm64.dmg` · **Apple Silicon only** (M1/M2/M3/M4). Open the DMG, drag TreeMap into Applications.

> ### ⚠️ macOS will block the first launch — this is expected
>
> You'll see **“Apple could not verify ‘TreeMap.app’ is free of malware…”**. Your download is
> fine. macOS shows that for *any* app Apple hasn't **notarized**, and notarization needs a paid
> $99/year Apple Developer membership this free project doesn't have.
>
> **Fastest fix** — drag TreeMap to Applications, open **Terminal**, paste this, press Return:
>
> ```
> xattr -dr com.apple.quarantine /Applications/TreeMap.app
> ```
>
> **No-Terminal fix** — double-click TreeMap → **Done** → **System Settings ▸ Privacy & Security**
> → scroll to **Security** → **Open Anyway** → authenticate → double-click TreeMap → **Open Anyway**.
> *(That button expires after ~1 hour; if it's missing, double-click TreeMap again to bring it back.)*
>
> On **macOS Sequoia (15) and Tahoe (26)** the old *right-click → Open* trick no longer works —
> Apple removed it. Use one of the two routes above.
>
> Full walkthrough, including the *"TreeMap is damaged"* variant:
> **[Installing on macOS](https://github.com/Prithvi-Web/TreeMap-Disk-Visualizer#-first-launch-on-macos--apple-could-not-verify)**

**Windows** — `TreeMap-Setup-x.y.z.exe`. Run it, click **More info** → **Run anyway** at the SmartScreen prompt.

**Intel Mac / Linux** — no desktop build; run web mode from source ([3 commands](https://github.com/Prithvi-Web/TreeMap-Disk-Visualizer#-run-from-source--web-mode-3-commands)).
