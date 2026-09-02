/* ═══════════ The Missing Gigabytes (v4 §5) ═══════════
   One page that reconciles a volume, printed as a receipt.

   The design rule the whole view turns on: **an unknown is never drawn as a
   zero.** A line whose bytes could not be measured gets no bar segment, prints
   "unknown" rather than "0 B", and states its reason in full — and the residual
   line names it, so the gap is attributable rather than mysterious. Rendering
   an unmeasured line as an empty segment would be the same lie in pixels.

   The bar spans the volume's whole capacity rather than just its used part,
   because free space is half of what a user is asking about, and a mark shows
   where "used" actually ends. Segments carry only positive lines: a negative
   line is a correction to the line above it, so it nets off there and is still
   printed in full in the statement below.                                  */

const MG_SEG = {
  scanned:      { cls: 'is-scanned',   colour: 'var(--mg-scanned)' },
  snapshots:    { cls: 'is-snapshots', colour: 'var(--mg-snapshots)' },
  openHandles:  { cls: 'is-handles',   colour: 'var(--mg-handles)' },
  otherVolumes: { cls: 'is-volumes',   colour: 'var(--mg-volumes)' },
  unaccounted:  { cls: 'is-residual',  colour: 'var(--mg-residual)' },
};

let missingData = null;
let missingLoading = false;

/** Fetch the statement. A failure says so; it never leaves a stale receipt up. */
async function loadMissing() {
  const body = $('missingBody');
  if (!state.scanId) {
    missingData = null;
    body.classList.remove('fx-chart-loading');
    body.innerHTML = '<div class="muted">Run a scan to reconcile this disk.</div>';
    $('missingInfo').textContent = '';
    return;
  }
  if (missingLoading) return;
  missingLoading = true;
  // The same pending language as every other card: skeleton rows on a first
  // load, the loading veil over a standing receipt on a refresh. Blanking a
  // receipt the user is reading to say "wait" loses more than it says.
  if (body.querySelector('.mg-receipt')) body.classList.add('fx-chart-loading');
  else body.innerHTML = skeletonRows(3, 30, 'Reconciling this disk…');
  try {
    missingData = await api(`/api/missing-gigabytes?scanId=${encodeURIComponent(state.scanId)}`);
    renderMissing();
  } catch (e) {
    missingData = null;
    $('missingInfo').textContent = '';
    body.classList.remove('fx-chart-loading');
    body.innerHTML = `<div class="muted">${escapeHtml(e.message)}</div>`;
  } finally {
    missingLoading = false;
  }
}

/**
 * Net a line against the corrections that belong to it.
 *
 * Cloud placeholders are a negative line that exists to take back what the
 * scanned line over-reported. In the arithmetic they are their own row, in full
 * view; in the *bar* they simply make the scanned segment shorter, because a
 * stacked bar has no way to draw a negative width and faking one would be worse
 * than netting it.
 */
function mgSegmentBytes(lines, id) {
  let total = lines.find(l => l.id === id)?.bytes ?? 0;
  if (id === 'scanned') total += lines.find(l => l.id === 'cloudPlaceholders')?.bytes ?? 0;
  return total;
}

function renderMissing() {
  const d = missingData;
  if (!d) return;
  const body = $('missingBody');
  body.classList.remove('fx-chart-loading'); // every paint settles the veil
  const total = d.volume.totalBytes;

  $('missingInfo').textContent =
    `Read from ${d.volume.mechanism}. Every line below is a measurement or an honest unknown; ` +
    `they sum to the volume's used space exactly.`;

  /* ── the bar ── */
  const segs = [];
  for (const id of ['scanned', 'snapshots', 'openHandles', 'otherVolumes', 'unaccounted']) {
    const line = d.lines.find(l => l.id === id);
    if (!line) continue;
    const bytes = mgSegmentBytes(d.lines, id);
    // A line with no measurement gets no segment at all. A zero-byte segment
    // would be indistinguishable from an unknown one, and they are opposites.
    if (line.bytes === null || bytes <= 0) continue;
    segs.push({ id, line, bytes });
  }
  const drawn = segs.reduce((a, x) => a + x.bytes, 0);
  // Normally the segments fit inside the capacity and the remainder is free
  // space. When TreeMap has over-counted (clones), they can exceed what the
  // volume says is used — the mark makes that visible rather than hiding it.
  const denom = Math.max(total, drawn);
  const pct = b => (b / denom) * 100;
  const usedPct = pct(d.volume.usedBytes);

  /* The blocks only the system may use — ext4's 5% by default, zero on APFS
     and Windows. Anchored to the RIGHT of the free tail rather than laid out
     after the segments: `freeBytes` is read straight off the volume, while the
     segment run can fall short of used when a line is unknown or a correction
     is negative, and the band should sit where free actually begins. Nothing
     is drawn when there is no reserve, which is every Mac and every PC — a
     zero-width band would be a claim about a disk that does not make it. */
  const reserved = d.volume.reservedBytes || 0;
  const reservedHtml = reserved > 0
    ? `<div class="mg-reserved" aria-hidden="true" style="right:${pct(d.volume.freeBytes).toFixed(3)}%;width:${pct(reserved).toFixed(3)}%" ` +
      `title="Kept back for the system — ${escapeHtml(formatBytes(reserved))}"></div>`
    : '';

  const barHtml =
    `<div class="mg-barwrap"><div class="mg-bar" role="group" aria-label="How this volume's space is used">` +
    segs.map(sgroup =>
      `<button type="button" class="mg-seg ${MG_SEG[sgroup.id].cls}" data-mg-seg="${sgroup.id}" ` +
      `style="width:${pct(sgroup.bytes).toFixed(3)}%" ` +
      `aria-label="${escapeHtml(sgroup.line.label)}: ${escapeHtml(formatBytes(sgroup.bytes))}. Show details." ` +
      `title="${escapeHtml(sgroup.line.label)} — ${escapeHtml(formatBytes(sgroup.bytes))}"></button>`
    ).join('') +
    reservedHtml +
    `</div>` +
    `<div class="mg-usedmark ${usedPct > 88 ? 'at-end' : usedPct < 6 ? 'at-start' : ''}" ` +
    `style="left:${usedPct.toFixed(3)}%" ` +
    `data-label="${escapeHtml(formatBytes(d.volume.usedBytes))} used"></div>` +
    `<div class="mg-legend">` +
    segs.map(sgroup =>
      `<span><i style="background:${MG_SEG[sgroup.id].colour}"></i>${escapeHtml(sgroup.line.label)}</span>`
    ).join('') +
    (reserved > 0
      ? `<span><i style="background:var(--mg-reserved)"></i>Kept back for the system — ${escapeHtml(formatBytes(reserved))}</span>`
      : '') +
    `<span><i style="background:var(--mg-free)"></i>Free to you — ${escapeHtml(formatBytes(d.volume.freeBytes))}</span>` +
    `</div></div>`;

  /* ── the statement ── */
  const rows = d.lines.map(line => {
    const seg = MG_SEG[line.id];
    const known = line.bytes !== null;
    const value = known
      ? `<div class="mg-v ${line.bytes < 0 ? 'mg-minus' : ''}">${line.bytes < 0 ? '−' : ''}${escapeHtml(formatBytes(Math.abs(line.bytes)))}</div>`
      : `<div class="mg-v mg-unknown">unknown</div>`;
    const count = line.count !== null
      ? `<span class="mg-count">${escapeHtml(formatCount(line.count))} ${line.count === 1 ? 'item' : 'items'}</span>` : '';
    return (
      `<div class="mg-row ${line.id === 'unaccounted' ? 'is-residual' : ''}" data-mg-row="${line.id}">` +
        `<div class="mg-l">` +
          (seg ? `<span class="mg-sw" style="background:${seg.colour}"></span>` : '') +
          `<span class="mg-name">${escapeHtml(line.label)}</span>${count}` +
        `</div>` +
        value +
        `<div class="mg-detail">${escapeHtml(line.detail)}</div>` +
        (line.reason ? `<div class="mg-reason">${escapeHtml(line.reason)}</div>` : '') +
        (line.notes.length
          ? `<ul class="mg-notes">${line.notes.map(n => `<li>${escapeHtml(n)}</li>`).join('')}</ul>` : '') +
        (line.remedy
          ? `<div class="mg-remedy">` +
              `<button class="btn" data-mg-remedy="${line.remedy.action}">${escapeHtml(line.remedy.label)}</button>` +
              `<span class="muted">${escapeHtml(line.remedy.caveat)}</span>` +
            `</div>`
          : '') +
      `</div>`
    );
  }).join('');

  const totalHtml =
    `<div class="mg-total">` +
      `<div class="mg-name">Used on ${escapeHtml(d.volume.mountPoint)}</div>` +
      `<div class="mg-v">${escapeHtml(formatBytes(d.volume.usedBytes))}</div>` +
      `<div class="mg-sub">Every line above, added together, is exactly this number. ` +
      `${escapeHtml(formatBytes(d.volume.freeBytes))} of ${escapeHtml(formatBytes(total))} is still free to you` +
      (reserved > 0
        ? `, and ${escapeHtml(formatBytes(reserved))} is kept back for the system — neither in use nor available to anything you run.</div>`
        : `.</div>`) +
    `</div>`;

  body.innerHTML =
    `<div class="mg-head">` +
      `<span class="mg-vol">${escapeHtml(d.volume.mountPoint === '/' ? 'This disk' : d.volume.mountPoint)}</span>` +
      `<span class="mg-mp">${escapeHtml(d.rootPath)}</span>` +
      `<span class="mg-cap"><b>${escapeHtml(formatBytes(d.volume.usedBytes))}</b> used of ${escapeHtml(formatBytes(total))}</span>` +
    `</div>` +
    barHtml +
    `<div class="mg-receipt">${rows}${totalHtml}</div>` +
    d.caveats.map(c => `<div class="mg-caveat">${escapeHtml(c)}</div>`).join('');
}

/* Segment → its row. Delegated, so re-rendering never leaves listeners behind. */
$('missingBody').addEventListener('click', (e) => {
  const seg = e.target.closest('[data-mg-seg]');
  if (seg) {
    const row = $('missingBody').querySelector(`[data-mg-row="${seg.dataset.mgSeg}"]`);
    if (row) {
      $('missingBody').querySelectorAll('.mg-row.mg-focus').forEach(r => r.classList.remove('mg-focus'));
      row.classList.add('mg-focus');
      // Instant, deliberately. Measured in the shipped shell: smooth scrolling
      // is a no-op here — `main.scrollTo({ behavior: 'smooth' })` leaves
      // scrollTop at 0 while the identical call with 'auto' lands exactly, and
      // prefers-reduced-motion is not set. A segment that silently fails to
      // reveal its row is a broken control, and the polish is not worth that;
      // the row stays highlighted, which is the signal that actually matters.
      row.scrollIntoView({ block: 'center', behavior: 'auto' });
    }
    return;
  }
  const remedy = e.target.closest('[data-mg-remedy]');
  if (!remedy) return;
  // Every remedy hands off to the control that ALREADY owns that action, by
  // clicking it. Re-implementing "purge snapshots" here would be a second path
  // to a destructive action — a second confirm dialog to keep in step, a second
  // place for a gate to be forgotten. Handing off means there is still exactly
  // one, and this view cannot drift away from it.
  const action = remedy.dataset.mgRemedy;
  switchView('dashboard');
  if (action === 'scan-volume') {
    const box = $('pathInput');
    if (box) { box.value = missingData ? missingData.volume.mountPoint : '/'; box.focus(); }
    toast('Press Scan to account for every file on this volume');
  } else if (action === 'purge-snapshots') {
    // The Dashboard's own button, with its own confirm modal and its own
    // { confirm: true } call. Nothing about the gate lives here.
    mgHandOff('snapPurgeBtn', 'Local snapshots are on the Dashboard — it asks before deleting any');
  } else if (action === 'review-open-handles') {
    mgHandOff('zombieCard', 'TreeMap asks a program to quit, and never forces it');
  }
});

/**
 * Reveal a Dashboard control and, when it is a button, press it.
 *
 * The Dashboard paints its cards lazily, so the target may not exist yet on
 * first switch; a frame's grace is enough and a miss falls back to saying where
 * to look rather than silently doing nothing.
 */
function mgHandOff(id, fallbackMessage) {
  requestAnimationFrame(() => {
    const el = $(id);
    if (!el || el.hidden || el.closest('[hidden]')) { toast(fallbackMessage); return; }
    el.scrollIntoView({ block: 'center', behavior: 'auto' });
    if (el.tagName === 'BUTTON') el.click();
  });
}

registerView({
  id: 'missing',
  label: 'Missing GB',
  icon: 'pie',
  needsScan: true,
  // Without the disk layout there is nothing to reconcile against, so the tab
  // disables itself with the capability's own words rather than rendering a
  // page of blanks.
  capabilityKey: 'volumeTopology',
  onScanChange() {
    // Entering mid-scan gets a truthful "still running" from the server, and a
    // user left looking at it would have no way back: nothing re-fetches on its
    // own. So a scan landing while this view is open re-reconciles immediately.
    missingData = null;
    if (mountedView && mountedView.id === 'missing') loadMissing();
  },
  mount() { loadMissing(); },
  unmount() {
    // Nothing is left holding memory: the statement is small, but the receipt
    // it paints is not, and the registry exists to stop exactly that
    // accumulating across view switches.
    missingData = null;
    $('missingBody').classList.remove('fx-chart-loading');
    $('missingBody').innerHTML = '<div class="muted">Run a scan to reconcile this disk.</div>';
    $('missingInfo').textContent = '';
  },
});

/* ── What the two switchable channels mean, and which values exist ────────

   These are the legend's wording AND the list of modes that are real. Both
   jobs on purpose: the legend reads a mode straight out of these maps, so a
   mode that is not here has no label, and `cityMode()` below is what stops
   one reaching the legend in the first place.

   "in this folder" is not padding: the height scale is normalised to what is
   on screen, so a tower is tall relative to its neighbours rather than on an
   absolute scale, and a legend that implied otherwise would be wrong.       */
const CITY_HEIGHT_LABEL = {
  staleness: 'how long since anything changed, within this folder',
  files: 'how many files are inside, within this folder',
  depth: 'how deeply nested it is',
};
const CITY_COLOUR_LABEL = {
  reclaim: 'how safe and worthwhile it is to reclaim',
  type: 'what kind of files it holds',
  age: 'how recently it changed',
};

/**
 * A channel mode this build actually has, or the default.
 *
 * `localStorage` outlives the code that wrote it. Both of Disk City's channels
 * are persisted by name, so a mode renamed or dropped in a later build leaves
 * behind a value that is a perfectly good string and no longer means anything.
 * The legend looks its wording up in the maps above and rendered the miss as
 * `Height = undefined` — which §2.4 rules out in as many words: never a blank,
 * never a plausible-looking default, and never a word the user cannot act on.
 *
 * Observed, not theorised: setting an unknown mode put exactly that sentence
 * on screen, and it survived every reload afterwards, because the only guard
 * on the read path was `|| 'staleness'` and that catches an absent value
 * rather than a meaningless one. The distinction is the same one `meansAbsent`
 * and `meansGone` exist for elsewhere in this repo.
 *
 * Applied in the two setters rather than at the `state` literal, because the
 * maps are declared here with the rest of Disk City and the literal is built
 * long before this point in the file — reading them there is a temporal dead
 * zone, not a lookup.
 */
function cityMode(mode, labels, fallback) {
  return Object.prototype.hasOwnProperty.call(labels, mode) ? mode : fallback;
}
