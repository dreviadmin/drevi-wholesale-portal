import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { lineImage, type LineLike } from "./catalog-images-core";

export { lineImage };

// Order lines snapshot a photo when they are added. A photo fixed afterwards
// (a new Studio front, a first push) would never reach that order's bills, so
// the buyer kept seeing the old picture (Ansh, 7 Oct: "make sure it syncs the
// current image as well so that the buyer sees the correct image when bill is
// generated"). Documents and order pages now show the catalog's CURRENT first
// photo for every catalog line; custom lines keep the photo staff took.

/** The catalog's current first photo per SKU (upper-cased keys). */
export async function currentCatalogImages(skus: (string | null | undefined)[]): Promise<Map<string, string>> {
  const list = [...new Set(skus.map((s) => (s ?? "").trim().toUpperCase()).filter((s) => s && s !== "CUSTOM"))];
  const out = new Map<string, string>();
  if (list.length === 0) return out;
  const admin = createAdminClient();
  for (let i = 0; i < list.length; i += 200) {
    const { data } = await admin.from("wholesale_products").select("sku, image_urls").in("sku", list.slice(i, i + 200));
    for (const r of data ?? []) {
      const first = Array.isArray(r.image_urls) ? (r.image_urls as string[])[0] : null;
      if (first) out.set(String(r.sku).toUpperCase(), first);
    }
  }
  return out;
}


/** Lines with every catalog line's photo replaced by the current one. Never throws. */
export async function withCurrentImages<T extends LineLike>(items: T[]): Promise<T[]> {
  try {
    const current = await currentCatalogImages(items.filter((i) => !i.custom).map((i) => i.sku));
    return items.map((i) => {
      const url = lineImage(i, current);
      return url && url !== i.image_url ? { ...i, image_url: url } : i;
    });
  } catch {
    return items;
  }
}
