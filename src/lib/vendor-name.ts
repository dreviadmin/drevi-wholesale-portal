// Finding a vendor by the name someone typed, the way the database decides
// two names clash: vendors_name_key is unique on lower(name), so "Ravi
// Textiles" and "ravi textiles " are the same vendor. Pure, for vitest; the
// lookup itself is in vendors.ts.

/**
 * `name` as a LIKE pattern that matches only itself (case-insensitively under
 * ilike): backslash, % and _ are escaped. PostgREST also reads * as %, and
 * that cannot be escaped, so callers still confirm with findVendorByName.
 */
export function escapeIlike(name: string): string {
  return name.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** The row whose name equals `name` ignoring case and outer spaces, if any. */
export function findVendorByName<T extends { name: string }>(rows: T[], name: string): T | undefined {
  const want = name.trim().toLowerCase();
  if (!want) return undefined;
  return rows.find((r) => r.name.trim().toLowerCase() === want);
}
