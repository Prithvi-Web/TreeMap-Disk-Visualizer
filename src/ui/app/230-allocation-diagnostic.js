/* ───────────────────── Allocation diagnostic (A2) ─────────────────────
   Shows the three numbers side by side: what a naive tool would report, what
   the files claim, and what they actually occupy — plus, when the scanned root
   is a whole disk, how TreeMap's total compares with the disk's own accounting.

   §A2 asks that this delta be visible ("should be near zero"). Making it
   visible rather than quietly correcting for it is the point: TreeMap cannot
   see which files share storage, and a panel that showed a confident total
   would be hiding exactly the uncertainty the user needs to know about. */
async function renderAllocationDiagnostic() {
  const host = $('allocationDiag');
  if (!host) return;
  const target = state.root && state.root.path;
  if (!target) { host.textContent = 'Scan a folder to see this.'; return; }

  host.innerHTML = '<span class="muted">Measuring…</span>';
  let a;
  try {
    a = await api('/api/allocation?path=' + encodeURIComponent(target));
  } catch (e) {
    // The most likely reason by far is simply that the index has not been
    // built yet — which is a state, not a failure, and says so.
    host.innerHTML = `<span class="muted">${escapeHtml(
      e.code === 'INDEX_NOT_BUILT'
        ? 'TreeMap is still building its index of this folder. Try again in a moment.'
        : e.message,
    )}</span>`;
    return;
  }

  const row = (label, value, hint) =>
    `<div class="row"><span>${escapeHtml(label)}${hint ? ` <span class="muted">— ${escapeHtml(hint)}</span>` : ''}</span><b>${formatBytes(value)}</b></div>`;

  let html =
    row('What other tools would report', a.naiveLogicalBytes, 'every file counted at the size it claims') +
    row('Size the files claim', a.logicalBytes, 'counting files with several names once') +
    row('Space actually used', a.allocatedBytes, 'what the disk really holds');

  if (a.sharedBytes > 0) {
    html += row('Of that, shared with other copies', a.sharedBytes, 'deleting one copy frees none of it');
  }
  if (a.hardlinkFamilies > 0) {
    html +=
      `<div class="row"><span>Files with more than one name</span><b>${formatCount(a.hardlinkFamilies)}</b></div>`;
  }

  if (a.reconciliation) {
    const r = a.reconciliation;
    html +=
      row('This disk reports as used', r.actualBytes, 'the disk’s own accounting') +
      `<div class="row"><span>Difference</span><b>${formatBytes(Math.abs(r.deltaBytes))} (${r.deltaPercent}%)</b></div>` +
      `<div class="note">${escapeHtml(r.verdict)}</div>`;
  } else {
    html +=
      `<div class="note">${escapeHtml(
        'Comparing against the disk’s own total only works when you scan a whole disk, so it isn’t shown for a folder.',
      )}</div>`;
  }

  html += `<div class="note">${escapeHtml(a.reason)}</div>`;
  host.innerHTML = html;
}

/* ── Fleet view (§D1) ──────────────────────────────────────────────────────
   The only feature that opens a network surface, so the panel leads with what
   would leave this machine and what never can — read from the SERVER, so the
   promise on screen and the code that keeps it cannot drift apart. Discovered
   machines are shown as "available to pair", never as connected. */
async function loadFleet() {
  const host = $('fleetBody');
  clearTimeout(state.fleet.timer);
  try { state.fleet.data = await api('/api/fleet'); }
  catch (e) { host.innerHTML = `<div class="muted">${escapeHtml(e.message)}</div>`; return; }
  renderFleet();
  // Discovery and peer liveness both move on their own; refresh gently while
  // the tab is open, and stop entirely on unmount.
  state.fleet.timer = setTimeout(() => { if (state.view === 'fleet') loadFleet(); }, 5000);
}

function renderFleet() {
  const f = state.fleet.data;
  const host = $('fleetBody');
  if (!f) return;

  const disclosure = `<div class="fleet-disclosure">
    <div class="fl-col"><b>${icon('checkCircle', 13)} What other machines would see</b><ul>${
      (f.shares || []).map(x => `<li>${escapeHtml(x)}</li>`).join('')}</ul></div>
    <div class="fl-col never"><b>${icon('ban', 13)} What they can never see</b><ul>${
      (f.neverShares || []).map(x => `<li>${escapeHtml(x)}</li>`).join('')}</ul></div>
  </div>`;

  if (!f.enabled) {
    host.innerHTML = disclosure +
      `<div class="fleet-off">
        <p>Seeing other TreeMaps on your network is <b>off</b>. Nothing is being shared, and this machine is not
        announcing itself to anything.</p>
        <button class="btn btn-primary" id="fleetOnBtn">${icon('globe', 14)} Turn on for this network</button>
      </div>`;
    $('fleetOnBtn').onclick = () => setFleet({ enabled: true });
    return;
  }

  const peers = (f.peers || []).map(p => {
    const s = p.summary;
    const pct = s && s.totalBytes ? Math.round((s.usedBytes / s.totalBytes) * 100) : null;
    return `<div class="fleet-peer${p.online ? '' : ' offline'}">
      <div class="fl-head">
        <b>${escapeHtml(p.label)}</b>
        <span class="fl-dot ${p.online ? 'on' : 'off'}" title="${p.online ? 'Seen just now' : 'Not seen recently'}"></span>
        <span class="muted num">${escapeHtml(p.address)}</span>
        <span style="flex:1"></span>
        <button class="pill" data-fleet-refresh="${escapeHtml(p.instanceId)}">Refresh</button>
        ${s && s.acceptsRemoteScan ? `<button class="pill" data-fleet-scan="${escapeHtml(p.instanceId)}">Scan a folder…</button>` : ''}
        <button class="icon-btn" data-fleet-forget="${escapeHtml(p.instanceId)}" title="Forget this machine">${icon('x', 13)}</button>
      </div>
      ${s ? `<div class="fl-bar"><div class="fill" style="width:${pct === null ? 0 : pct}%"></div></div>
        <div class="fl-facts num">${s.totalBytes !== null
          ? `${formatBytes(s.usedBytes)} used of ${formatBytes(s.totalBytes)} · ${formatBytes(s.freeBytes)} free`
          : 'disk figures unavailable'}${s.lastScanPath
          ? ` · last scanned ${escapeHtml(baseName(s.lastScanPath))} ${s.lastScanAt ? 'on ' + escapeHtml(formatDate(s.lastScanAt)) : ''}`
          : ' · no scan yet'}</div>`
        : `<div class="fl-facts muted">No summary yet — press Refresh to ask.</div>`}
    </div>`;
  }).join('');

  // §D1: an unpaired machine is "available to pair", never "connected".
  const pairedIds = new Set((f.peers || []).map(p => p.instanceId));
  const available = (f.discovered || []).filter(d => d.instanceId !== f.instanceId && !pairedIds.has(d.instanceId));
  const availableHtml = available.length
    ? `<div class="fleet-sub">Available to pair</div>` + available.map(d => `
      <div class="fleet-peer available">
        <div class="fl-head">
          <b>${escapeHtml(d.label)}</b>
          <span class="muted num">${escapeHtml(d.address)}</span>
          <span class="fl-tag">not paired — nothing is shared</span>
          <span style="flex:1"></span>
          <button class="pill" data-fleet-pair="${escapeHtml(d.address)}" data-fleet-port="${d.port}">Pair…</button>
        </div>
      </div>`).join('')
    : '';

  /* Pairing is a two-machine dance, and only one of the two steps happens on
     the screen you are looking at — so spell out both. Folded away once a
     machine is paired, since by then you have done it. */
  const help = `<details class="fleet-help"${(f.peers || []).length ? '' : ' open'}>
    <summary>${icon('help', 13)} How to pair another machine</summary>
    <ol>
      <li>On the other machine, open TreeMap, go to <kbd>Fleet</kbd> and turn on
        <kbd>Visible on this network</kbd> there too. Both machines have to be on the
        same Wi-Fi or wired network.</li>
      <li>On <em>one</em> of the two machines, press <kbd>Pair a machine</kbd>. A six-digit
        code appears.</li>
      <li>On the <em>other</em> machine, that first machine now shows up under
        <kbd>Available to pair</kbd>. Press <kbd>Pair…</kbd> next to it and type the
        six-digit code.</li>
    </ol>
    <div class="fh-note">The code lasts three minutes and works for one machine only. You
      only need to do this once — from then on the two remember each other, and either one
      can press <kbd>Refresh</kbd> to ask the other for its summary. If the other machine
      never appears, they are not on the same network: TreeMap only ever looks at the local
      network and never pairs over the internet.</div>
  </details>`;

  // The 5-second refresh repaints this whole panel; the constant key means a
  // peer's disk figures roll in place when they move instead of blinking.
  FxNum.rollHtml(host, disclosure +
    `<div class="fleet-controls">
      <label class="fl-switch"><input type="checkbox" id="fleetEnabled" checked> Visible on this network</label>
      <label class="fl-switch"><input type="checkbox" id="fleetRemoteScan"${f.allowRemoteScan ? ' checked' : ''}>
        Let paired machines start a scan here</label>
      <span style="flex:1"></span>
      <button class="btn" id="fleetPairBtn">${icon('plus', 13)} Pair a machine</button>
    </div>
    <div class="fl-addr muted num">${f.running
      ? `Listening on ${(f.addresses || []).map(escapeHtml).join(', ')} · port ${f.port}`
      : 'Not listening'}</div>` +
    (f.pairing ? `<div class="fleet-code">Type this code on the other machine: <b>${escapeHtml(f.pairing.code)}</b>
       <button class="pill" id="fleetCancelCode">Stop</button></div>` : '') +
    (!f.pairing && f.pairingStopped ? `<div class="fleet-alarm">${icon('ban', 13)}
       <span>Pairing stopped. Another machine on your network (${escapeHtml(f.pairingStopped.address)}) tried too
       many wrong codes, so the code you were showing stopped working. Nothing was shared with it. Press
       <b>Pair a machine</b> when you are ready to try again.</span></div>` : '') +
    help +
    (peers || `<div class="muted" style="padding:10px 2px;">No machines paired yet.</div>`) +
    availableHtml, 'fleet');

  $('fleetEnabled').onchange = (e) => setFleet({ enabled: e.target.checked });
  $('fleetRemoteScan').onchange = (e) => setFleet({ allowRemoteScan: e.target.checked });
  $('fleetPairBtn').onclick = showPairingCode;
  const cancel = $('fleetCancelCode');
  if (cancel) cancel.onclick = async () => { await api('/api/fleet/pairing', { method: 'DELETE' }); loadFleet(); };

  host.querySelectorAll('[data-fleet-refresh]').forEach(b => b.onclick = () => refreshPeer(b.dataset.fleetRefresh));
  host.querySelectorAll('[data-fleet-forget]').forEach(b => b.onclick = () => forgetPeer(b.dataset.fleetForget));
  host.querySelectorAll('[data-fleet-scan]').forEach(b => b.onclick = () => triggerPeerScan(b.dataset.fleetScan));
  host.querySelectorAll('[data-fleet-pair]').forEach(b =>
    b.onclick = () => pairWithMachine(b.dataset.fleetPair, Number(b.dataset.fleetPort)));
}

async function setFleet(patch) {
  try {
    await api('/api/fleet', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
  } catch (e) { toast('Could not change that: ' + e.message, 'error'); }
  loadFleet();
}

async function showPairingCode() {
  try {
    const offer = await api('/api/fleet/pairing', { method: 'POST' });
    toast(`Type ${offer.code} on the other machine`);
  } catch (e) { toast(e.message, 'error'); }
  loadFleet();
}

async function pairWithMachine(address, port) {
  const code = prompt(`Enter the six-digit code showing on ${address}:`);
  if (!code) return;
  try {
    await api('/api/fleet/peers', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address, port, code: code.trim() }),
    });
    toast('Paired');
  } catch (e) { toast('Pairing failed: ' + e.message, 'error'); }
  loadFleet();
}

async function refreshPeer(id) {
  try { await api(`/api/fleet/peers/${encodeURIComponent(id)}/summary`); }
  catch (e) { toast(e.message, 'error'); }
  loadFleet();
}

async function forgetPeer(id) {
  await api(`/api/fleet/peers/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => undefined);
  loadFleet();
}

async function triggerPeerScan(id) {
  const path = prompt('Which folder should that machine scan?');
  if (!path) return;
  try {
    await api(`/api/fleet/peers/${encodeURIComponent(id)}/trigger-scan`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path }),
    });
    toast('Asked it to scan — its own screen will show the result');
  } catch (e) { toast(e.message, 'error'); }
}

/* ── Portable session (§D3) ────────────────────────────────────────────────
   "It leaves no trace" is a promise the user has to be TOLD about to rely on,
   so a portable session opens with a screen that says exactly where things go,
   what this computer will and will not receive, and what the session cannot do.
   The read-only case is the one that must not be glossed: nothing is saved
   anywhere at all, and pretending otherwise would be the worst kind of lie
   here. */
let portableInfo = null;

async function loadPortableMode() {
  try { portableInfo = await api('/api/platform/portable'); } catch { return; }
  if (!portableInfo.portable) return;
  document.body.classList.add('is-portable');
  renderPortableScreen();
}

function renderPortableScreen() {
  const p = portableInfo;
  const body = $('portableBody');
  const drives = (p.externalVolumes || []).length
    ? `<div class="pm-row"><b>Drives found</b><span>${p.externalVolumes.map(v => escapeHtml(v.name)).join(', ')}</span></div>`
    : '';
  const degraded = (p.degraded || []).length
    ? `<div class="pm-degraded"><b>What this session can’t do</b><ul>` +
      p.degraded.map(d => `<li>${escapeHtml(d.reason)}</li>`).join('') + `</ul></div>`
    : '';

  body.innerHTML =
    `<p class="pm-lead">TreeMap is running from the drive it was launched from. Nothing is installed, and
      <b>nothing is written to this computer</b>.</p>` +
    `<div class="pm-rows">` +
      (p.writable
        ? `<div class="pm-row"><b>Saved to</b><span class="pth">${escapeHtml(p.dataDir || '')}</span></div>`
        : `<div class="pm-row warn"><b>Nothing is saved</b><span>${escapeHtml(p.reason || 'This drive is read-only.')}</span></div>`) +
      `<div class="pm-row"><b>Never touched</b><span class="pth">${escapeHtml(p.hostDataDir)}</span></div>` +
      drives +
    `</div>` + degraded +
    `<p class="pm-foot">When you are done, eject the drive. This computer keeps no record that TreeMap ran.</p>`;

  $('portableStartBtn').onclick = () => {
    $('portableModal').classList.remove('open');
    // Offer the attached drives first — that is what a portable session is for.
    if ((p.externalVolumes || []).length && $('pathInput') && !$('pathInput').value) {
      $('pathInput').value = p.externalVolumes[0].path;
    }
  };
  $('portableModal').classList.add('open');
}

/* ── Right-click menu (§D2) ───────────────────────────────────────────────
   Installed AND removed from the same control, because an uninstall that
   leaves a dead context-menu entry behind is the specific failure §D2 names.
   The state is re-read from the OS after every action rather than assumed, so
   the button always reflects what is really there. */
async function renderShellIntegration(carryStatus = '') {
  const btn = $('shellIntegrationBtn');
  const blurb = $('shellIntegrationBlurb');
  const status = $('shellIntegrationStatus');
  if (!btn) return;
  btn.disabled = true;
  // The re-read below is what makes the state trustworthy, but it must not wipe
  // the confirmation the user just earned — so the message is carried through.
  status.textContent = carryStatus;
  let data;
  try { data = await api('/api/platform/shell-integration'); }
  catch (e) { blurb.textContent = 'Could not check: ' + e.message; return; }

  if (!data.supported) {
    blurb.textContent = data.reason || 'This system has no file manager TreeMap can add an entry to.';
    btn.hidden = true;
    return;
  }
  btn.hidden = false;
  // The capability's own reason is already a complete sentence about what this
  // does; prefixing it with our own restated it twice.
  blurb.textContent = data.installed
    ? '“Scan with TreeMap” is in your file manager’s right-click menu for folders. Removing it takes the entry away completely.'
    : (data.reason || 'Add “Scan with TreeMap” to your file manager’s right-click menu for folders.');
  btn.textContent = data.installed ? 'Remove from right-click menu' : 'Add to right-click menu';
  btn.classList.toggle('btn-danger', !!data.installed);
  btn.disabled = false;
  btn.onclick = async () => {
    btn.disabled = true;
    status.textContent = data.installed ? 'Removing…' : 'Adding…';
    let message;
    try {
      const result = await api('/api/platform/shell-integration', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ install: !data.installed }),
      });
      message = result.installed
        ? `Added${result.targets && result.targets.length ? ' (' + result.targets.join(', ') + ')' : ''}.`
        : 'Removed.';
      if (result.installed && !data.installed) {
        toast('Added — your file manager may take a moment to show it');
      }
    } catch (e) {
      message = 'Failed: ' + e.message;
    }
    // Re-read the truth rather than assuming the action landed, carrying the
    // confirmation through so it survives the refresh.
    await renderShellIntegration(message);
  };
}
