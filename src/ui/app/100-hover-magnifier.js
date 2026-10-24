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

/** A tile's texture as the map lays it (r.tex): its seams in the shade of its cushion, over the tile's height. */
function lensTexture(ctx, s) {
  ctx.fillStyle = tmLeafFill(ctx, s.tex.stops, s.y, s.h);
  for (const [x, y, w, h] of s.tex.rects) ctx.fillRect(x, y, w, h);
}

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
  const framed = []; // the rectangle map's folders on the glass, whose bands go over their leaves
  const lined = []; // its leaves on the glass with lines of their own, laid after every tile, as pass 2.6 lays them
  // The top-level folders' name tags the map laid (pass 3), on the rectangle map only.
  const tags = isCells() ? [] : state.treemap.tags || [];
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
    if (s.kind && !s.leaf) {
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.lineWidth = 0.5;
      ctx.stroke();
      continue;
    }
    if (s.frame) {
      // A folder as the map paints it (review F1.2): its own fill where no
      // rectangle covers it (J51, pass 0), under what is drawn in it — the
      // server lists a folder before its contents — and its bands (pass 2.7)
      // after every leaf, below. It showed the ground where the map shows the
      // folder's colour, under a faint white line. A folder an online-only
      // file is hidden in is cleared to the ground, as the map clears it: the
      // fill of a folder above it does not show there (review F2.1).
      if (s.showsGround) {
        ctx.clearRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0);
        ctx.fillStyle = cssVar('--tm-canvas-bg') || '#111';
        ctx.fill();
      }
      if (s.bg) { ctx.fillStyle = tmLeafFill(ctx, s.bg, b.y0, b.y1 - b.y0); ctx.fill(); }
      if (s.tex) lensTexture(ctx, s);
      if (s.bands) framed.push(s);
      continue;
    }
    const w = b.x1 - b.x0, h = b.y1 - b.y0;
    if (!s.kind && s.shows) {
      // A staged block or a hollow cloud cell: the map clears it to its
      // ground, so a folder's fill does not show through what is not there.
      ctx.clearRect(b.x0, b.y0, w, h);
      ctx.fillStyle = cssVar('--tm-canvas-bg') || '#111';
      ctx.fill();
    }
    // A rectangle is painted with the map's own leaf recipe — the opaque,
    // full-strength cushion (G01), as pass 1 eased it for the tile's label
    // (s.stops) — so the glass shows the colour the map shows; when the two
    // recipes differed the glass read bright green over an olive map (QA
    // D39). Circles and Voronoi cells are opaque on the map too; a hollow
    // cloud cell is its faint wash over the ground, as on the map.
    ctx.fillStyle = s.n.freed ? 'rgba(120,120,130,0.35)'
      : s.kind ? `rgb(${base[0]},${base[1]},${base[2]})`
      : s.shows ? `rgba(${base[0]},${base[1]},${base[2]},0.16)`
      : tmLeafFill(ctx, s.stops || tmLeafStops(base, h), b.y0, h);
    ctx.fill();
    // A small leaf's texture as the map lays it (pass 2.4).
    if (!s.kind && s.tex) lensTexture(ctx, s);
    if (!s.kind && s.lines) {
      // Its lines as the map draws them (pass 2.6, tmLeafLines), below — each
      // stretch in the shade the map picked, inside its box — and the
      // highlight along its top under a dark one, part of its tile.
      lined.push(s);
      if (s.lit) {
        const lit = tmLitLine(s);
        ctx.lineWidth = lit.width;
        ctx.strokeStyle = `rgba(255,255,255,${tmLitAlpha(s)})`;
        ctx.beginPath();
        ctx.moveTo(lit.x0, lit.y); ctx.lineTo(lit.x1, lit.y);
        ctx.stroke();
      }
    } else {
      // A tile the map leaves without lines of its own (too small for them,
      // or a cell) keeps a hairline of the glass, so the tiles it magnifies
      // stay apart: on the rectangle map in a shade of its own colour that
      // reaches TM_EDGE_MIN against it, as the map's lines do (the owner's
      // outline decision); a black hairline at 0.45 was lost on a dark tile.
      const tone = s.kind ? null : tmTone(base, s.seen || s.shows || [base], TM_EDGE_MIN).rgb;
      ctx.strokeStyle = tone ? `rgb(${tone[0]},${tone[1]},${tone[2]})` : 'rgba(0,0,0,0.45)';
      ctx.lineWidth = 1 / LENS_SCALE;
      ctx.stroke();
    }
    labels.push({ n: s.n, b });
  }
  // Each leaf's lines, then each folder's bands, deepest folder first, as
  // passes 2.6 and 2.7 lay them — both stopping at the name tags, as on the
  // map (tmClipOutTags); then the tags themselves, as pass 3 lays them. The
  // glass drew no tag, and the lines ran on where the map has one (residual 8).
  ctx.save();
  if (tags.length) tmClipOutTags(ctx, tags, cssW, cssH);
  for (const s of lined) {
    for (const l of s.lines) {
      ctx.fillStyle = l.rgb;
      ctx.fillRect(l.x, l.y, l.w, l.h);
    }
  }
  for (const f of tmFramesDeepestFirst(framed)) {
    for (const band of f.bands) {
      ctx.fillStyle = band.rgb;
      ctx.fillRect(band.x, band.y, band.w, band.h);
    }
  }
  ctx.restore();
  ctx.textBaseline = 'middle';
  ctx.font = '600 10.5px -apple-system, sans-serif';
  for (const t of tags) tmLayTag(ctx, t);
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
    // Not on a name tag, as on the map, where a label goes below its folder's tag (tmLabelLines).
    if (tags.some((t) => {
      const p = toLens(t.x, t.y), q = toLens(t.x + t.w, t.y + t.h);
      return cx - tw / 2 < q.x && cx + tw / 2 > p.x && cy - 6 < q.y && cy + 6 > p.y;
    })) continue;
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
  // The footer's hint offers the lasso and the Z lens only where they work:
  // lassoAvailable() and the Z key both refuse the sunburst (hunt C28).
  const flatHint = $('tmHintFlat');
  if (flatHint) flatHint.hidden = mode === 'sunburst';
  lassoCancel();
  // Leaving a renderer drops what it drew. Otherwise the next hit test, cart
  // preview or lasso could answer with a shape that is no longer on screen.
  if (state.treemap.altZoomRaf) { cancelAnimationFrame(state.treemap.altZoomRaf); state.treemap.altZoomRaf = 0; }
  altRefineCancel();
  state.treemap.altZoom = null;
  state.treemap.cells = [];
  // The rectangles and arcs too: j/k, Enter, c and Delete read what was drawn
  // (kbSiblings), and until the new renderer draws, the last rectangle map's
  // or sunburst's — another folder's, nowhere on screen — were offered (review L9).
  state.treemap.pxRects = [];
  state.treemap.arcs = [];
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
    // A query in the box is applied again once the new renderer has drawn:
    // what the box said of it — "3 shown here", or that the sunburst
    // highlights none — was said of the renderer just left (hunt C20). A
    // grammar query is asked again; a plain word is the page's own filter,
    // asked of no server, and its words follow the renderer too (review F1.8).
    // Not over text typed since, which its own debounce applies: applying the
    // older text cancelled that debounce, and the box showed one query while
    // the map showed another. Whatever applies a query puts it in the box first.
    const q = state.treemap.query;
    if (q && q.trim() && load && typeof load.then === 'function') {
      load.then(() => {
        if (state.view === 'treemap' && state.treemap.mode === mode && state.treemap.query === q && $('tmSearch').value === q) tmApplyQuery(q);
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
/**
 * What j/k move through: the top level of the folder on screen (hunt C02),
 * as the renderer on screen drew it — its rectangles, arcs or shapes there,
 * biggest first. The rectangle map's are laid out by the server from the
 * whole scan, and the page's tree holds a folder the first frame pruned with
 * no children, so read from the tree j/k did nothing there, and a level
 * further, in a folder the tree never held, moved through the scan root's
 * folders, none of them on screen, for Enter, c and Delete to act on. Read
 * from what was drawn, not from what was laid out: Hide cloud hides an
 * online-only file, the rectangle map paints nothing under a device pixel and
 * the sunburst no arc under 0.8°, and j stopped on, announced and offered to
 * act on each of them with nothing on screen (review F1.2). Not the Trash
 * cell, nor a preview's staged block: neither is an item here. The sunburst
 * and the cells draw from the page's tree (loadTreemap fetches what they
 * show), and a folder it does not hold gives nothing, never the scan root's.
 */
function kbSiblings() {
  const sun = isSun(), cells = isCells();
  if ((sun || cells) && !(state.treemap.rootPath ? state.pathIndex.get(state.treemap.rootPath) : state.root)) return [];
  const drawn = (sun ? state.treemap.arcs : cells ? state.treemap.cells : state.treemap.pxRects) || [];
  // An arc and a cell carry their ring or level; a rectangle, its node's depth in the map.
  return drawn.filter((s) => (sun || cells ? s.depth : s.n.depth) === 1 && !s.n.isTrash && !s.n.freed && s.n.size > 0)
    .map((s) => s.n).sort((a, b) => b.size - a.size);
}
/** Where the keyboard's selected cell sits on screen — the point its card, and its menu, open at — or null when it is not drawn. */
function kbCellPoint(node) {
  const rect = tmCanvas.getBoundingClientRect();
  if (isSun()) {
    const arc = state.treemap.arcs.find((a) => a.n.path === node.path);
    if (!arc) return null;
    const mid = (arc.a0 + arc.a1) / 2, rMid = (arc.rInner + arc.rOuter) / 2;
    return { x: rect.left + arc.cx + Math.cos(mid) * rMid, y: rect.top + arc.cy + Math.sin(mid) * rMid };
  }
  if (isCells()) {
    const cell = state.treemap.cells.find((c) => c.n.path === node.path);
    return cell ? { x: rect.left + cell.cx, y: rect.top + cell.cy } : null;
  }
  const pr = state.treemap.pxRects.find((p) => p.n.path === node.path);
  return pr ? { x: rect.left + pr.x + pr.w / 2, y: rect.top + pr.y + Math.min(pr.h / 2, 38) } : null;
}
function kbShowTip(node) {
  const p = kbCellPoint(node);
  if (!p) { hideTooltip(); return; }
  const pct = state.treemap.rootSize > 0 ? (node.size / state.treemap.rootSize) * 100 : 0;
  showTooltip(p.x, p.y, node, pct);
}
/**
 * The ContextMenu key or Shift+F10 on the map (QA fourth pass E05): the menu
 * of the cell the keyboard selected (j/k), at that cell — what a right-click
 * on it opens, refused where a right-click is (a map of history, a preview)
 * and the Trash sheet for the Trash's cell. Answers whether anything opened.
 */
function tmCanvasKeyMenu() {
  const n = state.treemap.kbSel;
  if (!n || state.treemap.history.active || tmPreview.on) return false;
  const p = kbCellPoint(n);
  if (!p) return false;
  if (n.isTrash) { openTrashModal(); return true; }
  showCtxMenu(p.x, p.y, n);
  return true;
}
/**
 * The keyboard selection's card belongs to the map (QA D63).
 *
 * kbShowTip anchors it to a cell, and only map navigation ever took it down:
 * after j picked "Archives", its card floated on over the cart panel and
 * through Preview after. So anything that takes the user somewhere else takes
 * it down too — a press or a focus landing anywhere but the map while the map
 * is the view, and the map itself losing focus. A press ON the map is the
 * map's own business: hover and click already manage the card there.
 */
function tmTipDismiss(e) {
  if (state.view !== 'treemap' || e.target === tmCanvas) return;
  hideTooltip();
}
document.addEventListener('pointerdown', tmTipDismiss, true);
document.addEventListener('focusin', tmTipDismiss, true);
tmCanvas.addEventListener('blur', hideTooltip);
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
/**
 * The keyboard's selection, dropped when the map now drawn no longer draws it
 * (review L3): Hide cloud hid it, a Live re-layout left it out, or a key
 * pressed between a click and its map landing picked it from the folder
 * before. c, Delete, p, n and Enter still acted on it, with nothing on screen.
 * Called by each painter as it sets what it draws — drawTreemap, drawCells,
 * renderSunburstFrame, which a Live re-layout, a morph and the time-lapse
 * reach with no drawView (review F1.3, F1.5, F1.7) — and after every drawView.
 */
function kbDropUndrawn() {
  const ks = state.treemap.kbSel;
  if (!ks || drawnCells().some((s) => s.n.path === ks.path)) return;
  state.treemap.kbSel = null;
  hideTooltip(); // its card goes with it (QA D63)
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
