// Every object path in a Supabase Storage bucket, however deep it sits.
//
// Audit round 2: the storage backup listed the bucket root and ONE folder
// below it, on the belief that objects live at most one folder deep. Note
// photos do not — they are stored at <entityType>/<entityId>/<file> — so every
// one of them was silently missing from the daily storage backup. This walks
// folders recursively instead (Storage reports a folder as an entry with no
// id), and a folder that cannot be listed becomes a warning rather than a
// silent gap.
//
// Pure (the lister is passed in) so storage-walk.test.ts can drive it with a
// fake bucket; src/lib/backup.ts supplies the real admin-client lister.

export interface StorageListEntry {
  name: string;
  /** null for a folder. */
  id: string | null;
}

export type StorageLister = (
  prefix: string,
) => Promise<{ data: StorageListEntry[] | null; error: { message: string } | null }>;

/** Deep enough for every layout in use (the deepest is two folders); a guard, not a limit anyone should meet. */
export const MAX_STORAGE_DEPTH = 6;

export async function listAllObjectPaths(
  list: StorageLister,
  bucket: string,
  maxDepth = MAX_STORAGE_DEPTH,
): Promise<{ paths: string[]; warnings: string[] }> {
  const paths: string[] = [];
  const warnings: string[] = [];

  async function walk(prefix: string, depth: number): Promise<void> {
    const { data, error } = await list(prefix);
    if (error) {
      // Same wording the root failure always had, so existing backups read alike.
      warnings.push(prefix ? `${bucket}/${prefix}/: list failed — ${error.message}` : `${bucket}: list failed — ${error.message}`);
      return;
    }
    for (const entry of data ?? []) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.id) { paths.push(path); continue; } // a file
      if (depth >= maxDepth) { warnings.push(`${bucket}/${path}/: more than ${maxDepth} folders deep — skipped`); continue; }
      await walk(path, depth + 1);
    }
  }

  await walk("", 0);
  return { paths, warnings };
}
