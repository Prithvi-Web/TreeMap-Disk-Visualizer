import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { statToInput } from '../src/services/scan/nodeInput';
import { detectContainerKind } from '../src/utils/containerKind';
import type { ContainerKind } from '../src/models/types';
import type { NodeInput } from '../src/services/scanStore';

/**
 * `statToInput` shapes every entry every disk engine records, and
 * `detectContainerKind` also decides what the gdu mapper and the container
 * scanner treat as a container, so neither may move by a byte. The
 * references below are the logic both used until 23 September 2026, frozen
 * here — `path.extname`, lower-cased, without its dot; the container rules
 * asked of every name — and the implementations are held to them over names
 * built from tokens chosen to break a shortcut: dots at the start, the end
 * and doubled; container suffixes in mixed case; characters whose lower case
 * changes length (İ) or depends on context (Σ); an astral emoji; a space. No
 * token holds a path separator: no file name contains its own platform's.
 */
const DOCKER_DATA_FILES = new Set(['docker.raw', 'docker.qcow2', 'ext4.vhdx', 'docker_data.vhdx']);

function referenceContainer(name: string, isDir: boolean): ContainerKind | undefined {
  const lower = name.toLowerCase();
  if (isDir) return lower.endsWith('.photoslibrary') ? 'photos' : undefined;
  if (DOCKER_DATA_FILES.has(lower)) return 'docker';
  if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) return 'tgz';
  if (lower.endsWith('.zip') || lower.endsWith('.jar')) return 'zip';
  if (lower.endsWith('.tar')) return 'tar';
  if (lower.endsWith('.iso')) return 'iso';
  if (lower.endsWith('.dmg')) return 'dmg';
  return undefined;
}

function reference(name: string, isDir: boolean, size: number, mtimeMs: number, atimeMs?: number): NodeInput {
  const input: NodeInput = {
    name,
    isDir,
    size: isDir ? 0 : size,
    modifiedAt: Math.round(mtimeMs),
    isHidden: name.startsWith('.'),
  };
  if (atimeMs !== undefined && atimeMs > 0) input.accessedAt = Math.round(atimeMs);
  if (!isDir) {
    const ext = path.extname(name).toLowerCase().replace(/^\./, '');
    if (ext) input.extension = ext;
  }
  const container = referenceContainer(name, isDir);
  if (container) input.container = container;
  return input;
}

const TOKENS = [
  '.', '..', 'a', 'Z', 'zip', '.zip', '.ZIP', '.tar', '.Tar', '.gz', '.tgz', '.jar', '.iso', '.DMG',
  '.raw', '.qcow2', '.vhdx', 'docker', 'ext4', 'docker_data', '.photoslibrary', '.PhotosLibrary',
  'İ', '.İ', 'Σ', '.Σ', 'ß', '😀', ' ',
];

/** Deterministic: the same names on every run and every machine. */
function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function* names(): Generator<string> {
  yield '';
  // Every combination of up to three tokens...
  for (const a of TOKENS) {
    yield a;
    for (const b of TOKENS) {
      yield a + b;
      for (const c of TOKENS) yield a + b + c;
    }
  }
  // ...and 300,000 longer ones, drawn from a fixed seed.
  const rng = makeRng(20260923);
  for (let i = 0; i < 300_000; i++) {
    const count = 4 + Math.floor(rng() * 4);
    let name = '';
    for (let k = 0; k < count; k++) name += TOKENS[Math.floor(rng() * TOKENS.length)];
    yield name;
  }
}

test('statToInput keeps path.extname and the container rules exactly, for files and folders', () => {
  let checked = 0;
  for (const name of names()) {
    for (const isDir of [false, true]) {
      const got = statToInput(name, isDir, 7, 1_700_000_000_000.4, 1_700_000_000_000.6);
      const want = reference(name, isDir, 7, 1_700_000_000_000.4, 1_700_000_000_000.6);
      if (JSON.stringify(got) !== JSON.stringify(want)) assert.deepEqual(got, want, `${JSON.stringify(name)}, isDir ${isDir}`);
      checked++;
    }
  }
  assert.ok(checked > 600_000, `${checked} names checked`);
});

test('detectContainerKind answers as the rules it replaced, for every caller', () => {
  for (const name of names()) {
    for (const isDir of [false, true]) {
      const got = detectContainerKind(name, isDir);
      if (got !== referenceContainer(name, isDir)) assert.equal(got, referenceContainer(name, isDir), `${JSON.stringify(name)}, isDir ${isDir}`);
    }
  }
});

test('statToInput on the names a shortcut gets wrong', () => {
  const cases: Array<[string, boolean, string | undefined, string | undefined]> = [
    // name, isDir, extension, container
    ['.bashrc', false, undefined, undefined],
    ['..', false, undefined, undefined],
    ['...', false, undefined, undefined],
    ['a.', false, undefined, undefined],
    ['.zip', false, undefined, 'zip'],
    ['..zip', false, 'zip', 'zip'],
    ['x.TAR.GZ', false, 'gz', 'tgz'],
    ['.tar.gz', false, 'gz', 'tgz'],
    ['DOCKER.RAW', false, 'raw', 'docker'],
    ['docker_data.vhdx', false, 'vhdx', 'docker'],
    ['disk.vhdx', false, 'vhdx', undefined],
    ['Photos Library.photoslibrary', true, undefined, 'photos'],
    ['a.ZİP', false, 'zi̇p', undefined],
    ['Α.ΑΣ', false, 'ας', undefined],
  ];
  for (const [name, isDir, extension, container] of cases) {
    const got = statToInput(name, isDir, 1, 0);
    assert.equal(got.extension, extension, `${JSON.stringify(name)}: extension`);
    assert.equal(got.container, container, `${JSON.stringify(name)}: container`);
    assert.deepEqual(got, reference(name, isDir, 1, 0), `${JSON.stringify(name)}: the whole input`);
  }
});
