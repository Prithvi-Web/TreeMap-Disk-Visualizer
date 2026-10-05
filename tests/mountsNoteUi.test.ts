import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-mountsNoteUi-data-');

import { INDEX, lift } from './fixtures/liftFrontend';

/**
 * Track U, U-27: the Dashboard names the drives mounted inside the scanned
 * folder that a scan did not enter (or, under "Include drives mounted inside
 * it", the ones it counted, or why it could not tell), and Settings holds the
 * rule as two radios. The markup is asserted on the shipped page; the
 * sentence-maker is lifted out of it; the note, its loader and the Settings
 * row are evaluated as regions with their dependencies injected, so the real
 * wiring runs.
 */

/* ══════════════ helpers ══════════════ */

function slice(a: string, b: string): string {
  const i = INDEX.indexOf(a);
  assert.notEqual(i, -1, `anchor "${a}" exists in index.html`);
  const j = INDEX.indexOf(b, i + a.length);
  assert.notEqual(j, -1, `anchor "${b}" follows it`);
  return INDEX.slice(i, j);
}

type Note = { text: string; settings: boolean } | null;
const mountsNoteText = lift<(b: unknown, root: string) => Note>(['UI_LOCALE', 'formatCount', 'lastPathSegment', 'mountsNoteText'], 'mountsNoteText');

interface Mount { path: string; filesystem: string; source: string; reached: boolean; entered: boolean; bytes: number | null; sourceListed: boolean }

const disk = (p: string, over: Partial<Mount> = {}): Mount => ({ path: p, filesystem: 'apfs', source: '/dev/disk7s1', reached: true, entered: false, bytes: null, sourceListed: false, ...over });

/** A /boundary answer under stay with these drives not entered, in the route's order (sorted by path). */
function stay(mounts: Mount[]): Record<string, unknown> {
  const sorted = [...mounts].sort((a, b) => (a.path < b.path ? -1 : 1));
  const not = sorted.filter((m) => m.reached && !m.entered);
  return {
    scanId: 's1', rule: 'stay', source: 'mount', reason: null,
    notEntered: { count: not.length, examples: not.slice(0, 5).map((m) => m.path) },
    entered: { count: 0, examples: [], bytes: 0 },
    crossedUnlisted: { count: 0, examples: [] },
    mountsListed: sorted.length,
    mounts: sorted,
  };
}

const SIM = '/Library/Developer/CoreSimulator/Volumes';

/* ══════════════ the markup ══════════════ */

test('the Dashboard has the note beside the refused-folder row: hidden, a polite live region, with a Change in Settings button', () => {
  const access = INDEX.indexOf('id="accessRow"');
  const note = INDEX.indexOf('id="mountsNote"');
  assert.ok(access !== -1 && note > access, 'the note follows the refused-folder row');
  const row = slice('id="mountsNote"', 'Change in Settings');
  assert.match(INDEX, /<div class="access-row" id="mountsNote" role="status" aria-live="polite" hidden>/);
  assert.match(row, /id="mountsNoteText"/);
  assert.match(INDEX, /<button class="btn" id="mountsNoteSettingsBtn"[^>]*>Change in Settings<\/button>/);
});

test('Settings has the section: two labelled radios, Stay on this drive checked, and the help line', () => {
  const modal = slice('<div class="modal-backdrop" id="settingsModal"', 'id="settingsSaveBtn"');
  assert.match(modal, /class="set-h"[^>]*>(?:<span[^>]*><\/span>)?Drives mounted inside a folder<\/div>/);
  assert.match(modal, /<div id="scanBoundary" role="radiogroup" aria-label="Drives mounted inside a folder">/);
  assert.match(modal, /<input type="radio" name="scanBoundary" id="scanBoundary-stay" value="stay" checked>\s*<span class="budget-name">Stay on this drive<\/span>/);
  assert.match(modal, /<input type="radio" name="scanBoundary" id="scanBoundary-cross" value="cross">\s*<span class="budget-name">Include drives mounted inside it<\/span>/);
  assert.match(modal, /<label class="rule-row budget-row" for="scanBoundary-stay">/);
  assert.match(modal, /<label class="rule-row budget-row" for="scanBoundary-cross">/);
  assert.ok(modal.includes('A disk image or drive mounted inside the folder you scan is a separate disk. Staying on this drive keeps the totals true to the disk you chose.'), 'the help line, verbatim');
  const sections = INDEX.slice(INDEX.indexOf('const CMDK_SETTINGS_SECTIONS'), INDEX.indexOf('];', INDEX.indexOf('const CMDK_SETTINGS_SECTIONS')));
  assert.match(sections, /\{ name: 'Drives mounted inside a folder', hint: '[^']*mount[^']*' \}/, 'the palette finds it');
});

/* ══════════════ the sentence ══════════════ */

test('two separate disks not entered: both names, why, and the way to Settings', () => {
  const note = mountsNoteText(stay([disk(`${SIM}/iOS_23F77`), disk(`${SIM}/iOS_22E238`)]), '/');
  assert.deepEqual(note, {
    text: '2 drives mounted inside this folder were not scanned — iOS_22E238, iOS_23F77. They are separate disks, so their files are not part of this disk’s total.',
    settings: true,
  });
});

test('one disk reads in the singular; seven name five, then how many more', () => {
  assert.equal(mountsNoteText(stay([disk(`${SIM}/iOS_22E238`)]), '/')?.text, '1 drive mounted inside this folder was not scanned — iOS_22E238. It is a separate disk, so its files are not part of this disk’s total.');
  const seven = Array.from({ length: 7 }, (_, i) => disk(`/r/d${i + 1}`));
  assert.equal(mountsNoteText(stay(seven), '/r')?.text, '7 drives mounted inside this folder were not scanned — d1, d2, d3, d4, d5 and 2 more. They are separate disks, so their files are not part of this disk’s total.');
});

test('a nullfs or bind mount is a second view of a folder: already counted when the scan listed it, not counted here when it did not', () => {
  const view = (sourceListed: boolean): Mount => disk('/private/var/folders/zz/P/X/4B95', { filesystem: 'nullfs', source: '/Applications/Clocks.app/Wrapper', sourceListed });
  assert.equal(mountsNoteText(stay([view(true)]), '/')?.text, '1 drive mounted inside this folder was not scanned — 4B95. It is a second view of a folder already counted, so it was not counted again.');
  assert.equal(mountsNoteText(stay([view(false)]), '/private/var/folders/zz/P')?.text, '1 drive mounted inside this folder was not scanned — 4B95. It is a second view of another folder, so it was not counted here.');
});

test('a view of a folder inside the scanned one that the scan did not list — under /Volumes, or on a drive it did not enter — is not "already counted" (TS review R10)', () => {
  // An app run from a disk image: macOS shows it again at a translocation point, its source under /Volumes.
  const fromImage = disk('/private/var/folders/zz/P/AppTranslocation/U/d', { filesystem: 'nullfs', source: '/Volumes/Installer/Tool.app', sourceListed: false });
  assert.equal(mountsNoteText(stay([fromImage]), '/')?.text, '1 drive mounted inside this folder was not scanned — d. It is a second view of another folder, so it was not counted here.');
});

test('the diagnosis Mac’s shape — three disks and one nullfs view — says both', () => {
  const note = mountsNoteText(stay([
    disk('/Library/Developer/CoreSimulator/Cryptex/Images/bundle/SimRuntimeBundle-AC21E6AE'),
    disk(`${SIM}/iOS_22E238`),
    disk(`${SIM}/iOS_23F77`),
    disk('/private/var/folders/zz/P/X/4B95', { filesystem: 'nullfs', source: '/Applications/Clocks.app/Wrapper', sourceListed: true }),
  ]), '/');
  assert.equal(note?.text, '3 drives mounted inside this folder were not scanned — SimRuntimeBundle-AC21E6AE, iOS_22E238, iOS_23F77. They are separate disks, so their files are not part of this disk’s total. Also not scanned: 4B95, a second view of a folder already counted.');
});

test('under cross: the drives the scan counted, though they are not on this disk', () => {
  const b = {
    scanId: 's1', rule: 'cross', source: 'mount', reason: null,
    notEntered: { count: 0, examples: [] },
    entered: { count: 2, examples: [`${SIM}/iOS_22E238`, `${SIM}/iOS_23F77`], bytes: 37_000_000_000 },
    crossedUnlisted: { count: 0, examples: [] }, mountsListed: 2,
    mounts: [disk(`${SIM}/iOS_22E238`, { entered: true }), disk(`${SIM}/iOS_23F77`, { entered: true })],
  };
  assert.deepEqual(mountsNoteText(b, '/'), { text: 'This scan includes 2 drives mounted inside it — iOS_22E238, iOS_23F77. Their files are counted, though they are not on this disk.', settings: true });
  assert.equal(mountsNoteText({ ...b, entered: { count: 0, examples: [], bytes: 0 }, mounts: [] }, '/'), null, 'nothing mounted inside: nothing to say');
});

test('a mount table TreeMap could not read: it says so, with the reason, and offers no setting to change', () => {
  const b = { scanId: 's1', rule: 'stay', source: 'mount', reason: '/sbin/mount did not answer within 5 s', notEntered: null, entered: null, crossedUnlisted: { count: 0, examples: [] }, mountsListed: null, mounts: null };
  assert.deepEqual(mountsNoteText(b, '/'), {
    text: 'TreeMap could not read the list of mounted drives (/sbin/mount did not answer within 5 s), so a drive mounted inside this folder may have been counted as part of it.',
    settings: false,
  });
});

test('nothing to say is no note: no drive inside, a record without a boundary, no answer', () => {
  assert.equal(mountsNoteText(stay([]), '/'), null);
  assert.equal(mountsNoteText({ scanId: 's1', rule: null, source: null, reason: 'this scan was made without a mount boundary', notEntered: null, entered: null, crossedUnlisted: null, mountsListed: null, mounts: null }, '/'), null);
  assert.equal(mountsNoteText(null, '/'), null);
  // A mount under a folder no walk descends into was never reached: it is not a drive the scan chose to stay out of.
  assert.equal(mountsNoteText(stay([disk('/Volumes/Backup', { reached: false })]), '/'), null);
});

/* ══════════════ the row, its loader and its button ══════════════ */

interface FakeEl { hidden: boolean; textContentWrites: string[]; innerHTMLWrites: string[]; listeners: Record<string, () => void>; textContent: string; innerHTML: string; addEventListener(t: string, fn: () => void): void }

function fakeEl(): FakeEl {
  const el = {
    hidden: true,
    textContentWrites: [] as string[],
    innerHTMLWrites: [] as string[],
    listeners: {} as Record<string, () => void>,
    addEventListener(t: string, fn: () => void) { el.listeners[t] = fn; },
  } as unknown as FakeEl;
  Object.defineProperty(el, 'textContent', { get: () => el.textContentWrites.at(-1) ?? '', set: (v: string) => { el.textContentWrites.push(v); } });
  Object.defineProperty(el, 'innerHTML', { get: () => el.innerHTMLWrites.at(-1) ?? '', set: (v: string) => { el.innerHTMLWrites.push(v); } });
  return el;
}

/** The note's region, evaluated with its dependencies injected. */
function noteRuntime(api: (url: string) => Promise<unknown>, state: { scanId: string | null; root: { path: string } | null }) {
  const src = slice('/* ── Drives mounted inside the folder ── */', '/* ── end drives mounted inside ── */');
  const els: Record<string, FakeEl> = { mountsNote: fakeEl(), mountsNoteText: fakeEl(), mountsNoteSettingsBtn: fakeEl() };
  const subscribers: ((scanId: string | null) => void)[] = [];
  const opened: string[] = [];
  const formatCount = lift<(n: unknown) => string>(['UI_LOCALE', 'formatCount'], 'formatCount');
  const lastPathSegment = lift<(p: string) => string>(['lastPathSegment'], 'lastPathSegment');
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const rt = new Function(
    '$', 'api', 'state', 'subscribe', 'TOPIC', 'formatCount', 'lastPathSegment', 'cmdkOpenSettingsSection',
    `'use strict'; ${src}\nreturn { renderMountsNote, loadBoundary };`,
  )(
    (id: string) => els[id] ?? null, api, state, (_topic: string, fn: (scanId: string | null) => void) => { subscribers.push(fn); },
    { scan: 'scan' }, formatCount, lastPathSegment, (name: string) => { opened.push(name); },
  ) as { renderMountsNote: (b: unknown) => void; loadBoundary: (scanId: string) => Promise<void> };
  return { ...rt, els, subscribers, opened };
}

test('the row shows the sentence as text — a drive named like markup is shown, never parsed — and hides when there is nothing to say', () => {
  const rt = noteRuntime(async () => null, { scanId: 's1', root: { path: '/' } });
  rt.renderMountsNote(stay([disk(`${SIM}/<img src=x onerror=alert(1)>`), disk(`${SIM}/iOS_22E238`)]));
  assert.equal(rt.els.mountsNote.hidden, false);
  assert.match(rt.els.mountsNoteText.textContent, /<img src=x onerror=alert\(1\)>/, 'the name, as text');
  assert.deepEqual(rt.els.mountsNoteText.innerHTMLWrites, [], 'nothing is written as markup');
  assert.equal(rt.els.mountsNoteSettingsBtn.hidden, false);
  rt.renderMountsNote(stay([]));
  assert.equal(rt.els.mountsNote.hidden, true);
  rt.renderMountsNote({ scanId: 's1', rule: 'stay', source: 'mount', reason: 'no answer', notEntered: null, entered: null, crossedUnlisted: { count: 0, examples: [] }, mountsListed: null, mounts: null });
  assert.equal(rt.els.mountsNote.hidden, false);
  assert.equal(rt.els.mountsNoteSettingsBtn.hidden, true, 'an unreadable table is not a setting to change');
});

test('the boundary is asked for once a scan has painted (TOPIC.scan with its id), once per scan, and an answer for a scan no longer on screen is dropped', async () => {
  const calls: string[] = [];
  let answer: (v: unknown) => void = () => {};
  const state = { scanId: 's1' as string | null, root: { path: '/' } };
  const rt = noteRuntime((url) => { calls.push(url); return new Promise((r) => { answer = r; }); }, state);
  assert.equal(rt.subscribers.length, 1, 'it listens for a scan landing on screen');
  rt.subscribers[0](null);
  assert.deepEqual(calls, [], 'the index-first paint has no scan: nothing is asked');
  assert.equal(rt.els.mountsNote.hidden, true);
  rt.subscribers[0]('s1');
  rt.subscribers[0]('s1');
  assert.deepEqual(calls, ['/api/scan/s1/boundary'], 'once, however often the scan is announced');
  state.scanId = 's2';
  answer(stay([disk(`${SIM}/iOS_22E238`)]));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(rt.els.mountsNote.hidden, true, 'a newer scan owns the Dashboard now');
});

test('the boundary is never asked for before the tree is painted: finishScan does not, the scan listener does', () => {
  const finish = INDEX.slice(INDEX.indexOf('async function finishScan('), INDEX.indexOf('async function loadDashboardLists('));
  assert.doesNotMatch(finish, /loadBoundary|\/boundary/, 'nothing in the paint path asks');
  const region = slice('/* ── Drives mounted inside the folder ── */', '/* ── end drives mounted inside ── */');
  assert.match(region, /subscribe\(TOPIC\.scan, \(scanId\) => \{/, 'the listener runs when finishScan announces the painted scan');
  assert.match(region, /api\(`\/api\/scan\/\$\{encodeURIComponent\(scanId\)\}\/boundary`\)/);
});

test('Change in Settings opens Settings at the section', () => {
  const rt = noteRuntime(async () => null, { scanId: 's1', root: { path: '/' } });
  const click = rt.els.mountsNoteSettingsBtn.listeners.click;
  assert.ok(click, 'the button is wired');
  click();
  assert.deepEqual(rt.opened, ['Drives mounted inside a folder']);
});

/* ══════════════ Settings ══════════════ */

type Radio = { id: string; value: string; checked: boolean; listeners: Record<string, () => void>; addEventListener(t: string, fn: () => void): void };

function settingsRuntime(api: (url: string, options?: { method?: string; body?: string }) => Promise<unknown>, settingsData: { scanBoundary?: string }) {
  const src = slice('/* ── Drives mounted inside a folder (Track U, U-27) ──', '/* ── Cloud accounts (Feature 25) ── */');
  const radios: Radio[] = ['stay', 'cross'].map((v) => {
    const r: Radio = { id: `scanBoundary-${v}`, value: v, checked: v === 'stay', listeners: {}, addEventListener(t, fn) { r.listeners[t] = fn; } };
    return r;
  });
  const toasts: { msg: string; kind: string }[] = [];
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const rt = new Function(
    'api', '$', 'toast', 'settingsData',
    `'use strict'; ${src}\nreturn { renderScanBoundary, saveScanBoundary, settings: () => settingsData };`,
  )(api, (id: string) => radios.find((r) => r.id === id) ?? null, (msg: string, kind = 'success') => { toasts.push({ msg, kind }); }, settingsData) as {
    renderScanBoundary: (r: unknown) => void; saveScanBoundary: (r: string) => Promise<void>; settings: () => { scanBoundary?: string };
  };
  const checked = (): string[] => radios.filter((r) => r.checked).map((r) => r.value);
  const pick = async (v: string): Promise<void> => {
    for (const r of radios) r.checked = r.value === v;
    radios.find((r) => r.value === v)!.listeners.change();
    await new Promise((r) => setTimeout(r, 0));
  };
  return { ...rt, checked, pick, toasts };
}

test('opening Settings shows the stored rule; picking one PUTs { scanBoundary } and re-renders from the answer', async () => {
  const opener = INDEX.slice(INDEX.indexOf("$('settingsBtn').addEventListener('click', async () => {"), INDEX.indexOf('/* ── Scan engine'));
  assert.match(opener, /renderScanBoundary\(settingsData\.scanBoundary\)/, 'the sheet shows the stored choice when it opens');
  const calls: { url: string; body: unknown; method?: string }[] = [];
  const rt = settingsRuntime(async (url, options) => {
    calls.push({ url, method: options?.method, body: JSON.parse(options?.body ?? 'null') });
    return { ignore: [], schedules: [], ...JSON.parse(options?.body ?? '{}') };
  }, { scanBoundary: 'stay' });
  rt.renderScanBoundary('cross');
  assert.deepEqual(rt.checked(), ['cross']);
  rt.renderScanBoundary('bogus');
  assert.deepEqual(rt.checked(), ['stay'], 'a value the page does not know reads as the default');
  await rt.pick('cross');
  assert.deepEqual(calls, [{ url: '/api/settings', method: 'PUT', body: { scanBoundary: 'cross' } }], 'one save, the one key');
  assert.deepEqual(rt.checked(), ['cross']);
  assert.equal(rt.settings().scanBoundary, 'cross');
  assert.match(rt.toasts[0]?.msg ?? '', /Include drives mounted inside it — from the next scan/);
});

test('a failed save puts the radio back on the stored rule and says why', async () => {
  const rt = settingsRuntime(async () => { throw new Error('"scanBoundary" must be "stay" or "cross"'); }, { scanBoundary: 'stay' });
  rt.renderScanBoundary('stay');
  await rt.pick('cross');
  assert.deepEqual(rt.checked(), ['stay']);
  assert.equal(rt.toasts.length, 1);
  assert.equal(rt.toasts[0].kind, 'error');
  assert.match(rt.toasts[0].msg, /must be "stay" or "cross"/);
});
