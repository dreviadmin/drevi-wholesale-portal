// Parsing of the portal-storage "sb:" image refs. No imports on purpose, so the
// rule can be unit-tested and run against the real stored refs outside Next.
//
//   "sb:<path>"           → the design-images bucket (the original form)
//   "sb:<bucket>:<path>"  → one of the auxiliary buckets below
//
// Path rule (7 Nov 2026). A ref can arrive as the `id` query parameter of
// /api/drive-photo, and fetchImageByRef downloads it with the service-role
// client. storage-js joins the object path into the request URL without
// encoding it, and URL normalisation resolves dot segments, so an accepted
// path must never be able to resolve outside /storage/v1/object/<bucket>/.
//
// Hence an allow-list on every path segment, not a ".." check: "%2e%2e",
// ".%2E" and "..\" all normalise to ".." as well, and a double-encoded form
// survives the route's searchParams decoding. Plain file-name characters only:
// no "%", "?", "#", "\", ":" or spaces, no empty segments, and never "." or "..".
// Every ref the portal writes is built from ids, timestamps and fixed words
// (storeDesignImage, storeAuxPhoto, archiveImageFile). Before this shipped, a
// read-only scan of every text, array and JSON column found 4 stored refs in
// prod and 26 in dev (7 Nov 2026), and all of them pass.

export const SB_PREFIX = "sb:";
export const DEFAULT_BUCKET = "design-images";
export const STORAGE_REF_BUCKETS = ["design-images", "vendor-photos", "order-attachments", "note-photos"] as const;

const SEGMENT = /^[A-Za-z0-9._-]+$/;

/** True when every "/"-separated segment is a plain file-name token. */
export function isSafeObjectPath(path: string): boolean {
  return path.split("/").every((seg) => SEGMENT.test(seg) && seg !== "." && seg !== "..");
}

/**
 * Bucket and object path for an "sb:" ref, or null when the ref is not a
 * storage ref or its path could resolve anywhere outside its bucket.
 */
export function parseStorageRef(ref: string): { bucket: string; path: string } | null {
  if (!ref.startsWith(SB_PREFIX)) return null;
  const rest = ref.slice(SB_PREFIX.length);
  const head = rest.split(":", 1)[0];
  const named = (STORAGE_REF_BUCKETS as readonly string[]).includes(head);
  const bucket = named ? head : DEFAULT_BUCKET;
  const path = named ? rest.slice(head.length + 1) : rest;
  return isSafeObjectPath(path) ? { bucket, path } : null;
}
