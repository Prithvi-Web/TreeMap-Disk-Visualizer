# Security Policy

## Supported Versions

The table below shows which releases are safe to download and run.

| Version | Status | Notes |
|---------|--------|-------|
| v1.2.1  | ✅ Safe to use | Current stable release — recommended for all users |
| v1.1.0  | ✅ Safe to use | Previous stable release — fully functional |
| v1.0.0  | ✅ Safe to use | Initial release — fully functional |
| v1.2.0  | ❌ Do not download | Broken release — see warning below |

---

## ⚠️ v1.2.0 — Do Not Download

**v1.2.0 is broken and should not be used.**

The macOS build shipped with a corrupted quarantine signature, causing macOS to display:

> *"TreeMap is damaged and can't be opened. You should move it to the Trash."*

This is not a false positive — the v1.2.0 `.dmg` is genuinely unusable on macOS. The fix in that terminal command (`xattr -dr com.apple.quarantine`) does **not** resolve the issue for this release.

**If you downloaded v1.2.0, delete it and download v1.2.1 instead:**
👉 [Download v1.2.1](https://github.com/Prithvi-Web/Treemap/releases/tag/v1.2.1)

The Windows build from v1.2.0 is also affected and should not be used.

---

## Reporting a Security Vulnerability

If you find a security vulnerability in TreeMap — such as a path traversal issue, a way to delete files outside a scanned folder, or anything that could cause unintended data loss — please **do not open a public GitHub issue**.

Instead, report it privately:

**Email:** vinay.gopinath@gmail.com  
**Subject line:** `[TreeMap Security] Brief description`

Please include:
- A description of the vulnerability
- Steps to reproduce it
- The version of TreeMap affected
- Your OS and version

I aim to respond within 48 hours and will work with you to fix and disclose the issue responsibly.

---

## Security Design

TreeMap is built with the following safety principles:

- **Trash-only deletes** — files are never hard-deleted. Everything goes to the system Trash and can be recovered from Finder or Explorer
- **Path sanitization** — all file paths are validated and traversal-proofed; system directories (`/proc`, `/sys`, `/dev`, `C:\Windows\System32`, etc.) are blocked
- **Scoped operations** — the trash and file-open endpoints only accept paths inside a folder you explicitly scanned
- **No network access** — TreeMap is fully local. It makes no outbound requests and sends no data anywhere
- **No tracking** — zero telemetry, no analytics, no account required
- **Memory-only scan results** — scan data lives in memory and expires after 30 minutes; only lightweight snapshots (totals + top-level sizes) are written to disk
- **Rate limiting** — the local API is rate-limited to 10 requests/second per IP to prevent abuse if exposed on a network
