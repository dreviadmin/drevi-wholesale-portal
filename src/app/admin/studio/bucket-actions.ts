"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/staff";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAuditEvent } from "@/lib/audit";
import { bucketKeyFor, cleanBucketLabel, sameBucketLabel, type BucketChange, type StudioBucket } from "@/lib/studio/buckets";

// Studio buckets (0074; several per design since 0078). Same gate as the rest
// of Studio (admin / super_admin). None of these touch designs.updated_at:
// MasterEditor drafts use it as their base, and a bucket is not a change to
// the product.

const SET_CAP = 500;
const COLS = "key, label, sort, preset, active";
const INSERT_CHUNK = 1000;

/** 0078 not applied yet: say so instead of a raw schema-cache error. */
function membershipError(error: { code?: string; message: string }): string {
  return error.code === "PGRST205" || error.code === "42P01"
    ? "Buckets can't be saved until migration 0078 is applied to this database."
    : error.message;
}

export interface SetBucketResult {
  ok: boolean;
  error?: string;
  updated?: number;
  setAt?: string;
  setBy?: string;
}

/**
 * Add designs to buckets, take them out, or clear them (clear = out of every
 * bucket first). One action for a design's own picker, the Workbench and the
 * batch picker. Only an active bucket can be added: a removed one is refused
 * with a way forward rather than silently re-added. Taking a design out of a
 * removed bucket is always allowed.
 *
 * A design already in a bucket keeps its original "added by" stamp.
 */
export async function changeDesignBuckets(designIds: string[], change: BucketChange): Promise<SetBucketResult> {
  let staff;
  try { staff = await requireAdmin(); } catch { return { ok: false, error: "Not authorized" }; }
  const ids = [...new Set(designIds)].filter(Boolean);
  if (ids.length === 0) return { ok: false, error: "Nothing selected" };
  if (ids.length > SET_CAP) return { ok: false, error: `Select at most ${SET_CAP} designs at a time.` };
  const add = [...new Set(change.add ?? [])].filter(Boolean);
  const remove = [...new Set(change.remove ?? [])].filter((k) => k && !add.includes(k));
  if (!change.clear && add.length === 0 && remove.length === 0) return { ok: false, error: "Nothing to change." };

  const admin = createAdminClient();
  const labels = new Map<string, string>();
  const keys = [...new Set([...add, ...remove])];
  if (keys.length) {
    const { data: rows, error } = await admin.from("studio_buckets").select(COLS).in("key", keys);
    if (error) return { ok: false, error: error.message };
    for (const b of (rows ?? []) as StudioBucket[]) labels.set(b.key, b.label);
    for (const key of add) {
      const b = (rows ?? []).find((r) => r.key === key) as StudioBucket | undefined;
      if (!b) return { ok: false, error: "That bucket no longer exists — pick another." };
      if (!b.active) return { ok: false, error: `"${b.label}" was removed — add it again from the picker to use it.` };
    }
  }

  const { data: designs, error: readErr } = await admin.from("designs").select("id, base_sku, color").in("id", ids);
  if (readErr) return { ok: false, error: readErr.message };
  const found = designs ?? [];
  if (found.length === 0) return { ok: false, error: "Those designs no longer exist." };
  const live = found.map((d) => d.id as string);

  if (change.clear || remove.length) {
    let q = admin.from("design_buckets").delete().in("design_id", live);
    if (!change.clear) q = q.in("bucket_key", remove);
    const { error } = await q;
    if (error) return { ok: false, error: membershipError(error) };
  }

  // Worded before any write, so a partly saved change is logged as precisely
  // as a full one.
  const named = found.slice(0, 3).map((r) => `${r.base_sku} · ${r.color}`).join(", ");
  const on = found.length === 1 ? named : `${found.length} designs (${named}${found.length > 3 ? ", …" : ""})`;
  const quote = (k: string) => `"${labels.get(k) ?? k}"`;
  const what = [
    change.clear ? "cleared" : "",
    add.length ? `+ ${add.map(quote).join(", ")}` : "",
    remove.length ? `− ${remove.map(quote).join(", ")}` : "",
  ].filter(Boolean).join(" · ");

  const setAt = new Date().toISOString();
  const setBy = staff.name?.trim() || staff.email;
  if (add.length) {
    const rows = live.flatMap((design_id) => add.map((bucket_key) => ({ design_id, bucket_key, set_at: setAt, set_by: setBy })));
    for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
      const { error } = await admin
        .from("design_buckets")
        .upsert(rows.slice(i, i + INSERT_CHUNK), { onConflict: "design_id,bucket_key", ignoreDuplicates: true });
      if (error) {
        // Removals and earlier chunks have landed: record them, and say so,
        // rather than report a change that partly happened as one that did not.
        const landed = change.clear || remove.length || i > 0;
        if (landed) {
          const step = `${change.clear || remove.length ? "removals saved, " : ""}${i > 0 ? `adds saved for ${i} of ${rows.length}` : "adds not saved"}`;
          await writeAuditEvent({ eventType: "catalog_edit", staffUserId: staff.id, notes: `studio buckets partly saved (${what}) on ${on}: ${step} — ${membershipError(error)}` });
        }
        revalidatePath("/admin/studio");
        return { ok: false, error: landed ? `Saved in part — check the list after the refresh. (${membershipError(error)})` : membershipError(error) };
      }
    }
  }

  await writeAuditEvent({ eventType: "catalog_edit", staffUserId: staff.id, notes: `studio buckets ${what} on ${on}` });
  revalidatePath("/admin/studio");
  if (ids.length === 1) revalidatePath(`/admin/studio/${ids[0]}`);
  // The stamp is "who added a bucket last": a removal does not move it.
  return { ok: true, updated: found.length, ...(add.length ? { setAt, setBy } : {}) };
}

/**
 * Add a custom bucket from the picker. Typing a name that already exists —
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
 * Take a custom bucket out of the picker (a typo, a queue that is done).
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
  const { count } = await admin.from("design_buckets").select("design_id", { count: "exact", head: true }).eq("bucket_key", key);
  await writeAuditEvent({ eventType: "catalog_edit", staffUserId: staff.id, notes: `studio bucket removed: "${bucket.label}" (${count ?? 0} design(s) keep it)` });
  revalidatePath("/admin/studio");
  return { ok: true, inUse: count ?? 0 };
}
