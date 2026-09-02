/* ═══════════ Duplicate viewer (v4 §8.2) ═══════════
   Bulk-deleting duplicates is the scariest action in the app; this makes it
   verifiable. Copies sit next to each other — thumbnail, dimensions, EXIF
   capture date, size, mtime, path — with the recommended keep marked and the
   REASON stated (the server's rule, never a bare badge). Near-duplicate
   images also show which of the 64 dHash blocks differ, painted over both
   thumbnails, plus the Hamming distance in plain words. Facts the server
   could not read arrive as null WITH a reason and render as exactly that —
   an absent date is "no capture date recorded", never a guess. Keyboard
   first: ←/→ between groups, 1–9 choose the keeper, Space stages the rest. */
const dupeViewer = { kind: null, at: 0, keeper: 0, data: null, seq: 0, totalCopies: 0 };

function dupeViewerList() {
  return dupeViewer.kind === 'near' ? state.near.clusters : state.dup.groups;
}

async function openDupeViewer(kind, idx) {
  const list = kind === 'near' ? state.near.clusters : state.dup.groups;
  if (!list || !list[idx] || !state.scanId) return;
  const wasOpen = $('dupeViewerModal').classList.contains('open');
  dupeViewer.kind = kind;
  dupeViewer.at = idx;
  dupeViewer.keeper = 0;
  dupeViewer.data = null;
  const seq = ++dupeViewer.seq;
  dupeViewer.totalCopies = list[idx].files.length;
  const paths = list[idx].files.slice(0, 8).map((f) => f.path); // the detail endpoint's own cap
  $('dupeViewerSummary').textContent = 'Reading the copies…';
  $('dupeViewerPanes').innerHTML = '';
  $('dupeViewerModal').classList.add('open');
  if (!wasOpen) document.addEventListener('keydown', dupeViewerKeys);
  // Focus moves INTO the dialog: left behind on the Compare button, Enter
  // would re-open the group and Tab would reach controls beneath the backdrop.
  const dlg = $('dupeViewerModal').querySelector('.modal');
  if (dlg) { dlg.setAttribute('tabindex', '-1'); dlg.focus(); }
  try {
    const data = await api(`/api/duplicates/detail?scanId=${encodeURIComponent(state.scanId)}&paths=${paths.map(encodeURIComponent).join(',')}`);
    if (seq !== dupeViewer.seq) return; // superseded by another open or a close
    dupeViewer.data = data;
    dupeViewer.keeper = data.recommendedKeep ? data.recommendedKeep.index : 0;
    renderDupeViewer();
  } catch (e) {
    if (seq !== dupeViewer.seq) return;
    $('dupeViewerSummary').textContent = 'Could not read the copies: ' + e.message;
  }
}

/** The dHash distance between two images, in the Match dropdown's own vocabulary rather than block counts. */
function dupeSimilarity(d) {
  if (!(d > 0)) return 'looks identical';
  return `${Math.round(100 - (d / 64) * 100)}% similar to the keeper`;
}

function closeDupeViewer() {
  dupeViewer.seq++; // any in-flight detail fetch belongs to a viewer that is gone
  closeModal('dupeViewerModal');
  document.removeEventListener('keydown', dupeViewerKeys);
}

function renderDupeViewer() {
  const d = dupeViewer.data;
  const list = dupeViewerList();
  const total = list ? list.length : 0;
  const rec = d.recommendedKeep ? d.recommendedKeep.index : 0;
  const ref = d.diffReference;
  const firstDiff = d.files.find((f) => f.visualDiff);
  const noDiffWhy = d.files.find((f, i) => i !== ref && f.visualDiffReason)?.visualDiffReason
    || (d.files[0] && d.files[0].visualDiffReason);
  $('dupeViewerSummary').innerHTML =
    `<span class="num">Group ${dupeViewer.at + 1} of ${formatCount(total)}</span>` +
    (firstDiff ? ` · ${escapeHtml(firstDiff.visualDiff.summary)}` : '') +
    (ref != null && firstDiff ? ` <span class="dv-absent">— differing regions highlighted against copy ${ref + 1}</span>` : '') +
    (!firstDiff && noDiffWhy
      ? ` · <span class="dv-absent">${escapeHtml(noDiffWhy)} — metadata comparison only</span>` : '') +
    (dupeViewer.totalCopies > d.files.length
      ? ` · <span class="dv-absent">comparing the first ${d.files.length} of ${dupeViewer.totalCopies} copies — the rest are not staged from here</span>` : '');
  $('dupeViewerPanes').innerHTML = d.files.map((f, i) => {
    const dims = f.width != null ? `${f.width} × ${f.height}` : null;
    const blocks = f.visualDiff && i !== ref
      ? `<div class="dv-diff" aria-hidden="true">${f.visualDiff.differingBlocks.map((b) =>
          `<i style="left:${(b % 8) * 12.5}%;top:${Math.floor(b / 8) * 12.5}%"></i>`).join('')}</div>`
      : '';
    const keep = i === dupeViewer.keeper;
    const why = keep
      ? (i === rec && d.recommendedKeep ? d.recommendedKeep.reason : 'your pick — 1–9 chooses')
      : '';
    return `
    <div class="dv-pane${keep ? ' keep' : ''}">
      <div class="dv-thumbwrap">
        <img src="/api/files/preview?path=${encodeURIComponent(f.path)}&thumb=1" alt="" loading="lazy"
             onerror="this.hidden = true; this.parentElement.classList.add('noimg');">
        ${blocks}
      </div>
      <div class="dv-facts">
        <div class="nm"><span class="num">${i + 1}.</span> ${escapeHtml(f.name)}
          ${f.newest ? '<span class="tag">newest</span>' : ''}
          ${f.largest ? '<span class="tag">largest</span>' : ''}
          ${keep ? '<span class="tag" style="background:var(--ok);color:#fff;">keep</span>' : ''}
        </div>
        ${keep ? `<div class="dv-keepwhy">${escapeHtml(why)}</div>` : ''}
        <div class="num">${formatBytes(f.size)} · ${formatDate(f.modifiedAt)}</div>
        <div>${dims ? `<span class="num">${dims}</span>` : `<span class="dv-absent">${escapeHtml(f.dimensionsReason || 'not an image')}</span>`}</div>
        <div>${(() => {
          if (!f.captureDate) return `<span class="dv-absent">${escapeHtml(f.captureDateReason || 'no capture date recorded')}</span>`;
          // The server sends EXIF wall-clock time as a timezone-less string;
          // Date.parse reads it as local time, which is what a camera's
          // wall clock means. Fed raw to formatDate it threw (review RD1).
          const ms = Date.parse(f.captureDate);
          return `<span class="num">taken ${Number.isFinite(ms) ? formatDate(ms) : escapeHtml(f.captureDate)}</span>`;
        })()}</div>
        ${f.visualDiff && i !== ref ? `<div class="dv-absent num">${dupeSimilarity(f.visualDiff.hammingDistance)}</div>` : ''}
        <div class="dv-absent" title="${escapeHtml(f.path)}" style="word-break:break-all;">${escapeHtml(f.path)}</div>
        <button class="pill" data-dv-keep="${i}">Keep this one</button>
      </div>
    </div>`;
  }).join('');
}

async function dupeViewerStageOthers() {
  const d = dupeViewer.data;
  if (!d) return;
  const others = d.files.filter((_, i) => i !== dupeViewer.keeper).map((f) => f.path);
  let added = 0;
  for (const p of others) if (!state.cart.has(p)) { state.cart.add(p); added++; }
  saveCart();
  await renderCart();
  refreshCartButtons();
  const beyond = dupeViewer.totalCopies - d.files.length;
  toast(added
    ? `Staged ${added} cop${added === 1 ? 'y' : 'ies'} — the keeper stays put.${beyond > 0 ? ` ${beyond} more cop${beyond === 1 ? 'y was' : 'ies were'} not compared here — use the group's checkboxes for those.` : ''} Review the cart before anything moves.`
    : 'Those copies are already in the cart.');
}

function dupeViewerKeys(e) {
  // Self-heal: if some other path closed the modal, take the listener back.
  if (!$('dupeViewerModal').classList.contains('open')) { closeDupeViewer(); return; }
  // Browser and app chords (Cmd+1 switches tabs) pass through untouched, and
  // so does typing — the same guards every other global handler here carries.
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    e.preventDefault();
    const list = dupeViewerList();
    if (!list || !list.length) return;
    // The list can shrink under an open viewer (threshold change, rescan) —
    // clamp before stepping, or both arrows die out of range (QA D4).
    const cur = Math.min(dupeViewer.at, list.length - 1);
    const next = cur + (e.key === 'ArrowLeft' ? -1 : 1);
    if (list[next]) openDupeViewer(dupeViewer.kind, next);
    else if (cur !== dupeViewer.at) openDupeViewer(dupeViewer.kind, cur);
    return;
  }
  if (e.key >= '1' && e.key <= '9') { // the pair case is '1'/'2'; groups go further
    const i = Number(e.key) - 1;
    if (dupeViewer.data && dupeViewer.data.files[i]) { dupeViewer.keeper = i; renderDupeViewer(); }
    return;
  }
  if (e.key === ' ') {
    e.preventDefault();
    if (e.repeat) return; // a held Space must not machine-gun the cart
    dupeViewerStageOthers();
    return;
  }
  if (e.key === 'Escape') closeDupeViewer();
}

$('dupeViewerClose').addEventListener('click', closeDupeViewer);
$('dupeViewerPanes').addEventListener('click', (e) => {
  const b = e.target.closest('[data-dv-keep]');
  if (b) { dupeViewer.keeper = Number(b.dataset.dvKeep); renderDupeViewer(); }
});
// Capture phase, so a Compare click never also toggles the group head open.
$('dupBody').addEventListener('click', (e) => {
  const b = e.target.closest('[data-dupe-view]');
  if (b) { e.stopPropagation(); openDupeViewer('exact', Number(b.dataset.dupeView)); }
}, true);
$('ndBody').addEventListener('click', (e) => {
  const b = e.target.closest('[data-nd-view]');
  if (b) { e.stopPropagation(); openDupeViewer('near', Number(b.dataset.ndView)); }
}, true);

function renderNearDupes() {
  const body = $('ndBody');
  const n = state.near;
  if (ndSentinelObserver) { ndSentinelObserver.disconnect(); ndSentinelObserver = null; }
  n.renderedClusters = 0;
  n.shownPerCluster = {};
  if (!n.available) {
    $('ndSummary').textContent = '';
    body.innerHTML = `<div class="card glass"><div class="muted" style="display:flex;align-items:center;gap:8px;">${icon('image', 15)} ${escapeHtml(n.reason || 'Near-duplicate image detection is unavailable on this system.')}</div></div>`;
    updateNdToolbar();
    return;
  }
  const clusters = n.clusters;
  if (!clusters.length) {
    $('ndSummary').textContent = 'No near-duplicate images found.';
    body.innerHTML = `<div class="card glass"><div class="muted" style="display:flex;align-items:center;gap:8px;">${icon('checkCircle', 15)} No similar images above the match threshold — your image library looks tidy.</div></div>`;
    updateNdToolbar();
    return;
  }
  // Same rule as the exact-duplicates line: same hunt rolls, new hunt snaps.
  FxNum.rollHtml($('ndSummary'),
    `<b>${formatCount(n.clusterCount)}</b> similar-image ${n.clusterCount === 1 ? 'group' : 'groups'} — up to <b>${formatBytes(n.totalReclaimable)}</b> reclaimable` +
    (n.clusterCount > clusters.length ? ` <span class="num">(top ${clusters.length} shown)</span>` : ''), state.near.loadedFor);
  const note = n.truncated
    ? `<div class="nd-note">${icon('alert', 14)} Only the largest images were compared — some smaller images may not be grouped.</div>` : '';
  body.innerHTML = note + '<div class="nd-list"></div>';
  ndAppendClusters();
  updateNdToolbar();
}

/* One delegated set of handlers for the whole view, attached once. Per-element
   listeners were the other half of the cost: 7,830 of them on a big result. */
(function bindNearDupeDelegation() {
  const body = $('ndBody');
  if (!body) return;

  /* `item` is the .nd-item the interaction came from — a path belongs to exactly
     one cluster, so syncing that one row is enough and avoids a selector built
     from a user-controlled path. */
  const setChecked = (path, on, item) => {
    if (on) state.near.selection.add(path); else state.near.selection.delete(path);
    const ck = item && item.querySelector('.nd-ck');
    if (ck) ck.checked = on;
    const wrap = item && item.querySelector('.nd-thumbwrap');
    if (wrap) wrap.classList.toggle('sel', on);
    updateNdToolbar();
  };

  body.addEventListener('change', (e) => {
    const ck = e.target.closest('.nd-ck');
    if (!ck) return;
    setChecked(ck.dataset.p, ck.checked, ck.closest('.nd-item'));
  });

  body.addEventListener('click', (e) => {
    const more = e.target.closest('[data-nd-more]');
    if (more) {
      e.preventDefault();
      const ci = Number(more.dataset.ndMore);
      const cluster = state.near.clusters[ci];
      if (!cluster) return;
      const shown = state.near.shownPerCluster[ci] || 0;
      const next = Math.min(cluster.count, shown + ND_ITEMS_PER_STEP);
      state.near.shownPerCluster[ci] = next;
      const strip = more.closest('.nd-strip');
      const holder = more.closest('.nd-item');
      holder.insertAdjacentHTML('beforebegin', cluster.files.slice(shown, next).map((f, i) => ndItemHtml(f, shown + i)).join(''));
      holder.outerHTML = ndMoreItemHtml(ci, next, cluster.count);
      const head = strip.parentElement.querySelector('.nd-shown');
      if (head) {
        if (next < cluster.count) head.textContent = `showing ${formatCount(next)}`;
        else head.remove(); // fully shown — the count in the heading says it all
      }
      ndSyncNewNodes(strip);
      return;
    }
    if (e.target.closest('[data-nd-loadmore]')) { e.preventDefault(); ndAppendClusters(); return; }
    const reveal = e.target.closest('[data-reveal]');
    if (reveal) { e.preventDefault(); e.stopPropagation(); openInOS(reveal.dataset.reveal, true); return; }
    const wrap = e.target.closest('.nd-thumbwrap');
    if (wrap && !e.target.closest('input')) {
      e.preventDefault();
      setChecked(wrap.dataset.p, !state.near.selection.has(wrap.dataset.p), wrap.closest('.nd-item'));
    }
  });

  body.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const wrap = e.target.closest('.nd-thumbwrap');
    if (!wrap) return;
    e.preventDefault();
    setChecked(wrap.dataset.p, !state.near.selection.has(wrap.dataset.p), wrap.closest('.nd-item'));
  });

  // `error` does not bubble, but it does capture. One retry pass covers a
  // transient failure; before this a single hiccup broke the thumbnail for good.
  body.addEventListener('error', (e) => {
    const img = e.target;
    if (!img.classList || !img.classList.contains('nd-thumb')) return;
    const tries = Number(img.dataset.try || 0);
    if (tries < ND_THUMB_RETRIES) {
      img.dataset.try = String(tries + 1);
      const src = img.src.split('#')[0];
      setTimeout(() => { img.src = src + '#r' + (tries + 1); }, 400 * (tries + 1));
      return;
    }
    const ph = document.createElement('div');
    ph.className = 'nd-thumb broken';
    ph.innerHTML = icon('image', 22);
    img.replaceWith(ph);
  }, true);
})();

function updateNdToolbar() {
  const count = state.near.selection.size;
  let total = 0;
  for (const p of state.near.selection) total += nodeFor(p)?.size ?? 0;
  $('ndTrashBtn').disabled = !count;
  $('ndTrashBtn').innerHTML = icon('trash', 14) + (count ? `Move ${count} to Trash (${formatBytes(total)})` : 'Move to Trash');
}

$('ndAutoBtn').addEventListener('click', () => {
  if (state.near.status !== 'complete' || !state.near.clusters.length) return;
  state.near.selection.clear();
  state.near.clusters.forEach(c => c.files.slice(1).forEach(f => state.near.selection.add(f.path)));
  $('ndBody').querySelectorAll('.nd-ck').forEach(ck => {
    ck.checked = state.near.selection.has(ck.dataset.p);
    const w = ck.closest('.nd-thumbwrap'); if (w) w.classList.toggle('sel', ck.checked);
  });
  updateNdToolbar();
  toast(`Selected ${state.near.selection.size} extra ${state.near.selection.size === 1 ? 'copy' : 'copies'} — the newest image in each group is kept`);
});
$('ndTrashBtn').addEventListener('click', () => {
  for (const c of state.near.clusters) {
    if (c.files.every(f => state.near.selection.has(f.path))) {
      toast(`Every image in a group is selected — keep at least one`, 'error');
      return;
    }
  }
  confirmTrash([...state.near.selection]);
});
$('ndThreshold').addEventListener('change', () => loadNearDupes(true));
$('costCurrency').addEventListener('change', () => loadCostEstimate());
