import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-vault-cap-docs-');

import { capFor } from '../src/services/timeCapsule';

/**
 * Hunt S5 (judged real for the docs): the Undo Vault's cap is the setting's share of the free space
 * on its disk plus what the Vault already holds, not of the whole disk — on a 1 TB disk with 80 GB
 * free, 10% is about 8 GB, not 100 GB. SECURITY.md said "Capped at 10% of the disk", which reads as
 * the cap itself; README said only "default 10%". Both now name the base.
 */

test('the cap is a share of free space plus what the Vault holds (control)', () => {
  assert.equal(capFor(80e9, 0, 10), 8e9, '1 TB disk, 80 GB free, nothing held: 8 GB, not 100 GB');
});

test('SECURITY.md and README say what the Undo Vault\'s percentage is of', () => {
  const security = fs.readFileSync(path.join(__dirname, '..', 'SECURITY.md'), 'utf8');
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
  assert.doesNotMatch(security, /Capped at 10% of the disk/);
  assert.match(security, /10% of the free space on its disk, counting what it already holds/);
  assert.match(readme, /a size cap \(by default 10% of the free space on its disk, counting what it already holds\)/);
});
