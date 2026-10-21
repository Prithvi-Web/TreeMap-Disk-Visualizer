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
// Byte limits are typed in GB and size rules in MB: the page's decimal units (KB, MB, GB in 000-prelude).

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
    // The ids a suggestion policy can name on this computer; null when the server could not read its
    // rule packs, and then no named id is judged (BQL-b1 review F3.1, F3.5).
    state.autopilot.knownGroupIds = Array.isArray(policies.knownGroupIds) ? policies.knownGroupIds : null;
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
      `and everything it removes is copied to the Undo Vault so you can undo it, until the Undo Vault removes the copy.</div>`;
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
    // Counted only where a rule here has the kind: an id an earlier build's editor offered and no pack
    // ever shipped matches nothing, so it is said apart (BQL-b1 review F3.1, F3.5).
    // Packs the server could not read: no id is a kind TreeMap has or lacks that it can name, and the card
    // says so rather than counting each as a kind of reclaimable file (BQR-1 item 17).
    if (!apKindsKnown()) {
      const named = match.groupIds.length;
      return `${named} kind${named === 1 ? '' : 's'} of file — ${apCannotTell(named)}`;
    }
    const gone = apUnknownKinds(match.groupIds);
    const n = match.groupIds.length - gone.length;
    const kinds = `${n} kind${n === 1 ? '' : 's'} of reclaimable file`;
    if (gone.length === 0) return kinds;
    const goneText = `${gone.length} kind${gone.length === 1 ? '' : 's'} of file TreeMap does not have — edit it and pick again`;
    return n === 0 ? `only ${goneText}` : `${kinds}, and ${goneText}`;
  }
  // v4 §4.5 — a query policy shows the query itself. The caller escapes; what
  // matters here is that the standing instruction is legible at a glance
  // rather than summarised into something that might not mean the same thing.
  if (match.kind === 'query') return `files matching ${match.q}`;
  const parts = [];
  if (match.minBytes) parts.push(`over ${formatBytes(match.minBytes)}`);
  if (match.maxAgeMs) parts.push(`older than ${ruleAgeText(match.maxAgeMs)}`);
  if (match.exts?.length) parts.push(match.exts.map(e => '.' + e).join('/'));
  return parts.join(', ');
}

/**
 * The runs whose Approve is offered (final review F1.7): each policy's newest
 * run, when it is awaiting approval and was made for the policy's folder and
 * match as they are now. Approval is bound to the run on the server too; an
 * older run's button approved whatever the policy had become since — a scope
 * edited after its preview, never previewed, due at once.
 */
function approvableRunIds(runs, policies) {
  const out = new Set();
  const newestOf = new Map();
  for (const r of runs) if (!newestOf.has(r.policyId)) newestOf.set(r.policyId, r);
  for (const p of policies) {
    const r = newestOf.get(p.id);
    if (r && r.status === 'awaiting-approval' && r.scope && r.scope.path === p.path &&
        JSON.stringify(r.scope.match) === JSON.stringify(p.match)) out.add(r.id);
  }
  return out;
}

/**
 * Why a run awaiting approval offers no Approve, and what comes next — as the
 * server schedules it (final review F2.1, F2.3). A newer run of the policy is
 * named only when it can be approved. A policy not yet approved previews what
 * it matches now at the scheduler's next check, which passes over a policy
 * switched off; an approved one is never brought forward, and looks afresh at
 * its next scheduled run.
 */
function unapprovableRunNote(r, runs, policies, approvable) {
  const newest = runs.find(x => x.policyId === r.policyId);
  if (newest !== r) {
    const why = r.scope ? 'This policy has changed since this run, or ran again, so this is not what it would do now'
      : 'Recorded by an earlier version of TreeMap, so it cannot be approved';
    return why + (newest && approvable.has(newest.id) ? ' — approve its newest run.' : '.');
  }
  const why = r.scope ? 'This policy has changed since this run, so this is not what it would do now'
    : 'Recorded by an earlier version of TreeMap, so it cannot be approved';
  const policy = policies.find(p => p.id === r.policyId);
  if (!policy) return why + '.';
  if (!policy.approvedAt) {
    return `${why} — it previews what it matches now ${policy.enabled ? 'at its next check' : 'once it is switched on'}; approve that run.`;
  }
  const days = policy.cooldownDays;
  return `${why}. It is not previewed again: its next scheduled run looks afresh — it runs every ${days} day${days === 1 ? '' : 's'}` +
    `${policy.enabled ? '' : ' once it is switched on'} — and if that run asks first too, approve it there.`;
}

/**
 * A rule's age as the card states it, exactly: whole days as "180d", and anything else in the whole
 * days, hours, minutes, seconds and milliseconds it adds up to — 36 hours is "1d 12h", never rounded
 * to "2d". The matcher compares milliseconds and this line is where a person checks what an
 * unattended deleter runs, so it may not describe a different rule. Minutes are "min": a query reads
 * "m" as months. The server's reason sentence (describeAge in autopilot.ts) states the same parts.
 */
function ruleAgeText(ms) {
  let rest = ms;
  const parts = [];
  for (const [size, unit] of [[86400000, 'd'], [3600000, 'h'], [60000, 'min'], [1000, 's'], [1, 'ms']]) {
    const n = size === 1 ? rest : Math.floor(rest / size);
    if (n > 0) parts.push(`${n}${unit}`);
    rest -= n * size;
  }
  return parts.join(' ');
}

/**
 * What a run or a Preview left alone: one line per reason, with how many items
 * it covers — never only the first reason beside "(and N more left alone)",
 * which hid every other reason from a run that left things alone for several
 * (review round 3, F3.6). Past five reasons the rest are counted.
 */
function leftAloneHtml(skipped) {
  const MAX_REASONS = 5;
  const counts = new Map();
  for (const s of skipped) counts.set(s.reason, (counts.get(s.reason) || 0) + 1);
  const shown = [...counts].slice(0, MAX_REASONS);
  const rest = skipped.length - shown.reduce((n, [, c]) => n + c, 0);
  return shown.map(([reason, n]) => `
      <div class="ap-skipped">${icon('alert', 12)} <span>${escapeHtml(reason)}${n > 1 ? ` (${formatCount(n)} items)` : ''}</span></div>`).join('') +
    (rest > 0 ? `<div class="ap-skipped"><span>…and ${formatCount(rest)} more left alone</span></div>` : '');
}

function renderAutopilotRuns(runs) {
  const host = $('apRuns');
  const policies = state.autopilot.policies || [];
  const approvable = approvableRunIds(runs, policies);
  if (!runs.length) {
    host.innerHTML = `<div class="muted">Nothing has run yet. Each run will be listed here with exactly what it removed — or why it decided not to.</div>`;
    return;
  }
  host.innerHTML = runs.map(r => {
    const needsApproval = r.status === 'awaiting-approval';
    const tint = needsApproval ? '#FF9F0A' : r.status === 'completed' && r.bytesDeleted > 0 ? '#30D158'
      : r.status === 'failed' ? '#FF453A' : '#8E8E93';
    // Items whose trash step was not confirmed either way: the Trash may have taken them, so their
    // copies were kept and the run's undo puts each back once its place is empty (FG3c).
    const unconfirmed = (r.unverified || []).length;
    const headline = r.bytesDeleted > 0
      ? `Removed ${formatBytes(r.bytesDeleted)} across ${formatCount(r.items.length)} item${r.items.length === 1 ? '' : 's'}`
      : r.mode === 'dry-run'
        ? `Would remove ${formatBytes(r.bytesMatched)} across ${formatCount(r.items.length)} item${r.items.length === 1 ? '' : 's'}`
        : unconfirmed > 0 ? 'Nothing confirmed as removed' : 'Removed nothing';
    const items = r.items.slice(0, 8).map(i => `
      <div class="ap-run-item">
        <span class="nm" title="${escapeHtml(i.path)}">${escapeHtml(i.name)}</span>
        <span class="why">${escapeHtml(i.reason)}</span>
        <b class="num">${formatBytes(i.bytes)}</b>
      </div>`).join('');
    const more = r.items.length > 8 ? `<div class="muted" style="font-size:11px;padding:2px 0 0 10px;">…and ${formatCount(r.items.length - 8)} more</div>` : '';
    const skipped = r.skipped.length ? leftAloneHtml(r.skipped) : '';

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
        ${items || (r.skipped.length ? '' : '<div class="muted" style="padding:4px 10px;">Nothing matched.</div>') /* what it left alone matched (review F1.2) */}
        ${more}${skipped}
        <div class="ap-run-actions">
          ${approvable.has(r.id) ? `<button class="btn btn-primary" data-ap-approve="${escapeHtml(r.id)}"><span data-icon="check"></span>Approve this run</button>`
            : needsApproval ? `<span class="muted">${unapprovableRunNote(r, runs, policies, approvable)}</span>` : ''}
          ${(r.bytesDeleted > 0 || unconfirmed > 0) && !r.undoneAt ? `<button class="btn" data-ap-undo="${escapeHtml(r.id)}"><span data-icon="refresh"></span>Undo this run</button>` : ''}
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
  host.querySelectorAll('[data-ap-approve]').forEach(b => b.addEventListener('click', () => approveAutopilotRun(b.dataset.apApprove)));
  host.querySelectorAll('[data-ap-undo]').forEach(b => b.addEventListener('click', () => undoAutopilotRun(b.dataset.apUndo)));
}

/**
 * Approve the run the person is looking at (final review F1.7, F1.10): the
 * server holds the approval to that run, and the confirm says what it covers —
 * the folder, what the policy matches there, and how much this run matched.
 * A first approval lets the policy delete on its own from then on; approving a
 * run held by "Ask me first above" lets its next run delete what it matched,
 * once, and a later bigger match asks again.
 */
function approveAutopilotRun(runId) {
  const run = (state.autopilot.runs || []).find(r => r.id === runId);
  const policy = run && (state.autopilot.policies || []).find(p => p.id === run.policyId);
  if (!run || !policy) return;
  const first = !policy.approvedAt;
  onConfirmTrash = async () => {
    try {
      await api(`/api/autopilot/policies/${encodeURIComponent(policy.id)}/approve`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ runId: run.id }),
      });
      toast(first ? 'Approved — it will run on its own from now on' : 'Approved — its next run removes what this one matched');
    } catch (e) {
      toast(e.message, 'error');
    }
    loadAutopilot();
  };
  const scope = `in <b>${escapeHtml(policy.path)}</b> (${escapeHtml(describeMatch(policy.match))})`;
  $('confirmTitle').innerHTML = icon('check', 18) + (first ? 'Let this policy delete on its own?' : 'Let its next run remove this much?');
  $('confirmText').innerHTML = (first
    ? `<b>${escapeHtml(policy.name)}</b> will start removing what it matches ${scope} on its own — ` +
      `<b>${formatBytes(run.bytesMatched)}</b> this time.` +
      (policy.requireConfirmationAbove
        ? ` A run that matches more than ${formatBytes(policy.requireConfirmationAbove)} still asks first` +
          (run.bytesMatched > policy.requireConfirmationAbove ? ' — except its next one, up to what this run matched.' : '.')
        : '')
    : `<b>${escapeHtml(policy.name)}</b>'s next run will remove what it matches ${scope}, up to <b>${formatBytes(run.bytesMatched)}</b>, once. ` +
      `A later run that matches more than ${formatBytes(policy.requireConfirmationAbove || 0)} asks again.`) +
    `<br><span style="color:var(--text-3)">Everything it removes is copied to the Undo Vault first, and a run can be undone from here until the Undo Vault removes its copies.</span>`;
  setConfirmButton('Approve', 'check');
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
        // Each one it passed over (its place is not empty yet) is named with what the disk showed of
        // it (FG3c, FG3d #7); the run keeps its Undo for them. And each item whose copy is gone,
        // which no undo can put back (FG3f #3): then not everything from that run is back.
        // And no green "everything is back" beside a warning the dialog shows (FG3g L9).
        onComplete: (ev) => {
          const left = [...(resp.passedOver || []), ...(resp.unrestorable || [])];
          if (left.length) toast(passedOverToast(resp.entryCount, left), 'error', 12000);
          else if (!ev || !ev.warning) toast('Everything from that run is back');
          loadAutopilot();
        },
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
  // Each limit as its exact figure, never rounded: Save reads these boxes back,
  // so "5.37" for a 5 GiB cap an earlier TreeMap stored (5,368,709,120 bytes)
  // would rewrite it to 5,370,000,000 (review F1.1). It shows as 5.36870912.
  $('apMaxRun').value = apDraft.maxBytesPerRun ? String(apDraft.maxBytesPerRun / GB) : '';
  $('apMaxWeek').value = apDraft.maxBytesPerWeek ? String(apDraft.maxBytesPerWeek / GB) : '';
  $('apConfirmAbove').value = apDraft.requireConfirmationAbove ? String(apDraft.requireConfirmationAbove / GB) : '';
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
  // Every custom-rule control starts from the markup's own default on every
  // open, and only then takes what the policy stored. Painted for a custom
  // policy alone, a figure from the previous open stayed in its box: a 0.5 MB
  // rule left "0.5" there for the next policy, whose Save held it to the 1 MB
  // floor — the box said one figure and the standing rule became another
  // (review F3.1). A figure now reaches Save only if the person typed it or
  // the policy being edited stored it.
  for (const id of ['apRuleAgeOn', 'apRuleSizeOn', 'apRuleExtOn']) $(id).checked = $(id).defaultChecked;
  for (const id of ['apRuleAgeDays', 'apRuleSizeMb', 'apRuleExts']) $(id).value = $(id).defaultValue;
  if (kind === 'custom') {
    const m = apDraft.match;
    $('apRuleAgeOn').checked = m.maxAgeMs !== undefined;
    if (m.maxAgeMs) $('apRuleAgeDays').value = m.maxAgeMs / 86400000; // exact: 36 hours is 1.5, never rounded to 2
    $('apRuleSizeOn').checked = m.minBytes !== undefined;
    if (m.minBytes) $('apRuleSizeMb').value = m.minBytes / MB; // exact, as the limits above
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
 *
 * Each id is a rule id the packs ship on every platform, none advice-only
 * (tests/autopilotAdvisory.test.ts): the evaluator never matches an unknown
 * one, and three boxes that named none - regen-build-output, cache-general,
 * junk-general - made policies that matched nothing (BQL-b1 review F2.6).
 * "Web build output" is the framework folders and dist beside a JavaScript
 * project file; build-output, a folder named build, dist or target with no
 * project beside it to say what rebuilds it, is not offered for unattended runs.
 * A policy saved with one of those three, or with any id these boxes do not
 * show, keeps it while unchanged; its card and editor say so (describeMatch,
 * renderApGroupList), and the server refuses a new one (POLICY_MATCH_UNKNOWN).
 */
const AP_GROUPS = [
  { id: 'regen-node-modules', label: 'node_modules folders', hint: 'JavaScript dependencies — npm install restores them' },
  { id: 'regen-python-venv', label: 'Python virtualenvs', hint: 'Python can make one again; the packages in it must be reinstalled' },
  { id: 'regen-rust-target', label: 'Rust target folders', hint: 'cargo build restores them' },
  { id: 'regen-web-build', label: 'Web build output', hint: '.next, .nuxt and the like, and dist beside a JavaScript project — npm run build restores them' },
  { id: 'browser-caches', label: 'Browser caches', hint: 'Pages reload a bit slower once' },
  { id: 'dev-caches', label: 'Developer caches', hint: 'Package-manager and tool caches, and Xcode\'s on a Mac — rebuilt when next used' },
  { id: 'tool-caches', label: 'Tool caches', hint: '.pytest_cache, .mypy_cache and the like — rebuilt automatically when needed' },
  { id: 'os-junk', label: 'Junk files', hint: '.DS_Store, Thumbs.db and desktop.ini — the system makes them again' },
];

/**
 * The ids a suggestion policy names that no rule on this computer has, by the server's own list
 * (`knownGroupIds`); none when it could not say, so nothing is judged (BQL-b1 review F3.1, F3.5).
 */
function apUnknownKinds(ids) {
  const known = state.autopilot && state.autopilot.knownGroupIds;
  return Array.isArray(known) ? ids.filter(id => !known.includes(id)) : [];
}

/** Whether the server said which kinds the rule packs here have (null when it could not read them). */
function apKindsKnown() {
  return Array.isArray(state.autopilot && state.autopilot.knownGroupIds);
}

/** What the card and the editor say of `n` named kinds while the rule packs cannot be read (BQR-1 item 17). */
function apCannotTell(n) {
  return `TreeMap could not read its rule packs, so it cannot tell ${n === 1 ? 'whether it has it' : 'which of them it has'}`;
}

/** "a kind of file", "2 kinds of file". */
function apKinds(n) {
  return n === 1 ? 'a kind of file' : `${n} kinds of file`;
}

function renderApGroupList(selected) {
  const chosen = new Set(selected);
  // What the boxes cannot show, said above them, so a policy an earlier build saved does not open with
  // nothing ticked and no word why, and Save's refusal of an empty list does not come out of nowhere
  // (BQL-b1 review F3.5): ids no rule has, and kinds TreeMap has that these boxes do not offer.
  const unlisted = selected.filter(id => !AP_GROUPS.some(g => g.id === id));
  const gone = apUnknownKinds(unlisted);
  const other = unlisted.filter(id => !gone.includes(id));
  const parts = [
    gone.length ? `${apKinds(gone.length)} TreeMap does not have (${gone.join(', ')}), which ${gone.length === 1 ? 'matches' : 'match'} nothing` : null,
    other.length ? `${apKinds(other.length)} this list does not offer (${other.join(', ')})${apKindsKnown() ? '' : `, and ${apCannotTell(other.length)}`}` : null,
  ].filter(Boolean);
  const note = parts.length
    ? `<div class="muted" style="margin:0 0 8px;line-height:1.5;">This policy names ${escapeHtml(parts.join(', and '))}. Saving keeps only the kinds ticked below.</div>`
    : '';
  $('apGroupList').innerHTML = note + AP_GROUPS.map(g => `
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
    if ($('apRuleSizeOn').checked) {
      // A rule the box still shows as it was opened keeps its stored bytes —
      // one under 1 MB too, which the policy API accepts (500,000 opens as
      // "0.5"). Only a figure a person typed is held to the box's 1 MB floor,
      // so Save never rewrites a rule nobody edited (review F2.3).
      const opened = apDraft?.match?.minBytes;
      const typed = Number($('apRuleSizeMb').value);
      match.minBytes = opened > 0 && typed === opened / MB ? opened : Math.round(Math.max(1, typed || 100) * MB);
    }
    if ($('apRuleExtOn').checked) match.exts = $('apRuleExts').value.split(',').map(s => s.trim()).filter(Boolean);
    // An age rule the box still shows as it was opened keeps the milliseconds
    // the policy stored — a part of a day too (36 hours opens as "1.5"), and
    // one under the box's 1-day floor. Only a figure a person types is read as
    // days and held to that floor, so Save never rewrites a rule nobody edited
    // (the LEFT brief, item 6; as 8f54072 did for the size rule).
    const openedAge = apDraft && apDraft.match ? apDraft.match.maxAgeMs : undefined;
    if (match.maxAgeMs !== undefined && openedAge > 0 && Number($('apRuleAgeDays').value) === openedAge / 86400000) match.maxAgeMs = openedAge;
  }
  const gb = (id) => { const n = Number($(id).value); return Number.isFinite(n) && n > 0 ? Math.round(n * GB) : null; };
  return {
    ...(apDraft && apDraft.id ? { id: apDraft.id } : {}),
    name: $('apName').value.trim() || 'Untitled policy',
    // The folder exactly as the box holds it (asPath). Trimmed, a folder picked
    // as "Screenshots " was saved as its sibling "Screenshots", and the policy
    // would trash files there on schedule (review F2.1, QA4a R4-1).
    path: asPath($('apPath').value),
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
  openBrowse(asPath($('apPath').value) || null, (picked) => { $('apPath').value = picked; }, 'Folder this policy cleans'));

$('apPreviewBtn').addEventListener('click', async () => {
  const host = $('apPreview');
  // The draft as the editor holds it now — previewed, never saved.
  const draft = { policy: policyFromEditor() };
  // The editor this preview was asked in: closing it (apEditorClosed) or a
  // press of Save moves apSaveSeq on, and an offer made here then fills nothing.
  const seq = apSaveSeq;
  // FX: the "working" orb lives exactly as long as the simulate round-trip;
  // the finally below destroys it on every exit, the error paths included.
  host.innerHTML = `<div class="muted" style="margin-top:14px;display:flex;align-items:center;gap:8px;"><span class="fx-orb-well"></span>Checking what this would delete…</div>`;
  fxOrbShow('ap', host.querySelector('.fx-orb-well'), 'working');
  try {
    const result = await api('/api/autopilot/simulate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(draft),
    });
    const rows = result.items.slice(0, 12).map(i => `
      <div class="ap-run-item"><span class="nm" title="${escapeHtml(i.path)}">${escapeHtml(i.name)}</span>
      <span class="why">${escapeHtml(i.reason)}</span><b class="num">${formatBytes(i.bytes)}</b></div>`).join('');
    host.innerHTML =
      `<div class="set-h" style="margin-top:18px;">${icon('search', 14)}What this would delete</div>` +
      `<div class="ap-preview-head num">${formatBytes(result.bytesWouldDelete)} across ${formatCount(result.items.length)} item${result.items.length === 1 ? '' : 's'}` +
      (result.capBytes !== null ? ` <span class="muted">(limit ${formatBytes(result.capBytes)})</span>` : '') + `</div>` +
      (result.wouldBlockReason ? `<div class="ap-reason">${escapeHtml(result.wouldBlockReason)}</div>` : '') +
      // What it left alone matched: "Nothing matches" only when nothing was left alone, as the run list says it (review round 3, F3.7).
      (rows || `<div class="muted" style="padding:4px 0;">${result.skipped.length ? 'Everything that matches is left alone — nothing would be deleted.' : 'Nothing matches right now.'}</div>`) +
      (result.items.length > 12 ? `<div class="muted" style="font-size:11px;padding-left:10px;">…and ${formatCount(result.items.length - 12)} more</div>` : '') +
      (result.skipped.length ? leftAloneHtml(result.skipped) : '');
  } catch (e) {
    // A folder that names none, where the same path without the whitespace at
    // its end does: said in words, with that folder offered, as Save says it —
    // not a bare "Path does not exist" with the space invisible in it (final
    // review F1.6). Only offered into the editor it was asked in.
    const meant = await meantFolder(draft.policy.path, e);
    if (meant && seq === apSaveSeq) {
      host.innerHTML = `<div class="ap-reason">${escapeHtml(noFolderNamed(draft.policy.path))}</div>`;
      offerMeant(draft.policy.path, meant, () => { if (seq === apSaveSeq) $('apPath').value = meant; }, 'Use that folder', 'apModal');
    } else {
      host.innerHTML = `<div class="ap-reason">${escapeHtml(e.message)}</div>`;
    }
  } finally {
    fxOrbHide('ap');
  }
});

/** Each press of Save takes the next number, and the editor closing retires
    every press still looking up its folder (apEditorClosed). */
let apSaveSeq = 0;
/** The policy editor closed (closeModal): a Save still looking up its folder
    saves nothing, and the button it held is handed back for the next time the
    editor opens. */
function apEditorClosed() {
  apSaveSeq++;
  $('apSaveBtn').disabled = false;
  $('apSaveBtn').removeAttribute('aria-busy');
}
$('apSaveBtn').addEventListener('click', async () => {
  // Every field is read now, as the person pressed Save: what is saved is
  // what Save was pressed on (QA4a R4-3).
  const edited = policyFromEditor();
  // A folder that names none, where the same path without its trailing space
  // does, is not saved in its place: "no such folder", with that folder
  // offered, and a click puts it in the box for the person to save. The
  // policy's own stored folder is saved as stored, never looked up under
  // another name (QA4a R4-1).
  if (edited.path !== (apDraft && apDraft.path)) {
    const btn = $('apSaveBtn');
    const seq = ++apSaveSeq;
    // Held while the folder is looked up, at most PATH_LOOKUP_MS, and busy
    // while it is (final review F1.11).
    // Held, the button is disabled, and a browser hands focus from a disabled
    // control to <body>, where it stayed once the lookup ended: with the editor
    // still open — the save refused, the folder changed — the next Enter
    // reached nothing (as K02 found of Scan). It is given back as the button
    // is, unless the person moved it meanwhile or the button never had it.
    const heldFocus = document.activeElement === btn;
    btn.disabled = true;
    if (boxLooksUp(edited.path)) btn.setAttribute('aria-busy', 'true');
    let meant = null;
    try {
      meant = await boxMeant(edited.path);
    } finally {
      // Handed back by the press that holds it, however the lookup ended
      // (final review F1.5). The editor closed, or a newer press took over:
      // the button is not this press's to hand back, nor focus to give it.
      if (seq === apSaveSeq) {
        btn.disabled = false;
        btn.removeAttribute('aria-busy');
        if (heldFocus && (!document.activeElement || document.activeElement === document.body)) btn.focus({ preventScroll: true });
      }
    }
    // Nothing is saved for a closed editor, or in a newer press's place.
    if (seq !== apSaveSeq) return;
    // Another folder typed while this one was looked up: that one is the
    // next press's to save, and the person is told this one saved nothing.
    if (asPath($('apPath').value) !== edited.path) {
      toast('Nothing was saved — the folder changed while it was being checked. Press Save to save the folder in the box.', 'error');
      return;
    }
    if (meant) {
      // Only into the editor it was offered for, while no other press has come since.
      offerMeant(edited.path, meant, () => { if (seq === apSaveSeq) $('apPath').value = meant; }, 'Use that folder', 'apModal');
      return;
    }
  }
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
  icon: 'autopilot',
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

/** The paths with no ancestor also in the list — the cart's tmCartRoots rule,
    for any list. A folder and a file inside it are one set of bytes: the
    sheet's "(X total)" added the file again on top of the folder that
    already holds it. Separator-aware through tmParentPath, so "/r/AB" is not
    read as inside "/r/A". */
function outermostPaths(paths) {
  const listed = new Set(paths);
  return paths.filter((p) => {
    for (let dir = tmParentPath(p); dir; dir = tmParentPath(dir)) {
      if (listed.has(dir)) return false;
      if (dir === tmParentPath(dir)) break; // reached the filesystem root
    }
    return true;
  });
}

/* ── A part of an installed program (fifth browser pass F01) ──────────────────
   "Move to Trash" on Chrome's framework, WhatsApp's own executable or an
   app.asar is two clicks from breaking that app. Every Trash sheet says so
   before anyone confirms: which program, that it will stop working, and how
   to remove it whole. The answer is the server's one detector's — the one
   its dry-run manifests, Autopilot and the Security panel ask — never a
   second copy here. */

/** How many paths one installed-programs question carries: the route's own limit. */
const INSTALLED_PROGRAM_CHUNK = 2000;

/**
 * Which of `paths` are parts of an installed program, from
 * POST /api/files/installed-programs: [{ path, installedProgram }], or null
 * when the server could not be asked — which the sheet then admits.
 */
async function installedProgramParts(paths) {
  const parts = [];
  try {
    for (let i = 0; i < paths.length; i += INSTALLED_PROGRAM_CHUNK) {
      const answer = await api('/api/files/installed-programs', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paths: paths.slice(i, i + INSTALLED_PROGRAM_CHUNK) }),
      });
      parts.push(...(answer.parts || []));
    }
  } catch {
    return null;
  }
  return parts;
}

/** An installed program as the sheet names it: a program under Program Files by the folder it is installed in, which is often its maker's (review F1.11). */
function installedProgramWords(p) {
  if (p.kind === 'app') return `the app <b>${escapeHtml(p.name)}</b>`;
  if (p.kind === 'program') return `a program installed in <b>${escapeHtml(p.root)}</b>`;
  return 'the software your package manager installed in /usr';
}

/** How to remove these programs whole, never a part at a time. */
function installedProgramRemoval(programs) {
  const only = programs.length === 1 ? programs[0] : null;
  if (only && only.kind === 'app') return `To remove <b>${escapeHtml(only.name)}</b>, move the whole app to the Trash instead.`;
  // Settings › Apps lists the program by its own name, which the folder may not be: no entry is named.
  if (only && only.kind === 'program') return 'To remove that program, uninstall it in Windows Settings › Apps instead.';
  const advice = {
    app: 'To remove an app, move the whole app to the Trash instead.',
    program: 'To remove a program, uninstall it in Windows Settings › Apps instead.',
    package: 'To remove software your package manager installed, uninstall its package with the package manager instead.',
  };
  return [...new Set(programs.map((p) => p.kind))].map((kind) => advice[kind]).join(' ');
}

/**
 * What a Trash sheet says when some of the `count` items it moves are parts of
 * an installed program: '' when none is, and a plain admission when the
 * server could not be asked (`parts` null) — silence would read as "none is".
 * `doing(n)` says what the sheet does to them: a move to the Trash, unless
 * the sheet is a re-encode's, which replaces them (review F1.4).
 */
function installedProgramWarningHtml(parts, count, doing) {
  if (parts === null) {
    return `<div class="app-part-warn">${icon('alert', 14)}<span>TreeMap couldn’t check whether ${count === 1 ? 'this is' : 'any of these is'} part of an installed app.</span></div>`;
  }
  if (!parts.length) return '';
  const programs = [...new Map(parts.map((p) => [p.installedProgram.root, p.installedProgram])).values()];
  const n = parts.length;
  const who = count === 1 ? 'It is part' : `${formatCount(n)} of these ${n === 1 ? 'is part' : 'are parts'}`;
  const where = programs.length === 1
    ? installedProgramWords(programs[0])
    : `${formatCount(programs.length)} installed programs — ${programs.slice(0, 3).map(installedProgramWords).join(', ')}` +
      (programs.length > 3 ? ` and ${formatCount(programs.length - 3)} more` : '');
  const only = programs.length === 1 ? programs[0] : null;
  const breaks = only && only.kind === 'app' ? `will stop <b>${escapeHtml(only.name)}</b> from working`
    : only && only.kind === 'program' ? 'will stop that program from working'
      : `can stop ${only ? 'programs that use it' : 'those programs'} from working`;
  return `<div class="app-part-warn">${icon('alert', 14)}<span><b>${who} of ${where}.</b> ` +
    `${doing ? doing(n) : `Moving ${n === 1 ? 'it' : 'them'} to the Trash`} ${breaks}. ${installedProgramRemoval(programs)}</span></div>`;
}

async function confirmTrash(paths) {
  if (!paths.length) return;
  onConfirmTrash = null;
  confirmPaths = paths;
  // Reset the B2 panel before anything can return early below — otherwise a
  // previous dialog's warning, and its "Move to Trash anyway" button, would still be
  // sitting there for an unrelated set of files.
  resetOpenHandleWarning();
  // These sizes are what the user is told they're freeing, so they must be
  // real: a pruned-away node read as 0 would understate the total. Beside
  // them, which paths are parts of an installed program (F01): asked BEFORE
  // the sheet opens, so the warning is there when it is read — never painted
  // in after OK could already have been pressed. The answer reads the paths
  // alone, nothing on the disk, so it costs the sheet no more than its sizes;
  // the slow open-file check still fills in behind the open sheet. A cloud
  // account's files are on no computer's disk: nothing to ask.
  const local = !paths[0].startsWith('cloud://');
  const [, parts] = await Promise.all([ensureNodes(paths), local ? installedProgramParts(paths) : []]);
  const total = outermostPaths(paths).reduce((s, p) => s + (nodeFor(p)?.size ?? 0), 0);
  const first = nodeFor(paths[0]);
  // Cloud scans: deletes go to the provider's own trash, never the local one.
  if (paths[0].startsWith('cloud://')) {
    const provider = cloudProviderOfScan();
    $('confirmTitle').innerHTML = icon('trash', 18) + `Move to ${escapeHtml(provider.name)}'s trash?`;
    $('confirmText').innerHTML = (paths.length === 1
      ? `Move <b>${escapeHtml(first ? first.name : paths[0])}</b> (${formatBytes(total)}) to ${escapeHtml(provider.trashLabel)}?`
      : `Move <b>${paths.length} items</b> (${formatBytes(total)} total) to ${escapeHtml(provider.trashLabel)}?`) +
      // Until it is emptied (D06): a provider empties its own trash after the time it keeps deleted files.
      `<br><span style="color:var(--text-3)">You can restore ${paths.length === 1 ? 'it' : 'them'} from there until it is emptied — by you, or by the provider after the time it keeps deleted files.</span>`;
    onConfirmTrash = () => cloudTrashPaths(paths);
    $('confirmModal').classList.add('open');
    return;
  }
  $('confirmTitle').innerHTML = icon('trash', 18) + 'Move to Trash?';
  $('confirmText').innerHTML = paths.length === 1
    ? `Move <b>${escapeHtml(first ? first.name : paths[0])}</b> (${formatBytes(total)}) to the Trash?<br><span style="color:var(--text-3)">You can put it back from the Trash until the Trash is emptied.</span>`
    : `Move <b>${paths.length} items</b> (${formatBytes(total)} total) to the Trash?<br><span style="color:var(--text-3)">You can put them back from the Trash until the Trash is emptied.</span>`;
  $('confirmText').innerHTML += installedProgramWarningHtml(parts, paths.length);
  $('confirmModal').classList.add('open');
  void checkOpenHandlesFor(paths);
}
