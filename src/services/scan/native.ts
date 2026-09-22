/**
 * The native core's loader. The module is an accelerator: when it cannot be
 * loaded — missing for this platform, the wrong architecture, a build from
 * another version — the app runs on the legacy engines and says why. Nothing
 * here throws, and the outcome is decided once per process.
 *
 * `package.json`'s `nativeVersion` is the handshake: the module's `version()`
 * must equal it, so a stale prebuilt can never answer for a newer contract.
 */
import fs from 'node:fs';
import path from 'node:path';

export interface NativeModule {
  version(): string;
  [name: string]: unknown;
}

export type NativeOutcome =
  | { available: true; module: NativeModule; version: string; path: string }
  | { available: false; reason: string };

export interface LoadOptions {
  /** Try only this path (tests and the `TREEMAP_NATIVE_MODULE` override). */
  path?: string;
  expectedVersion?: string;
  /** Test hook standing in for `require`. */
  requireModule?: (file: string) => unknown;
}

const REPO_ROOT = path.join(__dirname, '..', '..', '..');
const MODULE_FILE = 'treemap_core.node';

let outcome: NativeOutcome | null = null;
/** The candidate list the cached outcome was decided for; a different list is decided afresh. */
let outcomeKey: string | null = null;
/**
 * Test-only: what a call with no options loads instead of the real
 * candidates — a fake module, or a path that is not there. One seam for every
 * consumer (the budget, the native engine), so a test that pins one pins all.
 */
let overrideOptions: LoadOptions | null = null;

/**
 * Where a module may live, most specific first. `TREEMAP_NATIVE_MODULE` is
 * exclusive: a person who points it at a module is testing that module, and
 * one who points it at a path that is not there is forcing the legacy
 * engines — either way the prebuilt must not answer behind their back.
 */
export function nativeCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  if (env.TREEMAP_NATIVE_MODULE) return [env.TREEMAP_NATIVE_MODULE];
  const out: string[] = [];
  const triple = `${process.platform}-${process.arch}`;
  out.push(path.join(REPO_ROOT, 'native', 'prebuilt', triple, MODULE_FILE));
  const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (resources) out.push(path.join(resources, 'native', MODULE_FILE));
  return out;
}

function expectedVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as { nativeVersion?: unknown };
    return typeof pkg.nativeVersion === 'string' ? pkg.nativeVersion : 'unknown';
  } catch {
    return 'unknown';
  }
}

function tryLoad(file: string, expected: string, requireModule: (f: string) => unknown, injected: boolean): NativeOutcome {
  const triple = `${process.platform}-${process.arch}`;
  // An injected loader stands in for the file system too (tests); the real one needs the file to exist.
  if (!injected && !fs.existsSync(file)) {
    return { available: false, reason: `no native module at ${file} for ${triple}; the legacy engines run instead` };
  }
  let loaded: unknown;
  try {
    loaded = requireModule(file);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { available: false, reason: `the native module at ${file} could not be loaded on ${triple}: ${message}` };
  }
  if (typeof loaded !== 'object' || loaded === null || typeof (loaded as { version?: unknown }).version !== 'function') {
    return { available: false, reason: `the file at ${file} loaded but is not TreeMap's native module (no version())` };
  }
  const mod = loaded as NativeModule;
  let version: string;
  try {
    version = String(mod.version());
  } catch (err: unknown) {
    return { available: false, reason: `the native module at ${file} failed its version handshake: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (version !== expected) {
    return { available: false, reason: `the native module at ${file} is version ${version} but this app expects ${expected}; rebuild it with npm run build:native` };
  }
  return { available: true, module: mod, version, path: file };
}

/**
 * Loads the native core once per process; every later call returns the same
 * outcome. With no options the test override applies when one is set.
 */
export function loadNative(opts?: LoadOptions): NativeOutcome {
  const options = opts ?? overrideOptions ?? {};
  const candidates = options.path ? [options.path] : nativeCandidates();
  const key = candidates.join('|');
  if (outcome && outcomeKey === key) return outcome;
  const expected = options.expectedVersion ?? expectedVersion();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const requireModule = options.requireModule ?? ((f: string): unknown => require(f) as unknown);
  const reasons: string[] = [];
  for (const file of candidates) {
    const result = tryLoad(file, expected, requireModule, options.requireModule !== undefined);
    if (result.available) {
      outcome = result;
      outcomeKey = key;
      return result;
    }
    reasons.push(result.reason);
  }
  const failed: NativeOutcome = { available: false, reason: reasons.join('; ') };
  outcome = failed;
  outcomeKey = key;
  return failed;
}

/** Test-only: what a no-option load uses (a fake module, or a path that is not there); null clears it. */
export function setNativeLoadOverrideForTests(opts: LoadOptions | null): void {
  overrideOptions = opts;
}

/** Test-only: forget the cached outcome. */
export function resetNativeForTests(): void {
  outcome = null;
  outcomeKey = null;
}
