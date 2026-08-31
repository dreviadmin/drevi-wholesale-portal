import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";

// Entity notes (Ansh, 30 Jul) — the "details we might forget" log. One
// polymorphic table serves every entity; detail pages fetch with this and
// mount <NotesPanel>.

export type NoteEntityType = "vendor" | "order" | "buyer" | "design" | "receipt" | "product" | "session";

export interface EntityNote {
  id: string;
  note: string;
  photoRefs: string[];
  createdBy: string | null;
  createdAt: string;
}

export async function listEntityNotes(entityType: NoteEntityType, entityId: string): Promise<EntityNote[]> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("entity_notes")
    .select("id, note, photo_refs, created_by, created_at")
    .eq("entity_type", entityType)
    .eq("entity_id", entityId)
    .order("created_at", { ascending: false })
    .limit(200);
  return (data ?? []).map((r) => ({
    id: r.id,
    note: r.note,
    photoRefs: (r.photo_refs as string[] | null) ?? [],
    createdBy: r.created_by,
    createdAt: r.created_at,
  }));
}
