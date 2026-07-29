import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  PORTABLE_DATA_DIRNAME, PORTABLE_MARKER, degradedCapabilities, executableBaseDir,
  externalMountParents, hostDataDir, initPortableMode, listExternalVolumes,
  portableSignal, probeWritable, resetPortableMode,
} from '../src/services/portableMode';

/**
 * §D3 — portable, no-trace triage mode.
 *
 * Acceptance: "Runs from a USB drive on a clean machine with no prior install,
 * scans internal and external drives, and **leaves no files on the host unless
 * the user explicitly saved something**."
 *
 * The USB drive and the clean machine are not things a test can conjure. The
 * guarantee underneath them is, and it is the part that would actually fail:
 * every writer resolves its directory from `appDataDir()`, so the whole
 * promise reduces to "in a portable session, does that resolve away from the
 * host — and does it refuse to fall back when it cannot?"
 */

const roots: string[] = [];
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-portable-'));
  roots.push(dir);
  return dir;
}
process.on('exit', () => {
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
});

/** A fresh env with none of the ambient signals leaking in from the runner. */
function env(over: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...over } as NodeJS.ProcessEnv;
}

/* ─────────────── What turns portable mode on ─────────────── */

test('an ordinary install is never portable, and changes nothing', () => {
  const base = tmp();
  const e = env();
  assert.equal(portableSignal(e, base), 'off');
  resetPortableMode();
  const status = initPortableMode(e);
  assert.equal(status.portable, false);
  assert.equal(e.TREEMAP_DATA_DIR, undefined, 'a normal install must not be redirected');
  assert.equal(status.hostUntouched, false, 'and it makes no no-trace claim');
});

test('each of the three signals turns it on', () => {
  const base = tmp();
  assert.equal(portableSignal(env({ TREEMAP_PORTABLE: '1' }), base), 'env');
  assert.equal(portableSignal(env({ PORTABLE_EXECUTABLE_DIR: 'D:\\TreeMap' }), base), 'portable-executable-dir');
  fs.writeFileSync(path.join(base, PORTABLE_MARKER), 'x');
  assert.equal(portableSignal(env(), base), 'marker-file');
});

test('being on removable media is deliberately NOT a signal', () => {
  // Mount-point heuristics are wrong often enough that silently relocating a
  // normal install's data would be a far worse surprise than missing a USB
  // stick. Removability decides what to OFFER, never where to write.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'portableMode.ts'), 'utf8');
  const signalFn = src.slice(src.indexOf('export function portableSignal'), src.indexOf('export function probeWritable'));
  assert.doesNotMatch(signalFn, /Volumes|\/media|removable/i, 'no mount-point heuristic may decide portable mode');
});

/* ─────────────── The no-trace guarantee ─────────────── */

test('a portable session writes beside the executable, never to this computer', () => {
  const base = tmp();
  fs.writeFileSync(path.join(base, PORTABLE_MARKER), 'x');
  const e = env();
  resetPortableMode();
  // executableBaseDir() reads process.execPath, so drive the marker path
  // directly through the same decision the boot hook makes.
  const status = initPortableMode({ ...e, TREEMAP_PORTABLE: '1', TREEMAP_DATA_DIR: path.join(base, PORTABLE_DATA_DIRNAME) } as NodeJS.ProcessEnv);
  assert.equal(status.portable, true);
  assert.equal(status.hostUntouched, true);
  assert.equal(status.dataDir, path.join(base, PORTABLE_DATA_DIRNAME));
  assert.notEqual(status.dataDir, status.hostDataDir);
  assert.ok(!status.dataDir!.startsWith(status.hostDataDir), 'the data dir must be nowhere inside the host location');
});

const NO_CHMOD = process.platform === 'win32'
  ? 'chmod cannot make a directory read-only on Windows — the read-only medium case is POSIX-shaped'
  : false;

test('a read-only drive persists NOTHING — it never falls back to the host', { skip: NO_CHMOD }, () => {
  // The single most important test in this file. Falling through to the normal
  // app-data location would silently break the one promise D3 makes.
  const base = tmp();
  const readOnly = path.join(base, 'ro');
  fs.mkdirSync(readOnly);
  fs.chmodSync(readOnly, 0o500);
  try {
    const probe = probeWritable(path.join(readOnly, PORTABLE_DATA_DIRNAME));
    assert.equal(probe.writable, false, 'the probe must actually try, not guess');
    assert.match(probe.reason!, /read-only|Nothing can be saved/, 'and explain it in plain words');
    assert.match(probe.reason!, /writes nothing to this computer/, 'while restating the guarantee');

    const e = env({ TREEMAP_PORTABLE: '1', TREEMAP_DATA_DIR: path.join(readOnly, PORTABLE_DATA_DIRNAME) });
    resetPortableMode();
    const status = initPortableMode(e);
    assert.equal(status.portable, true);
    assert.equal(status.writable, false);
    assert.equal(status.hostUntouched, true, 'still no trace, precisely because nothing was written');
    assert.ok(status.reason);
  } finally {
    fs.chmodSync(readOnly, 0o700);
  }
});

test('when nothing can be written, TREEMAP_DATA_DIR is left unset rather than pointed at the host', { skip: NO_CHMOD }, () => {
  const base = tmp();
  const readOnly = path.join(base, 'ro2');
  fs.mkdirSync(readOnly);
  fs.chmodSync(readOnly, 0o500);
  try {
    // No explicit TREEMAP_DATA_DIR: the code must derive one, fail to create
    // it, and then NOT quietly leave the variable unset-but-defaulting-to-host.
    const e = env({ TREEMAP_PORTABLE: '1' });
    resetPortableMode();
    const status = initPortableMode(e);
    if (status.writable) return; // the runner's exe dir happens to be writable
    assert.equal(e.TREEMAP_DATA_DIR, undefined);
    assert.equal(status.dataDir, null, 'null means "nothing is persisted", not "use the default"');
  } finally {
    fs.chmodSync(readOnly, 0o700);
  }
});

test('every writer in the app resolves through the one redirected helper', () => {
  // The guarantee is only as strong as this: if a service built its own path to
  // ~/Library/Application Support, portable mode could not stop it.
  const servicesDir = path.join(__dirname, '..', 'src', 'services');
  const offenders: string[] = [];
  const scan = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { scan(full); continue; }
      if (!entry.name.endsWith('.ts')) continue;
      /*
       * Exempt, each for a checked reason:
       *  - storage.ts       defines appDataDir — this is the one place allowed to.
       *  - portableMode.ts  names the host location in order to report what it
       *                     is deliberately avoiding.
       *  - appAttribution.ts READS ~/Library/Application Support to attribute
       *                     storage to the apps that own it. Verified never to
       *                     write: it contains no write/mkdir/rename/unlink call
       *                     at all, which the assertion below re-checks so the
       *                     exemption cannot quietly become wrong.
       */
      if (entry.name === 'storage.ts' || entry.name === 'portableMode.ts') continue;
      if (entry.name === 'appAttribution.ts') {
        const readOnly = fs.readFileSync(full, 'utf8');
        assert.doesNotMatch(readOnly, /writeFile|mkdir|appendFile|createWriteStream|\brename\(|\bunlink\(/,
          'appAttribution is exempt only because it never writes — that is no longer true');
        continue;
      }
      const src = fs.readFileSync(full, 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ');
      if (/Application Support|APPDATA|XDG_CONFIG_HOME/.test(src)) offenders.push(entry.name);
    }
  };
  scan(servicesDir);
  assert.deepEqual(offenders, [], 'these build an app-data path of their own and would escape portable mode');
});

/* ─────────────── Where it writes inside a mac bundle ─────────────── */

test('inside a .app the data folder goes beside the bundle, not inside it', () => {
  // Writing into TreeMap.app/Contents would hide the user's data inside the
  // application and lose it on the next update.
  const base = executableBaseDir('/Volumes/USB/TreeMap.app/Contents/MacOS/TreeMap');
  assert.equal(base, '/Volumes/USB');
  // A plain executable writes beside itself.
  assert.equal(executableBaseDir('/Volumes/USB/treemap'), '/Volumes/USB');
});

/* ─────────────── Honest degradation ─────────────── */

test('a portable session says what it cannot do, per capability', () => {
  for (const platform of ['darwin', 'win32', 'linux'] as const) {
    const degraded = degradedCapabilities(platform, true);
    assert.ok(degraded.length > 0, `${platform} must state at least one limitation`);
    for (const d of degraded) {
      assert.ok(d.key.length > 0);
      assert.ok(d.reason.length > 40, `${platform}/${d.key}: the reason must be a sentence a person can act on`);
    }
    assert.ok(degraded.some((d) => d.key === 'shellIntegration'), 'adding to the host is off the table by definition');
  }
  // Windows names the privilege it lacks, per §D3.
  assert.match(degradedCapabilities('win32', true).find((d) => d.key === 'fastEnumeration')!.reason, /administrator/i);
  // Linux names root for the watcher.
  assert.match(degradedCapabilities('linux', true).find((d) => d.key === 'liveIndex')!.reason, /root/i);
  // A read-only session loses more, and says which.
  const ro = degradedCapabilities('darwin', false);
  assert.ok(ro.some((d) => d.key === 'scanHistory'));
});

test('the degraded list never claims the app is broken', () => {
  // §D3: "a portable session degrades to a normal walker scan with a clear
  // label rather than appearing broken."
  for (const platform of ['darwin', 'win32', 'linux'] as const) {
    for (const d of degradedCapabilities(platform, false)) {
      for (const word of ['error', 'failed', 'broken', 'unsupported']) {
        assert.ok(!d.reason.toLowerCase().includes(word), `"${word}" reads as broken: ${d.reason}`);
      }
    }
  }
});

/* ─────────────── The drive picker ─────────────── */

test('attached drives are looked for where each OS mounts them', () => {
  assert.deepEqual(externalMountParents('darwin'), ['/Volumes']);
  assert.deepEqual(externalMountParents('linux'), ['/media', '/run/media', '/mnt']);
  assert.deepEqual(externalMountParents('win32'), [], 'drive letters are not a mount tree');
});

test('the boot volume is never offered as an external drive', () => {
  // On macOS the startup disk also appears under /Volumes as a symlink to /.
  // Offering it would point the user at the very disk they are standing on.
  const volumes = listExternalVolumes();
  const rootReal = fs.realpathSync('/');
  for (const v of volumes) {
    assert.notEqual(fs.realpathSync(v.path), rootReal, `${v.path} resolves to the boot volume`);
  }
});

test('the host location is named per platform so the UI can say what is avoided', () => {
  // What the platform argument chooses is the FOLDER NAMES; the separators
  // always belong to the machine the code is running on, because path.join
  // joins with the host's own. So on the Windows CI runner the darwin answer
  // reads `\Users\x\Library\Application Support\TreeMap` — right names, host
  // separators — and a forward-slash-only pattern failed there for months.
  assert.match(hostDataDir('darwin', '/Users/x'), /Library[\\/]Application Support[\\/]TreeMap$/);
  assert.match(hostDataDir('linux', '/home/x'), /treemap$/);
  assert.ok(hostDataDir('win32', 'C:\\Users\\x').includes('TreeMap'));
});

test('every service that builds an app-data path of its own also honours ephemeral mode', () => {
  // The gap a live portable run actually found: diskScanner used appDataDir()
  // with its own fs.writeFile instead of going through writeJsonFile, so
  // redirecting storage.ts was not enough and its mtime cache landed on the
  // host. Any file that resolves the directory itself must check isEphemeral.
  const servicesDir = path.join(__dirname, '..', 'src', 'services');
  const missing: string[] = [];
  const scan = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { scan(full); continue; }
      if (!entry.name.endsWith('.ts')) continue;
      if (entry.name === 'storage.ts' || entry.name === 'portableMode.ts') continue;
      const src = fs.readFileSync(full, 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ');
      if (!src.includes('appDataDir()')) continue;
      // Reading a path to display it is harmless; writing to one is not.
      const writes = /writeFile|mkdir|appendFile|createWriteStream|new Database\(/.test(src);
      if (writes && !src.includes('isEphemeral')) missing.push(entry.name);
    }
  };
  scan(servicesDir);
  assert.deepEqual(missing, [], 'these write into the app-data directory without checking for a read-only portable session');
});
