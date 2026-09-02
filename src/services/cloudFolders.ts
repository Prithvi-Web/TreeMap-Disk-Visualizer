/**
 * The one gate for "is this file a cloud placeholder?" that every engine
 * shares.
 *
 * A placeholder reports a logical size but occupies ~no disk blocks — and so
 * does any sparse file: a VM disk, Docker.raw, a Core Data store. The two are
 * told apart by WHERE the file lives, not by its blocks: only a file under a
 * known cloud-sync folder is a placeholder. The walker and the gdu mapper both
 * apply this gate; the live index must apply the same one, or the same folder
 * paints a cloud badge on its second open that its first open did not.
 */
export type CloudProvider = 'icloud' | 'onedrive' | 'dropbox';

/** Infer a cloud provider for a placeholder file from its path. */
export function cloudProviderFor(p: string): CloudProvider | undefined {
  if (/Library\/Mobile Documents|com~apple~CloudDocs|\.icloud$/i.test(p)) return 'icloud';
  if (/OneDrive/i.test(p)) return 'onedrive';
  if (/Dropbox/i.test(p)) return 'dropbox';
  return undefined;
}
