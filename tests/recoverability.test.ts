import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.TREEMAP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-recov-test-'));
process.env.TREEMAP_NO_GDU = '1';

import {
  membershipFromTmutil, parseDestinationInfo, parseFileHistoryConfig, parseIsExcluded,
  parseLatestBackup, linuxBackupReason, backupToolsFromPaths,
} from '../src/platform/backupParsers';
import { parseAheadBehind, parsePorcelainStatus, readRepoState, repoRootFor, ignoredPaths } from '../src/services/gitRecoverability';
import {
  backupVerdict, cloudVerdict, composeRecoverability, gitVerdict, humanAge,
} from '../src/services/recoverability';
import { syncRootFor } from '../src/services/placeholderResolver';
import type {
  BackupRecoverability, CloudRecoverability, ElsewhereVerdict, GitRecoverability,
} from '../src/services/recoverabilityTypes';

/**
 * Recoverability (v4 §1.2) — "does a copy of this exist elsewhere?"
 *
 * Two rules dominate this file, and both are about the same failure: telling
 * someone their data is safe when it is not.
 *
 *  1. **`pathCovered` is never promoted to 'yes' by inference.** §1.2b calls
 *     this the highest-stakes honesty rule in v4, because a false "this is
 *     backed up" directly causes data loss. It gets a dedicated test.
 *  2. **`proven` requires a checkable fact.** A configured backup earns at
 *     most `likely`, forever, however recent it is.
 *
 * The composite mapping is covered exhaustively — every combination of the
 * three sub-signals — because that table is what the UI's summary word comes
 * from, and a gap in it is a wrong word under a delete button.
 */

/* ============================ git: five real repo states ============================ */

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

/** The five states §1.2a names, built as real repositories on disk. */
function buildRepos(): { dir: string; repos: Record<string, string>; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-git-states-'));

  // Each repo gets its OWN bare origin. Sharing one would reject every push
  // after the first as a non-fast-forward, since the repos have unrelated
  // initial commits — which fails the fixture, not the code.
  const make = (name: string): string => {
    const origin = path.join(dir, `${name}-origin.git`);
    execFileSync('git', ['init', '-q', '--bare', origin], { stdio: 'ignore' });
    const repo = path.join(dir, name);
    fs.mkdirSync(repo);
    git(repo, ['init', '-q']);
    git(repo, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
    git(repo, ['config', 'user.email', 't@example.invalid']);
    git(repo, ['config', 'user.name', 'Test']);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-qm', 'init']);
    git(repo, ['remote', 'add', 'origin', origin]);
    git(repo, ['push', '-q', '-u', 'origin', 'main']);
    return repo;
  };

  const repos: Record<string, string> = {
    pushed: make('pushed'),
    ahead: make('ahead'),
    dirty: make('dirty'),
    untracked: make('untracked'),
    noremote: make('noremote'),
    ignored: make('ignored'),
  };

  fs.writeFileSync(path.join(repos.ahead, 'b.txt'), 'b');
  git(repos.ahead, ['add', '-A']);
  git(repos.ahead, ['commit', '-qm', 'second']);

  fs.appendFileSync(path.join(repos.dirty, 'a.txt'), 'changed');
  fs.writeFileSync(path.join(repos.untracked, 'new.bin'), 'new');
  git(repos.noremote, ['remote', 'remove', 'origin']);

  // A repo that reports CLEAN while holding content the remote has never seen.
  fs.mkdirSync(path.join(repos.ignored, 'node_modules'));
  fs.writeFileSync(path.join(repos.ignored, 'node_modules', 'big.js'), 'x'.repeat(1000));
  fs.writeFileSync(path.join(repos.ignored, '.gitignore'), 'node_modules/\n');
  git(repos.ignored, ['add', '-A']);
  git(repos.ignored, ['commit', '-qm', 'ignore']);
  git(repos.ignored, ['push', '-q', 'origin', 'main']);

  return { dir, repos, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('the five repository states each yield the right verdict', async () => {
  const fixture = buildRepos();
  try {
    const state = async (repo: string) => {
      const result = await readRepoState(repo);
      assert.ok(!('error' in result), `git failed for ${repo}`);
      return result as GitRecoverability;
    };

    const pushed = await state(fixture.repos.pushed);
    assert.equal(pushed.fullyPushed, true);
    assert.equal(pushed.hasRemote, true);
    assert.equal(pushed.ahead, 0);
    assert.equal(gitVerdict(pushed).verdict, 'proven');
    assert.match(gitVerdict(pushed).reason!.text, /git clone/);

    const ahead = await state(fixture.repos.ahead);
    assert.equal(ahead.ahead, 1);
    assert.equal(ahead.fullyPushed, false);
    assert.equal(gitVerdict(ahead).verdict, 'none');
    assert.match(gitVerdict(ahead).reason!.text, /1 commit not pushed/);

    const dirty = await state(fixture.repos.dirty);
    assert.equal(dirty.dirtyFiles, 1);
    assert.equal(dirty.fullyPushed, false);
    assert.match(gitVerdict(dirty).reason!.text, /1 uncommitted change/);

    const untracked = await state(fixture.repos.untracked);
    assert.equal(untracked.untrackedFiles, 1);
    assert.equal(untracked.fullyPushed, false);
    assert.match(gitVerdict(untracked).reason!.text, /1 untracked file/);

    const noremote = await state(fixture.repos.noremote);
    assert.equal(noremote.hasRemote, false);
    assert.equal(noremote.fullyPushed, false);
    assert.match(gitVerdict(noremote).reason!.text, /no remote/);
  } finally {
    fixture.cleanup();
  }
});

test('an ignored path inside a fully-pushed repo is NOT claimed as recoverable', async () => {
  // The hole in the specified design, verified end to end. `git status
  // --porcelain` omits ignored files, so this repo reports completely clean
  // and fullyPushed comes back true — while node_modules is not in the remote
  // at all. Without pathTracked, the UI would tell the user that deleting it
  // "costs one git clone".
  const fixture = buildRepos();
  try {
    const repo = fixture.repos.ignored;
    const state = await readRepoState(repo);
    assert.ok(!('error' in state));
    assert.equal((state as GitRecoverability).fullyPushed, true, 'the repo really does report clean');

    const target = path.join(repo, 'node_modules', 'big.js');
    const ignored = await ignoredPaths(repo, [target, path.join(repo, 'a.txt')]);
    assert.equal(ignored.has(target), true, 'check-ignore sees it');
    assert.equal(ignored.has(path.join(repo, 'a.txt')), false);

    const verdict = gitVerdict({ ...(state as GitRecoverability), pathTracked: false });
    assert.notEqual(verdict.verdict, 'proven', 'an ignored file is never proven by git');
    assert.equal(verdict.verdict, 'none');
    assert.match(verdict.reason!.text, /Git ignores it/);
  } finally {
    fixture.cleanup();
  }
});

test('a path outside any work tree has no repo root', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-norepo-'));
  try {
    fs.writeFileSync(path.join(dir, 'x.txt'), 'x');
    assert.equal(await repoRootFor(path.join(dir, 'x.txt')), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('porcelain parsing survives filenames with newlines and renames', () => {
  // NUL-separated because a filename may contain a newline; splitting on
  // newlines would invent entries that do not exist.
  const record = ' M a.txt\0?? new.bin\0 M we\nird.txt\0';
  const parsed = parsePorcelainStatus(record);
  assert.equal(parsed.dirtyFiles, 2);
  assert.deepEqual(parsed.untracked, ['new.bin']);

  // A rename carries its origin path as a second field; counting it as another
  // change would double-report one edit.
  const rename = 'R  new.txt\0old.txt\0 M other.txt\0';
  assert.equal(parsePorcelainStatus(rename).dirtyFiles, 2);
  assert.deepEqual(parsePorcelainStatus('').untracked, []);
});

test('ahead/behind parses, and a missing upstream is null not zero', () => {
  assert.deepEqual(parseAheadBehind('0\t0\n'), { behind: 0, ahead: 0 });
  assert.deepEqual(parseAheadBehind('2\t5\n'), { behind: 2, ahead: 5 });
  // "no upstream configured" must not read as "nothing to push".
  assert.equal(parseAheadBehind('fatal: no upstream configured for branch'), null);
  assert.equal(parseAheadBehind(''), null);
});

/* ============================ backups: never 'yes' ============================ */

test('pathCovered is NEVER promoted to "yes" by any code path', () => {
  // §1.2b: the highest-stakes honesty rule in v4. A false "this is backed up"
  // directly causes data loss, so this is asserted directly rather than left
  // implied by the other cases.
  const cases: (boolean | undefined)[] = [undefined, true, false];
  for (const configured of [true, false]) {
    for (const excluded of cases) {
      for (const lastBackup of [null, Date.now(), Date.now() - 86_400_000]) {
        const result = membershipFromTmutil(configured, lastBackup, excluded);
        assert.notEqual(
          result.pathCovered, 'yes',
          `configured=${configured} excluded=${String(excluded)} lastBackup=${String(lastBackup)} produced "yes"`,
        );
      }
    }
  }
  // And specifically the tempting case: configured, backed up an hour ago, not
  // excluded. Still unknown — the file may post-date the backup or have failed
  // to copy.
  const tempting = membershipFromTmutil(true, Date.now() - 3_600_000, false);
  assert.equal(tempting.pathCovered, 'unknown');
});

test('only an excluded path yields a definite "no"', () => {
  assert.equal(membershipFromTmutil(true, Date.now(), true).pathCovered, 'no');
  assert.equal(membershipFromTmutil(true, Date.now(), false).pathCovered, 'unknown');
  assert.equal(membershipFromTmutil(false, null, undefined).pathCovered, 'unknown');
  assert.equal(membershipFromTmutil(false, null, undefined).configured, false);
});

test('tmutil destinationinfo: configured vs not', () => {
  // Observed on this Mac, verbatim — and it exits 0, so the text is what counts.
  assert.deepEqual(parseDestinationInfo('tmutil: No destinations configured.'), { configured: false, name: null });
  const configured = parseDestinationInfo(
    '====================================================\nName          : Time Machine\nKind          : Local\nMount Point   : /Volumes/Backup\nID            : 1E2D\n',
  );
  assert.equal(configured.configured, true);
  assert.equal(configured.name, 'Time Machine');
  assert.deepEqual(parseDestinationInfo(''), { configured: false, name: null });
});

test('tmutil latestbackup: a date, or null — never a fabricated one', () => {
  const ms = parseLatestBackup('/Volumes/Backup/Backups.backupdb/Mac/2026-08-20-134501');
  assert.ok(ms);
  const when = new Date(ms!);
  assert.equal(when.getFullYear(), 2026);
  assert.equal(when.getMonth(), 7); // August
  assert.equal(when.getDate(), 20);

  // Observed on this Mac: it prints a mount failure AND EXITS 0. A configured
  // but unreachable backup reports a null date, not today's.
  assert.equal(parseLatestBackup('Failed to mount backup destination, error: Error Domain=com.apple.backupd.ErrorDomain Code=17'), null);
  assert.equal(parseLatestBackup(''), null);
  assert.equal(parseLatestBackup('/Volumes/Backup/no-timestamp-here'), null);
});

test('tmutil isexcluded is matched by echoed path, not by position', () => {
  // Unlike mdls, tmutil echoes each path back — so a dropped line cannot
  // silently shift every later answer onto the wrong file.
  const parsed = parseIsExcluded(
    '[Included]  /Users/me/Desktop\n[Excluded]  /Users/me/Downloads/big folder\n[Included]  /private/tmp\n',
  );
  assert.equal(parsed.get('/Users/me/Desktop'), false);
  assert.equal(parsed.get('/Users/me/Downloads/big folder'), true, 'a path with a space survives');
  assert.equal(parsed.size, 3);
  // A path missing from the output is absent from the map, so the caller reads
  // it as unknown rather than as included.
  assert.equal(parsed.has('/Users/me/never-asked'), false);
  assert.equal(parseIsExcluded('garbage').size, 0);
});

test('Linux backup detection states that a repo is not proof of coverage', () => {
  assert.deepEqual(backupToolsFromPaths({ restic: true, borg: false, borgmatic: false, timeshift: false }), ['restic']);
  assert.deepEqual(backupToolsFromPaths({ restic: false, borg: true, borgmatic: true, timeshift: false }), ['borg', 'borgmatic']);
  const reason = linuxBackupReason(['restic']);
  // §1.2b asks for exactly this sentence to reach the user.
  assert.match(reason, /not proof that this particular file is inside it/);
  assert.match(linuxBackupReason([]), /No backup tool/);
});

test('File History config parses shallowly, and never claims coverage', () => {
  const xml = '<?xml version="1.0"?><DataProtectionConfig><Target state="1"/><FolderList><Folder><Path>C:\\Users\\me\\Documents</Path></Folder><Folder><Path>C:\\Users\\me\\Pictures</Path></Folder></FolderList></DataProtectionConfig>';
  const parsed = parseFileHistoryConfig(xml);
  assert.equal(parsed.enabled, true);
  assert.deepEqual(parsed.includedFolders, ['C:\\Users\\me\\Documents', 'C:\\Users\\me\\Pictures']);
  assert.equal(parseFileHistoryConfig('<DataProtectionConfig/>').enabled, false);
  assert.deepEqual(parseFileHistoryConfig('not xml at all').includedFolders, []);
});

/* ============================ the composite table ============================ */

const gitPushed: GitRecoverability = {
  kind: 'git', repoRoot: '/r', hasRemote: true, ahead: 0, dirtyFiles: 0,
  untrackedFiles: 0, untrackedBytes: 0, fullyPushed: true, pathTracked: true,
};
const gitDirty: GitRecoverability = { ...gitPushed, dirtyFiles: 3, fullyPushed: false };
const gitIgnored: GitRecoverability = { ...gitPushed, pathTracked: false };

const backupConfigured: BackupRecoverability = {
  kind: 'backup', configured: true, lastBackupMs: Date.now() - 3_600_000,
  pathCovered: 'unknown', mechanism: 'Time Machine',
};
const backupExcluded: BackupRecoverability = { ...backupConfigured, pathCovered: 'no' };
const backupAbsent: BackupRecoverability = {
  kind: 'backup', configured: false, lastBackupMs: null, pathCovered: 'unknown',
  mechanism: 'Time Machine', reason: 'Time Machine has no backup disk set up on this Mac.',
};

const cloudSynced: CloudRecoverability = { kind: 'cloud', syncRoot: '/s', provider: 'dropbox', state: 'synced-local' };
const cloudPlaceholder: CloudRecoverability = { ...cloudSynced, state: 'placeholder' };
const cloudLocalOnly: CloudRecoverability = { ...cloudSynced, state: 'local-only' };
const cloudUnknown: CloudRecoverability = { ...cloudSynced, state: 'unknown' };

test('a configured backup can never reach "proven" on its own', () => {
  // The ceiling, asserted directly. However recent the backup and however
  // clearly the path is not excluded, membership alone is `likely`.
  assert.equal(backupVerdict(backupConfigured).verdict, 'likely');
  assert.equal(composeRecoverability(null, backupConfigured, null).elsewhere, 'likely');
  assert.equal(composeRecoverability(null, backupConfigured, cloudUnknown).elsewhere, 'likely');
  // And the reason says why it stops short, in words the user can act on.
  assert.match(backupVerdict(backupConfigured).reason!.text, /has not opened the backup to check/);
});

test('only a checkable fact reaches "proven"', () => {
  assert.equal(composeRecoverability(gitPushed, null, null).elsewhere, 'proven');
  assert.equal(composeRecoverability(null, null, cloudSynced).elsewhere, 'proven');
  assert.equal(composeRecoverability(null, null, cloudPlaceholder).elsewhere, 'proven');
  // Nothing else does.
  assert.equal(composeRecoverability(gitDirty, backupConfigured, cloudUnknown).elsewhere, 'likely');
  assert.equal(composeRecoverability(gitDirty, backupAbsent, cloudLocalOnly).elsewhere, 'none');
  assert.equal(composeRecoverability(null, null, null).elsewhere, 'unknown');
});

test('the composite mapping is exhaustive over all three sub-signals', () => {
  const gits: [string, GitRecoverability | null][] = [
    ['none', null], ['pushed', gitPushed], ['dirty', gitDirty], ['ignored', gitIgnored],
  ];
  const backups: [string, BackupRecoverability | null][] = [
    ['none', null], ['configured', backupConfigured], ['excluded', backupExcluded], ['absent', backupAbsent],
  ];
  const clouds: [string, CloudRecoverability | null][] = [
    ['none', null], ['synced', cloudSynced], ['placeholder', cloudPlaceholder],
    ['local-only', cloudLocalOnly], ['unknown-state', cloudUnknown],
  ];

  const rank: Record<ElsewhereVerdict, number> = { proven: 3, likely: 2, none: 1, unknown: 0 };
  let combos = 0;

  for (const [gName, g] of gits) {
    for (const [bName, b] of backups) {
      for (const [cName, c] of clouds) {
        combos++;
        const label = `git=${gName} backup=${bName} cloud=${cName}`;
        const result = composeRecoverability(g, b, c);

        // 1. The verdict is exactly the strongest individual claim. This is
        //    the whole mapping, asserted as a property rather than as 80
        //    hand-written expectations that could each be wrong.
        const expected = Math.max(
          rank[gitVerdict(g).verdict], rank[backupVerdict(b).verdict], rank[cloudVerdict(c).verdict],
        );
        assert.equal(rank[result.elsewhere], expected, label);

        // 2. "proven" is reachable ONLY from a fully-pushed tracked repo or a
        //    cloud copy. If this ever fires, some new signal has quietly been
        //    granted the authority to say "safe to delete".
        if (result.elsewhere === 'proven') {
          const provenGit = g?.fullyPushed === true && g.pathTracked;
          const provenCloud = c?.state === 'synced-local' || c?.state === 'placeholder';
          assert.ok(provenGit || provenCloud, `${label} reached "proven" without a checkable fact`);
        }

        // 3. Every non-unknown verdict can explain itself. A summary word with
        //    no reason behind it is exactly the oracle this project refuses.
        if (result.elsewhere !== 'unknown') {
          assert.ok(result.why.length > 0, `${label} gave a verdict with no reason`);
        }

        // 4. Every reason names its signal, so the UI can attribute it.
        for (const reason of result.why) {
          assert.ok(['git', 'backup', 'cloud'].includes(reason.signal), label);
          assert.ok(reason.text.length > 20, `${label} reason too terse to be useful`);
        }
      }
    }
  }
  assert.equal(combos, 4 * 4 * 5, 'every combination was exercised');
});

test('one sub-signal failing leaves the other two intact', () => {
  // §1.2: a broken git must not blank backup and cloud.
  const result = composeRecoverability(null, backupConfigured, cloudSynced, [
    { signal: 'git', reason: 'Git could not read the project at /r (fatal: not a git repository).' },
  ]);
  assert.equal(result.elsewhere, 'proven', 'the cloud still answered');
  assert.equal(result.backup, backupConfigured, 'the backup still answered');
  assert.equal(result.unavailable.length, 1);
  assert.equal(result.unavailable[0].signal, 'git');
  // And what could not be read is stated, not silently dropped.
  assert.match(result.unavailable[0].reason, /not a git repository/);
});

test('a "none" from one signal does not cancel a "proven" from another', () => {
  // An ignored build folder inside a synced Dropbox directory genuinely IS
  // retrievable — the cloud knows so even though git does not.
  const result = composeRecoverability(gitIgnored, null, cloudSynced);
  assert.equal(result.elsewhere, 'proven');
  assert.equal(result.why.length, 2, 'and both signals are shown, so the summary is never the whole story');
});

/* ============================ cloud residency ============================ */

test('a sync root is named, and a lookalike folder is not claimed', () => {
  assert.equal(syncRootFor('/Users/me/Dropbox/work/report.pdf'), '/Users/me/Dropbox');
  assert.equal(syncRootFor('/Users/me/OneDrive - Acme/x/y.txt'), '/Users/me/OneDrive - Acme');
  assert.equal(syncRootFor('/Users/me/Library/Mobile Documents/com~apple~CloudDocs/a.txt'), '/Users/me/Library/Mobile Documents/com~apple~CloudDocs');
  // Anchored to a separator: a file merely NAMED after a provider is not in one.
  assert.equal(syncRootFor('/Users/me/Desktop/my-Dropbox-notes.txt'), null);
  assert.equal(syncRootFor('/Users/me/Documents/report.pdf'), null);
});

test('local-only is a "none", because a synced folder is not a backup', () => {
  // A file sitting in a Dropbox folder looks backed up to a person. While the
  // client has not finished uploading, it is not.
  const verdict = cloudVerdict(cloudLocalOnly);
  assert.equal(verdict.verdict, 'none');
  assert.match(verdict.reason!.text, /has not uploaded this yet/);
  assert.match(verdict.reason!.text, /Deleting it loses it/);
  assert.equal(cloudVerdict(cloudUnknown).verdict, 'unknown');
  assert.equal(cloudVerdict(null).verdict, 'unknown');
});

/* ============================ presentation ============================ */

test('ages read as a person would say them', () => {
  assert.equal(humanAge(0), 'today');
  assert.equal(humanAge(86_400_000), 'yesterday');
  assert.equal(humanAge(5 * 86_400_000), '5 days ago');
  assert.equal(humanAge(45 * 86_400_000), 'a month ago');
  assert.equal(humanAge(400 * 86_400_000), '13 months ago');
  assert.equal(humanAge(1000 * 86_400_000), '2 years ago');
});
