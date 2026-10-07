import "server-only";

import { createHash } from "node:crypto";
import sharp from "sharp";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchImageByRef } from "@/lib/design-image-store";
import { uploadPublishedImage } from "@/lib/storage";
import { designKeyOf } from "@/lib/retail-price-core";

// THE FRONT PHOTO IS THE THUMBNAIL, published or not (Ansh, 7 Oct, on
// DD-SUT-PLZ-028 PUR: "The first photo (front photo) is not displayed as the
// thumbnail photo. So the buyer sees the wrong image."). That design had never
// been pushed, so its catalog row still carried the sheet era's six photos, of
// a different garment, and every picker, order line and bill used the first
// of them. Staff billed it as a custom line with their own photo instead.
//
// A design LIVE on the wholesale portal already shows its published front
// (publishWholesale writes image_urls). For every other design this copies the
// Studio front (the approved image, else the angle's source) into the public
// product-images bucket and puts it FIRST in image_urls of every size, with
// image_urls locked so the sheet sync stops putting the old photos back. The
// older photos stay behind it in the gallery; nothing is deleted.
//
// The URL carries ?v=<hash of the front's file ref>, which (a) busts any CDN
// or browser copy of the previous front, and (b) lets a repeat call see that
// nothing changed without downloading anything.

const MARK = "/catalog_front-";
export const isCatalogFrontUrl = (u: unknown): boolean => typeof u === "string" && u.includes(MARK);

export type CatalogFrontResult = { ok: boolean; updated?: number; skipped?: string; error?: string };

export async function syncCatalogFront(designId: string): Promise<CatalogFrontResult> {
  const admin = createAdminClient();
  const { data: d } = await admin.from("designs").select("id, base_sku, color").eq("id", designId).maybeSingle();
  if (!d) return { ok: false, error: "Design not found" };

  const { data: target } = await admin.from("publish_targets").select("state").eq("design_id", designId).eq("portal", "wholesale").maybeSingle();
  if (target && (target.state === "live" || target.state === "changes_pending")) return { ok: true, skipped: "published" };

  const key = `${d.base_sku}|${d.color}`.toUpperCase();
  const { data: rows } = await admin
    .from("wholesale_products")
    .select("sku, image_urls, locked_fields")
    .ilike("sku", `${d.base_sku}-%-${d.color}`);
  const group = (rows ?? []).filter((r) => designKeyOf(r.sku) === key);
  if (group.length === 0) return { ok: true, skipped: "no catalog rows" };

  // Effective front: the approved image, else the angle's source.
  const { data: front } = await admin
    .from("design_angles")
    .select("approved_image_id, source_ref")
    .eq("design_id", designId)
    .eq("angle", "front")
    .maybeSingle();
  let ref: string | null = null;
  if (front?.approved_image_id) {
    const { data: img } = await admin.from("design_images").select("file_ref").eq("id", front.approved_image_id).maybeSingle();
    ref = img?.file_ref ?? null;
  }
  ref = ref ?? front?.source_ref ?? null;
  if (!ref) return { ok: true, skipped: "no front photo" };

  const version = createHash("sha1").update(ref).digest("hex").slice(0, 10);
  const inSync = group.every((r) => {
    const first = Array.isArray(r.image_urls) ? r.image_urls[0] : null;
    return isCatalogFrontUrl(first) && String(first).endsWith(`?v=${version}`);
  });
  if (inSync) return { ok: true, updated: 0 };

  const img = await fetchImageByRef(ref, 1600);
  if (!img) return { ok: false, error: "Could not fetch the front photo" };
  const jpg = await sharp(Buffer.from(img.body))
    .rotate()
    .resize({ width: 1200, height: 1200, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toBuffer();
  const up = await uploadPublishedImage(d.base_sku, d.color, "catalog_front", 1200, jpg, "image/jpeg");
  const url = `${up.url}?v=${version}`;

  let updated = 0;
  for (const r of group) {
    const old: string[] = Array.isArray(r.image_urls) ? r.image_urls : [];
    if (old[0] === url) continue;
    const locks = new Set<string>(Array.isArray(r.locked_fields) ? r.locked_fields : []);
    locks.add("image_urls");
    const { error } = await admin
      .from("wholesale_products")
      .update({ image_urls: [url, ...old.filter((u) => !isCatalogFrontUrl(u))], locked_fields: [...locks] })
      .eq("sku", r.sku);
    if (error) return { ok: false, error: error.message };
    updated++;
  }
  return { ok: true, updated };
}

/** For Studio actions: a failed thumbnail sync must never fail the action itself. */
export async function syncCatalogFrontQuietly(designId: string | null | undefined): Promise<void> {
  if (!designId) return;
  try {
    const r = await syncCatalogFront(designId);
    if (!r.ok) console.warn(`[catalog-front] ${designId}: ${r.error}`);
  } catch (e) {
    console.warn(`[catalog-front] ${designId}: ${e instanceof Error ? e.message : String(e)}`);
  }
}
