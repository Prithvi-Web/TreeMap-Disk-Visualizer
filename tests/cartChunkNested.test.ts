import { test } from 'node:test';
import assert from 'node:assert/strict';

import { INDEX } from './fixtures/liftFrontend';

/**
 * The cart commits in chunks of 500 paths, and it allows a folder and an item inside it to be staged
 * both (the final review, F1.12). The chunks were cut from the whole staged list, so the folder could
 * land in one chunk and the item in a later one: the dry run counted the item's bytes twice and
 * planned its capsule copy twice, and the real run trashed the folder in the first chunk and then
 * reported the item — gone to the Trash with its folder — as "left in place, still on your disk,
 * not deleted, and still in your cart". Now only the cart's outermost items are sent, and what was
 * staged inside a folder that went leaves the cart with it.
 *
 * The page's own cartTrashAll, cartDryRun and cartExecuteCommit, evaluated with a chunk of one path
 * and the server stood in for.
 */

/** A named function declaration from the shipped page, by brace matching. */
function pageFunction(name: string): string {
  const at = INDEX.search(new RegExp(`(async )?function ${name}\\(`));
  assert.notEqual(at, -1, `${name} is in the page`);
  const open = INDEX.indexOf('{', INDEX.indexOf(')', at));
  let depth = 0;
  for (let i = open; i < INDEX.length; i++) {
    if (INDEX[i] === '{') depth++;
    else if (INDEX[i] === '}' && --depth === 0) return INDEX.slice(at, i + 1);
  }
  assert.fail(`${name} does not close`);
}

interface Page {
  trashAll: () => Promise<void>;
  confirm: () => (() => Promise<void>) | null;
  cart: Set<string>;
  requests: { dryRun: boolean; paths: string[] }[];
  summaries: { trashed: string[]; skipped: { path: string }[] }[];
}

/** The cart's commit as the page runs it, one path per chunk; the server trashes whatever it is sent but `keptBack`. */
function cartPage(staged: string[], keptBack: string[] = []): Page {
  const cart = new Set(staged);
  const requests: Page['requests'] = [];
  const summaries: Page['summaries'] = [];
  const gone: string[] = [];
  // A button takes focus as a page's does: the commit gives it back once it works again (review F1.15 of HZ).
  const el = (): Record<string, unknown> => ({ disabled: false, hidden: false, innerHTML: '', classList: { add: () => undefined, contains: () => true }, focus: () => undefined });
  const noop = (): undefined => undefined;
  const make = new Function(
    'state', 'api', '$', 'icon', 'REDUCED', 'formatCount', 'formatBytes', 'toast', 'ensureNodes', 'nodeFor', 'resetOpenHandleWarning',
    'cartManifestHtml', 'saveCart', 'renderCart', 'refreshCartButtons', 'cartCommitSummary', 'rescan', 'CART_PAGE', 'document', 'cartFocusReturn',
    `let confirmPaths = []; let onConfirmTrash = null; let cartCommitKey = ''; let cartLastRun = null; let cartShown = 0;
     const CART_COMMIT_CHUNK = 1;
     ${pageFunction('cartKnownPaths')}
     ${pageFunction('cartTrashAll')}
     ${pageFunction('cartDryRun')}
     ${pageFunction('cartExecuteCommit')}
     ${pageFunction('cartDropTrashed')}
     ${pageFunction('cartRefocus')}
     ${pageFunction('cartFocusOffHiddenDock')}
     ${pageFunction('outermostPaths')}
     ${pageFunction('tmParentPath')}
     ${pageFunction('tmIsInside')}
     return { trashAll: cartTrashAll, confirm: () => onConfirmTrash };`,
  );
  const page = make(
    { cart },
    async (_url: string, opts: { body: string }) => {
      const body = JSON.parse(opts.body) as { paths: string[]; dryRun: boolean };
      requests.push({ dryRun: body.dryRun, paths: body.paths });
      if (body.dryRun) return { items: body.paths.map((p) => ({ path: p, willDelete: true, bytes: 1 })), bytesWouldFree: body.paths.length };
      // As the server does: an item whose folder an earlier request trashed is no longer there to copy.
      const underGone = (p: string): boolean => gone.some((g) => p.startsWith(`${g}/`));
      const trashed = body.paths.filter((p) => !keptBack.includes(p) && !underGone(p));
      const skipped = body.paths.filter((p) => !trashed.includes(p)).map((p) => (underGone(p)
        ? { path: p, code: 'CAPSULE_UNREADABLE', reason: 'It could not be read (ENOENT, a test).' }
        : { path: p, code: 'CAPSULE_CHANGED', reason: 'kept back (a test)' }));
      gone.push(...trashed);
      return { runId: 'run-1', trashed, bytesFreed: trashed.length, skipped, failedToTrash: [], unverified: [] };
    },
    el, () => '', true, (n: number) => String(n), (n: number) => String(n), noop, async () => undefined, (p: string) => ({ path: p, size: 1 }), noop,
    () => '', noop, noop, noop, (result: Page['summaries'][number]) => { summaries.push(result); }, noop, 200,
    { activeElement: null, body: {} }, noop,
  ) as { trashAll: () => Promise<void>; confirm: () => (() => Promise<void>) | null };
  return { ...page, cart, requests, summaries };
}

test('a folder and an item staged inside it are sent once, by the folder, to the dry run and the commit, however the chunks fall', async () => {
  const page = cartPage(['/r/F', '/r/G.bin', '/r/F/child.bin', '/r/F/deeper/x.bin']);
  await page.trashAll();
  const confirm = page.confirm();
  assert.ok(confirm, 'the confirm offers the commit');
  await confirm();
  const sent = (dryRun: boolean): string[] => page.requests.filter((r) => r.dryRun === dryRun).flatMap((r) => r.paths);
  assert.deepEqual(sent(true), ['/r/F', '/r/G.bin'], 'the dry run plans the folder, never the folder and what it holds');
  assert.deepEqual(sent(false), ['/r/F', '/r/G.bin'], 'and the commit deletes the same');
  assert.deepEqual(page.summaries.flatMap((s) => s.skipped), [], 'nothing that went with its folder is reported left in place');
});

test('what was staged inside a folder that went to the Trash leaves the cart with it; a look-alike sibling the server kept back stays', async () => {
  const page = cartPage(['/r/F', '/r/F/child.bin', '/r/FX/other.bin'], ['/r/FX/other.bin']);
  await page.trashAll();
  const confirm = page.confirm();
  assert.ok(confirm, 'the confirm offers the commit');
  await confirm();
  assert.deepEqual([...page.cart], ['/r/FX/other.bin'], 'F and what was staged in it left the cart; FX, kept back and not inside F, stays');
});
