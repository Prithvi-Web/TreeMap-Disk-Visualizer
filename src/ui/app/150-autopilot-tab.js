/* ───────────────────────────── Autopilot tab (B1) ─────────────────────────────
   Standing cleanup policies. Clean Up stays exactly as it was — manual, and
   the place you go to delete something now; this is the place you go to say
   "keep doing this without me".

   Everything here is shaped around one fact: a policy deletes while nobody is
   watching, so the user has to be able to see what it *would* do before it can
   do it, and see what it *did* afterwards. Hence Preview beside every editor
   control, a mandatory approval on the first run, and a run history where the
   runs that refused are as visible as the ones that worked.               */

const AP_STATUS_LABEL = {
  'awaiting-approval': 'Needs your approval',
  completed: 'Ran',
  blocked: 'Held back',
  failed: 'Failed',
};
const GB = 1024 * 1024 * 1024;

/** Editor state for the policy dialog; null when it is closed. */
let apDraft = null;

async function loadAutopilot() {
  const host = $('apPolicies');
  if (!state.autopilot.policies) host.innerHTML = `<div class="muted">Loading policies…</div>`;
  try {
    const [policies, runs] = await Promise.all([
      api('/api/autopilot/policies'),
      api('/api/autopilot/runs?limit=30'),
    ]);
    state.autopilot.policies = policies.policies;
    state.autopilot.runs = runs.runs;
  } catch (e) {
    host.innerHTML =
      `<div class="muted">Couldn’t load Autopilot: ${escapeHtml(e.message)}</div>` +
      `<button class="pill" id="apRetry" style="margin-top:8px;">Try again</button>`;
    $('apRetry').addEventListener('click', () => loadAutopilot());
    $('apRuns').innerHTML = '';
    // FX: a failed load can honestly claim nothing about armed policies.
    fxApBreatheSync(false);
    return;
  }
  renderAutopilot();
}

function renderAutopilot() {
  const policies = state.autopilot.policies || [];
  const runs = state.autopilot.runs || [];
  const host = $('apPolicies');

  // FX: the heartbeat is a strict function of the armed set — the same
  // enabled && approved && !dryRunFirst predicate the info line counts as
  // "actively cleaning up". Every render re-derives it, so a policy edit,
  // delete or approve flips the orb through this one funnel.
  fxApBreatheSync(policies.some(p => p.enabled && p.approvedAt && !p.dryRunFirst));

  if (!policies.length) {
    $('apInfo').textContent = '';
    host.innerHTML =
      `<div class="muted" style="line-height:1.6;">No policies yet. A policy is a standing instruction — ` +
      `"clear old build folders in my Projects folder", say — that TreeMap carries out on its own.<br>` +
      `<b>Nothing is ever deleted on the first run:</b> you always see exactly what it matched and approve it first, ` +
      `and everything it removes is copied to the Time Capsule so you can undo it.</div>`;
  } else {
    const live = policies.filter(p => p.enabled && p.approvedAt && !p.dryRunFirst).length;
    $('apInfo').innerHTML =
      `<span class="num">${formatCount(policies.length)}</span> polic${policies.length === 1 ? 'y' : 'ies'} — ` +
      `<span class="num">${formatCount(live)}</span> actively cleaning up, the rest previewing or off.`;

    host.innerHTML = policies.map(p => {
      const needsApproval = !p.approvedAt;
      const stateLabel = !p.enabled ? 'Off'
        : needsApproval ? 'Waiting for your approval'
        : p.dryRunFirst ? 'Preview only'
        : `Every ${p.cooldownDays} day${p.cooldownDays === 1 ? '' : 's'}`;
      const limits = [
        p.maxBytesPerRun ? `${formatBytes(p.maxBytesPerRun)} per run` : null,
        p.maxBytesPerWeek ? `${formatBytes(p.maxBytesPerWeek)} per week` : null,
        p.requireConfirmationAbove ? `asks above ${formatBytes(p.requireConfirmationAbove)}` : null,
      ].filter(Boolean).join(' · ');
      return `
      <div class="bp-item ap-policy${p.enabled ? '' : ' ap-off'}">
        <span class="chip" style="--tint:${needsApproval ? '#FF9F0A' : p.enabled ? '#30D158' : '#8E8E93'}">${icon('sparkles', 15)}</span>
        <div class="meta" style="flex:1;min-width:0;">
          <div class="nm">${escapeHtml(p.name)}</div>
          <div class="pth" title="${escapeHtml(p.path)}">${escapeHtml(p.path)} · ${escapeHtml(describeMatch(p.match))}</div>
          <div class="why">${escapeHtml(stateLabel)}${limits ? ' · ' + escapeHtml(limits) : ''}</div>
        </div>
        <button class="pill" data-ap-edit="${escapeHtml(p.id)}">Edit</button>
        <button class="icon-btn" data-ap-delete="${escapeHtml(p.id)}" title="Remove this policy" aria-label="Remove the policy ${escapeHtml(p.name)}">${icon('trash', 13)}</button>
      </div>`;
    }).join('');

    host.querySelectorAll('[data-ap-edit]').forEach(b =>
      b.addEventListener('click', () => openPolicyEditor(policies.find(p => p.id === b.dataset.apEdit))));
    host.querySelectorAll('[data-ap-delete]').forEach(b =>
      b.addEventListener('click', () => deletePolicy(b.dataset.apDelete)));
  }

  renderAutopilotRuns(runs);
}

function describeMatch(match) {
  if (!match) return '';
  if (match.kind === 'suggestion') {
    return `${match.groupIds.length} kind${match.groupIds.length === 1 ? '' : 's'} of reclaimable file`;
  }
  // v4 §4.5 — a query policy shows the query itself. The caller escapes; what
  // matters here is that the standing instruction is legible at a glance
  // rather than summarised into something that might not mean the same thing.
  if (match.kind === 'query') return `files matching ${match.q}`;
  const parts = [];
  if (match.minBytes) parts.push(`over ${formatBytes(match.minBytes)}`);
  if (match.maxAgeMs) parts.push(`older than ${Math.round(match.maxAgeMs / 86400000)}d`);
  if (match.exts?.length) parts.push(match.exts.map(e => '.' + e).join('/'));
  return parts.join(', ');
}

function renderAutopilotRuns(runs) {
  const host = $('apRuns');
  if (!runs.length) {
    host.innerHTML = `<div class="muted">Nothing has run yet. Each run will be listed here with exactly what it removed — or why it decided not to.</div>`;
    return;
  }
  host.innerHTML = runs.map(r => {
    const needsApproval = r.status === 'awaiting-approval';
    const tint = needsApproval ? '#FF9F0A' : r.status === 'completed' && r.bytesDeleted > 0 ? '#30D158'
      : r.status === 'failed' ? '#FF453A' : '#8E8E93';
    const headline = r.bytesDeleted > 0
      ? `Removed ${formatBytes(r.bytesDeleted)} across ${formatCount(r.items.length)} item${r.items.length === 1 ? '' : 's'}`
      : r.mode === 'dry-run'
        ? `Would remove ${formatBytes(r.bytesMatched)} across ${formatCount(r.items.length)} item${r.items.length === 1 ? '' : 's'}`
        : 'Removed nothing';
    const items = r.items.slice(0, 8).map(i => `
      <div class="ap-run-item">
        <span class="nm" title="${escapeHtml(i.path)}">${escapeHtml(i.name)}</span>
        <span class="why">${escapeHtml(i.reason)}</span>
        <b class="num">${formatBytes(i.bytes)}</b>
      </div>`).join('');
    const more = r.items.length > 8 ? `<div class="muted" style="font-size:11px;padding:2px 0 0 10px;">…and ${formatCount(r.items.length - 8)} more</div>` : '';
    const skipped = r.skipped.length ? `
      <div class="ap-skipped">${icon('alert', 12)} <span>${escapeHtml(r.skipped[0].reason)}${r.skipped.length > 1 ? ` (and ${formatCount(r.skipped.length - 1)} more left alone)` : ''}</span></div>` : '';

    return `
    <div class="bp-acc ap-run" data-run="${escapeHtml(r.id)}">
      <div class="bp-head" role="button" tabindex="0" aria-expanded="false">
        <span class="chip" style="--tint:${tint}">${icon(needsApproval ? 'alert' : 'clock', 15)}</span>
        <span class="bp-title">${escapeHtml(r.policyName)}<span class="prof">${formatDate(r.at)} · ${escapeHtml(AP_STATUS_LABEL[r.status] || r.status)}${r.undoneAt ? ' · undone' : ''}</span></span>
        <span class="spacer"></span>
        <span class="size-badge num">${headline}</span>
        <span class="chev">${icon('chevronRight', 14)}</span>
      </div>
      <div class="bp-items">
        ${r.blockedReason ? `<div class="ap-reason">${escapeHtml(r.blockedReason)}</div>` : ''}
        ${items || '<div class="muted" style="padding:4px 10px;">Nothing matched.</div>'}
        ${more}${skipped}
        <div class="ap-run-actions">
          ${needsApproval ? `<button class="btn btn-primary" data-ap-approve="${escapeHtml(r.policyId)}"><span data-icon="check"></span>Approve this policy</button>` : ''}
          ${r.bytesDeleted > 0 && !r.undoneAt ? `<button class="btn" data-ap-undo="${escapeHtml(r.id)}"><span data-icon="refresh"></span>Undo this run</button>` : ''}
        </div>
      </div>
    </div>`;
  }).join('');

  host.querySelectorAll('.ap-run .bp-head').forEach(head => {
    const toggle = () => { const a = head.closest('.bp-acc'); head.setAttribute('aria-expanded', String(a.classList.toggle('open'))); };
    head.addEventListener('click', (e) => { if (e.target.closest('button')) return; toggle(); });
    head.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
  });
  // Anything needing a decision opens itself — a run that is waiting on the
  // user is useless folded away.
  host.querySelectorAll('.ap-run').forEach(a => {
    if (a.querySelector('[data-ap-approve]')) { a.classList.add('open'); a.querySelector('.bp-head').setAttribute('aria-expanded', 'true'); }
  });
  host.querySelectorAll('[data-ap-approve]').forEach(b => b.addEventListener('click', () => approveAutopilotPolicy(b.dataset.apApprove)));
  host.querySelectorAll('[data-ap-undo]').forEach(b => b.addEventListener('click', () => undoAutopilotRun(b.dataset.apUndo)));
}

function approveAutopilotPolicy(policyId) {
  const policy = (state.autopilot.policies || []).find(p => p.id === policyId);
  onConfirmTrash = async () => {
    try {
      await api(`/api/autopilot/policies/${encodeURIComponent(policyId)}/approve`, { method: 'POST' });
      toast('Approved — it will run on its own from now on');
    } catch (e) {
      toast(e.message, 'error');
    }
    loadAutopilot();
  };
  $('confirmTitle').innerHTML = icon('check', 18) + 'Let this policy delete on its own?';
  $('confirmText').innerHTML =
    `<b>${escapeHtml(policy ? policy.name : 'This policy')}</b> will start removing what it matched, without asking again.` +
    `<br><span style="color:var(--text-3)">Everything it removes is copied to the Time Capsule first, and any run can be undone from here.</span>`;
  $('confirmModal').classList.add('open');
}

function undoAutopilotRun(runId) {
  api(`/api/autopilot/runs/${encodeURIComponent(runId)}/undo`, { method: 'POST' })
    .then(resp => {
      watchJob({
        title: 'Putting everything back…',
        icon: 'refresh',
        progressUrl: `/api/timecapsule/jobs/${resp.jobId}/progress`,
        cancelUrl: `/api/timecapsule/jobs/${resp.jobId}/cancel`,
        footNote: 'Every byte is checked against the fingerprint taken when it was protected.',
        cancelledMessage: 'Undo cancelled — nothing was left half-written',
        lostMessage: 'Lost the progress stream — reopen Autopilot for the result',
        onComplete: () => { toast('Everything from that run is back'); loadAutopilot(); },
        onSettled: () => loadAutopilot(),
      });
    })
    .catch(e => toast(e.message, 'error', 8000));
}

function deletePolicy(policyId) {
  const policies = (state.autopilot.policies || []).filter(p => p.id !== policyId);
  api('/api/autopilot/policies', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ policies }),
  }).then(() => { toast('Policy removed'); loadAutopilot(); })
    .catch(e => toast(e.message, 'error'));
}

/* ── The policy editor ── */

function openPolicyEditor(policy) {
  apDraft = policy ? { ...policy } : {
    name: '', path: state.system ? state.system.homeDir : '',
    match: { kind: 'suggestion', groupIds: [] },
    maxBytesPerRun: null, maxBytesPerWeek: null, requireConfirmationAbove: null,
    cooldownDays: 7, dryRunFirst: true, enabled: false,
  };
  // Keyed on the id, not on whether a draft was passed: v4 §4.5's promotion
  // hands this a fully-formed draft that has never been saved, and calling
  // that "Edit policy" tells the user they are changing something that exists.
  $('apModalTitle').innerHTML = icon('sparkles', 18) + (policy && policy.id ? 'Edit policy' : 'New policy');
  $('apName').value = apDraft.name || '';
  $('apPath').value = apDraft.path || '';
  $('apCooldown').value = apDraft.cooldownDays ?? 7;
  $('apMaxRun').value = apDraft.maxBytesPerRun ? (apDraft.maxBytesPerRun / GB).toFixed(2).replace(/\.?0+$/, '') : '';
  $('apMaxWeek').value = apDraft.maxBytesPerWeek ? (apDraft.maxBytesPerWeek / GB).toFixed(2).replace(/\.?0+$/, '') : '';
  $('apConfirmAbove').value = apDraft.requireConfirmationAbove ? (apDraft.requireConfirmationAbove / GB).toFixed(2).replace(/\.?0+$/, '') : '';
  $('apDryRunFirst').checked = apDraft.dryRunFirst !== false;
  $('apEnabled').checked = apDraft.enabled === true;
  $('apPreview').innerHTML = '';

  const kind = apDraft.match?.kind === 'custom' ? 'custom'
    : apDraft.match?.kind === 'query' ? 'query'
    : 'suggestion';
  setApMatchKind(kind);
  $('apRuleQuery').value = kind === 'query' ? (apDraft.match.q || '') : '';
  $('apQueryStatus').textContent = '';
  if (kind === 'query') void validateApQuery();
  if (kind === 'custom') {
    const m = apDraft.match;
    $('apRuleAgeOn').checked = m.maxAgeMs !== undefined;
    if (m.maxAgeMs) $('apRuleAgeDays').value = Math.round(m.maxAgeMs / 86400000);
    $('apRuleSizeOn').checked = m.minBytes !== undefined;
    if (m.minBytes) $('apRuleSizeMb').value = Math.round(m.minBytes / 1048576);
    $('apRuleExtOn').checked = Boolean(m.exts?.length);
    $('apRuleExts').value = (m.exts || []).join(', ');
  }
  renderApGroupList(kind === 'suggestion' ? (apDraft.match.groupIds || []) : []);
  $('apModal').classList.add('open');
}

/**
 * The reclaimable kinds a policy can target.
 *
 * Deliberately a fixed, readable list rather than whatever the last scan
 * happened to find: a policy has to be writable before any scan exists, and a
 * list that changed shape depending on recent activity would make the same
 * policy mean different things on different days.
 */
const AP_GROUPS = [
  { id: 'regen-node-modules', label: 'node_modules folders', hint: 'JavaScript dependencies — npm install restores them' },
  { id: 'regen-python-venv', label: 'Python virtualenvs', hint: 'Recreate from the project manifest' },
  { id: 'regen-rust-target', label: 'Rust target folders', hint: 'cargo build restores them' },
  { id: 'regen-build-output', label: 'Web build output', hint: 'dist, build — your build command restores them' },
  { id: 'cache-general', label: 'Application caches', hint: 'Rebuilt automatically as you use each app' },
  { id: 'junk-general', label: 'Junk files', hint: '.DS_Store, Thumbs.db and friends' },
];

function renderApGroupList(selected) {
  const chosen = new Set(selected);
  $('apGroupList').innerHTML = AP_GROUPS.map(g => `
    <div class="rule-row">
      <input type="checkbox" id="apg-${escapeHtml(g.id)}" data-ap-group="${escapeHtml(g.id)}"${chosen.has(g.id) ? ' checked' : ''}>
      <label for="apg-${escapeHtml(g.id)}">${escapeHtml(g.label)} <span class="muted">— ${escapeHtml(g.hint)}</span></label>
    </div>`).join('');
}

function setApMatchKind(kind) {
  $('apMatchSuggestion').style.display = kind === 'suggestion' ? '' : 'none';
  $('apMatchCustom').style.display = kind === 'custom' ? '' : 'none';
  $('apMatchQuery').style.display = kind === 'query' ? '' : 'none';
  document.querySelectorAll('#apMatchSeg button').forEach(b =>
    b.setAttribute('aria-selected', String(b.dataset.apmatch === kind)));
}

/**
 * Live parse feedback for a policy's query (v4 §4.5).
 *
 * Through `POST /api/query/validate`, the parse-only endpoint — the same one
 * the treemap box uses, and for the same reason: §7 forbids a second query
 * language, and a client-side check here would be one. The server refuses an
 * unparseable query on save regardless; this only decides when the user finds
 * out.
 */
let apQuerySeq = 0;
async function validateApQuery() {
  const q = $('apRuleQuery').value.trim();
  const status = $('apQueryStatus');
  const seq = ++apQuerySeq;
  if (!q) { status.textContent = 'A policy needs a query to match on.'; status.classList.add('bad'); return; }
  try {
    await api('/api/query/validate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q }),
    });
    if (seq !== apQuerySeq) return;
    status.textContent = 'That query is understood.';
    status.classList.remove('bad');
  } catch (e) {
    if (seq !== apQuerySeq) return;
    const where = typeof e.offset === 'number' ? ` (at character ${e.offset + 1})` : '';
    status.textContent = (e.message || 'That query could not be understood.') + where;
    status.classList.add('bad');
  }
}
let apQueryDeb = 0;
$('apRuleQuery').addEventListener('input', () => {
  clearTimeout(apQueryDeb);
  apQueryDeb = setTimeout(() => { void validateApQuery(); }, 150);
});

/** Read the dialog back into the wire shape the API validates. */
function policyFromEditor() {
  const kind = document.querySelector('#apMatchSeg button[aria-selected="true"]').dataset.apmatch;
  let match;
  if (kind === 'suggestion') {
    match = { kind: 'suggestion', groupIds: [...document.querySelectorAll('[data-ap-group]')].filter(c => c.checked).map(c => c.dataset.apGroup) };
  } else if (kind === 'query') {
    // Sent as typed. The server parses it and refuses both an unparseable
    // query and one with no conditions — which would select every file under
    // the policy's folder, unattended.
    match = { kind: 'query', q: $('apRuleQuery').value.trim() };
  } else {
    match = { kind: 'custom' };
    if ($('apRuleAgeOn').checked) match.maxAgeMs = Math.max(1, Number($('apRuleAgeDays').value) || 180) * 86400000;
    if ($('apRuleSizeOn').checked) match.minBytes = Math.max(1, Number($('apRuleSizeMb').value) || 100) * 1048576;
    if ($('apRuleExtOn').checked) match.exts = $('apRuleExts').value.split(',').map(s => s.trim()).filter(Boolean);
  }
  const gb = (id) => { const n = Number($(id).value); return Number.isFinite(n) && n > 0 ? Math.round(n * GB) : null; };
  return {
    ...(apDraft && apDraft.id ? { id: apDraft.id } : {}),
    name: $('apName').value.trim() || 'Untitled policy',
    path: $('apPath').value.trim(),
    match,
    maxBytesPerRun: gb('apMaxRun'),
    maxBytesPerWeek: gb('apMaxWeek'),
    requireConfirmationAbove: gb('apConfirmAbove'),
    cooldownDays: Math.min(365, Math.max(1, Math.round(Number($('apCooldown').value) || 7))),
    dryRunFirst: $('apDryRunFirst').checked,
    enabled: $('apEnabled').checked,
  };
}

document.querySelectorAll('#apMatchSeg button').forEach(b =>
  b.addEventListener('click', () => setApMatchKind(b.dataset.apmatch)));
$('apAddBtn').addEventListener('click', () => openPolicyEditor(null));
$('apBrowseBtn').addEventListener('click', () =>
  openBrowse($('apPath').value.trim() || null, (picked) => { $('apPath').value = picked; }, 'Folder this policy cleans'));

$('apPreviewBtn').addEventListener('click', async () => {
  const host = $('apPreview');
  // FX: the "working" orb lives exactly as long as the simulate round-trip;
  // the finally below destroys it on every exit, the error paths included.
  host.innerHTML = `<div class="muted" style="margin-top:14px;display:flex;align-items:center;gap:8px;"><span class="fx-orb-well"></span>Checking what this would delete…</div>`;
  fxOrbShow('ap', host.querySelector('.fx-orb-well'), 'working');
  try {
    const result = await api('/api/autopilot/simulate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ policy: policyFromEditor() }),
    });
    const rows = result.items.slice(0, 12).map(i => `
      <div class="ap-run-item"><span class="nm" title="${escapeHtml(i.path)}">${escapeHtml(i.name)}</span>
      <span class="why">${escapeHtml(i.reason)}</span><b class="num">${formatBytes(i.bytes)}</b></div>`).join('');
    host.innerHTML =
      `<div class="set-h" style="margin-top:18px;">${icon('search', 14)}What this would delete</div>` +
      `<div class="ap-preview-head num">${formatBytes(result.bytesWouldDelete)} across ${formatCount(result.items.length)} item${result.items.length === 1 ? '' : 's'}` +
      (result.capBytes !== null ? ` <span class="muted">(limit ${formatBytes(result.capBytes)})</span>` : '') + `</div>` +
      (result.wouldBlockReason ? `<div class="ap-reason">${escapeHtml(result.wouldBlockReason)}</div>` : '') +
      (rows || `<div class="muted" style="padding:4px 0;">Nothing matches right now.</div>`) +
      (result.items.length > 12 ? `<div class="muted" style="font-size:11px;padding-left:10px;">…and ${formatCount(result.items.length - 12)} more</div>` : '') +
      (result.skipped.length ? `<div class="ap-skipped">${icon('alert', 12)} <span>${escapeHtml(result.skipped[0].reason)}</span></div>` : '');
  } catch (e) {
    host.innerHTML = `<div class="ap-reason">${escapeHtml(e.message)}</div>`;
  } finally {
    fxOrbHide('ap');
  }
});

$('apSaveBtn').addEventListener('click', async () => {
  const edited = policyFromEditor();
  const others = (state.autopilot.policies || []).filter(p => p.id !== edited.id);
  try {
    await api('/api/autopilot/policies', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ policies: [...others, edited] }),
    });
    closeModal('apModal');
    toast(edited.enabled ? 'Policy saved — its first run will show you what it matched before deleting anything' : 'Policy saved');
    loadAutopilot();
  } catch (e) {
    toast(e.message, 'error', 8000);
  }
});

registerView({
  id: 'autopilot',
  label: 'Autopilot',
  icon: 'sparkles',
  // Policies and run history are persisted, so this works with no scan loaded.
  needsScan: false,
  mount() { loadAutopilot(); },
  // FX: the heartbeat dies with the view — the per-orb offscreen pause is a
  // cost guard, not a teardown, and a mount must never outlive its owner.
  unmount() { fxApBreatheSync(false); },
});

/* ───────────────────────────── Trash (confirm + execute) ───────────────────────────── */
let confirmPaths = [];
let onConfirmTrash = null; // optional callback override for the shared confirm modal (used by the cart)
async function confirmTrash(paths) {
  if (!paths.length) return;
  onConfirmTrash = null;
  confirmPaths = paths;
  // Reset the B2 panel before anything can return early below — otherwise a
  // previous dialog's warning, and its "Delete anyway" button, would still be
  // sitting there for an unrelated set of files.
  resetOpenHandleWarning();
  // These sizes are what the user is told they're freeing, so they must be
  // real: a pruned-away node read as 0 would understate the total.
  await ensureNodes(paths);
  const total = paths.reduce((s, p) => s + (nodeFor(p)?.size ?? 0), 0);
  const first = nodeFor(paths[0]);
  // Cloud scans: deletes go to the provider's own trash, never the local one.
  if (paths[0].startsWith('cloud://')) {
    const provider = cloudProviderOfScan();
    $('confirmTitle').innerHTML = icon('trash', 18) + `Move to ${escapeHtml(provider.name)}'s trash?`;
    $('confirmText').innerHTML = (paths.length === 1
      ? `Move <b>${escapeHtml(first ? first.name : paths[0])}</b> (${formatBytes(total)}) to ${escapeHtml(provider.trashLabel)}?`
      : `Move <b>${paths.length} items</b> (${formatBytes(total)} total) to ${escapeHtml(provider.trashLabel)}?`) +
      `<br><span style="color:var(--text-3)">Restore any time from the provider's own trash.</span>`;
    onConfirmTrash = () => cloudTrashPaths(paths);
    $('confirmModal').classList.add('open');
    return;
  }
  $('confirmTitle').innerHTML = icon('trash', 18) + 'Move to Trash?';
  $('confirmText').innerHTML = paths.length === 1
    ? `Move <b>${escapeHtml(first ? first.name : paths[0])}</b> (${formatBytes(total)}) to the Trash?<br><span style="color:var(--text-3)">You can restore it from the Trash at any time.</span>`
    : `Move <b>${paths.length} items</b> (${formatBytes(total)} total) to the Trash?<br><span style="color:var(--text-3)">You can restore them from the Trash at any time.</span>`;
  $('confirmModal').classList.add('open');
  void checkOpenHandlesFor(paths);
}
