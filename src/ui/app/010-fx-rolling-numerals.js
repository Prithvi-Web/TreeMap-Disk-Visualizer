/* ═══════════════ FX: Rolling Numerals ═══════════════ */
/* NumberFlow-style rolling numerals. A formatted value splits into digit
   runs and static text; each digit gets a masked slot whose 0–9 column
   glides to the target, so units, separators and labels hold still while
   the number itself rolls. The rules that keep it honest:
   - REDUCED (and a hidden document) snap to plain text — no slots exist.
   - A value whose printed SHAPE changed (different unit, different run
     count) snaps rather than fake continuity — except a genuine from-zero
     start, which rolls every column up from 0.
   - The DOM carries the real target: the in-flow sizer per slot is the
     final digit; the animated column is aria-hidden presentation.
   - A finished glide collapses back to the plain target string. The strips
     say nothing the string does not once they have stopped, and at rest
     the dashboard and cart carried several hundred leftover slot boxes
     through every later style recalc and layout. data-v / data-fxv are
     the resume points, so nothing is lost with them.
   FxNum.math is DOM-free so the suite exercises it in Node. */
const FxNum = (() => {
  /* The column transition is 560ms (140-fx-numerals.css); the settle waits
     past it. One timer per element: a newer roll re-arms it, and the
     `firstChild === root` guard makes a stale settle a no-op when a newer
     roll or a snap has already replaced the structure. A transitionend
     listener is not used because every column fires its own. */
  const ROLL_SETTLE_MS = 650;
  const math = {
    /** Maximal digit runs and the statics between them, in order. */
    tokenize(str) {
      const s = String(str);
      const out = [];
      const re = /[0-9]+/g;
      let i = 0, m;
      while ((m = re.exec(s))) {
        if (m.index > i) out.push({ s: s.slice(i, m.index) });
        out.push({ d: m[0] });
        i = m.index + m[0].length;
      }
      if (i < s.length) out.push({ s: s.slice(i) });
      return out;
    },
    /** The printed shape: every digit run collapsed to '#'. */
    skeleton(str) { return String(str).replace(/[0-9]+/g, '#'); },
    /** Digit runs only, in order. */
    runs(str) { return String(str).match(/[0-9]+/g) || []; },
    /** A same-shaped zero: what "nothing yet" prints as in this format. */
    zeroLike(str) { return String(str).replace(/[0-9]/g, '0'); },
    /**
     * Per-slot plan from one printed value to the next, or null when the
     * shapes differ. Slots follow the TARGET string; digit runs align from
     * the right (place value), and a digit with no counterpart rolls from
     * nothing — the column starts at 0.
     */
    plan(fromStr, toStr) {
      if (math.skeleton(fromStr) !== math.skeleton(toStr)) return null;
      const fromRuns = math.runs(fromStr);
      const slots = [];
      let r = 0;
      for (const tok of math.tokenize(toStr)) {
        if (tok.s != null) { for (const ch of tok.s) slots.push({ ch }); continue; }
        const from = fromRuns[r++] || '';
        const pad = tok.d.length - from.length;
        for (let i = 0; i < tok.d.length; i++) {
          slots.push({ from: i - pad >= 0 ? Number(from[i - pad]) : null, to: Number(tok.d[i]) });
        }
      }
      return slots;
    },
  };

  /** Build the slot DOM inside `el` and glide each column to its target. */
  function roll(el, fromStr, toStr) {
    if (!el) return;
    if (REDUCED || document.hidden || fromStr === toStr) { el.textContent = toStr; return; }
    const slots = math.plan(fromStr, toStr);
    if (!slots || !slots.some((s) => s.to != null && s.from !== s.to)) { el.textContent = toStr; return; }
    el.textContent = '';
    const root = document.createElement('span');
    root.className = 'fx-roll';
    const cols = [];
    for (const s of slots) {
      if (s.ch != null) { root.appendChild(document.createTextNode(s.ch)); continue; }
      const d = document.createElement('span');
      d.className = 'fx-roll-d';
      const sizer = document.createElement('span');
      sizer.className = 'fx-roll-sizer';
      sizer.textContent = String(s.to);
      const col = document.createElement('span');
      col.className = 'fx-roll-col';
      col.setAttribute('aria-hidden', 'true');
      for (let n = 0; n <= 9; n++) {
        const g = document.createElement('span');
        g.textContent = String(n);
        col.appendChild(g);
      }
      col.style.transform = `translateY(${-(s.from == null ? 0 : s.from)}em)`;
      d.append(sizer, col);
      root.appendChild(d);
      cols.push({ col, to: s.to });
    }
    el.appendChild(root);
    // One kicked frame, not a loop: the glide itself is a CSS transition.
    requestAnimationFrame(() => { for (const c of cols) c.col.style.transform = `translateY(${-c.to}em)`; });
    clearTimeout(el._fxSettle);
    el._fxSettle = setTimeout(() => { if (el.firstChild === root) el.textContent = toStr; }, ROLL_SETTLE_MS);
  }

  /**
   * Text surfaces that repaint in place. Rolls from the last string THIS
   * helper rendered, stored on the element — after a roll, textContent
   * contains the columns' presentation digits and cannot be trusted as
   * the old value. A first paint has no past to roll from, so it snaps.
   */
  function rollText(el, str) {
    if (!el) return;
    const prev = el.dataset.fxv;
    // Nothing to say: repainting the same string would replace the element's
    // children with plain text — a childList mutation that dirties style and
    // layout, and wipes a mid-roll column — for no visible change at all.
    // Callers repaint on every pointer frame; most frames say the same thing.
    if (prev === str) return;
    el.dataset.fxv = str;
    if (prev == null) { el.textContent = str; return; }
    roll(el, prev, str);
  }

  /**
   * innerHTML surfaces: rewrite, then roll ONLY the digit runs whose text
   * changed — and only when `key` says this paint describes the same
   * entity as the last one (a different scan or folder must snap, not
   * roll). A changed skeleton snaps too: the statics moved, so digit
   * continuity would be a lie.
   */
  function rollHtml(el, html, key) {
    if (!el) return;
    const prevKey = el.dataset.fxk;
    const prevText = el.dataset.fxt;
    el.innerHTML = html;
    const nowText = el.textContent;
    el.dataset.fxk = key == null ? '' : String(key);
    el.dataset.fxt = nowText;
    if (REDUCED || document.hidden || key == null || prevText == null) return;
    if (prevKey !== String(key) || prevText === nowText) return;
    if (math.skeleton(prevText) !== math.skeleton(nowText)) return;
    const oldRuns = math.runs(prevText);
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    let runIdx = 0;
    for (const tn of nodes) {
      const found = [];
      const re = /[0-9]+/g;
      let m;
      while ((m = re.exec(tn.nodeValue))) found.push({ i: m.index, run: m[0], idx: runIdx++ });
      // Right-to-left, so earlier offsets survive the splits.
      for (let k = found.length - 1; k >= 0; k--) {
        const f = found[k];
        const from = oldRuns[f.idx];
        if (from == null || from === f.run) continue;
        tn.splitText(f.i + f.run.length);
        const runNode = tn.splitText(f.i);
        const span = document.createElement('span');
        runNode.parentNode.replaceChild(span, runNode);
        roll(span, from, f.run);
      }
    }
  }

  return { math, roll, rollText, rollHtml };
})();

/** Animated numerals for stat surfaces: digits roll, units hold still.
    The historical contract stands — data-v is the resume point, REDUCED
    snaps — so existing call sites need no changes. */
function countUp(el, target, fmt = formatCount) {
  // data-v, not textContent: after a roll the element holds ten presentation
  // digits per column, so the DOM cannot say what was last shown. Without the
  // resume point every repaint replays the whole 0→N spin — including the
  // repaints that change nothing (renderCart runs on ~12 paths).
  const from = Number(el.dataset.v || 0);
  el.dataset.v = target;
  if (REDUCED || document.hidden || !Number.isFinite(target) || target === from) { el.textContent = fmt(target); return; }
  const toStr = fmt(target);
  let fromStr = fmt(from);
  // A genuine from-zero start rolls every column up from 0 instead of
  // snapping on the shape change ("0" prints shorter than "1,234,567").
  if (from === 0 && FxNum.math.skeleton(fromStr) !== FxNum.math.skeleton(toStr)) fromStr = FxNum.math.zeroLike(toStr);
  FxNum.roll(el, fromStr, toStr);
}
/* ═══ end FX: Rolling Numerals ═══ */

/* ───────────────────────────── Icon system (Lucide-style strokes) ───────────────────────────── */
const PATHS = {
  // Dashboard is a dial, not a third arrangement of rounded squares beside
  // Treemap and Grid (QA D03: at 16 px it read as Grid).
  dashboard: '<path d="m12 14 4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/>',
  treemap: '<rect x="3" y="3" width="9" height="18" rx="1.5"/><rect x="15" y="3" width="6" height="8" rx="1.5"/><rect x="15" y="14" width="6" height="7" rx="1.5"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/>',
  folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>',
  doc: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M16 13H8"/><path d="M16 17H8"/><path d="M10 9H8"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/>',
  video: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m10 9 5 3-5 3V9z"/>',
  audio: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
  archive: '<rect x="2" y="3" width="20" height="5" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/>',
  code: '<path d="m16 18 6-6-6-6"/><path d="m8 6-6 6 6 6"/>',
  box: '<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>',
  disc: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="2.5"/>',
  type: '<polyline points="4 7 4 4 20 4 20 7"/><line x1="9" y1="20" x2="15" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/>',
  external: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  copy: '<rect x="8" y="8" width="14" height="14" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
  moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
  sparkles: '<path d="M12 3l1.9 5.8a2 2 0 0 0 1.3 1.3L21 12l-5.8 1.9a2 2 0 0 0-1.3 1.3L12 21l-1.9-5.8a2 2 0 0 0-1.3-1.3L3 12l5.8-1.9a2 2 0 0 0 1.3-1.3L12 3z"/>',
  chevronRight: '<path d="m9 18 6-6-6-6"/>',
  chevronLeft: '<path d="m15 18-6-6 6-6"/>',
  arrowUp: '<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  checkCircle: '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
  alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  hardDrive: '<line x1="22" y1="12" x2="2" y2="12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/><line x1="6" y1="16" x2="6.01" y2="16"/><line x1="10" y1="16" x2="10.01" y2="16"/>',
  play: '<path d="M6 3l14 9-14 9V3z"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  loader: '<path d="M21 12a9 9 0 1 1-6.22-8.56"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  trendUp: '<path d="M16 7h6v6"/><path d="m22 7-8.5 8.5-5-5L2 17"/>',
  pie: '<path d="M21.21 15.89A10 10 0 1 1 8 2.83"/><path d="M22 12A10 10 0 0 0 12 2v10z"/>',
  activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  zap: '<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/>',
  gauge: '<path d="m12 14 4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/>',
  globe: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
  shield: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>',
  // v4 §4.3 — the "Preview after" toggle and its banner. eyeOff already
  // existed for the cloud-hiding control; this is its open-eye counterpart.
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><line x1="2" y1="2" x2="22" y2="22"/>',
  mouse: '<rect x="5" y="2" width="14" height="20" rx="7"/><path d="M12 6v4"/>',
  diff: '<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7"/><path d="M11 18H8a2 2 0 0 1-2-2V9"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
  settings: '<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  pause: '<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>',
  ban: '<circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/>',
  cart: '<circle cx="8" cy="21" r="1"/><circle cx="19" cy="21" r="1"/><path d="M2.5 2.5h2l2.6 12.4a2 2 0 0 0 2 1.6h9.7a2 2 0 0 0 2-1.6l1.6-7.4H5.1"/>',
  keyboard: '<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M6 14h.01M18 14h.01M10 14h4"/>',
  terminal: '<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>',
  cloud: '<path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/>',
  gitBranch: '<line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>',
  help: '<circle cx="12" cy="12" r="10"/><path d="M9.1 9.5a3 3 0 0 1 5.8 1c0 2-2.9 3-2.9 3"/><path d="M12 17h.01"/>',
  // QA D03 — Disk City had Apps' box, and Autopilot had Clean Up's sparkles.
  city: '<path d="M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18Z"/><path d="M6 12H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2"/><path d="M18 9h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2"/><path d="M10 6h4"/><path d="M10 10h4"/><path d="M10 14h4"/><path d="M10 18h4"/>',
  autopilot: '<path d="M12 8V4H8"/><rect x="4" y="8" width="16" height="12" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>',
};
function icon(name, size = 16, cls = '') {
  return `<svg class="ic ${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PATHS[name] || PATHS.file}</svg>`;
}
/* Hydrate every <span data-icon="…"> placeholder in static HTML. */
document.querySelectorAll('[data-icon]').forEach(el => { el.outerHTML = icon(el.dataset.icon, el.dataset.size ? +el.dataset.size : 16); });

/* File-kind mapping: icon + tint per extension family. */
const KIND = {
  dir:     { icon: 'folder',  tint: '#0A84FF' },
  image:   { icon: 'image',   tint: '#64D2FF' },
  video:   { icon: 'video',   tint: '#BF5AF2' },
  audio:   { icon: 'audio',   tint: '#FF375F' },
  archive: { icon: 'archive', tint: '#FF9F0A' },
  code:    { icon: 'code',    tint: '#30D158' },
  pdf:     { icon: 'doc',     tint: '#FF453A' },
  doc:     { icon: 'doc',     tint: '#0A84FF' },
  app:     { icon: 'box',     tint: '#5E5CE6' },
  disk:    { icon: 'disc',    tint: '#FFD60A' },
  font:    { icon: 'type',    tint: '#98989D' },
  file:    { icon: 'file',    tint: '#8E8E93' },
};
const EXT_KIND = {};
/** Every extension of the app's one type table under its kind (fourth browser
    pass, E11): the table is src/ui/markup/137-file-kinds.json, shipped above
    as #fileKindTable, and the server's plain-words table reads the same file —
    so "videos" means exactly what a video tile does. */
function fillExtKinds(table) {
  for (const [kind, exts] of Object.entries(table)) for (const e of exts) EXT_KIND[e] = kind;
}
fillExtKinds(JSON.parse(document.getElementById('fileKindTable').textContent));
function kindFor(node) {
  if (node.type === 'dir') return KIND.dir;
  return KIND[EXT_KIND[node.extension] || 'file'];
}
function chipFor(node, size = 15) {
  const k = kindFor(node);
  return `<span class="chip" style="--tint:${k.tint}">${icon(k.icon, size)}</span>`;
}

/* ───────────────────────────── Theme ───────────────────────────── */
/* Three choices (QA D67): System — follow the computer's light or dark setting
   as it changes, the default — or an explicit Light or Dark. 'tm-theme' in
   localStorage holds 'light' or 'dark'; absent means System. The head script
   applies the same rule before first paint. The sidebar button flips what you
   see to an explicit choice; Settings › Theme is the way back to System. */
const THEME_CHOICES = ['system', 'light', 'dark'];
const THEME_LABELS = { system: 'System', light: 'Light', dark: 'Dark' };
const osLightQuery = window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null;
function themeStored() {
  let v = null;
  try { v = localStorage.getItem('tm-theme'); } catch { v = null; }
  return v === 'light' || v === 'dark' ? v : 'system';
}
// Held here as well as stored: storage that refuses still gets this session's choice.
let themeChosen = themeStored();
/** What a choice shows: System is whatever the computer says now. */
function themeFor(choice, osLight) { return choice === 'system' ? (osLight ? 'light' : 'dark') : choice; }
function applyThemeButton() {
  const dark = document.documentElement.dataset.theme !== 'light';
  const btn = $('themeToggle');
  btn.innerHTML = icon(dark ? 'sun' : 'moon', 16);
  const words = `Theme: ${THEME_LABELS[themeChosen]}${themeChosen === 'system' ? ` (${dark ? 'dark' : 'light'} now)` : ''}` +
    ` — switch to ${dark ? 'light' : 'dark'}`;
  btn.title = words;
  btn.setAttribute('aria-label', words);
}
/** Settings › Theme shows the choice, whichever surface made it. */
function renderThemeChoice() {
  for (const c of THEME_CHOICES) {
    const radio = $(`themeChoice-${c}`);
    if (radio) radio.checked = c === themeChosen;
  }
}
function applyTheme(repaint = true) {
  const next = themeFor(themeChosen, !!(osLightQuery && osLightQuery.matches));
  const changed = document.documentElement.dataset.theme !== next;
  document.documentElement.dataset.theme = next;
  applyThemeButton();
  renderThemeChoice();
  if (changed && repaint) themeRepaint();
}
function setThemeChoice(choice) {
  themeChosen = THEME_CHOICES.includes(choice) ? choice : 'system';
  try {
    if (themeChosen === 'system') localStorage.removeItem('tm-theme');
    else localStorage.setItem('tm-theme', themeChosen);
  } catch { /* storage refused: applied for this session, not remembered */ }
  applyTheme();
}
$('themeToggle').addEventListener('click', () => {
  setThemeChoice(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light');
});
for (const c of THEME_CHOICES) {
  const radio = $(`themeChoice-${c}`);
  if (radio) radio.addEventListener('change', () => { if (radio.checked) setThemeChoice(c); });
}
// System follows the computer as it changes, not only when the page loads.
if (osLightQuery) osLightQuery.addEventListener('change', () => { if (themeChosen === 'system') applyTheme(); });
/** Repaint every surface that holds the old theme's ink. */
function themeRepaint() {
  // Colour changed; nothing moved. The two solvers behind §6.2 therefore
  // repaint rather than re-solve — see `repaintCells`.
  if (state.view === 'treemap' && drawnCells().length) { isCells() ? repaintCells() : drawView(); }
  // update({}) re-reads every theme token; geometry is unchanged. Every LIVE
  // handle must be here: a canvas keeps its rasterized ink until someone
  // redraws it, so any handle this list forgets stays in the old theme's
  // colors until an unrelated resize (the QA F3 defect, verbatim).
  if (donutHandle) donutHandle.update({});
  if (trendHandle) trendHandle.update({});
  for (const g of budgetGauges) g.update({});
  if (liveLineHandle) liveLineHandle.update({});
  if (dhGauge) dhGauge.update({});
  if (trendNetHandle) trendNetHandle.update({});
  if (appsScatterHandle) appsScatterHandle.update({});
  if (capsuleGaugeHandle) capsuleGaugeHandle.update({});
}
// The head script painted the theme already; this only labels the button and
// checks the Settings row (nothing is drawn yet, so nothing to repaint).
applyTheme(false);

/* ───────────────────────────── Sidebar ─────────────────────────────
   Expanded glass panel ⇄ icon rail. The preference persists, aria-expanded
   mirrors the state for assistive tech, and the chevron always points where
   the sidebar will go next.

   Below 900px the expanded panel can only OVERLAY the content (see the
   navScrim CSS), so the persisted pin applies only at widths where the real
   column fits: a narrow viewport renders the pin as the rail, narrow-width
   toggles are transient overlays (never persisted — a scrim tap must not
   clobber the pin), and widening past the breakpoint restores whatever the
   user actually pinned. */
const sideNavNarrow = window.matchMedia('(max-width: 900px)');
function sideNavPref() {
  try { return localStorage.getItem('tm-sidenav'); } catch { return null; /* private mode */ }
}
/** The toggle's tooltip, naming this keyboard's shortcut (renderKeyNames says it again once the OS is known). */
function sideNavTitle(collapsed) {
  return `${collapsed ? 'Expand navigation' : 'Collapse navigation'} (${keyCombo('B')})`;
}
function applySideNav(collapsed) {
  $('sideNav').classList.toggle('collapsed', collapsed);
  const btn = $('sideToggle');
  btn.setAttribute('aria-expanded', String(!collapsed));
  btn.setAttribute('aria-label', collapsed ? 'Expand the navigation' : 'Collapse the navigation');
  btn.title = sideNavTitle(collapsed);
  btn.innerHTML = icon(collapsed ? 'chevronRight' : 'chevronLeft', 16);
  // Only a wide-viewport choice is the pin; narrow states are transient.
  if (!sideNavNarrow.matches) {
    try { localStorage.setItem('tm-sidenav', collapsed ? 'rail' : 'open'); } catch { /* private mode */ }
  }
  scheduleSideNavReflow(); // every entry point — toggle, scrim, search summon
}
function toggleSideNav() {
  applySideNav(!$('sideNav').classList.contains('collapsed'));
}
$('sideToggle').addEventListener('click', toggleSideNav);
// Collapsing or expanding changes the content column's width — a thing only
// window resizes could do before the sidebar existed. The width-sensitive
// views (grid layout, treemap canvas, trends chart) already rebuild on
// resize, so replay their own signal once the width transition lands. The
// timer is not redundant: a hidden or occluded window freezes transitions,
// so transitionend can arrive arbitrarily late or not at all — the same
// reason the Liquid Glass engine keeps a timer beside its rAF. Replaying
// resize twice is harmless; never replaying it strands a stale layout.
$('sideNav').addEventListener('transitionend', (e) => {
  if (e.propertyName === 'width') window.dispatchEvent(new Event('resize'));
});
let sideNavReflowTimer = 0;
function scheduleSideNavReflow() {
  clearTimeout(sideNavReflowTimer);
  sideNavReflowTimer = setTimeout(() => window.dispatchEvent(new Event('resize')), 480);
}
// The rail's search icon is the search box in collapsed form: it opens the
// sidebar and puts the caret in the input, exactly like "/".
$('gsearchRailBtn').addEventListener('click', () => summonGlobalSearch());
// On narrow windows the expanded panel floats over a scrim; clicking the
// scrim puts the panel away, the way every sheet in the app already closes.
$('navScrim').addEventListener('click', () => applySideNav(true));
// Crossing the breakpoint re-decides what the pin means: entering narrow
// demotes an open COLUMN to the rail (the pin itself survives untouched);
// leaving narrow puts the pinned state back.
sideNavNarrow.addEventListener('change', (e) => {
  if (e.matches) {
    if (!$('sideNav').classList.contains('collapsed')) applySideNav(true);
  } else {
    applySideNav(sideNavPref() === 'rail');
  }
});
// A narrow window always boots on the rail: below 900px the expanded panel
// floats OVER the content, which is a fine state to toggle into but a rude
// one to wake up in.
applySideNav(sideNavPref() === 'rail' || sideNavNarrow.matches);

/* ───────────────────────────── Toasts ───────────────────────────── */
// How long a toast stays when its caller names no time: 4.2 s, or about 60 ms
// a character when that is longer, so a long sentence — a server's or a
// peer's refusal — can be read before it goes (BQL-a review F3.6).
const TOAST_MIN_MS = 4200;
const TOAST_MS_PER_CHAR = 60;
/* ── A toast raised over an open sheet, said in the sheet too (BQT item 26) ──
   Every sheet is a modal dialog (aria-modal="true"), and while focus is in one
   Chromium leaves what stands outside it out of the accessibility tree: the
   toast stack, outside every sheet, may then never be announced. So a toast
   raised while a sheet is open is also said in that sheet's own live region,
   #<sheet>ToastSaid, there from the start — the BQS way: emptied now and given
   the words a frame later, with those of every toast raised before that frame,
   so the same words again are a change too. A sheet closed by then says
   nothing: the stack is heard again. The region is emptied as the last of its
   toasts goes. With no sheet open the stack alone says a toast, as it always
   has. Answers what takes the words back as the toast goes, or null. */
const toastSheetSaid = new Map(); // a sheet's region → { words, waiting, up }: what it says, or is about to, for how many toasts
function toastSayInSheet(msg) {
  const top = typeof topModal === 'function' ? topModal() : null;
  const live = top ? $(top.id + 'ToastSaid') : null;
  if (!live) return null;
  let said = toastSheetSaid.get(live);
  if (said && said.waiting) said.words += ' ' + msg;
  else {
    const now = { words: String(msg), waiting: true, up: 0 };
    said = now;
    toastSheetSaid.set(live, now);
    live.textContent = '';
    requestAnimationFrame(() => {
      now.waiting = false;
      if (toastSheetSaid.get(live) === now && top.classList.contains('open')) live.textContent = now.words;
    });
  }
  said.up++;
  const mine = said;
  return () => {
    if (--mine.up > 0 || toastSheetSaid.get(live) !== mine) return;
    toastSheetSaid.delete(live);
    live.textContent = '';
  };
}
function toast(msg, kind = 'success', ms = Math.max(TOAST_MIN_MS, String(msg).length * TOAST_MS_PER_CHAR)) {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.innerHTML = icon(kind === 'error' ? 'alert' : 'checkCircle', 16) + '<span>' + escapeHtml(msg) + '</span>';
  // Raised over an open sheet, said in it too (above). Guarded: a page reader may lift this without it.
  const unsay = typeof toastSayInSheet === 'function' ? toastSayInSheet(msg) : null;
  $('toasts').appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => { el.remove(); if (unsay) unsay(); }, 320); }, ms);
}

/* ── Where the toasts stand (BQR-1 item 14) ──
   The stack rests at the bottom of the window (095-timeslider-floating.css),
   and the Treemap is fitted to the window: its footer — the size key, the
   counts and the hint, the only mention of the lasso, the magnifier and Esc —
   always stands in that lane, and a toast lay over it for as long as it was
   up (at 1024 × 700 a long error covered the hint line). While a toast is up
   the stack stands clear of the two lines the map says there, as the tour
   card does (ninth browser pass M02): the footer, and the match bar while it
   says something — at the lowest place above its rest that covers neither,
   raised by --toast-lift, which the stylesheet reads. The map itself is the
   view's surface, and the stack may stand over it as over any view's
   content. Where nothing is under it, or nowhere is clear, it rests. Its
   rest is read from its own box less any lift (offsetTop ignores
   transforms), so a placement asked for while it glides to the last one
   reads where it rests. While a dialog is open the stack stands at the top
   of the scrim and the stylesheet drops the lift: the lift is left as it is
   then, and placed again when the dialog goes. */
const TOAST_GAP = 12; // between the stack and the line it stands clear of
const TOAST_EDGE = 8; // the least room kept between it and the window's top
const TOAST_KEEP_CLEAR = '.view.active .tm-querybar:not(.idle), .view.active .tm-foot';
function toastPlace() {
  const stack = $('toasts');
  if (!stack.childElementCount) { stack.style.removeProperty('--toast-lift'); return; }
  if (document.querySelector('.modal-backdrop.open')) return;
  const box = stack.getBoundingClientRect(); // its sides: the lift moves it up and down only
  const h = stack.offsetHeight;
  const rest = stack.offsetTop + h; // its bottom edge, unraised
  const inWay = [...document.querySelectorAll(TOAST_KEEP_CLEAR)]
    .filter((el) => el.getClientRects().length > 0)
    .map((el) => el.getBoundingClientRect())
    .filter((r) => r.right > box.left && r.left < box.right && r.bottom > r.top);
  const clear = (lift) => rest - lift - h >= TOAST_EDGE && !inWay.some((r) => r.top < rest - lift && r.bottom > rest - lift - h);
  const lift = [0, ...inWay.map((r) => Math.round(rest - r.top + TOAST_GAP))].filter((l) => l >= 0).sort((a, b) => a - b).find(clear);
  if (!lift) stack.style.removeProperty('--toast-lift');
  else stack.style.setProperty('--toast-lift', lift + 'px');
}

/** toastPlace at the next frame, once however often it is asked for in one — and not at all with no toast up and no lift to take away. */
let toastPlaceRaf = 0;
function toastPlaceSoon() {
  const stack = $('toasts');
  if (toastPlaceRaf || (!stack.childElementCount && !stack.style.getPropertyValue('--toast-lift'))) return;
  toastPlaceRaf = requestAnimationFrame(() => { toastPlaceRaf = 0; toastPlace(); });
}
window.addEventListener('resize', toastPlaceSoon);
document.addEventListener('scroll', toastPlaceSoon, { capture: true, passive: true });
// A toast comes or goes (the stack changes size), the footer wraps anew or
// comes with its view, the match bar grows or shrinks, a dialog opens or
// closes. switchView and tmSyncQueryBar ask as well: a change of view, or of
// the bar's words, need not change any size.
if (typeof ResizeObserver !== 'undefined') {
  const toastRo = new ResizeObserver(toastPlaceSoon);
  for (const sel of ['#toasts', '#view-treemap .tm-foot', '#tmQueryBar']) {
    const el = document.querySelector(sel);
    if (el) toastRo.observe(el);
  }
}
if (typeof MutationObserver !== 'undefined') {
  const toastMo = new MutationObserver(toastPlaceSoon);
  document.querySelectorAll('.modal-backdrop').forEach((m) => toastMo.observe(m, { attributes: true, attributeFilter: ['class'] }));
}

/* ───────────────────────────── Size → color scale ─────────────────────────────
   The ramp anchors (teal → amber → red) are tuned for DARK surfaces; pure
   #FFD60A text is ~1.4:1 against the light theme's chips. Text uses of the
   scale (every size printed as text) therefore go through sizeInk() below,
   `color-mix(in srgb, <ramp> var(--size-ink), var(--text-1))`: --text-1 is
   near-black in light and near-white in dark, so the hue survives while
   contrast lands in both themes — with zero theme-change re-render plumbing. */
// The ramp runs from 1 MB to 10 GB, decimal like every size the page prints
// (QA D09) — the two figures the key under the map is labelled with.
const TIER_LO = Math.log10(1e6), TIER_HI = Math.log10(1e10);
function hexToRgb(h) { return [parseInt(h.slice(1,3),16), parseInt(h.slice(3,5),16), parseInt(h.slice(5,7),16)]; }
const C_TEAL = hexToRgb('#30D158'), C_AMBER = hexToRgb('#FFD60A'), C_RED = hexToRgb('#FF453A');
function mix(a, b, t) { return a.map((v, i) => Math.round(v + (b[i] - v) * t)); }
function sizeRgb(bytes) {
  const t = bytes <= 0 ? 0 : Math.max(0, Math.min(1, (Math.log10(bytes) - TIER_LO) / (TIER_HI - TIER_LO)));
  return t < 0.5 ? mix(C_TEAL, C_AMBER, t * 2) : mix(C_AMBER, C_RED, (t - 0.5) * 2);
}
function sizeColor(bytes, alpha = 1) {
  const c = sizeRgb(bytes);
  return `rgba(${c[0]},${c[1]},${c[2]},${alpha})`;
}
/**
 * The colour to PRINT a size in: the ramp, mixed toward the body ink by the
 * theme's --size-ink share. Every size badge and the tooltip's size use it;
 * sizeColor stays the fill colour (cells, bars). The Libraries and Apps
 * totals printed the raw ramp — amber on a white card, ~1.5:1 — and the
 * Dashboard's own 60% mix still measured 2.6:1 there (QA B21).
 * tests/polishVisualTheme.test.ts measures the whole ramp in both themes.
 */
function sizeInk(bytes) {
  return `color-mix(in srgb, ${sizeColor(bytes)} var(--size-ink), var(--text-1))`;
}

/* ── Age → color scale (heatmap mode): green = fresh … red = stale ── */
const C_ORANGE = hexToRgb('#FF9F0A');
const AGE_BANDS = [
  { maxDays: 30,       rgb: C_TEAL,   label: '&lt; 30 days' },
  { maxDays: 365,      rgb: C_AMBER,  label: '30–365 days' },
  { maxDays: 730,      rgb: C_ORANGE, label: '1–2 years' },
  { maxDays: Infinity, rgb: C_RED,    label: '&gt; 2 years' },
];
function ageRgb(modifiedAt) {
  const days = (Date.now() - (modifiedAt || 0)) / 86400000;
  for (const b of AGE_BANDS) if (days < b.maxDays) return b.rgb;
  return C_RED;
}
/* ══ Reclaim Score → color scale (v4 §3.3) ══
   Runs the OTHER way from the size ramp on purpose. Red means "big" on the
   size scale and would mean "safe to delete" here, which is the same colour
   carrying opposite advice on two views of the same tree. So low scores are
   the neutral grey of "leave this alone" and high scores climb to the teal
   the app already uses for good news. */
const C_RC_LOW = hexToRgb('#5A6472');
/** Outside the ramp: no score, as distinct from a score of zero. */
const C_RC_UNSCORED = hexToRgb('#3A4048');
function reclaimRgb(score) {
  const t = Math.max(0, Math.min(1, (Number(score) || 0) / 100));
  return t < 0.5 ? mix(C_RC_LOW, C_AMBER, t * 2) : mix(C_AMBER, C_TEAL, (t - 0.5) * 2);
}
function reclaimColor(score, alpha = 1) {
  const c = reclaimRgb(score);
  return `rgba(${c[0]},${c[1]},${c[2]},${alpha})`;
}
/**
 * The colour to PRINT a reclaim score in: the ramp mixed toward the body ink
 * by the theme's --reclaim-ink share, as sizeInk does for sizes. The badge,
 * the tooltip's score line and the breakdown's header printed the raw ramp,
 * 1.36:1 for a 50 on a light card (B21 review F1.7). The ramp itself
 * (reclaimRgb) stays the fill of the map's Reclaim mode and of Disk City.
 * tests/polishVisualTheme.test.ts measures every score the badge prints in
 * both themes.
 */
function reclaimInk(score) {
  return `color-mix(in srgb, ${reclaimColor(score)} var(--reclaim-ink), var(--text-1))`;
}
/* ── Diff overlay (time slider): green = grew, red = shrank vs previous snapshot ── */
const C_DIFF_SAME = [116, 122, 134];
function diffRgb(n) {
  if (n.prevSize === undefined) return C_DIFF_SAME; // no earlier snapshot to compare with
  if (n.prevSize === null) return C_TEAL;           // didn't exist before — pure growth
  const delta = n.size - n.prevSize;
  if (Math.abs(delta) <= Math.max(4096, n.prevSize * 0.005)) return C_DIFF_SAME;
  return delta > 0 ? C_TEAL : C_RED;
}

/** Cell base color for the active treemap color mode ('size' | 'age' | history diff). */
function cellRgb(n) {
  if (state.treemap.history.active) {
    // Age coloring is meaningless on snapshots (every node carries the
    // snapshot time), so history shows size — or the diff overlay.
    return state.treemap.history.diff ? diffRgb(n) : sizeRgb(n.size);
  }
  if (state.treemap.colorMode === 'age') return ageRgb(n.modifiedAt);
  if (state.treemap.colorMode === 'reclaim') {
    const fact = scoreFor(n.path);
    // Not yet fetched, or not scorable at all. Either way this cell has no
    // score, and painting it at the bottom of the ramp would say "leave this
    // alone" about a file nobody has assessed. The unscored grey is outside
    // the ramp entirely, and the legend names it.
    return fact ? reclaimRgb(fact.score) : C_RC_UNSCORED;
  }
  return sizeRgb(n.size);
}

/* ───────────────────────────── App state ───────────────────────────── */
/**
 * How many duplicate groups are drawn at once.
 *
 * Five hundred headers in one innerHTML write cost ~100 ms of blocked main
 * thread every time the tab was opened. The same windowed-render pattern the
 * near-duplicate view already uses brings it under the 50 ms budget, and the
 * count of what is not yet drawn is stated on the button rather than implied.
 */
const DUP_PAGE = 100;

const state = {
  view: 'dashboard',
  /** Largest Files ordering: by bytes, or by v4 §3's reclaim score. */
  bigFilesSort: localStorage.getItem('tm-bigfiles-sort') === 'reclaim' ? 'reclaim' : 'size',
  system: null,
  trash: null,
  snapshots: null,
  scanStats: null,
  scanId: null,
  // The id of the scan `root` came from, written beside it in finishScan. It
  // differs from scanId for exactly as long as a rescan is in flight, which is
  // the window in which Stop needs to know what to put back.
  settledScanId: null,
  // The tree an index paint replaced while that folder's scan runs, when a
  // scan of its own was behind it — its tree, scan, counters and lists — for
  // a Stop to put back (putBackHeldTree, seventh browser pass J06); null
  // otherwise. `over` is the index's tree that replaced it.
  heldBehindIndex: null,
  // True from the index paint (finishScan with no scan) until the scan chrome
  // next ends: the scan behind that tree is requested only as the paint
  // returns (startScan → startScanRequest), and finishScan has ended the scan
  // chrome by then, so `scanning` alone says no scan will land. What says
  // whether a scan of the tree on screen is coming reads it through
  // treeScanComing (015): Disk City's line, the Reclaim legend, every view's
  // "fills in once the scan finishes" (review F3.1, BQJ-1b).
  indexScanDue: false,
  scanning: false,
  es: null,
  // Settles the running scan's stream and watchdog together. followScanProgress
  // owns both in a closure, and Stop has to reach them: cancelling server-side
  // without this leaves the watchdog polling, and its 500 would overwrite the
  // user's own "stopped" message with a scan-failed one.
  abortScan: null,
  // Bumped by beginScanChrome, once per started scan. A scan request that
  // answers after its own generation has passed is an orphan — either the user
  // stopped it, or a newer scan has since claimed the chrome — and must be
  // cancelled rather than followed. state.scanning alone cannot tell those
  // apart from "the newer scan is running fine".
  scanGen: 0,
  // The generation whose scan request (POST /api/scan, /api/cloud/scan) was
  // sent last: while it is the running generation's and the request has not
  // answered, a Stop has a cancel still to come — sent, and its answer read,
  // when the request answers (abandonIfStopped) — so it says "Stopping…"
  // until then (review F1.2). A Stop before the request is sent stops it.
  scanRequestGen: 0,
  root: null,
  // The folder the start screen names (the owner, 17 Oct 2026): the last one
  // scanned, from the server (restoreLastSession), or the one whose scan was
  // just stopped or failed with nothing on screen (noteLastFolder) —
  // { path, size, at, outcome, reason, offered }. renderStartChoices paints it.
  lastFolder: null,
  // The folder the history names (restoreLastSession), in lastFolder's shape:
  // still offered after another folder's scan is stopped or fails, which takes
  // lastFolder (the owner, 20 Oct 2026; seventh browser pass J03).
  historyFolder: null,
  // The folder the running or last started scan is of (startScan,
  // startCloudScan): a Stop or a failure names it on the start screen.
  scanningPath: null,
  // The last Stop: the scan generation it ended and what it said on the start
  // screen (`noted`, or null) — read when the request that Stop ended answers
  // afterwards and its cancel is refused (abandonIfStopped, review F2.2).
  lastStop: null,
  // Whether this person has scanned before — a scan the server holds, or a
  // folder in the history (restoreLastSession). The tour reads it.
  scannedBefore: false,
  // The folders the start screen offers nowhere, under any name, this page
  // load, until a scan of one is taken (startChoiceList): those the server
  // refused a scan of (400, 403, 404; noteLastFolder, review F1.5), one whose
  // Stop the server would not confirm, which may still be walking
  // (noteStopUnconfirmed), and a last folder the server cannot open now
  // (restoreLastSession) — kept here, not only on lastFolder, which the next
  // Stop or failure replaces (review F2.5).
  refusedPaths: [],
  pathIndex: new Map(),
  // Nodes resolved from the server for paths the pruned tree doesn't carry.
  // A path that isn't in the scan is cached as null — a real answer, not a miss.
  nodeCache: new Map(),
  lastScan: null,
  largest: [],
  types: [],
  bigFolders: [],
  savedViews: [],
  savedViewsLoaded: false,
  treemap: { rootPath: null, rootName: '', rootSize: 0, nodes: [], nodesFor: null, pxRects: [], hover: null, maxDepth: 4, query: '', matches: 0, matchTotal: null, queryMode: 'bare', matchedPaths: null, colorMode: localStorage.getItem('tm-colormode') === 'age' ? 'age' : 'size', mode: localStorage.getItem('tm-viewmode') || 'treemap', arcs: [], sun: null, cells: [], altNote: '', altMs: 0, altZoom: null, altRaf: 0, kbSel: null, hideCloud: false, history: { active: false, scrubbing: false, snaps: [], index: 0, diff: false, cache: new Map(), seq: 0, viewingAt: 0, tree: null }, lapse: { playing: false, raf: 0, pos: 0, speed: 1, loop: false, seq: 0, onDone: null, completed: false } },
  // v4 §6.1 — Disk City. Deliberately holds NO tree of its own: the root and
  // the nodes are the Treemap's, so the two are the same arrangement rather
  // than two arrangements that resemble each other.
  city: { blocks: [], hover: null, pan: { x: 0, y: 0 }, zoom: 1, fit: 1, drawn: 0, total: 0, aggregated: 0,
          zoomTarget: 1, zoomRaf: 0, morphRaf: 0, morphStart: 0, painted: 0,
          contentBounds: { x0: -87, x1: 87, y0: -26, y1: 50 },
          height: localStorage.getItem('tm-cityheight') || 'staleness',
          colour: cityColourStored(),
          counts: new Map(), countsAsked: new Set(), unresolved: 0, raf: 0, drag: null },
  // v4 §6.3 / §6.4 — a lasso in flight, and the magnifier. Both are pure
  // overlays over whatever the current renderer last drew: neither holds a
  // tree, a layout or a request of its own.
  lasso: { on: false, pts: [] },
  lens: { held: false, pinned: false, at: null },
  grid: { path: null, sort: 'size', query: '', layout: [], totalH: 0, selection: new Set(), anchor: null, rangeStart: 0, rangeEnd: -1 },
  apps: { loadedFor: null, list: [], otherBytes: 0, totalBytes: 0, appsFolderScanned: false },
  games: { loadedFor: null, report: null }, media: { loadedFor: null, report: null },
  security: { loadedFor: null, report: null },
  cost: null,
  capsuleOff: false, // a portable session that saves nothing: the Undo Vault keeps no copy (D07)
  fleet: { data: null, timer: 0 },
  live: { on: false, wanted: false, es: null, engine: '', idleMinutes: 10, pulses: new Map(), window: [], dirty: 0, feedTimer: 0, relayoutTimer: 0, pulseRaf: 0 },
  offload: { index: null, q: '' },
  capsule: { index: null, q: '' },
  autopilot: { policies: null, runs: null, knownGroupIds: null },
  cloud: { providers: [], loaded: false },
  donut: { animated: false }, // segs/hover moved into the FxCharts.rings handle
  dup: { loadedFor: null, status: 'idle', groups: [], groupCount: 0, totalReclaimable: 0, selection: new Set(), pollTimer: 0, shown: DUP_PAGE },
  dupMode: 'exact',
  // renderedClusters / shownPerCluster drive the windowed render: how many
  // clusters are in the DOM, and how many images of each. Both reset per render.
  near: { loadedFor: null, status: 'idle', clusters: [], clusterCount: 0, totalReclaimable: 0, available: true, truncated: false, selection: new Set(), pollTimer: 0, renderedClusters: 0, shownPerCluster: {} },
  budgets: { list: [], overPaths: new Set(), gauges: new Map(), saved: null }, // saved: the settings' list, over a tree no scan stands behind (budgetFor)
  // v4 §9.5 — notes pinned to folders, path → { text, suppress, … }. Loaded
  // once at boot and kept current by the editor; scan-independent by design
  // (a note describes a folder, not a scan of it).
  notes: new Map(),
  trends: { roots: [], path: null, snapshots: [], forecastRate: null },
  compare: { options: [], result: null, notice: false }, // notice: the card speaks for the picks (E07)
  whatsNew: { seq: 0, dismissed: false },
  /** Platform capabilities from /api/platform/capabilities; null until loaded. */
  capabilities: null,
};
