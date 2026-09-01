/* ═══════════ Calendar heatmap (v4 §7.2) ═══════════
   One cell per local day, coloured by bytes counted that day. The grid only
   claims what the backend counted: an absent day stays surface-coloured (for
   the modified channel that genuinely means nothing changed; for the created
   channel it may mean "not read before the stat cap", and the degraded note
   under the grid says exactly that). A day click or drag becomes a Phase 2
   query — the grammar's path, not a bespoke filter — so what the treemap then
   shows is exactly what typing the same query would show. */
let calChannel = 'modified';
let calData = null;
let calSeq = 0;
let calDragA = null, calDragB = null, calSuppressClick = false;

function calLevel(bytes, max) {
  if (!bytes || max <= 0) return 0;
  // sqrt spreads a heavy-tailed distribution across the four steps; a linear
  // scale paints one hot day level 4 and everything else level 1.
  const r = Math.sqrt(bytes / max);
  return Math.max(1, Math.min(4, Math.ceil(r * 4)));
}

function calNextDay(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const next = new Date(y, m - 1, d + 1); // local, matching the grammar's local-day rule
  const pad = (n) => String(n).padStart(2, '0');
  return `${next.getFullYear()}-${pad(next.getMonth() + 1)}-${pad(next.getDate())}`;
}

/** Calendar quarter of an ISO day, 1–4 — pure string arithmetic. */
function calQuarterOf(iso) {
  return Math.floor((Number(iso.slice(5, 7)) - 1) / 3) + 1;
}

async function loadCalendar() {
  const body = $('calBody');
  if (!state.scanId) {
    calData = null;
    body.innerHTML = '<div class="muted">Run a scan first.</div>';
    $('calDegraded').hidden = true; $('calLegend').hidden = true;
    return;
  }
  const seq = ++calSeq;
  // Counting can run seconds on a big root — the §3.5 skeleton treatment,
  // with the sentence kept as the status label for screen readers.
  body.innerHTML = skeletonRows(4, 30, 'Counting bytes per day…');
  try {
    const url = `/api/scan/${encodeURIComponent(state.scanId)}/calendar` + (calChannel === 'created' ? '?channel=created' : '');
    const data = await api(url);
    if (seq !== calSeq || state.view !== 'history') return; // superseded
    calData = data;
    renderCalendar();
  } catch (e) {
    if (seq !== calSeq || state.view !== 'history') return;
    calData = null;
    body.innerHTML = `<div class="muted">Could not build the calendar: ${escapeHtml(e.message)}</div>`;
    $('calDegraded').hidden = true; $('calLegend').hidden = true;
  }
}

function renderCalendar() {
  const body = $('calBody');
  const days = (calChannel === 'created' ? calData.created : calData.modified) || [];
  const deg = calData.degraded || [];
  $('calDegraded').hidden = deg.length === 0;
  $('calDegraded').textContent = deg.map((d) => d.reason).join(' ');
  if (!days.length) {
    body.innerHTML = `<div class="muted">${calChannel === 'created' && deg.length
      ? 'No creation days could be counted — see the note below.'
      : 'No days to show for this scan.'}</div>`;
    $('calLegend').hidden = true;
    return;
  }
  const byDate = new Map(days.map((d) => [d.date, d]));
  const max = days.reduce((m, d) => Math.max(m, d.bytes), 0);
  const years = [...new Set(days.map((d) => Number(d.date.slice(0, 4))))].sort((a, b) => b - a);
  const pad = (n) => String(n).padStart(2, '0');
  const parts = [];
  for (const year of years) {
    const inYear = days.filter((d) => d.date.startsWith(String(year)));
    const first = inYear[0].date, last = inYear[inYear.length - 1].date;
    // Columns are weeks, anchored on the Sunday on or before the first counted
    // day; the span runs only across counted territory, not a decorative year.
    const [fy, fm, fd] = first.split('-').map(Number);
    const start = new Date(fy, fm - 1, fd - new Date(fy, fm - 1, fd).getDay());
    const [ly, lm, ld] = last.split('-').map(Number);
    const end = new Date(ly, lm - 1, ld);
    const cells = [];
    // Iterate and compare by ISO string, bounded: comparing Date objects
    // breaks in zones where DST skips midnight (the constructed midnight is
    // 01:00 and the final day falls out of `t <= end`), and the Sunday
    // anchor can reach back into the previous December — those padding days
    // belong to their own year's grid and stay inert here, or a counted
    // Dec 29 renders as a live button under the next year's header too
    // (QA D7, review H8).
    const t = new Date(start);
    const jan1 = `${year}-01-01`;
    let dayCells = 0, prevQ = null;
    for (let guard = 0; guard < 372; guard++) {
      const iso = `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
      if (iso > last) break;
      // bklit's quarter separators, at week-column boundaries only: a
      // full-column divider mid-week would break the 7-row rhythm. A quarter
      // that advanced within the year earns the faded line + label; the 4→1
      // change at a year boundary is already told by the year header.
      if (dayCells % 7 === 0) {
        const q = calQuarterOf(iso);
        if (prevQ !== null && q === prevQ + 1) {
          cells.push(`<span class="cal-qsep" role="presentation" data-q="Q${q}"></span>`);
        }
        prevQ = q;
      }
      dayCells++;
      t.setDate(t.getDate() + 1);
      if (iso < jan1) {
        cells.push('<span class="cal-cell" role="presentation"></span>');
        continue;
      }
      const day = byDate.get(iso);
      if (!day) {
        const why = calChannel === 'created' && deg.length ? 'nothing counted (see note below)' : 'nothing counted this day';
        cells.push(`<span class="cal-cell" role="presentation" title="${iso} — ${why}"></span>`);
        continue;
      }
      const label = `${iso} — ${formatBytes(day.bytes)} · ${day.count} file${day.count === 1 ? '' : 's'}`;
      cells.push(`<button class="cal-cell" data-date="${iso}" data-lv="${calLevel(day.bytes, max)}" title="${label}" aria-label="${label}"></button>`);
    }
    parts.push(`<div class="cal-year num">${year}</div><div class="cal-grid">${cells.join('')}</div>`);
  }
  body.innerHTML = parts.join('');
  $('calLegend').hidden = false;
  $('calMax').textContent = `top day ${formatBytes(max)}`;
}

/** A day (or a dragged range) becomes a query and the treemap answers it. */
function calApplyRange(a, b) {
  const q = a === b ? `${calChannel}:${a}` : `${calChannel}>=${a} ${calChannel}<${calNextDay(b)}`;
  switchView('treemap');
  $('tmSearch').value = q;
  clearTimeout(tmQueryDeb);
  tmApplyQuery(q);
}

function calPaintDrag() {
  const cells = $('calBody').querySelectorAll('.cal-cell[data-date]');
  if (!calDragA) { cells.forEach((c) => c.classList.remove('sel')); return; }
  const [a, b] = calDragA <= calDragB ? [calDragA, calDragB] : [calDragB, calDragA];
  cells.forEach((c) => c.classList.toggle('sel', c.dataset.date >= a && c.dataset.date <= b));
}

/* Static top-level bindings, like the slider's — nothing for unmount to own. */
/* bklit legend hover-sync: holding a legend level dims every other cell to
   0.3 in 160ms. CSS owns the dimming; this only flips the data attribute. */
$('calLegend').addEventListener('mouseover', (e) => {
  const cell = e.target.closest('.cal-cell[data-lv]');
  if (cell) $('calBody').dataset.calDim = cell.dataset.lv;
});
$('calLegend').addEventListener('mouseout', () => {
  delete $('calBody').dataset.calDim;
});
$('calChannelSeg').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-ch]');
  if (!btn) return;
  calChannel = btn.dataset.ch;
  for (const b of $('calChannelSeg').querySelectorAll('button'))
    b.setAttribute('aria-selected', String(b.dataset.ch === calChannel));
  loadCalendar();
});
$('calBody').addEventListener('pointerdown', (e) => {
  const c = e.target.closest('.cal-cell[data-date]');
  if (!c) return;
  calDragA = calDragB = c.dataset.date;
  e.preventDefault();
});
$('calBody').addEventListener('pointerover', (e) => {
  if (!calDragA) return;
  // A release this page never saw (outside the window, a touch-cancel):
  // hovering with no button down must not keep growing a selection whose
  // next stray pointerup would fire a query the user never made (QA D4).
  if (e.buttons === 0) { calDragA = calDragB = null; calPaintDrag(); return; }
  const c = e.target.closest('.cal-cell[data-date]');
  if (c && c.dataset.date !== calDragB) { calDragB = c.dataset.date; calPaintDrag(); }
});
$('calBody').addEventListener('pointercancel', () => {
  calDragA = calDragB = null;
  calPaintDrag();
});
window.addEventListener('pointerup', () => {
  if (!calDragA) return;
  const [a, b] = calDragA <= calDragB ? [calDragA, calDragB] : [calDragB, calDragA];
  calDragA = calDragB = null;
  calSuppressClick = true; // the click that follows this pointerup is the same gesture
  calApplyRange(a, b);
});
$('calBody').addEventListener('click', (e) => {
  // Keyboard activation: Enter/Space on a cell arrives here with no pointer
  // gesture before it. A mouse click was already handled at pointerup.
  if (calSuppressClick) { calSuppressClick = false; return; }
  const c = e.target.closest('.cal-cell[data-date]');
  if (c) calApplyRange(c.dataset.date, c.dataset.date);
});

/* ═══════════ History (v4 §7) — one tab, three panels ═══════════
   Calendar, Journal and Compare share the time dimension, so they share one
   view: an internal segmented control switches panels, each keeping its own
   ids, loaders and stale-response guards. Loading happens on entry to a
   panel, never for the two hidden ones. */
let histPanel = 'calendar';

function histShow(panel) {
  histPanel = panel;
  for (const b of $('histSeg').querySelectorAll('button'))
    b.setAttribute('aria-selected', String(b.dataset.panel === panel));
  $('histPanelCalendar').hidden = panel !== 'calendar';
  $('histPanelJournal').hidden = panel !== 'journal';
  $('histPanelCompare').hidden = panel !== 'compare';
  if (state.view !== 'history') return; // reflect-only until the view mounts
  if (panel === 'calendar') loadCalendar();
  else if (panel === 'journal') loadJournal();
  else loadCompareOptions();
}

$('histSeg').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-panel]');
  if (btn) histShow(btn.dataset.panel);
});

registerView({
  id: 'history',
  label: 'History',
  icon: 'calendar',
  // Journal and Compare read persisted history and are useful with no scan
  // loaded; the calendar panel states its own need for one.
  needsScan: false,
  onScanChange() { calData = null; }, // the old scan's days belong to the old tree
  mount() { histShow(histPanel); },
  unmount() {
    // The compare counts chart is a live handle in this view's DOM; the
    // registry's rule — a view stops what it started — applies to it too.
    cmpCountsDrop();
    // FX: so does a mid-compare progress ring — the card is only hidden DOM
    // now, and the settle that would have dropped it repaints a hidden view.
    fxHuntBeamSync('cmpBody', false);
  },
});

/* ═══════════ Disk journal (v4 §7.3) ═══════════
   Reads the journal the scheduler writes (never written over HTTP), grouped
   by day, newest first. Portable sessions show the degraded reason instead
   of pretending history exists. An entry links into the treemap at its path
   and day: inside the loaded scan it drills and queries; outside it, the
   path field is pre-filled and the user told why — the journal never starts
   a scan behind their back. */
let journalSeq = 0;

async function loadJournal() {
  const body = $('journalBody');
  const seq = ++journalSeq;
  body.innerHTML = skeletonRows(6, 30, 'Reading the journal…');
  try {
    const [data, portable] = await Promise.all([
      api('/api/journal?limit=200'),
      api('/api/platform/portable').catch(() => null),
    ]);
    if (seq !== journalSeq || state.view !== 'history') return; // superseded
    const note = portable && portable.portable && (portable.degraded || []).find((d) => d.key === 'journal');
    $('journalPortable').hidden = !note;
    if (note) $('journalPortable').textContent = note.reason;
    renderJournal(data.entries || []);
  } catch (e) {
    if (seq !== journalSeq || state.view !== 'history') return;
    body.innerHTML = `<div class="muted">Could not read the journal: ${escapeHtml(e.message)}</div>`;
  }
}

function renderJournal(entries) {
  const body = $('journalBody');
  if (!entries.length) {
    body.innerHTML = '<div class="muted">Nothing significant yet. The journal fills in as scheduled scans notice changes of 100 MB or more — set one up under Scheduled scans in Settings.</div>';
    return;
  }
  const parts = [];
  let lastDay = '';
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const day = new Date(e.at).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    if (day !== lastDay) {
      lastDay = day;
      parts.push(`<div class="cal-year">${escapeHtml(day)}</div>`);
    }
    parts.push(
      `<div class="rule-row" style="align-items:baseline;gap:8px;margin:2px 0;">
        <span>${escapeHtml(e.sentence)}</span>
        <button class="pill" data-journal-open="${i}" title="Show this path on the treemap, filtered to that day">Show on treemap</button>
      </div>`,
    );
  }
  body.innerHTML = parts.join('');
  body.querySelectorAll('[data-journal-open]').forEach((b) =>
    b.addEventListener('click', () => journalOpen(entries[Number(b.dataset.journalOpen)])));
}

function journalOpen(entry) {
  const d = new Date(entry.at);
  const pad = (n) => String(n).padStart(2, '0');
  const iso = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const q = `modified:${iso}`;
  const root = state.root ? state.root.path : null;
  // Both separators are tried: sniffing one from entry.path misreads a POSIX
  // filename that happens to contain a backslash (review H9).
  const inScan = root && (entry.path === root || entry.path.startsWith(root + '/') || entry.path.startsWith(root + '\\'));
  if (!inScan) {
    $('pathInput').value = entry.rootPath;
    switchView('dashboard');
    toast(`Scan ${entry.rootPath} first — journal entries link into a scanned tree. The path is filled in.`);
    return;
  }
  const node = state.pathIndex.get(entry.path);
  state.treemap.rootPath = node && node.type === 'dir' ? entry.path : root;
  switchView('treemap');
  $('tmSearch').value = q;
  clearTimeout(tmQueryDeb);
  tmApplyQuery(q);
}


registerView({
  id: 'capsule',
  label: 'Time Capsule',
  icon: 'clock',
  // Reads persisted history, exactly like Trends/Compare/Offloaded, so it is
  // useful with no scan loaded and never shows the empty-state screen.
  needsScan: false,
  mount() { loadCapsule(); },
  unmount() {
    // The cap meter and the events list are live handles; a view stops what
    // it started.
    capsuleGaugeHide();
    capsuleEventsDrop();
  },
});
