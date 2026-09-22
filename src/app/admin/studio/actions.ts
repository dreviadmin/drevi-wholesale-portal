"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin, requireStaff } from "@/lib/staff";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAuditEvent } from "@/lib/audit";
import { DETAIL_ANGLES } from "@/lib/studio/state";
import { loadVocab } from "@/lib/sku/vocab-live";

// Stage 3's two LIVE batch actions (§7.4). Spend/push actions arrive with
// Stages 4–7 — their buttons render disabled until then.

export async function setTierBatch(designIds: string[], tier: "standard" | "hero"): Promise<{ ok: boolean; error?: string }> {
  let staff;
  try {
    staff = await requireAdmin();
  } catch {
    return { ok: false, error: "Not authorized" };
  }
  if (designIds.length === 0) return { ok: false, error: "Nothing selected" };
  const admin = createAdminClient();
  const { error } = await admin.from("designs").update({ tier, updated_at: new Date().toISOString() }).in("id", designIds.slice(0, 500));
  if (error) return { ok: false, error: error.message };
  await writeAuditEvent({
    eventType: "studio_tier_set",
    staffUserId: staff.id,
    notes: `tier=${tier} on ${designIds.length} design(s)`,
  });
  revalidatePath("/admin/studio");
  return { ok: true };
}

export async function togglePortalBatch(
  designIds: string[],
  portal: "wholesale" | "shopify",
  enabled: boolean,
): Promise<{ ok: boolean; error?: string }> {
  let staff;
  try {
    staff = await requireAdmin();
  } catch {
    return { ok: false, error: "Not authorized" };
  }
  if (designIds.length === 0) return { ok: false, error: "Nothing selected" };
  const admin = createAdminClient();
  const { error } = await admin
    .from("publish_targets")
    .update({ enabled })
    .eq("portal", portal)
    .in("design_id", designIds.slice(0, 500));
  if (error) return { ok: false, error: error.message };
  await writeAuditEvent({
    eventType: "studio_portal_toggled",
    staffUserId: staff.id,
    notes: `${portal} ${enabled ? "enabled" : "disabled"} on ${designIds.length} design(s)`,
  });
  revalidatePath("/admin/studio");
  return { ok: true };
}

// ---- Stage 5 batch actions (§9) ------------------------------------------

// Run FASHN across a selection: every AI angle with a source, engine fashn,
// no approved candidate and no active job gets one tryon job. dryRun returns
// the count + credit estimate for the D8 confirm sheet.
export async function runFashnBatch(
  designIds: string[],
  dryRun: boolean,
): Promise<{ ok: boolean; error?: string; jobs?: number; credits?: number }> {
  let staff;
  try {
    staff = await requireAdmin();
  } catch {
    return { ok: false, error: "Not authorized" };
  }
  if (designIds.length === 0) return { ok: false, error: "Nothing selected" };
  const admin = createAdminClient();
  const [{ data: angles }, { data: activeJobs }] = await Promise.all([
    admin
      .from("design_angles")
      .select("id, design_id, angle, engine, source_ref, approved_image_id")
      .in("design_id", designIds.slice(0, 500)),
    admin.from("pipeline_jobs").select("angle_id").in("status", ["queued", "claimed", "running"]),
  ]);
  const busy = new Set((activeJobs ?? []).map((j) => j.angle_id));
  const targets = (angles ?? []).filter(
    (a) =>
      !(DETAIL_ANGLES as readonly string[]).includes(a.angle) &&
      a.engine === "fashn" &&
      a.source_ref &&
      !a.approved_image_id &&
      !busy.has(a.id),
  );
  const CREDITS_EACH = 2; // 1k · balanced (drevi_common TRYON_MAX_CREDITS)
  if (dryRun) return { ok: true, jobs: targets.length, credits: targets.length * CREDITS_EACH };
  if (targets.length === 0) return { ok: false, error: "No pending AI angles in the selection" };

  const dispatchConfigured = !!(process.env.GITHUB_PAT && process.env.GITHUB_RUNNER_REPO);
  const rows = targets.map((a) => ({
    type: "tryon",
    design_id: a.design_id,
    angle_id: a.id,
    params: {},
    requested_by: staff.email,
    log: dispatchConfigured ? "" : "No hosted runner yet (ANSH-04) — run locally: python3 pipeline/runner.py --job <this id>",
  }));
  const { data: jobs, error } = await admin.from("pipeline_jobs").insert(rows).select("id");
  if (error) return { ok: false, error: error.message };
  if (dispatchConfigured) {
    for (const j of jobs ?? []) {
      fetch(`https://api.github.com/repos/${process.env.GITHUB_RUNNER_REPO}/actions/workflows/pipeline-runner.yml/dispatches`, {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.GITHUB_PAT}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
        body: JSON.stringify({ ref: process.env.GITHUB_RUNNER_REF ?? "dev", inputs: { job_id: j.id } }),
      }).catch(() => { /* stays queued */ });
    }
  }
  revalidatePath("/admin/studio");
  return { ok: true, jobs: rows.length, credits: rows.length * CREDITS_EACH };
}

// Use-candidates preflight (formerly approve-all): the CURRENT candidate per
// angle across the selection — the confirm sheet shows these as thumbnails
// (guide §9). 17 Sep: approval no longer gates anything, so this batch is a
// promotion — each listed candidate becomes its angle's production image.
// Source rows are excluded: they already publish as the effective image, so
// promoting them would be a no-op dressed as work.
export async function approveAllPreflight(
  designIds: string[],
): Promise<{ ok: boolean; error?: string; items?: { candidateId: string; fileRef: string; label: string }[] }> {
  try {
    await requireAdmin();
  } catch {
    return { ok: false, error: "Not authorized" };
  }
  const admin = createAdminClient();
  const { data: designs } = await admin.from("designs").select("id, base_sku, color").in("id", designIds.slice(0, 500));
  const byId = new Map((designs ?? []).map((d) => [d.id, `${d.base_sku}·${d.color}`]));
  const { data: angles } = await admin
    .from("design_angles")
    .select("id, design_id, angle, approved_image_id, design_images!angle_id(id, role, file_ref, status, created_at)")
    .in("design_id", designIds.slice(0, 500));
  const items: { candidateId: string; fileRef: string; label: string }[] = [];
  for (const a of angles ?? []) {
    if (a.approved_image_id) continue;
    const cands = ((a.design_images as { id: string; role: string; file_ref: string; status: string; created_at: string }[] | null) ?? [])
      .filter((c) => c.status === "active" && c.role !== "source")
      .sort((x, y) => y.created_at.localeCompare(x.created_at));
    if (cands[0]) items.push({ candidateId: cands[0].id, fileRef: cands[0].file_ref, label: `${byId.get(a.design_id) ?? "?"} ${a.angle}` });
  }
  return { ok: true, items };
}

export async function approveAllBatch(candidateIds: string[]): Promise<{ ok: boolean; error?: string; approved?: number }> {
  let staff;
  try {
    staff = await requireAdmin();
  } catch {
    return { ok: false, error: "Not authorized" };
  }
  if (candidateIds.length === 0) return { ok: false, error: "Nothing to approve" };
  const admin = createAdminClient();
  let approved = 0;
  const flippedDesigns = new Set<string>();
  for (const id of candidateIds.slice(0, 200)) {
    const { data: cand } = await admin.from("design_images").select("id, angle_id, status").eq("id", id).maybeSingle();
    if (!cand || cand.status !== "active") continue;
    const { data: angle } = await admin
      .from("design_angles")
      .select("id, design_id, approved_image_id")
      .eq("id", cand.angle_id)
      .single();
    if (!angle) continue;
    if (angle.approved_image_id) {
      await admin.from("design_images").update({ status: "active" }).eq("id", angle.approved_image_id);
    }
    await admin.from("design_images").update({ status: "active" }).eq("id", id);
    await admin.from("design_angles").update({ approved_image_id: id, updated_at: new Date().toISOString() }).eq("id", angle.id);
    flippedDesigns.add(angle.design_id);
    approved++;
  }
  // D3 once per design touched.
  for (const designId of flippedDesigns) {
    await admin.from("publish_targets").update({ state: "changes_pending" }).eq("design_id", designId).eq("state", "live");
  }
  await writeAuditEvent({ eventType: "studio_candidate_approved", staffUserId: staff.id, notes: `batch use-candidates: ${approved} promoted to production` });
  revalidatePath("/admin/studio");
  return { ok: true, approved };
}

// ---- Stage 6 batch: generate copy across a selection (§10) ----------------
// STRICT_SPEC_MODE designs are SKIPPED and reported, matching the pipeline
// principle. Capped per call to stay inside the action budget.
export async function generateCopyBatch(
  designIds: string[],
): Promise<{ ok: boolean; error?: string; generated?: number; skipped?: number; failed?: number }> {
  let staff;
  try {
    staff = await requireAdmin();
  } catch {
    return { ok: false, error: "Not authorized" };
  }
  if (designIds.length === 0) return { ok: false, error: "Nothing selected" };
  const { generateCopyForDesign } = await import("@/lib/studio/copy");
  const vocab = await loadVocab(); // one lovs read for the whole batch
  let generated = 0, skipped = 0, failed = 0;
  for (const id of designIds.slice(0, 10)) {
    const res = await generateCopyForDesign(id, staff.email, { vocab });
    if (res.ok) generated++;
    else if (res.skipped) skipped++;
    else failed++;
  }
  revalidatePath("/admin/studio");
  return { ok: true, generated, skipped, failed };
}

// ---- Stage 7 batch: push wholesale across a selection ----------------------
export async function pushWholesaleBatch(
  designIds: string[],
): Promise<{ ok: boolean; error?: string; pushed?: number; blocked?: number; failed?: number }> {
  let staff;
  try {
    staff = await requireAdmin();
  } catch {
    return { ok: false, error: "Not authorized" };
  }
  if (designIds.length === 0) return { ok: false, error: "Nothing selected" };
  const { publishWholesale } = await import("@/lib/studio/publish");
  let pushed = 0, blocked = 0, failed = 0;
  for (const id of designIds.slice(0, 20)) {
    const res = await publishWholesale(id, staff.id, staff.email);
    if (res.ok) pushed++;
    else if (res.blockers) blocked++;
    else failed++;
  }
  revalidatePath("/admin/studio");
  return { ok: true, pushed, blocked, failed };
}

/**
 * Bulk push to Shopify (Ansh, 21 Sep: "filter the ready orders from top, bulk
 * generate their copies, bulk push to wholesale portal and Shopify").
 *
 * The board already had multiselect, bulk copy and bulk wholesale — Shopify
 * was the one route that had to be done a design at a time.
 *
 * Capped at 20 like its wholesale twin, and SEQUENTIAL on purpose: each push
 * is a productSet round trip against one store, and Shopify rate-limits by
 * cost. A design that is not ready is reported as blocked, never skipped
 * silently — the count is what tells the operator to go look.
 */
export async function pushShopifyBatch(
  designIds: string[],
): Promise<{ ok: boolean; error?: string; pushed?: number; blocked?: number; failed?: number; firstError?: string }> {
  let staff;
  try {
    staff = await requireAdmin();
  } catch {
    return { ok: false, error: "Not authorized" };
  }
  if (designIds.length === 0) return { ok: false, error: "Nothing selected" };
  const { publishShopify, shopifyEnabled } = await import("@/lib/shopify");
  if (!shopifyEnabled()) return { ok: false, error: "Shopify is not connected — set SHOPIFY_ENABLED." };

  let pushed = 0, blocked = 0, failed = 0;
  let firstError: string | undefined;
  for (const id of designIds.slice(0, 20)) {
    const res = await publishShopify(id, staff.id, staff.email);
    if (res.ok) pushed++;
    else if (res.blockers) blocked++;
    else {
      failed++;
      // Surface ONE reason. A bare "3 failed" sends the operator hunting
      // through twenty designs for a cause the server already knew.
      if (!firstError) firstError = res.error;
    }
  }
  revalidatePath("/admin/studio");
  return { ok: true, pushed, blocked, failed, ...(firstError ? { firstError } : {}) };
}

/**
 * Take a live design back off a portal (Ansh, 22 Sep).
 *
 * Deliberately one design at a time and not part of the batch bar. The batch
 * buttons put things OUT; a control that silently withdrew twenty products
 * from sale on one click belongs nowhere near them.
 */
export async function unpublishDesign(
  designId: string,
  portal: "wholesale" | "shopify",
): Promise<{ ok: boolean; error?: string }> {
  let staff;
  try {
    staff = await requireAdmin();
  } catch {
    return { ok: false, error: "Not authorized" };
  }
  const { unpublish } = await import("@/lib/studio/publish");
  const res = await unpublish(designId, portal, staff.id, staff.email);
  revalidatePath("/admin/studio");
  revalidatePath(`/admin/studio/${designId}`);
  return { ok: res.ok, ...(res.error ? { error: res.error } : {}) };
}

/**
 * The variant SKUs behind a selection of board rows, for bulk tag printing
 * (Ansh, 22 Sep: "an option to select multiple designs and print tags in the
 * studio").
 *
 * A board row is a (base, colour) GROUP; a tag is printed per size SKU, so the
 * one thing the board cannot answer for itself is which sizes exist. Resolved
 * from sku_registry rather than wholesale_products: the registry is what a
 * minted SKU is recorded in, and a garment can have a tag printed before its
 * catalog row carries a price or has been pushed anywhere.
 */
export async function traySkusForDesigns(
  designIds: string[],
): Promise<{ ok: boolean; error?: string; skus?: string[]; groups?: number; missing?: string[] }> {
  try {
    await requireStaff();
  } catch {
    return { ok: false, error: "Not authorized" };
  }
  if (designIds.length === 0) return { ok: false, error: "Nothing selected" };
  const admin = createAdminClient();

  const { data: designs, error } = await admin
    .from("designs")
    .select("id, base_sku, color")
    .in("id", designIds.slice(0, 200));
  if (error) return { ok: false, error: error.message };
  if (!designs?.length) return { ok: false, error: "No designs found" };

  // One query for every base in the selection, then filtered on the colour
  // suffix in memory. Chained .like() on the same column is unreliable through
  // PostgREST, and a per-design round trip would be 100+ queries.
  const bases = [...new Set(designs.map((d) => d.base_sku.toUpperCase()))];
  const rows: { variant_sku: string }[] = [];
  const CHUNK = 25;
  for (let i = 0; i < bases.length; i += CHUNK) {
    const ors = bases.slice(i, i + CHUNK).map((b) => `variant_sku.ilike.${b}-%`).join(",");
    const { data, error: rErr } = await admin.from("sku_registry").select("variant_sku").or(ors).range(0, 9999);
    if (rErr) return { ok: false, error: rErr.message };
    rows.push(...(data ?? []));
  }

  const wanted = new Set(designs.map((d) => `${d.base_sku.toUpperCase()}|${d.color.toUpperCase()}`));
  const skus: string[] = [];
  const seenGroups = new Set<string>();
  for (const r of rows) {
    const parts = r.variant_sku.toUpperCase().split("-");
    if (parts.length < 5) continue;
    const key = `${parts.slice(0, 4).join("-")}|${parts[parts.length - 1]}`;
    if (!wanted.has(key)) continue;
    skus.push(r.variant_sku.toUpperCase());
    seenGroups.add(key);
  }

  // Named, not just counted: "3 designs have no SKUs" sends someone hunting
  // through the selection.
  const missing = designs
    .filter((d) => !seenGroups.has(`${d.base_sku.toUpperCase()}|${d.color.toUpperCase()}`))
    .map((d) => `${d.base_sku}·${d.color}`);

  return { ok: true, skus: [...new Set(skus)].sort(), groups: seenGroups.size, missing };
}
