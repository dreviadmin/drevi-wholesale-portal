// The Content-Disposition value for a downloaded photo (20 Sep).
//
// Pure and on its own because this is the security-bearing half of the
// download: the name is built from base_sku / colour / angle, which are
// operator-typed database columns, and it is written into a RESPONSE HEADER.
// A newline or a quote in one of those columns is the whole attack, so
// everything outside a conservative ASCII set is replaced and the length is
// bounded. The worst a rogue column can do here is produce an ugly filename.

const EXT: Record<string, string> = { "image/png": "png", "image/webp": "webp" };

/** Filename stem, sanitised. Exported for the test; the route wants the header. */
export function safeStem(stem: string): string {
  const cleaned = stem
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "")
    .slice(0, 100)
    .replace(/[-._]+$/, "");
  return cleaned || "drevi-photo";
}

/** `attachment; filename="DD-LEH-FLR-115-GRN-front-production.jpg"` */
export function attachmentHeader(stem: string, contentType: string): string {
  const ext = EXT[contentType.split(";")[0].trim().toLowerCase()] ?? "jpg";
  return `attachment; filename="${safeStem(stem)}.${ext}"`;
}
