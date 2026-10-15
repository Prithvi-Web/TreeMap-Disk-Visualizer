/* ═════════════════ Query grammar in the highlight box (Phase 2, §2.4) ═════════════════
   The box accepts the full grammar — size>1gb ext:mp4 used>1y -in:node_modules —
   without becoming a second implementation of it (§7 forbids one).

   * **The zero-token fast path is untouched.** A bare word still goes through
     `treemapMatch()` exactly as it always has: no network, no latency, and the
     backend/frontend agreement test in tests/indexSearch.test.ts keeps passing
     against the same five lines it has always read.
   * **Anything naming a field goes to the server.** `POST /api/query` runs the
     one parser and the one evaluator. The browser never parses the grammar.
   * **Live feedback is parse-only.** `POST /api/query/validate` on a 150 ms
     debounce never touches a scan, so typing cannot start a tree walk.        */

/**
 * Does this query use the grammar, or is it an ordinary filename search?
 *
 * **Anchored to a real field name, and that is the whole point.** An earlier
 * version triggered on any of `-`, `:`, `<`, `>`, `(`, `)` or the word `or`,
 * which quietly sent ordinary filenames to the parser:
 *
 *   `Screenshot (1).png`  →  substring("screenshot") AND "1" AND ".png"
 *   `-hidden.txt`         →  NOT substring("hidden.txt")  ← highlights every
 *                            file EXCEPT the one that was typed
 *
 * The first is the commonest filename shape there is, and the second is a
 * confident, silent inversion of what was asked. Global search's "go to" also
 * routes through here, so it broke a shipped path too. Requiring a known field
 * before the operator costs the grammar nothing — every field term has one —
 * and gives filenames back their plain meaning.
 */
const TM_GRAMMAR_FIELDS = 'size|ext|name|path|in|modified|created|used|dupe|elsewhere|git|backup|cloud|type|depth|empty|score';
const TM_GRAMMAR_RE = new RegExp('(^|[\\s(])-?(' + TM_GRAMMAR_FIELDS + ')\\s*(:|<=|>=|<|>|=)', 'i');
function tmIsGrammarQuery(q) {
  return TM_GRAMMAR_RE.test(q.trim());
}

/**
 * A word shaped like a field — two letters or more, then an operator — whether
 * or not it is one. Two letters, so a drive letter (`C:\Users`) is not a field.
 */
const TM_FIELDLIKE_RE = /(^|[\s(])-?([a-z][a-z0-9_]+)\s*(:|<=|>=|<|>|=)/gi;

/** Levenshtein distance, for "did you mean" over a dozen short field names. */
function tmEditDistance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = row;
  }
  return prev[b.length];
}

/**
 * The hint for a filename search that named a field that is not one (D30):
 * `sise>1gb`, `foo:bar`. Such text is never parsed — routing stays as
 * tmIsGrammarQuery decides — but a bare "0 matches" under it reads as a broken
 * filter. Names the word, offers the nearest field a typo away, and lists
 * them all. Null when no such word is in the text.
 */
function tmUnknownFieldHint(q) {
  const fields = TM_GRAMMAR_FIELDS.split('|');
  for (const m of q.matchAll(TM_FIELDLIKE_RE)) {
    const word = m[2].toLowerCase();
    if (fields.includes(word)) continue;
    let near = null;
    // A typo is one edit away in a short word, two in a longer one; past that
    // the guess would be a different word ("re" is not a misspelt "in").
    let nearest = (word.length <= 3 ? 1 : 2) + 1;
    for (const f of fields) {
      const d = tmEditDistance(word, f);
      if (d < nearest) { near = f; nearest = d; }
    }
    return `No file name here contains “${q}”. “${m[2]}” is not a query field${near ? ` — did you mean “${near}”?` : '.'} Fields: ${fields.join(', ')}.`;
  }
  return null;
}

let tmQueryDeb = 0;
let tmQuerySeq = 0;

/**
 * The last grammar query's hits, for "Stage matches" (v4 §4.2).
 *
 * Deliberately the SERVER's hit list rather than `state.treemap.matchedPaths`,
 * which is the same set — but only the part of it the map happened to draw
 * would be obvious to a reader, and staging "what is outlined" when the
 * message above says "412 matches — 37 shown here" would stage the wrong
 * thing. `truncated` is carried so the button can say what it is offering
 * instead of implying it has everything. `stage` is the part of the hits the
 * button actually stages (tmStageable).
 */
let tmLastHits = { q: '', paths: [], total: 0, truncated: false, stage: null };

/**
 * A query that asks for folders on purpose: a `type:dir` or `empty:yes` term
 * not negated by a leading `-`.
 */
const TM_ASKS_FOR_DIRS_RE = /(^|[\s(])(type\s*[:=]\s*"?dir"?|empty\s*[:=]\s*"?yes"?)(?=$|[\s)])/i;

/**
 * Which of a query's hits "Stage matches" puts in the cart (D60).
 *
 * `size>1gb` matches the big files, every folder on the way down to them and
 * the scanned folder itself, and staging all of that put the whole scan in
 * the cart from one click, with every nested file counted again. So:
 *   - never the scanned folder;
 *   - files only, unless the query asks for folders (TM_ASKS_FOR_DIRS_RE);
 *   - never a hit inside another staged hit: it goes with that folder.
 * What was left out is counted, so the toast can say so. A query with a
 * negated group, `-( … )`, is read as files only: the regex cannot tell
 * whether a `type:dir` inside one is asked for or ruled out, and staging the
 * narrower thing is the safe way to be wrong.
 */
function tmStageable(hits, q, rootPath) {
  const wantsDirs = TM_ASKS_FOR_DIRS_RE.test(q) && !/-\s*\(/.test(q);
  const picked = [];
  let root = false, folders = 0;
  for (const h of hits) {
    if (rootPath && h.path === rootPath) root = true;
    else if (h.isDir && !wantsDirs) folders++;
    else picked.push(h.path);
  }
  const chosen = new Set(picked);
  let nested = 0;
  const paths = picked.filter((p) => {
    for (let dir = tmParentPath(p); dir; dir = tmParentPath(dir)) {
      if (chosen.has(dir)) { nested++; return false; }
      if (dir === tmParentPath(dir)) break; // reached the filesystem root
    }
    return true;
  });
  return { paths, noun: wantsDirs ? 'item' : 'file', root, folders, nested };
}

/** Show / hide the Stage matches button for the current result (§4.2). */
function tmSyncStageButton() {
  const btn = $('tmStageMatches');
  if (!btn) return;
  const stage = tmLastHits.stage;
  const n = stage ? stage.paths.length : 0;
  btn.hidden = n === 0;
  // The bar earns its row from three things now, and this is one of them —
  // syncing here rather than at every call site is what keeps them agreeing.
  tmSyncQueryBar();
  if (n === 0) return;
  const nouns = `${stage.noun}${n === 1 ? '' : 's'}`;
  btn.textContent = `Stage ${formatCount(n)} ${nouns}`;
  btn.title = tmLastHits.truncated
    ? `Add ${formatCount(n)} matched ${nouns}, from the biggest of ${formatCount(tmLastHits.total)} matches, to the cleanup cart. Nothing is deleted — staging only.`
    : `Add ${formatCount(n)} matched ${nouns} to the cleanup cart. Nothing is deleted — staging only.`;
}

/** Clear the staged-matches offer. Called wherever a query stops being current. */
function tmClearHits() {
  tmLastHits = { q: '', paths: [], total: 0, truncated: false, stage: null };
  // The status line's "N of M" reads this; a failed or cleared query has no M,
  // and keeping the previous one would caption the map with a stale total.
  state.treemap.matchTotal = null;
  tmSyncStageButton();
}

/**
 * Invalidate every in-flight query response.
 *
 * Called on clear, on the bare-word path and on unmount. Without it a reply
 * that was already in the air lands afterwards and re-paints highlights, or
 * re-opens the message bar with a query the user ran two views ago.
 */
function tmCancelQueries() { tmQuerySeq++; clearTimeout(tmQueryDeb); tmQueryDeb = 0; }

function tmSetQueryMessage(text, isError) {
  const box = $('tmQueryErr');
  const input = $('tmSearch');
  box.textContent = text || '';
  box.hidden = !text;
  box.classList.toggle('okmsg', !isError);
  input.classList.toggle('badq', Boolean(isError));
  input.setAttribute('aria-invalid', isError ? 'true' : 'false');
  tmSyncQueryBar();
}

/** The bar earns its row only when it has something to say. */
function tmSyncQueryBar() {
  const bar = $('tmQueryBar');
  if (!bar) return;
  const hasViews = $('tmSavedViews').childElementCount > 0;
  const hasMessage = !$('tmQueryErr').hidden;
  const hasStage = !$('tmStageMatches').hidden;
  bar.hidden = !(hasViews || hasMessage || hasStage) || state.view !== 'treemap';
  // Save view saves the query in the box. With nothing typed there is nothing
  // to save, and the bar stays up for its saved chips: the button was offered
  // anyway and a press did nothing visible (B28).
  const typed = Boolean(($('tmSearch').value || '').trim());
  const save = $('tmSaveView');
  if (save) save.hidden = !typed;
  // Idle — saved chips and nothing else — the bar draws no card over the
  // map and lets the pointer through around its chips (review F1.15).
  bar.classList.toggle('idle', !typed && !hasMessage && !hasStage);
}

/**
 * Split the matches the map did NOT draw into the three reasons it can have.
 *
 * Every drawn rectangle is inside the current view root, so the hits inside it
 * minus the drawn count is exactly the number that lost to depth. The other
 * two buckets are the ones the old message got wrong.
 *
 * `drawn` is `state.treemap.matches`, and `paths` is the complete hit list —
 * only meaningful when the answer was not truncated, because a truncated list
 * cannot account for hits the server never sent. The caller handles truncation
 * before it reaches here.
 */
function tmUndrawnBreakdown(paths, viewRoot, drawn) {
  let self = false;
  let outside = 0;
  let inside = 0;
  for (const p of paths || []) {
    if (viewRoot && p === viewRoot) self = true;
    else if (viewRoot && !tmIsInside(p, viewRoot)) outside++;
    else inside++;
  }
  // A path can be drawn more than once in principle; never report a negative.
  return { self, outside, deeper: Math.max(0, inside - drawn) };
}

/**
 * Why the map shows fewer matches than the query found — the true reason.
 *
 * The message used to read "The rest are deeper than this view draws; zoom in
 * or raise Depth" whatever the reason was, and for the two commonest gaps that
 * advice cannot work:
 *
 *   - **The view root itself matched.** Measured on the live app at the scan
 *     root with `size>1gb`: the API returns 9, the map draws 8, and the ninth
 *     is the folder being looked at. The map IS that folder, so it has no
 *     rectangle of its own and no Depth setting will ever give it one.
 *   - **The match is elsewhere in the scan.** `/api/query` searches the WHOLE
 *     scan, not the drilled-in subtree. After a drill-in the missing hits are
 *     usually outside the folder on screen, and raising Depth draws deeper,
 *     never wider — only going back up can reach them.
 *   - **The match really is below what this view draws.** The only case the
 *     old sentence was right about, and the only one that still gets it.
 *
 * With no view root known, everything falls into the depth bucket, which is
 * the same answer the old code gave and the only honest one left.
 */
function tmUndrawnMessage(found, drawn, paths, viewRoot) {
  const b = tmUndrawnBreakdown(paths, viewRoot, drawn);
  const head = `${found} match${found === 1 ? '' : 'es'} — ${drawn} shown here.`;
  const why = [];
  if (b.self) why.push('one is this folder itself, which has no rectangle of its own');
  if (b.outside) why.push(`${b.outside} ${b.outside === 1 ? 'is' : 'are'} elsewhere in the scan, outside this folder`);
  if (b.deeper) why.push(`${b.deeper} ${b.deeper === 1 ? 'is' : 'are'} deeper than this view draws`);
  if (!why.length) return head; // nothing left to explain; do not invent a reason
  const advice = b.deeper && b.outside ? ' Zoom in or raise Depth for those; go up for the rest.'
    : b.deeper ? ' Zoom in or raise Depth.'
    : b.outside ? ' Go up to see them.'
    : '';
  return `${head} ${why.join('; ').replace(/^./, (c) => c.toUpperCase())}.${advice}`;
}

/** Run a grammar query on the server and highlight what comes back. */
async function tmRunGrammarQuery(q) {
  if (!state.scanId) {
    // Say so rather than doing nothing. A silent no-op here reads as a broken
    // search box; the user has no way to know a scan is what is missing.
    tmSetQueryMessage('Scan a folder first — there is nothing to search yet.', false);
    return;
  }
  const seq = ++tmQuerySeq;
  const scanAtRequest = state.scanId;
  try {
    const out = await api('/api/query', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scanId: scanAtRequest, q, limit: 1000, sort: 'size' }),
    });
    if (seq !== tmQuerySeq) return; // a newer keystroke, a clear, or an unmount won
    state.treemap.matchedPaths = new Set((out.hits || []).map((h) => h.path));
    state.treemap.queryMode = 'grammar';
    state.treemap.queryScanId = scanAtRequest; // whose tree these matches are (tmRejudgeQuery)
    // What the query matched across the whole scan, so the status line can say
    // "1 of 2" rather than a drawn count that reads as the total.
    state.treemap.matchTotal = out.total;
    // §4.2 — keep the hits themselves, every one, for the message below; what
    // the Stage button may put in the cart is the narrower `stage` (D60).
    tmLastHits = {
      q,
      paths: (out.hits || []).map((h) => h.path),
      total: out.total,
      truncated: Boolean(out.truncated),
      stage: tmStageable(out.hits || [], q, state.root && state.root.path),
    };
    seedNodes((out.hits || []).map((h) => ({ path: h.path, name: h.name, size: h.size, type: h.isDir ? 'dir' : 'file', modifiedAt: h.mtimeMs })));
    tmSyncStageButton();

    renderSearchOverlay();
    presentView();

    // Said AFTER rendering, because the honest number needs both halves.
    //
    // The server searches the whole scan; the map draws only what fits at the
    // current folder and depth. So a query can genuinely match thirty files
    // while the map outlines three — and "3 matches" alone reads as "that is
    // all there is". §2.2 also requires that a signal this machine cannot
    // supply is visible, rather than an empty highlight that reads as
    // "nothing matched". Which of the three gaps it is, and whether the Depth
    // advice can help at all, is tmUndrawnMessage's job.
    //
    // A degraded answer speaks first: when the server stopped at its candidate
    // cap (`capped`), its total is a floor, and "the N biggest of M" would
    // present the cap as the count (D31).
    const degraded = out.degraded || [];
    const drawn = state.treemap.matches;
    const found = out.total;
    if (degraded.length) {
      tmSetQueryMessage(degraded.map((d) => d.reason).join(' '), false);
    } else if (out.truncated) {
      tmSetQueryMessage(`Showing the ${formatCount(state.treemap.matchedPaths.size)} biggest of ${formatCount(found)} matches.`, false);
    } else if (found > drawn) {
      tmSetQueryMessage(tmUndrawnMessage(found, drawn, tmLastHits.paths, state.treemap.rootPath), false);
    } else {
      tmSetQueryMessage('', false);
    }
  } catch (e) {
    if (seq !== tmQuerySeq) return;
    tmClearHits(); // a failed query has no matches to stage — not stale ones
    tmSetQueryMessage(e.message || 'That query could not be run.', true);
  }
}

/**
 * Stage the current query's stageable hits (v4 §4.2; which ones: tmStageable).
 *
 * Staging, never deleting: the cart is the only route to a deletion and it
 * runs its own dry run and confirmation (§4.4). What this owes the user is an
 * honest count — including saying when the list is the biggest N of a larger
 * result rather than all of it, and what it left out. Said as sentences, each
 * ending in its own full stop (D61).
 */
async function tmStageMatches() {
  const stage = tmLastHits.stage;
  if (!stage || !stage.paths.length) return;
  const paths = stage.paths;
  let added = 0;
  for (const p of paths) if (!state.cart.has(p)) { state.cart.add(p); added++; }
  saveCart();
  await renderCart();
  refreshCartButtons();
  // A Preview that is up is a picture of the cart as it was: rebuilt, as every
  // other way into the cart does (cartAddMany), once renderCart has resolved
  // the new items' sizes. A press that added nothing leaves it alone.
  if (added) cartPreviewInvalidated();
  const already = paths.length - added;
  const sentences = [
    `Staged ${formatCount(added)} ${stage.noun}${added === 1 ? '' : 's'}` +
      (already ? ` — ${formatCount(already)} ${already === 1 ? 'was' : 'were'} already in the cart.` : '.'),
  ];
  if (tmLastHits.truncated) {
    sentences.push(`This query matched ${formatCount(tmLastHits.total)}; only the ${formatCount(tmLastHits.paths.length)} biggest were returned.`);
  }
  if (stage.root) sentences.push('The scanned folder itself matched too, and was not staged.');
  if (stage.folders) {
    sentences.push(`${formatCount(stage.folders)} matched folder${stage.folders === 1 ? ' was' : 's were'} not staged — add type:dir to the query to stage folders.`);
  }
  if (stage.nested) {
    sentences.push(`${formatCount(stage.nested)} inside a staged folder ${stage.nested === 1 ? 'goes' : 'go'} with it, so ${stage.nested === 1 ? 'it was' : 'they were'} not added on ${stage.nested === 1 ? 'its' : 'their'} own.`);
  }
  sentences.push('Nothing has been deleted.');
  toast(sentences.join(' '), 'success', sentences.length > 2 ? 9000 : 5000);
}
$('tmStageMatches').addEventListener('click', () => { void tmStageMatches(); });

/**
 * Parse-only feedback while typing. Never runs a query.
 *
 * Returns false when superseded as well as when invalid. Returning true for a
 * stale check let an older query start its run AFTER a newer one — and since
 * the run takes a fresh sequence number on entry, the stale results then won
 * the race and were painted.
 */
async function tmValidateQuery(q) {
  const seq = ++tmQuerySeq;
  try {
    await api('/api/query/validate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q }),
    });
    if (seq !== tmQuerySeq) return false;
    tmSetQueryMessage('', false);
    return true;
  } catch (e) {
    if (seq !== tmQuerySeq) return false;
    // The parser hands back the offending span and the valid alternatives;
    // showing them is the difference between "that didn't work" and a message
    // the user can act on without reading documentation.
    const where = typeof e.offset === 'number' ? ` (at character ${e.offset + 1})` : '';
    tmSetQueryMessage((e.message || 'That query could not be understood.') + where, true);
    return false;
  }
}

/** The one path by which a query reaches the box. */
function tmApplyQuery(raw) {
  const q = raw.trim();
  state.treemap.query = raw;
  state.treemap.queryRoot = state.root ? state.root.path : null; // the folder it is asked of (tmQueryScanChanged)

  if (!q || !tmIsGrammarQuery(q)) {
    // Empty means "no filter"; a bare word takes the original local path —
    // instant, and byte-for-byte the behaviour this box has always had.
    // Both invalidate anything in flight, or a late reply repaints over them.
    tmCancelQueries();
    state.treemap.queryMode = 'bare';
    state.treemap.matchedPaths = null;
    state.treemap.matchTotal = null; // no server answer to compare the map against
    tmClearHits();
    tmSetQueryMessage('', false);
    if (isSun()) presentSunburst();
    // §6.2 — the overlay's own `updateTmStatus` writes nothing for these
    // renderers, so clearing the box would otherwise leave "2 matches for …"
    // standing over a map with no query on it.
    else if (isCells()) { renderSearchOverlay(); renderCellsStatus(); presentCells(); }
    else { renderSearchOverlay(); presentTreemap(); }
    // D30 — found nothing, and a word in it is shaped like a field: say so.
    // Not over the sunburst, which draws no search highlight and counts no
    // matches, so "found nothing" would be a guess.
    const hint = q && !isSun() && !(state.treemap.matches > 0) ? tmUnknownFieldHint(q) : null;
    if (hint) tmSetQueryMessage(hint, false);
    return;
  }
  void tmValidateQuery(q).then((valid) => { if (valid) void tmRunGrammarQuery(q); });
}

/**
 * A scan is on screen: a query asked of another folder goes (browser
 * re-check C11). The Calendar's day query from corpus survived a scan of
 * /Applications and dimmed the whole new map under "0 matches" — a grammar
 * query's matches are paths of the old tree, and a bare word judged against
 * another folder's map is a filter nobody typed for it. Cleared without a
 * paint: the view that shows the map next draws it from this state. Asked of
 * this same folder (a rescan), it stays, and tmRejudgeQuery asks it again of
 * the new scan when the map is shown.
 */
function tmQueryScanChanged() {
  if (!state.treemap.query.trim()) return;
  const root = state.root ? state.root.path : null;
  if (root !== null && root === state.treemap.queryRoot) return;
  tmCancelQueries();
  $('tmSearch').value = '';
  state.treemap.query = '';
  state.treemap.queryRoot = null;
  state.treemap.queryMode = 'bare';
  state.treemap.matchedPaths = null;
  tmClearHits(); // the Stage offer, and the total the status line compares the map against
  tmSetQueryMessage('', false);
}
subscribe(TOPIC.scan, tmQueryScanChanged);

/**
 * A grammar query another scan answered is asked again of the scan on screen
 * (C11): the Treemap's mount calls this after a rescan of the same folder, so
 * its highlights are this tree's. One this scan already answered is left be.
 */
function tmRejudgeQuery() {
  const q = state.treemap.query;
  if (!q.trim() || state.treemap.queryMode !== 'grammar' || state.treemap.queryScanId === state.scanId) return;
  tmApplyQuery(q);
}

$('tmSearch').addEventListener('input', (e) => {
  clearTimeout(tmQueryDeb);
  const raw = e.target.value;
  tmSyncQueryBar(); // Save view follows the box at once (B28)
  void tmRenderHints(raw);
  // 150 ms for a grammar query, per §2.4 — long enough that a fast typist makes
  // one request, short enough that the underline feels immediate.
  tmQueryDeb = setTimeout(() => tmApplyQuery(raw), tmIsGrammarQuery(raw) ? 150 : 120);
});

/* ── Autocomplete over the grammar (§2.4) ──
   The field list comes from GET /api/query/fields rather than a copy kept
   here, so the box cannot drift from the parser that answers it. */

let tmFields = null;
let tmFieldsInFlight = null;
let tmHintSel = -1;

async function tmLoadFields() {
  if (tmFields) return tmFields;
  // One request, however fast the typing. Without the in-flight guard the
  // first four keystrokes fired four concurrent fetches and whichever landed
  // last rendered — possibly for the oldest prefix.
  if (!tmFieldsInFlight) {
    tmFieldsInFlight = api('/api/query/fields')
      .then((out) => { tmFields = out.fields || []; return tmFields; })
      .catch(() => { tmFields = []; return tmFields; })
      .finally(() => { tmFieldsInFlight = null; });
  }
  return tmFieldsInFlight;
}

function tmCloseHints() {
  const panel = $('tmQueryHints');
  if (panel) panel.hidden = true;
  const box = $('tmSearch');
  box.setAttribute('aria-expanded', 'false');
  box.removeAttribute('aria-activedescendant');
  tmHintSel = -1;
}

/** The token the caret sits in — what autocomplete is completing. */
function tmActiveToken(value, caret) {
  const upto = value.slice(0, caret);
  const start = Math.max(upto.lastIndexOf(' '), upto.lastIndexOf('(')) + 1;
  return { text: upto.slice(start).replace(/^-/, ''), start };
}

async function tmRenderHints(value) {
  // Read the caret BEFORE the await: `tmLoadFields` can suspend, and reading a
  // live selection against a captured value afterwards completes the wrong
  // token.
  const caret = $('tmSearch').selectionStart ?? value.length;
  const fields = await tmLoadFields();
  // The view may have been left while the fields were loading; re-opening the
  // panel inside a hidden view is exactly what unmount() just prevented.
  if (state.view !== 'treemap') { tmCloseHints(); return; }

  const panel = $('tmQueryHints');
  const token = tmActiveToken(value, caret);
  if (!token.text) { tmCloseHints(); return; }

  const colon = token.text.indexOf(':');
  let items = [];
  if (colon === -1) {
    const prefix = token.text.toLowerCase();
    items = fields
      .filter((f) => f.name.startsWith(prefix))
      .map((f) => ({ insert: f.name + ((f.operators || []).includes(':') ? ':' : '>'), label: f.name, help: f.help || '' }));
  } else {
    // Past the colon: offer that field's own values, so `git:` proposes
    // pushed / dirty / none rather than nothing.
    const field = fields.find((f) => f.name === token.text.slice(0, colon).toLowerCase());
    const typed = token.text.slice(colon + 1).toLowerCase();
    if (field) {
      items = (field.values || [])
        .filter((v) => v.startsWith(typed))
        .map((v) => ({ insert: `${field.name}:${v}`, label: `${field.name}:${v}`, help: field.help || '' }));
    }
  }

  if (!items.length) { tmCloseHints(); return; }
  panel.innerHTML = items.slice(0, 8).map((it, i) =>
    `<button class="tm-hint" role="option" id="tmHint${i}" aria-selected="false" data-i="${i}" data-insert="${escapeHtml(it.insert)}">` +
    `<span class="k">${escapeHtml(it.label)}</span><span class="h">${escapeHtml(it.help)}</span></button>`).join('');
  panel.hidden = false;
  $('tmSearch').setAttribute('aria-expanded', 'true');
  tmHintSel = -1;
  $('tmSearch').removeAttribute('aria-activedescendant');
}

function tmAcceptHint(insert) {
  const input = $('tmSearch');
  const caret = input.selectionStart ?? input.value.length;
  const token = tmActiveToken(input.value, caret);
  const negated = input.value.slice(token.start).startsWith('-');
  const before = input.value.slice(0, token.start) + (negated ? '-' : '');
  input.value = before + insert + input.value.slice(caret);
  input.focus();
  input.setSelectionRange((before + insert).length, (before + insert).length);
  tmCloseHints();
  clearTimeout(tmQueryDeb);
  tmApplyQuery(input.value);
}

function tmMoveHint(delta) {
  const options = [...$('tmQueryHints').querySelectorAll('.tm-hint')];
  if (!options.length) return;
  tmHintSel = (tmHintSel + delta + options.length) % options.length;
  options.forEach((o, i) => {
    o.setAttribute('aria-selected', String(i === tmHintSel));
    if (i === tmHintSel) o.scrollIntoView({ block: 'nearest' });
  });
  // Without this the input declares role="combobox" and announces nothing as
  // the arrow keys move.
  $('tmSearch').setAttribute('aria-activedescendant', options[tmHintSel].id);
}

/* The highlight box's placeholder, longest first: the longest that fits the
   field is the one shown. The field is a cqw clamp, 187 px at 1024 px and
   140 px beside the open preview pane, and one placeholder for every width
   was cut mid-word there — "Highlight… (try size>1g", read as "1gl" (QA
   fourth pass E14c). The markup ships the last, which fits the floor. */
const TM_SEARCH_PLACEHOLDERS = ['Highlight… (try size>1gb)', 'Highlight… (size>1gb)', 'Highlight…'];
let tmSearchMeasure = null; // a 2D context, for the field's own font
function tmSearchPlaceholderFit() {
  const box = $('tmSearch');
  const cs = getComputedStyle(box);
  const room = box.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  if (!(room > 0)) return; // not laid out (a hidden view): nothing to fit
  if (!tmSearchMeasure) tmSearchMeasure = document.createElement('canvas').getContext('2d');
  tmSearchMeasure.font = cs.font;
  const fits = TM_SEARCH_PLACEHOLDERS.find((p) => tmSearchMeasure.measureText(p).width <= room)
    || TM_SEARCH_PLACEHOLDERS[TM_SEARCH_PLACEHOLDERS.length - 1];
  if (box.placeholder !== fits) box.placeholder = fits;
}
if (typeof ResizeObserver !== 'undefined') new ResizeObserver(tmSearchPlaceholderFit).observe($('tmSearch'));

// One delegate on the panel, so a re-render cannot leave listeners behind.
$('tmQueryHints').addEventListener('mousedown', (e) => {
  const hint = e.target.closest('.tm-hint');
  if (!hint) return;
  e.preventDefault();
  tmAcceptHint(hint.dataset.insert);
});

$('tmSearch').addEventListener('keydown', (e) => {
  const open = !$('tmQueryHints').hidden;
  if (open && e.key === 'ArrowDown') { e.preventDefault(); tmMoveHint(1); return; }
  if (open && e.key === 'ArrowUp') { e.preventDefault(); tmMoveHint(-1); return; }
  if (open && e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); tmCloseHints(); return; }
  if (open && e.key === 'Tab') {
    const pick = [...$('tmQueryHints').querySelectorAll('.tm-hint')][tmHintSel >= 0 ? tmHintSel : 0];
    if (pick) { e.preventDefault(); tmAcceptHint(pick.dataset.insert); return; }
  }
  if (e.key === 'Enter') {
    e.preventDefault();
    // Enter accepts a hint ONLY when one was deliberately highlighted. Taking
    // the first suggestion otherwise turned a search for a file named "ext"
    // into the `ext:` filter without the user choosing it.
    if (open && tmHintSel >= 0) {
      const pick = [...$('tmQueryHints').querySelectorAll('.tm-hint')][tmHintSel];
      if (pick) { tmAcceptHint(pick.dataset.insert); return; }
    }
    tmCloseHints();
    clearTimeout(tmQueryDeb);
    tmApplyQuery(e.target.value);
  }
});
// Focus can leave without a click — "/" jumps to global search — and an
// orphaned panel then floats over the toolbar until the next click anywhere.
$('tmSearch').addEventListener('blur', () => { setTimeout(tmCloseHints, 120); });
document.addEventListener('click', (e) => {
  if (!$('tmQueryHints').hidden && !$('tmSearchWrap').contains(e.target)) tmCloseHints();
});

/* ── Saved views (§2.3 / §2.4) ── */

async function loadSavedViews(force = false) {
  // Cached: this list changes only when a view is saved or deleted, and
  // re-fetching it on every entry to the view is a round trip for nothing.
  if (state.savedViews && state.savedViewsLoaded && !force) { renderSavedViews(); return; }
  try {
    const out = await api('/api/queries');
    state.savedViews = out.queries || [];
    state.savedViewsLoaded = true;
  } catch { state.savedViews = []; }
  renderSavedViews();
}

function renderSavedViews() {
  const host = $('tmSavedViews');
  if (!host) return;
  const views = state.savedViews || [];
  // Two sibling buttons rather than a role="button" span inside a <button>:
  // the nested form was invalid interactive content AND unreachable from the
  // keyboard, while promising "Delete the saved view X" to a screen reader.
  //
  // `colour` reaches a style attribute, and escapeHtml does not escape ';' or
  // '(' — it is safe only because the server whitelists /^#[0-9a-f]{6}$/i on
  // read as well as on write. Do not relax that pattern.
  host.innerHTML = views.map((v) =>
    `<span class="saved-chip">` +
    `<button class="pill" data-view-q="${escapeHtml(v.q)}" title="${escapeHtml(v.q)}">` +
    `<span class="sw"${v.colour ? ` style="background:${escapeHtml(v.colour)}"` : ''}></span>` +
    `${escapeHtml(v.name)}</button>` +
    `<button class="pill pill-x" data-view-rm="${escapeHtml(v.id)}" aria-label="Delete the saved view ${escapeHtml(v.name)}" title="Delete this saved view">×</button>` +
    `</span>`).join('');
  tmSyncQueryBar();
}

/* ── Asking for one line of text (D65) ──
   window.prompt() is not implemented in Electron — it returns nothing — so
   Save view, the fleet's pairing code and a paired machine's scan folder did
   nothing at all in the desktop app. They ask through #askModal instead, a
   sheet like any other, so the focus and inert net (235) applies to it. */
let askResolve = null;
/** Whether the open question asks for a folder (askText's `path`). */
let askIsPath = false;

/**
 * Ask one question with a typed answer. Resolves with the trimmed text, or
 * null when the sheet is closed any way but OK — Cancel, ×, the scrim and
 * Escape all reach closeModal, which settles it — or OK is pressed with
 * nothing typed: what prompt() answered as null or ''.
 *
 * `path`: the answer is a folder, read as every path box is (asPath) —
 * leading whitespace goes, and whitespace at its end stays, part of the
 * folder's name. Trimmed, "Screenshots " was asked for as its sibling
 * "Screenshots" (final review F1.8).
 */
function askText({ title, label, value = '', ok = 'OK', path = false }) {
  askSettle(null); // a question still open is answered "no", never left waiting
  askIsPath = path;
  $('askTitle').textContent = title;
  $('askLabel').textContent = label;
  $('askInput').value = value;
  $('askOk').textContent = ok;
  $('askModal').classList.add('open');
  return new Promise((resolve) => { askResolve = resolve; });
}

/** Answer the open question, once; a later answer finds nothing to settle. */
function askSettle(answer) {
  const resolve = askResolve;
  askResolve = null;
  if (resolve) resolve(answer);
}
$('askOk').addEventListener('click', () => {
  const text = $('askInput').value;
  askSettle((askIsPath ? asPath(text) : text.trim()) || null);
  closeModal('askModal');
});
$('askInput').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  $('askOk').click();
});

async function saveCurrentView() {
  const q = ($('tmSearch').value || '').trim();
  if (!q) { toast('Type a query first, then save it as a view.', 'error'); return; }
  const name = await askText({ title: 'Save view', label: 'Name this view', value: q.slice(0, 40), ok: 'Save view' });
  if (!name) return;
  try {
    await api('/api/queries', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, q, pinned: true }),
    });
    await loadSavedViews(true);
    toast('Saved view “' + name + '”');
  } catch (e) {
    toast('Could not save that view: ' + e.message, 'error');
  }
}

/**
 * Delete a saved view from its chip's ×. One click, as before — and then said,
 * with an Undo that saves it again as it was (B28: it went with no toast and
 * nothing to undo). A view is a query, not a file, so undo is the right rail.
 */
async function deleteSavedView(id) {
  const view = (state.savedViews || []).find((v) => v.id === id) || null;
  try {
    await api('/api/queries/' + encodeURIComponent(id), { method: 'DELETE' });
    await loadSavedViews(true);
  } catch (err) { toast('Could not delete that view: ' + err.message, 'error'); return; }
  if (!view) return;
  toastAction(`Deleted the saved view “${view.name}”`, 'Undo', async () => {
    try {
      await api('/api/queries', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: view.name, q: view.q, pinned: view.pinned, ...(view.colour ? { colour: view.colour } : {}) }),
      });
      await loadSavedViews(true);
    } catch (err) { toast('Could not bring that view back: ' + err.message, 'error'); }
  });
}

$('tmSaveView').addEventListener('click', saveCurrentView);
$('tmSavedViews').addEventListener('click', async (e) => {
  const remove = e.target.closest('[data-view-rm]');
  if (remove) {
    // preventDefault only. stopPropagation here also blocked the document
    // delegate that closes the autocomplete, so deleting a chip with the
    // panel open left it hanging.
    e.preventDefault();
    await deleteSavedView(remove.dataset.viewRm);
    return;
  }
  const chip = e.target.closest('[data-view-q]');
  if (!chip) return;
  $('tmSearch').value = chip.dataset.viewQ;
  clearTimeout(tmQueryDeb);
  tmApplyQuery(chip.dataset.viewQ);
});

/* ── Export PNG / SVG ── */
/* ── Export PNG / SVG ── */
$('tmExportBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  // A toggle, as its aria-expanded says, like "…": a second press closes the
  // menu the first opened (QA-6b review F3.3). Its click never reaches the
  // document handler that closes it, so without this it rebuilt the menu.
  if (ctxMenuOpener === e.currentTarget && ctxMenuIsOpen()) { hideCtxMenu(); return; }
  if (!drawnCells().length) { toast('Render something first', 'error'); return; }
  const menu = $('ctxMenu');
  // A report can only be built from a FINISHED scan — the endpoint answers
  // 202 {status:'running'} until then (src/api/scanRoutes.ts). An offered menu
  // entry that cannot work is a promise the app breaks, and this one used to
  // break it by navigating away from the app entirely; see downloadReport.
  // The trap is that the menu looks perfectly ready mid-scan: an already
  // indexed folder paints from the live index the instant it is opened, while
  // the real scan is still walking the tree underneath.
  const canReport = !!(state.scanId && state.root && !state.scanning);
  // §7.1c — the time-lapse exports need two snapshots to animate between and
  // the rectangle renderer (the only one whose motion is honest to tween).
  const canLapse = state.treemap.history.snaps.length >= 2 && isRectMap();
  const canWebm = canLapse && 'captureStream' in HTMLCanvasElement.prototype && !!window.MediaRecorder;
  const html = `
    <button data-exp="png">${icon('image', 15)}PNG image</button>` +
    (isRectMap() ? `
    <button data-exp="svg">${icon('code', 15)}SVG vector</button>` : '') +
    (canLapse ? `
    <div class="div"></div>
    <button data-exp="gif">${icon('play', 15)}Animated GIF — history</button>` : '') +
    (canWebm ? `
    <button data-exp="webm">${icon('video', 15)}WebM video — history</button>` : '') +
    (canReport ? `
    <div class="div"></div>
    <button data-exp="csv-files">${icon('file', 15)}CSV — all files</button>
    <button data-exp="csv-folders">${icon('folder', 15)}CSV — all folders</button>
    <button data-exp="xlsx-files">${icon('grid', 15)}Excel — all files</button>
    <button data-exp="xlsx-folders">${icon('grid', 15)}Excel — all folders</button>
    <button data-exp="pdf">${icon('download', 15)}PDF report</button>` : '');
  const r = e.currentTarget.getBoundingClientRect();
  // A named menu of menu items, focus back on Export when the keyboard closes it or an entry is picked (QA-6 review MEDIUM-1, QA-6b F1.8).
  ctxMenuShow(menu, { label: 'Export the map', html, opener: e.currentTarget, x: r.left, y: r.bottom + 6 });
  menu.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
    ctxMenuFocusOpener(hideCtxMenu());
    const exp = b.dataset.exp;
    if (exp === 'png') exportTreemapPNG();
    else if (exp === 'svg') exportTreemapSVG();
    else if (exp === 'gif') exportTimelapseGif();
    else if (exp === 'webm') exportTimelapseWebm();
    else if (exp === 'csv-files') void downloadReport('csv', 'files');
    else if (exp === 'csv-folders') void downloadReport('csv', 'folders');
    else if (exp === 'xlsx-files') void downloadReport('xlsx', 'files');
    else if (exp === 'xlsx-folders') void downloadReport('xlsx', 'folders');
    else if (exp === 'pdf') void downloadReport('pdf');
  }));
});

/**
 * Trigger a server-side report download (CSV / XLSX / PDF) for the current scan.
 *
 * **This was the one network call in the UI that could unload the whole app.**
 * It was a bare `<a href="/api/scan/…/export">` click, and a bare anchor
 * NAVIGATES unless the answer carries `Content-Disposition: attachment`. That
 * endpoint only sets the header once the scan has FINISHED: while it is still
 * running it answers `202 {status:'running'}`, and 404/500 answer the flat
 * `{error, code}` envelope — all JSON, none of them attachments. So Export
 * mid-scan replaced the single-page app with a page of raw JSON, taking the
 * cart, the drill-in, the query and every other unsaved thing with it. It is
 * easy to hit precisely because the screen looks finished: an already-indexed
 * folder paints instantly from the live index while a real scan runs under it.
 *
 * Both halves are closed, and neither one alone would be enough.
 *
 *  1. **The report is not offered, or run, unless the scan is done.** The menu
 *     drops the entries while `state.scanning` (see `canReport` above); this
 *     repeats the guard for any caller that arrives another way, and then asks
 *     the server, because `state.scanning` describes THIS session — reopening
 *     an indexed folder paints a map from a scan someone else is still running.
 *     The ask goes through `api()`, so a 404 or a 500 arrives as the project's
 *     error envelope and is spoken, exactly like every other call in the app.
 *  2. **The anchor is given a `download` attribute.** That is the half that
 *     makes the unload structurally impossible rather than merely unlikely: a
 *     same-origin anchor with `download` saves the response, and the HTML spec
 *     gives it no path back to navigating, whatever status or content type
 *     comes back. Should the export somehow still answer JSON after a clean
 *     preflight, the worst case is a small useless file — not a lost session.
 *
 * The bytes still stream from the server straight to disk, which is why this
 * stayed an anchor rather than becoming a buffered blob: a full-tree CSV of a
 * large scan has no business being held in the page's memory first.
 */
async function downloadReport(format, mode) {
  if (!state.scanId) { toast('Run a scan first', 'error'); return; }
  if (state.scanning) {
    toast('The scan is still running — a report can only be built from a finished scan. Try again when it lands.', 'error');
    return;
  }

  // /stats is the cheap one: it answers 200 with the scan's status for any
  // state the scan is in, so there is no 202 to interpret and no tree walk to
  // pay for. A scan that has been evicted or has failed surfaces here, in
  // words, instead of as a page of JSON where the app used to be.
  let stats;
  try {
    stats = await api(`/api/scan/${encodeURIComponent(state.scanId)}/stats`);
  } catch (e) {
    toast(e.message || 'That report could not be built.', 'error');
    return;
  }
  if (stats && stats.status === 'running') {
    toast('The scan hasn’t finished on the server yet, so there is nothing to report on yet. Try again in a moment.', 'error');
    return;
  }
  if (!stats || stats.status !== 'complete') {
    toast('That scan didn’t finish, so there is nothing to report on. Rescan the folder and try again.', 'error');
    return;
  }

  let url = `/api/scan/${encodeURIComponent(state.scanId)}/export?format=${format}`;
  if (mode) url += `&mode=${mode}`;
  const a = document.createElement('a');
  a.href = url;
  // Load-bearing, not cosmetic: `download` is what forbids navigation. Without
  // it this anchor is the original defect. The name follows the same
  // convention as every other export the app writes, and names the mode: the
  // attribute wins over the server's -files-/-folders- name, so without it the
  // two CSVs (and the two workbooks) were saved under one name (D37).
  // Named after the SCANNED folder: the request has no root, and the file
  // holds the whole scan, whatever folder the map is drilled into (B32 — it
  // saved treemap-Videos-files-….csv holding every corpus file).
  a.download = exportFileName(format === 'pdf' ? 'pdf' : format === 'xlsx' ? 'xlsx' : 'csv', mode, state.root && state.root.name);
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  toast(format === 'pdf' ? 'Building PDF report…' : format === 'xlsx' ? 'Building Excel workbook…' : 'Exporting CSV…');
}

/**
 * `mode` (files / folders) is part of the name when an export has one.
 * `name` is what the file holds: by default the folder on screen — a picture
 * of the map shows that folder — and the scanned folder for a report of the
 * whole scan (B32).
 */
function exportFileName(ext, mode, name = state.treemap.rootName) {
  const base = (name || 'treemap').replace(/[^\w.-]+/g, '_');
  const d = new Date(), pad = (n) => String(n).padStart(2, '0');
  return `treemap-${base}-${mode ? `${mode}-` : ''}${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}.${ext}`;
}
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/* ── §7.1c — time-lapse export: GIF in a worker, WebM off the live canvas ── */

const LAPSE_GIF_FPS = 10;
const LAPSE_GIF_CAP = 150; // frames — stated to the user when it bites
const LAPSE_GIF_MAX_W = 480;

/**
 * One implementation serves both threads: the four shipped GIF functions are
 * serialised into a worker via their own source (Function.prototype.toString
 * → Blob), exactly so no second copy exists to drift (liftFrontend.ts's
 * argument, applied to the worker boundary). Inside the worker,
 * gifLzwEncode is wrapped to report per-frame progress — encodeGif calls it
 * once per frame, so the count is honest without touching the encoder.
 */
function lapseGifWorkerUrl() {
  const src = [gifBuildPalette, gifIndexFrame, gifLzwEncode, encodeGif]
    .map((f) => f.toString())
    .join('\n') + `
const __lzw = gifLzwEncode;
let __done = 0;
gifLzwEncode = function (...args) {
  const r = __lzw(...args);
  self.postMessage({ progress: ++__done });
  return r;
};
self.onmessage = (e) => {
  try {
    const bytes = encodeGif(e.data.frames, e.data.opts);
    self.postMessage({ ok: true, bytes }, [bytes.buffer]);
  } catch (err) {
    self.postMessage({ ok: false, error: String((err && err.message) || err) });
  }
};`;
  return URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
}

let lapseExporting = false;
/** Set only around the WebM export's own lapseStart — the one caller allowed past the export guard. */
let lapseInternalStart = false;
async function exportTimelapseGif() {
  const h = state.treemap.history;
  if (lapseExporting) { toast('An export is already running', 'error'); return; }
  if (h.snaps.length < 2 || !isRectMap()) { toast('History export needs two snapshots and the rectangle map', 'error'); return; }
  lapseExporting = true;
  // FX: "composing" beside the Export control, exactly while lapseExporting
  // holds — the finally that clears the flag clears the orb, and the sm ring
  // on the button itself rides the identical pair.
  fxOrbShow('export', $('tmExportBtn').closest('.tb-group'), 'composing');
  FxBeam.attach($('tmExportBtn'), { type: 'sm', active: true });
  lapseStop();
  const status = $('tmStatus');
  try {
    const { times, capped } = lapseSampleTimes(h.snaps.length, LAPSE_GIF_FPS, LAPSE_GIF_CAP);
    if (capped) toast(`Long history — sampling ${LAPSE_GIF_CAP} frames across all ${h.snaps.length} snapshots`);
    const layouts = [];
    for (let i = 0; i < h.snaps.length; i++) {
      status.textContent = `Fetching snapshot ${i + 1}/${h.snaps.length}…`;
      layouts.push(await historyLayoutFor(h.snaps[i]));
    }
    // Downscale through an offscreen canvas; the frames drawn are the real
    // drawTreemap's, via tmBuffer — the export shows what the app shows.
    const scale = Math.min(1, LAPSE_GIF_MAX_W / tmBuffer.width);
    const w = Math.max(1, Math.round(tmBuffer.width * scale));
    const hh = Math.max(1, Math.round(tmBuffer.height * scale));
    const off = document.createElement('canvas');
    off.width = w; off.height = hh;
    const offCtx = off.getContext('2d', { willReadFrequently: true });
    const bg = cssVar('--bg-1') || '#0e0e13';
    const savedNodes = state.treemap.nodes;
    const frames = [];
    for (let i = 0; i < times.length; i++) {
      // Leaving the view mid-export would size drawTreemap from a hidden
      // wrap (negative canvas dims) — abort with the reason, not a mystery.
      if (state.view !== 'treemap') throw new Error('the Treemap view was left mid-export');
      const t = times[i];
      const k = Math.min(Math.floor(t), h.snaps.length - 2);
      state.treemap.nodes = lapseLerpNodes(layouts[k].nodes, layouts[k + 1].nodes, t - k);
      drawTreemap();
      offCtx.fillStyle = bg;
      offCtx.fillRect(0, 0, w, hh);
      offCtx.drawImage(tmBuffer, 0, 0, w, hh);
      frames.push(new Uint8Array(offCtx.getImageData(0, 0, w, hh).data.buffer.slice(0)));
      status.textContent = `Sampling frame ${i + 1}/${times.length}…`;
      // Yield between frames: 150 synchronous draw+read passes would freeze
      // the UI with a progress line that never paints (review H3).
      await new Promise((r) => setTimeout(r, 0));
    }
    state.treemap.nodes = savedNodes;
    drawTreemap();
    const url = lapseGifWorkerUrl();
    const worker = new Worker(url);
    const bytes = await new Promise((resolve, reject) => {
      worker.onmessage = (ev) => {
        if (ev.data.progress) { status.textContent = `Encoding GIF — frame ${ev.data.progress}/${frames.length}…`; return; }
        ev.data.ok ? resolve(ev.data.bytes) : reject(new Error(ev.data.error));
      };
      worker.onerror = (ev) => reject(new Error(ev.message || 'GIF worker failed'));
      worker.postMessage(
        { frames, opts: { width: w, height: hh, delayMs: 1000 / LAPSE_GIF_FPS, loop: 0 } },
        frames.map((f) => f.buffer),
      );
    }).finally(() => { worker.terminate(); URL.revokeObjectURL(url); });
    downloadBlob(new Blob([bytes], { type: 'image/gif' }), exportFileName('gif'));
    toast(`GIF saved — ${frames.length} frames at ${LAPSE_GIF_FPS} fps${capped ? ' (capped)' : ''}`);
  } catch (e) {
    toast('Could not export the GIF: ' + e.message, 'error');
  } finally {
    lapseExporting = false;
    fxOrbHide('export');
    FxBeam.attach($('tmExportBtn'), { type: 'sm', active: false });
    drawTreemap(); // whatever happened, the status line goes back to the truth
  }
}

async function exportTimelapseWebm() {
  const h = state.treemap.history;
  if (lapseExporting) { toast('An export is already running', 'error'); return; }
  if (h.snaps.length < 2 || !isRectMap()) { toast('History export needs two snapshots and the rectangle map', 'error'); return; }
  // Feature-detected, never assumed — and the user is told which format runs.
  if (!('captureStream' in HTMLCanvasElement.prototype) || !window.MediaRecorder) {
    toast('This runtime cannot record video — use the GIF export instead', 'error');
    return;
  }
  lapseExporting = true;
  fxOrbShow('export', $('tmExportBtn').closest('.tb-group'), 'composing'); // FX: same pair as the GIF path
  FxBeam.attach($('tmExportBtn'), { type: 'sm', active: true });
  lapseStop();
  const L = state.treemap.lapse;
  const prevLoop = L.loop;
  let stream = null;
  try {
    const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9') ? 'video/webm;codecs=vp9' : 'video/webm';
    stream = $('treemapCanvas').captureStream(30);
    const rec = new MediaRecorder(stream, { mimeType: mime });
    const chunks = [];
    rec.ondataavailable = (ev) => { if (ev.data.size) chunks.push(ev.data); };
    const stopped = new Promise((resolve) => { rec.onstop = resolve; });
    toast('Recording one playback run as WebM (' + mime + ')');
    $('tmTimeSlider').value = String(h.snaps.length); // from the top
    L.loop = false; // one run is what was promised
    rec.start(200);
    const runEnded = new Promise((resolve) => { L.onDone = resolve; });
    lapseInternalStart = true;
    try { lapseStart(); } finally { lapseInternalStart = false; }
    if (!L.playing) { rec.stop(); await stopped; throw new Error('playback did not start'); }
    await runEnded; // natural end or the user stopping it — either ends the take
    rec.stop();
    await stopped;
    if (!chunks.length) throw new Error('the recorder produced no data');
    downloadBlob(new Blob(chunks, { type: mime }), exportFileName('webm'));
    // The toast tells a finished run from an interrupted one — claiming "one
    // full playback run" for a stopped take would be a lie (review RD10).
    toast(L.completed ? 'WebM saved — one full playback run' : 'WebM saved — a partial take; playback was stopped early');
  } catch (e) {
    toast('Could not export the WebM: ' + e.message, 'error');
  } finally {
    // The capture track is hardware in use — release it on EVERY exit,
    // including the throws above (review H2).
    if (stream) stream.getTracks().forEach((t) => t.stop());
    L.loop = prevLoop;
    // The export forced L.loop off for its one promised run; restoring the
    // flag without reflecting left the pill (and now its ring) claiming Off
    // while the state said On.
    lapseReflect();
    L.onDone = null;
    lapseExporting = false;
    fxOrbHide('export');
    FxBeam.attach($('tmExportBtn'), { type: 'sm', active: false });
  }
}

function exportTreemapPNG() {
  const out = document.createElement('canvas');
  out.width = tmBuffer.width;
  out.height = tmBuffer.height;
  const ctx = out.getContext('2d');
  ctx.fillStyle = cssVar('--bg-1') || '#0e0e13';
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(tmBuffer, 0, 0);
  if (!isSun() && state.treemap.query.trim()) ctx.drawImage(tmSearchBuffer, 0, 0); // sunburst has no overlay buffer
  out.toBlob((blob) => {
    if (!blob) { toast('PNG export failed', 'error'); return; }
    downloadBlob(blob, exportFileName('png'));
    toast('Treemap saved as PNG');
  }, 'image/png');
}

/**
 * The map as an SVG, drawn with the canvas's own recipe (review F1.3, F1.9):
 * each leaf the cushion pass 1 painted it with (r.stops — opaque, in the
 * colour mode on screen, eased under its label where it had to be), each
 * folder pass 2's dark outline and light rim, in the History diff pass
 * 2.5's wash over each folder that changed, and each label at the lines
 * and in the ink pass 4 chose (r.label, tmLabelInk). It once redrew the map
 * with the recipe G01 and G09 retired — every leaf faded by depth over the
 * page, in the size ramp whatever the colour mode, its labels fixed black.
 */
function exportTreemapSVG() {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(tmBuffer.width / dpr);
  const h = Math.round(tmBuffer.height / dpr);
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const rgb = (c) => `rgb(${c[0]},${c[1]},${c[2]})`;
  const defs = [];
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" font-family="-apple-system, 'Segoe UI', Helvetica, sans-serif">`,
    `<rect width="${w}" height="${h}" fill="${cssVar('--bg-1') || '#0e0e13'}"/>`,
  ];
  // Leaf fills (with native tooltips via <title>).
  for (const [i, r] of state.treemap.pxRects.entries()) {
    if (r.frame) continue;
    const box = `x="${(r.x + 0.5).toFixed(1)}" y="${(r.y + 0.5).toFixed(1)}" width="${Math.max(1, r.w - 1).toFixed(1)}" height="${Math.max(1, r.h - 1).toFixed(1)}"`;
    const title = `<title>${esc(r.n.path)} — ${esc(formatBytes(r.n.size))}</title>`;
    if (r.stops) {
      defs.push(`<linearGradient id="tm-c${i}" gradientUnits="userSpaceOnUse" x1="0" y1="${r.y}" x2="0" y2="${r.y + r.h}">` +
        `<stop offset="0" stop-color="${rgb(r.stops[0])}"/><stop offset="1" stop-color="${rgb(r.stops[1])}"/></linearGradient>`);
      parts.push(`<rect ${box} fill="url(#tm-c${i})" stroke="rgba(0,0,0,0.35)" stroke-width="1">${title}</rect>`);
    } else if (r.n.freed) {
      // Staged in the cart preview: an outline of what is not freed yet.
      parts.push(`<rect ${box} fill="none" stroke="${cssVar('--warn') || '#FF9F0A'}" stroke-dasharray="4 3" stroke-width="1">${title}</rect>`);
    } else {
      // A cloud placeholder, hollow as on the map: its bytes are not here.
      const c = r.n.isTrash ? [108, 122, 137] : cellRgb(r.n);
      parts.push(`<rect ${box} fill="${rgb(c)}" fill-opacity="0.16" stroke="rgba(${c[0]},${c[1]},${c[2]},0.85)" stroke-dasharray="4 3" stroke-width="1">${title}</rect>`);
    }
  }
  // Directory frames: a dark outline, heavier at the top level, and a light rim inside it.
  for (const r of state.treemap.pxRects) {
    if (!r.frame) continue;
    const top = r.n.depth <= 1;
    parts.push(
      `<rect x="${(r.x + 0.5).toFixed(1)}" y="${(r.y + 0.5).toFixed(1)}" width="${Math.max(0, r.w - 1).toFixed(1)}" height="${Math.max(0, r.h - 1).toFixed(1)}" ` +
      `fill="none" stroke="rgba(0,0,0,${top ? 0.6 : 0.42})" stroke-width="${top ? 1.5 : 1}"/>`
    );
    if (r.w > 4 && r.h > 4) {
      parts.push(
        `<rect x="${(r.x + 1.5).toFixed(1)}" y="${(r.y + 1.5).toFixed(1)}" width="${(r.w - 3).toFixed(1)}" height="${(r.h - 3).toFixed(1)}" ` +
        `fill="none" stroke="rgba(255,255,255,${Math.max(0.12, 0.3 - r.n.depth * 0.05).toFixed(2)})" stroke-width="1"/>`
      );
    }
  }
  // The History diff's wash over each folder that grew or shrank (pass 2.5):
  // the diff itself, and what each label's ink was chosen through (F2.1).
  for (const { r, rgb: c } of tmDiffWashes(state.treemap.pxRects)) {
    parts.push(
      `<rect x="${(r.x + 0.5).toFixed(1)}" y="${(r.y + 0.5).toFixed(1)}" width="${Math.max(1, r.w - 1).toFixed(1)}" height="${Math.max(1, r.h - 1).toFixed(1)}" ` +
      `fill="${rgb(c)}" fill-opacity="${TM_DIFF_WASH}"/>`
    );
  }
  // Labels — at the lines pass 4 wrote them, in the ink it chose. An SVG
  // text's y is its baseline, about 0.8 of the font size below its top.
  for (const r of state.treemap.pxRects) {
    if (!r.label || !r.label.length) continue;
    const [name, size] = r.label;
    const maxChars = Math.floor((r.w - 10) / 6.2);
    const label = r.n.name.length > maxChars ? r.n.name.slice(0, Math.max(1, maxChars - 1)) + '…' : r.n.name;
    parts.push(`<text x="${(r.x + 5).toFixed(1)}" y="${(name.y + name.px * 0.8).toFixed(1)}" font-size="${name.px}" font-weight="500" fill="${tmLabelInk(r, name.y, name.px, name.alpha)}">${esc(label)}</text>`);
    if (size) {
      parts.push(`<text x="${(r.x + 5).toFixed(1)}" y="${(size.y + size.px * 0.8).toFixed(1)}" font-size="${size.px}" fill="${tmLabelInk(r, size.y, size.px, size.alpha)}">${esc(formatBytes(r.n.size))}</text>`);
    }
  }
  // Top-level directory name tags.
  for (const r of state.treemap.pxRects) {
    if (!r.frame || r.n.depth !== 1 || r.w < 90 || r.h < 44) continue;
    const maxChars = Math.floor((r.w - 26) / 6.2);
    const label = r.n.name.length > maxChars ? r.n.name.slice(0, Math.max(1, maxChars - 1)) + '…' : r.n.name;
    const tagW = Math.min(r.w - 12, label.length * 6.2 + 14);
    parts.push(`<rect x="${(r.x + 5).toFixed(1)}" y="${(r.y + 5).toFixed(1)}" width="${tagW.toFixed(1)}" height="18" rx="9" fill="rgba(0,0,0,0.5)"/>`);
    parts.push(`<text x="${(r.x + 12).toFixed(1)}" y="${(r.y + 18).toFixed(1)}" font-size="10.5" font-weight="600" fill="rgba(255,255,255,0.92)">${esc(label)}</text>`);
  }
  if (defs.length) parts.splice(2, 0, `<defs>${defs.join('')}</defs>`);
  parts.push('</svg>');
  downloadBlob(new Blob([parts.join('\n')], { type: 'image/svg+xml' }), exportFileName('svg'));
  toast('Treemap saved as SVG');
}
