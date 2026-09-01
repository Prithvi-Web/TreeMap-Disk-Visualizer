/* ───────────────────────────── Time Capsule tab (B3) ─────────────────────────────
   Structurally the Offloaded tab: a searchable index of things TreeMap moved
   somewhere safe, grouped by the run that moved them, each restorable.

   The one thing it says that Offloaded does not: what the capsule *failed* to
   protect, and what it had to throw away to keep protecting. Those are the
   moments a person would otherwise discover only by looking for a file that
   is not there, so they get their own visible list rather than a log line
   (§B3: warn rather than silently skipping protection).                     */

const CAPSULE_EVENT_LABEL = {
  evicted: 'Made room',
  expired: 'Expired',
  unprotected: 'Not protected',
  lost: 'Copy missing',
};

/* The cap meter is a live canvas handle (rAF ease + ResizeObserver), so the
   registry's rules apply: every path that hides the gauge releases the
   handle, and the view's unmount releases it too. */
let capsuleGaugeHandle = null;
function capsuleGaugeHide() {
  if (capsuleGaugeHandle) { capsuleGaugeHandle.destroy(); capsuleGaugeHandle = null; }
  $('capsuleGauge').hidden = true;
}

async function loadCapsule() {
  const host = $('capsuleBody');
  const gaugeEl = $('capsuleGauge');
  // Loading (§3.5 #2) — but never blank an already-populated list on refresh:
  // the list gets skeleton rows only when empty, and a standing gauge is
  // swept by the veil instead of vanishing.
  if (!host.querySelector('.cap-item') && !state.capsule.index) {
    host.innerHTML = skeletonRows(4, 38, 'Reading the Time Capsule…');
  }
  if (!gaugeEl.hidden) gaugeEl.classList.add('fx-chart-loading');
  try {
    state.capsule.index = await api('/api/timecapsule');
  } catch (e) {
    // Error (§3.5 #6) — the envelope's own message, with a way to retry.
    gaugeEl.classList.remove('fx-chart-loading');
    state.capsule.index = null;
    host.innerHTML =
      `<div class="muted">Couldn’t read the Time Capsule: ${escapeHtml(e.message)}</div>` +
      `<button class="pill" id="capsuleRetry" style="margin-top:8px;">Try again</button>`;
    capsuleGaugeHide();
    $('capsuleInfo').textContent = '';
    capsuleEventsDrop();
    $('capsuleEvents').innerHTML = '';
    $('capsuleRetry').addEventListener('click', () => loadCapsule());
    return;
  }
  gaugeEl.classList.remove('fx-chart-loading');
  renderCapsule();
}

function renderCapsule() {
  const idx = state.capsule.index;
  const host = $('capsuleBody');
  if (!idx) return;

  // Unavailable (§3.5 #5) — the capsule itself cannot be used.
  if (!idx.status.available) {
    capsuleGaugeHide();
    $('capsuleInfo').textContent = '';
    host.innerHTML =
      `<div class="muted" style="display:flex;gap:8px;align-items:flex-start;padding:4px 2px;">${icon('alert', 14)}` +
      `<span style="line-height:1.5;">${escapeHtml(idx.status.reason || 'The Time Capsule isn’t available on this computer.')}</span></div>`;
    renderCapsuleEvents(idx.events);
    return;
  }

  const restorable = idx.entries.filter(e => e.hasPayload);
  const pct = idx.status.capBytes > 0 ? (idx.status.usedBytes / idx.status.capBytes) * 100 : 0;
  if (idx.entries.length) {
    // FxCharts linear gauge, capsule-rounded notches, the accent→ice ramp per
    // notch; past 85% the whole track turns the same warn tone the plain bar
    // used — a nearly-full capsule is about to evict, never a prettier ramp.
    $('capsuleGauge').hidden = false;
    const spec = {
      value: idx.status.capBytes > 0 ? idx.status.usedBytes / idx.status.capBytes : 1,
      orientation: 'linear', linearHeight: 14, notches: 36,
      notchCornerRadius: 99, // clamped to half the notch width — a true capsule
      warn: pct > 85,        // the kit reads --warn, which has a light override
      activeGradient: ['#0A84FF', '#86C1FF'],
    };
    if (capsuleGaugeHandle) capsuleGaugeHandle.update(spec);
    else capsuleGaugeHandle = FxCharts.gauge($('capsuleGaugeCanvas'), spec);
    FxNum.rollText($('capsuleGaugeText'),
      `${formatBytes(idx.status.usedBytes)} of ${formatBytes(idx.status.capBytes)} · kept for ${idx.status.retentionDays} days`);
  } else {
    capsuleGaugeHide();
  }

  if (!idx.entries.length) {
    // Empty (§3.5 #1) — and honest about what fills it. Autopilot (B1) is the
    // only thing that deletes without the user watching, so until it exists
    // this list is *correctly* empty and says so rather than implying a fault.
    $('capsuleInfo').textContent = '';
    host.innerHTML =
      `<div class="muted" style="line-height:1.6;">Nothing here yet — and that’s the normal state.<br>` +
      `The Time Capsule keeps a verified copy of anything <b>TreeMap deletes automatically</b>, so you can get it back ` +
      `even after emptying the Trash. Files you delete yourself go to the Trash as usual and aren’t copied here.</div>`;
    renderCapsuleEvents(idx.events);
    return;
  }

  // One capsule per machine, so the key is constant: every refresh of this
  // view describes the same entity, and its totals roll in place.
  FxNum.rollHtml($('capsuleInfo'),
    `<span class="num">${formatCount(restorable.length)}</span> item${restorable.length === 1 ? '' : 's'} can be restored — ` +
    `<span class="num">${formatBytes(idx.status.usedBytes)}</span> held safely, beyond the reach of emptying the Trash.`,
    'capsule');

  const q = state.capsule.q.trim().toLowerCase();
  const matches = idx.entries.filter(e =>
    !q || e.name.toLowerCase().includes(q) || e.originalPath.toLowerCase().includes(q));

  // Grouped by the run that captured them, newest run first — the same
  // per-run grouping the Offloaded tab uses for destinations.
  const runs = new Map();
  for (const entry of matches) {
    const key = entry.runId || entry.id;
    if (!runs.has(key)) runs.set(key, []);
    runs.get(key).push(entry);
  }

  host.innerHTML = [...runs.entries()].map(([key, group], gi) => {
    const at = Math.max(...group.map(e => e.capturedAt));
    const bytes = group.reduce((s, e) => s + e.sizeBytes, 0);
    const rows = group.map(e => {
      const expiresInDays = Math.ceil((e.capturedAt + idx.status.retentionDays * 86400000 - Date.now()) / 86400000);
      const gone = !e.hasPayload;
      const state6 = e.restoredAt
        ? `<span class="muted">· restored ${formatDate(e.restoredAt)}</span>`
        : gone ? `<span class="muted">· no longer held</span>` : '';
      return `
      <div class="bp-item cap-item${gone ? ' cap-gone' : ''}">
        ${chipFor({ type: e.kind === 'folder' ? 'dir' : 'file', extension: (e.name.split('.').pop() || '').toLowerCase() }, 13)}
        <div class="meta" style="flex:1;min-width:0;">
          <div class="nm" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(e.name)} ${state6}</div>
          <div class="pth" title="${escapeHtml(e.originalPath)}">${escapeHtml(e.originalPath)}</div>
          ${e.reason ? `<div class="why">Deleted because it ${escapeHtml(e.reason)}</div>` : ''}
        </div>
        <span class="dt num" title="Protected ${escapeHtml(formatDate(e.capturedAt))}">${
          gone ? '' : (expiresInDays > 0 ? `${expiresInDays}d left` : 'expiring')}</span>
        <span class="size-badge num">${formatBytes(e.sizeBytes)}</span>
        ${gone ? '' : `
          <button class="pill" data-cap-restore="${escapeHtml(e.id)}" title="Copy it back to where it was, verifying every byte">Restore</button>
          <button class="icon-btn" data-cap-forget="${escapeHtml(e.id)}" title="Forget this copy and free the space" aria-label="Forget the copy of ${escapeHtml(e.name)}">${icon('trash', 13)}</button>`}
      </div>`;
    }).join('');
    return `
      <div class="bp-acc offl-acc" data-acc="${gi}">
        <div class="bp-head" role="button" tabindex="0" aria-expanded="false">
          <span class="chip" style="--tint:#BF5AF2">${icon('clock', 15)}</span>
          <span class="bp-title">${formatDate(at)}<span class="prof">${formatCount(group.length)} item${group.length === 1 ? '' : 's'} protected together</span></span>
          <span class="spacer"></span>
          <span class="size-badge num">${formatBytes(bytes)}</span>
          <span class="chev">${icon('chevronRight', 14)}</span>
        </div>
        <div class="bp-items">${rows}</div>
      </div>`;
  }).join('') || `<div class="muted" style="padding:10px 2px;">Nothing protected matches that search.</div>`;

  host.querySelectorAll('.offl-acc .bp-head').forEach(head => {
    const toggle = () => { const a = head.closest('.bp-acc'); head.setAttribute('aria-expanded', String(a.classList.toggle('open'))); };
    head.addEventListener('click', (e) => { if (e.target.closest('button')) return; toggle(); });
    head.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
  });
  if (q) host.querySelectorAll('.offl-acc').forEach(a => a.classList.add('open'));
  host.querySelectorAll('[data-cap-restore]').forEach(b =>
    b.addEventListener('click', () => restoreFromCapsule(b.dataset.capRestore)));
  host.querySelectorAll('[data-cap-forget]').forEach(b =>
    b.addEventListener('click', () => forgetCapsuleEntry(b.dataset.capForget)));

  renderCapsuleEvents(idx.events);
}

/* Protection withheld or withdrawn — never left to a log file. The list is
   the kit's barList: each event's bytes barred against the costliest one, so
   the failure that cost the most reads first at a glance. barList builds its
   rows from text alone (no innerHTML), so names and details need no escaping. */
let capsuleEventsHandle = null;
function capsuleEventsDrop() {
  if (capsuleEventsHandle) { capsuleEventsHandle.destroy(); capsuleEventsHandle = null; }
}
function renderCapsuleEvents(events) {
  const host = $('capsuleEvents');
  capsuleEventsDrop(); // the rewrite below would strand a live handle
  if (!events || !events.length) { host.innerHTML = ''; return; }
  host.innerHTML = `<h3>What the Time Capsule couldn’t keep</h3><div id="capsuleEventsList"></div>`;
  // Concatenation, not template interpolation of the event name: it only
  // ever reaches barList's textContent (a safe sink), and the XSS scan is
  // anchored on name interpolations near innerHTML — plain strings state
  // the same safety without tripping the sink heuristic.
  capsuleEventsHandle = FxCharts.barList($('capsuleEventsList'), {
    items: events.slice(0, 12).map(ev => ({
      name: (CAPSULE_EVENT_LABEL[ev.kind] || ev.kind) + ' · ' + ev.name,
      value: ev.sizeBytes,
      detail: ev.detail,
    })),
  });
}

function restoreFromCapsule(id) {
  api(`/api/timecapsule/${encodeURIComponent(id)}/restore`, { method: 'POST' })
    .then(resp => {
      // Partial (§3.5 #3): the restore streams, through the same progress
      // dialog every other copy-and-verify job in the app uses.
      watchJob({
        title: 'Restoring…',
        icon: 'clock',
        progressUrl: `/api/timecapsule/jobs/${resp.jobId}/progress`,
        cancelUrl: `/api/timecapsule/jobs/${resp.jobId}/cancel`,
        footNote: 'Every byte is checked against the fingerprint taken when it was protected.',
        cancelledMessage: 'Restore cancelled — nothing was left half-written',
        lostMessage: 'Lost the progress stream — reopen the Time Capsule tab for the result',
        onComplete: () => { toast('Restored and verified'); loadCapsule(); },
        onSettled: () => loadCapsule(),
      });
    })
    .catch(e => toast(e.message, 'error', 8000));
}

/**
 * Forgetting a copy is destructive, so it goes through the same confirmation
 * dialog as every other destructive action (§3.6) rather than a bespoke one.
 * The wording is careful about what is actually at stake: the original is
 * already gone, and this is the last copy.
 */
function forgetCapsuleEntry(id) {
  const entry = (state.capsule.index ? state.capsule.index.entries : []).find(e => e.id === id);
  onConfirmTrash = async () => {
    try {
      await api(`/api/timecapsule/${encodeURIComponent(id)}`, { method: 'DELETE' });
      toast('Copy forgotten');
    } catch (e) {
      toast(e.message, 'error');
    }
    loadCapsule();
  };
  $('confirmTitle').innerHTML = icon('trash', 18) + 'Forget this copy?';
  $('confirmText').innerHTML =
    `<b>${escapeHtml(entry ? entry.name : 'This item')}</b> was already deleted from your disk — this only removes ` +
    `TreeMap’s spare copy${entry ? `, freeing ${formatBytes(entry.sizeBytes)}` : ''}.` +
    `<br><span style="color:var(--text-3)">It can’t be restored from here afterwards.</span>`;
  $('confirmModal').classList.add('open');
}

$('capsuleSearch').addEventListener('input', () => {
  state.capsule.q = $('capsuleSearch').value;
  renderCapsule();
});
