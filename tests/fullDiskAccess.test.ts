import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { fileTempDir, isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-fullDiskAccess-data-');

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildMcpServer } from '../src/mcp/server';

import { INDEX } from './fixtures/liftFrontend';
import {
  probeFullDiskAccess, fullDiskAccessCapability, type FdaProbe,
} from '../src/platform/macos/fullDiskAccess';
import { accessAdvice, granteeFor, type Grantee } from '../src/utils/accessAdvice';
import { rememberFdaState, lastFdaState, type FdaState } from '../src/utils/fdaState';
import { getCapabilities, invalidateCapabilities } from '../src/platform/capabilities';
import { capabilitySummary } from '../src/api/platformRoutes';
import { permissionDeniedMessage } from '../src/middleware/errorHandler';
import { describeFsError } from '../src/utils/errno';
import { refusedPermissionNote } from '../src/services/missingGigabytes';
import { startScan } from '../src/services/diskScanner';
import { waitFor } from './fixtures/waitFor';

/**
 * Track U, U-11: TreeMap knows whether Full Disk Access is on, and says the
 * true thing.
 *
 * Before this, every refusal on a Mac was answered "Give TreeMap Full Disk
 * Access": an EACCES (the folder's own permissions, which Full Disk Access
 * does not touch) included, a Mac that already had it included, and in web
 * mode (`npm start`) naming TreeMap, when the grant belongs to the app that
 * started the server. Now one probe says whether it is on, one builder
 * (`accessAdvice`) writes every server sentence about it, and the page
 * shows the server's sentence for the state it probed.
 */

/* ══════════════════ the probe ══════════════════ */

const HOME = '/Users/someone';
/**
 * The two folders the probe may open, written out rather than imported: built
 * from the product's own constants, a probe aimed at the wrong folder (or a
 * typo in the name) answered every test here and said "granted" on a Mac
 * without access (review F1.6). These are the plan's paths, verbatim.
 */
const SYSTEM_TCC = '/Library/Application Support/com.apple.TCC';
const USER_TCC = '/Users/someone/Library/Application Support/com.apple.TCC';

const errno = (code: string): NodeJS.ErrnoException => Object.assign(new Error(`${code}: from the test`), { code });

/** A fake `opendir`: each path answers with an errno or opens a directory whose closes and reads are counted. */
function fakeFs(answers: Record<string, string | 'open'>) {
  const opened: string[] = [];
  const counts = { close: 0, read: 0 };
  const opendir = async (p: string) => {
    opened.push(p);
    const answer = answers[p];
    if (answer === undefined) throw new Error(`the probe asked about a folder the test did not expect: ${p}`);
    if (answer !== 'open') throw errno(answer);
    const dir = {
      close: async () => { counts.close++; },
      read: async () => { counts.read++; return null; },
      readSync: () => { counts.read++; return null; },
      [Symbol.asyncIterator]: () => { counts.read++; return { next: async () => ({ done: true, value: undefined }) }; },
    };
    return dir;
  };
  return { deps: { platform: 'darwin' as NodeJS.Platform, homedir: () => HOME, opendir }, opened, counts };
}

test('the probe: EPERM on the system TCC folder is not-granted, and the per-user folder is never opened', async () => {
  const f = fakeFs({ [SYSTEM_TCC]: 'EPERM', [USER_TCC]: 'open' });
  const probe = await probeFullDiskAccess(f.deps);
  assert.equal(probe.state, 'not-granted');
  assert.deepEqual(f.opened, [SYSTEM_TCC], 'the system folder first, and its EPERM is the answer');
});

test('the probe: ENOENT on the system folder, then EPERM on the per-user one, is not-granted', async () => {
  const f = fakeFs({ [SYSTEM_TCC]: 'ENOENT', [USER_TCC]: 'EPERM' });
  assert.equal((await probeFullDiskAccess(f.deps)).state, 'not-granted');
  assert.deepEqual(f.opened, [SYSTEM_TCC, USER_TCC]);
});

test('the probe: a folder that opens is granted — closed once, and not one entry read', async () => {
  const f = fakeFs({ [SYSTEM_TCC]: 'open', [USER_TCC]: 'EPERM' });
  assert.equal((await probeFullDiskAccess(f.deps)).state, 'granted');
  assert.deepEqual(f.opened, [SYSTEM_TCC]);
  assert.equal(f.counts.close, 1, 'the directory is closed once');
  assert.equal(f.counts.read, 0, 'and nothing in it is read');
  const late = fakeFs({ [SYSTEM_TCC]: 'ENOENT', [USER_TCC]: 'open' });
  assert.equal((await probeFullDiskAccess(late.deps)).state, 'granted', 'the per-user folder opening is a yes too');
  assert.equal(late.counts.close, 1);
  assert.equal(late.counts.read, 0);
});

test('the probe: ENOENT on both is unknown, naming the errno — never not-granted', async () => {
  const f = fakeFs({ [SYSTEM_TCC]: 'ENOENT', [USER_TCC]: 'ENOENT' });
  const probe = await probeFullDiskAccess(f.deps);
  assert.equal(probe.state, 'unknown');
  assert.match((probe as { reason: string }).reason, /ENOENT/, 'the reason names what the folders answered');
  const odd = fakeFs({ [SYSTEM_TCC]: 'EIO', [USER_TCC]: 'ENOENT' });
  const oddProbe = await probeFullDiskAccess(odd.deps);
  assert.equal(oddProbe.state, 'unknown');
  assert.match((oddProbe as { reason: string }).reason, /EIO/);
});

test('the probe never opens Desktop, Documents or Downloads (each raises a macOS prompt), nor anything off macOS', async () => {
  for (const answers of [
    { [SYSTEM_TCC]: 'EPERM' }, { [SYSTEM_TCC]: 'open' },
    { [SYSTEM_TCC]: 'ENOENT', [USER_TCC]: 'ENOENT' }, { [SYSTEM_TCC]: 'ENOENT', [USER_TCC]: 'open' },
  ] as Array<Record<string, string>>) {
    const f = fakeFs(answers);
    await probeFullDiskAccess(f.deps);
    for (const p of f.opened) {
      assert.ok([SYSTEM_TCC, USER_TCC].includes(p), `only the two TCC folders are opened, not ${p}`);
      assert.doesNotMatch(p, /\/(Desktop|Documents|Downloads)(\/|$)/);
    }
  }
  for (const platform of ['win32', 'linux'] as NodeJS.Platform[]) {
    const f = fakeFs({});
    const probe = await probeFullDiskAccess({ ...f.deps, platform });
    assert.equal(probe.state, 'unavailable', `${platform}: Full Disk Access is a macOS setting`);
    assert.deepEqual(f.opened, [], `${platform}: nothing is opened`);
  }
});

/* ══════════════════ the capability ══════════════════ */

const DESKTOP: Grantee = granteeFor({ electron: '37.0.0' }, {});
const WEB: Grantee = granteeFor({}, {});

test('the capability is available only when granted; unknown and not-granted are unavailable with a reason; off macOS it is a macOS setting', () => {
  const cases: Array<[FdaProbe, boolean, FdaState]> = [
    [{ state: 'granted', answeredBy: SYSTEM_TCC }, true, 'granted'],
    [{ state: 'not-granted', answeredBy: SYSTEM_TCC }, false, 'not-granted'],
    [{ state: 'unknown', reason: 'the two folders it checks answered ENOENT and ENOENT' }, false, 'unknown'],
  ];
  for (const [probe, available, state] of cases) {
    const cap = fullDiskAccessCapability(probe, DESKTOP);
    assert.equal(cap.available, available, `${state}: available is ${available}`);
    assert.equal(cap.state, state);
    assert.equal(cap.grantee, 'TreeMap');
    assert.ok(cap.mechanism.length > 0, 'it names its mechanism, as every capability does');
    assert.equal(cap.advice, accessAdvice({ code: null, state, grantee: DESKTOP, retry: 'scan again' }), `${state}: the page's hint is the builder's sentence for a refused count`);
    if (!available) {
      assert.ok(cap.reason && cap.reason.length > 20, `${state}: unavailable says why`);
      assert.match(cap.reason!, /[a-z]\s[a-z]/i, 'in prose');
    } else {
      assert.equal(cap.reason, undefined, 'granted needs no reason');
    }
  }
  assert.match(fullDiskAccessCapability({ state: 'unknown', reason: 'the two folders it checks answered ENOENT and ENOENT' }, DESKTOP).reason!, /ENOENT/, 'unknown carries the errno');
  const off = fullDiskAccessCapability({ state: 'unavailable', reason: 'not macOS' }, WEB);
  assert.equal(off.available, false);
  assert.match(off.reason!, /macOS setting/);
  assert.equal(off.advice, undefined, 'off macOS there is no advice to give');
  assert.equal(capabilitySummary({ fullDiskAccess: fullDiskAccessCapability({ state: 'unknown', reason: 'x y' }, DESKTOP) } as never).fullDiskAccess, false,
    'the agent manifest reads unknown as not available');
});

test('the grantee: the desktop app is TreeMap; plain Node is the app that started the server', () => {
  assert.deepEqual(granteeFor({ electron: '37.0.0', node: '22' }, {}), { name: 'TreeMap', desktop: true });
  assert.deepEqual(granteeFor({ node: '22' }, { TREEMAP_SHELL: 'tauri' }), { name: 'TreeMap', desktop: true }, 'a desktop shell that says so');
  const web = granteeFor({ node: '22' }, {});
  assert.equal(web.desktop, false);
  assert.equal(web.name, "the app that started TreeMap's server (for npm start, your terminal app)");
});

test('getCapabilities probes Full Disk Access and remembers the state for the error sentences', async () => {
  invalidateCapabilities();
  const caps = await getCapabilities();
  const fda = caps.fullDiskAccess;
  assert.ok(fda, 'the capability is there on every OS');
  assert.ok(['granted', 'not-granted', 'unknown'].includes(fda.state));
  assert.equal(fda.available, fda.state === 'granted' && process.platform === 'darwin');
  assert.equal(fda.grantee, granteeFor().name, 'this process is plain Node: the grant belongs to whatever started it');
  if (process.platform === 'darwin') {
    assert.equal(lastFdaState(), fda.state, 'errno.ts and errorHandler.ts read the state the probe found');
  } else {
    assert.match(fda.reason ?? '', /macOS setting/);
  }
});

/* ══════════════════ one builder, every sentence ══════════════════ */

const STATES: Array<FdaState | null> = ['granted', 'not-granted', 'unknown', null];
const GIVE = /\bGive\b|\bgive\b/;

test('EACCES never tells anyone to grant Full Disk Access; granted never does; not-granted always names the grantee', () => {
  for (const grantee of [DESKTOP, WEB]) {
    for (const state of STATES) {
      const eacces = accessAdvice({ code: 'EACCES', state, grantee });
      assert.doesNotMatch(eacces, GIVE, `EACCES under ${String(state)}: Full Disk Access does not change a folder's own permissions`);
      assert.match(eacces, /Full Disk Access does not change that/);
      assert.match(eacces, /does not ask for administrator rights/);
    }
    for (const code of ['EPERM', 'EACCES', null] as const) {
      const granted = accessAdvice({ code, state: 'granted', grantee });
      assert.doesNotMatch(granted, GIVE, `granted, ${String(code)}: it is already on`);
      assert.match(granted, /Full Disk Access does not change that/);
    }
    for (const code of ['EPERM', null] as const) {
      const notGranted = accessAdvice({ code, state: 'not-granted', grantee });
      assert.ok(notGranted.includes(`Give ${grantee.name} Full Disk Access in System Settings › Privacy & Security › Full Disk Access`), `not-granted, ${String(code)}: ${notGranted}`);
      assert.doesNotMatch(notGranted, /does not change that/, 'and nothing says it would not help');
    }
  }
});

test('a count under not-granted says Full Disk Access will not open what permissions or a lock keep closed; a single EPERM is the privacy gate alone', () => {
  // The scan keeps no errno per refused folder (review F1.3): a count can hold
  // the person's own chmod-000 folder or another account's, which granting
  // Full Disk Access does not open. Unhedged, the grant sentence sent them
  // round the loop U-11 exists to end: grant, relaunch, rescan, same refusal.
  const HEDGE = 'Full Disk Access does not override permissions or locks that you or another account set on a folder or file.';
  for (const grantee of [DESKTOP, WEB]) {
    const count = accessAdvice({ code: null, state: 'not-granted', grantee });
    assert.ok(count.startsWith(`Give ${grantee.name} Full Disk Access`), 'the grant still comes first: most refusals on a Mac are the privacy gate');
    assert.ok(count.endsWith(` ${HEDGE}`), `a count says what granting will not open: ${count}`);
    const eperm = accessAdvice({ code: 'EPERM', state: 'not-granted', grantee });
    assert.ok(!eperm.includes(HEDGE), `one EPERM from a read is the privacy gate, and says only that: ${eperm}`);
  }
});

test('unknown says both: what to grant if it is off, and what refuses if it is on', () => {
  for (const state of ['unknown', null] as const) {
    for (const code of ['EPERM', null] as const) {
      const both = accessAdvice({ code, state, grantee: DESKTOP });
      assert.match(both, /could not tell whether/);
      assert.match(both, /give TreeMap Full Disk Access in System Settings › Privacy & Security › Full Disk Access/);
      assert.match(both, /Full Disk Access does not change that/);
    }
  }
});

test('the restart clause: the desktop app says quit and reopen TreeMap; the web-mode sentence says quitting stops the server', () => {
  const desktop = accessAdvice({ code: 'EPERM', state: 'not-granted', grantee: DESKTOP });
  assert.match(desktop, /then quit and reopen TreeMap and scan again\.$/);
  const web = accessAdvice({ code: 'EPERM', state: 'not-granted', grantee: WEB });
  assert.match(web, /quit and reopen that app/);
  assert.match(web, /quitting it stops TreeMap's server, so start the server again after/);
  assert.doesNotMatch(web, /Give TreeMap\b/, 'web mode never names TreeMap as the one to grant');
  assert.match(accessAdvice({ code: 'EPERM', state: 'not-granted', grantee: DESKTOP, retry: 'try again' }), /and try again\.$/);
});

/** Every file under src/, comments removed, keyed by its path relative to the repository. */
function sourcesWithoutComments(): Map<string, string> {
  const root = path.join(__dirname, '..');
  const out = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (/\.(ts|js|html)$/.test(ent.name)) {
        const text = fs.readFileSync(full, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|<!--[\s\S]*?-->/g, '');
        out.set(path.relative(root, full).split(path.sep).join('/'), text);
      }
    }
  };
  walk(path.join(root, 'src'));
  return out;
}

test('every server sentence about Full Disk Access comes from accessAdvice', () => {
  const sources = sourcesWithoutComments();
  assert.ok(sources.size > 100, 'the scan found the source tree');
  const BUILDER = 'src/utils/accessAdvice.ts';
  assert.ok(sources.get(BUILDER)?.includes('Full Disk Access in System Settings'), 'the builder holds the sentence');
  for (const [file, text] of sources) {
    if (file === BUILDER) continue;
    assert.doesNotMatch(text, /Full Disk Access in System Settings/, `${file} writes its own "Full Disk Access in System Settings" sentence`);
    if (file.startsWith('src/ui/')) continue; // the page shows the server's sentence; its own words are tested below
    assert.doesNotMatch(text, /\b(give|grant|granting)\b[^.\n'"`]{0,60}Full Disk Access/i, `${file} tells someone to grant Full Disk Access in its own words`);
    assert.doesNotMatch(text, /lacks Full Disk Access|Full Disk Access usually/i, `${file} guesses at Full Disk Access in its own words`);
  }
});

test('the callers follow the state: the error handler, describeFsError and the Missing GB note', { skip: process.platform !== 'darwin' && 'the sentences are macOS-only' }, () => {
  const saved = lastFdaState();
  try {
    rememberFdaState('granted');
    assert.doesNotMatch(permissionDeniedMessage('/x', 'EPERM'), GIVE, 'granted: no grant advice for an EPERM');
    assert.doesNotMatch(describeFsError(errno('EPERM')), GIVE);
    assert.doesNotMatch(refusedPermissionNote(4, 'darwin'), GIVE);
    rememberFdaState('not-granted');
    assert.doesNotMatch(permissionDeniedMessage('/x', 'EACCES'), GIVE, 'an EACCES is never answered with Full Disk Access');
    assert.doesNotMatch(describeFsError(errno('EACCES')), GIVE);
    assert.ok(permissionDeniedMessage('/x', 'EPERM').endsWith(accessAdvice({ code: 'EPERM', state: 'not-granted', grantee: granteeFor(), retry: 'try again' })));
    assert.match(describeFsError(errno('EPERM')), /Give .* Full Disk Access/);
    assert.match(refusedPermissionNote(4, 'darwin'), /^4 refused permission\. Give /);
    assert.ok(refusedPermissionNote(4, 'darwin').includes(granteeFor().name), 'naming who to grant it to');
  } finally {
    rememberFdaState(saved);
  }
});

test('describeFsError: an EPERM from a write, a removal or an unnamed call also says what Full Disk Access will not lift; one from a read is the privacy gate', { skip: process.platform !== 'darwin' && 'the sentences are macOS-only' }, () => {
  // Review F1.4: `fsp.rm` on a file locked in Finder (`chflags uchg`) fails
  // EPERM, and so do chmod, utimes and chown on another account's file. The
  // grant sentence alone told that person Full Disk Access was the fix, and
  // dropped the "check the folder's permissions" the old wording offered.
  const HEDGE = /Full Disk Access does not override permissions or locks that you or another account set on a folder or file/;
  const withSyscall = (syscall: string | undefined): NodeJS.ErrnoException => Object.assign(errno('EPERM'), syscall ? { syscall } : {});
  const saved = lastFdaState();
  try {
    rememberFdaState('not-granted');
    for (const syscall of ['unlink', 'rmdir', 'rename', 'chmod', 'utime', 'open', 'copyfile', undefined]) {
      const s = describeFsError(withSyscall(syscall));
      assert.match(s, /Give .* Full Disk Access/, `${String(syscall)}: it may still be the privacy gate`);
      assert.match(s, HEDGE, `${String(syscall)}: and it may be a lock or another account's permissions: ${s}`);
    }
    // Every read describeFsError counts as the privacy gate, each by name
    // (review F2.4: two of the six were never asked about, and dropping them
    // from the set passed): a refused readlink is a read too.
    for (const syscall of ['scandir', 'opendir', 'readdir', 'stat', 'lstat', 'readlink']) {
      const s = describeFsError(withSyscall(syscall));
      assert.match(s, /Give .* Full Disk Access/, `${syscall}: a refused read is the privacy gate`);
      assert.doesNotMatch(s, HEDGE, `${syscall}: and says only that`);
    }
    // The cause chain describeFsError already walks carries the call too: a
    // wrapped read is still the privacy gate.
    assert.doesNotMatch(describeFsError(new Error('wrapped', { cause: withSyscall('scandir') })), HEDGE);
  } finally {
    rememberFdaState(saved);
  }
});

test('a disk scan records the Full Disk Access state it started under, so its refusals are worded by it later', async () => {
  // Review F1.5: the Missing GB note and an unreadable bundle's reason are
  // built on request, long after the scan; worded by the state now, a grant
  // that came on meanwhile made them say Full Disk Access "does not change"
  // refusals it caused.
  const dir = fileTempDir('treemap-fda-stamp-');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a');
  const saved = lastFdaState();
  try {
    rememberFdaState('not-granted');
    const scan = await startScan(dir);
    rememberFdaState('granted'); // switched on while it ran
    await waitFor(() => scan.status !== 'running', 'the stamped scan settling', 50);
    assert.equal(scan.fdaState, 'not-granted', 'the state when it started, not the state now');
  } finally {
    rememberFdaState(saved);
  }
});

const canLock = process.platform !== 'win32' && (typeof process.getuid !== 'function' || process.getuid() !== 0);

test('an agent refused a folder by its own permissions is told its errno\'s sentence over MCP, never to grant Full Disk Access', { skip: !canLock && 'needs a chmod-000 folder' }, async () => {
  const locked = path.join(fileTempDir('treemap-fda-locked-'), 'locked');
  fs.mkdirSync(locked);
  fs.chmodSync(locked, 0o000);
  const server = buildMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'treemap-fda-test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const reply = await client.callTool({ name: 'scan_path', arguments: { path: locked } }) as { isError?: boolean; content: Array<{ text: string }> };
    assert.equal(reply.isError, true);
    assert.equal(reply.content[0].text, `Error (PERMISSION_DENIED): ${permissionDeniedMessage(locked, 'EACCES')}`, 'worded for the EACCES it was');
    if (process.platform === 'darwin') assert.doesNotMatch(reply.content[0].text, GIVE, 'a chmod-000 folder is not opened by Full Disk Access');
  } finally {
    await client.close();
    fs.chmodSync(locked, 0o755);
  }
});

/* ══════════════════ the page ══════════════════ */

type El = {
  hidden: boolean; textContent: string; innerHTML: string; cls: Set<string>;
  listeners: Record<string, Array<() => void>>;
  classList: { add: (c: string) => void; remove: (c: string) => void };
  addEventListener: (n: string, fn: () => void) => void;
};
function el(): El {
  const e: El = {
    hidden: true, textContent: '', innerHTML: '', cls: new Set(), listeners: {},
    classList: { add: (c) => { e.cls.add(c); }, remove: (c) => { e.cls.delete(c); } },
    addEventListener: (n, fn) => { (e.listeners[n] ??= []).push(fn); },
  };
  return e;
}

/** One function declaration out of the built page, by brace depth. */
function braced(openAnchor: string): string {
  const start = INDEX.indexOf(openAnchor);
  assert.notEqual(start, -1, `block "${openAnchor}" exists in index.html`);
  let depth = 0;
  for (let i = INDEX.indexOf('{', INDEX.indexOf(')', start)); i < INDEX.length; i++) {
    if (INDEX[i] === '{') depth++;
    else if (INDEX[i] === '}' && --depth === 0) return INDEX.slice(start, i + 1);
  }
  return assert.fail(`block "${openAnchor}" never closes`);
}

function block(start: string, end: string): string {
  const i = INDEX.indexOf(start);
  assert.notEqual(i, -1, `anchor "${start}" exists in index.html`);
  const j = INDEX.indexOf(end, i + start.length);
  assert.notEqual(j, -1, `anchor "${end}" follows`);
  return INDEX.slice(i, j);
}

const ADVICE: Record<FdaState, string> = {
  'not-granted': 'Give the test grantee Full Disk Access — the not-granted sentence.',
  granted: 'The granted sentence: Full Disk Access does not change that.',
  unknown: 'The unknown sentence, both halves.',
};
const fdaCap = (state: FdaState) => ({ available: state === 'granted', mechanism: 'm', state, grantee: 'the test grantee', advice: ADVICE[state] });

/** An element's opening tag in the built page, by id, or null when the page has none. */
function openTag(id: string): string | null {
  const m = new RegExp(`<[a-z][a-z0-9]*\\b[^>]*\\bid="${id}"[^>]*>`).exec(INDEX);
  return m ? m[0] : null;
}

/**
 * Whether `focus()` can land on the element, judged as a browser judges it
 * from the shipped markup: a button can take focus, and anything else only
 * when it carries a tabindex. A stub that let any element take focus kept
 * the F1.11 row-focus test green with the row's `tabindex="-1"` deleted,
 * though a `<div>` without one ignores `.focus()` (review F2.3).
 */
function focusableInMarkup(id: string): boolean {
  const tag = openTag(id);
  return !!tag && (/^<button\b/.test(tag) || /\btabindex="-?\d+"/.test(tag));
}

function pageHarness(opts: { platform?: string; fda?: FdaState | null; refused?: { dirs: number; examples: string[] } | null; scanning?: boolean; refresh?: () => unknown }) {
  const src = block('/* ── Refused folders ── */', '/* ── end refused folders ── */') +
    block('/* ── Full Disk Access recheck ── */', '/* ── end Full Disk Access recheck ── */');
  const els: Record<string, El> = {};
  // The row's parts, as the markup nests them: hiding the row hides them too.
  const ROW_PARTS = ['accessText', 'accessHint', 'accessMissingBtn', 'accessOpenBtn'];
  const parentOf = (id: string): string | null => (ROW_PARTS.includes(id) ? 'accessRow' : null);
  const idOf = (e: unknown): string | null => Object.keys(els).find((k) => els[k] === e) ?? null;
  const rendered = (id: string): boolean => {
    const up = parentOf(id);
    return !$(id).hidden && (up === null || rendered(up));
  };
  // focus() moves the document's activeElement as a browser's does: never onto
  // an element that is not rendered, and never onto one the markup does not
  // make focusable. Each element starts as the markup has it, hidden or not.
  const $ = (id: string): El => (els[id] ??= Object.assign(el(), {
    hidden: /\shidden[\s>=]/.test(openTag(id) ?? ' hidden>'),
    focus: () => { if (rendered(id) && focusableInMarkup(id)) focused = id; },
    contains: (other: unknown): boolean => {
      for (let at = idOf(other); at !== null; at = parentOf(at)) if (at === id) return true;
      return false;
    },
  }));
  const toasts: string[] = [];
  const asked: Array<[string, unknown]> = [];
  const emitted: Array<[string, unknown]> = [];
  const winListeners: Record<string, Array<() => void>> = {};
  const docListeners: Record<string, Array<() => void>> = {};
  const body = { tagName: 'BODY' };
  let focused: string | null = null;
  const doc = {
    visibilityState: 'visible',
    // The focus fixup rule (review F2.6): an element that is no longer
    // rendered — hidden, or inside something hidden — has handed focus to
    // <body>. A stub that kept answering with the hidden element could not
    // show focus being lost.
    get activeElement(): unknown { return focused === null ? null : rendered(focused) ? els[focused] : body; },
    set activeElement(e: unknown) { focused = idOf(e); },
    addEventListener: (n: string, fn: () => void) => { (docListeners[n] ??= []).push(fn); },
  };
  const win = { treemapDesktop: null, addEventListener: (n: string, fn: () => void) => { (winListeners[n] ??= []).push(fn); } };
  const state: Record<string, unknown> = {
    scanStats: opts.refused === undefined ? null : { refused: opts.refused ?? { dirs: 0, examples: [] } },
    root: { path: '/Users/x', size: 5e9 }, scanId: 's1', scanRefused: null, scanning: !!opts.scanning,
    system: { platform: opts.platform || 'darwin', homeDir: '/Users/x' },
    capabilities: opts.fda ? { volumeTopology: { available: true }, fullDiskAccess: fdaCap(opts.fda) } : null,
    pathIndex: new Map(),
  };
  const api = async (url: string, options?: unknown) => {
    asked.push([url, options]);
    if (url === '/api/platform/capabilities/refresh') return opts.refresh ? opts.refresh() : { capabilities: { fullDiskAccess: fdaCap('granted') } };
    return { entries: [] };
  };
  const TOPIC = { scan: 'scan', capabilities: 'capabilities' };
  const fns = new Function('$', 'state', 'api', 'toast', 'icon', 'escapeHtml', 'formatCount', 'emit', 'TOPIC', 'window', 'document',
    `'use strict'; ${src} return { render: renderRefusedFolders, notice: preScanAccessNotice, arm: armFullDiskAccessRecheck };`)(
    $, state, api, (m: string) => toasts.push(m), () => '', (s: string) => String(s), (n: number) => String(n),
    (topic: string, payload: unknown) => { emitted.push([topic, payload]); }, TOPIC, win, doc,
  ) as { render: () => void; notice: (p: string) => boolean; arm: () => void };
  const settle = async (): Promise<void> => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };
  const fire = async (...names: string[]): Promise<void> => {
    for (const n of names) {
      for (const fn of winListeners[n] || []) fn();
      for (const fn of docListeners[n] || []) fn();
    }
    await settle();
  };
  return { ...fns, els, $, state, toasts, asked, emitted, fire, doc };
}

test('the refused row\'s hint is the server\'s sentence for the state it probed, and the button is hidden exactly when granted', () => {
  for (const fda of ['not-granted', 'granted', 'unknown'] as const) {
    const h = pageHarness({ fda, refused: { dirs: 2, examples: ['/Users/x/Library/Mail', '/Users/x/.Trash'] } });
    h.render();
    assert.equal(h.els.accessRow.hidden, false, `${fda}: the row shows`);
    assert.equal(h.els.accessHint.textContent, ADVICE[fda], `${fda}: the hint is the server's sentence for that state`);
    assert.equal(h.els.accessOpenBtn.hidden, fda === 'granted', `${fda}: the Privacy settings button ${fda === 'granted' ? 'is hidden' : 'is offered'}`);
  }
  // The page has no answer yet (the capabilities failed to load): no advice is made up, and the button stays.
  const none = pageHarness({ fda: null, refused: { dirs: 1, examples: ['/Users/x/Library/Mail'] } });
  none.render();
  assert.doesNotMatch(none.els.accessHint.textContent, /\bGive\b|TreeMap Full Disk Access/, 'no grantee guessed');
  assert.equal(none.els.accessOpenBtn.hidden, false);
  // Off macOS the copy is about permissions, whatever the server says about Full Disk Access.
  const win = pageHarness({ platform: 'win32', fda: 'not-granted', refused: { dirs: 1, examples: ['C:\\Users\\x\\Documents'] } });
  win.render();
  assert.doesNotMatch(win.els.accessHint.textContent, /Full Disk Access/);
  assert.equal(win.els.accessOpenBtn.hidden, true);
});

test('"What\'s missing?" sits in the refused row, opens the Missing view, and prints no byte figure', () => {
  const h = pageHarness({ fda: 'not-granted', refused: { dirs: 3, examples: [] } });
  h.render();
  assert.equal(h.els.accessMissingBtn.hidden, false, 'offered beside the refusals');
  const button = /<button[^>]*id="accessMissingBtn"[^>]*>([^<]*)<\/button>/.exec(INDEX);
  assert.ok(button, 'the button is in the page');
  assert.match(button[1], /What.s missing\?/);
  assert.doesNotMatch(button[1], /\d/, 'no byte figure (U-D14)');
  assert.doesNotMatch(h.els.accessText.textContent + h.els.accessHint.textContent, /\d\s?(B|KB|MB|GB|TB)\b/, 'nor anywhere in the row');
  const wiring = /\$\('accessMissingBtn'\)\.addEventListener\('click'[^\n]*\n/.exec(INDEX);
  assert.ok(wiring, 'the button is wired');
  const views: string[] = [];
  const btn = el();
  new Function('$', 'switchView', wiring[0])(() => btn, (v: string) => views.push(v));
  for (const fn of btn.listeners.click || []) fn();
  assert.deepEqual(views, ['missing']);
});

/** A CSS rule of the built page, from its selector to its closing brace. */
function cssRule(selector: string): string {
  const at = INDEX.indexOf(`${selector} {`);
  assert.notEqual(at, -1, `the ${selector} rule is in the built page`);
  return INDEX.slice(at, INDEX.indexOf('}', at));
}

test('the access row reflows rather than starving its sentence: the buttons go under the text in a narrow column', () => {
  // Review F1.10: a second button in a row that could not wrap left the
  // sentence 91px at the default 1320x880 window (9 lines; 17 in web mode),
  // and 27px with the sidebar collapsed, where "administrator" painted over
  // the buttons. Measured by arithmetic on the shipped CSS; a browser is the
  // real check, and this holds the rules that produce it.
  assert.match(cssRule('.access-row'), /flex-wrap:\s*wrap/, 'the row wraps');
  const basis = /flex:\s*1 1 (\d+)px/.exec(cssRule('.access-body'));
  assert.ok(basis && Number(basis[1]) >= 240, 'the sentence keeps a readable width before anything sits beside it');
  assert.match(INDEX, /<div class="access-actions">\s*<button class="btn" id="accessMissingBtn" hidden>[^<]*<\/button>\s*<button class="btn" id="accessOpenBtn" hidden>[^<]*<\/button>\s*<\/div>/,
    'the two buttons are one group, so they wrap together, never one at a time');
  assert.match(cssRule('.access-actions'), /flex-wrap:\s*wrap/, 'and the group stacks its own buttons in a column too narrow for both');
  assert.match(cssRule('.access-text, .access-hint'), /overflow-wrap:\s*anywhere/, 'a word longer than the column breaks instead of painting over the buttons');
});

test('before a scan of / or the home folder without Full Disk Access, the row says what the total will leave out — and the scan is not held', async () => {
  const NOTICE = /macOS keeps TreeMap out of the folders it protects \(Mail, Messages, Safari, the Trash\), so their size will not be in this total\./;
  for (const p of ['/', '/Users/x', '/Users/x/', '~']) {
    const h = pageHarness({ fda: 'not-granted' });
    const shown = h.notice(p);
    assert.equal(shown, true, `${p}: the notice shows`);
    assert.equal(h.els.accessRow.hidden, false);
    assert.match(h.els.accessText.textContent, NOTICE);
    assert.doesNotMatch(h.els.accessText.textContent, /\d/, 'no byte figure');
    assert.equal(h.els.accessHint.textContent, ADVICE['not-granted'], 'with the server\'s advice');
    assert.equal(h.els.accessOpenBtn.hidden, false, 'and the button goes with it');
    assert.equal(h.els.accessMissingBtn.hidden, true, 'nothing is missing yet: the scan has not finished');
  }
  const cases: Array<[string, Parameters<typeof pageHarness>[0], string]> = [
    ['/Users/x/Projects', { fda: 'not-granted' }, 'a folder that is not the whole disk or home'],
    ['/', { fda: 'granted' }, 'granted'],
    ['/', { fda: 'unknown' }, 'unknown'],
    ['/', { fda: null }, 'no answer'],
    ['/', { fda: 'not-granted', platform: 'win32' }, 'off macOS'],
    ['/', { fda: 'not-granted', platform: 'linux' }, 'off macOS'],
  ];
  for (const [p, opts, why] of cases) {
    const h = pageHarness(opts);
    assert.equal(h.notice(p), false, `${why}: no notice`);
    assert.equal(h.$('accessRow').hidden, true, `${why}: the row is left alone`);
  }
  // The scan runs alongside it: startScanRequest paints the notice and goes on to POST /api/scan.
  const src = INDEX.slice(INDEX.indexOf('async function startScanRequest('), INDEX.indexOf('function quietRescanFailed('));
  const order: string[] = [];
  const run = new Function('beginScanChrome', 'state', 'performance', 'api', 'abandonIfStopped', 'followScanProgress', 'failScan', 'quietRescanFailed', 'preScanAccessNotice',
    `'use strict'; ${src} return startScanRequest;`)(
    () => order.push('chrome'), { scanGen: 1 }, { now: () => 0 },
    async (url: string) => { order.push(url); return { scanId: 's9' }; }, () => false, () => order.push('follow'),
    (m: string) => assert.fail(m), () => assert.fail('quiet'), (p: string) => { order.push(`notice ${p}`); return true; },
  ) as (p: string) => Promise<void>;
  await run('/');
  assert.deepEqual(order, ['chrome', 'notice /', '/api/scan', 'follow'], 'the notice never stands between the click and the scan');
});

test('while the scan runs the notice stays; once it settles the row is the scan\'s own', () => {
  const h = pageHarness({ fda: 'not-granted', scanning: true });
  h.notice('/');
  h.render(); // TOPIC.scan fires mid-scan (an index-first paint)
  assert.equal(h.els.accessRow.hidden, false, 'the notice survives a repaint while the scan runs');
  assert.match(h.els.accessText.textContent, /Mail, Messages, Safari, the Trash/);
  h.state.scanning = false;
  h.state.scanStats = { refused: { dirs: 4, examples: ['/Users/x/Library/Mail'] } };
  h.render();
  assert.match(h.els.accessText.textContent, /^4 folders could not be read/, 'the scan\'s own count replaces it');
  h.state.scanStats = { refused: { dirs: 0, examples: [] } };
  h.render();
  assert.equal(h.els.accessRow.hidden, true, 'and a scan that was refused nothing hides it');
});

test('a scan that stops or fails takes its notice with it: the row is repainted from the scan still on screen', () => {
  // Stop and failure both end in restoreDashboardPanels; without a repaint the
  // notice went on saying "their size will not be in this total" about no total.
  const restore = braced('function restoreDashboardPanels(');
  let repaints = 0;
  const noop = (): void => {};
  const $ = (): El & { dataset: Record<string, unknown> } => ({ ...el(), dataset: {} });
  new Function('state', '$', 'renderBigFiles', 'renderBigFolders', 'renderDonut', 'fxDonutLoadingSync', 'renderDiskNotes', 'countUp', 'renderRefusedFolders',
    `'use strict'; ${restore}\nrestoreDashboardPanels();`)(
    { largest: [], bigFolders: [], types: [], donut: {}, scanStats: null }, $, noop, noop, noop, noop, noop, noop, () => { repaints++; },
  );
  assert.equal(repaints, 1, 'the access row is repainted once');
  const h = pageHarness({ fda: 'not-granted', scanning: true });
  h.notice('/');
  h.state.scanning = false; // endScanChrome ran
  h.render();
  assert.equal(h.els.accessRow.hidden, true, 'no notice once nothing is scanning, and no refusals of its own to show');
});

/**
 * beginScanChrome and endScanChrome out of the built page, run over `state`.
 * Every other name they reach (the spinner, the FX, the tour, `$`) is an
 * inert stand-in that accepts any call or property: what is under test is
 * what the two functions do to `state`, so nothing else needs to be real.
 */
function scanChrome(state: Record<string, unknown>): { begin: (opts?: object) => void; end: () => void } {
  const src = `${braced('function beginScanChrome(')}\n${braced('function endScanChrome(')}`;
  const inert: unknown = new Proxy(function inert() { /* stand-in */ }, {
    get: (_t, k) => (k === Symbol.toPrimitive ? () => 0 : inert),
    set: () => true,
    apply: () => inert,
  });
  const own = new Set(['beginScanChrome', 'endScanChrome']);
  const scope = new Proxy({ state } as Record<PropertyKey, unknown>, {
    has: (_t, k) => typeof k === 'string' && !own.has(k),
    get: (t, k) => (k === Symbol.unscopables ? undefined : k in t ? t[k] : inert),
    set: (t, k, v) => { t[k] = v; return true; },
  });
  // Not strict on purpose: `with` is how every other page name becomes the stand-in.
  return new Function('scope', `with (scope) { ${src}\nreturn { begin: beginScanChrome, end: endScanChrome }; }`)(scope) as ReturnType<typeof scanChrome>;
}

test('the notice belongs to the scan that set it: it ends with that scan, and a scan that never set it (a cloud account) paints none', () => {
  // Review F1.2: state.accessNotice was set by preScanAccessNotice and cleared
  // only by the next disk scan. A cloud scan (beginScanChrome, never
  // preScanAccessNotice) after a / scan on a Mac without access then painted
  // "macOS keeps TreeMap out of the folders it protects (Mail, Messages,
  // Safari, the Trash)" on its first repaint — false for a cloud account.
  const h = pageHarness({ fda: 'not-granted', refused: { dirs: 0, examples: [] } });
  Object.assign(h.state, { scanGen: 0, whatsNew: { seq: 0 } }); // the state beginScanChrome counts on
  const chrome = scanChrome(h.state);
  chrome.begin(); // startScanRequest: the chrome, then the notice
  h.notice('/');
  assert.equal(h.state.accessNotice, '/', 'a / scan without access sets it');
  chrome.end();
  assert.equal(h.state.accessNotice ?? null, null, 'and the end of that scan clears it');

  h.state.accessNotice = '/'; // left behind however a scan ended
  chrome.begin(); // startCloudScan: the chrome, and no notice of its own
  h.els.accessText.textContent = '';
  h.render(); // a mid-scan repaint (the recheck, or the last scan's late probe)
  assert.equal(h.els.accessRow.hidden, true, 'a scan that did not set the notice never paints it');
  assert.doesNotMatch(h.els.accessText.textContent, /Mail, Messages, Safari/);
});

test('after the button, the next focus asks the server once, repaints the row from its answer, and emits no capabilities topic', async () => {
  const h = pageHarness({ fda: 'not-granted', refused: { dirs: 2, examples: ['/Users/x/Library/Mail'] } });
  h.render();
  await h.fire('focus', 'visibilitychange');
  assert.equal(h.asked.length, 0, 'no refresh before the button was used');
  h.arm();
  await h.fire('focus', 'visibilitychange');
  const refreshes = h.asked.filter(([u]) => u === '/api/platform/capabilities/refresh');
  assert.equal(refreshes.length, 1, 'focus and visibilitychange together ask once');
  assert.equal((refreshes[0][1] as { method: string }).method, 'POST');
  assert.equal(h.emitted.filter(([t]) => t === 'capabilities').length, 0, 'TOPIC.capabilities is not emitted, so held-up space does not run again');
  assert.equal(h.els.accessOpenBtn.hidden, true, 'granted now: the button goes');
  assert.match(h.els.accessHint.textContent, /Full Disk Access is on now/, 'and the row says a new scan can read what was refused');
  assert.equal(((h.state.capabilities as { fullDiskAccess: { state: string } }).fullDiskAccess).state, 'granted', 'the page keeps the new answer');
  // Review F1.9: only fullDiskAccess is replaced. Dropping the rest would
  // enable views the registry had blocked with a reason, which then ask the
  // server for what this machine cannot answer.
  assert.deepEqual((h.state.capabilities as { volumeTopology: unknown }).volumeTopology, { available: true }, 'every other capability is kept as it was');
  await h.fire('focus');
  assert.equal(h.asked.length, 1, 'once per use of the button, not on every focus');
  // An answer that is still not-granted repaints the same advice; a failed one leaves the row alone.
  const still = pageHarness({ fda: 'not-granted', refused: { dirs: 2, examples: [] }, refresh: () => ({ capabilities: { fullDiskAccess: fdaCap('not-granted') } }) });
  still.render();
  still.arm();
  await still.fire('visibilitychange');
  assert.equal(still.els.accessHint.textContent, ADVICE['not-granted']);
  assert.equal(still.els.accessOpenBtn.hidden, false);
  const failed = pageHarness({ fda: 'not-granted', refused: { dirs: 2, examples: [] }, refresh: () => { throw new Error('offline'); } });
  failed.render();
  failed.arm();
  await failed.fire('focus');
  assert.equal(failed.els.accessHint.textContent, ADVICE['not-granted']);
});

test('the recheck waits for the window to be visible: going hidden neither asks nor spends it', async () => {
  // Review F1.8: the person clicks "Open Privacy settings", and System
  // Settings comes forward, so this window often goes hidden first. Spent
  // there, before anything was switched on, the one ask never comes back
  // and the row never updates.
  const h = pageHarness({ fda: 'not-granted', refused: { dirs: 2, examples: ['/Users/x/Library/Mail'] } });
  h.render();
  h.arm();
  h.doc.visibilityState = 'hidden';
  await h.fire('visibilitychange');
  assert.equal(h.asked.length, 0, 'going hidden asks nothing');
  h.doc.visibilityState = 'visible';
  await h.fire('visibilitychange');
  assert.equal(h.asked.filter(([u]) => u === '/api/platform/capabilities/refresh').length, 1, 'and coming back asks once: going hidden did not spend it');
});

test('when the recheck hides a focused "Open Privacy settings", focus moves to what stays, never to the page body', async () => {
  // Review F1.11: a keyboard user presses the button, switches access on in
  // System Settings and comes back; the window restores focus to the button,
  // and the recheck hides it. [hidden] takes it out of the page, focus fell
  // to <body>, and their place was lost.
  // The row can take focus only because its markup says so, and it stays out
  // of the Tab order: -1, never 0 (review F2.3).
  const rowTag = openTag('accessRow');
  assert.ok(rowTag, 'the access row is in the page');
  assert.match(rowTag, /\btabindex="-1"/, '#accessRow carries tabindex="-1": a <div> without one ignores focus()');
  const h = pageHarness({ fda: 'not-granted', refused: { dirs: 2, examples: ['/Users/x/Library/Mail'] } });
  h.render();
  h.arm();
  h.doc.activeElement = h.els.accessOpenBtn;
  await h.fire('focus');
  assert.equal(h.els.accessOpenBtn.hidden, true, 'granted now: the button goes');
  assert.equal(h.doc.activeElement, h.els.accessMissingBtn, 'and focus moves to "What\u2019s missing?", beside it');
  // The notice beside a running scan has no "What's missing?": the row takes focus.
  const n = pageHarness({ fda: 'not-granted', scanning: true });
  n.notice('/');
  n.arm();
  n.doc.activeElement = n.els.accessOpenBtn;
  await n.fire('focus');
  assert.equal(n.els.accessOpenBtn.hidden, true);
  assert.equal(n.doc.activeElement, n.els.accessRow, 'the row itself, which says what changed');
  // Focus anywhere else is left where it is.
  const o = pageHarness({ fda: 'not-granted', refused: { dirs: 2, examples: [] } });
  o.render();
  o.arm();
  const elsewhere = o.$('scanBtn');
  o.doc.activeElement = elsewhere;
  await o.fire('focus');
  assert.equal(o.els.accessOpenBtn.hidden, true);
  assert.equal(o.doc.activeElement, elsewhere, 'a hidden button that did not have focus moves nobody');
});

test('any repaint that hides the focused part of the access row moves focus to what stays, or to the Scan button, never to the page body', async () => {
  // Review F2.6: the F1.11 rescue covered one transition. The recheck parks
  // focus on "What's missing?"; the hint says a new scan can read the
  // folders, so the person presses ⌘R, which moves no focus; the rescan
  // refuses nothing and the row goes — with focus inside it, so it fell to
  // <body>. And a / scan without access, begun with focus on "What's
  // missing?", hid that button under its notice.
  const h = pageHarness({ fda: 'not-granted', refused: { dirs: 2, examples: ['/Users/x/Library/Mail'] } });
  h.render();
  h.arm();
  h.doc.activeElement = h.els.accessOpenBtn;
  await h.fire('focus');
  assert.equal(h.doc.activeElement, h.els.accessMissingBtn, 'the recheck left focus on "What’s missing?"');
  h.state.scanStats = { refused: { dirs: 0, examples: [] } }; // ⌘R, and the rescan read everything
  h.render();
  assert.equal(h.els.accessRow.hidden, true, 'the rescan refused nothing: the row goes');
  assert.equal(h.doc.activeElement, h.$('scanBtn'), 'and focus goes to the Scan button above it');

  const n = pageHarness({ fda: 'not-granted', refused: { dirs: 2, examples: [] } });
  n.render();
  n.doc.activeElement = n.els.accessMissingBtn;
  n.state.scanning = true;
  assert.equal(n.notice('/'), true, 'a / scan without access paints its notice');
  assert.equal(n.els.accessMissingBtn.hidden, true, 'which has no "What’s missing?"');
  assert.equal(n.doc.activeElement, n.els.accessOpenBtn, 'so focus moves to the button the notice keeps');

  const g = pageHarness({ fda: 'granted', refused: { dirs: 2, examples: [] } });
  g.render();
  g.doc.activeElement = g.els.accessMissingBtn;
  g.state.scanStats = { refused: { dirs: 0, examples: [] } };
  g.render();
  assert.equal(g.doc.activeElement, g.$('scanBtn'), 'with no other button showing, the row gone, the Scan button takes it');

  // A repaint that hides nothing focused moves nobody.
  const s = pageHarness({ fda: 'not-granted', refused: { dirs: 2, examples: [] } });
  s.render();
  s.doc.activeElement = s.els.accessOpenBtn;
  s.render();
  assert.equal(s.doc.activeElement, s.els.accessOpenBtn, 'a button still on screen keeps its focus');
  s.doc.activeElement = s.els.accessRow;
  s.render();
  assert.equal(s.doc.activeElement, s.els.accessRow, 'and so does the row while it shows');
  // Focus outside the row is never moved, even when the row goes.
  const o = pageHarness({ fda: 'not-granted', refused: { dirs: 2, examples: [] } });
  o.render();
  const field = o.$('pathInput');
  o.doc.activeElement = field;
  o.state.scanStats = { refused: { dirs: 0, examples: [] } };
  o.render();
  assert.equal(o.doc.activeElement, field, 'focus outside the row stays where it is');
});

test('the button arms the recheck, and its fallback toast uses the server\'s sentence', async () => {
  const wiring = block("$('accessOpenBtn').addEventListener('click'", '/* ── Scan queue ── */');
  const buttons: Record<string, El> = {};
  let armed = 0;
  let opened = 0;
  new Function('$', 'armFullDiskAccessRecheck', 'openFullDiskAccessSettings', 'switchView', wiring)(
    (id: string) => (buttons[id] ??= el()), () => { armed++; }, async () => { opened++; }, () => {},
  );
  for (const fn of buttons.accessOpenBtn.listeners.click || []) fn();
  assert.equal(armed, 1, 'the next focus will ask');
  assert.equal(opened, 1);

  const handler = INDEX.slice(INDEX.indexOf('async function openFullDiskAccessSettings('), INDEX.indexOf("$('accessOpenBtn').addEventListener('click'"));
  const info = braced('function fullDiskAccessInfo(');
  const toastFor = async (caps: unknown): Promise<string[]> => {
    const toasts: string[] = [];
    const run = new Function('window', 'toast', 'state', `'use strict'; ${info}\n${handler}\nreturn openFullDiskAccessSettings;`)(
      { treemapDesktop: undefined }, (m: string) => toasts.push(m), { capabilities: caps },
    ) as () => Promise<void>;
    await run();
    return toasts;
  };
  const web = await toastFor({ fullDiskAccess: fdaCap('not-granted') });
  assert.equal(web.length, 1);
  assert.ok(web[0].endsWith(ADVICE['not-granted']), 'the grantee and the restart clause are the server\'s');
  const unknownAnswer = await toastFor(null);
  assert.match(unknownAnswer[0], /System Settings › Privacy & Security › Full Disk Access/, 'without an answer the path is still said');
  assert.doesNotMatch(unknownAnswer[0], /switch TreeMap on/, 'without naming a grantee it cannot know');
});
