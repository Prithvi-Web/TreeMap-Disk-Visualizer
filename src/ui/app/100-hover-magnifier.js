/* ══════════════════ v4 §6.4 — The hover magnifier ══════════════════

   Hold `Z`, or press the lens button, for a circular window over the cursor
   showing the tiles underneath at 4× with their names. A treemap of a real
   home folder has thousands of cells two pixels wide; they are not decoration,
   they are files, and until now the only way to read one was to drill in and
   lose your place.

   **Redrawn from the layout, not magnified from the canvas.** §6.4 asks for
   "rendered from the same layout, no re-layout, no extra data", and the
   difference is the whole feature: scaling the rendered bitmap four times
   gives four-times-larger blur, and the names — which are the reason to look —
   were never drawn at that size in the first place. Re-running the cells
   through the same fill and the same `cellRgb` at 4× gives crisp edges and
   labels that were never on the map at all.

   It reads `state.treemap.pxRects` / `state.treemap.cells`, which are exactly
   what the last paint produced. No layout runs, nothing is fetched, and the
   lens cannot show something the map is not showing.                          */

const LENS_SCALE = 4;
const LENS_RADIUS = 108;

/** Is the lens up? Either held with Z or pinned with the toolbar button. */
function lensActive() {
  return (state.lens.held || state.lens.pinned) && state.lens.at !== null;
}

/**
 * Everything the lens can draw, in painter's order.
 *
 * Shaped as `{ n, path(ctx), label }` so one drawing loop covers rectangles,
 * circles and Voronoi cells — the alternative is a third copy of the fill and
 * stroke logic that would drift from the two that already exist.
 */
function lensShapes() {
  if (isCells()) return state.treemap.cells.filter((c) => c.leaf || c.depth === 0);
  return state.treemap.pxRects;
}

/**
 * Draw the lens onto the visible canvas.
 *
 * Called after the blit, like every other overlay, so it costs one composite
 * and never touches the offscreen buffer the map itself lives in.
 */
function lensPaint(ctx, cssW, cssH) {
  if (!lensActive()) return;
  const cursor = state.lens.at;
  const r = Math.min(LENS_RADIUS, Math.min(cssW, cssH) * 0.42);
  if (!(r > 12)) return;
  /* The GLASS is clamped to stay whole; the MAGNIFICATION still happens about
     the cursor. Those are deliberately two different points.

     Letting the lens sit centred on the cursor is what a magnifier should do,
     right up to the edge of the map — where half the circle falls off the
     canvas and what is left reads as a rendering fault rather than as a lens.
     Clamping the circle but keeping the scale anchored on the pointer means
     the glass slides along the edge intact while the tile under the cursor
     stays exactly under the cursor, which is the property that makes a
     magnifier usable at all. */
  const mx = Math.max(r + 2, Math.min(cssW - r - 2, cursor.x));
  const my = Math.max(r + 2, Math.min(cssH - r - 2, cursor.y));

  ctx.save();
  // The glass itself: a hard circular clip, so the magnified world stops
  // exactly at the rim rather than fading into the map it sits over.
  ctx.beginPath();
  ctx.arc(mx, my, r, 0, Math.PI * 2);
  ctx.save();
  ctx.clip();
  ctx.fillStyle = cssVar('--tm-canvas-bg') || '#111';
  ctx.fillRect(mx - r, my - r, r * 2, r * 2);

  // Scale about the cursor, so whatever is under the pointer stays under it.
  ctx.translate(cursor.x, cursor.y);
  ctx.scale(LENS_SCALE, LENS_SCALE);
  ctx.translate(-cursor.x, -cursor.y);

  const half = r / LENS_SCALE + Math.hypot(mx - cursor.x, my - cursor.y) / LENS_SCALE + 2;
  const shapes = lensShapes();
  const labels = [];
  for (const s of shapes) {
    const b = s.bb
      ? { x0: s.bb.x0, x1: s.bb.x1, y0: s.bb.y0, y1: s.bb.y1 }
      : { x0: s.x, x1: s.x + s.w, y0: s.y, y1: s.y + s.h };
    if (b.x1 < cursor.x - half || b.x0 > cursor.x + half) continue;
    if (b.y1 < cursor.y - half || b.y0 > cursor.y + half) continue;
    const base = s.n.isTrash ? [108, 122, 137] : cellRgb(s.n);
    if (s.kind) {
      altCellPath(ctx, s);
    } else {
      ctx.beginPath();
      ctx.rect(b.x0, b.y0, Math.max(0.2, b.x1 - b.x0), Math.max(0.2, b.y1 - b.y0));
    }
    if (s.frame || (s.kind && !s.leaf)) {
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.lineWidth = 0.5;
      ctx.stroke();
      continue;
    }
    ctx.fillStyle = s.n.freed ? 'rgba(120,120,130,0.35)' : `rgb(${base[0]},${base[1]},${base[2]})`;
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.45)';
    ctx.lineWidth = 0.25;
    ctx.stroke();
    labels.push({ n: s.n, b });
  }
  ctx.restore(); // out of the magnified transform, still inside the clip

  // Labels are drawn UNMAGNIFIED, at their magnified positions. A name scaled
  // 4× is a name you can only fit two letters of; drawn at normal weight over
  // a tile that is now forty pixels wide, it is a name you can read.
  ctx.font = '600 10.5px -apple-system, sans-serif';
  ctx.textBaseline = 'middle';
  const toLens = (x, y) => ({
    x: cursor.x + (x - cursor.x) * LENS_SCALE,
    y: cursor.y + (y - cursor.y) * LENS_SCALE,
  });
  const placed = [];
  labels.sort((p, q) => (q.b.x1 - q.b.x0) * (q.b.y1 - q.b.y0) - (p.b.x1 - p.b.x0) * (p.b.y1 - p.b.y0));
  for (const l of labels) {
    const a = toLens(l.b.x0, l.b.y0), c = toLens(l.b.x1, l.b.y1);
    // Label the part of the tile that is ON THE GLASS, not the whole tile.
    // At 4× a cell often covers the entire lens, and its true centre is then
    // far outside it — which culled the label for exactly the tile the user
    // was pointing at, so the glass came up as two flat colours with no names
    // at all. Clipping to the visible patch first fixes it.
    const ax = Math.max(a.x, mx - r + 5), bx2 = Math.min(c.x, mx + r - 5);
    const ay = Math.max(a.y, my - r + 5), by2 = Math.min(c.y, my + r - 5);
    const w = bx2 - ax, h = by2 - ay;
    if (w < 26 || h < 11) continue;
    const cx = (ax + bx2) / 2, cy = (ay + by2) / 2;
    if (Math.hypot(cx - mx, cy - my) > r - 8) continue;
    const text = Canvas2D.fitText(ctx, l.n.name, Math.min(w - 6, r * 1.7));
    if (!text) continue;
    const tw = ctx.measureText(text).width;
    // One name per patch of glass: at 4× the tiles are big enough to read but
    // the lens is small enough that two names still collide often.
    if (placed.some((p) => Math.abs(p.x - cx) < (p.w + tw) / 2 + 3 && Math.abs(p.y - cy) < 12)) continue;
    placed.push({ x: cx, y: cy, w: tw });
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.strokeText(text, cx - tw / 2, cy);
    ctx.fillStyle = 'rgba(255,255,255,0.97)';
    ctx.fillText(text, cx - tw / 2, cy);
  }
  ctx.restore();

  // The rim, outside the clip, so it reads as a piece of glass lying on the
  // map rather than as a hole cut in it.
  ctx.save();
  ctx.beginPath();
  ctx.arc(mx, my, r, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(255,255,255,0.5)';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(mx, my, r + 1.5, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(0,0,0,0.45)';
  ctx.lineWidth = 2;
  ctx.stroke();
  // A specular sweep along the top left, which is where every other lit thing
  // in this app takes its light from.
  ctx.beginPath();
  ctx.arc(mx, my, r - 2, Math.PI * 1.02, Math.PI * 1.62);
  ctx.strokeStyle = 'rgba(255,255,255,0.34)';
  ctx.lineWidth = 2.5;
  ctx.stroke();
  ctx.restore();

  // The magnification badge goes INSIDE the glass, along the bottom rim. Below
  // it there is not always room: the lens is clamped to the panel, so at the
  // bottom edge a badge outside the circle is a badge off the canvas.
  ctx.save();
  ctx.font = '600 10px -apple-system, sans-serif';
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  Canvas2D.roundRect(ctx, mx - 13, my + r - 24, 26, 15, 7);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(`${LENS_SCALE}×`, mx, my + r - 16.5);
  ctx.restore();
}

/** Turn the lens on or off from the toolbar, and keep the button honest. */
function lensSetPinned(on) {
  state.lens.pinned = on;
  const btn = $('tmLensToggle');
  if (btn) {
    btn.setAttribute('aria-pressed', String(on));
    btn.classList.toggle('active', on);
  }
  fxTmPillBeamsSync(); // FX: pinned is a persistent mode — the sm ring says so
  presentView();
}

// View-mode toggle (Treemap ⇆ Sunburst), persisted in localStorage.
function setTreemapView(mode) {
  mode = TM_MODES.includes(mode) ? mode : 'treemap';
  state.treemap.mode = mode;
  const hist = state.treemap.history; // read before the reload lands and exits history
  lapseStop(); // §7.1 — a renderer switch ends playback; scrubbed position is re-dispatched below
  // §6.4 — the lens redraws from the drawn set, and the sunburst's is arcs,
  // which this does not know how to magnify. Turned off rather than left
  // pinned and silently doing nothing.
  if (mode === 'sunburst') { state.lens.held = false; lensSetPinned(false); }
  const lensBtn = $('tmLensToggle');
  if (lensBtn) lensBtn.disabled = mode === 'sunburst';
  lassoCancel();
  // Leaving a renderer drops what it drew. Otherwise the next hit test, cart
  // preview or lasso could answer with a shape that is no longer on screen.
  if (state.treemap.altZoomRaf) { cancelAnimationFrame(state.treemap.altZoomRaf); state.treemap.altZoomRaf = 0; }
  altRefineCancel();
  state.treemap.altZoom = null;
  state.treemap.cells = [];
  state.treemap.altNote = '';
  renderAltNote();
  localStorage.setItem('tm-viewmode', mode);
  for (const b of $('tmViewSeg').querySelectorAll('button'))
    b.setAttribute('aria-selected', String(b.dataset.vm === mode));
  state.treemap.hover = null;
  if (state.treemap.rootPath) {
    // A renderer switch keeps your place in history instead of silently
    // snapping to Live (QA D5): the live layout's landing exits history as
    // always, then the same index is re-dispatched for the new renderer.
    const wasAt = hist && hist.active ? hist.index : null;
    const load = loadTreemap(state.treemap.rootPath);
    if (wasAt !== null && load && typeof load.then === 'function') {
      load.then(() => {
        if (state.view === 'treemap' && state.treemap.mode === mode) lapseSeekTo(wasAt);
      }).catch(() => {});
    }
  }
}
$('tmViewSeg').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-vm]');
  if (btn) setTreemapView(btn.dataset.vm);
});
setTreemapView(state.treemap.mode); // reflect persisted choice on load

/* ───────────────────────────── Keyboard-first navigation (Feature 6) ───────────────────────────── */
function kbSiblings() {
  const root = state.pathIndex.get(state.treemap.rootPath) || state.root;
  if (!root || !root.children) return [];
  return [...root.children].filter((c) => c.size > 0).sort((a, b) => b.size - a.size);
}
function kbShowTip(node) {
  const rect = tmCanvas.getBoundingClientRect();
  let cx, cy;
  if (isSun()) {
    const arc = state.treemap.arcs.find((a) => a.n.path === node.path);
    if (!arc) { hideTooltip(); return; }
    const mid = (arc.a0 + arc.a1) / 2, rMid = (arc.rInner + arc.rOuter) / 2;
    cx = rect.left + arc.cx + Math.cos(mid) * rMid;
    cy = rect.top + arc.cy + Math.sin(mid) * rMid;
  } else if (isCells()) {
    const cell = state.treemap.cells.find((c) => c.n.path === node.path);
    if (!cell) { hideTooltip(); return; }
    cx = rect.left + cell.cx;
    cy = rect.top + cell.cy;
  } else {
    const pr = state.treemap.pxRects.find((p) => p.n.path === node.path);
    if (!pr) { hideTooltip(); return; }
    cx = rect.left + pr.x + pr.w / 2;
    cy = rect.top + pr.y + Math.min(pr.h / 2, 38);
  }
  const pct = state.treemap.rootSize > 0 ? (node.size / state.treemap.rootSize) * 100 : 0;
  showTooltip(cx, cy, node, pct);
}
function kbSelect(node) {
  state.treemap.kbSel = node || null;
  presentView();
  if (node) kbShowTip(node); else hideTooltip();
  // The highlight moves silently for a screen reader: the tooltip is
  // role=tooltip, not a live region. Say what is selected — name, kind, size
  // and share of this view — so Enter and Delete act on something the user
  // has been told about.
  const live = $('tmKbAnnounce');
  if (!live) return;
  if (!node) { live.textContent = ''; return; }
  const pct = state.treemap.rootSize > 0 ? (node.size / state.treemap.rootSize) * 100 : 0;
  live.textContent = `${node.name}, ${node.type === 'dir' ? 'folder' : 'file'}, ${formatBytes(node.size)}, ` +
    `${pct.toFixed(1)} percent of this view${cartHas(node.path) ? ', in cart' : ''}`;
}
/** After a drill or a climb: say where we are, ahead of what is selected there. */
function kbAnnounceRoot() {
  const live = $('tmKbAnnounce');
  if (live) live.textContent = `Now in ${state.treemap.rootName || state.treemap.rootPath}. ${live.textContent}`;
}
function kbMove(delta) {
  const sibs = kbSiblings();
  if (!sibs.length) return;
  let idx = state.treemap.kbSel ? sibs.findIndex((s) => s.path === state.treemap.kbSel.path) : -1;
  idx = idx < 0 ? (delta > 0 ? 0 : sibs.length - 1) : Math.max(0, Math.min(sibs.length - 1, idx + delta));
  kbSelect(sibs[idx]);
}
async function kbDrill() {
  const sel = state.treemap.kbSel;
  if (!sel) { const sibs = kbSiblings(); if (sibs.length) kbSelect(sibs[0]); return; }
  if (sel.type === 'dir') {
    await loadTreemap(sel.path, true);
    kbSelect(kbSiblings()[0] || null);
    kbAnnounceRoot();
  } else {
    openPreview(sel);
  }
}
async function kbUp() {
  const root = state.root;
  if (!root || !state.treemap.rootPath || state.treemap.rootPath === root.path) return;
  const oldRoot = state.treemap.rootPath;
  const crumbs = breadcrumbsFor(oldRoot);
  const parent = crumbs.length > 1 ? crumbs[crumbs.length - 2].path : root.path;
  await loadTreemap(parent, true);
  const sibs = kbSiblings();
  kbSelect(sibs.find((s) => s.path === oldRoot) || sibs[0] || null);
  kbAnnounceRoot();
}
function toggleShortcuts() {
  const m = $('shortcutsModal');
  // Never a second sheet on top of a first: with Settings open, "?" stacked
  // this on top, and Escape then closed Settings underneath it.
  if (!m.classList.contains('open') && topModal()) return;
  m.classList.toggle('open');
}

/* ── Zoom out (button, breadcrumbs already handle jumps) ── */
function treemapUp() {
  if (!state.root || !state.treemap.rootPath || state.treemap.rootPath === state.root.path) return;
  const crumbs = breadcrumbsFor(state.treemap.rootPath);
  if (crumbs.length > 1) loadTreemap(crumbs[crumbs.length - 2].path, true);
}
$('tmUpBtn').addEventListener('click', treemapUp);
