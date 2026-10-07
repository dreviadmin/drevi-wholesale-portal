// Pure half of catalog-images.ts (vitest-importable: relative imports only).

export type LineLike = { sku?: string | null; custom?: boolean | null; image_url?: string | null };

/** The photo a line should show: the current catalog photo, else its own snapshot. Custom lines keep theirs. */
export function lineImage(it: LineLike, current: Map<string, string>): string | null {
  if (it.custom || !it.sku) return it.image_url ?? null;
  return current.get(it.sku.trim().toUpperCase()) ?? it.image_url ?? null;
}
