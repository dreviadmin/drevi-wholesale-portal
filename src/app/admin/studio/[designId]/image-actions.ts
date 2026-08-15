"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/staff";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAuditEvent } from "@/lib/audit";
import { DETAIL_ANGLES } from "@/lib/studio/state";
import { storeDesignImage, archiveImageFile, isStorageRef } from "@/lib/design-image-store";

// Retrofit R5 (§7) — four input modes per angle.
//
//   A · Shoot / upload    → new role='source' image, becomes source_image_id
//   B · Use input directly→ existing image becomes source AND approved, raw
//   C · Import a finished → role='import', immediately approvable
//   D · Generate          → pipeline job → role='candidate' for review
//
// detail_1 / detail_2 accept A, B, C only — never D (§7.1). Enforced HERE as
// well as in the UI: generative try-on re-synthesises embroidery.

type Res = { ok: boolean; error?: string };
const fail = (e: string): Res => ({ ok: false, error: e });

async function designMeta(designId: string): Promise<{ ok: boolean; error?: string; baseSku: string; color: string; driveFolderId: string | null }> {
  const admin = createAdminClient();
  const { data: d } = await admin.from("designs").select("id, base_sku, color, drive_folder_id").eq("id", designId).maybeSingle();
  if (!d) return { ok: false, error: "Design not found", baseSku: "", color: "", driveFolderId: null };
  return { ok: true, baseSku: d.base_sku, color: d.color, driveFolderId: d.drive_folder_id ?? null };
}

/** Store one photo for a design, remembering a newly-created Drive folder. */
async function putImage(designId: string, meta: { baseSku: string; color: string; driveFolderId: string | null }, angle: string, kind: string, file: File) {
  const stored = await storeDesignImage({
    designId,
    baseSku: meta.baseSku,
    color: meta.color,
    angle,
    kind,
    bytes: Buffer.from(await file.arrayBuffer()),
    contentType: file.type || "image/jpeg",
    driveFolderId: meta.driveFolderId,
  });
  if (stored.driveFolderId && !meta.driveFolderId) {
    const admin = createAdminClient();
    await admin.from("designs").update({ drive_folder_id: stored.driveFolderId }).eq("id", designId);
  }
  return stored;
}

// D3 — any change to a live design's approved set flips that portal.
async function flipLive(designId: string) {
  const admin = createAdminClient();
  await admin.from("publish_targets").update({ state: "changes_pending" }).eq("design_id", designId).eq("state", "live");
}

/** Mode A — shoot or upload a new SOURCE for this angle. */
export async function uploadSource(angleId: string, formData: FormData): Promise<Res & { imageId?: string }> {
  let staff;
  try { staff = await requireAdmin(); } catch { return fail("Not authorized"); }
  const file = formData.get("photo");
  if (!(file instanceof File) || file.size === 0) return fail("No image");

  const admin = createAdminClient();
  const { data: angle } = await admin.from("design_angles").select("id, design_id, angle").eq("id", angleId).maybeSingle();
  if (!angle) return fail("Angle not found");
  const meta = await designMeta(angle.design_id);
  if (!meta.ok) return fail(meta.error ?? "Design not found");

  let up;
  try { up = await putImage(angle.design_id, meta, angle.angle, "src", file); }
  catch (e) { return fail(e instanceof Error ? e.message : "Upload failed"); }
  const { data: row, error } = await admin
    .from("design_images")
    .insert({ design_id: angle.design_id, angle_id: angleId, role: "source", file_ref: up.fileRef, file_name: up.fileName, status: "active", created_by: staff.email })
    .select("id")
    .single();
  if (error) return fail(error.message);
  // source_ref is what the Workbench renders and generators read — keep it in
  // lockstep with source_image_id (historically only the sheet sync wrote it).
  await admin.from("design_angles").update({ source_image_id: row.id, source_ref: up.fileRef, updated_at: new Date().toISOString() }).eq("id", angleId);
  revalidatePath(`/admin/studio/${angle.design_id}`);
  return { ok: true, imageId: row.id };
}

/** Mode C — import an externally finished image, immediately approvable. */
export async function importFinished(angleId: string, formData: FormData): Promise<Res & { imageId?: string }> {
  let staff;
  try { staff = await requireAdmin(); } catch { return fail("Not authorized"); }
  const file = formData.get("photo");
  if (!(file instanceof File) || file.size === 0) return fail("No image");

  const admin = createAdminClient();
  const { data: angle } = await admin.from("design_angles").select("id, design_id, angle").eq("id", angleId).maybeSingle();
  if (!angle) return fail("Angle not found");
  const meta = await designMeta(angle.design_id);
  if (!meta.ok) return fail(meta.error ?? "Design not found");

  let up;
  try { up = await putImage(angle.design_id, meta, angle.angle, "import", file); }
  catch (e) { return fail(e instanceof Error ? e.message : "Upload failed"); }
  const { data: row, error } = await admin
    .from("design_images")
    .insert({ design_id: angle.design_id, angle_id: angleId, role: "import", file_ref: up.fileRef, file_name: up.fileName, status: "active", engine: "raw", created_by: staff.email })
    .select("id")
    .single();
  if (error) return fail(error.message);
  revalidatePath(`/admin/studio/${angle.design_id}`);
  return { ok: true, imageId: row.id };
}

/**
 * Mode B — use an existing image (source, ident, import, crop, or a detached
 * closeup) directly: it becomes the angle's source AND its approved image,
 * engine 'raw'. No generation, no cost (§7.1).
 */
export async function applyImageDirectly(angleId: string, imageId: string): Promise<Res> {
  let staff;
  try { staff = await requireAdmin(); } catch { return fail("Not authorized"); }
  const admin = createAdminClient();
  const { data: angle } = await admin.from("design_angles").select("id, design_id, approved_image_id").eq("id", angleId).maybeSingle();
  if (!angle) return fail("Angle not found");
  const { data: img } = await admin.from("design_images").select("id, design_id, role, file_ref").eq("id", imageId).maybeSingle();
  if (!img) return fail("Image not found");

  // Attach a design-level image to this angle without losing its identity.
  await admin.from("design_images").update({ angle_id: angleId, status: "active" }).eq("id", imageId);
  await admin
    .from("design_angles")
    .update({ source_image_id: imageId, source_ref: img.file_ref, approved_image_id: imageId, engine: "raw", updated_at: new Date().toISOString() })
    .eq("id", angleId);
  if (angle.approved_image_id && angle.approved_image_id !== imageId) {
    await admin.from("design_images").update({ status: "archived" }).eq("id", angle.approved_image_id);
  }
  await flipLive(angle.design_id);
  await writeAuditEvent({ eventType: "studio_candidate_approved", staffUserId: staff.id, notes: `mode B use-directly image ${imageId} on angle ${angleId}` });
  revalidatePath(`/admin/studio/${angle.design_id}`);
  revalidatePath("/admin/studio");
  return { ok: true };
}

/** Approve any image for an angle (used by modes B/C and the review flow). */
export async function approveImage(angleId: string, imageId: string): Promise<Res> {
  let staff;
  try { staff = await requireAdmin(); } catch { return fail("Not authorized"); }
  const admin = createAdminClient();
  const { data: angle } = await admin.from("design_angles").select("id, design_id, approved_image_id").eq("id", angleId).maybeSingle();
  if (!angle) return fail("Angle not found");
  const { data: design } = await admin.from("designs").select("drive_folder_id").eq("id", angle.design_id).maybeSingle();

  // Previous approval is archived — file moved to _archive/, row marked (§7.5).
  if (angle.approved_image_id && angle.approved_image_id !== imageId) {
    const { data: prev } = await admin.from("design_images").select("id, file_ref").eq("id", angle.approved_image_id).maybeSingle();
    await admin.from("design_images").update({ status: "archived" }).eq("id", angle.approved_image_id);
    if (prev?.file_ref && (isStorageRef(prev.file_ref) || design?.drive_folder_id)) {
      // Move first, then point the row at wherever the file actually landed.
      try {
        const moved = await archiveImageFile(prev.file_ref, design?.drive_folder_id);
        if (moved !== prev.file_ref) await admin.from("design_images").update({ file_ref: moved }).eq("id", angle.approved_image_id);
      } catch { /* move failed — the row still points at the live object */ }
    }
  }
  await admin.from("design_images").update({ status: "active", angle_id: angleId }).eq("id", imageId);
  const { error } = await admin.from("design_angles").update({ approved_image_id: imageId, updated_at: new Date().toISOString() }).eq("id", angleId);
  if (error) return fail(error.message);
  await flipLive(angle.design_id);
  await writeAuditEvent({ eventType: "studio_candidate_approved", staffUserId: staff.id, notes: `image ${imageId} approved on angle ${angleId}` });
  revalidatePath(`/admin/studio/${angle.design_id}`);
  revalidatePath("/admin/studio");
  return { ok: true };
}

export async function rejectImage(imageId: string): Promise<Res> {
  let staff;
  try { staff = await requireAdmin(); } catch { return fail("Not authorized"); }
  const admin = createAdminClient();
  const { data: img } = await admin.from("design_images").select("id, design_id, angle_id, file_ref").eq("id", imageId).maybeSingle();
  if (!img) return fail("Image not found");
  const { data: angle } = img.angle_id
    ? await admin.from("design_angles").select("id, design_id, approved_image_id").eq("id", img.angle_id).maybeSingle()
    : { data: null };

  await admin.from("design_images").update({ status: "rejected" }).eq("id", imageId);
  if (angle?.approved_image_id === imageId) {
    await admin.from("design_angles").update({ approved_image_id: null }).eq("id", angle.id);
    await flipLive(angle.design_id);
  }
  const { data: design } = await admin.from("designs").select("drive_folder_id").eq("id", img.design_id!).maybeSingle();
  if (img.file_ref && (isStorageRef(img.file_ref) || design?.drive_folder_id)) {
    try {
      const moved = await archiveImageFile(img.file_ref, design?.drive_folder_id);
      if (moved !== img.file_ref) await admin.from("design_images").update({ file_ref: moved }).eq("id", imageId);
    } catch { /* move failed — the row still points at the live object */ }
  }
  await writeAuditEvent({ eventType: "studio_candidate_rejected", staffUserId: staff.id, notes: `image ${imageId} rejected` });
  revalidatePath(`/admin/studio/${img.design_id}`);
  return { ok: true };
}

/** §7.3 — crop any image; the original is never modified. */
export async function saveCrop(
  angleId: string | null,
  designId: string,
  parentImageId: string,
  formData: FormData,
): Promise<Res & { imageId?: string }> {
  let staff;
  try { staff = await requireAdmin(); } catch { return fail("Not authorized"); }
  const file = formData.get("photo");
  if (!(file instanceof File) || file.size === 0) return fail("No image");

  const admin = createAdminClient();
  const meta = await designMeta(designId);
  if (!meta.ok) return fail(meta.error ?? "Design not found");
  const { data: angle } = angleId
    ? await admin.from("design_angles").select("angle").eq("id", angleId).maybeSingle()
    : { data: null };

  let up;
  try { up = await putImage(designId, meta, angle?.angle ?? "design", "crop", file); }
  catch (e) { return fail(e instanceof Error ? e.message : "Upload failed"); }

  const { data: row, error } = await admin
    .from("design_images")
    .insert({
      design_id: designId,
      angle_id: angleId,
      role: "crop",
      derived_from: parentImageId,
      file_ref: up.fileRef,
      file_name: up.fileName,
      status: "active",
      created_by: staff.email,
    })
    .select("id")
    .single();
  if (error) return fail(error.message);
  revalidatePath(`/admin/studio/${designId}`);
  return { ok: true, imageId: row.id };
}

/** Mode D guard — the API refusal for detail angles (§7.1). */
export async function assertGenerable(angleId: string): Promise<Res> {
  const admin = createAdminClient();
  const { data: angle } = await admin.from("design_angles").select("angle").eq("id", angleId).maybeSingle();
  if (!angle) return fail("Angle not found");
  if ((DETAIL_ANGLES as readonly string[]).includes(angle.angle)) {
    return fail("Detail angles are macro shots — they are never AI-generated (§7.1).");
  }
  return { ok: true };
}

/** Set the angle's source without approving (mode D "change source"). */
export async function setAngleSource(angleId: string, imageId: string): Promise<Res> {
  try { await requireAdmin(); } catch { return fail("Not authorized"); }
  const admin = createAdminClient();
  const { data: angle } = await admin.from("design_angles").select("design_id").eq("id", angleId).maybeSingle();
  if (!angle) return fail("Angle not found");
  const { data: img } = await admin.from("design_images").select("file_ref").eq("id", imageId).maybeSingle();
  if (!img) return fail("Image not found");
  await admin.from("design_images").update({ angle_id: angleId }).eq("id", imageId);
  const { error } = await admin.from("design_angles").update({ source_image_id: imageId, source_ref: img.file_ref, updated_at: new Date().toISOString() }).eq("id", angleId);
  if (error) return fail(error.message);
  revalidatePath(`/admin/studio/${angle.design_id}`);
  return { ok: true };
}

/** Ansh (4 Aug) — pull photos dropped straight into the Drive folder into the picker pool. */
export async function syncDrivePhotos(designId: string): Promise<Res & { added?: number }> {
  try { await requireAdmin(); } catch { return fail("Not authorized"); }
  const { ingestDriveFolder } = await import("@/lib/design-image-store");
  const res = await ingestDriveFolder(designId);
  if (!res.ok) return fail(res.error ?? "Sync failed");
  revalidatePath(`/admin/studio/${designId}`);
  return { ok: true, added: res.added };
}
