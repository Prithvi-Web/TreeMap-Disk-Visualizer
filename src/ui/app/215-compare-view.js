/* ───────────────────────────── Compare view ───────────────────────────── */
async function loadCompareOptions() {
  try {
    const [scansRes, snapsRes] = await Promise.all([api('/api/scans'), api('/api/snapshots?all=true')]);
    const options = [];
    for (const s of scansRes.scans) {
      options.push({ kind: 'scan', id: s.scanId, rootPath: s.rootPath, when: s.finishedAt, size: s.totalSize });
    }
    for (const sn of snapsRes.snapshots) {
      options.push({ kind: 'snap', id: sn.id, rootPath: sn.rootPath, when: sn.takenAt, size: sn.totalSize });
    }
    state.compare.options = options;
    if (!options.length) {
      $('cmpA').innerHTML = $('cmpB').innerHTML = '<option>No scans yet</option>';
      $('cmpA').disabled = $('cmpB').disabled = true;
      return;
    }
    $('cmpA').disabled = $('cmpB').disabled = false;

    const byRoot = new Map();
    for (const o of options) {
      if (!byRoot.has(o.rootPath)) byRoot.set(o.rootPath, []);
      byRoot.get(o.rootPath).push(o);
    }
    const label = (o) => `${o.kind === 'scan' ? 'Scan (full diff)' : 'History'} · ${formatWhen(o.when)} · ${formatBytes(o.size)}`;
    const html = [...byRoot.entries()].map(([root, list]) =>
      `<optgroup label="${escapeHtml(root)}">` +
      list.sort((x, y) => y.when - x.when).map(o =>
        `<option value="${o.kind}:${o.id}">${escapeHtml(label(o))}</option>`).join('') +
      '</optgroup>').join('');
    $('cmpA').innerHTML = html;
    $('cmpB').innerHTML = html;

    // Defaults: newest two entries OF THE SAME KIND for the current (or
    // first) root, older → newer. "Newest two overall" always paired the
    // newest scan with the snapshot that scan itself saved — same timestamp,
    // mixed kinds, and the exact pair the Run button refuses (QA D2).
    const rootKey = state.root && byRoot.has(state.root.path) ? state.root.path : [...byRoot.keys()][0];
    const list = byRoot.get(rootKey).sort((x, y) => y.when - x.when);
    const scans = list.filter((o) => o.kind === 'scan');
    const snaps = list.filter((o) => o.kind === 'snap');
    const pool = scans.length >= 2 ? scans : snaps.length >= 2 ? snaps : list;
    $('cmpB').value = `${pool[0].kind}:${pool[0].id}`;
    if (pool.length > 1) $('cmpA').value = `${pool[1].kind}:${pool[1].id}`;
    $('cmpInfo').textContent = pool.length < 2 ? 'Only one record of this folder so far — scan it again to have something to compare.' : '';
  } catch (e) {
    toast('Could not load scans: ' + e.message, 'error');
  }
}

function parseCmp(value) {
  const i = value.indexOf(':');
  if (i < 0) return null;
  const kind = value.slice(0, i), id = value.slice(i + 1);
  return state.compare.options.find(o => o.kind === kind && o.id === id) || null;
}

$('cmpRunBtn').addEventListener('click', async () => {
  const a = parseCmp($('cmpA').value), b = parseCmp($('cmpB').value);
  if (!a || !b) { toast('Pick two scans to compare', 'error'); return; }
  if (a.rootPath !== b.rootPath) { toast('Both picks must cover the same folder', 'error'); return; }
  if (a.kind === b.kind && a.id === b.id) { toast('Pick two different scans', 'error'); return; }
  if (a.kind !== b.kind) {
    toast('Mixing a live scan with a history snapshot isn’t supported — pick two of the same kind', 'error');
    return;
  }
  const body = $('cmpBody');
  cmpCountsDrop(); // the rewrite below would strand a live counts handle
  body.innerHTML = `<div class="card glass dup-progress">${icon('loader', 20, REDUCED ? '' : 'spin')}<span>Comparing…</span></div>`;
  // FX: the md ring marks the diff computing — on with the progress card,
  // dropped (the card is innerHTML-transient) before every rewrite that
  // settles it: render, error, and the history view's unmount.
  fxHuntBeamSync('cmpBody', true);
  try {
    if (a.kind === 'scan') {
      const diff = await api(`/api/compare?scanIdA=${a.id}&scanIdB=${b.id}`);
      fxHuntBeamSync('cmpBody', false);
      renderCompare({ entries: diff.entries, totalDelta: diff.totalDelta, truncated: diff.truncated, deep: true, whenA: a.when, whenB: b.when });
    } else {
      const diff = await api(`/api/snapshots/compare?a=${a.id}&b=${b.id}`);
      fxHuntBeamSync('cmpBody', false);
      // §7.4 — a same-root snapshot pair also gets the split-slider maps.
      renderCompare({ entries: diff.entries, totalDelta: diff.totalDelta, truncated: false, deep: false, whenA: diff.a.takenAt, whenB: diff.b.takenAt, splitRoot: a.rootPath });
    }
  } catch (e) {
    fxHuntBeamSync('cmpBody', false);
    body.innerHTML = `<div class="card glass"><div class="muted">Compare failed: ${escapeHtml(e.message)}</div></div>`;
  }
});

/* ── §7.4 — the split-slider: two snapshot treemaps behind one divider ──
   Both layouts come from /api/snapshots/tree (percent-space rects, the same
   shape the live renderer draws), painted into ONE canvas: the newer map in
   full, then the older clipped to the divider's left — a photo-comparison
   wipe. The divider is a NATIVE range input so arrows, Home and End are the
   platform's own; aria-valuetext narrates the position, the reclaim-weight
   sliders' pattern. Everything lives on elements this render created, so
   there is nothing for unmount to take back; the one static listener
   (resize) checks the canvas is still on screen before it draws. */
let cmpSplit = null; // { a, b, whenA, whenB } — percent-node layouts
let cmpSplitSeq = 0;

async function initCmpSplit(rootPath, whenA, whenB) {
  const seq = ++cmpSplitSeq;
  const note = $('cmpSplitNote');
  // Left of the divider is promised to be the OLDER — keep that promise even
  // when the user picked the pair newest-first (review RD7).
  const [tA, tB] = whenA <= whenB ? [whenA, whenB] : [whenB, whenA];
  try {
    const [la, lb] = await Promise.all([
      api(`/api/snapshots/tree?path=${encodeURIComponent(rootPath)}&at=${tA}`),
      api(`/api/snapshots/tree?path=${encodeURIComponent(rootPath)}&at=${tB}`),
    ]);
    if (seq !== cmpSplitSeq) return; // a slower earlier compare must not paint over a newer one (review RD6)
    // closestSnapshot answers with the nearest stored tree; if both picks
    // resolve to the same one there is nothing to wipe between — say so.
    if (la.snapshot.takenAt === lb.snapshot.takenAt) {
      const card = $('cmpSplitCard');
      if (card) card.hidden = true;
      return;
    }
    cmpSplit = { a: la.nodes, b: lb.nodes, whenA: la.snapshot.takenAt, whenB: lb.snapshot.takenAt };
    // The footer speaks for what the canvas actually shows — the nearest
    // STORED trees, which can differ from the picked times (review H11).
    const foot = $('cmpSplitFoot');
    if (foot) foot.innerHTML =
      `<span>◀ ${formatWhen(cmpSplit.whenA)}</span><span>${formatWhen(cmpSplit.whenB)} ▶</span>`;
    const range = $('cmpSplitRange');
    range.addEventListener('input', () => cmpSplitDraw());
    cmpSplitDraw();
  } catch (e) {
    if (seq !== cmpSplitSeq) return;
    cmpSplit = null;
    if (note) note.textContent = `No split view: ${e.message}`;
  }
}

function cmpSplitDraw() {
  const canvas = $('cmpSplitCanvas');
  if (!canvas || !cmpSplit) return;
  const range = $('cmpSplitRange');
  const pct = Number(range.value);
  range.setAttribute('aria-valuetext',
    `${pct} percent — left of the divider: ${formatWhen(cmpSplit.whenA)}, right: ${formatWhen(cmpSplit.whenB)}`);
  const cw = canvas.clientWidth, ch = canvas.clientHeight;
  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== Math.round(cw * dpr)) canvas.width = Math.round(cw * dpr);
  if (canvas.height !== Math.round(ch * dpr)) canvas.height = Math.round(ch * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // own the matrix — never scale on top of an inherited one
  const paint = (nodes) => {
    ctx.fillStyle = cssVar('--bg-1') || '#0e0e13';
    ctx.fillRect(0, 0, cw, ch);
    for (const n of nodes) {
      // Only EXPANDED dirs are frames around their children; an unexpanded
      // dir (depth cap, pruned children) is a leaf cell carrying the deep
      // bytes — skipping every dir left most of a real tree as background
      // holes (review RD1).
      if (n.expanded) continue;
      const x = (n.x / 100) * cw, y = (n.y / 100) * ch;
      const w = (n.w / 100) * cw, h = (n.h / 100) * ch;
      if (w < 0.5 || h < 0.5) continue;
      ctx.fillStyle = sizeColor(n.size, 0.92);
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = 'rgba(0,0,0,0.25)';
      ctx.strokeRect(x + 0.5, y + 0.5, Math.max(0, w - 1), Math.max(0, h - 1));
    }
  };
  const splitX = (pct / 100) * cw;
  paint(cmpSplit.b); // the newer scan, in full
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, splitX, ch);
  ctx.clip();
  paint(cmpSplit.a); // the older scan, revealed left of the divider
  ctx.restore();
  ctx.fillStyle = cssVar('--accent') || '#0A84FF';
  ctx.fillRect(splitX - 1, 0, 2, ch);
}

window.addEventListener('resize', () => {
  if (state.view === 'history' && $('cmpSplitCanvas')) cmpSplitDraw();
});

/* Compare's counts chart is a live DOM handle inside a card this function
   rewrites wholesale — so it dies BEFORE the rewrite that would strand it
   (the budget-gauge rule), and again with the view. */
let cmpCountsHandle = null;
function cmpCountsDrop() {
  if (cmpCountsHandle) { cmpCountsHandle.destroy(); cmpCountsHandle = null; }
}

function renderCompare(r) {
  cmpSplit = null; // a fresh card owns the canvas; a stale draw must find nothing
  cmpCountsDrop();
  const counts = { added: 0, removed: 0, grew: 0, shrank: 0 };
  for (const en of r.entries) {
    counts[en.sizeA === null ? 'added' : en.sizeB === null ? 'removed' : en.delta > 0 ? 'grew' : 'shrank']++;
  }
  const up = r.totalDelta >= 0;
  const maxD = Math.abs(r.entries[0]?.delta ?? 0) || 1;
  const splitCard = r.splitRoot ? `
    <div class="card glass" id="cmpSplitCard">
      <h2><span style="display:inline-flex;">${icon('diff', 13)}</span>Split view</h2>
      <div class="muted" style="margin-bottom:8px;">Drag the divider — or focus it and use the arrow keys; Home and End snap. Left of the line is the older scan, right is the newer.</div>
      <div class="cmp-split">
        <canvas id="cmpSplitCanvas" aria-hidden="true"></canvas>
        <input type="range" id="cmpSplitRange" min="0" max="100" step="1" value="50"
               aria-label="Reveal divider between the two scans — left of it shows the older scan, right the newer" aria-valuetext="50 percent">
      </div>
      <div class="rule-row num muted" id="cmpSplitFoot" style="justify-content:space-between;">
        <span>Loading the two maps…</span>
      </div>
      <div class="muted" id="cmpSplitNote" role="status"></div>
    </div>` : '';
  $('cmpBody').innerHTML = splitCard + `
    <div class="card glass">
      <h2><span style="display:inline-flex;">${icon('diff', 13)}</span>${formatWhen(r.whenA)} → ${formatWhen(r.whenB)}${r.deep ? '' : ' · top-level folders only'}</h2>
      <div class="muted num" style="margin-bottom:12px;">Total ${up ? 'grew' : 'shrank'} by
        <b class="cmp-total" style="color:${up ? '#ff6b61' : 'var(--ok)'}">${formatBytes(Math.abs(r.totalDelta))}</b>
        &nbsp;·&nbsp; <span class="cmp-ct" data-n="${counts.added}">${counts.added}</span> added · <span class="cmp-ct" data-n="${counts.removed}">${counts.removed}</span> removed · <span class="cmp-ct" data-n="${counts.grew}">${counts.grew}</span> grew · <span class="cmp-ct" data-n="${counts.shrank}">${counts.shrank}</span> shrank${r.truncated ? ' · biggest 1,000 shown' : ''}</div>
      ${r.entries.length ? '<div id="cmpCounts"></div>' : ''}
      ${r.entries.length
        ? r.entries.slice(0, 200).map(en => deltaRow(en, maxD, { offerSnapshots: true })).join('')
        : `<div class="muted" style="display:flex;align-items:center;gap:8px;">${icon('checkCircle', 15)} No differences — nothing changed between these two.</div>`}
    </div>`;
  // Animated counts: the from-zero roll the quick stats use, on the totals
  // just computed — and the same four counts again as discrete square
  // stacks, because a count is a number of whole things.
  countUp($('cmpBody').querySelector('.cmp-total'), Math.abs(r.totalDelta), formatBytes);
  $('cmpBody').querySelectorAll('.cmp-ct').forEach(el => countUp(el, Number(el.dataset.n)));
  if (r.entries.length) {
    cmpCountsHandle = FxCharts.barSquares($('cmpCounts'), {
      items: [
        { name: 'Added', value: counts.added },
        { name: 'Removed', value: counts.removed },
        { name: 'Grew', value: counts.grew },
        { name: 'Shrank', value: counts.shrank },
      ],
      squareSize: 10, height: 60, gradient: true, labelWidth: 56,
      formatValue: formatCount, valueName: 'Entries',
    });
  }
  fxBarsIn($('cmpBody')); // the diverging delta bars ride the kit's width-in
  if (r.splitRoot) initCmpSplit(r.splitRoot, r.whenA, r.whenB);
  wireSnapshotActions($('cmpBody'));
}

/* ───────────────────────────── Browse modal ───────────────────────────── */
let browsePath = null;
let browseOnPick = null; // when set, "Use this folder" hands the path to this instead of scanning
async function openBrowse(start, onPick = null, title = null) {
  browseOnPick = onPick;
  $('browseTitle').innerHTML = icon('folder', 18) + (title || 'Choose a folder');
  $('browseModal').classList.add('open');
  const chips = $('browseChips');
  chips.innerHTML = (state.system?.commonDirs ?? []).map(d =>
    `<button class="pill" data-p="${escapeHtml(d)}">${icon('folder', 12)}${escapeHtml(d.split(/[\\/]/).pop() || d)}</button>`).join('');
  chips.querySelectorAll('.pill').forEach(c => c.addEventListener('click', () => browseTo(c.dataset.p)));
  await browseTo(start || state.system?.homeDir || '/');
}
async function browseTo(path) {
  try {
    const data = await api('/api/fs/list?path=' + encodeURIComponent(path));
    browsePath = data.path;
    $('browseCurrent').textContent = data.path;
    const list = $('browseList');
    const rows = [];
    if (data.parent) rows.push(`<button class="browse-item" data-p="${escapeHtml(data.parent)}" aria-label="Up one level">${icon('arrowUp', 14)} <b>..</b></button>`);
    rows.push(...data.dirs.map(d =>
      `<button class="browse-item" data-p="${escapeHtml(d.path)}" aria-label="Open ${escapeHtml(d.name)}">${icon('folder', 14)} <span class="${d.isHidden ? 'hid' : ''}">${escapeHtml(d.name)}</span></button>`));
    list.innerHTML = rows.join('') || '<div class="muted" style="padding:14px;">No subfolders.</div>';
    list.querySelectorAll('.browse-item').forEach(b => b.addEventListener('click', () => browseTo(b.dataset.p)));
  } catch (e) {
    toast(e.message, 'error');
  }
}
$('browseBtn').addEventListener('click', () => openBrowse($('pathInput').value.trim() || null));
$('emptyBrowseBtn').addEventListener('click', () => openBrowse(null));
$('browseUseBtn').addEventListener('click', () => {
  const pick = browseOnPick;
  browseOnPick = null;
  closeModal('browseModal');
  if (!browsePath) return;
  if (pick) { pick(browsePath); return; }
  $('pathInput').value = browsePath;
  startScan(browsePath);
});
