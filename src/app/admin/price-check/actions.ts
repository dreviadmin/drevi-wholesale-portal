"use server";

import { requireStaff } from "@/lib/staff";
import { findSkuImage } from "@/lib/drive";

// Resolve a scanned SKU to a Drive photo (best-effort). Returns a proxy URL the
// browser can put straight into an <img>, or null if the feature is off / no
// match. Never throws to the caller — a photo miss must not disrupt scanning.
export async function lookupSkuPhoto(sku: string): Promise<{ url: string | null }> {
  try {
    await requireStaff();
  } catch {
    return { url: null };
  }
  try {
    const hit = await findSkuImage(sku);
    return { url: hit ? `/api/drive-photo?id=${encodeURIComponent(hit.fileId)}` : null };
  } catch {
    return { url: null };
  }
}
