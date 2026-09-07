'use strict';
/* ═══════════════════════════════════════════════════════════════════════
   TreeMap frontend 2.0 — zero dependencies. Hand-rolled SVG icon system,
   buffered cushion-treemap canvas, virtual grid, paired light/dark themes.
   ═══════════════════════════════════════════════════════════════════════ */

/* ───────────────────────────── Utilities ───────────────────────────── */
const $ = (id) => document.getElementById(id);
const REDUCED = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
const UNITS = ['B','KB','MB','GB','TB','PB'];
function formatBytes(n, d = 1) {
  if (!Number.isFinite(n) || n < 0) return '0 B';
  let v = n, u = 0;
  while (v >= 1024 && u < UNITS.length - 1) { v /= 1024; u++; }
  // Rounding can carry a value up to exactly 1024 of its unit — "1024.0 KB",
  // "1024 B" — a figure no unit system prints. Roll it into the next unit,
  // which is what the rounded number means. Mirrors src/utils/formatBytes.ts.
  const shown = u === 0 ? Math.round(v) : Number(v.toFixed(d));
  if (shown >= 1024 && u < UNITS.length - 1) { v /= 1024; u++; }
  return u === 0 ? Math.round(v) + ' B' : v.toFixed(d) + ' ' + UNITS[u];
}
/* The interface is in English, so what it writes is English: counts "1,234"
   (formatCount, below) and dates "Sep 6, 2026" (DATE_FMT, WHEN_FMT and the
   few toLocale*String calls that name UI_LOCALE). A Portuguese machine used to
   show "1.234 shapes" beside "1.2 GB" — the same dot meaning thousands in one
   and tenths in the other — and "6 de set. de 2026" inside English sentences;
   an Arabic one printed Arabic-Indic digits (issue #34). What stays the
   machine's is its time zone and its 12- or 24-hour clock (HOUR_CYCLE): a
   reader's habit, not a dialect. Mirrors src/utils/formatCount.ts. */
const UI_LOCALE = 'en-US';
const HOUR_CYCLE = new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).resolvedOptions().hourCycle;
/* A count. Nothing (null, undefined) is 0; a numeric string is its number; a
   number that is not one (NaN, Infinity) prints the dash formatDate prints for
   no date, so a broken calculation is seen as broken rather than read as
   "none" — this app has printed a measured value as 0 before. */
function formatCount(n) {
  const v = typeof n === 'string' && n.trim() !== '' ? Number(n) : n;
  if (v === null || v === undefined) return '0';
  return typeof v === 'number' && Number.isFinite(v) ? v.toLocaleString(UI_LOCALE) : '–';
}
/* Platform words. /api/system says which OS this is (state.system.platform);
   until it has answered, or on an OS the table does not name, `other` is used.
   Every sentence that would name a Mac thing goes through here — issue #33 was
   a Windows machine reading about Time Machine, Full Disk Access and "This
   Mac". Keys: darwin, win32, linux, other (required). */
function platformWord(words) {
  // `state` is declared with const further down this bundle; before that line
  // has run, reading it throws even under typeof, so no OS is known yet.
  let p;
  try { p = state && state.system ? state.system.platform : undefined; } catch { p = undefined; }
  return p !== undefined && Object.prototype.hasOwnProperty.call(words, p) ? words[p] : words.other;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
/* One shared formatter + a memo: toLocaleDateString builds a fresh Intl
   formatter per call (~20µs), which alone cost ~35ms per long-list render. */
const DATE_FMT = new Intl.DateTimeFormat(UI_LOCALE, { year:'numeric', month:'short', day:'numeric' });
const dateMemo = new Map();
function formatDate(ms) {
  if (!ms) return '–';
  let s = dateMemo.get(ms);
  if (s === undefined) {
    s = DATE_FMT.format(ms);
    if (dateMemo.size > 20000) dateMemo.clear();
    dateMemo.set(ms, s);
  }
  return s;
}
/* The one short date-and-time dialect ("Sep 1, 10:31 PM", or "Sep 1, 22:31"
   on a 24-hour machine) for every surface that names a moment: the time
   slider, the history captions, the compare pickers. Memoised like formatDate
   — the compare view builds hundreds of option labels from it. */
const WHEN_FMT = new Intl.DateTimeFormat(UI_LOCALE, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: HOUR_CYCLE });
const whenMemo = new Map();
function formatWhen(ms) {
  if (!ms) return '–';
  let s = whenMemo.get(ms);
  if (s === undefined) {
    s = WHEN_FMT.format(ms);
    if (whenMemo.size > 5000) whenMemo.clear();
    whenMemo.set(ms, s);
  }
  return s;
}
/* A clock alone ("10:31 PM", or "22:31" on a 24-hour machine): the dashboard's
   "last scan" tile. Same words and same clock as formatWhen. */
const CLOCK_FMT = new Intl.DateTimeFormat(UI_LOCALE, { hour: '2-digit', minute: '2-digit', hourCycle: HOUR_CYCLE });
function formatClock(ms) { return CLOCK_FMT.format(ms); }
/* A day alone ("Sep 6"): chart axes, and the day a folder budget runs out. */
const DAY_FMT = new Intl.DateTimeFormat(UI_LOCALE, { month: 'short', day: 'numeric' });
function formatDay(ms) { return DAY_FMT.format(ms); }
function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }