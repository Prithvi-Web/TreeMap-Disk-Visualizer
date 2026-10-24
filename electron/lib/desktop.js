'use strict';
/*
 * Pure decisions for the desktop shell: the API token, notification copy,
 * the crash and update dialogs, the About panel, the dock progress mapping
 * and the scan queue. No `electron` import on purpose — this loads under
 * plain Node so tests/desktopPolish.test.ts can drive every branch, and
 * main.js stays a thin layer that hands these results to Electron.
 */
const crypto = require('crypto');

const REPO_URL = 'https://github.com/Prithvi-Web/TreeMap-Disk-Visualizer';
const RELEASES_URL = `${REPO_URL}/releases`;
const LATEST_RELEASE_URL = `${REPO_URL}/releases/latest`;
const ISSUES_URL = `${REPO_URL}/issues/new`;

/* ───────────────────────────── API token ───────────────────────────── */

/**
 * The token the in-process server requires on every /api request.
 *
 * The desktop app used to run its API open: any local process or web page
 * that found the port could scan, trash and offload. The server enforces
 * TREEMAP_TOKEN when it is set, so a fresh random token per launch gates the
 * API; the window's own session is `sessionSecret`'s cookie, never this token.
 * An owner-provided token wins.
 */
function desktopToken(env) {
  const preset = env && typeof env.TREEMAP_TOKEN === 'string' ? env.TREEMAP_TOKEN : '';
  return preset.trim() ? preset : crypto.randomBytes(32).toString('hex');
}

/**
 * The program the right-click "Scan with TreeMap" entry starts (hunt C11):
 * the installed app's own executable — or, in a Linux AppImage, the AppImage
 * file the runtime names in APPIMAGE, since the executable lives in a mount
 * that is gone once TreeMap quits; in the Windows portable build, the .exe
 * electron-builder names in PORTABLE_EXECUTABLE_FILE, since it runs from a
 * temporary folder deleted when it quits (review F1.4). A portable session
 * is not offered the entry at all; this names the copy that stays.
 */
function desktopExec(env, execPath) {
  const named = (key) => (env && typeof env[key] === 'string' ? env[key] : '');
  return named('APPIMAGE') || named('PORTABLE_EXECUTABLE_FILE') || execPath;
}

/**
 * A folder argument from a launch's command line, as the folder it names, or
 * null for an option. `cwd` is the directory the launch was made from — a
 * second launch's own, which Electron hands over, never this process's: a
 * relative "." typed in ~/proj named the first launch's folder, `/` for an
 * app started from the Dock, and the whole disk was scanned (hunt C88).
 *
 * On Windows, "Scan with TreeMap" on a drive passes `"C:\"`, and the command
 * line's rules read a backslash before a quote as a quote: the argument
 * arrives as `C:"` (electron/mft.js names the same trap). It is the drive's
 * root, `C:\` (hunt C57).
 */
function scanArgPath(arg, cwd, platform, paths) {
  if (typeof arg !== 'string' || !arg || arg.startsWith('-')) return null;
  const repaired = platform === 'win32' && /^[A-Za-z]:"$/.test(arg) ? `${arg.slice(0, 2)}\\` : arg;
  return paths.resolve(cwd, repaired);
}

/**
 * The window's session secret (hunt C10), fresh per launch and apart from the token. Set as
 * TREEMAP_SESSION_COOKIE, it tells the server to hand no cookie to a page load and to accept only a
 * `treemap_session` cookie of this value: the server used to answer every `GET /` with the token
 * itself in a cookie, so any local program — another account's too — could take it.
 */
function sessionSecret() {
  return crypto.randomBytes(32).toString('hex');
}

/** The cookie main.js puts into the window's own session before it loads the page (Electron's cookies.set details). */
function sessionCookie(origin, secret) {
  return { url: origin, name: 'treemap_session', value: secret, httpOnly: true, sameSite: 'strict' };
}

/* ─────────────────────────── Names and numbers ─────────────────────────── */

/** The last path segment, on either separator; the path itself for a root. */
function folderName(p) {
  const s = String(p || '');
  const trimmed = s.replace(/[\\/]+$/, '');
  const last = trimmed.split(/[\\/]/).pop();
  return last || s;
}

const asCount = (n) => (Number.isFinite(Number(n)) && Number(n) >= 0 ? Number(n) : null);

/* ──────────────────────── Notifications (copy-3, -5) ──────────────────────── */

/**
 * The native banner for a scheduler alert. The headline names the folder and
 * the number that matters; the path goes in the body, after a sentence.
 *
 * The scheduler pushes two shapes through one channel: a growth alert
 * (prevSize → newSize, delta = the growth) and a disk-full forecast
 * (prevSize = newSize = free bytes, delta = bytes per day). `kind` tells them
 * apart when the server sets it; without it the shape does.
 */
function growthNotification(alert, formatBytes) {
  const a = alert && typeof alert === 'object' ? alert : {};
  const target = String(a.path || '');
  const name = folderName(target);
  const kind = a.kind === 'growth' || a.kind === 'forecast' ? a.kind : a.prevSize === a.newSize ? 'forecast' : 'growth';

  if (kind === 'forecast') {
    const free = asCount(a.prevSize) || 0;
    const perDay = asCount(a.delta) || 0;
    const given = asCount(a.days);
    const days = given ? Math.max(1, Math.round(given)) : perDay > 0 ? Math.max(1, Math.round(free / perDay)) : 0;
    const title =
      days > 0
        ? `The disk holding ${name} is full in about ${days} day${days === 1 ? '' : 's'}`
        : `The disk holding ${name} is filling up`;
    return { title, body: `${formatBytes(free)} free, growing ${formatBytes(perDay)} a day.\n${target}` };
  }

  const delta = Number(a.delta) || 0;
  const verb = delta < 0 ? 'shrank' : 'grew';
  const prev = asCount(a.prevSize) || 0;
  const next = asCount(a.newSize) || 0;
  return {
    title: `${name} ${verb} ${formatBytes(Math.abs(delta))} since the last scan`,
    body: `Was ${formatBytes(prev)}, now ${formatBytes(next)}.\n${target}`,
  };
}

/**
 * The banner for a scan that ended while the window was in the background.
 * `null` means "say nothing": the user pressed Stop themselves. `files` is the
 * page's files count — "files", since the page keeps "items" for files and
 * folders (review F1.6) — and `refused` the folders that could not be read,
 * which a partial scan says in the same breath, as the page's toast does
 * (review F1.8).
 */
function scanFinishedNotice(result, formatBytes) {
  if (!result || typeof result !== 'object' || result.stopped) return null;
  const target = String(result.path || '');
  const name = folderName(target) || 'the folder';
  if (result.ok) {
    const parts = [];
    const files = asCount(result.files);
    const bytes = asCount(result.bytes);
    const refused = asCount(result.refused);
    if (files !== null) parts.push(`${files.toLocaleString('en-US')} file${files === 1 ? '' : 's'}`);
    if (bytes !== null) parts.push(formatBytes(bytes));
    if (refused) parts.push(`${refused.toLocaleString('en-US')} folder${refused === 1 ? '' : 's'} could not be read`);
    const summary = parts.join(' · ');
    return { title: `Finished scanning ${name}`, body: summary ? `${summary}\n${target}` : target };
  }
  return {
    title: `Couldn't finish scanning ${name}`,
    body: result.error ? String(result.error) : 'Open TreeMap for details.',
  };
}

/* ───────────────────────── Dock / taskbar progress ───────────────────────── */

/**
 * Page contract → BrowserWindow.setProgressBar: 0…1 shows that fraction,
 * anything above 1 means "indeterminate" (Electron: 2), anything else clears.
 */
function progressBarValue(v) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return -1;
  return v > 1 ? 2 : v;
}

/* ───────────────────────────── Crash dialog ───────────────────────────── */

/**
 * The last-resort dialog. The stack goes to the log and to the clipboard
 * behind "Copy details"; the dialog itself says something a person can act on.
 */
function crashDialogFor(err, info) {
  const stack = err && typeof err === 'object' && err.stack ? String(err.stack) : String(err);
  const details = [
    `TreeMap ${info.version} · ${info.platform} ${info.arch} · Electron ${info.electron}`,
    '',
    stack,
  ].join('\n');
  return {
    message: 'TreeMap hit an unexpected error.',
    detail:
      'TreeMap keeps running. If this keeps happening, click Copy details and paste them into a bug report on GitHub — ' +
      'the details say exactly where it went wrong.',
    buttons: ['OK', 'Copy details'],
    defaultId: 0,
    cancelId: 0,
    copyIndex: 1,
    details,
  };
}

/* ───────────────────────────── About panel ───────────────────────────── */

/**
 * The credits name what the app is built on and bundles, and where those
 * licences are, on every platform: build.extraResources puts gdu/LICENSE.md,
 * gdu/THIRD_PARTY_NOTICES.txt (the Go modules and standard library inside
 * gdu, scripts/gdu-notices.js) and THIRD_PARTY_NOTICES.txt (the native core's
 * Rust crates and standard library, scripts/rust-notices.js) in the resources
 * folder; Electron's LICENSE.electron.txt and Chromium's
 * LICENSES.chromium.html are in that folder on macOS
 * (scripts/electron-licences.js puts them there) and beside it, next to the
 * executable, on Windows and Linux (electron-builder keeps them there). They
 * claim no more than that.
 */
function aboutPanelOptions({ version }) {
  return {
    applicationName: 'TreeMap',
    applicationVersion: version,
    copyright: 'Copyright © 2026 Prithvi Vinay · MIT License',
    credits:
      "See where your disk space goes, and get it back. Built on Electron and Chromium, and includes TreeMap's native scan core and gdu (MIT); their licences ship inside the app, in or beside its resources folder.",
    website: REPO_URL,
  };
}

/* ───────────────────────────── Update flow ───────────────────────────── */

/** Offer a version once per run, never the one that is running, never one the user skipped. */
function updateOffer({ version, current, skippedVersion, offered }) {
  if (!version || version === current) return false;
  if (skippedVersion && version === skippedVersion) return false;
  if (offered && offered.has(version)) return false;
  return true;
}

/**
 * The macOS offer. This build is unsigned, so TreeMap cannot install what it
 * downloads; the honest path is the download page plus the one thing that
 * trips people up afterwards — Gatekeeper's Open Anyway button and its clock.
 */
function updateDialogCopy({ version, current, arch }) {
  const dmg = `TreeMap-${version}-${arch}.dmg`;
  return {
    message: `TreeMap ${version} is available.`,
    detail:
      `You have ${current}. TreeMap can't install updates on macOS, so the download page will open in your browser: ` +
      `get "${dmg}", open it, and drag TreeMap into Applications.\n\n` +
      'macOS blocks the first launch of a downloaded copy. Open it once, then go to System Settings › Privacy & Security ' +
      'and click Open Anyway — that button stays for about an hour.',
    buttons: ['Download', 'Skip this version', 'Later'],
    defaultId: 0,
    cancelId: 2,
    downloadIndex: 0,
    skipIndex: 1,
  };
}

/* ───────────────────────────── Scan queue ───────────────────────────── */

/**
 * Folders handed to the shell (dock drops, a multi-folder drop on the window,
 * "Scan with TreeMap" on several selections, a second launch) scan one at a
 * time, in order. The page refuses to start a scan while one runs, so pushing
 * three paths at once would scan the first and lose the rest.
 *
 * `busy` is true while a scan runs — one this queue dispatched, or one the
 * page started itself and reported progress for — and clears when the page
 * reports the scan finished. `reset()` is for a page reload: whatever was
 * running is gone with the page, but what was asked for is still wanted.
 */
class ScanQueue {
  /** @param resolve (rawPath) → folder to scan, or null to ignore it */
  constructor(resolve) {
    this.resolve = resolve;
    this.pending = [];
    this.current = null;
    this.busy = false;
  }

  /** @returns {{ queued: string[], ignored: string[] }} in the order given */
  enqueue(rawPaths) {
    const queued = [];
    const ignored = [];
    for (const raw of Array.isArray(rawPaths) ? rawPaths : []) {
      const dir = typeof raw === 'string' && raw ? this.resolve(raw) : null;
      if (!dir || queued.includes(dir) || this.pending.includes(dir) || this.current === dir) {
        ignored.push(raw);
        continue;
      }
      queued.push(dir);
    }
    this.pending.push(...queued);
    return { queued, ignored };
  }

  /** The next folder to dispatch, or null while a scan runs or nothing waits. */
  next() {
    if (this.busy || this.pending.length === 0) return null;
    this.busy = true;
    this.current = this.pending.shift();
    return this.current;
  }

  /**
   * A scan is running. `dir` is the folder the page says it scans — then the
   * one being scanned, which is not queued to be walked again behind itself
   * (review F1.8): a scan the page started itself reached the shell with no
   * folder, so the same folder asked for from File › Scan folder…, the tray
   * or the Dock was queued, called "it scans next" and walked twice. `null`
   * is a scan of no folder the shell can name (a cloud account); leaving it
   * out keeps the folder the shell handed over.
   */
  markBusy(dir) {
    this.busy = true;
    if (dir !== undefined) this.current = dir;
  }

  finished() {
    this.busy = false;
    this.current = null;
  }

  /**
   * A Stop: every folder still waiting is dropped, not started — a Stop means
   * stop, and the next folder starting 300 ms after it meant pressing Stop
   * once per folder (review F1.1). Answers how many were waiting, which the
   * page says will not be scanned.
   */
  clear() {
    const dropped = this.pending.length;
    this.pending = [];
    return dropped;
  }

  reset() {
    this.busy = false;
    this.current = null;
  }
}

module.exports = {
  REPO_URL,
  RELEASES_URL,
  LATEST_RELEASE_URL,
  ISSUES_URL,
  desktopToken,
  desktopExec,
  scanArgPath,
  sessionSecret,
  sessionCookie,
  folderName,
  growthNotification,
  scanFinishedNotice,
  progressBarValue,
  crashDialogFor,
  aboutPanelOptions,
  updateOffer,
  updateDialogCopy,
  ScanQueue,
};
