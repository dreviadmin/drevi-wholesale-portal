import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

// Rakesh's rule (14 Sep), ONE implementation for every path that lands a photo:
// "If at least one or more photos for a SKU are present in drive or uploaded on
// the portal: Neither the identifier nor the front image shall be blank. add any
// one as the identifier image and front image in case of multiple, but these
// shall not be blank."
//
// The rule used to live only in seedFrontFromIdent, reachable from the single
// ident upload — so a design whose photos arrived by Drive ingest or a Studio
// upload kept a blank identifier and an empty front card forever (141 of the
// 142 dev designs that have photos). This runs after EVERY photo lands and
// repairs whatever is still blank.
//
// It seeds the SOURCE and the identifier only, NEVER approved_image_id:
// approval is a human quality gate, and an auto-approved photo would publish
// unreviewed to the storefront.

/** A photo already known to be usable as an identifier / angle source. */
interface Pick {
  id: string;
  fileRef: string;
}

export interface EnsuredImagery {
  /** designs.ident_image_id was blank and now points at a photo */
  identSet: boolean;
  /** the front angle had nothing to show and now has a source */
  frontSeeded: boolean;
  /** the design had no 'front' row at all (30 dev designs carry only 'lifestyle') */
  frontCreated: boolean;
}

const NOTHING: EnsuredImagery = { identSet: false, frontSeeded: false, frontCreated: false };

async function usableImage(admin: SupabaseClient, imageId: string): Promise<Pick | null> {
  const { data } = await admin.from("design_images").select("id, file_ref, status").eq("id", imageId).maybeSingle();
  if (!data?.file_ref || data.status === "rejected") return null;
  return { id: data.id, fileRef: data.file_ref };
}

/**
 * The one photo this design's identifier and front should point at. Ordered so
 * that the most deliberate choice a human already made wins, and so a repeat
 * run always agrees with the first.
 */
async function pickPhoto(
  admin: SupabaseClient,
  designId: string,
  identImageId: string | null,
  front: { source_image_id: string | null; approved_image_id: string | null } | null,
): Promise<Pick | null> {
  for (const id of [front?.approved_image_id, front?.source_image_id, identImageId]) {
    if (!id) continue;
    const hit = await usableImage(admin, id);
    if (hit) return hit;
  }
  // Oldest first, so a fresh upload never re-points an identifier an earlier
  // run already chose. Role 'candidate' is generated output awaiting review —
  // never the photo staff use to recognise the garment on the rack, and every
  // candidate was generated FROM a source row that is in this pool anyway.
  const { data } = await admin
    .from("design_images")
    .select("id, file_ref")
    .eq("design_id", designId)
    .eq("status", "active")
    .neq("role", "candidate")
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(1);
  const row = (data ?? [])[0];
  return row?.file_ref ? { id: row.id, fileRef: row.file_ref } : null;
}

/**
 * Enforce the rule for one design. Idempotent: a design that is already fine,
 * or that has no photos at all, is left untouched. Never throws — a failed seed
 * must not fail the upload the operator just made.
 */
export async function ensureDesignImagery(admin: SupabaseClient, designId: string): Promise<EnsuredImagery> {
  const { data: design } = await admin.from("designs").select("id, ident_image_id").eq("id", designId).maybeSingle();
  if (!design) return NOTHING;

  const { data: front } = await admin
    .from("design_angles")
    .select("id, source_ref, source_image_id, approved_image_id")
    .eq("design_id", designId)
    .eq("angle", "front")
    .maybeSingle();

  // The Workbench renders source_ref, so an angle carrying source_image_id
  // without source_ref still reads blank — pickPhoto resolves that pointer back
  // to its file and the write below restores the pair, rather than choosing a
  // different photo. An approved front is never blank and is left alone.
  const identBlank = !design.ident_image_id;
  const frontBlank = !front || (!front.source_ref && !front.approved_image_id);
  if (!identBlank && !frontBlank) return NOTHING;

  const picked = await pickPhoto(admin, designId, design.ident_image_id, front);
  if (!picked) return NOTHING; // no photos yet — the rule promises nothing

  let identSet = false;
  let frontSeeded = false;
  let frontCreated = false;

  if (identBlank) {
    // Compare-and-set: an ident uploaded between our read and this write wins.
    const { data: hit } = await admin
      .from("designs")
      .update({ ident_image_id: picked.id })
      .eq("id", designId)
      .is("ident_image_id", null)
      .select("id");
    identSet = (hit ?? []).length > 0;
  }

  if (frontBlank) {
    if (front) {
      // source_ref and source_image_id move together — every Studio path keeps
      // them in lockstep, and the old ident seed wrote only the ref.
      const { data: hit } = await admin
        .from("design_angles")
        .update({ source_image_id: picked.id, source_ref: picked.fileRef, updated_at: new Date().toISOString() })
        .eq("id", front.id)
        .select("id");
      frontSeeded = (hit ?? []).length > 0;
    } else {
      // Conflict-ignore under the (design_id, angle) unique key: a row created
      // since our read is left as it stands rather than overwritten.
      const { data: hit } = await admin
        .from("design_angles")
        .upsert(
          { design_id: designId, angle: "front", source_image_id: picked.id, source_ref: picked.fileRef },
          { onConflict: "design_id,angle", ignoreDuplicates: true },
        )
        .select("id");
      frontCreated = (hit ?? []).length > 0;
      frontSeeded = frontCreated;
    }
  }

  return { identSet, frontSeeded, frontCreated };
}
