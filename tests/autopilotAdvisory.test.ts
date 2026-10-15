import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { fileTempDir, isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-autopilotAdvisory-data-');
process.env.TREEMAP_NO_GDU = '1';

import { approvePolicyForTests, listPolicies, runPolicy, savePolicies, selectCandidates, simulatePolicy } from '../src/services/autopilot';
import { loadRuleCatalog } from '../src/services/rulePacks';
import { setTrashStepForTests } from '../src/services/cleaner';
import { readJsonFile, writeJsonFile } from '../src/services/storage';
import { AppError } from '../src/middleware/errorHandler';
import type { AutopilotPolicy, AutopilotRun, CleanupSuggestionGroup } from '../src/models/types';
import { withOpenFileCheck } from './fixtures/openFileCheck';

/**
 * A group whose rule only advises (`advisory: true`: a VM disk, Xcode archives, a photo library's
 * derivatives — the file is the data, or the OS owns it) "must never be deleted" (AGENTS.md). Clean Up
 * offers no cart button for one, but an Autopilot suggestion policy took any group id it was given and
 * selected its items like any other's: saved through the API with ['docker-vm-image'], an approved
 * policy trashed the Docker disk image unattended (the final review, F1.11). Now such an id is refused
 * where a person saves it, and a run leaves an advisory group's items alone, saying so.
 *
 * Nothing reaches the machine's Trash: the trash step moves each original into this file's own folder.
 */

const FAKE_TRASH = fileTempDir('treemap-autopilotAdvisory-trash-');
const trashed: string[] = [];

before(() => {
  setTrashStepForTests(async (p) => {
    trashed.push(p);
    fs.renameSync(p, path.join(FAKE_TRASH, `${trashed.length}-${path.basename(p)}`));
  });
});

after(() => {
  setTrashStepForTests(null);
});

/** Every rule id this platform's packs mark advice-only. */
function advisoryIds(): string[] {
  const c = loadRuleCatalog();
  return [...c.projectDirectory, ...c.directory, ...c.file, ...c.location, ...c.staleFiles].filter((r) => r.action === 'advice').map((r) => r.id);
}

test('a suggestion policy naming an advice-only group is refused where it is saved, naming the group', async () => {
  const [advice] = advisoryIds();
  assert.ok(advice, 'this platform\'s packs have an advice-only rule');
  const dir = fileTempDir('treemap-autopilotAdvisory-save-');
  let refused: unknown = null;
  try {
    await savePolicies([{ id: 'adv', name: 'Docker', path: dir, match: { kind: 'suggestion', groupIds: ['regen-node-modules', advice] }, dryRunFirst: false, enabled: true }]);
  } catch (err) {
    refused = err;
  }
  assert.ok(refused instanceof AppError, String(refused));
  assert.equal(refused.code, 'POLICY_MATCH_ADVISORY', refused.message);
  assert.equal(refused.status, 400);
  assert.match(refused.message, /never deletes/, refused.message);
  assert.deepEqual(await listPolicies(), [], 'nothing was saved');
});

test('an advice-only group is never selected, whatever the policy asks for', () => {
  const group = (id: string, advisory: boolean): CleanupSuggestionGroup => ({
    id, title: id, description: 'a test group', category: 'cache', totalSize: 10, items: [{ path: `/x/${id}`, name: id, size: 10 }],
    ...(advisory ? { advisory: true, adviceCommand: 'use the app' } : {}),
  } as unknown as CleanupSuggestionGroup);
  const picked = selectCandidates([group('vm-disk', true), group('cache', false)], [], { kind: 'suggestion', groupIds: ['vm-disk', 'cache'] });
  assert.deepEqual(picked.map((c) => c.path), ['/x/cache']);
});

const LIGHTROOM = process.platform === 'darwin' || process.platform === 'win32' ? false : 'the Lightroom rules are for macOS and Windows';
/** The Lightroom previews rule's own advice (rulepacks/common.json), as a skipped row gives it. */
const INSTEAD = /Instead: Lightroom Classic ▸ Edit ▸ Catalog Settings ▸ File Handling ▸ Automatically Discard 1:1 Previews/;

test('a policy an earlier build saved with an advice-only group is not refused while unchanged, and its runs leave that group alone, saying so', { skip: LIGHTROOM }, async () => {
  const dir = fs.realpathSync(fileTempDir('treemap-autopilotAdvisory-run-'));
  const previews = path.join(dir, 'Lightroom Catalog Previews.lrdata');
  fs.mkdirSync(previews);
  fs.writeFileSync(path.join(previews, 'preview.jpg'), Buffer.alloc(4096, 3));
  // As an earlier build saved it: the refusal is at save time, so it is planted in the store.
  await savePolicies([{ id: 'planted', name: 'Previews', path: dir, match: { kind: 'suggestion', groupIds: ['regen-node-modules'] }, dryRunFirst: false, enabled: true }]);
  const store = await readJsonFile<{ policies: AutopilotPolicy[]; runs: AutopilotRun[] }>('autopilot.json', { policies: [], runs: [] });
  store.policies[0].match = { kind: 'suggestion', groupIds: ['media-lightroom-previews'] };
  await writeJsonFile('autopilot.json', store);
  try {
    const [unchanged] = await listPolicies();
    await savePolicies([{ ...unchanged, name: 'Renamed' }]); // an unrelated edit of the list it rides in
    await approvePolicyForTests('planted');
    const preview = await simulatePolicy((await listPolicies())[0]);
    assert.deepEqual(preview.items, [], 'nothing is offered for deletion');
    assert.ok(preview.skipped.some((s) => s.path === previews && /advice only/.test(s.reason)), JSON.stringify(preview.skipped));
    // With the group's own advice, so the refusal says what to do instead (final review F2.10).
    assert.ok(preview.skipped.some((s) => s.path === previews && INSTEAD.test(s.reason)), JSON.stringify(preview.skipped));
    const run = await withOpenFileCheck('clear', async () => runPolicy((await listPolicies())[0]));
    assert.equal(run.bytesDeleted, 0, run.blockedReason);
    assert.deepEqual(trashed, [], 'the Trash step was never reached');
    assert.ok(fs.existsSync(path.join(previews, 'preview.jpg')), 'it is where it was');
    assert.ok(run.skipped.some((s) => s.path === previews && /advice only/.test(s.reason)), JSON.stringify(run.skipped));
    assert.ok(run.skipped.some((s) => s.path === previews && INSTEAD.test(s.reason)), JSON.stringify(run.skipped));
    // Something matched and was left alone, so never "Nothing matched this time." (review round 2, F2.3).
    assert.equal(run.blockedReason, LEFT_ALONE, 'it says why nothing was deleted');
  } finally {
    await savePolicies([]);
  }
});

/** What a run says when everything it matched was left alone, some of it for a reason with no short name of its own. */
const LEFT_ALONE = 'Everything that matched was left alone, each for the reason listed with it — nothing was deleted.';

test('a run that left an advice-only group\'s items alone beside parts of an installed program never says everything it matched was part of an installed program (review round 2, F2.3)', { skip: LIGHTROOM }, async () => {
  const dir = fs.realpathSync(fileTempDir('treemap-autopilotAdvisory-mixed-'));
  const previews = path.join(dir, 'Lightroom Catalog Previews.lrdata');
  fs.mkdirSync(previews);
  fs.writeFileSync(path.join(previews, 'preview.jpg'), Buffer.alloc(4096, 3));
  const inApp = path.join(dir, 'Fake.app', 'Contents', 'Resources', 'app', 'node_modules', 'dep');
  fs.mkdirSync(inApp, { recursive: true });
  fs.writeFileSync(path.join(inApp, 'index.js'), Buffer.alloc(4096, 3));
  // As an earlier build saved it: an advice-only group is refused at save time, so it is planted in the store.
  await savePolicies([{ id: 'planted-mixed', name: 'Previews and build folders', path: dir, match: { kind: 'suggestion', groupIds: ['regen-node-modules'] }, dryRunFirst: false, enabled: true }]);
  const store = await readJsonFile<{ policies: AutopilotPolicy[]; runs: AutopilotRun[] }>('autopilot.json', { policies: [], runs: [] });
  store.policies[0].match = { kind: 'suggestion', groupIds: ['media-lightroom-previews', 'regen-node-modules'] };
  await writeJsonFile('autopilot.json', store);
  try {
    await approvePolicyForTests('planted-mixed');
    const run = await withOpenFileCheck('clear', async () => runPolicy((await listPolicies())[0]));
    assert.deepEqual(run.items, [], 'control: nothing is selected');
    assert.ok(run.skipped.some((s) => s.path === previews && /advice only/.test(s.reason)), `control: the advice-only group is left alone: ${JSON.stringify(run.skipped)}`);
    assert.ok(run.skipped.some((s) => /inside the app “Fake”/.test(s.reason)), `control: and the app's own node_modules: ${JSON.stringify(run.skipped)}`);
    assert.equal(run.blockedReason, LEFT_ALONE, 'neither reason alone covers what it left');
    assert.deepEqual(trashed, [], 'the Trash step was never reached');
  } finally {
    await savePolicies([]);
  }
});
