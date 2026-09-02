'use strict';
/*
 * Window placement and the desktop prefs file. Pure and Electron-free, so it
 * can be tested under plain Node; main.js supplies the displays (from
 * `screen`) and the data directory (the backend's `appDataDir()`, which
 * already follows TREEMAP_DATA_DIR and portable mode).
 *
 * The prefs file (`desktop-prefs.json` in the app-data dir) holds:
 *   { window: { x, y, width, height, maximized, fullScreen, displayId },
 *     skippedUpdate: '4.2.0' }
 * It is written atomically (temp file + rename) and never in an ephemeral
 * portable session — a read-only medium means TreeMap promised to write
 * nothing anywhere.
 */
const fs = require('fs');
const path = require('path');

const PREFS_FILE = 'desktop-prefs.json';

function readPrefs(dir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, PREFS_FILE), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {}; // missing or unreadable: "nothing saved", never a crash at launch
  }
}

/** @returns {boolean} whether anything was written */
function writePrefs(dir, prefs, { ephemeral = false } = {}) {
  if (ephemeral) return false;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, PREFS_FILE);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(prefs, null, 2));
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false; // a prefs write must never take the window down with it
  }
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), Math.max(lo, hi));

function overlapArea(a, b) {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/**
 * Where the window should open.
 *
 * @param saved the `window` entry from the prefs file (or nothing)
 * @param displays `screen.getAllDisplays()` — the first is the primary
 * @param defaults { width, height, minWidth, minHeight }
 * @returns {{ x?: number, y?: number, width: number, height: number, maximized: boolean, fullScreen: boolean }}
 *   Without x/y Electron centres the window on the primary display.
 *
 * A saved rectangle is kept only when it overlaps a display that is still
 * attached; it is then pulled inside that display's work area and shrunk to
 * fit it, and never smaller than the minimum size. Anything else — a monitor
 * that is unplugged, a corrupt file — gives the default size, itself shrunk
 * to the primary work area so a 1320px default never hangs off a 1280px screen.
 */
function windowStateFor(saved, displays, defaults) {
  const primary = displays[0];
  const base = {
    width: Math.min(defaults.width, primary.workArea.width),
    height: Math.min(defaults.height, primary.workArea.height),
    maximized: false,
    fullScreen: false,
  };
  const s = saved && typeof saved === 'object' ? saved : null;
  if (!s) return base;
  const maximized = s.maximized === true;
  const fullScreen = s.fullScreen === true;
  const x = num(s.x);
  const y = num(s.y);
  const w = num(s.width);
  const h = num(s.height);
  if (x === null || y === null || w === null || h === null) return { ...base, maximized, fullScreen };

  const rect = { x, y, width: Math.max(w, 1), height: Math.max(h, 1) };
  let best = null;
  let bestArea = 0;
  for (const d of displays) {
    const area = overlapArea(rect, d.workArea);
    if (area > bestArea) {
      best = d;
      bestArea = area;
    }
  }
  if (!best) return { ...base, maximized, fullScreen };

  const wa = best.workArea;
  const width = Math.min(Math.max(rect.width, defaults.minWidth), wa.width);
  const height = Math.min(Math.max(rect.height, defaults.minHeight), wa.height);
  return {
    x: clamp(rect.x, wa.x, wa.x + wa.width - width),
    y: clamp(rect.y, wa.y, wa.y + wa.height - height),
    width,
    height,
    maximized,
    fullScreen,
  };
}

/** The state to persist for a live window. */
function stateOfWindow(win, displayId) {
  return {
    ...win.getNormalBounds(),
    maximized: win.isMaximized(),
    fullScreen: win.isFullScreen(),
    displayId,
  };
}

module.exports = { PREFS_FILE, readPrefs, writePrefs, windowStateFor, stateOfWindow };
