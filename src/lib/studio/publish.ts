import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { fetchDriveImage } from "@/lib/drive";
import { uploadPublishedImage } from "@/lib/storage";
import { writeAuditEvent } from "@/lib/audit";
import { loadDesignDetail } from "./load";
import { ALL_ANGLES } from "./state";

// Stage 7a — wholesale publish (build guide §11.2). Idempotent: Re-push runs
// the exact same routine over the same deterministic storage paths.
//
// 1. Hard gate (same function the UI chips show) — fail with the reasons.
// 2. Copy every approved candidate from Drive into the public product-images
//    bucket (s1200 web + s800 thumb) and upsert the product_images registry.
// 3. Point wholesale_products.image_urls for ALL size variants of the group
//    at the published set (front first), write the approved description, and
//    LOCK those fields — the sheet sync must never claw them back.
// 4. Flip the target live (+last_pushed_at) and audit.

export interface PublishResult {
  ok: boolean;
  error?: string;
  blockers?: string[];
  published?: number; // images published
  variants?: number; // wholesale_products rows updated
}

export async function publishWholesale(designId: string, staffId: string, staffEmail: string): Promise<PublishResult> {
  const admin = createAdminClient();
  const detail = await loadDesignDetail(designId);
  if (!detail) return { ok: false, error: "Design not found" };
  const { board, angles, copy } = detail;

  const target = board.targets.find((t) => t.portal === "wholesale");
  if (target && !target.enabled) return { ok: false, error: "Wholesale is disabled for this design" };
  const gate = board.gates.wholesale;
  if (!gate.ready) return { ok: false, error: "Gate not met", blockers: gate.blockers };

  await admin.from("publish_targets").update({ state: "pushing", error: null }).eq("design_id", designId).eq("portal", "wholesale");

  try {
    // Approved candidates in display order (front → … → detail_2).
    const approved: { angle: string; fileRef: string; candidateId: string }[] = [];
    for (const angleName of ALL_ANGLES) {
      const a = angles.find((x) => x.angle === angleName);
      if (!a?.approvedImageId) continue;
      const cand = a.candidates.find((c) => c.id === a.approvedImageId);
      if (cand) approved.push({ angle: a.angle, fileRef: cand.fileRef, candidateId: cand.id });
    }
    if (approved.length === 0) return { ok: false, error: "No approved images (gate should have caught this)" };

    const webUrls: string[] = [];
    const nowIso = new Date().toISOString();
    for (const item of approved) {
      const [web, thumb] = await Promise.all([fetchDriveImage(item.fileRef, 1200), fetchDriveImage(item.fileRef, 800)]);
      if (!web || !thumb) throw new Error(`Could not fetch ${item.angle} image from Drive`);
      const webUp = await uploadPublishedImage(board.baseSku, board.color, item.angle, 1200, Buffer.from(web.body), web.contentType);
      await uploadPublishedImage(board.baseSku, board.color, item.angle, 800, Buffer.from(thumb.body), thumb.contentType);
      webUrls.push(webUp.url);
      const { error } = await admin.from("product_images").upsert(
        {
          sku_base: board.baseSku,
          color: board.color,
          angle: item.angle,
          storage_path: webUp.path,
          source_candidate_id: item.candidateId,
          published_at: nowIso,
        },
        { onConflict: "sku_base,color,angle" },
      );
      if (error) throw new Error(`product_images upsert: ${error.message}`);
    }

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
      const patch: Record<string, unknown> = {
        image_urls: webUrls,
        images_fetched_at: nowIso,
        locked_fields: [...locks],
      };
      if (copy?.status === "approved" && copy.description) {
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
      notes: `wholesale push ${board.baseSku}·${board.color}: ${approved.length} image(s) → ${updated} variant(s) by ${staffEmail}`,
    });
    return { ok: true, published: approved.length, variants: updated };
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
