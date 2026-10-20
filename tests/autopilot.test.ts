import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';

// Isolate policies, run history, the capsule and settings from the user's real
// app data. An Autopilot test that wrote to the real store would leave standing
// instructions to delete the user's files.
import { fileTempDir, isolatedDataDir } from './fixtures/dataDir';
import { waitFor, withinHangGuard } from './fixtures/waitFor';
import { isRestoreCopyFor } from './fixtures/restoreCopy';
isolatedDataDir('treemap-autopilot-test-');
process.env.TREEMAP_NO_GDU = '1';

import {
  normalizePolicy,
  savePolicies,
  listPolicies,
  sameScope,
  selectCandidates,
  applyCaps,
  effectiveCap,
  bytesDeletedSince,
  runPolicy,
  simulatePolicy,
  approvePolicy,
  approvePolicyForTests,
  listRuns,
  undoRun,
  type Candidate,
} from '../src/services/autopilot';
import { getCapsuleJob, protectItems } from '../src/services/timeCapsule';
import { setCopyFaultForTests } from '../src/utils/copyVerify';
import { readJsonFile, writeJsonFile } from '../src/services/storage';
import { AutopilotPolicy, AutopilotRun, CleanupSuggestionGroup } from '../src/models/types';
import { AppError } from '../src/middleware/errorHandler';
import { setTrashStepForTests } from '../src/services/cleaner';
import { buildOpenApiDocument } from '../src/api/openapi';
import { loadRuleCatalog } from '../src/services/rulePacks';
import http from 'node:http';
import { createApp } from '../src/server';
import { resetRateLimiter } from '../src/middleware/rateLimiter';

/**
 * B1 — Autopilot.
 *
 * A policy is a standing instruction to delete things while nobody is
 * watching, so the tests that matter here are about the *rails*: the run that
 * refuses, the cap that holds, the approval that cannot be skipped. §B1's
 * acceptance criteria are all of that shape.
 *
 * Nothing in this file trashes anything. The one test that drives a live run
 * all the way through does so against a file held open by another process, so
 * B2 refuses the delete — or, when `lsof` outruns its limit on a loaded
 * machine, the unattended run refuses what it could not check (24 Sep 2026:
 * before that rule, such a run trashed the held file). Its Trash step is also
 * replaced by a recorder, so nothing here can reach the machine's Trash.
 */

const mkTmp = (): Promise<string> => fsp.mkdtemp(path.join(os.tmpdir(), 'tm-b1-'));
const IS_UNIX = process.platform !== 'win32';
const MB = 1024 * 1024;

async function writeFile(p: string, size: number): Promise<string> {
  await fsp.mkdir(path.dirname(p), { recursive: true });
  await fsp.writeFile(p, crypto.randomBytes(size));
  return p;
}

function candidate(name: string, bytes: number): Candidate {
  return { path: `/x/${name}`, name, bytes, reason: 'test' };
}

function group(id: string, items: { path: string; size: number }[]): CleanupSuggestionGroup {
  return {
    id,
    title: id,
    description: 'test group',
    items: items.map((i) => ({ name: path.basename(i.path), path: i.path, size: i.size, type: 'dir' as const, modifiedAt: 0 })),
    totalSize: items.reduce((s, i) => s + i.size, 0),
    category: 'regenerable',
  };
}

const basePolicy = (over: Partial<AutopilotPolicy> = {}): AutopilotPolicy => ({
  id: 'p1',
  name: 'Test policy',
  path: os.tmpdir(),
  match: { kind: 'suggestion', groupIds: ['regen-node-modules'] },
  maxBytesPerRun: null,
  maxBytesPerWeek: null,
  cooldownDays: 7,
  dryRunFirst: false,
  requireConfirmationAbove: null,
  enabled: true,
  ...over,
});

/* ══════════════════ A policy cannot be saved in a dangerous shape ══════════════════ */

test('a custom rule with nothing set is refused — it would match every file', () => {
  // Unattended, "delete everything under this folder" is the worst possible
  // policy, and an empty rule set is how someone writes it by accident.
  assert.throws(
    () => normalizePolicy({ path: os.tmpdir(), match: { kind: 'custom' } }),
    (err: unknown) => err instanceof AppError && err.code === 'POLICY_MATCH_EMPTY',
  );
});

test('an age or size that rounds to nothing is no rule: refused as empty, never stored as a 0 that matches every file', () => {
  // A rule is kept in whole milliseconds and whole bytes, and a figure under
  // half of one rounds to 0. A stored 0 is no rule at all - no file is younger
  // than 0 ms or smaller than 0 bytes - so it selected every file under the
  // folder, and each item's recorded reason read "matched your rule: ",
  // stating nothing (review F2.1). It is the empty rule and is refused as one.
  const tmp = os.tmpdir();
  const empty = (err: unknown) => err instanceof AppError && err.code === 'POLICY_MATCH_EMPTY';
  assert.throws(() => normalizePolicy({ path: tmp, match: { kind: 'custom', maxAgeMs: 0.4 } }), empty,
    'an age of 0.4 ms is the empty rule');
  assert.throws(() => normalizePolicy({ path: tmp, match: { kind: 'custom', minBytes: 0.4 } }), empty,
    'a size of 0.4 bytes is the empty rule');
  assert.deepEqual(normalizePolicy({ path: tmp, match: { kind: 'custom', maxAgeMs: 0.4, exts: ['tmp'] } }).match,
    { kind: 'custom', exts: ['tmp'] }, 'beside a real rule, the age that rounds away is left out, not stored as 0');
  // Half a unit or more rounds to a whole one, which is a rule, and every item
  // it picks says what it is.
  const kept: Array<[Record<string, unknown>, Record<string, unknown>]> = [
    [{ kind: 'custom', maxAgeMs: 0.5 }, { kind: 'custom', maxAgeMs: 1 }],
    [{ kind: 'custom', minBytes: 0.5 }, { kind: 'custom', minBytes: 1 }],
  ];
  for (const [sent, stored] of kept) {
    const p = normalizePolicy({ path: tmp, match: sent });
    assert.deepEqual(p.match, stored, `${JSON.stringify(sent)} is kept as ${JSON.stringify(stored)}`);
    const [picked] = selectCandidates([], [{ path: path.join(tmp, 'a'), name: 'a', size: 5 }], p.match);
    assert.match(picked.reason, /^matched your rule: \S/, `the reason ${JSON.stringify(sent)}'s items carry states the rule`);
  }
});

test('beside a real rule, an age or a size that rounds to nothing is left out, never stored as a 0', () => {
  // The size half of the rule above, and each figure beside the other. A
  // stored 0 opens in the editor as a ticked box with no figure, and an
  // untouched Save then sends the box's default in its place - 100 MB, 180
  // days - so the rule nobody edited would change (review F3.2).
  const tmp = os.tmpdir();
  const DAY = 86_400_000;
  const cases: Array<[Record<string, unknown>, Record<string, unknown>]> = [
    [{ kind: 'custom', minBytes: 0.4, exts: ['tmp'] }, { kind: 'custom', exts: ['tmp'] }],
    [{ kind: 'custom', minBytes: 0.4, maxAgeMs: DAY }, { kind: 'custom', maxAgeMs: DAY }],
    [{ kind: 'custom', maxAgeMs: 0.4, minBytes: 2048 }, { kind: 'custom', minBytes: 2048 }],
  ];
  const misstored = cases
    .map(([sent, want]) => ({ sent, want, got: normalizePolicy({ path: tmp, match: sent }).match }))
    .filter(({ want, got }) => !isDeepStrictEqual(got, want))
    .map(({ sent, got }) => `${JSON.stringify(sent)} was stored as ${JSON.stringify(got)}`);
  assert.deepEqual(misstored, [], 'the figure that rounds away is left out beside any real rule');
});

test('a limit that rounds to nothing is no limit, as a 0 is - never stored as a 0 the editor opens blank and saves as no limit', () => {
  // A limit is kept in whole bytes, and it was judged before it was rounded,
  // so 0.4 was stored as 0. The engine reads a stored 0 as a real limit -
  // nothing fits under it - while the policy card leaves it off and the
  // editor opens its box blank, so an untouched Save sent null and widened it
  // to no limit at all, keeping the approval (review F3.1). Judged once
  // rounded, a figure under half a byte is no limit, as a 0 sent always was,
  // and half a byte or more is a one-byte limit.
  const tmp = os.tmpdir();
  const fields = ['maxBytesPerRun', 'maxBytesPerWeek', 'requireConfirmationAbove'] as const;
  const sentAndStored: Array<[number, number | null]> = [[0.4, null], [0, null], [0.5, 1]];
  const misstored: string[] = [];
  for (const field of fields) {
    for (const [sent, want] of sentAndStored) {
      const got = normalizePolicy({ path: tmp, match: { kind: 'custom', exts: ['tmp'] }, [field]: sent })[field];
      if (got !== want) misstored.push(`${field} ${sent} was stored as ${got}, not ${want}`);
    }
  }
  assert.deepEqual(misstored, [], 'every limit is stored as a whole number of bytes above 0, or as no limit');
});

test('PUT /api/autopilot/policies refuses an age that rounds to nothing, as it refuses an empty rule', async () => {
  const tmp = os.tmpdir();
  try {
    const put = await call('PUT', '/api/autopilot/policies', { policies: [{ path: tmp, match: { kind: 'custom', maxAgeMs: 0.4 } }] });
    assert.deepEqual([put.status, put.body.code], [400, 'POLICY_MATCH_EMPTY'], `refused, not stored (${put.body.error})`);
  } finally {
    await savePolicies([]);
  }
});

test('a custom rule carrying the Clean Up duplicate flag is refused, not saved without it', () => {
  // `dup` is a Clean Up rule (GET /api/cleanup/rules?dup=1) with no policy
  // equivalent. Dropping it quietly would store a policy WIDER than the rule
  // that was sent: every file older than 90 days, duplicate or not.
  assert.throws(
    () => normalizePolicy({ path: os.tmpdir(), match: { kind: 'custom', maxAgeMs: 90 * 86_400_000, dup: true } }),
    (err: unknown) => err instanceof AppError && err.code === 'POLICY_MATCH_INVALID' && /duplicate/i.test(err.message),
  );
  // An explicit false narrows nothing, so dropping it changes nothing either.
  const p = normalizePolicy({ path: os.tmpdir(), match: { kind: 'custom', maxAgeMs: 90 * 86_400_000, dup: false } });
  assert.deepEqual(p.match, { kind: 'custom', maxAgeMs: 90 * 86_400_000 });
});

/** One JSON request to a fresh app on an ephemeral port. */
async function call(method: string, url: string, body: unknown): Promise<{ status: number; body: { code?: string; error?: string } }> {
  resetRateLimiter();
  const server = http.createServer(createApp(path.join(__dirname, '..', 'public')));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    const port = (server.address() as { port: number }).port;
    const payload = JSON.stringify(body);
    return await new Promise((resolve, reject) => {
      const r = http.request({ host: '127.0.0.1', port, path: url, method, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } }, (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => { buf += c; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: buf ? JSON.parse(buf) : {} }));
      });
      r.on('error', reject);
      r.end(payload);
    });
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

/** A rule id this platform's packs mark advice-only (final review F1.11). */
const ADVICE_ONLY_ID = ((): string => {
  const c = loadRuleCatalog();
  const rule = [...c.projectDirectory, ...c.directory, ...c.file, ...c.location, ...c.staleFiles].find((r) => r.action === 'advice');
  assert.ok(rule, 'this platform has an advice-only rule');
  return rule.id;
})();

test('every refusal PUT /api/autopilot/policies and POST /api/autopilot/simulate give is named in the published spec', async () => {
  // A client generated from GET /api/openapi.json learns a route's error codes
  // from its description. The duplicate-flag refusal above reuses
  // POLICY_MATCH_INVALID, which the spec had never listed, and the same save
  // gave several more it did not name. Each case here provokes one, over HTTP.
  const tmp = os.tmpdir();
  const ok = { kind: 'custom', maxAgeMs: 86_400_000 };
  const blocked = process.platform === 'win32' ? 'C:\\Windows\\System32' : '/dev';
  const policyCases: Array<[string, unknown]> = [
    ['POLICY_PATH_REQUIRED', { match: ok }],
    ['PATH_INVALID', { path: `${tmp}/a\u0000b`, match: ok }],
    ['PATH_BLOCKED', { path: blocked, match: ok }],
    ['POLICY_PATH_TOO_BROAD', { path: path.parse(tmp).root, match: ok }],
    ['POLICY_MATCH_EMPTY', { path: tmp, match: { kind: 'suggestion', groupIds: [] } }],
    ['POLICY_MATCH_INVALID', { path: tmp, match: { ...ok, dup: true } }],
    ['POLICY_QUERY_INVALID', { path: tmp, match: { kind: 'query', q: 'nosuchfield:1' } }],
    ['POLICY_QUERY_UNANSWERABLE', { path: tmp, match: { kind: 'query', q: 'dupe:yes' } }],
    ['POLICY_MATCH_ADVISORY', { path: tmp, match: { kind: 'suggestion', groupIds: [ADVICE_ONLY_ID] } }],
  ];
  if (IS_UNIX) {
    // A folder given as a link (POL item 5); making a link needs a privilege on Windows.
    const link = path.join(fileTempDir('tm-ap-spec-'), 'lnk');
    fs.symlinkSync(tmp, link, 'dir');
    policyCases.push(['POLICY_PATH_IS_LINK', { path: link, match: ok }]);
  }
  const routes: Record<string, Array<[string, unknown]>> = {
    'put /api/autopilot/policies': [
      ['NOTHING_TO_UPDATE', {}],
      ['BAD_POLICIES', { policies: 'not a list' }],
      ['TOO_MANY_POLICIES', { policies: Array.from({ length: 51 }, () => ({ path: tmp, match: ok })) }],
      ['DUPLICATE_POLICY_ID', { policies: [{ id: 'same', path: tmp, match: ok }, { id: 'same', name: 'Another', path: tmp, match: ok }] }],
      ...policyCases.map(([code, policy]): [string, unknown] => [code, { policies: [policy] }]),
    ],
    'post /api/autopilot/simulate': [
      ['POLICY_REQUIRED', {}],
      ...policyCases.map(([code, policy]): [string, unknown] => [code, { policy }]),
    ],
  };
  const doc = buildOpenApiDocument() as {
    paths: Record<string, Record<string, { responses: Record<string, { description: string }> }>>;
  };
  for (const [route, cases] of Object.entries(routes)) {
    const [method, url] = route.split(' ') as [string, string];
    const documented = doc.paths[url]?.[method]?.responses['400']?.description ?? '';
    for (const [code, body] of cases) {
      const got = await call(method.toUpperCase(), url, body);
      assert.deepEqual([got.status, got.body.code], [400, code], `${route}: the case for ${code} provokes exactly that refusal (${got.body.error})`);
      assert.match(documented, new RegExp(`\\b${code}\\b`), `the spec's 400 for ${route} names ${code}`);
    }
  }
  assert.deepEqual(await listPolicies(), [], 'no refused save stored anything');
});

test('the editor\'s Preview judges a saved policy as Save does', async () => {
  // Preview sends the policy being edited, id and all. A policy an earlier
  // build saved with a condition this build cannot answer is accepted by Save
  // while it stays unchanged; Preview refused it, so the one button meant to
  // show what it does said it could not be saved.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-autopilot-preview-'));
  const old: AutopilotPolicy = {
    id: 'legacy', name: 'Old duplicates', path: dir, match: { kind: 'query', q: 'dupe:yes ext:jpg' },
    maxBytesPerRun: null, maxBytesPerWeek: null, cooldownDays: 7, dryRunFirst: true, requireConfirmationAbove: null, enabled: false,
  };
  await writeJsonFile('autopilot.json', { version: 1, policies: [old], runs: [] });
  try {
    const same = await call('POST', '/api/autopilot/simulate', { policy: old });
    assert.equal(same.status, 200, `unchanged, it previews: ${JSON.stringify(same.body)}`);
    const changed = await call('POST', '/api/autopilot/simulate', { policy: { ...old, match: { kind: 'query', q: 'dupe:yes ext:png' } } });
    assert.deepEqual([changed.status, changed.body.code], [400, 'POLICY_QUERY_UNANSWERABLE'], 'changed, it is refused as Save would refuse it');
    const fresh = await call('POST', '/api/autopilot/simulate', { policy: { ...old, id: undefined } });
    assert.deepEqual([fresh.status, fresh.body.code], [400, 'POLICY_QUERY_UNANSWERABLE'], 'and so is a new one');
  } finally {
    await savePolicies([]);
  }
});

test('two policies in one list may not share an id', async () => {
  // The second would inherit the first one's approval and pass as unchanged.
  const tmp = os.tmpdir();
  await assert.rejects(
    savePolicies([{ id: 'same', name: 'One', path: tmp, match: { kind: 'custom', maxAgeMs: 1 } }, { id: 'same', name: 'Two', path: tmp, match: { kind: 'custom', minBytes: 1 } }]),
    (err: unknown) => err instanceof AppError && err.code === 'DUPLICATE_POLICY_ID' && /"same"/.test(err.message),
  );
  assert.deepEqual(await listPolicies(), [], 'nothing was stored');
});

test('a suggestion match with no groups is refused', () => {
  assert.throws(
    () => normalizePolicy({ path: os.tmpdir(), match: { kind: 'suggestion', groupIds: [] } }),
    (err: unknown) => err instanceof AppError && err.code === 'POLICY_MATCH_EMPTY',
  );
});

test('a policy needs a folder, and it goes through the same guard as a scan path', () => {
  assert.throws(
    () => normalizePolicy({ match: { kind: 'suggestion', groupIds: ['x'] } }),
    (err: unknown) => err instanceof AppError && err.code === 'POLICY_PATH_REQUIRED',
  );
  // The shared sanitizer refuses virtual filesystems. POSIX-only: on a
  // Windows host the sanitizer resolves '/proc' to 'C:\proc' — an ordinary,
  // permissible path there — so the refusal genuinely does not (and should
  // not) fire. The NUL check below is invalid on every OS.
  if (process.platform !== 'win32') {
    assert.throws(() => normalizePolicy({ path: '/proc', match: { kind: 'suggestion', groupIds: ['x'] } }));
  }
  assert.throws(() => normalizePolicy({ path: 'x\0y', match: { kind: 'suggestion', groupIds: ['x'] } }));
});

test('a policy cannot be pointed at the whole drive', () => {
  // The shared sanitizer allows scanning "/" — reasonable for a disk tool. A
  // standing instruction to delete unattended is a different proposition, so
  // Autopilot narrows it rather than relying on a guard tuned for scanning.
  assert.throws(
    () => normalizePolicy({ path: '/', match: { kind: 'suggestion', groupIds: ['x'] } }),
    (err: unknown) => err instanceof AppError && err.code === 'POLICY_PATH_TOO_BROAD',
  );
});

test('agent-policy.json protected paths bind Autopilot too', async () => {
  // agent-policy.json is the user's own "never destroy these" list. It was
  // written for the API surface, but an unattended deleter is precisely what
  // those paths need protecting from.
  const dir = await mkTmp();
  try {
    const keep = path.join(dir, 'proj');
    await writeFile(path.join(keep, 'node_modules', 'x', 'a.bin'), 4096);
    await writeJsonFile('agent-policy.json', { allowedRoots: [], protectedPaths: [keep], maxBytesPerOperation: null });

    const [policy] = await savePolicies([{
      id: 'protected', name: 'p', path: dir,
      match: { kind: 'suggestion', groupIds: ['regen-node-modules'] },
      dryRunFirst: false, enabled: true,
    }]);
    await approvePolicyForTests(policy.id);

    const result = await runPolicy((await listPolicies())[0]);
    assert.equal(result.bytesDeleted, 0);
    assert.ok(result.skipped.some((s) => /protected path/i.test(s.reason)),
      'the protected match is skipped, and the run record says why');
    assert.ok(fs.existsSync(path.join(keep, 'node_modules')));
  } finally {
    await writeJsonFile('agent-policy.json', {});
    await savePolicies([]);
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('a client cannot grant its own approval by sending the field', () => {
  // Otherwise the mandatory first dry run is one crafted request away from
  // being skipped entirely.
  const p = normalizePolicy({
    path: os.tmpdir(),
    match: { kind: 'suggestion', groupIds: ['regen-node-modules'] },
    approvedAt: 12345,
    lastRunAt: 999,
  });
  assert.equal(p.approvedAt, undefined);
  assert.equal(p.lastRunAt, undefined);
});

test('a new policy is disabled unless explicitly enabled', () => {
  const p = normalizePolicy({ path: os.tmpdir(), match: { kind: 'suggestion', groupIds: ['a'] } });
  assert.equal(p.enabled, false);
  assert.equal(p.dryRunFirst, true, 'and previews by default');
});

test('editing what a policy matches revokes the approval it already had', async () => {
  const saved = await savePolicies([
    { id: 'edit-me', path: os.tmpdir(), match: { kind: 'suggestion', groupIds: ['regen-node-modules'] }, enabled: true },
  ]);
  await approvePolicyForTests(saved[0].id);
  assert.ok((await listPolicies())[0].approvedAt, 'approved');

  // "Approve a tiny dry run, then edit the policy to match everything" is the
  // exact bypass this closes.
  const edited = await savePolicies([
    { id: 'edit-me', path: os.tmpdir(), match: { kind: 'suggestion', groupIds: ['regen-node-modules', 'cache-npm'] }, enabled: true },
  ]);
  assert.equal(edited[0].approvedAt, undefined, 'a wider policy must earn approval again');
  await savePolicies([]);
});

test('sameScope compares where and what, not the cosmetic fields', () => {
  const a = basePolicy();
  assert.equal(sameScope(a, basePolicy({ name: 'renamed', cooldownDays: 30 })), true);
  assert.equal(sameScope(a, basePolicy({ path: os.homedir() })), false);
  assert.equal(sameScope(a, basePolicy({ match: { kind: 'suggestion', groupIds: ['other'] } })), false);
});

/* ══════════════════ Selection and caps (pure) ══════════════════ */

test('only the chosen suggestion groups are selected, and each carries its reason', () => {
  const groups = [
    group('regen-node-modules', [{ path: '/p/node_modules', size: 500 }]),
    group('cache-other', [{ path: '/p/.cache', size: 900 }]),
  ];
  const picked = selectCandidates(groups, [], { kind: 'suggestion', groupIds: ['regen-node-modules'] });
  assert.deepEqual(picked.map((c) => c.path), ['/p/node_modules']);
  assert.match(picked[0].reason, /regen-node-modules/, 'the rule’s own words travel with the candidate');
});

test('a candidate from a group whose restore command names its folder carries the command for its own folder, the name quoted where a shell needs it (BQL item 7)', async () => {
  // The run record and the Undo Vault entry carried "python3 -m venv <folder>, …" — pasted into zsh,
  // `<` is a redirect: "no such file or directory: folder".
  const venv = { ...group('regen-python-venv', [{ path: '/p/proj/.venv', size: 300 }, { path: '/p/my scripts/my env', size: 200 }]),
    regenerateCmd: 'python3 -m venv <folder>, then reinstall the packages it held' };
  const picked = selectCandidates([venv], [], { kind: 'suggestion', groupIds: ['regen-python-venv'] });
  assert.deepEqual(picked.map((c) => [c.name, c.regenerateCmd]), [
    ['.venv', 'python3 -m venv .venv, then reinstall the packages it held'],
    ['my env', "python3 -m venv 'my env', then reinstall the packages it held"],
  ], 'each candidate names its own folder, a name with a space quoted');
  const npm = { ...group('regen-node-modules', [{ path: '/p/node_modules', size: 1 }]), regenerateCmd: 'npm install' };
  assert.equal(selectCandidates([npm], [], { kind: 'suggestion', groupIds: ['regen-node-modules'] })[0].regenerateCmd, 'npm install',
    'a command with no placeholder travels as the rule wrote it');
  // Through a real preview, which is what a run record is built from.
  const dir = fs.realpathSync(await mkTmp());
  try {
    await writeFile(path.join(dir, 'proj', 'requirements.txt'), 100);
    await writeFile(path.join(dir, 'proj', '.venv', 'pyvenv.cfg'), 4096);
    const [policy] = await savePolicies([{ id: 'venv-7', name: 'Virtualenvs', path: dir, match: { kind: 'suggestion', groupIds: ['regen-python-venv'] }, dryRunFirst: false, enabled: true }]);
    const { items } = await simulatePolicy(policy);
    assert.deepEqual(items.map((i) => [path.relative(dir, i.path), i.regenerateCmd]),
      [[path.join('proj', '.venv'), 'python3 -m venv .venv, then reinstall the packages it held']], 'the previewed item carries its own command');
  } finally {
    await savePolicies([]);
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('a custom match explains itself in words a person can check', () => {
  const picked = selectCandidates([], [{ path: '/p/big.dmg', name: 'big.dmg', size: 5 * MB }],
    { kind: 'custom', minBytes: MB, maxAgeMs: 90 * 86_400_000, exts: ['dmg'] });
  assert.equal(picked.length, 1);
  assert.match(picked[0].reason, /at least 1\.0 MB/);
  assert.match(picked[0].reason, /older than 90 days/);
  assert.match(picked[0].reason, /\.dmg/);
});

test('candidates come back largest first', () => {
  const picked = selectCandidates([group('g', [
    { path: '/a', size: 10 }, { path: '/b', size: 900 }, { path: '/c', size: 50 },
  ])], [], { kind: 'suggestion', groupIds: ['g'] });
  assert.deepEqual(picked.map((c) => c.bytes), [900, 50, 10]);
});

test('a run never exceeds its cap, and says what it left behind', () => {
  // §B1 acceptance: "A byte-capped policy never exceeds its cap in a run."
  const { selected, skipped } = applyCaps([candidate('a', 60), candidate('b', 30), candidate('c', 20)], 100);
  const total = selected.reduce((s, c) => s + c.bytes, 0);
  assert.ok(total <= 100, `selected ${total} bytes against a cap of 100`);
  assert.deepEqual(selected.map((c) => c.name), ['a', 'b']);
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].reason, /limit of 100 B was reached/);
});

test('one oversized item does not block every smaller thing behind it', () => {
  const { selected, skipped } = applyCaps([candidate('huge', 5000), candidate('small', 10)], 100);
  assert.deepEqual(selected.map((c) => c.name), ['small']);
  assert.deepEqual(skipped.map((s) => s.path), ['/x/huge']);
});

test('no cap means no ceiling and nothing skipped', () => {
  const { selected, skipped } = applyCaps([candidate('a', 1e9)], null);
  assert.equal(selected.length, 1);
  assert.deepEqual(skipped, []);
});

/* ══════════════════ The weekly budget ══════════════════ */

const run = (over: Partial<AutopilotRun>): AutopilotRun => ({
  id: crypto.randomUUID(), policyId: 'p1', policyName: 'p', at: Date.now(),
  mode: 'live', status: 'completed', items: [], bytesMatched: 0, bytesDeleted: 0, skipped: [], ...over,
});

test('the weekly total counts only live runs, in window, that were not undone', () => {
  const now = Date.now();
  const runs = [
    run({ bytesDeleted: 100, at: now - 86_400_000 }),
    run({ bytesDeleted: 999, at: now - 86_400_000, mode: 'dry-run' }),   // simulated
    run({ bytesDeleted: 500, at: now - 30 * 86_400_000 }),               // out of window
    run({ bytesDeleted: 400, at: now - 86_400_000, undoneAt: now }),     // put back
    run({ bytesDeleted: 50, at: now - 86_400_000, policyId: 'other' }),  // another policy
  ];
  assert.equal(bytesDeletedSince(runs, 'p1', now - 7 * 86_400_000), 100);
});

test('the effective cap is the tighter of the per-run and weekly limits', () => {
  const now = Date.now();
  const spent = [run({ bytesDeleted: 800, at: now - 86_400_000 })];
  // 1000-per-week with 800 spent leaves 200, which is tighter than a 500 run cap.
  assert.equal(effectiveCap(basePolicy({ maxBytesPerRun: 500, maxBytesPerWeek: 1000 }), spent, now), 200);
  // With nothing spent the per-run cap is the binding one.
  assert.equal(effectiveCap(basePolicy({ maxBytesPerRun: 500, maxBytesPerWeek: 1000 }), [], now), 500);
  assert.equal(effectiveCap(basePolicy(), [], now), null, 'no caps set = no ceiling');
  // A spent week clamps to zero rather than going negative.
  assert.equal(effectiveCap(basePolicy({ maxBytesPerWeek: 100 }), [run({ bytesDeleted: 500, at: now })], now), 0);
});

/* ══════════════════ The mandatory first dry run ══════════════════ */

test('a brand-new policy simulates and deletes nothing, however it is configured', async () => {
  const dir = await mkTmp();
  try {
    // Configured as aggressively as the model allows: enabled, no preview, no
    // caps, no confirmation threshold. It must STILL only simulate.
    await writeFile(path.join(dir, 'project', 'node_modules', 'dep', 'a.bin'), 4096);
    const [policy] = await savePolicies([{
      id: 'first-run', name: 'Aggressive', path: dir,
      match: { kind: 'suggestion', groupIds: ['regen-node-modules'] },
      dryRunFirst: false, enabled: true,
    }]);

    const result = await runPolicy(policy);
    assert.equal(result.status, 'awaiting-approval');
    assert.equal(result.mode, 'dry-run');
    assert.equal(result.bytesDeleted, 0);
    assert.match(result.blockedReason ?? '', /never run/);
    assert.ok(result.items.length > 0, 'and it shows exactly what it would have deleted');
    assert.ok(fs.existsSync(path.join(dir, 'project', 'node_modules')), 'nothing was touched');
  } finally {
    await savePolicies([]);
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

/* ══════════════════ Never a part of an installed app (fifth browser pass F01) ══════════════════ */

test('an unattended run never selects a file inside an installed app, whatever its match — a size rule, a query or a rule pack\'s suggestion — the app is listed in skipped once, with how many it left and why (fifth browser pass F01; review F1.8)', async () => {
  // QA: Largest Files on /Applications was six app internals (Chrome's
  // framework, WhatsApp's own executable, an app.asar). A size rule over a
  // folder of apps would trash them while nobody is watching.
  const dir = await mkTmp();
  try {
    await writeFile(path.join(dir, 'Fake.app', 'Contents', 'MacOS', 'Fake'), 2 * MB);
    await writeFile(path.join(dir, 'Fake.app', 'Contents', 'Resources', 'app.asar'), 2 * MB);
    await writeFile(path.join(dir, 'loose.bin'), 2 * MB);
    for (const match of [{ kind: 'custom' as const, minBytes: MB }, { kind: 'query' as const, q: 'size>1mb' }]) {
      const [policy] = await savePolicies([{ id: `apps-${match.kind}`, name: 'Big files', path: dir, match, dryRunFirst: false, enabled: true }]);
      const sim = await simulatePolicy(policy);
      assert.deepEqual(sim.items.map((i) => path.basename(i.path)), ['loose.bin'], `${match.kind}: control: the loose file is selected, and nothing inside the app`);
      const left = sim.skipped.filter((s) => s.path.includes('Fake.app'));
      assert.equal(left.length, 1, `${match.kind}: the app is named once, not once per file: ${JSON.stringify(sim.skipped)}`);
      assert.equal(path.basename(left[0].path), 'Fake.app', `${match.kind}: by the whole app`);
      assert.match(left[0].reason, /2 matched items inside the app “Fake”/, `${match.kind}: with how many it left, and in which app`);
      assert.match(left[0].reason, /which would stop working without them/, `${match.kind}: and why`);
    }
    // The third kind, a rule pack's suggestion, selects folders — an Electron
    // app's own node_modules among them, the likeliest part of an app such a
    // rule matches (review F1.8).
    await writeFile(path.join(dir, 'Fake.app', 'Contents', 'Resources', 'app', 'node_modules', 'dep', 'index.js'), 4096);
    await writeFile(path.join(dir, 'proj', 'node_modules', 'dep', 'index.js'), 4096);
    const [suggestion] = await savePolicies([{ id: 'apps-suggestion', name: 'Build folders', path: dir, match: { kind: 'suggestion', groupIds: ['regen-node-modules'] }, dryRunFirst: false, enabled: true }]);
    const sim = await simulatePolicy(suggestion);
    assert.deepEqual(sim.items.map((i) => path.relative(dir, i.path)), [path.join('proj', 'node_modules')], 'suggestion: control: the project\'s node_modules is selected, and nothing inside the app');
    const left = sim.skipped.filter((s) => s.path.includes('Fake.app'));
    assert.equal(left.length, 1, `suggestion: the app is named once: ${JSON.stringify(sim.skipped)}`);
    assert.match(left[0].reason, /1 matched item inside the app “Fake”/, 'suggestion: the app\'s own node_modules is left alone, and counted');
  } finally {
    await savePolicies([]);
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('a "Tool caches" policy never selects a virtualenv with no project beside it, or a folder named coverage on its name alone: nothing makes either again by itself (BQL item 7b)', async () => {
  // An approved policy on "Tool caches" trashed both unattended, recording
  // "Caches left by dev tools — rebuilt automatically when needed" as the
  // reason in the run record and the Undo Vault entry.
  const dir = fs.realpathSync(await mkTmp());
  try {
    await writeFile(path.join(dir, 'scripts', '.venv', 'pyvenv.cfg'), 200);
    await writeFile(path.join(dir, 'scripts', '.venv', 'lib', 'site.py'), 4096);
    await writeFile(path.join(dir, 'scripts', 'run.py'), 300);
    await writeFile(path.join(dir, 'Insurance', 'coverage', 'home-policy.pdf'), 4096);
    await writeFile(path.join(dir, 'proj', '.pytest_cache', 'v', 'cache', 'lastfailed'), 4096);
    await writeFile(path.join(dir, 'web', 'package.json'), 100);
    await writeFile(path.join(dir, 'web', 'coverage', 'lcov.info'), 4096);
    const rel = (items: { path: string }[]) => items.map((i) => path.relative(dir, i.path)).sort();
    const [caches] = await savePolicies([{ id: 'tool-caches-7b', name: 'Tool caches', path: dir, match: { kind: 'suggestion', groupIds: ['tool-caches'] }, dryRunFirst: false, enabled: true }]);
    assert.deepEqual(rel((await simulatePolicy(caches)).items), [path.join('proj', '.pytest_cache')],
      'control: the pytest cache is selected — and neither the virtualenv nor the folder of insurance papers');
    // A coverage folder beside package.json is the test tools' own, a group of its own a policy may name.
    const [both] = await savePolicies([{ id: 'coverage-7b', name: 'Caches and coverage', path: dir, match: { kind: 'suggestion', groupIds: ['tool-caches', 'test-coverage'] }, dryRunFirst: false, enabled: true }]);
    assert.deepEqual(rel((await simulatePolicy(both)).items), [path.join('proj', '.pytest_cache'), path.join('web', 'coverage')].sort(),
      'the JavaScript project\'s coverage reports are selected, the insurance papers still are not');
  } finally {
    await savePolicies([]);
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('a "Build output" or bytecode policy never selects a part of pip inside a virtualenv no rule claims: its build package is pip\'s own (BQL-b1 review F1.1, F1.3, F1.6)', async () => {
  // An approved policy on "Build output" would have trashed
  // .venv/lib/python3.12/site-packages/pip/_internal/operations/build
  // unattended, recording "regenerated by the next build" in the run record
  // and the Undo Vault entry; pip in that virtualenv then cannot build a wheel.
  const dir = fs.realpathSync(await mkTmp());
  try {
    const pip = path.join(dir, 'scripts', '.venv', 'lib', 'python3.12', 'site-packages', 'pip');
    await writeFile(path.join(dir, 'scripts', '.venv', 'pyvenv.cfg'), 200);
    await writeFile(path.join(pip, '__init__.py'), 400);
    await writeFile(path.join(pip, '__pycache__', '__init__.cpython-312.pyc'), 700);
    await writeFile(path.join(pip, '_internal', 'operations', 'build', 'wheel.py'), 4096);
    await writeFile(path.join(dir, 'scripts', 'run.py'), 300);
    await writeFile(path.join(dir, 'proj', 'build', 'app.o'), 4096);
    await writeFile(path.join(dir, 'proj', 'src', '__pycache__', 'app.cpython-312.pyc'), 900);
    const rel = (items: { path: string }[]) => items.map((i) => path.relative(dir, i.path)).sort();
    const [policy] = await savePolicies([{ id: 'build-b1', name: 'Build output and bytecode', path: dir, match: { kind: 'suggestion', groupIds: ['build-output', 'regen-pycache'] }, dryRunFirst: false, enabled: true }]);
    assert.deepEqual(rel((await simulatePolicy(policy)).items), [path.join('proj', 'build'), path.join('proj', 'src', '__pycache__')].sort(),
      'control: the project\'s build folder and bytecode are selected — and nothing of pip in the virtualenv');
  } finally {
    await savePolicies([]);
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('a run that left everything it matched alone, as parts of an installed program, says so — never "Nothing matched this time." beside its own list of what it left (review F1.2)', async () => {
  const dir = await mkTmp();
  const trashed: string[] = [];
  setTrashStepForTests(async (p) => { trashed.push(p); });
  try {
    await writeFile(path.join(dir, 'Fake.app', 'Contents', 'MacOS', 'Fake'), 2 * MB);
    await writeFile(path.join(dir, 'Fake.app', 'Contents', 'Resources', 'app.asar'), 2 * MB);
    const [policy] = await savePolicies([{ id: 'apps-only', name: 'Big files', path: dir, match: { kind: 'custom', minBytes: MB }, dryRunFirst: false, enabled: true }]);
    await approvePolicyForTests(policy.id);
    const run = await runPolicy((await listPolicies())[0]);
    assert.deepEqual(run.items, [], 'control: nothing inside the app is selected');
    assert.ok(run.skipped.some((s) => /2 matched items inside the app “Fake”/.test(s.reason)), `control: the app is named in skipped: ${JSON.stringify(run.skipped)}`);
    assert.equal(run.blockedReason, 'Everything that matched is part of an installed program — nothing was deleted.', 'it says why nothing was deleted');
    assert.deepEqual(trashed, [], 'nothing reached the Trash step');
  } finally {
    setTrashStepForTests(null);
    await savePolicies([]);
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('a run whose matches agent-policy.json refused says so, alone or beside parts of an installed program — never "Nothing matched this time." nor a reason that covers only some of what it left (review round 2, F2.3, F2.4)', async () => {
  // A file under a protected path matched and was refused in the run's own
  // agent-policy check: the run said "Nothing matched this time." above its
  // own skipped entry for it, and beside an app's files "Everything that
  // matched is part of an installed program", which the protected file is not.
  const dir = await mkTmp();
  const trashed: string[] = [];
  setTrashStepForTests(async (p) => { trashed.push(p); });
  try {
    const keep = path.join(dir, 'keep');
    await writeFile(path.join(keep, 'big.bin'), 2 * MB);
    await writeJsonFile('agent-policy.json', { allowedRoots: [], protectedPaths: [keep], maxBytesPerOperation: null });
    const match = { kind: 'custom' as const, minBytes: MB };
    const [alone] = await savePolicies([{ id: 'protected-only', name: 'Big files', path: dir, match, dryRunFirst: false, enabled: true }]);
    await approvePolicyForTests(alone.id);
    const refused = await runPolicy((await listPolicies())[0]);
    assert.deepEqual(refused.items, [], 'control: nothing is selected');
    assert.ok(refused.skipped.some((s) => /protected path/.test(s.reason)), `control: the protected file is in skipped: ${JSON.stringify(refused.skipped)}`);
    assert.equal(refused.blockedReason, 'Everything that matched is refused by your agent-policy.json — nothing was deleted.', 'it says why nothing was deleted');

    await writeFile(path.join(dir, 'Fake.app', 'Contents', 'MacOS', 'Fake'), 2 * MB);
    const [mixed] = await savePolicies([{ id: 'protected-and-app', name: 'Big files', path: dir, match, dryRunFirst: false, enabled: true }]);
    await approvePolicyForTests(mixed.id);
    const both = await runPolicy((await listPolicies())[0]);
    assert.deepEqual(both.items, [], 'control: nothing is selected');
    assert.ok(both.skipped.some((s) => /inside the app “Fake”/.test(s.reason)) && both.skipped.some((s) => /protected path/.test(s.reason)),
      `control: both are in skipped: ${JSON.stringify(both.skipped)}`);
    assert.equal(both.blockedReason, 'Everything that matched is part of an installed program or refused by your agent-policy.json — nothing was deleted.', 'it names both reasons');
    assert.deepEqual(trashed, [], 'nothing reached the Trash step');
  } finally {
    setTrashStepForTests(null);
    await writeJsonFile('agent-policy.json', {});
    await savePolicies([]);
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('a run whose every candidate is over its allowance says so beside every other reason it left something alone — never "Everything it matched is larger than the remaining allowance" above a part of an installed program, which is left for another reason (review round 3, F3.1)', async () => {
  // maxBytesPerRun 1 MiB; a 2 MiB file outside any program, and a file inside
  // an app: the app's file is left alone as a part of the app, and the loose
  // file because it alone is over the cap. The run said "Everything it matched
  // is larger than the remaining allowance", which the app's file is not.
  const dir = await mkTmp();
  const alone = await mkTmp();
  const trashed: string[] = [];
  setTrashStepForTests(async (p) => { trashed.push(p); });
  const overLimit = (s: { path: string; reason: string }): boolean => path.basename(s.path) === 'loose.bin' && /limit of .* was reached/.test(s.reason);
  try {
    const match = { kind: 'custom' as const, minBytes: MB };
    await writeFile(path.join(dir, 'loose.bin'), 2 * MB);
    await writeFile(path.join(dir, 'Fake.app', 'Contents', 'MacOS', 'Fake'), 2 * MB);
    const [mixed] = await savePolicies([{ id: 'over-allowance-and-app', name: 'Big files', path: dir, match, maxBytesPerRun: MB, dryRunFirst: false, enabled: true }]);
    await approvePolicyForTests(mixed.id);
    const both = await runPolicy((await listPolicies())[0]);
    assert.deepEqual(both.items, [], 'control: nothing is selected');
    assert.ok(both.skipped.some((s) => /inside the app “Fake”/.test(s.reason)) && both.skipped.some(overLimit),
      `control: the app's file and the loose file are both in skipped: ${JSON.stringify(both.skipped)}`);
    assert.equal(both.blockedReason, 'Everything that matched is part of an installed program or larger than the remaining allowance — nothing was deleted.', 'it names both reasons');

    await writeFile(path.join(alone, 'loose.bin'), 2 * MB);
    const [over] = await savePolicies([{ id: 'over-allowance', name: 'Big files', path: alone, match, maxBytesPerRun: MB, dryRunFirst: false, enabled: true }]);
    await approvePolicyForTests(over.id);
    const capped = await runPolicy((await listPolicies())[0]);
    assert.deepEqual(capped.items, [], 'control: nothing is selected');
    assert.ok(capped.skipped.some(overLimit), `control: the loose file is in skipped: ${JSON.stringify(capped.skipped)}`);
    assert.equal(capped.blockedReason, 'Everything that matched is larger than the remaining allowance — nothing was deleted.', 'alone, the allowance is the reason');
    assert.deepEqual(trashed, [], 'nothing reached the Trash step');
  } finally {
    setTrashStepForTests(null);
    await savePolicies([]);
    await fsp.rm(dir, { recursive: true, force: true });
    await fsp.rm(alone, { recursive: true, force: true });
  }
});

test('a policy whose folder is reached through a link into an app never selects the app\'s files: each is judged where it really is (review F1.5)', { skip: !IS_UNIX && 'symlinks need a privilege on Windows' }, async () => {
  const dir = await mkTmp();
  try {
    const contents = path.join(dir, 'apps', 'Foo.app', 'Contents');
    await writeFile(path.join(contents, 'Resources', 'big.bin'), 2 * MB);
    fs.symlinkSync(contents, path.join(dir, 'L'), 'dir');
    // A real folder, a link in the folders above it: such a policy saves.
    const [policy] = await savePolicies([{ id: 'via-parent-link', name: 'Big files', path: path.join(dir, 'L', 'Resources'), match: { kind: 'custom', minBytes: MB }, dryRunFirst: false, enabled: true }]);
    const sim = await simulatePolicy(policy);
    assert.deepEqual(sim.items.map((i) => i.path), [], 'nothing inside Foo.app is selected');
    const left = sim.skipped.filter((s) => /inside the app “Foo”/.test(s.reason));
    assert.equal(left.length, 1, `the app is named in skipped, once: ${JSON.stringify(sim.skipped)}`);
    assert.equal(left[0].path, path.join(fs.realpathSync(dir), 'apps', 'Foo.app'), 'where it really is');
  } finally {
    await savePolicies([]);
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('a policy whose folder is a link acts on nothing through it: the scan takes the link as the one file it is, as before (QA D78 — a scan of a link elsewhere follows it)', { skip: !IS_UNIX && 'symlinks need a privilege on Windows' }, async () => {
  // A person's scan of a link is of the folder it points to (D78). An unattended
  // policy is not: every check made of its folder — never a whole drive, notes,
  // protected paths, TreeMap's own spill folder — was made of the saved spelling,
  // and a link (~/all -> /) can lead anywhere since.
  const dir = await mkTmp();
  try {
    await writeFile(path.join(dir, 'real', 'project', 'node_modules', 'dep', 'a.bin'), 4096);
    const link = path.join(dir, 'lnk');
    fs.symlinkSync(path.join(dir, 'real'), link, 'dir');
    const match = { kind: 'suggestion', groupIds: ['regen-node-modules'] };
    const [direct] = await savePolicies([{ id: 'direct', name: 'Direct', path: path.join(dir, 'real'), match }]);
    // A link folder can no longer be saved (POL item 5): this one is as an earlier build stored it.
    const viaLink: AutopilotPolicy = { ...direct, id: 'via-link', name: 'Via link', path: link };
    await writeJsonFile('autopilot.json', { version: 1, policies: [direct, viaLink], runs: [] });
    assert.ok((await simulatePolicy(direct)).items.length > 0, 'the folder by its own path matches');
    const sim = await simulatePolicy(viaLink);
    assert.deepEqual(sim.items, [], 'through the link, nothing');
    assert.equal(sim.bytesMatched, 0);
    assert.ok(fs.existsSync(path.join(dir, 'real', 'project', 'node_modules')), 'nothing was touched');
  } finally {
    await savePolicies([]);
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('a policy cannot be saved with a folder that is a link: 400 POLICY_PATH_IS_LINK names the folder it leads to, which the person can choose instead — as Preview judges it; one an earlier build saved is kept while it stays unchanged (POL item 5)', { skip: !IS_UNIX && 'symlinks need a privilege on Windows' }, async () => {
  // A scan a person starts follows a root that is a link, and says so (QA D78).
  // A policy is an unattended deleter: its checks are made of the saved
  // spelling, and a link can be pointed anywhere after the policy is
  // approved, so its run takes the link as the one file it is and matches
  // nothing. Saving one said nothing, and the policy silently never acted.
  const dir = fs.realpathSync(await mkTmp());
  const esc = (t: string): string => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  try {
    const real = path.join(dir, 'real');
    fs.mkdirSync(real);
    const link = path.join(dir, 'lnk');
    fs.symlinkSync(real, link, 'dir');
    const dangling = path.join(dir, 'gone');
    fs.symlinkSync(path.join(dir, 'not-made'), dangling, 'dir');
    const match = { kind: 'custom', minBytes: 1 };
    const refusal = (p: string, id?: string): Promise<unknown> => savePolicies([{ ...(id ? { id } : {}), name: 'Via link', path: p, match }])
      .then(() => 'saved', (err: unknown) => (err instanceof AppError ? [err.status, err.code, err.message] : String(err)));
    const viaLink = await refusal(link) as [number, string, string];
    assert.deepEqual(viaLink.slice(0, 2), [400, 'POLICY_PATH_IS_LINK'], String(viaLink));
    assert.match(viaLink[2], new RegExp(`^"${esc(link)}" is a link to "${esc(real)}"\\. .*Choose "${esc(real)}" itself\\.$`), 'it names the folder the link leads to, to choose instead');
    const gone = await refusal(dangling) as [number, string, string];
    assert.deepEqual(gone.slice(0, 2), [400, 'POLICY_PATH_IS_LINK'], 'a link to nothing is a link too');
    assert.match(gone[2], new RegExp(`^"${esc(dangling)}" is a link to "${esc(path.join(dir, 'not-made'))}"`), 'named where it would lead');
    // The folder itself saves, and changing a saved policy's folder to the link is refused.
    const [saved] = await savePolicies([{ id: 'p', name: 'Real', path: real, match }]);
    assert.deepEqual((await refusal(link, 'p') as unknown[]).slice(0, 2), [400, 'POLICY_PATH_IS_LINK'], 'a changed folder is judged as a new one');
    // An earlier build stored one: kept while unchanged, so the rest of the list can still be edited.
    const old: AutopilotPolicy = { ...saved, id: 'old', name: 'Old', path: link };
    await writeJsonFile('autopilot.json', { version: 1, policies: [saved, old], runs: [] });
    const kept = await savePolicies([{ ...saved, name: 'Renamed' }, old]);
    assert.deepEqual(kept.map((p) => [p.id, p.name, p.path]), [['p', 'Renamed', real], ['old', 'Old', link]]);
    // Preview judges a new one as Save does.
    const preview = await call('POST', '/api/autopilot/simulate', { policy: { name: 'Via link', path: link, match } });
    assert.deepEqual([preview.status, preview.body.code], [400, 'POLICY_PATH_IS_LINK']);
  } finally {
    await savePolicies([]);
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('the folder a link policy’s refusal tells the person to choose is one a policy can be saved with — never a whole drive, nor another link — and where there is none it names none (POL item 5 review, F1.5)', { skip: !IS_UNIX && 'symlinks need a privilege on Windows' }, async () => {
  // "~/all" -> "/" was refused as "… Choose "/" itself.", and choosing "/" is POLICY_PATH_TOO_BROAD. A
  // loop (a -> b -> a) named "b", itself a link, refused the same way again.
  const dir = fs.realpathSync(await mkTmp());
  try {
    const real = path.join(dir, 'real');
    fs.mkdirSync(real);
    const links: Record<string, string> = {
      'to-real': real,
      'to-nothing': path.join(dir, 'not-made'),
      'to-root': '/',
      'loop-a': path.join(dir, 'loop-b'),
      'loop-b': path.join(dir, 'loop-a'),
    };
    for (const [name, target] of Object.entries(links)) fs.symlinkSync(target, path.join(dir, name), 'dir');
    const match = { kind: 'custom', minBytes: 1 };
    const verdicts: Record<string, unknown> = {};
    for (const name of ['to-real', 'to-nothing', 'to-root', 'loop-a']) {
      const said = await savePolicies([{ name: 'Via link', path: path.join(dir, name), match }])
        .then(() => 'saved', (err: unknown) => (err instanceof AppError ? `${err.code}: ${err.message}` : String(err)));
      const advised = /Choose "([^"]+)" itself\.$/.exec(said)?.[1] ?? null;
      // Following the advice saves: it is the folder the person can choose.
      const followed = advised === null ? null : await savePolicies([{ name: 'Chosen', path: advised, match }])
        .then(() => 'saved', (err: unknown) => (err instanceof AppError ? err.code : String(err)));
      verdicts[name] = {
        code: said.split(':')[0],
        advised: advised === null ? null : path.relative(dir, advised) || advised,
        followed,
        wholeDrive: /a whole drive/.test(said),
      };
    }
    assert.deepEqual(verdicts, {
      'to-real': { code: 'POLICY_PATH_IS_LINK', advised: 'real', followed: 'saved', wholeDrive: false },
      'to-nothing': { code: 'POLICY_PATH_IS_LINK', advised: 'not-made', followed: 'saved', wholeDrive: false },
      'to-root': { code: 'POLICY_PATH_IS_LINK', advised: null, followed: null, wholeDrive: true },
      'loop-a': { code: 'POLICY_PATH_IS_LINK', advised: null, followed: null, wholeDrive: false },
    });
    // Each still says where the link leads.
    const sentence = (name: string) => savePolicies([{ name: 'Via link', path: path.join(dir, name), match }])
      .then(() => 'saved', (err: unknown) => String((err as Error).message));
    assert.match(await sentence('to-root'), /is a link to "\/"\. .*a whole drive.*choose a folder on it instead\.$/);
    assert.match(await sentence('loop-a'), new RegExp(`is a link to "${path.join(dir, 'loop-b').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\. .*Choose the folder itself\\.$`));
  } finally {
    await savePolicies([]);
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('approving clears the cooldown the dry run started', async () => {
  const dir = await mkTmp();
  try {
    await writeFile(path.join(dir, 'project', 'node_modules', 'dep', 'a.bin'), 4096);
    const [policy] = await savePolicies([{
      id: 'approve-me', name: 'p', path: dir,
      match: { kind: 'suggestion', groupIds: ['regen-node-modules'] }, enabled: true,
    }]);
    const preview = await runPolicy(policy);
    assert.equal(preview.status, 'awaiting-approval');
    assert.ok((await listPolicies())[0].lastRunAt, 'the dry run stamped the clock');

    const approved = await approvePolicy(policy.id, preview.id);
    assert.ok(approved.approvedAt);
    assert.equal(approved.lastRunAt, undefined, 'approving must not leave the user waiting out a full cooldown');
  } finally {
    await savePolicies([]);
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

/* ══════════════════ The rails that stop a real run ══════════════════ */

test('an unexpectedly large match stops the run instead of being trimmed and executed', async () => {
  // §B1 acceptance: caught by requireConfirmationAbove "rather than executing
  // silently". Note it is NOT clipped by the cap and run anyway — the size
  // itself is the signal that the policy is wrong.
  const dir = await mkTmp();
  try {
    await writeFile(path.join(dir, 'proj', 'node_modules', 'x', 'big.bin'), 200_000);
    const [policy] = await savePolicies([{
      id: 'huge-match', name: 'p', path: dir,
      match: { kind: 'suggestion', groupIds: ['regen-node-modules'] },
      dryRunFirst: false, enabled: true, requireConfirmationAbove: 1000, maxBytesPerRun: 100,
    }]);
    await approvePolicyForTests(policy.id);

    const result = await runPolicy((await listPolicies())[0]);
    assert.equal(result.status, 'awaiting-approval');
    assert.equal(result.bytesDeleted, 0);
    assert.match(result.blockedReason ?? '', /more than the 1\.0 KB you asked/, 'the 1,000-byte limit, in decimal units (QA D09)');
    assert.ok(fs.existsSync(path.join(dir, 'proj', 'node_modules')), 'nothing was deleted');
  } finally {
    await savePolicies([]);
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('a policy inside its cooldown refuses without restarting the clock', async () => {
  const startedAt = Date.now() - 2 * 86_400_000;
  const policy = basePolicy({ id: 'cooling', cooldownDays: 7, lastRunAt: startedAt });
  await savePolicies([{ ...policy }]);
  // savePolicies drops client-sent lastRunAt, so put it back the way a real
  // previous run would have.
  const raw = await readJsonFile<{ policies: AutopilotPolicy[]; runs: AutopilotRun[] }>('autopilot.json', { policies: [], runs: [] });
  raw.policies[0].lastRunAt = startedAt;
  raw.policies[0].approvedAt = startedAt;
  await writeJsonFile('autopilot.json', raw);

  const result = await runPolicy((await listPolicies())[0]);
  assert.equal(result.status, 'blocked');
  assert.match(result.blockedReason ?? '', /cooldown/);

  // The clock must not move: otherwise a frequent tick pushes the next real
  // run further away every time it checks.
  assert.equal((await listPolicies())[0].lastRunAt, startedAt);
  await savePolicies([]);
});

test('a spent weekly allowance blocks the run and says when it resumes', async () => {
  const dir = await mkTmp();
  try {
    await writeFile(path.join(dir, 'proj', 'node_modules', 'x', 'a.bin'), 4096);
    const [policy] = await savePolicies([{
      id: 'weekly', name: 'p', path: dir,
      match: { kind: 'suggestion', groupIds: ['regen-node-modules'] },
      dryRunFirst: false, enabled: true, maxBytesPerWeek: 1000,
    }]);
    await approvePolicyForTests(policy.id);

    // A previous live run already used the whole weekly allowance.
    const raw = await readJsonFile<{ policies: AutopilotPolicy[]; runs: AutopilotRun[] }>('autopilot.json', { policies: [], runs: [] });
    raw.runs.unshift(run({ policyId: policy.id, bytesDeleted: 1000, at: Date.now() - 3600_000 }));
    await writeJsonFile('autopilot.json', raw);

    const result = await runPolicy((await listPolicies())[0]);
    assert.equal(result.status, 'blocked');
    assert.match(result.blockedReason ?? '', /weekly allowance/);
    assert.ok(fs.existsSync(path.join(dir, 'proj', 'node_modules')));
  } finally {
    await savePolicies([]);
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('a policy set to preview keeps previewing after approval', async () => {
  const dir = await mkTmp();
  try {
    await writeFile(path.join(dir, 'proj', 'node_modules', 'x', 'a.bin'), 2048);
    const [policy] = await savePolicies([{
      id: 'preview', name: 'p', path: dir,
      match: { kind: 'suggestion', groupIds: ['regen-node-modules'] },
      dryRunFirst: true, enabled: true,
    }]);
    await approvePolicyForTests(policy.id);

    const result = await runPolicy((await listPolicies())[0]);
    assert.equal(result.mode, 'dry-run');
    assert.equal(result.bytesDeleted, 0);
    assert.match(result.blockedReason ?? '', /Simulated/);
    assert.ok(fs.existsSync(path.join(dir, 'proj', 'node_modules')));
  } finally {
    await savePolicies([]);
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

/* ══════════════════ The live path, stopped by B2 ══════════════════ */

async function holdOpenElsewhere(target: string): Promise<() => void> {
  const child = spawn(process.execPath, [
    '-e',
    `const fs=require('fs');const fd=fs.openSync(${JSON.stringify(target)},'r');` +
    `process.stdout.write('open');setInterval(()=>{},1000);`,
  ], { stdio: ['ignore', 'pipe', 'ignore'] });
  await withinHangGuard(new Promise<void>((resolve, reject) => {
    child.stdout.once('data', () => resolve());
    child.once('error', reject);
  }), 'the child signalling that it holds the file open');
  return () => child.kill('SIGKILL');
}

test('a live run routes through the open-file guard and deletes nothing when it refuses', { skip: !IS_UNIX }, async () => {
  // Drives the whole production path — scan, select, cap, protect, trash —
  // with B2 stopping the delete, so the Trash is never touched.
  const dir = await mkTmp();
  let release: (() => void) | null = null;
  const trashed: string[] = [];
  setTrashStepForTests(async (p) => {
    trashed.push(p);
  });
  try {
    const held = await writeFile(path.join(dir, 'proj', 'node_modules', 'dep', 'held.bin'), 8192);
    release = await holdOpenElsewhere(held);

    const [policy] = await savePolicies([{
      id: 'live-blocked', name: 'p', path: dir,
      match: { kind: 'suggestion', groupIds: ['regen-node-modules'] },
      dryRunFirst: false, enabled: true,
    }]);
    await approvePolicyForTests(policy.id);

    const result = await runPolicy((await listPolicies())[0]);
    assert.equal(result.mode, 'live', 'it really did try');
    assert.equal(result.bytesDeleted, 0);
    assert.equal(result.status, 'blocked');
    assert.ok(result.skipped.length > 0, 'and it says what it left and why');
    assert.ok(fs.existsSync(held), 'the open file is exactly where it was');
    assert.deepEqual(trashed, [], 'the Trash step was never reached');
  } finally {
    setTrashStepForTests(null);
    release?.();
    await savePolicies([]);
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

/* ══════════════════ Undo ══════════════════ */

test('a run is undone by putting every item back from the Time Capsule', async () => {
  // §B1 acceptance: "every run is fully undoable for at least 30 days".
  // Built from a real capture so the undo restores real bytes.
  const dir = await mkTmp();
  try {
    const a = await writeFile(path.join(dir, 'one.bin'), 4096);
    const b = await writeFile(path.join(dir, 'two.bin'), 2048);
    const runId = crypto.randomUUID();
    const { outcomes } = await protectItems([{ path: a }, { path: b }], { runId, policyId: 'undo-me' });
    assert.ok(outcomes.every((o) => o.protected), 'both were protected');

    // What a completed live run leaves behind: originals gone, capsule holding
    // copies stamped with the run id.
    await fsp.rm(a);
    await fsp.rm(b);

    const raw = await readJsonFile<{ policies: AutopilotPolicy[]; runs: AutopilotRun[] }>('autopilot.json', { policies: [], runs: [] });
    raw.runs.unshift(run({ id: runId, policyId: 'undo-me', capsuleRunId: runId, bytesDeleted: 6144, mode: 'live' }));
    await writeJsonFile('autopilot.json', raw);

    const undo = await undoRun(runId);
    assert.equal(undo.entryCount, 2);

    // The restore is a job; wait it out.
    const { getCapsuleJob } = await import('../src/services/timeCapsule');
    await waitFor(() => { const job = getCapsuleJob(undo.jobId); return job !== undefined && job.status !== 'running'; }, 'the undo job settling', 25);
    const job = getCapsuleJob(undo.jobId);
    assert.equal(job?.status, 'complete', job?.error ?? '');

    assert.ok(fs.existsSync(a), 'the first file is back');
    assert.ok(fs.existsSync(b), 'and so is the second');
    assert.equal((await listRuns()).find((r) => r.id === runId)?.undoneAt !== undefined, true);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

/** A live run of one file, as a completed run leaves it: the original gone, its copy in the capsule under the run's id. */
async function plantedRun(dir: string, name: string, size: number): Promise<{ runId: string; policyId: string; file: string; bytes: Buffer }> {
  const file = await writeFile(path.join(dir, name), size);
  const bytes = await fsp.readFile(file);
  const runId = crypto.randomUUID();
  const policyId = `undo-${runId}`;
  const { outcomes } = await protectItems([{ path: file }], { runId, policyId });
  assert.ok(outcomes.every((o) => o.protected), 'it was protected');
  await fsp.rm(file);
  const raw = await readJsonFile<{ policies: AutopilotPolicy[]; runs: AutopilotRun[] }>('autopilot.json', { policies: [], runs: [] });
  raw.runs.unshift(run({ id: runId, policyId, capsuleRunId: runId, bytesDeleted: size, mode: 'live' }));
  await writeJsonFile('autopilot.json', raw);
  return { runId, policyId, file, bytes };
}

/** An undo's restore job, once it has settled. */
async function settledUndo(jobId: string): Promise<{ status: string; error?: string }> {
  await waitFor(() => { const job = getCapsuleJob(jobId); return job !== undefined && job.status !== 'running'; }, 'the undo job settling', 25);
  const job = getCapsuleJob(jobId);
  assert.ok(job, 'the job record exists');
  return job;
}

/** The run as autopilot.json holds it on disk this moment — what the page reads when it reloads the runs. */
function runOnDisk(runId: string): AutopilotRun | undefined {
  const raw = JSON.parse(fs.readFileSync(path.join(process.env.TREEMAP_DATA_DIR ?? '', 'autopilot.json'), 'utf8')) as { runs: AutopilotRun[] };
  return raw.runs.find((r) => r.id === runId);
}

/** What a file read stream hands over at a time: a fault past it lands part-way through a file. */
const CHUNK = 64 * 1024;
const WEEK_AGO = (): number => Date.now() - 7 * 86_400_000;

test('an undo whose restore fails leaves the run undoable and counted against its week, and the one that puts it back marks it undone (FG3d #8)', async () => {
  const dir = await mkTmp();
  try {
    const { runId, policyId, file, bytes } = await plantedRun(dir, 'a.bin', 3 * CHUNK);
    // The restore writes beside the file's name until its copy verifies (FG3f #8).
    const removeFault = setCopyFaultForTests((dest, read) => (isRestoreCopyFor(dest, file) && read > CHUNK ? new Error('the disk stopped answering (a test)') : null));
    let failed: { status: string; error?: string };
    try {
      failed = await settledUndo((await undoRun(runId)).jobId);
    } finally {
      removeFault();
    }
    assert.equal(failed.status, 'error', `the case under test: the restore failed (${failed.error})`);
    assert.ok(!fs.existsSync(file), 'and nothing came back');
    assert.equal((await listRuns()).find((r) => r.id === runId)?.undoneAt, undefined, 'a run whose undo failed is not marked undone');
    assert.equal(bytesDeletedSince(await listRuns(), policyId, WEEK_AGO()), 3 * CHUNK, 'and what it deleted still counts against its week');

    const retried = await settledUndo((await undoRun(runId)).jobId); // not refused as already undone
    assert.equal(retried.status, 'complete', retried.error ?? '');
    assert.deepEqual(await fsp.readFile(file), bytes, 'the second undo puts it back');
    assert.notEqual((await listRuns()).find((r) => r.id === runId)?.undoneAt, undefined, 'and marks the run undone');
    assert.equal(bytesDeletedSince(await listRuns(), policyId, WEEK_AGO()), 0, 'which no longer counts against its week');
    await assert.rejects(() => undoRun(runId), (err: unknown) => err instanceof AppError && err.code === 'ALREADY_UNDONE');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('an undo is marked undone before its job says complete, and a cancel that comes once everything is back does not report it cancelled (FG3d #8)', async () => {
  const dir = await mkTmp();
  try {
    const { runId, file, bytes } = await plantedRun(dir, 'b.bin', 4096);
    const { jobId } = await undoRun(runId);
    const job = getCapsuleJob(jobId);
    assert.ok(job, 'the job record exists');
    // The cancel button pressed as the last byte lands: a cancel that reads true once every file is home.
    Object.defineProperty(job, 'cancelled', { get: () => job.filesDone >= job.fileCount, set: () => {}, configurable: true });
    // What the page reads the moment the job says complete: the run as autopilot.json holds it then.
    let status = job.status;
    let undoneWhenComplete: boolean | null = null;
    Object.defineProperty(job, 'status', {
      get: () => status,
      set: (next: typeof status) => {
        if (next === 'complete') undoneWhenComplete = runOnDisk(runId)?.undoneAt !== undefined;
        status = next;
      },
      configurable: true,
    });
    const done = await settledUndo(jobId);
    assert.equal(done.status, 'complete', 'everything is back, so the undo is complete, not cancelled');
    assert.equal(undoneWhenComplete, true, 'the run was marked undone before the job said complete');
    assert.deepEqual(await fsp.readFile(file), bytes);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('undoing twice is refused rather than half-working', async () => {
  const raw = await readJsonFile<{ policies: AutopilotPolicy[]; runs: AutopilotRun[] }>('autopilot.json', { policies: [], runs: [] });
  const id = crypto.randomUUID();
  raw.runs.unshift(run({ id, bytesDeleted: 10, mode: 'live', undoneAt: Date.now() }));
  await writeJsonFile('autopilot.json', raw);
  await assert.rejects(() => undoRun(id), (err: unknown) => err instanceof AppError && err.code === 'ALREADY_UNDONE');
});

test('a dry run has nothing to undo, and says so', async () => {
  const raw = await readJsonFile<{ policies: AutopilotPolicy[]; runs: AutopilotRun[] }>('autopilot.json', { policies: [], runs: [] });
  const id = crypto.randomUUID();
  raw.runs.unshift(run({ id, mode: 'dry-run', bytesDeleted: 0 }));
  await writeJsonFile('autopilot.json', raw);
  await assert.rejects(() => undoRun(id), (err: unknown) => err instanceof AppError && err.code === 'NOTHING_TO_UNDO');
});

test('a run whose copies the capsule no longer holds cannot be silently half-undone', async () => {
  const raw = await readJsonFile<{ policies: AutopilotPolicy[]; runs: AutopilotRun[] }>('autopilot.json', { policies: [], runs: [] });
  const id = crypto.randomUUID();
  raw.runs.unshift(run({ id, mode: 'live', bytesDeleted: 100, capsuleRunId: 'no-such-capsule-run' }));
  await writeJsonFile('autopilot.json', raw);
  await assert.rejects(
    () => undoRun(id),
    (err: unknown) => err instanceof AppError && err.code === 'CAPSULE_EMPTY',
  );
});
