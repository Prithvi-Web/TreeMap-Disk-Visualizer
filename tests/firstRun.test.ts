import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.TREEMAP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-firstrun-test-'));
process.env.TREEMAP_NO_GDU = '1';

import { getSettings, updateSettings } from '../src/services/settings';

/**
 * v4 §9.2 — the guided first run.
 *
 * The tour's promises are stronger than its steps: it must never stage
 * anything itself (the user clicks), never present a suggestion the normal
 * engine would not make (it reads /api/cleanup/suggestions and nothing
 * else), be skippable at every step, and never come back once completed —
 * with the flag persisted through settings.json so a read-only portable
 * session, which persists nothing, honestly shows it again.
 */

const INDEX = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

/* ══════════════════════ The flag ══════════════════════ */

test('tourDone defaults to false, persists true, and refuses junk', async () => {
  const fresh = await getSettings();
  assert.equal(fresh.tourDone, false, 'a new install has not seen the tour');
  const done = await updateSettings({ tourDone: true });
  assert.equal(done.tourDone, true);
  const kept = await updateSettings({ forecastThresholdDays: 30 });
  assert.equal(kept.tourDone, true, 'an unrelated save keeps it');
  const junk = await updateSettings({ tourDone: 'yes' });
  assert.equal(junk.tourDone, false, 'only boolean true counts — a truthy string must not silence the tour');
  await updateSettings({ tourDone: false });
});

/* ══════════════════════ The overlay, structurally ══════════════════════ */

test('the tour exists, is a dialog, and every step can be skipped', () => {
  assert.ok(INDEX.includes('id="tourOverlay"'), 'the overlay exists');
  const tag = INDEX.slice(INDEX.indexOf('id="tourOverlay"') - 250, INDEX.indexOf('id="tourOverlay"') + 250);
  assert.match(tag, /role="dialog"/);
  const js = INDEX.slice(INDEX.indexOf('function tourRender'), INDEX.indexOf('function tourRender') + 9000);
  assert.match(js, /data-tour-skip/, 'a skip control is rendered');
  // Skipping and finishing both persist the flag — the tour never returns
  // uninvited after either.
  const finish = INDEX.slice(INDEX.indexOf('async function tourFinish'), INDEX.indexOf('async function tourFinish') + 700);
  assert.match(finish, /tourDone: true/, 'finish persists the flag');
  assert.match(finish, /\/api\/settings/, 'through the settings endpoint (portable mode then keeps it in memory only)');
});

test('the tour never stages, deletes, or invents — the user clicks, the engine suggests', () => {
  const start = INDEX.indexOf('/* ───────────────────── v4 §9.2');
  assert.notEqual(start, -1, 'the tour block is banner-commented like the rest of Phase 9');
  const block = INDEX.slice(start, INDEX.indexOf('/* ───────────── end §9.2', start));
  assert.ok(block.length > 2000, 'the tour block was located whole');
  // Suggestions come from the normal engine, nothing else.
  assert.match(block, /\/api\/cleanup\/suggestions/, 'wins come from the real suggestion engine');
  // Advisory groups have no delete path anywhere in the app; the tour must
  // not offer to stage them either.
  // Matched on the CODE literal, not the word: the first review round proved
  // by mutation that /advisory/ matched the adjacent comment and the filter
  // could be deleted without a failure. `!g.advisory` only exists in code.
  assert.match(block, /!g\.advisory/, 'advisory groups are filtered out — in code, not in a comment');
  // Staging happens only inside a click handler, through cartAddMany — a bulk
  // door on the ONE cart, living beside cartToggle and running the same
  // save/render pipeline once instead of per item. Deletion is nowhere.
  assert.match(block, /cartAddMany\(/, 'staging rides the shared cart pipeline');
  const bulk = INDEX.slice(INDEX.indexOf('function cartAddMany'), INDEX.indexOf('function cartAddMany') + 800);
  for (const fn of ['saveCart()', 'renderCart()', 'refreshCartButtons()', 'cartPreviewInvalidated()']) {
    assert.ok(bulk.includes(fn), `cartAddMany runs ${fn} — the same pipeline as cartToggle, once`);
  }
  assert.ok(!block.includes('cartTrashAll'), 'the tour cannot commit the cart');
  assert.ok(!/api\('\/api\/files'/.test(block), 'the tour cannot delete');
  assert.ok(!block.includes('confirmTrash'), 'not even via the confirm dialog');
});

test('an empty disk gets honesty, not invented wins', () => {
  const block = INDEX.slice(INDEX.indexOf('/* ───────────────────── v4 §9.2'), INDEX.indexOf('/* ───────────── end §9.2'));
  assert.match(block, /looks clean/, 'no suggestions → the tour says so and ends, rather than inventing a win');
});

test('the tour only appears for a first run, and rides the boot settings read', () => {
  const boot = INDEX.slice(INDEX.indexOf('async function loadCartGoal'), INDEX.indexOf('async function loadCartGoal') + 900);
  assert.match(boot, /tourMaybeStart\(s\.tourDone/, 'the boot settings fetch decides — no second request');
});

test('the welcome card never focuses a hidden input — found by driving the zero-state', () => {
  // Before any scan the top path box is offscreen; focus() on it is a silent
  // no-op and the tour's "pick my own" button would do nothing. The handler
  // must fall back to the zero-state's own folder browser.
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const pick = html.indexOf("querySelector('[data-tour-pick]')");
  assert.notEqual(pick, -1, 'the pick-my-own handler exists');
  const handler = html.slice(pick, pick + 700);
  assert.match(handler, /offsetParent === null/, 'visibility is checked, not assumed');
  assert.match(handler, /openBrowse\(null\)/, 'the hidden case opens the folder browser instead');
});

test('one Escape never closes a dialog AND skips the tour', () => {
  // Same promise, stronger architecture after review round 1: the skip now
  // lives at the END of the app-wide Escape chain, so any press an earlier
  // branch claims — modal, menu, preview, climb-out — returns before the
  // tour branch is ever reached.
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const chain = html.slice(html.indexOf("const openModal = document.querySelector('.modal-backdrop.open')"));
  // closeModal(), not a bare class removal: the funnel carries per-modal
  // teardown (the Settings sheet clears its cloud-connect poll + orb there).
  const modalBranch = chain.indexOf('closeModal(openModal.id)');
  const tourBranch = chain.indexOf("tour.active && !$('tourOverlay').hidden");
  assert.ok(modalBranch !== -1 && tourBranch !== -1 && modalBranch < tourBranch,
    'closing a dialog returns before the tour branch is reached');
  assert.match(chain.slice(tourBranch, tourBranch + 220), /nlPop/, 'an open plain-words popover blocks the skip too');
});

test('the tour card never steals focus from a text field', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const at = html.indexOf('const primary = host.querySelector');
  const around = html.slice(at - 500, at + 300);
  assert.match(around, /INPUT\|TEXTAREA\|SELECT/, 'the active element is checked');
  assert.match(around, /!typing\) primary\.focus\(\)/, 'focus only moves when nobody is typing');
});

test("the wins step never reads a non-answer as clean — polls, and shows refusals", () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const fn = html.slice(html.indexOf('async function tourLoadWins'), html.indexOf('async function tourLoadWins') + 1600);
  assert.match(fn, /poll: true/, 'a still-running scan is waited out, not misread as empty');
  assert.match(fn, /available === false/, "a broken rule catalog becomes 'couldn\u2019t check', with its reason");
  assert.match(fn, /catch \(e\)/, 'so does a transport error');
  assert.ok(!/catch \{ groups = \[\]; \}/.test(fn), 'the silent-empty catch is gone');
  const card = html.slice(html.indexOf("tour.step === 'unknown'"), html.indexOf("tour.step === 'unknown'") + 900);
  assert.match(card, /Couldn/, 'the unknown card says could-not-check, never clean');
  assert.match(card, /escapeHtml\(tour\.unknownReason/, 'and shows the reason, escaped');
});

test('Escape has one meaning: the tour skip is the LAST branch of the app-wide chain', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  // The dedicated tour listener is gone…
  assert.ok(!/addEventListener\('keydown', \(e\) => \{\n  if \(e\.key === 'Escape' && tour\.active/.test(html),
    'no separate tour Escape listener survives');
  // …and inside the big chain, every established meaning comes first.
  const chain = html.slice(html.indexOf("const openModal = document.querySelector('.modal-backdrop.open')"));
  const tourAt = chain.indexOf('tour.active && !$(\'tourOverlay\').hidden');
  assert.notEqual(tourAt, -1, 'the tour branch lives in the chain');
  for (const earlier of ['hideCtxMenu()', 'closePreview()', 'exitCartPreview()', 'treemapUp()', 'cityUp()', 'gridUp()']) {
    const at = chain.indexOf(earlier);
    assert.ok(at !== -1 && at < tourAt, `${earlier} outranks the tour skip`);
  }
  const branch = chain.slice(tourAt, tourAt + 300);
  assert.match(branch, /!typing/, 'and Esc from inside a text field never skips the tour');
});

test('the palette closes through its own door from every path — focus restore included', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.match(html, /openModal\.id === 'cmdkModal'\) \{ cmdkClose\(\); return; \}/,
    'the generic Escape path special-cases the palette');
  assert.match(html, /#cmdkModal \{[^}]*z-index: 130/, 'the palette paints above the other modals');
  const scoped = html.slice(html.indexOf("$('cmdkModal').addEventListener('keydown'"), html.indexOf("$('cmdkModal').addEventListener('keydown'") + 600);
  assert.match(scoped, /stopPropagation\(\)/, "palette keys are the palette's — they never reach dupeViewerKeys or the view shortcuts");
});
