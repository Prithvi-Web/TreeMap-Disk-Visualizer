import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { fileTempDir, isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-policyPlace-data-');

import { assertPathsAllowed } from '../src/services/policy';
import { sanitizePath } from '../src/utils/pathSanitizer';
import type { AgentPolicy } from '../src/models/types';

/**
 * agent-policy.json's lists are judged by where a path IS, as the scanned-root rule judges it (the final
 * review, F1.4). `protectedPaths` compared the text of the path a request named with the text of each
 * protected path, while the scanned-root rule and the sanitizer place a path where it lives: so the
 * protected file reached through a link inside the scanned folder, by its name in another case on a
 * volume that folds case, or by the macOS Data volume's spelling passed every guard — and the Trash
 * step, which follows the parents and folds the case, moved the protected file itself. `allowedRoots`
 * likewise let a path through a link in an allowed root out of it.
 *
 * Driven as the routes drive it: each path through the sanitizer first, then the policy. Nothing is
 * deleted: the question is only whether the policy refuses.
 */

const NO_LINKS = process.platform === 'win32' ? 'a link needs a privilege on Windows' : false;

/** A scanned-looking folder R holding Precious/keep.txt, a sibling PreciousX/keep.txt, and a link R/shortcut -> R/Precious. */
function fixture(label: string): { root: string; precious: string; keep: string; shortcut: string; sibling: string } {
  const root = fs.realpathSync(fileTempDir(`treemap-policyPlace-${label}-`));
  const precious = path.join(root, 'Precious');
  fs.mkdirSync(precious);
  const keep = path.join(precious, 'keep.txt');
  fs.writeFileSync(keep, 'irreplaceable');
  fs.mkdirSync(path.join(root, 'PreciousX'));
  const sibling = path.join(root, 'PreciousX', 'keep.txt');
  fs.writeFileSync(sibling, 'a different folder');
  const shortcut = path.join(root, 'shortcut');
  if (!NO_LINKS) fs.symlinkSync(precious, shortcut);
  return { root, precious, keep, shortcut, sibling };
}

const policyOf = (over: Partial<AgentPolicy>): AgentPolicy => ({ allowedRoots: [], protectedPaths: [], maxBytesPerOperation: null, ...over });

/** The code the policy refuses `p` with (after the sanitizer, as on every route), or null when it allows it. */
function refusal(policy: AgentPolicy, p: string): string | null {
  try {
    assertPathsAllowed(policy, [sanitizePath(p)]);
    return null;
  } catch (err) {
    return (err as { code?: string }).code ?? String(err);
  }
}

test('a protected folder reached through a link inside the scanned folder is refused, as its real path is', { skip: NO_LINKS }, () => {
  const f = fixture('link');
  const policy = policyOf({ protectedPaths: [f.precious] });
  assert.equal(refusal(policy, f.keep), 'POLICY_PROTECTED_PATH', 'the real path, as before');
  assert.equal(refusal(policy, path.join(f.shortcut, 'keep.txt')), 'POLICY_PROTECTED_PATH', 'the same file through the link');
  // The link itself is not the folder: trashing a link moves the link, never what it leads to.
  assert.equal(refusal(policy, f.shortcut), null, 'the link alone touches nothing protected');
  assert.equal(refusal(policy, f.sibling), null, 'a folder whose name only begins the same is another folder');
});

test('a protected path written through a link is held where it leads, too', { skip: NO_LINKS }, () => {
  const f = fixture('entry-link');
  const policy = policyOf({ protectedPaths: [f.shortcut] });
  assert.equal(refusal(policy, f.keep), 'POLICY_PROTECTED_PATH', 'the folder the protected spelling leads to is protected');
});

const FOLDS_CASE = ((): boolean => {
  const probe = fileTempDir('treemap-policyPlace-case-');
  fs.writeFileSync(path.join(probe, 'a'), '');
  return fs.existsSync(path.join(probe, 'A'));
})();

test('a protected folder named in another case on a volume that folds case is refused', { skip: FOLDS_CASE ? false : 'this volume keeps case, so PRECIOUS is another folder' }, () => {
  const f = fixture('case');
  const policy = policyOf({ protectedPaths: [f.precious] });
  assert.equal(refusal(policy, path.join(f.root, 'PRECIOUS', 'keep.txt')), 'POLICY_PROTECTED_PATH', 'a file in it');
  assert.equal(refusal(policy, path.join(f.root, 'PRECIOUS')), 'POLICY_PROTECTED_PATH', 'the folder itself');
});

test('a protected folder named by the macOS Data volume\'s spelling is refused, in both directions', { skip: process.platform === 'darwin' ? false : 'the Data volume is macOS\'s' }, () => {
  const f = fixture('data-volume');
  const policy = policyOf({ protectedPaths: [f.precious] });
  assert.equal(refusal(policy, `/System/Volumes/Data${f.keep}`), 'POLICY_PROTECTED_PATH', 'a file in it');
  assert.equal(refusal(policy, `/System/Volumes/Data${f.root}`), 'POLICY_PROTECTED_PATH', 'a folder holding it');
  const dataSpelled = policyOf({ protectedPaths: [`/System/Volumes/Data${f.precious}`] });
  assert.equal(refusal(dataSpelled, f.keep), 'POLICY_PROTECTED_PATH', 'and a protected path written in that spelling holds the usual one');
});

test('allowedRoots hold a path where it lives: a link in an allowed root leads out of it, and is refused', { skip: NO_LINKS }, () => {
  const allowed = fs.realpathSync(fileTempDir('treemap-policyPlace-allowed-'));
  const outside = fs.realpathSync(fileTempDir('treemap-policyPlace-outside-'));
  fs.writeFileSync(path.join(outside, 'taxes.pdf'), 'not in any allowed root');
  fs.writeFileSync(path.join(allowed, 'old.zip'), 'in the allowed root');
  fs.symlinkSync(outside, path.join(allowed, 'esc'));
  const policy = policyOf({ allowedRoots: [allowed] });
  assert.equal(refusal(policy, path.join(allowed, 'esc', 'taxes.pdf')), 'POLICY_ROOT_NOT_ALLOWED', 'through the link it lies outside');
  assert.equal(refusal(policy, path.join(allowed, 'old.zip')), null, 'a file in the root is allowed, as before');
  assert.equal(refusal(policy, path.join(allowed, 'esc')), null, 'and so is the link itself, which lies in the root');
  // An allowed root written through a link is the folder it leads to.
  const alias = path.join(fileTempDir('treemap-policyPlace-alias-'), 'to-allowed');
  fs.symlinkSync(allowed, alias);
  assert.equal(refusal(policyOf({ allowedRoots: [alias] }), path.join(allowed, 'old.zip')), null, 'a root spelled through a link still holds the folder it names');
});
