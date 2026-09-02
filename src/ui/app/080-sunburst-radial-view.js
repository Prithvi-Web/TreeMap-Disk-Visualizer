/* ───────────────────────────── Sunburst / radial view (Feature 3) ───────────────────────────── */
function isSun() { return state.treemap.mode === 'sunburst'; }
function drawView() {
  if (isSun()) drawSunburst();
  else if (isCells()) drawCells();
  else drawTreemap();
  // The drawn set changes on every zoom, depth change, resize and rescan, so
  // the scores that back the Reclaim colour mode are re-asked for here rather
  // than only when the mode is switched on. `ensureScores` skips everything
  // already known, so the repeat calls after the first cost nothing.
  if (state.treemap.colorMode === 'reclaim') fetchScoresForTreemap();
}
function presentView(opts) {
  if (isSun()) presentSunburst();
  else if (isCells()) presentCells();
  else presentTreemap(opts && opts.clip);
}
function viewHit(cx, cy, leavesOnly) {
  if (isSun()) return sunburstHit(cx, cy);
  // The alternate renderers already answer with the deepest shape, which is
  // the leaf wherever there is one — so `leavesOnly` needs no second pass.
  if (isCells()) return cellsHit(cx, cy);
  return leavesOnly ? (treemapHit(cx, cy, true) || treemapHit(cx, cy)) : treemapHit(cx, cy);
}
function sunRingCount() { return Math.max(2, Math.min(7, state.treemap.maxDepth)); }

/** Annulus-sector sub-path from inner to outer radius across [a0,a1]. */
function sectorPath(ctx, cx, cy, rInner, rOuter, a0, a1) {
  ctx.beginPath();
  ctx.arc(cx, cy, rOuter, a0, a1, false);
  ctx.arc(cx, cy, rInner, a1, a0, true);
  ctx.closePath();
}

/** Live or historical (time slider) tree the sunburst should draw. */
function sunburstRoot() {
  if (state.treemap.history.active && state.treemap.history.tree) return state.treemap.history.tree;
  return state.pathIndex.get(state.treemap.rootPath) || state.root;
}

/** Size the canvas + buffer for the sunburst; returns the shared geometry. */
function sunburstGeometry() {
  const { cssW, cssH, dpr } = tmSizeCanvas();
  const rings = sunRingCount();
  const outerR = Math.max(60, Math.min(cssW, cssH) / 2 - 18);
  const innerR0 = outerR / (rings + 1);
  return { cssW, cssH, dpr, cx: cssW / 2, cy: cssH / 2, rings, outerR, innerR0, ringT: (outerR - innerR0) / rings };
}

/** Angular layout of `root` into arcs with final radii — no drawing. */
function layoutSunburstArcs(root, geo) {
  const minAngle = (0.8 / 180) * Math.PI;
  const START = -Math.PI / 2;
  const arcs = [];
  (function layout(node, depth, a0, a1) {
    if (depth > 0) arcs.push({ n: node, depth, a0, a1 });
    if (depth >= geo.rings || (node.type !== 'dir' && !node.container) || !node.children) return;
    const total = node.size;
    if (total <= 0) return;
    const kids = node.children.filter((c) => c.size > 0 && !(state.treemap.hideCloud && c.cloudPlaceholder)).sort((a, b) => b.size - a.size);
    let a = a0;
    const span = a1 - a0;
    for (const c of kids) {
      const cSpan = (c.size / total) * span;
      if (cSpan >= minAngle) layout(c, depth + 1, a, a + cSpan);
      a += cSpan;
    }
  })(root, 0, START, START + Math.PI * 2);

  arcs.sort((p, q) => p.depth - q.depth);
  for (const arc of arcs) {
    arc.cx = geo.cx; arc.cy = geo.cy;
    arc.rInner = geo.innerR0 + (arc.depth - 1) * geo.ringT;
    arc.rOuter = geo.innerR0 + arc.depth * geo.ringT;
  }
  return arcs;
}

/** Draw one full sunburst frame from prepared arcs (live draw and time-slider animation). */
function renderSunburstFrame(root, arcs, geo) {
  const ctx = tmBufCtx;
  ctx.setTransform(geo.dpr, 0, 0, geo.dpr, 0, 0);
  ctx.clearRect(0, 0, geo.cssW, geo.cssH);
  ctx.fillStyle = cssVar('--tm-canvas-bg');
  ctx.fillRect(0, 0, geo.cssW, geo.cssH);

  for (const arc of arcs) {
    const base = cellRgb(arc.n);
    const col = mix(base, [12, 12, 16], Math.min(0.4, arc.depth * 0.07));
    sectorPath(ctx, arc.cx, arc.cy, arc.rInner, arc.rOuter, arc.a0, arc.a1);
    ctx.fillStyle = `rgb(${col[0]},${col[1]},${col[2]})`;
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  // Labels on arcs wide enough to read.
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (const arc of arcs) {
    const sweep = arc.a1 - arc.a0;
    const rMid = (arc.rInner + arc.rOuter) / 2;
    if (sweep * rMid < 30 || geo.ringT < 13) continue;
    const mid = (arc.a0 + arc.a1) / 2;
    ctx.save();
    ctx.translate(arc.cx + Math.cos(mid) * rMid, arc.cy + Math.sin(mid) * rMid);
    let rot = mid;
    if (rot > Math.PI / 2 && rot < Math.PI * 1.5) rot += Math.PI;
    ctx.rotate(rot);
    ctx.font = '600 10px -apple-system, sans-serif';
    ctx.fillStyle = 'rgba(0,0,0,0.82)';
    const maxW = geo.ringT - 7;
    const label = arc.n.name;
    ctx.fillText(label, 0, 0, maxW);
    ctx.restore();
  }

  // Centre disc = current root (click to zoom out).
  ctx.beginPath();
  ctx.arc(geo.cx, geo.cy, geo.innerR0, 0, Math.PI * 2);
  ctx.fillStyle = cssVar('--surface-2') || '#1c1c22';
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.14)'; ctx.lineWidth = 1; ctx.stroke();
  ctx.fillStyle = cssVar('--text-1');
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.font = '600 12px -apple-system, sans-serif';
  const cname = root.name.length > 16 ? root.name.slice(0, 15) + '…' : root.name;
  ctx.fillText(cname, geo.cx, geo.cy - 7, geo.innerR0 * 1.8);
  ctx.fillStyle = cssVar('--text-2');
  ctx.font = '10px -apple-system, sans-serif';
  ctx.fillText(formatBytes(root.size), geo.cx, geo.cy + 9, geo.innerR0 * 1.8);

  state.treemap.arcs = arcs;
  state.treemap.sun = { cx: geo.cx, cy: geo.cy, innerR0: geo.innerR0, outerR: geo.outerR };
  const st = $('tmStatus');
  if (st) {
    st.textContent = state.treemap.history.active
      ? `Viewing ${new Date(state.treemap.history.viewingAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })} · ${formatBytes(root.size)} — drag the slider to Live to interact`
      : `${formatCount(arcs.length)} segments · ${geo.rings} rings · ${formatBytes(root.size)} total`;
  }

  presentSunburst();
  renderTmLegend();
}

function drawSunburst() {
  const geo = sunburstGeometry();
  const root = sunburstRoot();
  if (!root) {
    const ctx = tmBufCtx;
    ctx.setTransform(geo.dpr, 0, 0, geo.dpr, 0, 0);
    ctx.clearRect(0, 0, geo.cssW, geo.cssH);
    ctx.fillStyle = cssVar('--tm-canvas-bg');
    ctx.fillRect(0, 0, geo.cssW, geo.cssH);
    state.treemap.arcs = []; state.treemap.sun = null;
    presentSunburst();
    return;
  }
  renderSunburstFrame(root, layoutSunburstArcs(root, geo), geo);
}

/** Time-slider canvas interpolation: sweep the arcs into `newRoot`'s layout. */
function animateSunburstTo(newRoot) {
  cancelAnimationFrame(tmAnimFrame);
  const geo = sunburstGeometry();
  const target = layoutSunburstArcs(newRoot, geo);
  if (REDUCED || document.hidden || !state.treemap.arcs.length) { renderSunburstFrame(newRoot, target, geo); return; }
  const oldByPath = new Map(state.treemap.arcs.map((a) => [a.n.path, a]));
  const from = target.map((t) => {
    const o = oldByPath.get(t.n.path);
    if (o) return { a0: o.a0, a1: o.a1, rInner: o.rInner, rOuter: o.rOuter };
    const mid = (t.a0 + t.a1) / 2; // new entries sweep open from their midpoint
    return { a0: mid, a1: mid, rInner: t.rInner, rOuter: t.rOuter };
  });
  const t0 = performance.now(), dur = 260;
  const tick = (t) => {
    const p = Math.min(1, (t - t0) / dur);
    const e = 1 - Math.pow(1 - p, 3);
    const frame = target.map((a, i) => ({
      ...a,
      a0: from[i].a0 + (a.a0 - from[i].a0) * e,
      a1: from[i].a1 + (a.a1 - from[i].a1) * e,
      rInner: from[i].rInner + (a.rInner - from[i].rInner) * e,
      rOuter: from[i].rOuter + (a.rOuter - from[i].rOuter) * e,
    }));
    renderSunburstFrame(newRoot, frame, geo);
    if (p < 1) tmAnimFrame = requestAnimationFrame(tick);
    else renderSunburstFrame(newRoot, target, geo);
  };
  tmAnimFrame = requestAnimationFrame(tick);
}

function presentSunburst() {
  const dpr = window.devicePixelRatio || 1;
  tmCtx.setTransform(1, 0, 0, 1, 0, 0);
  tmCtx.clearRect(0, 0, tmCanvas.width, tmCanvas.height);
  tmCtx.drawImage(tmBuffer, 0, 0);
  const h = state.treemap.hover;
  if (h && h.arc) {
    tmCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const a = h.arc;
    sectorPath(tmCtx, a.cx, a.cy, a.rInner, a.rOuter, a.a0, a.a1);
    tmCtx.fillStyle = 'rgba(255,255,255,0.16)';
    tmCtx.fill();
    tmCtx.strokeStyle = cssVar('--accent') || '#0A84FF';
    tmCtx.lineWidth = 2;
    tmCtx.stroke();
  }
  const ks = state.treemap.kbSel;
  if (ks) {
    const arc = state.treemap.arcs.find((a) => a.n.path === ks.path);
    if (arc) {
      tmCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      sectorPath(tmCtx, arc.cx, arc.cy, arc.rInner, arc.rOuter, arc.a0, arc.a1);
      tmCtx.setLineDash([6, 3]); tmCtx.strokeStyle = '#fff'; tmCtx.lineWidth = 2;
      tmCtx.stroke(); tmCtx.setLineDash([]);
    }
  }
  drawLivePulses();
}

function angInRange(t, a0, a1) {
  const tau = Math.PI * 2;
  const norm = (x) => ((x % tau) + tau) % tau;
  t = norm(t); const s = norm(a0), e = norm(a1);
  return s <= e ? (t >= s && t <= e) : (t >= s || t <= e);
}
function sunburstHit(clientX, clientY) {
  const sun = state.treemap.sun;
  if (!sun) return null;
  const rect = tmCanvas.getBoundingClientRect();
  const x = clientX - rect.left - sun.cx, y = clientY - rect.top - sun.cy;
  const r = Math.hypot(x, y);
  if (r <= sun.innerR0) {
    const root = sunburstRoot();
    return root ? { n: root, center: true } : null;
  }
  if (r > sun.outerR) return null;
  const theta = Math.atan2(y, x);
  let best = null;
  for (const arc of state.treemap.arcs) {
    if (r >= arc.rInner && r <= arc.rOuter && angInRange(theta, arc.a0, arc.a1)) {
      if (!best || arc.depth > best.arc.depth) best = { n: arc.n, arc };
    }
  }
  return best;
}
