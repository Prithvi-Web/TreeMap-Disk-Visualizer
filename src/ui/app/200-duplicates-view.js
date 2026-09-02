/* ───────────────────────────── Duplicates view ───────────────────────────── */

/**
 * A tree can be on screen with no scan behind it.
 *
 * Two ways in: the index paints a folder before the background scan has an id,
 * and Stop leaves the previous tree up when a rescan is abandoned with nothing
 * settled behind it. Both used to mount this view and return in silence, which
 * left the markup's own "Scanning for duplicates…" standing over an empty card
 * — a sentence that would never come true (§3.5). Both panes say what is
 * actually missing instead, because both are one tab click apart.
 */
function dupNeedsScan() {
  $('dupSummary').textContent = 'Needs a completed scan.';
  $('dupBody').innerHTML = `<div class="card glass"><div class="muted" style="display:flex;align-items:center;gap:8px;padding:10px 2px;">${icon('alert', 15)} Finding duplicates compares file contents, so it needs a finished scan of this folder. Press Scan to run one.</div></div>`;
  updateDupToolbar();
}

function ndNeedsScan() {
  $('ndSummary').textContent = 'Needs a completed scan.';
  $('ndBody').innerHTML = `<div class="card glass"><div class="muted" style="display:flex;align-items:center;gap:8px;padding:10px 2px;">${icon('alert', 15)} Finding similar images reads the pictures themselves, so it needs a finished scan of this folder. Press Scan to run one.</div></div>`;
  updateNdToolbar();
}

async function loadDuplicates(force = false) {
  if (!state.root) return;                          // the welcome screen is up
  if (!state.scanId) { dupNeedsScan(); return; }
  const key = state.scanId + ':' + $('dupMinSize').value;
  if (!force && state.dup.loadedFor === key && state.dup.status === 'complete') { renderDuplicates(); return; }
  state.dup.loadedFor = key;
  state.dup.status = 'loading';
  state.dup.selection.clear();
  clearTimeout(state.dup.pollTimer);
  fxOrbHide('dup'); // a re-entry rewrites the progress card — never strand the old orb
  fxHuntBeamSync('dupBody', false); // and never strand the old card's ring
  $('dupSummary').textContent = 'Looking for duplicates…';
  updateDupToolbar();
  // FX: the "solving" orb replaces the loader icon; same slot in the card.
  // The card's md ring rides the same flag as the orb, through the same doors.
  $('dupBody').innerHTML = `<div class="card glass dup-progress"><span class="fx-orb-well"></span>
    <span id="dupProgText" class="fx-shimmer-text">Comparing file sizes…</span>
    <div class="track"><div class="fill" id="dupProgFill"></div></div></div>`;
  fxOrbShow('dup', $('dupBody').querySelector('.fx-orb-well'), 'solving');
  fxHuntBeamSync('dupBody', true);

  const poll = async () => {
    if (state.dup.loadedFor !== key) return; // a newer request superseded this one
    try {
      // `pending: 'return'` because this loop exists to PAINT the 202 body:
      // the wrapper's own poll can wait, but it cannot draw a progress bar.
      const data = await api(`/api/duplicates?scanId=${state.scanId}&minSize=${$('dupMinSize').value}`,
        undefined, { pending: 'return' });
      if (data.status === 'running') {
        const t = $('dupProgText'), f = $('dupProgFill');
        if (t) t.textContent = data.toHash
          ? `Hashing candidates… ${formatCount(data.hashed)} / ${formatCount(data.toHash)} files`
          : 'Comparing file sizes…';
        if (f && data.toHash) f.style.width = Math.round((data.hashed / data.toHash) * 100) + '%';
        state.dup.pollTimer = setTimeout(poll, 700);
        return;
      }
      fxOrbHide('dup'); // the hunt settled — the orb goes before the card does
      fxHuntBeamSync('dupBody', false); // the ring too — renderDuplicates rewrites the host
      state.dup.status = 'complete';
      state.dup.groups = data.groups;
      state.dup.groupCount = data.groupCount;
      state.dup.totalReclaimable = data.totalReclaimable;
      // A group's files carry no size of their own — every copy is g.size by
      // definition. Seed them so selection totals are right even for copies the
      // pruned tree left out.
      for (const g of data.groups) seedNodes(g.files.map((f) => ({ ...f, size: g.size, type: 'file' })));
      renderDuplicates();
    } catch (e) {
      fxOrbHide('dup');
      fxHuntBeamSync('dupBody', false); // the error rewrite below destroys the card
      state.dup.status = 'error';
      $('dupSummary').textContent = '';
      $('dupBody').innerHTML = `<div class="card glass"><div class="muted">Duplicate search failed: ${escapeHtml(e.message)}</div></div>`;
    }
  };
  poll();
}

function renderDuplicates() {
  const body = $('dupBody');
  const groups = state.dup.groups;
  if (state.dup.shown === undefined) state.dup.shown = DUP_PAGE;
  if (!groups.length) {
    $('dupSummary').textContent = 'No duplicates found.';
    body.innerHTML = `<div class="card glass"><div class="muted" style="display:flex;align-items:center;gap:8px;">${icon('checkCircle', 15)} No duplicate files above the size threshold — nothing to reclaim.</div></div>`;
    updateDupToolbar();
    return;
  }
  // Keyed by scan+threshold: a re-run of the SAME hunt rolls its numbers,
  // a different scan or threshold snaps.
  FxNum.rollHtml($('dupSummary'),
    `<b>${formatCount(state.dup.groupCount)}</b> duplicate group${state.dup.groupCount === 1 ? '' : 's'} — up to <b>${formatBytes(state.dup.totalReclaimable)}</b> reclaimable` +
    (state.dup.groupCount > groups.length ? ` <span class="num">(top ${groups.length} shown)</span>` : ''), state.dup.loadedFor);
  const shown = Math.min(state.dup.shown, groups.length);
  // The mini-bar scales against the biggest reclaim among the SHOWN groups —
  // the ordering the list already has — so bars and rank agree.
  const maxRec = groups.slice(0, shown).reduce((m, g) => Math.max(m, g.reclaimable), 1);
  body.innerHTML = '<div class="dup-list">' + groups.slice(0, shown).map((g, gi) => {
    const ext = (g.files[0].name.split('.').pop() || '').toLowerCase();
    return `
    <div class="dup-group glass" data-g="${gi}">
      <div class="dup-head" role="button" tabindex="0" aria-expanded="false">
        <span class="chev">${icon('chevronRight', 14)}</span>
        ${chipFor({ type: 'file', extension: ext })}
        <div class="meta">
          <div class="nm">${escapeHtml(g.files[0].name)}</div>
          <div class="sub num">${g.count} copies × ${formatBytes(g.size)} · sha-256 ${g.hash.slice(0, 12)}…</div>
        </div>
        <div class="bar-track dup-mini"><div class="fx-bar-fill" data-w="${Math.max(4, (g.reclaimable / maxRec) * 100).toFixed(1)}" style="${fxBarStyle(gi)}"></div></div>
        <span class="reclaim num">+${formatBytes(g.reclaimable)} reclaimable</span>
        <button class="pill" data-dupe-view="${gi}" title="Side by side — thumbnails, dates, dimensions, and which copy to keep">Compare</button>
      </div>
      <div class="dup-files"></div>
    </div>`;
  }).join('') + '</div>' +
    (shown < groups.length
      ? `<div style="display:flex;justify-content:center;margin-top:12px;">
           <button class="btn" id="dupShowMore">Show ${Math.min(DUP_PAGE, groups.length - shown)} more of ${groups.length - shown} remaining</button>
         </div>`
      : '');

  const more = $('dupShowMore');
  if (more) more.addEventListener('click', () => { state.dup.shown += DUP_PAGE; renderDuplicates(); });

  fxBarsIn(body); // the per-group reclaim mini-bars
  refreshCartButtons();
  updateDupToolbar();
}

/**
 * Build one group's file rows, once, the first time it is opened.
 *
 * Groups render collapsed, so building every row up front put a DOM nobody
 * was looking at on screen: measured on a real 768-group result, one 3.4 MB
 * innerHTML write producing 26,675 elements and 1,484 cart buttons, and a
 * ~400 ms main-thread freeze on EVERY visit to the tab — eight times §2.5's
 * 50 ms budget for a single UI action.
 *
 * Those 1,484 buttons are also exactly the population `refreshCartButtons`
 * documents as having cost 30.5 ms per cart click, from a list the user was
 * not even looking at. Filling on expand fixes both at once.
 *
 * Selection state is read from `state.dup.selection` here rather than fixed
 * up afterwards, so a row built late is still correct — which is what lets
 * "select all extras" keep working without touching unbuilt rows.
 */
function dupFillGroup(groupEl) {
  if (!groupEl || groupEl.dataset.filled === '1') return;
  const g = state.dup.groups[Number(groupEl.dataset.g)];
  if (!g) return;
  groupEl.querySelector('.dup-files').innerHTML = g.files.map((f, fi) => `
        <div class="dup-file">
          <input type="checkbox" class="dup-ck" data-p="${escapeHtml(f.path)}"${state.dup.selection.has(f.path) ? ' checked' : ''} aria-label="Select ${escapeHtml(f.path)}">
          ${fi === 0 ? '<span class="tag">newest</span>' : ''}
          <span class="pth" title="${escapeHtml(f.path)}">${escapeHtml(f.path)}</span>
          <span class="dt num">${formatDate(f.modifiedAt)}</span>
          <button class="icon-btn${cartHas(f.path) ? ' cartin' : ''}" data-cart-add="${escapeHtml(f.path)}" data-cartin="${cartHas(f.path) ? '1' : '0'}" title="${cartHas(f.path) ? 'Remove from cleanup cart' : 'Add to cleanup cart'}" aria-label="Add ${escapeHtml(f.name)} to cleanup cart">${icon(cartHas(f.path) ? 'check' : 'plus', 13)}</button>
          <button class="icon-btn" data-reveal="${escapeHtml(f.path)}" title="Reveal in file manager" aria-label="Reveal ${escapeHtml(f.name)}">${icon('external', 13)}</button>
        </div>`).join('');
  groupEl.dataset.filled = '1';
  refreshCartButtons();
}

/* One delegated set of listeners serves every duplicate row for the life of
   the page: wiring each of ~2,400 controls per render used to cost twice as
   much main-thread time as building the HTML itself. Selection state is
   rendered into the markup, so a rebuild needs no per-row fix-up pass. */
function dupToggleHead(head) {
  const g = head.closest('.dup-group');
  // Fill before opening, so the rows are there the moment it expands.
  if (!g.classList.contains('open')) dupFillGroup(g);
  head.setAttribute('aria-expanded', String(g.classList.toggle('open')));
}
$('dupBody').addEventListener('click', (e) => {
  const reveal = e.target.closest('[data-reveal]');
  if (reveal) { openInOS(reveal.dataset.reveal, true); return; }
  const head = e.target.closest('.dup-head');
  if (head && !e.target.closest('input,button')) dupToggleHead(head);
});
$('dupBody').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const head = e.target.closest('.dup-head');
  if (head && e.target === head) { e.preventDefault(); dupToggleHead(head); }
});
$('dupBody').addEventListener('change', (e) => {
  const ck = e.target.closest('.dup-ck');
  if (!ck) return;
  if (ck.checked) state.dup.selection.add(ck.dataset.p);
  else state.dup.selection.delete(ck.dataset.p);
  updateDupToolbar();
});

/* The reclaim funnel: everything the hunt found → what is selected → what
   of that is already staged in the cleanup cart. All three live in state
   this view already keeps; the funnel exists only while a selection does —
   an empty funnel would be decoration, not a statement. */
let dupFunnelHandle = null;
function dupFunnelDrop() {
  if (dupFunnelHandle) { dupFunnelHandle.destroy(); dupFunnelHandle = null; }
  $('dupFunnel').hidden = true;
}

function updateDupToolbar() {
  const n = state.dup.selection.size;
  let total = 0;
  for (const p of state.dup.selection) total += nodeFor(p)?.size ?? 0;
  $('dupTrashBtn').disabled = !n;
  $('dupTrashBtn').innerHTML = icon('trash', 14) + (n ? `Move ${n} to Trash (${formatBytes(total)})` : 'Move to Trash');
  $('dupOffloadBtn').disabled = !n;
  if (n && state.dup.status === 'complete') {
    let staged = 0;
    for (const p of state.dup.selection) if (cartHas(p)) staged += nodeFor(p)?.size ?? 0;
    const spec = {
      stages: [
        { name: 'Duplicate bytes', value: state.dup.totalReclaimable },
        { name: 'Selected', value: total },
        { name: 'Staged in cart', value: staged },
      ],
      trackSize: 46,
    };
    $('dupFunnel').hidden = false;
    if (dupFunnelHandle) dupFunnelHandle.update(spec);
    else dupFunnelHandle = FxCharts.funnel($('dupFunnel'), spec);
  } else {
    dupFunnelDrop();
  }
}

$('dupAutoBtn').addEventListener('click', () => {
  if (state.dup.status !== 'complete' || !state.dup.groups.length) return;
  state.dup.selection.clear();
  // Selection comes from the DATA, so groups past the render window are
  // selected too — and their checkboxes read correctly whenever they are drawn.
  state.dup.groups.forEach(g => g.files.slice(1).forEach(f => state.dup.selection.add(f.path)));
  $('dupBody').querySelectorAll('.dup-group').forEach(g => {
    // An explicit bulk action, so building every row here is the cost the
    // user asked for — unlike merely opening the tab, which now builds none.
    dupFillGroup(g);
    g.classList.add('open');
    g.querySelector('.dup-head').setAttribute('aria-expanded', 'true');
  });
  $('dupBody').querySelectorAll('.dup-ck').forEach(ck => { ck.checked = state.dup.selection.has(ck.dataset.p); });
  updateDupToolbar();
  toast(`Selected ${state.dup.selection.size} extra copies — the newest copy in each group is kept`);
});
$('dupTrashBtn').addEventListener('click', () => {
  for (const g of state.dup.groups) {
    if (g.files.every(f => state.dup.selection.has(f.path))) {
      toast(`All ${g.count} copies of “${g.files[0].name}” are selected — keep at least one`, 'error');
      return;
    }
  }
  confirmTrash([...state.dup.selection]);
});
$('dupMinSize').addEventListener('change', () => loadDuplicates(true));

/* ── Near-duplicate images (Feature 12) ── */
function setDupMode(mode) {
  state.dupMode = mode;
  $('dupModeSeg').querySelectorAll('button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.dupmode === mode)));
  $('dupPaneExact').hidden = mode !== 'exact';
  $('dupPaneNear').hidden = mode !== 'near';
  // The loaders own the "no scan behind this tree" answer; switching panes must
  // reach it, or the pane the user just revealed is the silent blank again.
  if (!state.root) return;
  if (mode === 'near') loadNearDupes(); else loadDuplicates();
}
$('dupModeSeg').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  setDupMode(b.dataset.dupmode);
});

async function loadNearDupes(force = false) {
  if (!state.root) return;                          // the welcome screen is up
  if (!state.scanId) { ndNeedsScan(); return; }
  const key = state.scanId + ':' + $('ndThreshold').value;
  if (!force && state.near.loadedFor === key && state.near.status === 'complete') { renderNearDupes(); return; }
  state.near.loadedFor = key;
  state.near.status = 'loading';
  state.near.selection.clear();
  clearTimeout(state.near.pollTimer);
  $('ndSummary').textContent = 'Looking for similar images…';
  updateNdToolbar();
  $('ndBody').innerHTML = `<div class="card glass dup-progress">${icon('loader', 22, REDUCED ? '' : 'spin')}
    <span id="ndProgText" class="fx-shimmer-text">Finding image files…</span>
    <div class="track"><div class="fill" id="ndProgFill"></div></div></div>`;

  const poll = async () => {
    if (state.near.loadedFor !== key) return; // a newer request superseded this one
    try {
      // Same reason as the exact finder: the 202 body IS this loop's progress.
      const data = await api(`/api/near-duplicates?scanId=${state.scanId}&threshold=${$('ndThreshold').value}`,
        undefined, { pending: 'return' });
      if (data.status === 'running') {
        const t = $('ndProgText'), f = $('ndProgFill');
        if (t) t.textContent = data.toHash
          ? `Fingerprinting images… ${formatCount(data.hashed)} / ${formatCount(data.toHash)}`
          : 'Finding image files…';
        if (f && data.toHash) f.style.width = Math.round((data.hashed / data.toHash) * 100) + '%';
        state.near.pollTimer = setTimeout(poll, 700);
        return;
      }
      state.near.status = 'complete';
      state.near.available = data.available;
      state.near.reason = data.reason;
      state.near.clusters = data.clusters;
      for (const c of data.clusters) seedNodes(c.files); // NearDupeFile carries its own size
      state.near.clusterCount = data.clusterCount;
      state.near.totalReclaimable = data.totalReclaimable;
      state.near.truncated = data.truncated;
      renderNearDupes();
    } catch (e) {
      state.near.status = 'error';
      $('ndSummary').textContent = '';
      $('ndBody').innerHTML = `<div class="card glass"><div class="muted">Image scan failed: ${escapeHtml(e.message)}</div></div>`;
    }
  };
  poll();
}

/*
 * Rendering the result is windowed, not all-at-once.
 *
 * Measured on a 1,820-image corpus that clustered into one group of 1,556: the
 * old "one innerHTML with every cluster and every image" added **28,196 DOM
 * nodes, 3.7 MB of HTML and 7,830 event listeners**, laid out a single flex
 * strip **224,052 px** wide, and fired 1,564 thumbnail requests at a bucket
 * that allows 20. Worse, none of it was ever released — the view is hidden, not
 * emptied — so every later `refreshCartButtons()` walked 1,574 buttons and
 * rewrote each one's SVG, costing **30.5 ms of blocked main thread per cart
 * click in every other view**. That is the "TreeMap goes slow and glitchy after
 * near-duplicates run" report, exactly.
 *
 * So clusters render a batch at a time, each cluster shows a bounded number of
 * images with an explicit "show more", every handler is delegated from #ndBody
 * (four listeners total, not four per image), and unmount empties the body.
 */
const ND_CLUSTER_BATCH = 4;    // clusters appended per step — a quarter the mid-scroll parse it used to be
const ND_ITEMS_PER_STEP = 12;  // images revealed per cluster per step — a wrapped cluster shows two rows, not a 3.4k px strip
/** Retries a thumbnail gets before it is called broken (covers a transient 429). */
const ND_THUMB_RETRIES = 2;

function ndItemHtml(f, fi) {
  const badge = fi === 0
    ? '<span class="nd-badge new">newest</span>'
    : `<span class="nd-badge" title="${f.distance} bits different from the newest copy">Δ${f.distance}</span>`;
  return `
      <div class="nd-item">
        <div class="nd-thumbwrap" data-p="${escapeHtml(f.path)}" role="button" tabindex="0" aria-label="Toggle ${escapeHtml(f.name)}">
          <input type="checkbox" class="nd-ck" data-p="${escapeHtml(f.path)}" aria-label="Select ${escapeHtml(f.name)}">
          <img class="nd-thumb" loading="lazy" decoding="async" src="/api/files/preview?path=${encodeURIComponent(f.path)}&thumb=1" alt="${escapeHtml(f.name)}">
          ${badge}
        </div>
        <div class="nd-info">
          <div class="nm" title="${escapeHtml(f.path)}">${escapeHtml(f.name)}</div>
          <div class="sub num">${formatBytes(f.size)} · ${formatDate(f.modifiedAt)}</div>
          <div class="acts">
            <button class="icon-btn${cartHas(f.path) ? ' cartin' : ''}" data-cart-add="${escapeHtml(f.path)}" data-cartin="${cartHas(f.path) ? '1' : '0'}" title="${cartHas(f.path) ? 'Remove from cleanup cart' : 'Add to cleanup cart'}" aria-label="Add ${escapeHtml(f.name)} to cleanup cart">${icon(cartHas(f.path) ? 'check' : 'plus', 14)}</button>
            <button class="icon-btn" data-reveal="${escapeHtml(f.path)}" title="Reveal in file manager" aria-label="Reveal ${escapeHtml(f.name)}">${icon('external', 13)}</button>
          </div>
        </div>
      </div>`;
}

/** The trailing "+N more" control inside a cluster strip, or '' when it is fully shown. */
function ndMoreItemHtml(ci, shown, total) {
  const rest = total - shown;
  if (rest <= 0) return '';
  return `<div class="nd-item nd-more"><button class="nd-morebtn" data-nd-more="${ci}"
      aria-label="Show more images in this group">${icon('plus', 16)}<span>${formatCount(rest)} more</span></button></div>`;
}

function ndClusterHtml(c, ci, shown) {
  const files = c.files.slice(0, shown);
  return `
    <div class="nd-cluster glass" data-c="${ci}">
      <div class="nd-chead">
        ${icon('image', 15)}
        <span class="nd-count">${formatCount(c.count)} similar images</span>
        ${c.count > shown ? `<span class="nd-shown num">showing ${formatCount(shown)}</span>` : ''}
        <span class="reclaim num">+${formatBytes(c.reclaimableBytes)} reclaimable</span>
        <button class="pill" data-nd-view="${ci}" title="Side by side with the differing regions highlighted">Compare</button>
      </div>
      <div class="nd-strip">${files.map(ndItemHtml).join('')}${ndMoreItemHtml(ci, shown, c.count)}</div>
    </div>`;
}

/** Append the next batch of clusters, and the sentinel that asks for the one after. */
function ndAppendClusters() {
  const n = state.near;
  const list = $('ndBody').querySelector('.nd-list');
  if (!list) return;
  const old = list.querySelector('.nd-loadmore');
  if (old) old.remove();

  const from = n.renderedClusters;
  const to = Math.min(n.clusters.length, from + ND_CLUSTER_BATCH);
  let html = '';
  for (let ci = from; ci < to; ci++) {
    const shown = Math.min(n.clusters[ci].count, ND_ITEMS_PER_STEP);
    n.shownPerCluster[ci] = shown;
    html += ndClusterHtml(n.clusters[ci], ci, shown);
  }
  n.renderedClusters = to;
  if (to < n.clusters.length) {
    html += `<div class="nd-loadmore"><button class="btn" data-nd-loadmore="1">Show more groups
      <span class="num">(${formatCount(n.clusters.length - to)} left)</span></button></div>`;
  }
  // Sync only what this append inserted: walking every cluster already on
  // the page made each later append cost more than the one before it.
  const firstNew = list.children.length;
  list.insertAdjacentHTML('beforeend', html);
  ndSyncNewNodes([...list.children].slice(firstNew));
}

/** Reflect selection state on freshly inserted rows and prime their cart buttons. */
function ndSyncNewNodes(scope) {
  const roots = Array.isArray(scope) ? scope : [scope];
  for (const root of roots) root.querySelectorAll('.nd-ck').forEach(ck => {
    const on = state.near.selection.has(ck.dataset.p);
    if (ck.checked !== on) ck.checked = on;
    const w = ck.closest('.nd-thumbwrap');
    if (w) w.classList.toggle('sel', on);
  });
  refreshCartButtons(roots);
  // The pane can be occluded (rAF and IntersectionObserver suspend), so the
  // sentinel is a real button first and observed second — it always works.
  ndObserveSentinel();
}

let ndSentinelObserver = null;
function ndObserveSentinel() {
  if (ndSentinelObserver) { ndSentinelObserver.disconnect(); ndSentinelObserver = null; }
  const sentinel = $('ndBody').querySelector('.nd-loadmore');
  if (!sentinel || typeof IntersectionObserver !== 'function') return;
  ndSentinelObserver = new IntersectionObserver((entries) => {
    // Never auto-append into a page nobody is looking at: a hidden document can
    // report a zero-height sentinel as permanently intersecting, which would
    // walk the whole result and undo the window. The button still works.
    if (document.hidden) return;
    if (entries.some(e => e.isIntersecting)) ndAppendClusters();
  }, { rootMargin: '1000px' });
  ndSentinelObserver.observe(sentinel);
}

/** Free the rendered DOM. Called on unmount so its cost cannot follow the user. */
function ndClearBody() {
  if (ndSentinelObserver) { ndSentinelObserver.disconnect(); ndSentinelObserver = null; }
  const body = $('ndBody');
  if (body) body.innerHTML = '';
  state.near.renderedClusters = 0;
  state.near.shownPerCluster = {};
}
