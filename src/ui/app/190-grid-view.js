/* ───────────────────────────── Grid view ───────────────────────────── */
const GAP = 12, MIN_SQ = 64, MAX_SQ = 256;
/* Every tile names itself and says its size (QA D43). MIN_SQ was 48 while
   the name came only at 64 px and the size at 84, so a folder of small files
   was a wall of bare icons, and "Extensions" had a name and no size. Below
   GRID_COMPACT_BELOW a tile draws a smaller icon on tighter spacing (.gcell
   .compact) so all three fit. The folder-count badge sits in the top-right
   corner and waits for GRID_BADGE_MIN, the size from which the centred icon
   starts below it. tests/gridViewQa.test.ts checks both against the
   stylesheet's own numbers. */
const GRID_COMPACT_BELOW = 84, GRID_BADGE_MIN = 120;
function gridIconPx(side) {
  return side < GRID_COMPACT_BELOW ? 16 : Math.max(17, Math.min(46, Math.round(side * 0.3)));
}
const gridScroll = $('gridScroll');
const gridInner = $('gridInner');

function gridItems() {
  const node = state.pathIndex.get(state.grid.path);
  if (!node || !node.children) return [];
  let items = [...node.children];
  const q = state.grid.query.trim().toLowerCase();
  if (q) items = items.filter(it => it.name.toLowerCase().includes(q));
  const s = state.grid.sort;
  items.sort((a, b) =>
    s === 'name' ? a.name.localeCompare(b.name, undefined, { sensitivity:'base' }) :
    s === 'date' ? b.modifiedAt - a.modifiedAt :
    // atime is best-effort (gdu/cloud engines and noatime mounts never record
    // it) — entries without one sink to the bottom instead of erroring.
    s === 'accessed' ? ((b.accessedAt || 0) - (a.accessedAt || 0)) || b.size - a.size :
    s === 'type' ? (a.type !== b.type ? (a.type === 'dir' ? -1 : 1) : (a.extension || '').localeCompare(b.extension || '') || b.size - a.size) :
    b.size - a.size);
  // v4 §3.3 — ranked by what is safest to reclaim rather than by what is
  // biggest. Applied after the switch because it needs the whole list: an
  // entry with no score yet sorts last, not as zero.
  if (s === 'reclaim') items.sort(byReclaimDesc((it) => it.path));
  return items;
}

function layoutGrid(items) {
  const prev = state.grid.layout;
  const width = gridScroll.clientWidth - 20;
  const maxSize = items.reduce((m, it) => Math.max(m, it.size), 1);
  const layout = [];
  let x = 0, y = 0, rowH = 0;
  for (const it of items) {
    const side = Math.round(Math.min(MAX_SQ, MIN_SQ + Math.sqrt(it.size / maxSize) * (MAX_SQ - MIN_SQ)));
    if (x + side > width && x > 0) { x = 0; y += rowH + GAP; rowH = 0; }
    layout.push({ it, x, y, side });
    x += side + GAP;
    rowH = Math.max(rowH, side);
  }
  state.grid.layout = layout;
  state.grid.totalH = layout.length ? y + rowH + GAP : 0;
  // The shift-click anchor is a POSITIONAL index into the array we just threw
  // away, and every caller of this function rebuilds that array from scratch:
  // folder navigation, a sort change, each debounced search keystroke, a
  // rescan, a window resize. Position 35 in the old list is a different file in
  // the new one — or, once a query narrows 40 entries down to 3, no file at
  // all, which is how a following shift-click ended up reading past the end of
  // the layout. Clearing it here rather than at each call site is deliberate:
  // this is the only place `state.grid.layout` is ever written, so no rebuild
  // path can quietly skip the reset the way a per-call-site version would.
  // Kept only where the very same file still sits at that position: a re-flow
  // of the same list into a new width. The preview pane narrows the page
  // (QA C04), and it opens on the plain click that sets the anchor — dropped
  // there, the next shift-click selected one file instead of the range.
  const a = state.grid.anchor;
  const same = a !== null && prev && prev[a] && layout[a] && prev[a].it.path === layout[a].it.path;
  if (!same) state.grid.anchor = null;
}

/* A re-flow of the same list into a new width keeps the Grid's place (review
   F1.8). The preview pane narrows the page on the very click that opens it
   (QA C04), and the sidebar folds, and a window resizes: rows multiply or
   merge and every tile's y moves, while nothing moved the scroller, so the
   tile just clicked dropped out of view. The tile kept in place is the
   anchor — the one clicked last — if any of it is in view, else the first
   tile in view; never an anchor scrolled away, which would jump the Grid. */
function gridScrollAnchor() {
  const layout = state.grid.layout || [];
  const top = gridScroll.scrollTop, bottom = top + gridScroll.clientHeight;
  const inView = (c) => !!c && c.y + c.side > top && c.y < bottom;
  const a = state.grid.anchor;
  const i = a !== null && inView(layout[a]) ? a : layout.findIndex(inView);
  return i === -1 ? null : { i, path: layout[i].it.path, offset: layout[i].y - top };
}
/** Put that tile back at its offset — only where the same file holds the same place. (A new folder, order or filter never comes here: it starts at its top, renderGrid.) */
function gridScrollKeep(keep) {
  const c = keep && state.grid.layout[keep.i];
  if (!c || c.it.path !== keep.path) return;
  gridScroll.scrollTop = Math.max(0, c.y - keep.offset);
}
/* A tile just clicked is never left under the bars the click raised (QA C04
   remainder). The plain click that opens the preview pane raises the
   selection bar too, and the cart pill steps up above it, over the foot of
   the Grid — and the re-flow kept the tile where it was, under the pill. The
   room the scroller keeps at its foot while the bar is up (040-grid.css, QA
   D02) is where those bars stand, so it is read back from the scroller: a
   tile reaching into it, or its GAP short of it, is scrolled up just clear,
   never further. (The scroller's 420 px floor leaves room above any tile.) */
function gridScrollClear(i) {
  const c = state.grid.layout[i];
  if (!c) return;
  const cs = getComputedStyle(gridScroll);
  const padTop = parseFloat(cs.paddingTop) || 0, padBottom = parseFloat(cs.paddingBottom) || 0;
  const tileTop = padTop + c.y - gridScroll.scrollTop; // in the scroller's window
  const over = tileTop + c.side + GAP - (gridScroll.clientHeight - padBottom);
  if (over > 0) gridScroll.scrollTop += over;
}
/* The tile a click left selected, and where that left it in the Grid's
   window. The re-flow that click brings on — the preview pane it opened
   narrowing the page — can move it under the bars (fewer to a row, and the
   pill stands mid-window), and the click's own scroll may have been cut
   short by a Grid too short to scroll that far before the pane narrowed it.
   So the next re-flow brings that tile clear of the bars: that tile only,
   only while the bars are up, and only if nothing has scrolled it since
   (review F1.2). An anchor the user scrolled to the foot themselves, or one left
   after Clear, stays where they put it, and a resize does not jump the
   Grid. */
let gridClicked = null;
function gridNoteClicked(i) {
  const c = state.grid.layout[i];
  gridClicked = c && state.grid.selection.has(c.it.path) ? { path: c.it.path, offset: c.y - gridScroll.scrollTop } : null;
}

/* The list the layout was last drawn from: its folder, filter and order. The
   same list drawn again — a re-flow into a new width, a rescan, the view
   shown again — keeps the Grid's place; any other list starts at its top
   (review F1.1, F1.4). Since the Grid is its own scroller (QA D01) its
   toolbar stays on screen, so a folder opened, Up, a crumb, a filter or a
   sort is made from deep in a folder, and nothing but the browser's clamp
   touched the old offset: a folder opened at its last rows, and a filter or
   a new order hid its first — largest — matches off the top. */
let gridShown = '';

let gridSeq = 0;
async function renderGrid() {
  // This folder's children may have been pruned out of the tree we were sent.
  // Fetch them before rendering, or an untouched folder reads as empty.
  const seq = ++gridSeq;
  // Up has nowhere to go at the scan root: say so rather than offer a button
  // that does nothing (QA D43 — the treemap's Up already does this).
  $('gridUpBtn').disabled = !state.root || state.grid.path === state.root.path;
  await ensureSubtree(state.grid.path);
  if (seq !== gridSeq) return; // a newer navigation superseded this one

  // After ensureSubtree, either we hold this folder's children or we don't.
  // Still `pruned`, or absent from the tree entirely, both mean the fetch never
  // landed — and calling that "empty" is a lie about the user's disk. Guarded
  // on scanId/path so the pre-scan state still shows the normal empty view.
  const gridNode = state.pathIndex.get(state.grid.path);
  const unloaded = !!state.scanId && !!state.grid.path && (!gridNode || !!gridNode.pruned);

  // Scores for this folder's children, before the sort that needs them.
  // Bounded by the folder's own contents rather than the tree's, and awaited
  // only when the sort actually depends on it — every other sort paints at
  // once and picks the badges up on the next repaint.
  if (state.grid.sort === 'reclaim') {
    const node = state.pathIndex.get(state.grid.path);
    const kids = (node && node.children) || [];
    if (kids.length) {
      await ensureScores(kids.slice(0, RECLAIM_BATCH).map((k) => k.path));
      if (seq !== gridSeq) return;
    }
  }

  const items = gridItems();
  const shown = JSON.stringify([state.grid.path, state.grid.query.trim().toLowerCase(), state.grid.sort]);
  const sameList = shown === gridShown;
  gridShown = shown;
  const keep = gridScrollAnchor();
  const clicked = gridClicked;
  gridClicked = null;
  layoutGrid(items);
  gridInner.style.height = state.grid.totalH + 'px';
  if (!sameList) gridScroll.scrollTop = 0;
  else {
    gridScrollKeep(keep);
    const justClicked = clicked && keep && keep.i === state.grid.anchor && keep.path === clicked.path &&
      Math.abs(keep.offset - clicked.offset) < 1 && state.grid.selection.size > 0;
    if (justClicked) gridScrollClear(keep.i);
  }
  state.grid.rangeStart = 0; state.grid.rangeEnd = -1;
  renderGridWindow(true);
  renderCrumbs($('gridCrumbs'), state.grid.path, (p) => gridNavigate(p));
  const existing = gridScroll.querySelector('.grid-empty');
  if (existing) existing.remove();
  if (!items.length) {
    const q = state.grid.query.trim();
    const div = document.createElement('div');
    div.className = 'grid-empty';
    div.innerHTML = unloaded && !q
      ? icon('alert', 30) + '<span>Couldn’t load this folder — check your connection and try again</span>'
      : icon(q ? 'search' : 'folder', 30) +
        `<span>${q ? `No files match “${escapeHtml(q)}”` : 'This folder is empty'}</span>`;
    gridScroll.appendChild(div);
  }
}

/* A tile with keyboard focus keeps it when the window is rebuilt (review
   F1.5). Every rebuild replaces the tiles, and a focused tile replaced fell
   to <body>: since the Grid really scrolls (QA D01), a tile tabbed to in the
   margin below the foot is scrolled into view by the browser, that scroll
   moves the window, and Tab never got past the first screenful. The same
   file's new tile takes the focus, without scrolling; scrolled out of the
   window, it is still built — first or last, so the next Tab reaches the
   tiles on screen. A different list (another folder, filter or order) has
   no tile of that file at that place, and takes nothing. */
const gridCellItem = new WeakMap();
function gridFocusedIndex(layout) {
  const el = document.activeElement;
  const it = el && gridInner.contains(el) ? gridCellItem.get(el) : undefined;
  const i = it ? Number(el.dataset.i) : -1;
  return layout[i] && layout[i].it.path === it.path ? i : -1;
}

function renderGridWindow(force = false) {
  const top = gridScroll.scrollTop - 200;
  const bottom = gridScroll.scrollTop + gridScroll.clientHeight + 200;
  const layout = state.grid.layout;
  let start = layout.length, end = -1;
  for (let i = 0; i < layout.length; i++) {
    const c = layout[i];
    if (c.y + c.side >= top && c.y <= bottom) { if (i < start) start = i; end = i; }
    else if (c.y > bottom) break;
  }
  if (!force && start === state.grid.rangeStart && end === state.grid.rangeEnd) return;
  state.grid.rangeStart = start; state.grid.rangeEnd = end;

  const focused = gridFocusedIndex(layout);
  const order = [];
  if (focused !== -1 && focused < start) order.push(focused);
  for (let i = start; i <= end; i++) order.push(i);
  if (focused > end) order.push(focused);
  const frag = document.createDocumentFragment();
  let refocus = null;
  for (const i of order) {
    const cell = gridCell(i);
    if (i === focused) refocus = cell;
    frag.appendChild(cell);
  }
  gridInner.replaceChildren(frag);
  if (refocus) refocus.focus({ preventScroll: true });
}

/** Tile `i` of the layout, built with its handlers. */
function gridCell(i) {
  const { it, x, y, side } = state.grid.layout[i];
  const k = kindFor(it);
  const cell = document.createElement('div');
  gridCellItem.set(cell, it);
  cell.className = 'gcell' + (side < GRID_COMPACT_BELOW ? ' compact' : '') + (state.grid.selection.has(it.path) ? ' selected' : '');
  cell.tabIndex = 0;
  cell.dataset.i = i;
  cell.setAttribute('role', 'button');
  cell.setAttribute('aria-label', `${it.name}, ${formatBytes(it.size)}${it.type === 'dir' ? ', folder' : ''}`);
  cell.style.cssText = `left:${x}px;top:${y}px;width:${side}px;height:${side}px;`;
  cell.innerHTML = `
    <span class="sel-mark">${icon('check', 11)}</span>
    ${it.type === 'dir' && it.children && side >= GRID_BADGE_MIN ? `<span class="badge num">${formatCount(it.children.length)}</span>` : ''}
    <span style="color:${k.tint};display:inline-flex;">${icon(k.icon, gridIconPx(side))}</span>
    <span class="nm">${escapeHtml(it.name)}</span>
    <span class="sz num">${formatBytes(it.size)}</span>`;
  cell.addEventListener('click', (e) => onCellClick(e, i));
  cell.addEventListener('dblclick', () => { if (it.type === 'file') openInOS(it.path, false); });
  cell.addEventListener('contextmenu', (e) => { e.preventDefault(); showCtxMenu(e.clientX, e.clientY, it); });
  cell.addEventListener('mouseenter', () => {
    const r = cell.getBoundingClientRect();
    showTooltip(r.right, r.top, it);
  });
  cell.addEventListener('mouseleave', hideTooltip);
  cell.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onCellClick(e, i); }
  });
  return cell;
}
let gridRaf = 0;
gridScroll.addEventListener('scroll', () => {
  if (gridRaf) return;
  gridRaf = requestAnimationFrame(() => { gridRaf = 0; renderGridWindow(); });
});

function onCellClick(e, i) {
  const { it } = state.grid.layout[i];
  const sel = state.grid.selection;
  const barWasUp = sel.size > 0;
  // Second line of defence for the same trap. layoutGrid() clears the anchor on
  // every rebuild, but this handler is the point of USE and it must not depend
  // on that promise being kept: a future rebuild path that writes the layout
  // itself would otherwise turn one stale index into a TypeError thrown from
  // inside a click, with the selection half applied. Clamping degrades that to
  // a shorter range instead. `!== null` stays as the emptiness test because
  // anchor 0 is a real anchor and every falsy check would drop it.
  const anchor = state.grid.anchor === null
    ? null
    : Math.max(0, Math.min(state.grid.anchor, state.grid.layout.length - 1));
  if (e.shiftKey && anchor !== null) {
    const a = Math.min(anchor, i), b = Math.max(anchor, i);
    if (!(e.metaKey || e.ctrlKey)) sel.clear();
    for (let k = a; k <= b; k++) sel.add(state.grid.layout[k].it.path);
  } else if (e.metaKey || e.ctrlKey) {
    sel.has(it.path) ? sel.delete(it.path) : sel.add(it.path);
    state.grid.anchor = i;
  } else if (it.type === 'dir') {
    hideTooltip();
    gridNavigate(it.path);
    return;
  } else {
    sel.clear(); sel.add(it.path);
    state.grid.anchor = i;
    if (it.type === 'file') openPreview(it);
  }
  updateSelectionBar();
  if (!barWasUp && sel.has(it.path)) gridScrollClear(i);
  gridNoteClicked(i);
  renderGridWindow(true);
}

$('gridUpBtn').addEventListener('click', gridUp);
function gridUp() {
  const crumbs = breadcrumbsFor(state.grid.path);
  if (crumbs.length > 1) gridNavigate(crumbs[crumbs.length - 2].path);
}
/* Every move to another folder — a folder tile, a breadcrumb, Up — goes
   through here. The filter belongs to the folder it was typed in (QA D44):
   "Fonts" found the Fonts folder, and opening it then said 'No files match
   "Fonts"'. A keystroke still inside its debounce is cancelled with it, or it
   would land on the new folder a moment later. */
function gridNavigate(path) {
  clearTimeout(searchDeb);
  state.grid.query = '';
  $('gridSearch').value = '';
  state.grid.path = path;
  state.grid.selection.clear(); updateSelectionBar();
  renderGrid();
}
$('gridSort').addEventListener('change', (e) => { state.grid.sort = e.target.value; renderGrid(); });
let searchDeb = 0;
$('gridSearch').addEventListener('input', (e) => {
  clearTimeout(searchDeb);
  searchDeb = setTimeout(() => { state.grid.query = e.target.value; renderGrid(); }, 140);
});
window.addEventListener('resize', () => { if (state.view === 'grid' && state.root) renderGrid(); });

/**
 * Is the Grid's selection one the person can see — the Grid the view on
 * screen, and something selected in it? The one test for everything that
 * acts on that selection: its bar, ⌘⌫ and Delete (QA third pass D03). The
 * selection is the Grid's and stays in state while another view is up, for
 * the Grid to show again; nothing anywhere else may act on it.
 */
function gridSelectionShown() {
  return state.view === 'grid' && state.grid.selection.size > 0;
}
function updateSelectionBar() {
  const sel = state.grid.selection;
  const bar = $('selectionBar');
  // The bar belongs to the Grid and leaves with it (D03). It stood over every
  // other view — on the Dashboard, beside the Treemap's own selection, behind
  // the Autopilot editor — offering Offload and Move to Trash for files none
  // of them shows.
  if (!gridSelectionShown()) { bar.classList.remove('visible'); return; }
  let total = 0;
  for (const p of sel) total += nodeFor(p)?.size ?? 0;
  $('selInfo').innerHTML = `<b>${sel.size}</b> item${sel.size > 1 ? 's' : ''} selected — ${formatBytes(total)}`;
  $('selOffloadBtn').hidden = isCloudScan(); // offload is a local-disk concept
  bar.classList.add('visible');
}
/* Clear hides the bar it sits in. Focus that was in the bar goes back to the
   grid — the tile the selection was anchored on, else the first tile on
   screen, else the filter box — instead of falling to <body> with the bar
   (QA B13). Never a tile off screen, and without scrolling: the grid stays
   where the user left it (B13 review F1.3). Focus anywhere else is left where
   it is. */
function gridClearSelection() {
  const hadFocus = $('selectionBar').contains(document.activeElement);
  state.grid.selection.clear(); updateSelectionBar(); renderGridWindow(true);
  if (hadFocus) selectionBarFocusOut();
}
/* Where focus in the bar goes when the bar goes. In the Grid, back to the
   grid (above). With the Grid hidden — the bar leaving with it on a view
   switch (D03) — no tile and not the filter box can take focus, so the view
   on screen takes it, or its sidebar tab when it has no control to offer
   (B13 review F2.4). */
function selectionBarFocusOut() {
  const target = state.view === 'grid'
    ? gridTileOnScreen(state.grid.anchor) || $('gridSearch')
    : activeViewControl() || document.querySelector('.tabbar button[aria-selected="true"]');
  if (target) target.focus({ preventScroll: true });
}
/** switchView's half of D03: the bar follows the view on screen, and focus that was in it as it went does not fall to <body>. */
function selectionBarFollowView() {
  const hadFocus = $('selectionBar').contains(document.activeElement);
  updateSelectionBar();
  if (hadFocus && !$('selectionBar').classList.contains('visible')) selectionBarFocusOut();
}
/** The drawn tile at layout index `prefer` if any of it is in view, else the first drawn tile that is; null when none is. */
function gridTileOnScreen(prefer) {
  const top = gridScroll.scrollTop, bottom = top + gridScroll.clientHeight;
  const inView = (i) => { const c = state.grid.layout[i]; return !!c && c.y + c.side > top && c.y < bottom; };
  const drawn = (i) => gridInner.querySelector(`.gcell[data-i="${i}"]`);
  if (prefer !== null && inView(prefer) && drawn(prefer)) return drawn(prefer);
  for (let i = state.grid.rangeStart; i <= state.grid.rangeEnd; i++) if (inView(i) && drawn(i)) return drawn(i);
  return null;
}
/* The tile standing for one a rebuild took away, for the focus that was on
   it (review F2.6): the preview pane gives focus back to where it came from,
   and the Enter that opens it from a tile redraws every tile, so the one it
   remembered is gone by the close and focus fell to <body>. The same file's
   tile takes it if it is on screen, else the first tile that is — never one
   scrolled away (B13). Null for anything that was not a Grid tile. */
function gridFocusStandIn(el) {
  const it = gridCellItem.get(el);
  if (!it) return null;
  const i = state.grid.layout.findIndex((c) => c.it.path === it.path);
  return gridTileOnScreen(i === -1 ? null : i);
}
$('selClearBtn').addEventListener('click', gridClearSelection);
$('selTrashBtn').addEventListener('click', () => confirmTrash([...state.grid.selection]));

/* ───────────────────────────── Apps view (Feature 18) ───────────────────────────── */
const APP_CAT_LABEL = { app: 'App', cache: 'Caches', data: 'Data', logs: 'Logs' };

async function loadApps(force = false) {
  if (!state.scanId || !state.root) return;
  if (!force && state.apps.loadedFor === state.scanId) { renderApps(); return; }
  const host = $('appsBody');
  appsScatterDrop(); // the standing dots belong to the previous scan's apps
  host.innerHTML = skeletonRows(8, 42);
  $('appsInfo').textContent = '';
  try {
    const data = await api('/api/apps?scanId=' + state.scanId);
    state.apps.list = data.apps || [];
    state.apps.otherBytes = data.otherBytes;
    state.apps.totalBytes = data.totalBytes;
    state.apps.appsFolderScanned = data.appsFolderScanned;
    state.apps.loadedFor = state.scanId;
    renderApps();
  } catch (e) {
    host.innerHTML = `<div class="muted">${escapeHtml(e.message)}</div>`;
  }
}

/* ─────────────────────────── Cost to Keep (§C1) ───────────────────────────
   Prices come from a table that ships with the app — TreeMap makes no outbound
   request of any kind. That means prices go stale, so the date they were
   recorded is always on screen. The what-if is the useful half: a saving only
   exists when the TIER changes, and the card says so when it does not. */
function costMoney(usd, est) {
  const value = usd * (est.rateFromUsd || 1);
  const shown = value >= 100 ? value.toFixed(0) : value.toFixed(2);
  return `${est.approximate ? '≈' : ''}${est.symbol}${shown}`;
}

async function loadCostEstimate(after) {
  const host = $('costBody');
  if (!host || !state.scanId) return;
  // First paint loads as labelled skeleton rows; a reload (currency change,
  // rescan) sweeps the standing prices with the veil instead of blanking
  // them. Both painters below settle it.
  if (host.querySelector('.cost-row')) host.classList.add('fx-chart-loading');
  else host.innerHTML = skeletonRows(4, 22, 'Working out what keeping this online would cost…');
  // U-16: the suggestions below are a walk of the whole tree. After a scan,
  // finishScan hands over the dashboard lists' own walks, and the card asks
  // only once those have answered rather than competing with them. A newer
  // scan by then loads its own estimate; until it does — and for good if it
  // is stopped — this card has nothing current to show, so it says so rather
  // than stay on its loading state (review of U-16, finding 3).
  if (after) {
    const scanId = state.scanId;
    try { await after; } catch { /* the lists report their own failure; the card still loads */ }
    if (scanId !== state.scanId) {
      host.classList.remove('fx-chart-loading');
      host.innerHTML = '<div class="muted">Run a scan to see what this data would cost to keep online.</div>';
      return;
    }
  }
  // The what-if uses whatever the Clean Up rules already found to be
  // reclaimable, so the two features agree about the same bytes.
  let freeable = 0;
  try {
    const s = await api('/api/cleanup/suggestions?scanId=' + state.scanId);
    freeable = (s.groups || []).reduce((n, g) => n + (g.advisory ? 0 : g.totalSize), 0);
  } catch { /* the estimate is still worth showing without a what-if */ }

  let est;
  try {
    est = await api(`/api/cost/estimate?scanId=${state.scanId}&freeable=${freeable}&currency=${$('costCurrency').value}`);
  } catch (e) {
    host.classList.remove('fx-chart-loading');
    host.innerHTML = `<div class="muted">${escapeHtml(e.message)}</div>`;
    return;
  }
  state.cost = est;

  // The bytes these prices were worked out from ride in the answer itself —
  // every provider carries the figure the server priced. The client tree's own
  // root size is a second, independent measurement of the same thing, and a
  // headline taken from it would disagree with the prices beneath it the day
  // the two ever differ.
  const pricedBytes = est.providers.length ? est.providers[0].bytes : null;

  // Bars are normalized to the priciest plan actually shown — a provider
  // with no plan this big has no honest bar, so it gets none.
  const maxMonthly = est.providers.reduce((m, p) => Math.max(m, p.current.tier ? p.current.monthly : 0), 0);
  const rows = est.providers.map((p, i) => {
    const tier = p.current.tier;
    const price = tier
      ? `${costMoney(p.current.monthly, est)}<span class="per">/mo</span>`
      : '<span class="muted">no plan this big</span>';
    const saving = costSavingHtml(p, freeable, est);
    const bar = tier && maxMonthly > 0
      ? `<span class="fx-bar-track"><span class="fx-bar-fill" data-w="${Math.max(3, (p.current.monthly / maxMonthly) * 100).toFixed(1)}" style="${fxBarStyle(i)}"></span></span>`
      : '';
    return `<div class="cost-row">
      <div class="meta"><div class="nm">${escapeHtml(p.providerName)}</div>
        <div class="sub">${tier ? escapeHtml(tier.label) : 'more than this provider sells'} ${saving}</div></div>
      ${bar}
      <span class="cost-price num">${price}</span>
    </div>`;
  }).join('');

  host.classList.remove('fx-chart-loading');
  // Same scan, same currency → the prices roll in place (a rescan shifting
  // the freeable bytes, say); a currency or scan change is a new entity and
  // snaps through the key.
  FxNum.rollHtml(host,
    (pricedBytes === null
      ? `<div class="cost-lead">No cloud plans ship with this version, so there is nothing to price this against.</div>`
      : `<div class="cost-lead">Keeping <b>${formatBytes(pricedBytes)}</b> online would cost:</div>`) +
    rows +
    `<div class="cost-foot">Prices as of <b>${escapeHtml(est.asOf)}</b>, shipped with this version — TreeMap never looks them up online, so check the provider before you buy.` +
    (est.approximate ? ` Figures marked ≈ are converted from US dollars at an approximate rate.` : '') + `</div>`,
    `${state.scanId}:${$('costCurrency').value}`);
  fxBarsIn(host);
}

/** The what-if beside a provider's price: what clearing the reclaimable bytes
    would save, or that it would not change the plan. Not said of a plan that
    costs nothing (QA D21): "clearing 137 MB keeps you on the same plan" read
    as a cost on a free plan the data already fits. */
function costSavingHtml(p, freeable, est) {
  if (p.monthlySavingUsd > 0) {
    return `<span class="cost-save">save ${costMoney(p.monthlySavingUsd, est)}/mo by clearing ${formatBytes(freeable)}</span>`;
  }
  if (p.afterCleanup && p.sameTierAfterCleanup && p.current.tier && p.current.monthly > 0) {
    return `<span class="cost-nosave">clearing ${formatBytes(freeable)} keeps you on the same plan</span>`;
  }
  return '';
}

/* ───────────────────────────── Drive Health (§C4) ─────────────────────────────
   The drive's own attributes and its own self-assessment, verbatim, next to the
   growth forecast. There is deliberately NO health verdict of TreeMap's own: a
   false "your drive is dying" sends people to buy hardware they do not need. */
/* The wear gauge is a live canvas handle (rAF ease + ResizeObserver), so the
   registry's rules apply to it exactly as to the donut and budget gauges:
   destroy before the rewrite that would strand it, destroy on unmount, and
   retint through update({}) when the theme flips. */
let dhGauge = null;
function fxDriveGaugeDrop() {
  if (dhGauge) { dhGauge.destroy(); dhGauge = null; }
}

/**
 * Which drive the scanned folder actually sits on, from the topology answer.
 *
 * `/api/platform/topology` answers `physicalDisks[]` and `logicalVolumes[]` —
 * that is what `VolumeTopology` is and what openapi.json publishes. It has
 * never carried `volumes`, `disks` or a `devicePath`, so reading those names
 * named no drive on any machine and this card could only ever repeat the
 * server's "no drive was named", even where smartctl was installed.
 *
 * Longest mount point wins: `/` backs every path, so a first match would beat
 * the volume the folder is really on. A physical-disk id is already a device
 * node on Linux and a bare `diskN` on macOS; anything else — Windows names its
 * disks `PhysicalDiskN`, which smartctl does not take — names nothing, because
 * "no drive was named" is true while "that drive returned no SMART data" is
 * the false sentence a guess would produce.
 */
function smartDeviceFor(topo, rootPath) {
  if (!topo || typeof rootPath !== 'string' || !rootPath) return null;
  // A mount point is a folder boundary, never a string prefix: /Volumes/Database
  // is not inside /Volumes/Data. "\" separates only a Windows path (POL item 7):
  // on macOS and Linux it is a character a name may hold.
  const under = (p, mount) => {
    if (p === mount) return true;
    const sep = /^(?:[A-Za-z]:|\\\\)/.test(mount) ? '\\' : '/';
    return p.startsWith(mount.endsWith(sep) ? mount : mount + sep);
  };
  const vol = (topo.logicalVolumes || [])
    .filter((v) => v && typeof v.mountPoint === 'string' && v.mountPoint && under(rootPath, v.mountPoint))
    .sort((a, b) => b.mountPoint.length - a.mountPoint.length)[0] || null;
  const disks = topo.physicalDisks || [];
  const id = ((vol && vol.physicalDiskIds) || [])[0] ||
    // One physical disk means there is nowhere else the folder could be. More
    // than one, with no volume matched, is a guess this card must not make.
    (disks.length === 1 && disks[0] ? disks[0].id : null);
  if (typeof id !== 'string' || !id) return null;
  if (id.startsWith('/dev/')) return id;
  return /^disk\d+$/.test(id) ? '/dev/' + id : null;
}

async function loadDriveHealth() {
  const host = $('driveHealthBody');
  if (!host || !state.scanId) return;
  // First paint loads as labelled skeleton rows; a reload sweeps the standing
  // card with the veil instead of blanking it. Every painter settles it.
  if (host.querySelector('.dh-kv') || host.querySelector('.dh-unknown')) host.classList.add('fx-chart-loading');
  else host.innerHTML = skeletonRows(2, 22, 'Reading the drive’s own report…');
  let device = null;
  try {
    // The topology map (A5) already knows which physical drive holds this root.
    device = smartDeviceFor(await topologyAnswer(), state.root && state.root.path);
  } catch { /* topology is optional; the forecast half still answers */ }

  let data;
  try {
    data = await api(`/api/health/smart?scanId=${state.scanId}` + (device ? `&device=${encodeURIComponent(device)}` : ''));
  } catch (e) {
    host.classList.remove('fx-chart-loading');
    fxDriveGaugeDrop();
    host.innerHTML = `<div class="muted">${escapeHtml(e.message)}</div>`;
    return;
  }
  // Held so a dashboard re-entry rebuilds the gauge from state instead of
  // shelling out to smartctl again (the donut's state.types precedent).
  state.driveHealth = data;
  renderDriveHealth();
}

function renderDriveHealth() {
  const host = $('driveHealthBody');
  const data = state.driveHealth;
  if (!host || !data) return;
  host.classList.remove('fx-chart-loading'); // every paint settles the veil
  fxDriveGaugeDrop(); // destroy BEFORE the rewrite that would strand the handle

  const outlook = data.outlook || {};
  const summary = `<div class="dh-summary">${escapeHtml(outlook.summary || '')}</div>`;

  if (!data.available) {
    // §3.5 state 5: unavailable, with the reason and what to do about it.
    host.innerHTML = summary +
      `<div class="dh-unknown">${icon('alert', 14)}<span>${escapeHtml(data.reason || 'Drive health cannot be read on this system.')}</span></div>`;
    return;
  }

  const s = data.smart || {};
  // The one 0..100 figure the endpoint really returns: NVMe/SSD wear — 0 at
  // manufacture, 100 at the rated endurance. The spec allows values past 100
  // on a worn drive, and a gauge clamped full would understate that, so past
  // 100 the figure stays a text row. The gauge gives the drive's own number
  // a shape — still no verdict of TreeMap's.
  const wear = typeof s.percentageUsed === 'number' && s.percentageUsed >= 0 && s.percentageUsed <= 100
    ? s.percentageUsed : null;
  const rows = [
    s.modelName ? ['Drive', escapeHtml(s.modelName)] : null,
    wear === null && s.percentageUsed !== null && s.percentageUsed !== undefined
      ? ['Write endurance used', `${escapeHtml(String(s.percentageUsed))}%`] : null,
    s.powerOnHours !== null && s.powerOnHours !== undefined
      ? ['Powered on for', `${formatCount(Math.round(s.powerOnHours))} hours`] : null,
    s.reallocatedSectors !== null && s.reallocatedSectors !== undefined
      ? ['Reallocated sectors', formatCount(s.reallocatedSectors)] : null,
    s.temperatureCelsius !== null && s.temperatureCelsius !== undefined
      ? ['Temperature', `${escapeHtml(String(s.temperatureCelsius))} °C`] : null,
    // The device's own words, attributed to the device — never restated as ours.
    s.selfAssessmentPassed !== null && s.selfAssessmentPassed !== undefined
      ? ['The drive’s own self-check', s.selfAssessmentPassed ? 'reports passed' : 'reports not passed']
      : ['The drive’s own self-check', 'not reported'],
  ].filter(Boolean);

  const gauge = wear === null ? '' :
    `<div class="dh-gauge-wrap"><canvas id="dhGaugeCanvas" role="img" aria-label="Write endurance used: ${wear}%"></canvas></div>`;

  host.innerHTML = summary + gauge +
    '<div class="dh-kv">' + rows.map(([k, v]) => `<span class="k">${k}</span><span>${v}</span>`).join('') + '</div>' +
    `<div class="dh-foot">${escapeHtml(data.mechanism)} · ${escapeHtml(data.devicePath || '')}</div>`;

  if (wear !== null) {
    dhGauge = FxCharts.gauge($('dhGaugeCanvas'), {
      value: wear / 100,
      orientation: 'linear', linearHeight: 20, notches: 40, notchCornerRadius: 2,
      label: 'Write endurance used',
      activeGradient: FxCharts.ramp(2), // the accent ramp's endpoints
    });
  }
}

/* ──────────────────────────── Security view (§C5) ────────────────────────────
   Names and locations only — nothing here has ever opened a file, and the panel
   says so, because a tool that reads your keys is a different kind of tool.
   There is deliberately NO delete: false positives in this category are
   expensive, so the only actions are "show me" and "put it somewhere sensible". */
const SEVERITY_LABEL = { high: 'Serious', medium: 'Worth fixing', low: 'Minor' };

async function loadSecurity(force = false) {
  if (!state.scanId || !state.root) return;
  if (!force && state.security.loadedFor === state.scanId) { renderSecurity(); return; }
  const host = $('securityBody');
  host.innerHTML = skeletonRows(5, 40);
  $('securityInfo').textContent = '';
  try {
    state.security.report = await api('/api/security/findings?scanId=' + state.scanId);
    state.security.loadedFor = state.scanId;
    renderSecurity();
  } catch (e) {
    state.security.report = null;
    host.innerHTML = `<div class="muted">${escapeHtml(e.message)}</div>`;
  }
}

function renderSecurity() {
  const host = $('securityBody');
  const report = state.security.report;
  if (!report) return;
  const findings = report.findings || [];
  if (!findings.length) {
    $('securityInfo').textContent = '';
    host.innerHTML = `<div class="muted" style="display:flex;align-items:center;gap:8px;padding:10px 2px;">${icon('checkCircle', 15)}
      Nothing out of place. TreeMap checked ${formatCount(report.patternCount || 0)} kinds of key, credential and wallet file
      against the folders each one belongs in — by name and location only, never by opening anything.</div>`;
    return;
  }
  const { high = 0, medium = 0 } = report.counts || {};
  // The server counts every finding and lists the most serious ones (QA D77),
  // so the headline and the counts describe the disk, not the list.
  const total = report.total ?? findings.length;
  // Every finding is reachable (E09): the server lists them 500 at a time,
  // most serious first, and "Show more" asks for the next page.
  const unshown = Math.max(0, total - findings.length);
  // A file in a folder installed software or the operating system keeps for
  // itself is listed, never called misplaced (H05). The server counts them over
  // every finding, as it counts the total. Said as what they are: an app's own
  // files, but also a program's data folder (Application Support, Containers,
  // AppData) and package folders — a key a person saved in a tool's data
  // folder did not ship inside anything, so never "ship inside", and nothing
  // reassures that nothing is out of place (review F1.3).
  const owned = Math.min(total, report.appOwnedCount || 0);
  const misplaced = total - owned;
  const ships = `${owned === 1 ? 'sits in a folder' : 'sit in folders'} that installed software or the operating system keeps for itself (a program, its data or its packages)`;
  const headline = misplaced
    ? `<b>${formatCount(misplaced)}</b> ${misplaced === 1 ? 'file' : 'files'} sitting outside the folder ${misplaced === 1 ? 'it belongs' : 'they belong'} in` +
      // Serious and worth fixing are never app-owned: those are always minor.
      (high ? ` — <b>${formatCount(high)} serious</b>` : '') + (medium ? `${high ? ',' : ' —'} ${formatCount(medium)} worth fixing` : '') + '.' +
      (owned ? ` ${formatCount(owned)} more ${ships}.` : '')
    : `The ${owned === 1 ? 'file' : `${formatCount(owned)} files`} below ${ships}: listed for awareness, not to move.`;
  // Keyed by scan, like the apps line: a repaint of the same scan rolls the
  // counts (a relocation re-checks), a new scan snaps.
  FxNum.rollHtml($('securityInfo'),
    headline +
    ` <span class="sec-note">Matched on name and location only; no file was opened and nothing leaves this computer.</span>` +
    (unshown ? ` <span class="num">(the ${formatCount(findings.length)} most serious shown — ${formatCount(unshown)} more below)</span>` : ''), state.scanId);

  host.innerHTML = '<div class="sec-list">' + findings.map((f, i) => `
    <div class="sec-item sev-${escapeHtml(f.severity)}">
      <span class="sec-sev">${escapeHtml(SEVERITY_LABEL[f.severity] || f.severity)}</span>
      <div class="meta">
        <div class="nm"><span class="sec-name">${escapeHtml(f.name)}</span><span class="sec-kind">${escapeHtml(f.label)}</span></div>
        <div class="pth">${escapeHtml(f.path)}</div>
        <div class="sec-why">${escapeHtml(f.reason)} ${escapeHtml(f.why)}</div>
        ${f.suggestedPath && f.relocateRefusal ? `<div class="sec-why sec-move-off">${icon('shield', 12)} ${escapeHtml(f.relocateRefusal)}</div>` : ''}
      </div>
      ${f.size == null // a hard link's second name whose size could not be read (B17)
        ? '<span class="size-badge" title="TreeMap could not read this file’s size">size unknown</span>'
        : `<span class="size-badge num">${formatBytes(f.size)}</span>`}
      <button class="pill" data-sec-reveal="${i}">${icon('external', 13)} Show me</button>
      ${f.suggestedPath && !f.relocateRefusal // offered only where the server will move it (E10)
        ? `<button class="pill" data-sec-move="${i}">${icon('shield', 13)} Move to ${escapeHtml(baseName(f.suggestedPath))}</button>` : ''}
    </div>`).join('') + '</div>' +
    (unshown ? `<div class="sec-more"><button class="pill" data-sec-more>${icon('plus', 13)} Show more</button>` +
      ` <span class="muted num">${formatCount(findings.length)} of ${formatCount(total)} shown, most serious first</span></div>` : '');

  host.querySelectorAll('[data-sec-reveal]').forEach(b =>
    b.addEventListener('click', () => openInOS(findings[+b.dataset.secReveal].path, true)));
  host.querySelectorAll('[data-sec-move]').forEach(b =>
    b.addEventListener('click', () => confirmRelocateSecret(findings[+b.dataset.secMove])));
  host.querySelectorAll('[data-sec-more]').forEach(b => b.addEventListener('click', () => loadMoreSecurity()));
}

/** The report a "Show more" page is on its way for: a second press meanwhile asks nothing (review F1.11). */
let securityMoreFor = null;

/**
 * The next page of findings, appended (E09: 500 of 801 were shown and the
 * other 301 could not be reached). A newer scan or a newer page owns the
 * panel by the time this lands, so this one is dropped. Focus moves to the
 * first finding it brought in, never to the page. While the page is on its
 * way the button is disabled and busy, and a second press asks nothing:
 * every request re-walks the whole scan on the server.
 */
async function loadMoreSecurity() {
  const report = state.security.report;
  if (!report || securityMoreFor === report) return;
  securityMoreFor = report;
  const button = $('securityBody').querySelector('[data-sec-more]');
  if (button) { button.disabled = true; button.setAttribute('aria-busy', 'true'); }
  const scanId = state.scanId;
  const from = report.findings.length;
  try {
    const page = await api(`/api/security/findings?scanId=${scanId}&offset=${from}`);
    if (state.scanId !== scanId || state.security.report !== report) return;
    state.security.report = { ...report, findings: [...report.findings, ...page.findings], counts: page.counts, total: page.total, appOwnedCount: page.appOwnedCount, truncated: page.truncated };
    renderSecurity();
    $('securityBody').querySelector(`[data-sec-reveal="${from}"]`)?.focus();
  } catch (e) {
    toast('Could not list more findings: ' + e.message, 'error');
  } finally {
    if (securityMoreFor === report) securityMoreFor = null;
    // A page that landed drew a new button; one that failed, or was dropped, hands this one back.
    if (button) { button.disabled = false; button.removeAttribute('aria-busy'); }
  }
}

/** Confirm and run a single move. Never a delete; an occupied destination aborts. */
function confirmRelocateSecret(finding) {
  const to = finding.suggestedPath + '/' + finding.name;
  $('confirmTitle').innerHTML = icon('shield', 18) + 'Move it somewhere safer?';
  $('confirmText').innerHTML =
    `Move <b>${escapeHtml(finding.name)}</b> to <b>${escapeHtml(to)}</b>.<br>` +
    `<span style="color:var(--text-3)">Nothing is deleted, and if something is already there the move is cancelled instead of overwriting it. ` +
    `<b>Anything that refers to the old path</b> — an SSH config, a script, an app setting — <b>will need updating</b>.</span>`;
  onConfirmTrash = async () => {
    try {
      await api('/api/security/relocate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: finding.path, to, confirm: true }),
      });
      toast(`Moved to ${baseName(finding.suggestedPath)}`);
      rescan();
    } catch (e) {
      toast('Not moved: ' + e.message, 'error');
    }
  };
  setConfirmButton('Move it', 'shield');
  $('confirmModal').classList.add('open');
}

/* ───────────────────────────── Games view (§C7) ─────────────────────────────
   Structurally the Apps tab, per title instead of per app. The only action is
   clearing shader caches: everything else here costs a redownload, a mod
   re-subscribe, or a destroyed Proton prefix. */
const LAUNCHER_LABEL = { steam: 'Steam', epic: 'Epic Games', gog: 'GOG Galaxy', itch: 'itch.io' };
const GAME_PART = {
  base: { label: 'Game', hint: 'The game itself — removing it means downloading it again.' },
  dlc: { label: 'DLC', hint: 'Add-on content this game keeps in its own folder.' },
  shaderCache: { label: 'Shader cache', hint: 'Compiled shaders. Safe to clear — the game rebuilds them.' },
  workshop: { label: 'Workshop / mods', hint: 'Subscribed Workshop items and their downloads.' },
  compatPrefix: { label: 'Proton prefix', hint: 'The Windows compatibility prefix, including saves for some games.' },
};

/**
 * The shader-cache rows for one title (v4 §4.2).
 *
 * Games gets add-to-cart on the **shader cache only**. That restriction is the
 * feature's original safety guarantee, not a default anyone may widen: the
 * base install costs a redownload, the Workshop folder costs a re-subscribe,
 * and a Proton prefix holds saves for some titles. A shader cache is the one
 * part the game rebuilds by itself, which is exactly why "Clear shader caches
 * safely" was the only button C7 ever shipped.
 *
 * Returns '' when a title has no shader cache, so nothing is drawn at all —
 * §4.2 asks for no button rather than a disabled one.
 */
function gameCartRows(t) {
  const shaders = (t.components || []).filter((c) => c.kind === 'shaderCache' && c.bytes > 0);
  if (!shaders.length) return '';
  return `<div class="game-shaders">` + shaders.map((c) => `
        <div class="game-shader">
          <span class="gl"><i class="gp-shaderCache"></i>Shader cache</span>
          <span class="pth" title="${escapeHtml(c.path)}">${escapeHtml(c.path)}</span>
          <span class="size-badge num">${formatBytes(c.bytes)}</span>
          ${cartButtonHtml(c.path, `the shader cache for ${t.name}`)}
        </div>`).join('') + `</div>`;
}
