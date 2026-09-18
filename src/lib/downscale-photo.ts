"use client";

// Phone photos run 2–5 MB; unresized they bloat the invoice PDF's fetch, blow
// its 2 MB embed gate (empty placeholder on the bill) and burn egress.
// Downscale to ~1200px JPEG in the browser; fall back to the original file
// when canvas isn't available (old WebViews).
export async function downscalePhoto(file: File): Promise<File> {
  try {
    const bmp = await createImageBitmap(file);
    const MAX = 1200;
    const scale = Math.min(1, MAX / Math.max(bmp.width, bmp.height));
    if (scale >= 1 && file.size < 500_000) return file;
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/jpeg", 0.8));
    if (!blob || blob.size >= file.size) return file;
    return new File([blob], file.name.replace(/\.[^.]+$/, "") + ".jpg", { type: "image/jpeg" });
  } catch {
    return file;
  }
}

// The ceiling a server action can actually receive. next.config.mjs sets
// serverActions.bodySizeLimit to 4mb, and Vercel rejects a serverless request
// body over ~4.5 MB before Next even sees it — so this is a platform floor, not
// a tunable. Over it, the action never runs and resolves to undefined, which
// callers historically reported as "session expired".
//
// Snapshot photos (ident, visiting cards, tracking sheets, notes) go through
// downscalePhoto and never approach this. PRODUCTION imagery — studio sources
// and catalog photos that get published — must keep full resolution, so those
// call sites check this instead and say plainly what went wrong.
export const UPLOAD_LIMIT_BYTES = 4 * 1024 * 1024;

export function tooLargeMessage(file: File): string | null {
  if (file.size <= UPLOAD_LIMIT_BYTES) return null;
  const mb = (file.size / 1024 / 1024).toFixed(1);
  return `That image is ${mb} MB and the upload limit is 4 MB. Resize it, or put it in the design's Drive folder and sync.`;
}
