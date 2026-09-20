import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { fetchImageByRef } from "@/lib/design-image-store";
import { uploadPublishedImage } from "@/lib/storage";
import { writeAuditEvent } from "@/lib/audit";
import { loadDesignDetail } from "./load";
import { ALL_ANGLES } from "./state";

// Stage 7a — wholesale publish (build guide §11.2). Idempotent: Re-push runs
// the exact same routine over the same deterministic storage paths.
//
// 1. Hard gate (same function the UI chips show) — fail with the reasons.
// 2. Copy every angle's EFFECTIVE image (approved candidate, else its source
//    — 17 Sep semantics) into the public product-images bucket (s1200 web +
//    s800 thumb) and upsert the product_images registry.
// 3. Point wholesale_products.image_urls for ALL size variants of the group
//    at the published set (front first), write the description whenever real
//    copy exists (draft included — whoever pushed has read it), and LOCK
//    those fields — the sheet sync must never claw them back.
// 4. Flip the target live (+last_pushed_at) and audit.

export interface PublishResult {
  ok: boolean;
  error?: string;
  blockers?: string[];
  published?: number; // images published
  variants?: number; // wholesale_products rows updated
}

/**
 * Publish the design's EFFECTIVE image set to the public bucket and register
 * it in product_images. Portal-NEUTRAL (20 Sep): it was the first half of
 * publishWholesale, which is why the Shopify push refused with "Push wholesale
 * first" — its media reads product_images, and only the wholesale push ever
 * wrote there. A garment that belongs on Shopify and not in the trade catalog
 * had no way through.
 *
 * product_images is keyed (sku_base, color, angle) and has nothing wholesale
 * about it. It is the PUBLISHED WEB SET; either portal may create it, both
 * read it, and re-running writes the same deterministic paths.
 */
export async function publishImageSet(designId: string): Promise<{
  ok: boolean;
  error?: string;
  webUrls?: string[];
  count?: number;
}> {
  const admin = createAdminClient();
  const detail = await loadDesignDetail(designId);
  if (!detail) return { ok: false, error: "Design not found" };
  const { board, angles } = detail;

  // The EFFECTIVE set in display order (front → … → detail_2): the approved
  // candidate where one exists, else the angle's source.
  const publishSet: { angle: string; fileRef: string; imageId: string | null }[] = [];
  for (const angleName of ALL_ANGLES) {
    const a = angles.find((x) => x.angle === angleName);
    if (!a) continue;
    const cand = a.approvedImageId ? a.candidates.find((c) => c.id === a.approvedImageId) : undefined;
    if (cand) publishSet.push({ angle: a.angle, fileRef: cand.fileRef, imageId: cand.id });
    else if (a.sourceRef) publishSet.push({ angle: a.angle, fileRef: a.sourceRef, imageId: a.sourceImageId });
  }
  if (publishSet.length === 0) return { ok: false, error: "No images to publish" };

  const webUrls: string[] = [];
  const nowIso = new Date().toISOString();
  for (const item of publishSet) {
    // fetchImageByRef serves Drive ids AND the portal-storage sb: refs —
    // fetchDriveImage alone broke on backfilled sb: fronts.
    // 2048 for the web image (20 Sep). At 1200 the long edge, a published
    // front came out 674x1200 — and that exact file is what the Shopify push
    // hands the product page, where a customer pinch-zooms the embroidery a
    // garment is sold on. 2048 is the e-commerce norm and every engine now
    // produces at least that. The 800 thumb is unchanged: it is a grid tile.
    const [web, thumb] = await Promise.all([fetchImageByRef(item.fileRef, 2048), fetchImageByRef(item.fileRef, 800)]);
    if (!web || !thumb) return { ok: false, error: `Could not fetch the ${item.angle} image` };
    // The width is part of the storage PATH (angle-1200.jpg), so this writes
    // angle-2048.jpg alongside whatever is already there rather than over it.
    const webUp = await uploadPublishedImage(board.baseSku, board.color, item.angle, 2048, Buffer.from(web.body), web.contentType);
    await uploadPublishedImage(board.baseSku, board.color, item.angle, 800, Buffer.from(thumb.body), thumb.contentType);
    webUrls.push(webUp.url);
    const { error } = await admin.from("product_images").upsert(
      {
        sku_base: board.baseSku,
        color: board.color,
        angle: item.angle,
        storage_path: webUp.path,
        source_candidate_id: item.imageId,
        published_at: nowIso,
      },
      { onConflict: "sku_base,color,angle" },
    );
    if (error) return { ok: false, error: `product_images upsert: ${error.message}` };
  }
  return { ok: true, webUrls, count: publishSet.length };
}

/**
 * Is the registered set still the design's effective set? Compares angle by
 * angle against product_images.source_candidate_id. A Shopify-only garment
 * never gets a wholesale re-push to refresh its media, so without this its
 * pictures would freeze at whatever was published the first time.
 */
export async function publishedSetIsStale(designId: string): Promise<boolean> {
  const admin = createAdminClient();
  const detail = await loadDesignDetail(designId);
  if (!detail) return false;
  const { board, angles } = detail;

  const effective = new Map<string, string | null>();
  for (const angleName of ALL_ANGLES) {
    const a = angles.find((x) => x.angle === angleName);
    if (!a) continue;
    const cand = a.approvedImageId ? a.candidates.find((c) => c.id === a.approvedImageId) : undefined;
    if (cand) effective.set(a.angle, cand.id);
    else if (a.sourceRef) effective.set(a.angle, a.sourceImageId);
  }
  if (effective.size === 0) return false;

  const { data, error } = await admin
    .from("product_images")
    .select("angle, source_candidate_id")
    .eq("sku_base", board.baseSku)
    .eq("color", board.color);
  // Unreadable is not "fresh": re-publishing costs a few uploads, serving the
  // wrong photos costs a customer.
  if (error) return true;
  const published = new Map((data ?? []).map((r) => [r.angle as string, (r.source_candidate_id as string | null) ?? null]));
  if (published.size === 0) return true;
  for (const [angle, imageId] of effective) {
    if (!published.has(angle)) return true;
    if (published.get(angle) !== imageId) return true;
  }
  return false;
}

export async function publishWholesale(designId: string, staffId: string, staffEmail: string): Promise<PublishResult> {
  const admin = createAdminClient();
  const detail = await loadDesignDetail(designId);
  if (!detail) return { ok: false, error: "Design not found" };
  // angles is no longer read here — publishImageSet owns the image half now.
  const { board, copy } = detail;

  const target = board.targets.find((t) => t.portal === "wholesale");
  if (target && !target.enabled) return { ok: false, error: "Wholesale is disabled for this design" };
  const gate = board.gates.wholesale;
  if (!gate.ready) return { ok: false, error: "Gate not met", blockers: gate.blockers };

  await admin.from("publish_targets").update({ state: "pushing", error: null }).eq("design_id", designId).eq("portal", "wholesale");

  try {
    // Publishing the images is portal-neutral and now lives in
    // publishImageSet, which the Shopify push calls too — that shared step is
    // what stopped Shopify needing a wholesale push to have run first.
    const set = await publishImageSet(designId);
    if (!set.ok || !set.webUrls) throw new Error(set.error ?? "Could not publish the image set");
    const webUrls = set.webUrls;
    const publishedCount = set.count ?? webUrls.length;
    const nowIso = new Date().toISOString();

    // Every size variant of the (base, color) group gets the published set.
    const { data: variants, error: vErr } = await admin
      .from("wholesale_products")
      .select("sku, locked_fields, description")
      .like("sku", `${board.baseSku}-%`);
    if (vErr) throw new Error(vErr.message);
    const groupRows = (variants ?? []).filter((v) => v.sku.toUpperCase().endsWith(`-${board.color}`));
    let updated = 0;
    for (const v of groupRows) {
      const locks = new Set<string>(Array.isArray(v.locked_fields) ? v.locked_fields : []);
      locks.add("image_urls"); // published set is app-owned now — sync keeps off
      // AND MAKE IT VISIBLE (Ansh, 20 Sep: "the live designs pushed to Shopify
      // and wholesale are still not visible in the catalog — why so?").
      //
      // Because nothing ever turned them on. Log delivery mints every SKU with
      // wholesale_visible FALSE and locks it that way (delivery-actions §5.7),
      // deliberately — a garment counted into stock is not automatically for
      // sale. publishWholesale then wrote images, description and state='live'
      // and never touched the flag, so the board said LIVE, the buyer catalog
      // filters on wholesale_visible, and the design was invisible with no
      // sign of why. All three wholesale-live designs on prod were in exactly
      // that state, each fully priced and photographed.
      //
      // Pushing to the wholesale catalog IS the act of putting it on sale, so
      // the push now says so. The lock stays: the flag is an app decision and
      // the sheet must not move it back.
      locks.add("wholesale_visible");
      const patch: Record<string, unknown> = {
        image_urls: webUrls,
        images_fetched_at: nowIso,
        wholesale_visible: true,
        locked_fields: [...locks],
      };
      // Copy presence (not the approved stamp) writes the description — the
      // same contract the shopify gate uses now.
      if (board.copyPresent && copy?.description) {
        patch.description = copy.description;
        locks.add("description");
        patch.locked_fields = [...locks];
      }
      const { error } = await admin.from("wholesale_products").update(patch).eq("sku", v.sku);
      if (error) throw new Error(`variant ${v.sku}: ${error.message}`);
      updated++;
    }

    await admin
      .from("publish_targets")
      .update({ state: "live", last_pushed_at: nowIso, error: null })
      .eq("design_id", designId)
      .eq("portal", "wholesale");
    await writeAuditEvent({
      eventType: "studio_published",
      staffUserId: staffId,
      notes: `wholesale push ${board.baseSku}·${board.color}: ${publishedCount} image(s) → ${updated} variant(s) by ${staffEmail}`,
    });
    return { ok: true, published: publishedCount, variants: updated };
  } catch (err) {
    const message = (err as Error).message;
    await admin
      .from("publish_targets")
      .update({ state: "error", error: message })
      .eq("design_id", designId)
      .eq("portal", "wholesale");
    return { ok: false, error: message };
  }
}
