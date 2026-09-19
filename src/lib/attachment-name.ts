// The Content-Disposition value for a downloaded photo (20 Sep).
//
// Pure and on its own because this is the security-bearing half of the
// download: the name is built from base_sku / colour / angle, which are
// operator-typed database columns, and it is written into a RESPONSE HEADER.
// A newline or a quote in one of those columns is the whole attack, so
// everything outside a conservative ASCII set is replaced and the length is
// bounded. The worst a rogue column can do here is produce an ugly filename.

// The extension has to describe the BYTES, not the hope. Ayushi's camera
// originals reach Drive as image/heif, and a HEIC file handed out as .jpg
// opens on her Mac and fails everywhere the extension is trusted — Windows,
// and Shopify's own uploader. Anything unrecognised still falls back to jpg,
// which is what the generated candidates are.
const EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heif": "heic",
  "image/heic": "heic",
  "image/heif-sequence": "heic",
  "image/heic-sequence": "heic",
  "image/avif": "avif",
  "image/gif": "gif",
  "image/tiff": "tiff",
};

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
