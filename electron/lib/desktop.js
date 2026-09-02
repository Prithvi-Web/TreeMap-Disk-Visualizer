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
 * that found the port could scan, trash and offload. The server already
 * enforces TREEMAP_TOKEN when it is set and hands the page its own session
 * cookie when it serves the UI, so a fresh random token per launch closes the
 * hole with no change to the page. An owner-provided token wins.
 */
function desktopToken(env) {
  const preset = env && typeof env.TREEMAP_TOKEN === 'string' ? env.TREEMAP_TOKEN : '';
  return preset.trim() ? preset : crypto.randomBytes(32).toString('hex');
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
 * `null` means "say nothing": the user pressed Stop themselves.
 */
function scanFinishedNotice(result, formatBytes) {
  if (!result || typeof result !== 'object' || result.stopped) return null;
  const target = String(result.path || '');
  const name = folderName(target) || 'the folder';
  if (result.ok) {
    const parts = [];
    const files = asCount(result.files);
    const bytes = asCount(result.bytes);
    if (files !== null) parts.push(`${files.toLocaleString('en-US')} items`);
    if (bytes !== null) parts.push(formatBytes(bytes));
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

function aboutPanelOptions({ version }) {
  return {
    applicationName: 'TreeMap',
    applicationVersion: version,
    copyright: 'Copyright © 2026 Prithvi Vinay · MIT License',
    credits: 'See where your disk space goes, and get it back. Bundles gdu (MIT).',
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
    buttons: ['Download', 'Skip This Version', 'Later'],
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

  markBusy() {
    this.busy = true;
  }

  finished() {
    this.busy = false;
    this.current = null;
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
