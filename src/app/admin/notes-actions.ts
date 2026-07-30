"use server";

import { revalidatePath } from "next/cache";
import { requireStaff, requireAdmin } from "@/lib/staff";
import { createAdminClient } from "@/lib/supabase/admin";
import { storeAuxPhoto } from "@/lib/design-image-store";
import type { NoteEntityType } from "@/lib/entity-notes";

// Entity notes actions (Ansh, 30 Jul). Any staff member can add a note where
// they can see the page; only admins can remove one. Photos land in the
// private note-photos bucket and serve through /api/drive-photo.

const TYPES: NoteEntityType[] = ["vendor", "order", "buyer", "design", "receipt", "product", "session"];
const MAX_PHOTOS = 4;
const MAX_BYTES = 8 * 1024 * 1024;

type Res = { ok: boolean; error?: string };

export async function addEntityNote(
  entityType: NoteEntityType,
  entityId: string,
  revalidate: string,
  formData: FormData,
): Promise<Res & { id?: string }> {
  let staff;
  try { staff = await requireStaff(); } catch { return { ok: false, error: "Not authorized." }; }
  if (!TYPES.includes(entityType)) return { ok: false, error: "Unknown entity type." };
  const id = entityId.trim();
  if (!id || id.length > 80) return { ok: false, error: "Bad entity id." };

  const note = String(formData.get("note") ?? "").trim();
  const photos = formData.getAll("photos").filter((f): f is File => f instanceof File && f.size > 0);
  if (!note && photos.length === 0) return { ok: false, error: "Write something or attach a photo." };
  if (photos.length > MAX_PHOTOS) return { ok: false, error: `At most ${MAX_PHOTOS} photos per note.` };

  const refs: string[] = [];
  for (const p of photos) {
    if (p.size > MAX_BYTES) return { ok: false, error: "Photo too large (8 MB max)." };
    const ext = (p.type || "").includes("png") ? "png" : "jpg";
    try {
      refs.push(
        await storeAuxPhoto({
          bucket: "note-photos",
          path: `${entityType}/${id}/${Date.now()}-${Math.random().toString(36).slice(2, 7)}.${ext}`,
          bytes: Buffer.from(await p.arrayBuffer()),
          contentType: p.type || "image/jpeg",
        }),
      );
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "Photo upload failed." };
    }
  }

  const admin = createAdminClient();
  const { data: row, error } = await admin
    .from("entity_notes")
    .insert({ entity_type: entityType, entity_id: id, note, photo_refs: refs, created_by: staff.email })
    .select("id")
    .single();
  if (error) return { ok: false, error: error.message };
  revalidatePath(revalidate);
  return { ok: true, id: row.id };
}

/** Admin-only. The row goes; photos stay in the bucket (cheap, and recoverable). */
export async function deleteEntityNote(noteId: string, revalidate: string): Promise<Res> {
  try { await requireAdmin(); } catch { return { ok: false, error: "Not authorized." }; }
  const admin = createAdminClient();
  const { error } = await admin.from("entity_notes").delete().eq("id", noteId);
  if (error) return { ok: false, error: error.message };
  revalidatePath(revalidate);
  return { ok: true };
}
