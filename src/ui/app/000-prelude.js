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
  if (n < 1024) return Math.round(n) + ' B';
  let v = n, u = 0;
  while (v >= 1024 && u < UNITS.length - 1) { v /= 1024; u++; }
  return v.toFixed(d) + ' ' + UNITS[u];
}
function formatCount(n) { return (n ?? 0).toLocaleString(); }
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
/* One shared formatter + a memo: toLocaleDateString builds a fresh Intl
   formatter per call (~20µs), which alone cost ~35ms per long-list render. */
const DATE_FMT = new Intl.DateTimeFormat(undefined, { year:'numeric', month:'short', day:'numeric' });
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
function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }