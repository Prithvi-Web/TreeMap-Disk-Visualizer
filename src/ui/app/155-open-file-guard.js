/* ───────────────────────────── Open-file guard (B2) ─────────────────────────────
   The dialog opens immediately and the check fills in behind it. Blocking the
   dialog on a ~200 ms round-trip would make every delete feel sticky, and the
   answer arrives long before anyone reads the sentence above it.

   The server runs the same check again on the delete itself, so this is a
   courtesy, not the enforcement — nothing gets through by clicking fast.     */

/** Rises with each dialog, so a slow answer can't paint into a later one. */
let openHandleSeq = 0;
/** Set when the user has seen the warning and chose to go ahead regardless. */
let confirmIgnoreOpenHandles = false;

/** Clear the panel and the button back to their neutral state. */
function resetOpenHandleWarning() {
  openHandleSeq++; // abandon any answer still in flight
  confirmIgnoreOpenHandles = false;
  const host = $('confirmOpenHandles');
  if (host) { host.hidden = true; host.innerHTML = ''; }
  setConfirmButton('Move to Trash');
}

/**
 * How many requests the preflight will spend before it stops and admits how far
 * it got.
 *
 * The bound is deliberate, and it is a bound on REQUESTS, not on the selection.
 * The API caps a *body* at 500 paths, so a big selection has to be asked about
 * in chunks — but nothing stops the client asking repeatedly, and it used to
 * ask exactly once and then describe the answer as if it covered everything.
 * The reason not to ask forever: each request costs the server a full
 * enumeration of every open handle on the machine (the check is flat in the
 * number of paths — a chunk of 400 costs what a chunk of 1 costs), and this
 * runs behind a dialog someone is already reading. Sixteen chunks covers 6,400
 * items in a second or two of background work and stays inside the rate
 * limiter's 20-request burst, so the delete that follows is not queued behind
 * its own preflight. Past that, "checked 6,400 of 80,000" is worth more than a
 * warning that arrives a minute after the user clicked.
 */
const OPEN_HANDLE_PREFLIGHT_CHUNKS = 16;

/**
 * Ask about the selection in chunks, merge the answers, and paint one report
 * that is true about the WHOLE selection.
 *
 * The merge is the point of this function. A response's `complete` flag
 * describes only the paths that request carried, so a report built from the
 * first chunk and then rendered against `paths.length` claims a reach it never
 * had: with the in-use files sitting past index 400 — the ordinary case for a
 * 5,000-item cleanup — the dialog showed no warning at all, which reads as
 * "nothing here is open", and people trashed files their editor was holding.
 *
 * Everything this did NOT look at therefore makes the report partial: chunks
 * past the budget, chunks whose request died on the way, and — once some chunk
 * has answered — the chunk that came back "no way to check" together with every
 * chunk after it, since the loop stops there. The panel stays silent only when
 * the answer covered the whole set.
 *
 * The loop is kept here rather than split into a helper so the "a failed
 * preflight gets out of the way" path stays visible in one function: the catch
 * below and the `host.hidden = true` that follows it are one decision.
 *
 * The panel keeps saying "Checking…" until every chunk is in, rather than
 * growing a row at a time — a warning that rewrites itself while someone is
 * reading it is worse than one that arrives once.
 */
async function checkOpenHandlesFor(paths) {
  const seq = ++openHandleSeq;
  const host = $('confirmOpenHandles');
  host.hidden = false;
  host.className = 'checking';
  host.textContent = 'Checking whether anything has these files open…';

  const chunks = Math.min(Math.ceil(paths.length / TRASH_CHUNK), OPEN_HANDLE_PREFLIGHT_CHUNKS);
  const conflicts = [];
  let checkedCount = 0;
  let complete = true;
  let answered = false;
  let serverReason = '';
  let unavailable = null;

  for (let i = 0; i < chunks; i++) {
    const chunk = paths.slice(i * TRASH_CHUNK, (i + 1) * TRASH_CHUNK);
    let part;
    try {
      part = await api('/api/files/open-handles', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paths: chunk }),
      });
    } catch {
      // Asked and never answered. Skipping the chunk is right — one dropped
      // request must not lose the answers that did arrive — but these paths
      // were not checked, and the count below has to say so.
      continue;
    }
    if (seq !== openHandleSeq) return; // a newer dialog owns the panel now
    answered = true;
    // `checked: false` is the machine saying it has no way to look. `lsof`
    // missing is a property of the computer, not of this chunk, so asking
    // sixteen times would collect sixteen identical noes: take the first.
    if (part.checked === false) { unavailable = part; break; }
    if (part.conflicts) conflicts.push(...part.conflicts);
    checkedCount += chunk.length;
    if (part.complete === false) {
      // The server hit its own limit inside this chunk (Windows' Restart
      // Manager truncates at RM_MAX_RESOURCES). Its wording is better than
      // anything guessable from here, so carry it rather than restate it.
      complete = false;
      if (part.reason) serverReason = part.reason;
    }
  }

  // One check for every exit below, and it must stay the FIRST statement here.
  //
  // The in-loop `seq !== openHandleSeq` runs only after a chunk SUCCEEDS, and
  // the catch above does `continue` — so a run whose first chunk landed and
  // whose later chunk died skips it entirely and falls out of the loop still
  // believing the panel is its own. #confirmOpenHandles is one element shared
  // by every confirm dialog, and this is worse than a stray repaint:
  // `renderOpenHandleWarning` also arms `confirmIgnoreOpenHandles` and relabels
  // the button "Delete anyway", so a loser can hand a NEWER dialog an override
  // for a warning its user never saw, and that dialog's next confirm sends
  // `ignoreOpenHandles: true` for an unrelated selection.
  if (seq !== openHandleSeq) return; // a newer dialog owns the panel now

  if (!answered) {
    // Nothing answered at all. The check is a courtesy; failing it must not
    // stand between the user and a delete they asked for. The server still
    // guards the delete itself.
    host.hidden = true;
    return;
  }
  if (unavailable) {
    // `checked: false` carries `conflicts: []` — it is the machine saying it
    // cannot look, not a finding. Painting it on its own therefore throws away
    // every conflict the chunks before it already found, and prints a panel
    // that names nothing in use: the exact "nothing here is open" that chunking
    // exists to prevent, re-entered through the back door. So only a run that
    // reached nothing reports itself as unchecked; once some chunk has answered,
    // what it found stays, and the part nobody could look at is admitted below
    // as the reason the answer is partial.
    if (!checkedCount) { renderOpenHandleWarning(unavailable, paths.length); return; }
    complete = false;
    if (unavailable.reason && unavailable.reason !== serverReason) {
      serverReason = serverReason ? `${serverReason} ${unavailable.reason}` : unavailable.reason;
    }
  }

  const reasons = [];
  if (checkedCount < paths.length) {
    // Paths nobody looked at — the budget ran out, or their request died. The
    // flag matters as much as the sentence: `renderOpenHandleWarning` decides
    // whether to speak at all from `complete`, so a report carrying the honest
    // count without the flag would print it nowhere and still render a
    // truncated check as a clean bill of health.
    complete = false;
    reasons.push(`TreeMap checked ${formatCount(checkedCount)} of ${formatCount(paths.length)} selected items, so anything open in the rest isn’t listed here.`);
  }
  if (serverReason) reasons.push(serverReason);
  renderOpenHandleWarning({
    conflicts,
    checked: true,
    complete,
    ...(reasons.length ? { reason: reasons.join(' ') } : {}),
  }, paths.length);
}

function renderOpenHandleWarning(report, pathCount) {
  const host = $('confirmOpenHandles');
  const conflicts = report.conflicts || [];
  // "The probe could not cover the whole set" is true whether or not it found
  // something in the part it DID cover, and it is most important when it did:
  // Windows' Restart Manager truncates at RM_MAX_RESOURCES, which a
  // `node_modules` delete passes routinely, so "3 files in use" there may be
  // three of an unknown number. Kept above the empty-list branch for that
  // reason.
  const partial = report.checked !== false && report.complete === false
    ? (report.reason || 'TreeMap could not check every file in this set, so some open files may not be listed.')
    : '';

  if (!conflicts.length) {
    // "Couldn't check" is not "nothing is open" (§2.2) — say which it was, but
    // quietly, since it changes nothing about what the button does.
    if (report.checked === false) {
      host.className = 'checking';
      host.hidden = false;
      host.textContent = report.reason || 'TreeMap couldn’t check whether these files are in use.';
      return;
    }
    // "Checked, found nothing" and "checked as much as it could reach, found
    // nothing in that part" are different facts, and only the first means the
    // set is clear. The server has always carried `complete` for this and the
    // UI has never read it — because until now nothing computed it.
    if (partial) {
      host.className = 'checking';
      host.hidden = false;
      host.textContent = partial;
      return;
    }
    host.hidden = true;
    return;
  }

  // Group by program: "Chrome — 3 files" reads better than three Chrome rows.
  const byProcess = new Map();
  for (const c of conflicts) {
    if (!byProcess.has(c.processName)) byProcess.set(c.processName, []);
    byProcess.get(c.processName).push(c.openPath || c.path);
  }
  const rows = [...byProcess.entries()].slice(0, 5).map(([name, files]) => {
    const shown = files.slice(0, 2).map(f => escapeHtml(baseName(f))).join(', ');
    const extra = files.length > 2 ? ` and ${files.length - 2} more` : '';
    return `<li><b>${escapeHtml(name)}</b> <span class="oh-file">— ${shown}${extra}</span></li>`;
  }).join('');
  const hiddenCount = byProcess.size - Math.min(5, byProcess.size);

  // What is actually in use decides the wording. Telling someone "this file is
  // in use" when they selected a folder — the commonest case, since the open
  // file is usually buried inside it — describes something they didn't do.
  const insideAFolder = conflicts.some(c => c.openPath && c.openPath !== c.path);
  const openFileCount = new Set(conflicts.map(c => c.openPath || c.path)).size;
  const subject = pathCount > 1
    ? 'Some of these items are in use right now.'
    : insideAFolder
      ? `${openFileCount === 1 ? 'A file' : `${openFileCount} files`} inside this folder ${openFileCount === 1 ? 'is' : 'are'} in use right now.`
      : 'This file is in use right now.';
  // The consequence follows what is *open*, not what was selected: it is the
  // open file that keeps holding the space, and one open file inside a folder
  // still reads as "it".
  const consequence = openFileCount === 1
    ? `Deleting it may not free the space until ${byProcess.size === 1 ? 'that program closes' : 'those programs close'} it.`
    : `Deleting them may not free the space until ${byProcess.size === 1 ? 'that program closes' : 'those programs close'} them.`;

  host.className = '';
  host.hidden = false;
  host.innerHTML =
    `<div class="oh-head">${icon('alert', 15)}<div><b>${subject}</b> ${consequence}</div></div>` +
    `<ul>${rows}${hiddenCount > 0 ? `<li class="oh-file">and ${hiddenCount} other program${hiddenCount === 1 ? '' : 's'}</li>` : ''}</ul>` +
    // A truncated probe that found something is still truncated, and this is
    // the case it matters most in — the list below may be part of a longer one.
    (partial ? `<div class="oh-file" style="margin-top:6px;">${escapeHtml(partial)}</div>` : '');

  // The button now says what it actually does. The user has read the warning;
  // taking the choice away would just send them to Finder to do it unguarded.
  confirmIgnoreOpenHandles = true;
  setConfirmButton('Delete anyway');
}

/** Last path segment, for naming a file without the full path. */
function baseName(p) {
  const parts = String(p).split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

function setConfirmButton(label) {
  $('confirmOk').innerHTML = icon('trash', 15) + escapeHtml(label);
}

$('confirmOk').addEventListener('click', async () => {
  closeModal('confirmModal');
  const cb = onConfirmTrash; onConfirmTrash = null;
  const ignoreOpenHandles = confirmIgnoreOpenHandles;
  confirmIgnoreOpenHandles = false;
  openHandleSeq++; // any in-flight check belongs to a dialog that is now closed
  if (cb) { await cb(); return; }
  await trashPaths(confirmPaths, { ignoreOpenHandles });
  confirmPaths = [];
});

/**
 * The API sanitizes and bounds each request at 500 paths, so any selection is
 * sent in chunks. There is no limit on how many items one action can trash —
 * selecting 5,000 near-duplicates and hitting Trash works.
 */
const TRASH_CHUNK = 400;

/**
 * A request that rides out rate limiting. Bulk actions fire many chunks back to
 * back, and the server allows a 20-request burst then 10/s. Chunks that return
 * quickly (e.g. paths already gone) can outrun that — pacing is the client's
 * job, and a 429 must never surface as "your delete failed".
 */
/**
 * Kept as a name, not as a second code path: rate-limit backoff moved into
 * `api()` itself, so every call gets it rather than only the handful that
 * remembered to opt in. A 429 means the request was refused, not performed, so
 * retrying it is safe even for POST and DELETE.
 */
async function apiPaced(url, options, tries = 8) {
  return api(url, options, { retries: tries });
}

async function trashPaths(paths, { silent = false, ignoreOpenHandles = false } = {}) {
  if (!paths.length) return { deleted: [], failed: [] };
  await ensureNodes(paths); // real sizes for the "recovered" figure
  const recovered = paths.reduce((s, p) => s + (nodeFor(p)?.size ?? 0), 0);

  const deleted = [], failed = [];
  // A file can be opened between the dialog's check and this request. The
  // server refuses that batch rather than half-freeing it, and the paths are
  // collected here so the user can be re-asked with the fresh answer instead of
  // just being told "failed".
  let blocked = null;
  const blockedPaths = [];
  // Per-chunk error handling: a later chunk failing must not discard the fact
  // that earlier ones really were trashed.
  for (let i = 0; i < paths.length; i += TRASH_CHUNK) {
    const chunk = paths.slice(i, i + TRASH_CHUNK);
    try {
      const result = await apiPaced('/api/files', {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paths: chunk, ...(ignoreOpenHandles ? { ignoreOpenHandles: true } : {}) }),
      });
      deleted.push(...result.deleted);
      failed.push(...result.failed);
    } catch (e) {
      if (e.code === 'OPEN_HANDLE_CONFLICT') {
        blocked = e;
        blockedPaths.push(...chunk);
        continue;
      }
      for (const p of chunk) failed.push({ path: p, reason: e.message });
    }
  }

  if (!silent) {
    if (deleted.length) {
      toast(`Moved ${deleted.length} ${deleted.length === 1 ? 'item' : 'items'} to Trash — ${formatBytes(recovered)} recovered`);
    }
    if (failed.length) {
      toast(`${failed.length} failed: ${failed[0].reason}`, 'error');
    }
    if (deleted.length) rescan();
    // Re-ask last, so it isn't buried under the toasts above.
    if (blocked) reofferBlockedTrash(blockedPaths, blocked);
  }
  return { deleted, failed, ...(blocked ? { blocked: blockedPaths } : {}) };
}

/**
 * Something got opened between the check and the delete: put the dialog back
 * with the real reason, rather than leaving a bare "failed" toast the user can
 * do nothing with.
 */
async function reofferBlockedTrash(paths, err) {
  if (!paths.length) return;
  confirmPaths = paths;
  onConfirmTrash = null;
  $('confirmTitle').innerHTML = icon('trash', 18) + 'Still in use';
  $('confirmText').innerHTML = paths.length === 1
    ? `<b>${escapeHtml(baseName(paths[0]))}</b> wasn’t moved to the Trash.`
    : `<b>${paths.length} items</b> weren’t moved to the Trash.`;
  $('confirmModal').classList.add('open');
  openHandleSeq++; // this panel is painted directly, not by the async check
  renderOpenHandleWarning({ conflicts: err.conflicts || [], checked: true }, paths.length);
}
function rescan() {
  if (state.root && !state.scanning) startScan(state.root.path);
}
