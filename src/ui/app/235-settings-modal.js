/* ───────────────────────────── Settings modal ───────────────────────────── */
let settingsData = { ignore: [], schedules: [] };

/**
 * The sheet's status line, said in #settingsStatusSaid too (review F1.17): why Save is off after a failed
 * load, and a cleared target, were plain text no screen reader heard.
 */
function setSettingsStatus(words) {
  $('settingsStatus').textContent = words;
  if (typeof sayAloud === 'function') sayAloud('settingsStatusSaid', words); // guarded: a page reader may lift this without it
}
void loadPortableMode(); // D3 — decided before the user scans anything
$('settingsBtn').innerHTML = icon('settings', 16);
$('settingsBtn').addEventListener('click', async () => {
  $('settingsModal').classList.add('open');
  setSettingsStatus('');
  void renderAllocationDiagnostic(); // A2 — independent of settings loading
  renderEngineBudgetHelp();          // Automatic's sentence, in this platform's words
  void loadEngineBudget();           // Phase 2 — its own endpoint, its own failure mode
  // D2 — the right-click entry, re-read from the OS each time the sheet opens.
  // Its only caller was lost once (QA D70) and the row sat on "Checking…".
  void renderShellIntegration();
  // Save waits for the stored settings (the hunt, C79): pressed over the
  // placeholder lists a failed or unanswered load leaves, it wrote empty
  // schedules, ignore list and cloud client IDs over the stored ones.
  settingsSaveOn(false);
  try {
    settingsData = await api('/api/settings');
  } catch (e) {
    toast('Could not load settings: ' + e.message, 'error');
    setSettingsStatus('Your settings could not be read, so Save is off — nothing here can overwrite them. Close this sheet and open Settings again to try again.');
    return;
  }
  settingsSaveOn(true);
  rememberStoredSchedules();
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
  renderScanEngine(settingsData.engine); // Phase 3 — rides on the settings just loaded
  renderScanBoundary(settingsData.scanBoundary); // Track U, U-27 — likewise
});

/* ── Scan engine (Phase 3) ──
   Which engine reads the disk: Automatic (the native engine when this build
   has it, else gdu — never on Windows — else the built-in walker) or one of
   them forced. A dial
   like the budget below — saved the moment it is picked, through the one
   api() wrapper to PUT /api/settings with the single key { engine } — and it
   applies from the next scan.
   M6 adds NTFS turbo (`ntfs-mft`), Windows only: its row ships hidden and is
   shown only while the page knows the computer is Windows. Anywhere else the
   server refuses the value, so a stored one is shown as Automatic. */
const SCAN_ENGINES = ['auto', 'native', 'gdu', 'walker', 'ntfs-mft'];
const SCAN_ENGINE_LABELS = { auto: 'Automatic', native: 'Native', gdu: 'gdu', walker: 'Built-in walker', 'ntfs-mft': 'NTFS turbo' };
/** The gdu row's sentence. On Windows gdu is never used (it reads every file id
    as 0, RISKS R59), so there the row says so instead of promising it — and
    says what choosing it does, since an Automatic scan there is the native
    engine's, not the walker's. */
const SCAN_ENGINE_GDU_HELP = 'the bundled gdu helper, one process per top-level folder';
const SCAN_ENGINE_GDU_HELP_WINDOWS = 'not used on Windows, where gdu cannot tell two names for one file apart and would count such a file twice: choosing it there scans with the built-in walker';

function scanEngineInputs() {
  return SCAN_ENGINES.map((e) => $(`scanEngine-${e}`)).filter(Boolean);
}

/** Whether /api/system has said this is Windows. Guarded like platformWord:
    before the bundle's `const state` line has run, reading it throws. */
function scanEngineOnWindows() {
  let p;
  try { p = state && state.system ? state.system.platform : undefined; } catch { p = undefined; }
  return p === 'win32';
}

/** Check the stored choice; a value the page does not know renders as
    Automatic, never as nothing — and so does NTFS turbo on a page that does
    not know it is on Windows, whose row stays hidden. */
function renderScanEngine(engine) {
  const onWindows = scanEngineOnWindows();
  const turboRow = $('scanEngineRow-ntfs-mft');
  if (turboRow) turboRow.hidden = !onWindows;
  const gduHelp = $('scanEngineHelp-gdu');
  if (gduHelp) gduHelp.textContent = onWindows ? SCAN_ENGINE_GDU_HELP_WINDOWS : SCAN_ENGINE_GDU_HELP;
  const offered = onWindows ? SCAN_ENGINES : SCAN_ENGINES.filter((e) => e !== 'ntfs-mft');
  const chosen = offered.includes(engine) ? engine : 'auto';
  for (const input of scanEngineInputs()) input.checked = input.value === chosen;
}

async function saveScanEngine(engine) {
  try {
    const saved = await api('/api/settings', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ engine }),
    });
    // Only the key this pick saved: the server answers with every setting as
    // stored, and adopting the whole answer took the sheet's unsaved schedule
    // and ignore rows from under them, so Save dropped them (review F1.3).
    settingsData = { ...settingsData, engine: saved.engine };
    renderScanEngine(settingsData.engine);
    toast(`Scan engine: ${SCAN_ENGINE_LABELS[settingsData.engine] || settingsData.engine} — from the next scan`);
    // The engine decides whether the Fast-rescan box is offered (QA D45):
    // read the plan again now, not at the next scan or reload.
    void refreshFastRescanPlan();
  } catch (e) {
    // The radio moved under the pointer before the server had its say: put it
    // back on what is actually stored, and say why.
    renderScanEngine(settingsData.engine);
    toast('Could not save the scan engine: ' + e.message, 'error');
  }
}
for (const input of scanEngineInputs()) {
  input.addEventListener('change', () => { if (input.checked) void saveScanEngine(input.value); });
}

/* ── Scanning budget (Phase 2 §11.4) ──
   Four presets, saved the moment one is picked — a budget is a dial, not a
   form, so it does not wait for the Save button and does not ride on
   PUT /api/settings. The endpoint is always there (without the native module
   the Node shim answers, and the line under the radios says it is
   approximate); a server that answers 404 is one without the feature, and
   that is a state to show in the row, in words — not a blank, and not an
   error toast. */
const ENGINE_BUDGET_PRESETS = ['auto', 'eco', 'balanced', 'turbo'];
const ENGINE_BUDGET_UNAVAILABLE = 'Not available in this build';
let engineBudget = null; // the server's last answer, or null when it has none

/** Automatic's sentence. The heat clause is said only where the governor can
    read the heat — a Mac reports it, Linux through its thermal zones, Windows
    to no program at all (tm-governor's signals) — and before /api/system has
    answered, or on an OS the table does not name, nothing is promised that
    might not happen. */
function engineBudgetAutoHelp() {
  return platformWord({
    darwin: 'Turbo for scans you start, never above Balanced for the rest; a step lower on battery, Eco when the Mac runs hot',
    win32: 'Turbo for scans you start, never above Balanced for the rest; a step lower on battery',
    linux: 'Turbo for scans you start, never above Balanced for the rest; a step lower on battery, Eco when the computer runs hot',
    other: 'Turbo for scans you start, never above Balanced for the rest; a step lower on battery',
  });
}

/** Write Automatic's sentence for this platform; the markup ships the neutral one. */
function renderEngineBudgetHelp() {
  const help = $('engineBudgetHelp-auto');
  if (help) help.textContent = engineBudgetAutoHelp();
}

function engineBudgetInputs() {
  return ENGINE_BUDGET_PRESETS.map((p) => $(`engineBudget-${p}`)).filter(Boolean);
}

/** The line under the radios: what is running now, and how faithfully. */
function engineBudgetStatusText(data) {
  const effective = data && data.effective;
  if (!effective || !effective.preset) return '';
  const approx = effective.source === 'node-shim' ? ' — this build can only keep to it approximately' : '';
  return `Right now: ${budgetPresetLabel(effective.preset)}${approx}.`;
}

/** What a failed read says. A 404 is a build without the feature, not a fault. */
function engineBudgetErrorText(err) {
  if (err && err.status === 404) return ENGINE_BUDGET_UNAVAILABLE;
  return 'Could not read the scanning budget: ' + (err && err.message ? err.message : 'no answer');
}

function renderEngineBudget(data) {
  engineBudget = data;
  const preset = data && data.setting && ENGINE_BUDGET_PRESETS.includes(data.setting.preset) ? data.setting.preset : 'auto';
  for (const input of engineBudgetInputs()) {
    input.disabled = false;
    input.checked = input.value === preset;
  }
  const note = $('engineBudgetNote');
  if (note) note.textContent = engineBudgetStatusText(data);
  // Said in #engineBudgetNoteSaid: held while Settings is closed — an answer
  // can come after it was — and said a frame after it opens (BQT item 28).
  // Guarded: a page reader may lift this function without sayAloud.
  if (typeof sayAloud === 'function') sayAloud('engineBudgetNoteSaid', engineBudgetStatusText(data));
}

function renderEngineBudgetUnavailable(err) {
  engineBudget = null;
  for (const input of engineBudgetInputs()) input.disabled = true;
  const note = $('engineBudgetNote');
  if (note) note.textContent = engineBudgetErrorText(err);
  if (typeof sayAloud === 'function') sayAloud('engineBudgetNoteSaid', engineBudgetErrorText(err)); // as above (BQT item 28)
}

async function loadEngineBudget() {
  let data;
  try { data = await api('/api/engine/budget'); }
  catch (e) { renderEngineBudgetUnavailable(e); return; }
  renderEngineBudget(data);
}

async function saveEngineBudget(preset) {
  // The row has no cpuPercent control, so the stored value rides along
  // unchanged rather than being reset by a save it was never part of.
  const cpuPercent = engineBudget && engineBudget.setting && engineBudget.setting.cpuPercent != null
    ? engineBudget.setting.cpuPercent : null;
  try {
    const data = await api('/api/engine/budget', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ preset, cpuPercent }),
    });
    renderEngineBudget(data);
    toast(`Scanning budget: ${budgetPresetLabel(preset)}`);
  } catch (e) {
    // The radio moved under the pointer before the server had its say: put it
    // back on what is actually stored, and say why.
    if (engineBudget) renderEngineBudget(engineBudget); else renderEngineBudgetUnavailable(e);
    toast('Could not save the scanning budget: ' + e.message, 'error');
  }
}
for (const input of engineBudgetInputs()) {
  input.addEventListener('change', () => { if (input.checked) void saveEngineBudget(input.value); });
}

/* ── Clean Up target (v4 §4.1) ──
   Stored as bytes; shown in whichever unit divides evenly, largest first, so
   50 GB comes back as "50 GB" rather than "50000 MB". Units are decimal, as
   printed (QA D09). An empty box is the no-target state and is written back
   as `null`. */
const CLEANUP_GOAL_UNITS = [TB, GB, MB];
function renderCleanupGoalFields() {
  // adoptCartGoal is boot's own policy: the dock and the dialog can never
  // disagree, whether this paint follows an open or a save.
  const bytes = adoptCartGoal(settingsData.cleanupGoalBytes);
  if (bytes === null) { $('cleanupGoalValue').value = ''; $('cleanupGoalUnit').value = String(GB); return; }
  // A target no unit divides — one an earlier TreeMap stored in 1024s, 50
  // "GB" being 53,687,091,200 bytes — opens in the largest unit it reaches,
  // as its exact figure (53.6870912 GB): Save reads this box back whatever
  // was edited, so a rounded figure would rewrite the target (review F1.5).
  const unit = CLEANUP_GOAL_UNITS.find((u) => bytes % u === 0)
    ?? CLEANUP_GOAL_UNITS.find((u) => bytes >= u) ?? MB;
  $('cleanupGoalUnit').value = String(unit);
  $('cleanupGoalValue').value = String(bytes / unit);
}

/** The target as bytes, or null when the box is empty or nonsense. */
function collectCleanupGoal() {
  const raw = parseFloat($('cleanupGoalValue').value);
  if (!Number.isFinite(raw) || raw <= 0) return null;
  return Math.round(raw * (Number($('cleanupGoalUnit').value) || GB));
}

// An edit like every other field here: Save carries it to the cart's meter
// (renderCleanupGoalFields), so "Close without saving" leaves the target and
// the meter as they were (review F1.10).
const TARGET_CLEARED = 'Target cleared — press Save to keep it';
$('cleanupGoalClear').addEventListener('click', () => {
  $('cleanupGoalValue').value = '';
  // While Save is off the line says why, and "press Save" would be untrue over it (review HD2 F1.11).
  if ($('settingsSaveBtn').disabled) return;
  // Each press is said (review HD-L16): the same words as the last are no news to sayAloud, so the line is
  // emptied first.
  setSettingsStatus('');
  setSettingsStatus(TARGET_CLEARED);
});
// A new target typed, or its unit changed, retires the line (review HD-L16): left up, it was untrue while
// Save would store the new figure. A line about anything else stays.
for (const [id, type] of [['cleanupGoalValue', 'input'], ['cleanupGoalUnit', 'change']]) {
  $(id).addEventListener(type, () => { if ($('settingsStatus').textContent === TARGET_CLEARED) setSettingsStatus(''); });
}

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
      const saved = await api('/api/settings', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reclaimWeights: null }),
      });
      settingsData = { ...settingsData, reclaimWeights: saved.reclaimWeights }; // only this key (F1.3)
      renderReclaimWeights();
      reclaimReset(); // every cached score was computed under the old weights
      toast('Reclaim Score weights reset to defaults');
    } catch (e) {
      toast('Could not reset: ' + e.message, 'error');
    }
  })();
});

/* ── Drives mounted inside a folder (Track U, U-27) ──
   "Stay on this drive" (the default, the owner's U-Q9 answer) or "Include
   drives mounted inside it": a dial like the scan engine above — saved the
   moment it is picked, through PUT /api/settings with the one key
   { scanBoundary } — and applied from the next scan. A value the page does
   not know reads as the default. */
const SCAN_BOUNDARY_RULES = ['stay', 'cross'];
const SCAN_BOUNDARY_LABELS = { stay: 'Stay on this drive', cross: 'Include drives mounted inside it' };

function scanBoundaryInputs() {
  return SCAN_BOUNDARY_RULES.map((r) => $(`scanBoundary-${r}`)).filter(Boolean);
}

function renderScanBoundary(rule) {
  const chosen = SCAN_BOUNDARY_RULES.includes(rule) ? rule : 'stay';
  for (const input of scanBoundaryInputs()) input.checked = input.value === chosen;
}

async function saveScanBoundary(rule) {
  try {
    const saved = await api('/api/settings', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scanBoundary: rule }),
    });
    settingsData = { ...settingsData, scanBoundary: saved.scanBoundary }; // only this key (F1.3)
    renderScanBoundary(settingsData.scanBoundary);
    toast(`Drives mounted inside a folder: ${SCAN_BOUNDARY_LABELS[settingsData.scanBoundary] || settingsData.scanBoundary} — from the next scan`);
  } catch (e) {
    // The radio moved before the server had its say: back on what is stored, and why.
    renderScanBoundary(settingsData.scanBoundary);
    toast('Could not save where scans stop: ' + e.message, 'error');
  }
}
for (const input of scanBoundaryInputs()) {
  input.addEventListener('change', () => { if (input.checked) void saveScanBoundary(input.value); });
}

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
    const saved = await api('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cloud: collectCloudCreds() }),
    });
    settingsData = { ...settingsData, cloud: saved.cloud }; // only this key (F1.3)
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
      <input type="number" class="s-gb" min="0" step="0.5" value="${s.thresholdBytes ? String(s.thresholdBytes / GB) : ''}" placeholder="–" aria-label="Alert threshold in gigabytes">
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
    // As every path box is read (asPath): whitespace at its end is part of a
    // folder's name. Trimmed, any Save swapped "Screenshots " for its sibling
    // "Screenshots" (final review F1.4).
    s.path = asPath(row.querySelector('.s-path').value);
    s.intervalHours = +row.querySelector('.s-int').value;
    // renderSchedules paints the stored alert's exact figure (0.536870912 for
    // a 1024-based "0.5"), so a row nobody edited saves the bytes it had (review F1.1).
    const gb = parseFloat(row.querySelector('.s-gb').value);
    s.thresholdBytes = Number.isFinite(gb) && gb > 0 ? Math.round(gb * GB) : undefined;
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

/** The scheduled folders as the server last sent them: a folder the page put
    in a box is saved as stored, never looked up under another name (QA4a
    R4-1). Opening the sheet sets it (rememberStoredSchedules). */
let schedStoredPaths = new Set();
function rememberStoredSchedules() {
  schedStoredPaths = new Set((settingsData.schedules || []).map((s) => s.path));
}
/** Each press of Save takes the next number; the sheet closing retires every
    press still looking up a folder (settingsSheetClosed). */
let settingsSaveSeq = 0;
/** The Settings sheet closed (closeModal): a Save still looking up a folder
    saves nothing, and the button it held is handed back. */
function settingsSheetClosed() {
  settingsSaveSeq++;
  $('settingsSaveBtn').disabled = false;
  $('settingsSaveBtn').removeAttribute('aria-busy');
}
/** Save on or off: off until the stored settings have loaded, and while they cannot be read (the hunt, C79). */
function settingsSaveOn(on) {
  $('settingsSaveBtn').disabled = !on;
}
/** Every field of the sheet, read into the body Save sends. */
function settingsBody() {
  collectSettingsForms();
  return JSON.stringify({
    schedules: settingsData.schedules.filter(s => s.path),
    ignore: settingsData.ignore.filter(e => e.pattern),
    forecastThresholdDays: Math.min(365, Math.max(1, Math.round(Number($('forecastDays').value) || 30))),
    watchIdleMinutes: Math.min(120, Math.max(1, Math.round(Number($('watchIdleMin').value) || 10))),
    timeCapsuleRetentionDays: Math.min(365, Math.max(1, Math.round(Number($('capsuleRetentionDays').value) || 30))),
    timeCapsuleMaxPercent: Math.min(90, Math.max(1, Math.round(Number($('capsuleMaxPercent').value) || 10))),
    cloud: collectCloudCreds(),
    reclaimWeights: collectReclaimWeights(),
    cleanupGoalBytes: collectCleanupGoal(), // null clears the target (§4.1)
    humanScaleUnits: $('humanScaleToggle').checked, // §9.3
  });
}
/**
 * Before Save: a scheduled folder typed or changed here whose path ends in
 * whitespace and names no folder, where the same path without it does, is
 * not saved — nor that folder in its place: "no such folder", with that
 * folder offered, as every path box does (final review F1.4). Save is held
 * while it is looked up (at most PATH_LOOKUP_MS a folder). True when Save
 * may go ahead with `body`, the sheet as it was pressed.
 */
async function settingsFoldersChecked(body) {
  const typed = JSON.parse(body).schedules.map((s) => s.path).filter((p) => !schedStoredPaths.has(p) && boxLooksUp(p));
  if (!typed.length) return true;
  const btn = $('settingsSaveBtn');
  const seq = ++settingsSaveSeq;
  btn.disabled = true;
  btn.setAttribute('aria-busy', 'true');
  let found = null;
  try {
    for (const p of typed) {
      const meant = await boxMeant(p);
      if (seq !== settingsSaveSeq) break;
      if (meant) { found = { p, meant }; break; }
    }
  } finally {
    if (seq === settingsSaveSeq) { btn.disabled = false; btn.removeAttribute('aria-busy'); }
  }
  // The sheet closed, or a newer press took over and answers instead.
  if (seq !== settingsSaveSeq) return false;
  // What is saved is what Save was pressed on: an edit made while a folder
  // was looked up would be lost by saving the sheet as it was — so nothing is.
  if (settingsBody() !== body) {
    toast('Nothing was saved — a setting changed while a scheduled folder was being checked. Press Save to save the settings as they are now.', 'error');
    return false;
  }
  if (found) {
    // A click puts that folder in the box, for the person to save.
    offerMeant(found.p, found.meant, () => {
      if (seq !== settingsSaveSeq) return;
      document.querySelectorAll('#schedList .s-path').forEach((box) => { if (asPath(box.value) === found.p) box.value = found.meant; });
    }, 'Use that folder', 'settingsModal');
    return false;
  }
  return true;
}

/**
 * Why a number on the sheet cannot be saved as typed, or null (the hunt, C81): Save clamped it in
 * silence — 0 in "Keep copies for" saved 30 days, 95 % saved 90 — and closed with "Settings saved".
 * A figure outside its field's range, or not a whole number, is refused with the field and its range.
 */
function settingsRangeRefusal() {
  for (const [id, label, max, unit] of [
    ['forecastDays', 'Warn within', 365, 'days'], ['watchIdleMin', 'Auto-pause after', 120, 'minutes'],
    ['capsuleRetentionDays', 'Keep copies for', 365, 'days'], ['capsuleMaxPercent', 'Never use more than', 90, 'per cent'],
  ]) {
    const raw = String($(id).value ?? '').trim();
    if (raw === '') continue; // an empty box saves its default, as before
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > max) return `Enter a whole number from 1 to ${max} (${unit}) in “${label}”.`;
  }
  return null;
}

$('settingsSaveBtn').addEventListener('click', async () => {
  const refused = settingsRangeRefusal();
  if (refused) { toast(refused, 'error', 8000); return; }
  // Every field is read now, as the person pressed Save (QA4a R4-3).
  const body = settingsBody();
  if (!(await settingsFoldersChecked(body))) return;
  try {
    settingsData = await api('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body,
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
    // Saved: the sheet's work is done, so it closes (QA D76) — through
    // closeModal, like every other way out — and the toast says so. A
    // failure below leaves it open with the edits still in it.
    // A "Don't scan" rule moves the next scan off the native engine, which
    // decides whether the Fast-rescan box is offered (QA D45): read it again now.
    void refreshFastRescanPlan();
    toast('Settings saved — ignore rules apply from the next scan');
    closeModal('settingsModal');
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
  if (id === 'settingsModal') { clearInterval(cloudConnectPoll); fxOrbHide('cloud'); settingsSheetClosed(); }
  // The Smart pane's funnel is a live handle inside this sheet; every way of
  // closing the sheet funnels through here, so this is its one exit door.
  if (id === 'cleanModal') cleanFunnelDrop();
  // An ask sheet closed any way but its OK is a "no" (D65); after OK this
  // finds the question already answered.
  if (id === 'askModal') askSettle(null);
  // The shared dialog's Cancel and OK label are put back for whichever dialog
  // uses it next (D62).
  if (id === 'confirmModal') confirmFooterReset();
  // A typed path still opening in the folder picker is not acted on once the
  // picker is gone: no pick (an offload destination), no scan.
  if (id === 'browseModal') browseClosed();
  // A Save still looking up its folder when the policy editor goes saves
  // nothing, and its button is handed back (QA4a R4-3).
  if (id === 'apModal') apEditorClosed();
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

/* ── Focus discipline for every dialog ── */
/* Thirty-two call sites open a sheet by adding `.open` to its backdrop, and
   until now only the palette, the duplicate viewer and the two small forms
   moved focus with it: everywhere else Enter could not confirm, Tab walked
   the page under the scrim, and a screen reader was never told a dialog had
   opened. Rather than a fourth pattern at every site, one net watches the
   class flip on every backdrop and applies the same rules to all of them:

   - the page (everything at body level that is not a backdrop or the toasts)
     goes `inert` while any sheet is up, and so does every open sheet except
     the topmost — Tab, clicks and assistive tech cannot reach underneath;
   - focus moves INTO the top sheet: an [autofocus] field, else its first
     field, else its footer's Cancel, else the sheet itself — never a button
     that commits or destroys (modalFocusTarget); a sheet that already placed
     focus (the palette, the viewer) is left alone;
   - Tab and Shift+Tab cycle inside the top sheet (modalTrapTab, called from
     the app-wide keydown handler);
   - closing restores focus to where it was before the sheet opened, unless
     the close already put it somewhere (the palette hands off to its action).
   `inert` is native in Electron's Chromium — no dependency. */
/* The last few focused elements, anywhere, newest last. Not just the last
   one: a sheet that focuses itself as it opens — the duplicate viewer does,
   in the same breath as its `.open` — has moved focus inside by the time the
   observer below runs, so "the last focus" named the sheet and the close had
   nowhere to return to (QA third pass D05). A few entries cover every focus
   move one synchronous open can make. */
const FOCUS_TRAIL_MAX = 8;
const focusTrail = [];
const modalPrevFocus = new Map(); // backdrop id → the element to return focus to

/* Body-level panels a sheet's own content opens over it, painted above every
   sheet: the reclaim-score breakdown Clean Up's badges open (z-index 211 to
   the sheets' 100). They belong to the top layer, not to the page behind it.
   Made inert with the page, the breakdown opened unreachable — its close
   button refused focus, Tab and a screen reader could not get to it, and a
   click on it fell through to the sheet and closed it (review F1.3). The
   right-click menu and the plain-words popover are not here: what opens them
   lives in the page, which no one can reach while a sheet is up. */
const MODAL_OVERLAYS = ['rcPopover'];
function inModalOverlay(node) {
  return !!(node && node.closest && MODAL_OVERLAYS.some((id) => node.closest('#' + id)));
}

function noteFocus(el) {
  focusTrail.push(el);
  if (focusTrail.length > FOCUS_TRAIL_MAX) focusTrail.shift();
}
/** Where focus was before `sheet` took it: the newest focus outside the sheet that is still in the page, or null. */
function focusBefore(sheet) {
  for (let i = focusTrail.length - 1; i >= 0; i--) {
    const el = focusTrail[i];
    if (el && el.isConnected !== false && !sheet.contains(el)) return el;
  }
  return null;
}
document.addEventListener('focusin', (e) => {
  noteFocus(e.target);
  // Belt and braces over inert: focus that lands outside the top sheet (a
  // programmatic .focus() somewhere in the page) is pulled back in. #toasts
  // is the exception, as it is to inert: an offer made in answer to a press
  // in the sheet takes focus there, the one way a keyboard reaches it (final
  // review F1.10). Tab from it goes back into the sheet (modalTrapTab).
  const top = topModal();
  if (top && !top.contains(e.target) && !$('toasts').contains(e.target) && !inModalOverlay(e.target)) modalFocusInto(top);
});
/* A press that focuses nothing opens a sheet all the same: a click in Safari
   or Firefox on macOS, which do not focus a button they click, or a scripted
   click(). Closing it then gave focus back to the newest focus the net had
   seen — the Autopilot editor's Name field, not the "Browse…" that opened the
   picker (BQR-1 item 12b). So the control a click presses counts as the
   newest focus, noted as the click starts (capture), before any handler opens
   a sheet. A click on no control — the page's background — notes nothing. */
document.addEventListener('click', (e) => {
  const control = e.target && e.target.closest ? e.target.closest('button, a[href], input, select, textarea, [tabindex]') : null;
  if (control && control !== document.activeElement) noteFocus(control);
}, true);

/* Which sheet is on top, bottom to top.
   NOT DOM order. Backdrops share one z-index, so DOM order is what PAINTS —
   and that is the bug, not the rule: #confirmModal is markup/095 and
   #settingsModal is markup/110, so a confirmation opened from Settings
   painted behind the sheet that opened it. The order that matters is the
   order they were opened in, and `syncModalLayers` lifts the top sheet so
   the painting agrees with it. The palette still wins outright: it is
   summoned over anything and hands focus back on close. */
let modalOpenSeq = 0;
const modalOrder = new WeakMap(); // backdrop → the tick it was opened on
function openModals() {
  const open = [...document.querySelectorAll('.modal-backdrop.open')]
    .sort((a, b) => (modalOrder.get(a) || 0) - (modalOrder.get(b) || 0));
  const k = open.findIndex((el) => el.id === 'cmdkModal');
  if (k !== -1 && k !== open.length - 1) open.push(...open.splice(k, 1));
  return open;
}
function topModal() { const open = openModals(); return open.length ? open[open.length - 1] : null; }

/* The controls a keyboard can land on, in order. A control hidden by
   `visibility` keeps its box but cannot take focus — the selection bar's
   buttons with nothing selected (QA D02) — so it is no stop: counted, it was
   the page's last one, and an offer handing focus there left it on <body>
   (review F2.1). */
function modalFocusables(root) {
  return [...root.querySelectorAll('a[href], button, input, select, textarea, [tabindex]')]
    .filter((el) => !el.disabled && el.tabIndex >= 0 && el.getAttribute('aria-hidden') !== 'true' && el.getClientRects().length &&
      getComputedStyle(el).visibility === 'visible');
}
/* Where focus lands as a sheet opens: its first field, else its safe way out
   (the footer's Cancel — a [data-close] button), else the sheet itself; never
   a button that commits or destroys (QA C01). The footer's primary or danger
   button used to take it, so an Enter pressed out of habit saved the policy
   the Autopilot editor had only just opened on, and the Trash sheet opened on
   "Empty Trash…". An [autofocus] control still wins: its sheet chose it —
   Settings chooses its "Close without saving", as its first fields save the
   moment one is picked and an arrow key on arrival moved the theme (review
   F1.4). A radio group is entered at its checked radio, as Tab enters it —
   on the first, unchecked one, Space would pick it. */
function modalFocusTarget(backdrop) {
  const dlg = backdrop.querySelector('.modal') || backdrop;
  const live = (el) => !el.disabled && el.getClientRects().length;
  const pick = (sel) => [...dlg.querySelectorAll(sel)].find(live);
  const first = pick('[autofocus]') || pick('input, select, textarea');
  const field = first && first.type === 'radio' && first.name
    ? [...dlg.querySelectorAll('input')].find((r) => r.type === 'radio' && r.name === first.name && r.checked && live(r)) || first
    : first;
  const target = field || pick('.modal-foot [data-close]');
  if (target) return target;
  if (!dlg.hasAttribute('tabindex')) dlg.setAttribute('tabindex', '-1');
  return dlg;
}
function modalFocusInto(backdrop) {
  const t = modalFocusTarget(backdrop);
  if (t && t.focus) t.focus({ preventScroll: true });
}
function modalTrapTab(e, top) {
  const f = modalFocusables(top);
  if (!f.length) { e.preventDefault(); return; }
  const i = f.indexOf(document.activeElement);
  if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); }
  else if (!e.shiftKey && (i === -1 || i === f.length - 1)) { e.preventDefault(); f[0].focus(); }
}
/* A sheet has opened since the net last placed focus. It takes focus wherever
   focus was, the breakdown included: a sheet opened over the breakdown is the
   layer the keyboard is in now, and left in the breakdown, Enter acted on it
   (review F2.3). Moving focus did not move Escape: the breakdown's own
   listener (185) took the first one until it learnt to yield to a sheet
   opened after it (review F3.1). Only a re-run of the net with no sheet
   newly open leaves focus in a panel the top sheet opened over itself
   (review F1.3). The mark is spent by the net's own pass, never by the one a
   closing sheet runs first (moveFocus false): one observer batch can open
   one sheet and close another, and the closing pass runs between them
   (review F3.3). */
let modalJustOpened = false;
function modalOpened(el) {
  modalOrder.set(el, ++modalOpenSeq);
  modalPrevFocus.set(el.id, focusBefore(el));
  modalJustOpened = true;
}
function modalClosed(el) {
  syncModalLayers(false); // lift inert first, or the restored focus is refused
  const prev = modalPrevFocus.get(el.id) || null;
  modalPrevFocus.delete(el.id);
  // A sheet opened from inside this one would return focus into a sheet that
  // is gone: re-point it at where this one came from.
  for (const [id, p] of modalPrevFocus) if (p && el.contains(p)) modalPrevFocus.set(id, prev);
  const active = document.activeElement;
  // The close already placed focus (the palette restores its own, an action
  // opened a search box): leave it. Otherwise focus fell to <body> when the
  // sheet stopped painting, is still nominally inside it, or is on an offer
  // the sheet made (#toasts is exempt from inert) — and that offer goes with
  // the sheet (toastsRetire), its choice being for a sheet that is gone
  // (final review F2.2, F2.3). Nominally on anything that stopped painting
  // counts, this sheet or not: two sheets closed in one batch ("Empty the
  // Trash" closes the question and the Trash sheet under it) find focus still
  // on the question's button as the second close runs — a browser drops it to
  // <body> at a later rendering step, not before this observer's microtask
  // (review F1.2 of QA fourth pass E04).
  const drifted = !active || active === document.body || el.contains(active)
    || !active.getClientRects().length || $('toasts').contains(active);
  toastsRetire(el.id);
  if (!drifted || !prev || !prev.focus) return;
  // The control that opened the sheet can be gone by now: the welcome card's
  // "Choose a folder" is, as the scan its "Scan this folder" starts repaints
  // the card in the same turn (review F2.1). Focus goes where it would had
  // that control left the screen — the views' focusLanding — never <body>.
  // Guarded: a page reader may lift this net without the views.
  // So can one still in the page that stopped painting while the sheet was open — a cart's Move to
  // Trash, in the dock a commit emptied — which takes no focus (review HC2-L7).
  const onScreen = prev.isConnected !== false && (typeof prev.getClientRects !== 'function' || prev.getClientRects().length > 0);
  // Not when it stopped painting because it sits in another sheet that closed in this same batch:
  // "Empty the Trash" closes the question, whose opener is the Trash sheet's Empty button, and then
  // the Trash sheet. That sheet's own close runs next and gives focus back to the Trash row it was
  // opened from; landing focus here first left it on the Dashboard's first control (review F1.1 of HZ).
  if (!onScreen && prev.isConnected !== false && typeof prev.closest === 'function' && prev.closest('.modal-backdrop')) return;
  const back = onScreen ? prev : (typeof focusLanding === 'function' ? focusLanding() : null);
  if (back) back.focus({ preventScroll: true });
}
function syncModalLayers(moveFocus = true) {
  const open = openModals();
  const top = open.length ? open[open.length - 1] : null;
  for (const el of document.body.children) {
    if (el.classList.contains('modal-backdrop')) {
      el.inert = el.classList.contains('open') && el !== top;
      // Paint follows focus. Stacked sheets share one z-index, so without
      // this the sheet that owns the keyboard can sit behind the one it was
      // opened from. Cleared on close so the stylesheet owns the rank again.
      if (el.style) el.style.zIndex = el === top && open.length > 1 ? '101' : '';
    } else if (el.id !== 'toasts' && el.id !== 'tooltip' && !MODAL_OVERLAYS.includes(el.id) && !el.classList.contains('blob')) el.inert = !!top;
  }
  if (!moveFocus) return;
  const opened = modalJustOpened;
  modalJustOpened = false;
  const active = document.activeElement;
  if (top && !top.contains(active) && (opened || !inModalOverlay(active))) modalFocusInto(top);
}
const modalNet = new MutationObserver((records) => {
  for (const r of records) {
    const el = r.target;
    const isOpen = el.classList.contains('open');
    const wasOpen = (r.oldValue || '').split(/\s+/).includes('open');
    if (isOpen === wasOpen) continue;
    if (isOpen) modalOpened(el); else modalClosed(el);
  }
  syncModalLayers();
});
document.querySelectorAll('.modal-backdrop').forEach((el) =>
  modalNet.observe(el, { attributes: true, attributeFilter: ['class'], attributeOldValue: true }));
/* ── end focus discipline ── */
