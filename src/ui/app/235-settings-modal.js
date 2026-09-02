/* ───────────────────────────── Settings modal ───────────────────────────── */
let settingsData = { ignore: [], schedules: [] };
void loadPortableMode(); // D3 — decided before the user scans anything
$('settingsBtn').innerHTML = icon('settings', 16);
$('settingsBtn').addEventListener('click', async () => {
  $('settingsModal').classList.add('open');
  $('settingsStatus').textContent = '';
  void renderAllocationDiagnostic(); // A2 — independent of settings loading
  void renderShellIntegration();     // D2 — same
  try {
    settingsData = await api('/api/settings');
  } catch (e) {
    toast('Could not load settings: ' + e.message, 'error');
    settingsData = { ignore: [], schedules: [] };
  }
  renderSchedules();
  renderIgnores();
  renderCloudAccounts();
  $('forecastDays').value = settingsData.forecastThresholdDays ?? 30;
  $('watchIdleMin').value = settingsData.watchIdleMinutes ?? 10;
  $('capsuleRetentionDays').value = settingsData.timeCapsuleRetentionDays ?? 30;
  $('capsuleMaxPercent').value = settingsData.timeCapsuleMaxPercent ?? 10;
  renderCleanupGoalFields();
  renderReclaimWeights();
  $('humanScaleToggle').checked = settingsData.humanScaleUnits !== false;
});

/* ── Cleanup target (v4 §4.1) ──
   Stored as bytes; shown in whichever unit divides evenly, largest first, so
   50 GB comes back as "50 GB" rather than "51200 MB". An empty box is the
   no-target state and is written back as `null`. */
const CLEANUP_GOAL_UNITS = [1099511627776, 1073741824, 1048576];
function renderCleanupGoalFields() {
  // adoptCartGoal is boot's own policy: the dock and the dialog can never
  // disagree, whether this paint follows an open or a save.
  const bytes = adoptCartGoal(settingsData.cleanupGoalBytes);
  if (bytes === null) { $('cleanupGoalValue').value = ''; $('cleanupGoalUnit').value = '1073741824'; return; }
  const unit = CLEANUP_GOAL_UNITS.find((u) => bytes % u === 0) ?? 1073741824;
  $('cleanupGoalUnit').value = String(unit);
  $('cleanupGoalValue').value = String(Math.round((bytes / unit) * 100) / 100);
}

/** The target as bytes, or null when the box is empty or nonsense. */
function collectCleanupGoal() {
  const raw = parseFloat($('cleanupGoalValue').value);
  if (!Number.isFinite(raw) || raw <= 0) return null;
  return Math.round(raw * (Number($('cleanupGoalUnit').value) || 1073741824));
}

$('cleanupGoalClear').addEventListener('click', () => {
  $('cleanupGoalValue').value = '';
  adoptCartGoal(null);
  $('settingsStatus').textContent = 'Target cleared — press Save to keep it';
});

/* ── Reclaim Score weights (v4 §3.2) ──
   Six sliders and a reset. §3.2 requires the weights to be user-editable, and
   the reason is not configurability for its own sake: a ranking whose
   reasoning cannot be inspected or adjusted is an oracle, and this app makes a
   point of not shipping any. */
const RECLAIM_WEIGHT_ROWS = [
  ['staleness', 'How long since it was used', 'Files nobody has opened in years rank higher.'],
  ['regenerable', 'Rebuilds itself', 'Caches and dependency folders a command can restore.'],
  ['elsewhere', 'A copy exists elsewhere', 'Pushed to a remote, or uploaded by a sync client.'],
  ['redundant', 'Another copy on this disk', 'An identical file found by the Duplicates view.'],
  ['size', 'Size', 'How big it is, measured against the rest of this scan.'],
  ['redownloadable', 'Came from somewhere', 'Downloaded files you could fetch again.'],
];

function renderReclaimWeights() {
  const host = $('reclaimWeights');
  if (!host) return;
  const weights = (settingsData && settingsData.reclaimWeights) || {};
  host.innerHTML = RECLAIM_WEIGHT_ROWS.map(([id, label, help]) => {
    const value = Math.round((Number(weights[id]) || 0) * 100);
    return `<div class="rule-row rw-row">
      <label for="rw-${id}">${escapeHtml(label)}</label>
      <input type="range" id="rw-${id}" data-weight="${id}" min="0" max="100" step="1" value="${value}"
             aria-describedby="rwh-${id}" aria-valuetext="${value} percent">
      <span class="num rw-val" id="rwv-${id}">${value}%</span>
      <span class="rw-help" id="rwh-${id}">${escapeHtml(help)}</span>
    </div>`;
  }).join('');
  host.querySelectorAll('[data-weight]').forEach((slider) => {
    slider.addEventListener('input', () => {
      $(`rwv-${slider.dataset.weight}`).textContent = slider.value + '%';
      // A range input announces its raw number; without this a screen reader
      // says "22" for a control whose whole meaning is "22 percent".
      slider.setAttribute('aria-valuetext', slider.value + ' percent');
      updateReclaimWeightsNote();
    });
  });
  updateReclaimWeightsNote();
}

/** Read the sliders back as the 0-1 weights the API stores. */
function collectReclaimWeights() {
  const out = {};
  for (const [id] of RECLAIM_WEIGHT_ROWS) {
    const slider = $(`rw-${id}`);
    if (slider) out[id] = Math.min(1, Math.max(0, Number(slider.value) / 100));
  }
  return out;
}

/**
 * Say what the current sliders mean, including the one setting that does
 * nothing: all six at zero. The server refuses that back to the defaults
 * rather than storing a score nobody can compute, so the note warns before
 * Save rather than letting the value silently snap back afterwards.
 */
function updateReclaimWeightsNote() {
  const note = $('reclaimWeightsNote');
  if (!note) return;
  const values = collectReclaimWeights();
  const total = Object.values(values).reduce((a, b) => a + b, 0);
  const off = Object.entries(values).filter(([, v]) => v === 0).length;
  note.textContent = total === 0
    ? 'Every signal is off, so there would be no score at all — saving this restores the defaults instead.'
    : off > 0
      ? `${off} signal${off === 1 ? '' : 's'} switched off — they are left out of the score rather than counted as zero.`
      : '';
}

$('reclaimResetBtn').addEventListener('click', () => {
  // `null` is how the API's normalizer is asked for the defaults, so the
  // numbers live in exactly one place — the server — and this button cannot
  // drift from them.
  void (async () => {
    try {
      settingsData = await api('/api/settings', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reclaimWeights: null }),
      });
      renderReclaimWeights();
      reclaimReset(); // every cached score was computed under the old weights
      toast('Reclaim Score weights reset to defaults');
    } catch (e) {
      toast('Could not reset: ' + e.message, 'error');
    }
  })();
});

/* ── Cloud accounts (Feature 25) ── */
function renderCloudAccounts() {
  const host = $('cloudAccounts');
  if (!host) return;
  const creds = settingsData.cloud || {};
  const providers = state.cloud.providers.length ? state.cloud.providers : [
    { id: 'gdrive', name: 'Google Drive', needsClientSecret: true, configured: false, connected: false },
    { id: 'dropbox', name: 'Dropbox', needsClientSecret: false, configured: false, connected: false },
    { id: 'onedrive', name: 'OneDrive', needsClientSecret: false, configured: false, connected: false },
  ];
  host.innerHTML = providers.map(p => `
    <div class="cloud-row" data-provider="${p.id}">
      <div class="rule-row">
        <span data-icon-inline>${icon('cloud', 15)}</span>
        <b style="width:110px;">${escapeHtml(p.name)}</b>
        <span class="muted" style="flex:1;">${p.connected ? `connected${p.account ? ' as <b>' + escapeHtml(p.account) + '</b>' : ''}` : 'not connected'}</span>
        ${p.connected
          ? `<button class="btn" data-cloud-disconnect="${p.id}">Disconnect</button>`
          : `<button class="btn btn-primary" data-cloud-connect="${p.id}">Connect…</button>`}
      </div>
      ${p.connected ? '' : `
      <div class="rule-row" style="margin-left:24px;">
        <label class="muted">Client ID</label>
        <input type="text" class="cc-id" style="flex:1;min-width:0;" value="${escapeHtml(creds[p.id]?.clientId || '')}" placeholder="from the ${escapeHtml(p.name)} developer console" spellcheck="false" aria-label="${escapeHtml(p.name)} client ID">
        ${p.needsClientSecret ? `<label class="muted">Secret</label>
        <input type="text" class="cc-secret" style="width:150px;" value="${escapeHtml(creds[p.id]?.clientSecret || '')}" placeholder="client secret" spellcheck="false" aria-label="${escapeHtml(p.name)} client secret">` : ''}
      </div>
      <div class="rule-row cloud-paste" data-paste="${p.id}" hidden style="margin-left:24px;">
        <label class="muted">Didn't redirect back? Paste the code or URL:</label>
        <input type="text" class="cc-paste" style="flex:1;min-width:0;" placeholder="paste the redirect URL or code here" spellcheck="false" aria-label="Pasted sign-in code">
        <button class="btn cc-paste-go">Finish</button>
      </div>`}
    </div>`).join('');

  host.querySelectorAll('[data-cloud-connect]').forEach(b => b.addEventListener('click', () => connectCloud(b.dataset.cloudConnect)));
  host.querySelectorAll('[data-cloud-disconnect]').forEach(b => b.addEventListener('click', async () => {
    try {
      await api('/api/cloud/disconnect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: b.dataset.cloudDisconnect }) });
      toast('Disconnected — the saved sign-in was wiped from this computer');
      await loadCloudStatus();
      renderCloudAccounts();
    } catch (e) { toast(e.message, 'error'); }
  }));
  host.querySelectorAll('.cc-paste-go').forEach(b => b.addEventListener('click', async () => {
    const row = b.closest('.cloud-paste');
    try {
      await api('/api/cloud/connect/manual', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input: row.querySelector('.cc-paste').value }) });
      toast('Connected');
      await loadCloudStatus();
      renderCloudAccounts();
    } catch (e) { toast(e.message, 'error'); }
  }));
}

function collectCloudCreds() {
  const out = {};
  document.querySelectorAll('#cloudAccounts .cloud-row').forEach(row => {
    const id = row.dataset.provider;
    const idInput = row.querySelector('.cc-id');
    if (!idInput) { // connected rows keep their saved creds
      if (settingsData.cloud?.[id]) out[id] = settingsData.cloud[id];
      return;
    }
    const clientId = idInput.value.trim();
    if (!clientId) return;
    const secret = row.querySelector('.cc-secret');
    out[id] = { clientId, ...(secret && secret.value.trim() ? { clientSecret: secret.value.trim() } : {}) };
  });
  return out;
}

let cloudConnectPoll = 0;

/**
 * Five minutes with no consent, and the poll stops.
 *
 * Stopping is right — the loopback listener is gone by then and polling on
 * forever would be a lie about a handshake nobody is completing. Stopping in
 * SILENCE was not: the provider's row simply ceased moving, which tells a
 * person who started something in another tab exactly nothing (§3.5). So the
 * paste-the-code row is left open, because pasting the code is the way out of
 * this state, and the toast says both what happened and what to do.
 */
function cloudConnectGaveUp(providerId) {
  clearInterval(cloudConnectPoll);
  fxOrbHide('cloud');
  const pasteRow = document.querySelector(`.cloud-paste[data-paste="${providerId}"]`);
  if (pasteRow) pasteRow.hidden = false;
  toast('TreeMap stopped listening for approval after five minutes. Paste the code from the browser tab below, or press Connect to start again.', 'error', 12000);
}

async function connectCloud(providerId) {
  try {
    // Save the credentials first so the server can build the consent URL.
    settingsData = await api('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cloud: collectCloudCreds() }),
    });
    const started = await api('/api/cloud/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: providerId }),
    });
    window.open(started.authorizeUrl, '_blank', 'noopener');
    const pasteRow = document.querySelector(`.cloud-paste[data-paste="${providerId}"]`);
    if (pasteRow) pasteRow.hidden = false;
    toast('Approve access in the browser tab that just opened');
    // The loopback listener completes silently — poll until it does.
    clearInterval(cloudConnectPoll);
    // FX: the "connecting" orb rides the provider's own row for as long as
    // the handshake is genuinely pending; every way the poll can end drops it.
    fxOrbShow('cloud', document.querySelector(`.cloud-row[data-provider="${providerId}"] .rule-row`), 'connecting');
    const t0 = Date.now();
    cloudConnectPoll = setInterval(async () => {
      if (Date.now() - t0 > 5 * 60_000) { cloudConnectGaveUp(providerId); return; }
      await loadCloudStatus();
      if (state.cloud.providers.find(p => p.id === providerId)?.connected) {
        clearInterval(cloudConnectPoll);
        fxOrbHide('cloud'); // before the rerender rewrites the row it sits on
        toast('Connected ✓');
        renderCloudAccounts();
      }
    }, 2500);
  } catch (e) {
    fxOrbHide('cloud');
    toast(e.message, 'error');
  }
}

const SCHED_HOURS = [6, 12, 24, 48, 168];
function renderSchedules() {
  const host = $('schedList');
  const rows = settingsData.schedules;
  if (!rows.length) {
    host.innerHTML = '<div class="muted" style="padding:4px 0 10px;">No scheduled scans yet.</div>';
    return;
  }
  host.innerHTML = `
    <div class="sched-row sched-head muted" aria-hidden="true">
      <span>Folder</span><span>Every</span><span>Alert if +GB</span><span>or +%</span><span>On</span><span></span>
    </div>` + rows.map((s, i) => {
    const hours = SCHED_HOURS.includes(s.intervalHours) ? SCHED_HOURS : [s.intervalHours, ...SCHED_HOURS];
    return `
    <div class="sched-row">
      <input type="text" class="s-path" data-i="${i}" value="${escapeHtml(s.path)}" placeholder="/Users/you/Documents" spellcheck="false" aria-label="Folder to scan on a schedule">
      <select class="s-int" aria-label="Scan interval">
        ${hours.map(h => `<option value="${h}"${s.intervalHours === h ? ' selected' : ''}>${h === 168 ? 'week' : h + ' h'}</option>`).join('')}
      </select>
      <input type="number" class="s-gb" min="0" step="0.5" value="${s.thresholdBytes ? (s.thresholdBytes / 1073741824).toFixed(1) : ''}" placeholder="–" aria-label="Alert threshold in gigabytes">
      <input type="number" class="s-pct" min="0" value="${s.thresholdPct ?? ''}" placeholder="–" aria-label="Alert threshold in percent">
      <input type="checkbox" class="s-on"${s.enabled ? ' checked' : ''} aria-label="Schedule enabled">
      <button class="icon-btn danger s-del" data-i="${i}" aria-label="Remove this schedule" title="Remove">${icon('trash', 14)}</button>
    </div>`;
  }).join('');
  host.querySelectorAll('.s-del').forEach(b => b.addEventListener('click', () => {
    collectSettingsForms();
    settingsData.schedules.splice(+b.dataset.i, 1);
    renderSchedules();
  }));
}

function renderIgnores() {
  const host = $('ignoreList');
  const rows = settingsData.ignore;
  if (!rows.length) {
    host.innerHTML = '<div class="muted" style="padding:4px 0 10px;">Nothing ignored — everything gets scanned and suggested.</div>';
    return;
  }
  host.innerHTML = rows.map((e, i) => `
    <div class="ign-row">
      <input type="text" class="i-pat" data-i="${i}" value="${escapeHtml(e.pattern)}" placeholder="node_modules, *.iso, ~/Library …" spellcheck="false" aria-label="Pattern to ignore">
      <select class="i-scope" aria-label="Where this pattern applies">
        <option value="scan"${e.scope === 'scan' ? ' selected' : ''}>Don't scan</option>
        <option value="suggest"${e.scope === 'suggest' ? ' selected' : ''}>Don't suggest</option>
        <option value="both"${e.scope === 'both' ? ' selected' : ''}>Both</option>
      </select>
      <button class="icon-btn danger i-del" data-i="${i}" aria-label="Remove this pattern" title="Remove">${icon('trash', 14)}</button>
    </div>`).join('');
  host.querySelectorAll('.i-del').forEach(b => b.addEventListener('click', () => {
    collectSettingsForms();
    settingsData.ignore.splice(+b.dataset.i, 1);
    renderIgnores();
  }));
}

/** Read the form rows back into settingsData (before add/remove/save). */
function collectSettingsForms() {
  document.querySelectorAll('#schedList .sched-row:not(.sched-head)').forEach(row => {
    const s = settingsData.schedules[+row.querySelector('.s-path').dataset.i];
    if (!s) return;
    s.path = row.querySelector('.s-path').value.trim();
    s.intervalHours = +row.querySelector('.s-int').value;
    const gb = parseFloat(row.querySelector('.s-gb').value);
    s.thresholdBytes = Number.isFinite(gb) && gb > 0 ? Math.round(gb * 1073741824) : undefined;
    const pct = parseFloat(row.querySelector('.s-pct').value);
    s.thresholdPct = Number.isFinite(pct) && pct > 0 ? pct : undefined;
    s.enabled = row.querySelector('.s-on').checked;
  });
  document.querySelectorAll('#ignoreList .ign-row').forEach(row => {
    const e = settingsData.ignore[+row.querySelector('.i-pat').dataset.i];
    if (!e) return;
    e.pattern = row.querySelector('.i-pat').value.trim();
    e.scope = row.querySelector('.i-scope').value;
  });
}

$('schedAddBtn').addEventListener('click', () => {
  collectSettingsForms();
  settingsData.schedules.push({
    id: '',
    path: state.root ? state.root.path : (state.system?.homeDir || ''),
    intervalHours: 24,
    enabled: true,
  });
  renderSchedules();
});
$('ignoreAddBtn').addEventListener('click', () => {
  collectSettingsForms();
  settingsData.ignore.push({ pattern: '', scope: 'both' });
  renderIgnores();
});

$('settingsSaveBtn').addEventListener('click', async () => {
  collectSettingsForms();
  const schedules = settingsData.schedules.filter(s => s.path);
  const ignore = settingsData.ignore.filter(e => e.pattern);
  const forecastThresholdDays = Math.min(365, Math.max(1, Math.round(Number($('forecastDays').value) || 30)));
  const watchIdleMinutes = Math.min(120, Math.max(1, Math.round(Number($('watchIdleMin').value) || 10)));
  const timeCapsuleRetentionDays = Math.min(365, Math.max(1, Math.round(Number($('capsuleRetentionDays').value) || 30)));
  const timeCapsuleMaxPercent = Math.min(90, Math.max(1, Math.round(Number($('capsuleMaxPercent').value) || 10)));
  const cloud = collectCloudCreds();
  const reclaimWeights = collectReclaimWeights();
  const cleanupGoalBytes = collectCleanupGoal(); // null clears the target (§4.1)
  const humanScaleUnits = $('humanScaleToggle').checked; // §9.3
  try {
    settingsData = await api('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ schedules, ignore, forecastThresholdDays, watchIdleMinutes, timeCapsuleRetentionDays, timeCapsuleMaxPercent, cloud, reclaimWeights, cleanupGoalBytes, humanScaleUnits }),
    });
    humanScaleOn = settingsData.humanScaleUnits !== false;
    renderSchedules();
    renderIgnores();
    $('forecastDays').value = settingsData.forecastThresholdDays ?? 30;
    $('watchIdleMin').value = settingsData.watchIdleMinutes ?? 10;
    $('capsuleRetentionDays').value = settingsData.timeCapsuleRetentionDays ?? 30;
    $('capsuleMaxPercent').value = settingsData.timeCapsuleMaxPercent ?? 10;
    renderCleanupGoalFields(); // re-read from the server's answer, not the form
    renderReclaimWeights();
    // Every cached score was computed under the previous weights, so keeping
    // them would show old numbers beside the new sliders until the next scan.
    reclaimReset();
    if (state.view === 'treemap' && state.treemap.colorMode === 'reclaim' && state.treemap.rootPath) drawView();
    if (state.bigFilesSort === 'reclaim') refreshBigFiles();
    $('settingsStatus').textContent = 'Saved';
    toast('Settings saved — ignore rules apply from the next scan');
    setTimeout(() => { if ($('settingsStatus').textContent === 'Saved') $('settingsStatus').textContent = ''; }, 2500);
  } catch (e) {
    toast('Save failed: ' + e.message, 'error');
  }
});

/* ── Growth notifications from scheduled scans (poll once a minute) ── */
let lastNotifPoll = Date.now();
setInterval(async () => {
  try {
    const data = await api('/api/notifications?since=' + lastNotifPoll);
    lastNotifPoll = data.now;
    for (const n of data.notifications) toast(n.message, 'error', 12000);
  } catch { /* server unreachable — the next poll will catch up */ }
}, 60_000);

/* ───────────────────────────── Modal plumbing ───────────────────────────── */
function closeModal(id) {
  $(id).classList.remove('open');
  // A consent handshake abandoned behind a closed Settings sheet is not
  // "pending" to anyone: left alone, the 2.5s status poll and the
  // connecting orb run for up to five minutes inside a display:none
  // subtree (FxOrbs only gates on document.hidden). Closing the sheet
  // ends both; Connect starts a fresh handshake, and a consent that DID
  // complete shows as connected the next time the sheet opens.
  if (id === 'settingsModal') { clearInterval(cloudConnectPoll); fxOrbHide('cloud'); }
  // The Smart pane's funnel is a live handle inside this sheet; every way of
  // closing the sheet funnels through here, so this is its one exit door.
  if (id === 'cleanModal') cleanFunnelDrop();
  // FX: the job ring dies with the sheet, whichever surface closed it — a beam
  // on a hidden modal would be a claim nobody can see.
  if (id === 'offloadModal') {
    FxBeam.attach($('offloadBeamStrip'), { type: 'md', active: false });
    /* A dismissal is not a cancel. done() clears activeJob before it closes
       the dialog, so a job still standing here means the scrim or Escape took
       the dialog away while the copy was mid-flight. The job keeps running and
       its stream keeps reporting — the completion toast still lands — but an
       empty screen reads as "stopped", and that is the one wrong conclusion
       that could cost someone track of where their files went. Say it instead.
       Cancelling stays where it was: the Cancel button inside the dialog. */
    if (typeof activeJob !== 'undefined' && activeJob) {
      toast('That job is still running — you\'ll be told when it finishes. Reopen it to cancel.', 'success', 7000);
    }
  }
  // FX: a keyboard close moves no pointer — the hover ring must not outlive
  // the card it sat on.
}
document.querySelectorAll('[data-close]').forEach(b =>
  b.addEventListener('click', () => closeModal(b.dataset.close)));
// The scrim path goes through closeModal too — a close is a close, whichever
// surface delivered it, and per-modal teardown must not depend on which one.
document.querySelectorAll('.modal-backdrop').forEach(bd =>
  bd.addEventListener('mousedown', (e) => { if (e.target === bd) closeModal(bd.id); }));
