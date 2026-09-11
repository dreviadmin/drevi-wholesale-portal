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
