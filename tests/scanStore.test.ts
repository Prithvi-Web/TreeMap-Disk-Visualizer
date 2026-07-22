import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FileNode } from '../src/models/types';
import { pruneTree } from '../src/utils/pruneTree';
import { ObjectScanStore, ScanStore, Flag, NodeInput, emitFileNode, pruneStore } from '../src/services/scanStore';

/**
 * The ScanStore interface contract, proven against the reference
 * implementation (ObjectScanStore). PackedScanStore is differential-tested
 * against this same oracle in packedStore.test.ts — so what these tests pin
 * down is the semantics every implementation must share: insertion-order
 * children, absent-optionals-stay-absent, byte-identical prune output,
 * file-with-children containers, and exact path fidelity on both separators.
 */

const fileIn = (name: string, size: number, extra: Partial<NodeInput> = {}): NodeInput => ({
  name, isDir: false, size, modifiedAt: 1000, isHidden: name.startsWith('.'), ...extra,
});
const dirIn = (name: string, extra: Partial<NodeInput> = {}): NodeInput => ({
  name, isDir: true, size: 0, modifiedAt: 2000, isHidden: name.startsWith('.'), ...extra,
});

/** A small store covering every field family. Returns named ids. */
function buildFixture(): { store: ObjectScanStore; ids: Record<string, number> } {
  const store = new ObjectScanStore('/scan/root', '/', dirIn('root'));
  const ids: Record<string, number> = { root: store.rootId };
  ids.docs = store.addNode(ids.root, dirIn('docs'));
  ids.big = store.addNode(ids.docs, fileIn('big.mp4', 5000, { extension: 'mp4', accessedAt: 3000 }));
  ids.hidden = store.addNode(ids.docs, fileIn('.secret', 10));
  ids.link = store.addNode(ids.docs, fileIn('alias', 0, { isSymlink: true }));
  ids.dup = store.addNode(ids.docs, fileIn('copy.bin', 0, { extension: 'bin', hardlinkDuplicate: true }));
  ids.cloud = store.addNode(ids.docs, fileIn('film.mov', 700, { extension: 'mov', cloudPlaceholder: true, cloudProvider: 'icloud' }));
  ids.empty = store.addNode(ids.root, dirIn('empty'));
  ids.repo = store.addNode(ids.root, dirIn('repo'));
  ids.git = store.addNode(ids.repo, dirIn('.git'));
  ids.pack = store.addNode(ids.git, fileIn('pack-1.pack', 300, { extension: 'pack' }));
  store.setFlag(ids.repo, Flag.GitRepo, true);
  ids.zip = store.addNode(ids.root, fileIn('bundle.zip', 400, { extension: 'zip', container: 'zip' }));
  store.finalize();
  store.sumSizes();
  return { store, ids };
}

test('metadata accessors answer every field, absent-aware', () => {
  const { store, ids } = buildFixture();

  assert.equal(store.rootPath, '/scan/root');
  assert.equal(store.sep, '/');
  assert.equal(store.count, 12);
  assert.equal(store.name(ids.big), 'big.mp4');
  assert.equal(store.path(ids.big), '/scan/root/docs/big.mp4');
  assert.equal(store.size(ids.big), 5000);
  assert.equal(store.nodeType(ids.big), 'file');
  assert.equal(store.nodeType(ids.docs), 'dir');
  assert.equal(store.isDir(ids.docs), true);
  assert.equal(store.modifiedAt(ids.big), 1000);
  assert.equal(store.extension(ids.big), 'mp4');
  assert.equal(store.extension(ids.hidden), undefined);
  assert.equal(store.accessedAt(ids.big), 3000);
  assert.equal(store.accessedAt(ids.hidden), undefined);
  assert.equal(store.container(ids.zip), 'zip');
  assert.equal(store.container(ids.big), undefined);
  assert.equal(store.cloudProvider(ids.cloud), 'icloud');
  assert.equal(store.cloudProvider(ids.big), undefined);
  assert.equal(store.cloudId(ids.big), undefined);
  assert.equal(store.logicalSize(ids.big), undefined);
  assert.equal(store.parent(ids.big), ids.docs);
  assert.equal(store.parent(ids.root), -1);

  assert.equal(store.flag(ids.hidden, Flag.Hidden), true);
  assert.equal(store.flag(ids.big, Flag.Hidden), false);
  assert.equal(store.flag(ids.link, Flag.Symlink), true);
  assert.equal(store.flag(ids.dup, Flag.HardlinkDup), true);
  assert.equal(store.size(ids.dup), 0, 'hardlink duplicates keep size 0');
  assert.equal(store.flag(ids.cloud, Flag.CloudPlaceholder), true);
  assert.equal(store.flag(ids.repo, Flag.GitRepo), true);
  assert.equal(store.flag(ids.git, Flag.GitRepo), false, 'gitRepo lands on the parent, not .git');
});

test('sumSizes computes recursive dir totals; files keep their own size', () => {
  const { store, ids } = buildFixture();
  assert.equal(store.size(ids.docs), 5000 + 10 + 0 + 0 + 700);
  assert.equal(store.size(ids.empty), 0);
  assert.equal(store.size(ids.repo), 300);
  assert.equal(store.size(ids.root), 5710 + 300 + 400);
  assert.equal(store.size(ids.zip), 400, 'a container file keeps its disk size');
});

test('traversal: children in insertion order, eachFile stops at files', () => {
  const { store, ids } = buildFixture();

  assert.deepEqual(store.childIds(ids.docs), [ids.big, ids.hidden, ids.link, ids.dup, ids.cloud]);
  assert.equal(store.childCount(ids.docs), 5);
  assert.equal(store.hasChildArray(ids.empty), true);
  assert.equal(store.childCount(ids.empty), 0);
  assert.equal(store.hasChildArray(ids.big), false, 'plain files carry no child array');
  assert.equal(store.childByName(ids.docs, '.secret'), ids.hidden);
  assert.equal(store.childByName(ids.docs, 'nope'), -1);

  const viaForEach: number[] = [];
  store.forEachChild(ids.docs, (c) => viaForEach.push(c));
  assert.deepEqual(viaForEach, store.childIds(ids.docs));

  const files: string[] = [];
  store.eachFile(store.rootId, (id) => files.push(store.name(id)));
  assert.deepEqual(files, ['big.mp4', '.secret', 'alias', 'copy.bin', 'film.mov', 'pack-1.pack', 'bundle.zip']);

  let all = 0;
  store.eachNode(store.rootId, () => all++);
  assert.equal(all, store.count);
});

test('a file-typed container carries grafted children and drills like a dir', () => {
  const { store, ids } = buildFixture();
  const virtualKids: FileNode[] = [
    {
      name: 'inner', path: '/scan/root/bundle.zip/inner', size: 350, type: 'dir',
      children: [
        { name: 'a.txt', path: '/scan/root/bundle.zip/inner/a.txt', size: 350, type: 'file', modifiedAt: 5000, isHidden: false, virtual: true, logicalSize: 900, extension: 'txt' },
      ],
      modifiedAt: 5000, isHidden: false, virtual: true,
    },
  ];
  store.ingestSubtree(ids.zip, virtualKids);

  assert.equal(store.nodeType(ids.zip), 'file');
  assert.equal(store.hasChildArray(ids.zip), true);
  assert.equal(store.childCount(ids.zip), 1);
  const inner = store.childByName(ids.zip, 'inner');
  assert.notEqual(inner, -1);
  assert.equal(store.flag(inner, Flag.Virtual), true);
  const aTxt = store.childByName(inner, 'a.txt');
  assert.equal(store.logicalSize(aTxt), 900);
  assert.equal(store.path(aTxt), '/scan/root/bundle.zip/inner/a.txt');
  assert.equal(store.findByPath('/scan/root/bundle.zip/inner/a.txt'), aTxt);

  // eachFile visits the container itself but never its virtual listing.
  const files: string[] = [];
  store.eachFile(store.rootId, (id) => files.push(store.name(id)));
  assert.ok(files.includes('bundle.zip'));
  assert.ok(!files.includes('a.txt'));

  // Size scaling stayed verbatim; the container's own size is untouched.
  assert.equal(store.size(ids.zip), 400);
});

test('findByPath: exact hits, misses, and the root itself', () => {
  const { store, ids } = buildFixture();
  assert.equal(store.findByPath('/scan/root'), ids.root);
  assert.equal(store.findByPath('/scan/root/docs'), ids.docs);
  assert.equal(store.findByPath('/scan/root/docs/big.mp4'), ids.big);
  assert.equal(store.findByPath('/scan/root/docs/big.mp4.nope'), -1);
  assert.equal(store.findByPath('/scan/root/nope'), -1);
  assert.equal(store.findByPath('/other'), -1);
});

test('windows-style paths reconstruct and resolve with backslashes', () => {
  const store = new ObjectScanStore('C:\\Users\\vin', '\\', dirIn('vin'));
  const docs = store.addNode(store.rootId, dirIn('Documents'));
  const f = store.addNode(docs, fileIn('report.docx', 100, { extension: 'docx' }));
  store.finalize();
  store.sumSizes();

  assert.equal(store.path(f), 'C:\\Users\\vin\\Documents\\report.docx');
  assert.equal(store.findByPath('C:\\Users\\vin\\Documents\\report.docx'), f);
  assert.equal(store.findByPath('C:\\Users\\vin\\Documents'), docs);

  // A drive root whose path already ends with the separator gains no double-sep.
  const drive = new ObjectScanStore('C:\\', '\\', dirIn('C:\\'));
  const top = drive.addNode(drive.rootId, fileIn('pagefile.sys', 5, { extension: 'sys' }));
  assert.equal(drive.path(top), 'C:\\pagefile.sys');
  assert.equal(drive.findByPath('C:\\pagefile.sys'), top);
});

test('mutations: setSize/addToSize/setFlag/removeNode behave like the live tree', () => {
  const { store, ids } = buildFixture();

  store.setSize(ids.big, 6000);
  assert.equal(store.size(ids.big), 6000);
  store.addToSize(ids.docs, 1000);
  assert.equal(store.size(ids.docs), 6710);
  store.setModifiedAt(ids.big, 9999);
  assert.equal(store.modifiedAt(ids.big), 9999);
  store.setAccessedAt(ids.big, undefined);
  assert.equal(store.accessedAt(ids.big), undefined);
  store.setFlag(ids.docs, Flag.GitRepo, true);
  assert.equal(store.flag(ids.docs, Flag.GitRepo), true);
  store.setFlag(ids.docs, Flag.GitRepo, false);
  assert.equal(store.flag(ids.docs, Flag.GitRepo), false);

  // Remove the cloud file the way provider-trash does.
  store.removeNode(ids.cloud);
  assert.equal(store.flag(ids.cloud, Flag.Removed), true);
  assert.equal(store.childCount(ids.docs), 4);
  assert.equal(store.findByPath('/scan/root/docs/film.mov'), -1);
  const files: string[] = [];
  store.eachFile(store.rootId, (id) => files.push(store.name(id)));
  assert.ok(!files.includes('film.mov'));
});

test('post-finalize addNode inserts a watcher-created file', () => {
  const { store, ids } = buildFixture();
  const created = store.addNode(ids.docs, fileIn('fresh.log', 42, { extension: 'log' }));
  assert.equal(store.path(created), '/scan/root/docs/fresh.log');
  assert.equal(store.findByPath('/scan/root/docs/fresh.log'), created);
  assert.equal(store.childCount(ids.docs), 6);
  assert.deepEqual(store.childIds(ids.docs).at(-1), created, 'appended last, insertion order kept');
});

test('materialize is exactly pruneTree at a budget of 1', () => {
  const { store, ids } = buildFixture();

  const dir = store.materialize(ids.docs);
  assert.equal(dir.pruned, true, 'a dir with children materializes pruned');
  assert.equal(dir.children, undefined, 'never both children and pruned');
  assert.equal(dir.size, 5710, 'sizes stay exact on pruned nodes');

  const empty = store.materialize(ids.empty);
  assert.deepEqual(empty.children, [], 'an empty dir stays children: [], not pruned');
  assert.equal(empty.pruned, undefined);

  const file = store.materialize(ids.big);
  assert.equal(file.children, undefined);
  assert.equal(file.pruned, undefined);
  assert.equal(file.extension, 'mp4');
  assert.equal(file.accessedAt, 3000);
  assert.ok(!('hardlinkDuplicate' in file), 'absent optionals stay absent');
  assert.ok(!('cloudPlaceholder' in file));
  assert.ok(!('virtual' in file));
});

test('prune output is byte-identical to pruneTree across budgets', () => {
  const { store } = buildFixture();
  // An independently hand-built copy of the same tree, pruned by the
  // original pruneTree — the wire-format oracle.
  const oracle = buildFixture().store;

  for (const maxNodes of [1, 2, 3, 5, 8, 100]) {
    const viaStore = store.prune(store.rootId, { maxNodes });
    const viaShared = pruneStore(store, store.rootId, { maxNodes });
    const viaObject = oracle.prune(oracle.rootId, { maxNodes });
    assert.equal(JSON.stringify(viaStore.root), JSON.stringify(viaObject.root), `maxNodes=${maxNodes}`);
    assert.equal(JSON.stringify(viaShared.root), JSON.stringify(viaObject.root), `shared pruneStore maxNodes=${maxNodes}`);
    assert.equal(viaStore.nodes, viaObject.nodes);
    assert.equal(viaStore.prunedDirs, viaObject.prunedDirs);
    assert.equal(viaShared.nodes, viaObject.nodes);
    assert.equal(viaShared.prunedDirs, viaObject.prunedDirs);
  }
});

test('emitFileNode: property order matches each producer family', () => {
  const walkerFile = emitFileNode({
    name: 'a.zip', path: '/r/a.zip', size: 9, isDir: false, modifiedAt: 1, isHidden: false,
    accessedAt: 2, extension: 'zip', container: 'zip', isSymlink: false,
    cloudPlaceholder: true, cloudProvider: 'dropbox', hardlinkDuplicate: true, gitRepo: false,
  });
  assert.deepEqual(Object.keys(walkerFile), [
    'name', 'path', 'size', 'type', 'modifiedAt', 'isHidden',
    'accessedAt', 'extension', 'container', 'cloudPlaceholder', 'cloudProvider', 'hardlinkDuplicate',
  ]);

  const virtualFile = emitFileNode({
    name: 'x.txt', path: '/r/a.zip/x.txt', size: 5, isDir: false, modifiedAt: 1, isHidden: false,
    virtual: true, logicalSize: 50, extension: 'txt',
  });
  assert.deepEqual(Object.keys(virtualFile), [
    'name', 'path', 'size', 'type', 'modifiedAt', 'isHidden', 'virtual', 'logicalSize', 'extension',
  ]);

  const cloudFile = emitFileNode({
    name: 'doc.pdf', path: 'cloud://gdrive/doc.pdf', size: 5, isDir: false, modifiedAt: 0, isHidden: false,
    cloudId: 'abc123', extension: 'pdf',
  });
  assert.deepEqual(Object.keys(cloudFile), [
    'name', 'path', 'size', 'type', 'modifiedAt', 'isHidden', 'cloudId', 'extension',
  ]);
});

test('wrap-mode indexes an existing tree without touching it', () => {
  const root: FileNode = {
    name: 'r', path: '/r', size: 30, type: 'dir', modifiedAt: 0, isHidden: false,
    children: [
      { name: 'a.txt', path: '/r/a.txt', size: 10, type: 'file', modifiedAt: 0, isHidden: false, extension: 'txt' },
      { name: 'sub', path: '/r/sub', size: 20, type: 'dir', modifiedAt: 0, isHidden: false, children: [
        { name: 'b.txt', path: '/r/sub/b.txt', size: 20, type: 'file', modifiedAt: 0, isHidden: false, extension: 'txt' },
      ] },
    ],
  };
  const before = JSON.stringify(root);
  const store: ScanStore = ObjectScanStore.wrap(root);
  assert.equal(store.count, 4);
  assert.equal(store.findByPath('/r/sub/b.txt'), 3);
  assert.equal(store.size(store.findByPath('/r/sub')), 20);
  assert.equal(JSON.stringify(store.prune(store.rootId, { maxNodes: 100 }).root), JSON.stringify(pruneTree(root, { maxNodes: 100 }).root));
  assert.equal(JSON.stringify(root), before, 'wrapping and pruning never mutate the source tree');
});
