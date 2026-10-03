"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/staff";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAuditEvent } from "@/lib/audit";
import { bucketKeyFor, cleanBucketLabel, sameBucketLabel, type StudioBucket } from "@/lib/studio/buckets";

// Studio buckets (0074). Same gate as the rest of Studio (admin / super_admin).
// None of these touch designs.updated_at: MasterEditor drafts use it as their
// base, and a bucket is not a change to the product.

const SET_CAP = 500;
const COLS = "key, label, sort, preset, active";

export interface SetBucketResult {
  ok: boolean;
  error?: string;
  updated?: number;
  setAt?: string;
  setBy?: string;
}

/**
 * Put one or many designs in a bucket, or take them out (key = null → Not
 * set). One action for the row dropdown, the Workbench and the batch bar.
 * Only an active bucket can be picked: a removed one is refused with a way
 * forward rather than silently re-added.
 */
export async function setDesignBucket(designIds: string[], key: string | null): Promise<SetBucketResult> {
  let staff;
  try { staff = await requireAdmin(); } catch { return { ok: false, error: "Not authorized" }; }
  const ids = [...new Set(designIds)].filter(Boolean);
  if (ids.length === 0) return { ok: false, error: "Nothing selected" };
  if (ids.length > SET_CAP) return { ok: false, error: `Select at most ${SET_CAP} designs at a time.` };

  const admin = createAdminClient();
  let label = "Not set";
  if (key !== null) {
    const { data: bucket, error } = await admin.from("studio_buckets").select(COLS).eq("key", key).maybeSingle();
    if (error) return { ok: false, error: error.message };
    if (!bucket) return { ok: false, error: "That bucket no longer exists — pick another." };
    if (!bucket.active) return { ok: false, error: `"${bucket.label}" was removed — add it again from the dropdown to use it.` };
    label = bucket.label;
  }

  const setAt = new Date().toISOString();
  const setBy = staff.name?.trim() || staff.email;
  const { data: rows, error } = await admin
    .from("designs")
    .update(key === null
      ? { studio_bucket: null, studio_bucket_set_at: null, studio_bucket_set_by: null }
      : { studio_bucket: key, studio_bucket_set_at: setAt, studio_bucket_set_by: setBy })
    .in("id", ids)
    .select("id, base_sku, color");
  if (error) return { ok: false, error: error.message };
  const updated = rows ?? [];
  if (updated.length === 0) return { ok: false, error: "Those designs no longer exist." };

  const named = updated.slice(0, 3).map((r) => `${r.base_sku} · ${r.color}`).join(", ");
  await writeAuditEvent({
    eventType: "catalog_edit",
    staffUserId: staff.id,
    notes: `studio bucket → "${label}" on ${updated.length === 1 ? named : `${updated.length} designs (${named}${updated.length > 3 ? ", …" : ""})`}`,
  });
  revalidatePath("/admin/studio");
  if (ids.length === 1) revalidatePath(`/admin/studio/${ids[0]}`);
  return { ok: true, updated: updated.length, ...(key === null ? {} : { setAt, setBy }) };
}

/**
 * Add a custom bucket from the dropdown. Typing a name that already exists —
 * any capitals or spacing — hands back that bucket instead of a duplicate,
 * and brings it back if it had been removed.
 */
export async function addStudioBucket(rawLabel: string): Promise<{ ok: boolean; error?: string; bucket?: StudioBucket; existed?: boolean }> {
  let staff;
  try { staff = await requireAdmin(); } catch { return { ok: false, error: "Not authorized" }; }
  const clean = cleanBucketLabel(rawLabel);
  if (!clean.ok) return { ok: false, error: clean.error };

  const admin = createAdminClient();
  const readAll = async () => admin.from("studio_buckets").select(COLS);
  const { data: all, error } = await readAll();
  if (error) return { ok: false, error: error.message };
  const rows = (all ?? []) as StudioBucket[];

  const same = rows.find((b) => sameBucketLabel(b.label, clean.label));
  if (same) {
    if (same.active) return { ok: true, bucket: same, existed: true };
    const { error: upErr } = await admin.from("studio_buckets").update({ active: true }).eq("key", same.key);
    if (upErr) return { ok: false, error: upErr.message };
    await writeAuditEvent({ eventType: "catalog_edit", staffUserId: staff.id, notes: `studio bucket restored: "${same.label}"` });
    revalidatePath("/admin/studio");
    return { ok: true, bucket: { ...same, active: true }, existed: true };
  }

  // 23505 means someone got there a moment ago: the SAME name (use theirs) or
  // a different name that slugs to the same key (take the next key and retry).
  let known = rows;
  for (let attempt = 0; attempt < 3; attempt++) {
    const key = bucketKeyFor(clean.label, known.map((b) => b.key));
    const sort = Math.max(100, ...known.map((b) => b.sort)) + 10;
    const { data: made, error: insErr } = await admin
      .from("studio_buckets")
      .insert({ key, label: clean.label, sort, preset: false, active: true, created_by: staff.name?.trim() || staff.email })
      .select(COLS)
      .single();
    if (!insErr) {
      await writeAuditEvent({ eventType: "catalog_edit", staffUserId: staff.id, notes: `studio bucket added: "${clean.label}"` });
      revalidatePath("/admin/studio");
      return { ok: true, bucket: made as StudioBucket };
    }
    if (insErr.code !== "23505") return { ok: false, error: insErr.message };
    const again = await readAll();
    known = (again.data ?? []) as StudioBucket[];
    const theirs = known.find((b) => sameBucketLabel(b.label, clean.label));
    if (theirs) return { ok: true, bucket: theirs, existed: true };
  }
  return { ok: false, error: "Someone just added a similar bucket — try again." };
}

/**
 * Take a custom bucket out of the dropdown (a typo, a queue that is done).
 * Designs already in it keep it and stay findable under its filter chip; the
 * four standard buckets cannot be removed.
 */
export async function removeStudioBucket(key: string): Promise<{ ok: boolean; error?: string; inUse?: number }> {
  let staff;
  try { staff = await requireAdmin(); } catch { return { ok: false, error: "Not authorized" }; }
  const admin = createAdminClient();
  const { data: bucket, error } = await admin.from("studio_buckets").select(COLS).eq("key", key).maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!bucket) return { ok: false, error: "That bucket no longer exists." };
  if (bucket.preset) return { ok: false, error: "The four standard buckets can't be removed." };
  const { error: upErr } = await admin.from("studio_buckets").update({ active: false }).eq("key", key);
  if (upErr) return { ok: false, error: upErr.message };
  const { count } = await admin.from("designs").select("id", { count: "exact", head: true }).eq("studio_bucket", key);
  await writeAuditEvent({ eventType: "catalog_edit", staffUserId: staff.id, notes: `studio bucket removed: "${bucket.label}" (${count ?? 0} design(s) keep it)` });
  revalidatePath("/admin/studio");
  return { ok: true, inUse: count ?? 0 };
}
