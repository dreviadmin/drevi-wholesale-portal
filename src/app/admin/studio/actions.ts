"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin, requireStaff } from "@/lib/staff";
import { createAdminClient } from "@/lib/supabase/admin";
import { syncCatalogFrontQuietly } from "@/lib/studio/catalog-front";
import { writeAuditEvent } from "@/lib/audit";
import { DETAIL_ANGLES } from "@/lib/studio/state";
import { loadVocab } from "@/lib/sku/vocab-live";
import { fashnEnabled } from "@/lib/pipeline/engines";
import { inRuns } from "@/lib/chunk";

// Stage 3's two LIVE batch actions (§7.4). Spend/push actions arrive with
// Stages 4–7 — their buttons render disabled until then.

// A selection goes to the database in runs (chunk.ts) rather than one .in()
// list: a few hundred UUIDs in one URL risks a 414, and a read of several rows
// per design can pass the 1,000-row cap. Every selected design is acted on;
// past the sanity cap the action says so instead of quietly doing part.
const WRITE_RUN = 150;
const READ_RUN = 100; // six angles a design, so a run reads at most 600 angle rows
const BATCH_CAP = 2000;
const overCap = (ids: string[]) =>
  ids.length > BATCH_CAP ? `Select at most ${BATCH_CAP.toLocaleString("en-IN")} designs at a time.` : null;

export async function setTierBatch(designIds: string[], tier: "standard" | "hero"): Promise<{ ok: boolean; error?: string }> {
  let staff;
  try {
    staff = await requireAdmin();
  } catch {
    return { ok: false, error: "Not authorized" };
  }
  if (designIds.length === 0) return { ok: false, error: "Nothing selected" };
  const capErr = overCap(designIds);
  if (capErr) return { ok: false, error: capErr };
  const admin = createAdminClient();
  const updatedAt = new Date().toISOString();
  const { error, done } = await inRuns(designIds, WRITE_RUN, (ids) => admin.from("designs").update({ tier, updated_at: updatedAt }).in("id", ids));
  if (error && done === 0) return { ok: false, error: error.message };
  await writeAuditEvent({
    eventType: "studio_tier_set",
    staffUserId: staff.id,
    notes: `tier=${tier} on ${error ? `${done} of ${designIds.length}` : designIds.length} design(s)${error ? `, then failed: ${error.message}` : ""}`,
  });
  if (error) {
    revalidatePath("/admin/studio");
    return { ok: false, error: `Set on ${done} of ${designIds.length} designs, then: ${error.message}` };
  }
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
  const capErr = overCap(designIds);
  if (capErr) return { ok: false, error: capErr };
  const admin = createAdminClient();
  const { error, done } = await inRuns(designIds, WRITE_RUN, (ids) =>
    admin.from("publish_targets").update({ enabled }).eq("portal", portal).in("design_id", ids),
  );
  if (error && done === 0) return { ok: false, error: error.message };
  await writeAuditEvent({
    eventType: "studio_portal_toggled",
    staffUserId: staff.id,
    notes: `${portal} ${enabled ? "enabled" : "disabled"} on ${error ? `${done} of ${designIds.length}` : designIds.length} design(s)${error ? `, then failed: ${error.message}` : ""}`,
  });
  if (error) {
    revalidatePath("/admin/studio");
    return { ok: false, error: `Changed on ${done} of ${designIds.length} designs, then: ${error.message}` };
  }
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
  // Parked (FASHN_ENABLED, default off) — the board draws this button disabled,
  // and the action refuses too rather than queue tryon jobs nothing will run.
  if (!fashnEnabled()) return { ok: false, error: "Model swap is parked — set FASHN_ENABLED=true to bring it back" };
  const capErr = overCap(designIds);
  if (capErr) return { ok: false, error: capErr };
  const admin = createAdminClient();
  const [{ data: angles, error: anglesErr }, { data: activeJobs }] = await Promise.all([
    inRuns(designIds, READ_RUN, (ids) =>
      admin
        .from("design_angles")
        .select("id, design_id, angle, engine, source_ref, approved_image_id")
        .in("design_id", ids),
    ),
    admin.from("pipeline_jobs").select("angle_id").in("status", ["queued", "claimed", "running"]),
  ]);
  // A lost run would undercount the jobs and the credits on the confirm sheet.
  if (anglesErr) return { ok: false, error: anglesErr.message };
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
  const capErr = overCap(designIds);
  if (capErr) return { ok: false, error: capErr };
  const admin = createAdminClient();
  const { data: designs, error: designsErr } = await inRuns(designIds, READ_RUN, (ids) =>
    admin.from("designs").select("id, base_sku, color").in("id", ids),
  );
  if (designsErr) return { ok: false, error: designsErr.message };
  const byId = new Map(designs.map((d) => [d.id, `${d.base_sku}·${d.color}`]));
  const { data: angles, error: anglesErr } = await inRuns(designIds, READ_RUN, (ids) =>
    admin
      .from("design_angles")
      .select("id, design_id, angle, approved_image_id, design_images!angle_id(id, role, file_ref, status, created_at)")
      .in("design_id", ids),
  );
  // A lost run would leave candidates off the confirm sheet with nothing saying so.
  if (anglesErr) return { ok: false, error: anglesErr.message };
  const items: { candidateId: string; fileRef: string; label: string }[] = [];
  for (const a of angles) {
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
    await admin.from("publish_targets").update({ state: "changes_pending" }).eq("design_id", designId).eq("state", "live");    await syncCatalogFrontQuietly(designId);
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
  const capErr = overCap(designIds);
  if (capErr) return { ok: false, error: capErr };
  const admin = createAdminClient();

  const { data: designs, error } = await inRuns(designIds, READ_RUN, (ids) =>
    admin.from("designs").select("id, base_sku, color").in("id", ids),
  );
  if (error) return { ok: false, error: error.message };
  if (!designs.length) return { ok: false, error: "No designs found" };

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

/**
 * Retire a product, or bring it back (Ansh, 22 Sep).
 *
 * `discontinued_at` is a stamp rather than a boolean, so the row still answers
 * who retired it and when — the questions anyone actually asks six months
 * later. Clearing the stamp is the restore.
 *
 * It ALSO takes the product out of the buyer catalog, because a product
 * announced as discontinued that buyers can still order is a promise nobody
 * meant to make. It does NOT touch wholesale_visible: a retired garment still
 * hanging in the showroom stays sellable at the counter, the same separation
 * 0062 drew. Restoring does not put it back in the catalog either — that is a
 * Studio push, and it should be a decision rather than a side effect. The
 * wholesale target says so: a live or changes-pending target goes to 'ready',
 * so after Restore the Wholesale card offers Push wholesale instead of
 * claiming the product is still out there.
 *
 * SHOPIFY IS TAKEN DOWN TOO (Ansh, 23 Sep, answering exactly that question),
 * and since 31 Oct it goes to ARCHIVED rather than DRAFT: "send the product to
 * archive on shopify instead of moving to draft only". It reuses unpublish()
 * rather than duplicating the mutation, so the target state, the audit line and
 * the error path stay in one place.
 *
 * Order matters. The Shopify call goes FIRST, because it is the step that can
 * fail and it is idempotent — archiving a product twice is the same as once, so
 * a retry after a dropped response is safe. The local writes follow and
 * effectively cannot fail.
 *
 * A Shopify failure does NOT block the retirement. Being unable to retire a
 * garment because Shopify is having a bad afternoon is the worse outcome, and
 * the half-state is made loud rather than hidden: the result carries
 * shopifyError, the caller says so, and publish_targets keeps its own error so
 * the Shopify panel shows it with the retry sitting right there.
 *
 * RESTORING takes the product out of archive, back to DRAFT. A push cannot do
 * it (status is only sent on create), so without this a restored garment would
 * stay archived through every later push with nothing on screen saying so. Here
 * a Shopify failure DOES stop the restore: its status is unknown, carrying on
 * could leave it in the archive with nothing saying so, and trying again is one
 * tap.
 */
export async function setDiscontinued(
  designId: string,
  discontinued: boolean,
  note?: string,
): Promise<{ ok: boolean; error?: string; hiddenSkus?: number; shopifyArchived?: boolean; shopifyUnarchived?: boolean; shopifyError?: string; catalogError?: string }> {
  let staff;
  try {
    staff = await requireAdmin();
  } catch {
    return { ok: false, error: "Not authorized" };
  }
  const admin = createAdminClient();

  const { data: design } = await admin
    .from("designs")
    .select("id, base_sku, color, discontinued_at")
    .eq("id", designId)
    .maybeSingle();
  if (!design) return { ok: false, error: "Design not found" };
  if (discontinued && design.discontinued_at) return { ok: false, error: "Already discontinued" };
  if (!discontinued && !design.discontinued_at) return { ok: false, error: "This product is not discontinued" };

  // Shopify first — see the note above on ordering. Gated on a product EXISTING,
  // not on the mirrored state. publish_targets drifts — going live from DRAFT is
  // a human act in Shopify admin that never writes back here — so trusting the
  // state would silently skip the take-down on a product that is genuinely on
  // sale.
  const { data: sh, error: shErr } = await admin
    .from("publish_targets")
    .select("remote_id")
    .eq("design_id", designId)
    .eq("portal", "shopify")
    .maybeSingle();
  // Unknown is not the same as no product: going on would skip Shopify in silence.
  if (shErr) return { ok: false, error: "Could not check Shopify. Try again." };
  let shopifyArchived = false;
  let shopifyUnarchived = false;
  let shopifyError: string | undefined;
  if (sh?.remote_id && discontinued) {
    const { unpublish } = await import("@/lib/studio/publish");
    const res = await unpublish(designId, "shopify", staff.id, staff.email, { force: true, archive: true });
    if (res.ok) shopifyArchived = !res.gone;
    else shopifyError = res.error ?? "Shopify archive failed";
  } else if (sh?.remote_id) {
    const { unarchiveShopifyProduct } = await import("@/lib/shopify");
    try {
      shopifyUnarchived = await unarchiveShopifyProduct(sh.remote_id);
    } catch (err) {
      await writeAuditEvent({
        eventType: "catalog_edit",
        staffUserId: staff.id,
        notes: `RESTORE FAILED ${design.base_sku}·${design.color} by ${staff.email}: ${(err as Error).message}`,
      });
      return { ok: false, error: "Not restored: could not update this product in Shopify. Try again." };
    }
  }

  const { error } = await admin
    .from("designs")
    .update(
      discontinued
        ? { discontinued_at: new Date().toISOString(), discontinued_by: staff.email, discontinued_note: note?.trim() || null }
        : { discontinued_at: null, discontinued_by: null, discontinued_note: null },
    )
    .eq("id", designId);
  if (error) return { ok: false, error: error.message };

  let hiddenSkus = 0;
  let catalogError: string | undefined;
  if (discontinued) {
    const { data: variants, error: readErr } = await admin
      .from("wholesale_products")
      .select("sku")
      .like("sku", `${design.base_sku}-%`);
    if (readErr) catalogError = readErr.message;
    const skus = (variants ?? [])
      .map((v) => v.sku)
      .filter((s) => s.toUpperCase().endsWith(`-${design.color.toUpperCase()}`));
    if (!catalogError && skus.length) {
      const { error: hideErr } = await admin.from("wholesale_products").update({ buyer_visible: false }).in("sku", skus);
      if (hideErr) catalogError = hideErr.message;
      else hiddenSkus = skus.length;
    }
    // And say so on the target, the way unpublish() does: left at 'live', the
    // board read "Live · WS" for a garment buyers cannot see, and after Restore
    // nobody pushed it back because the badge claimed it was already out there.
    // Only once the hide has worked, though: over sizes buyers can still see,
    // 'live' is the truth, and it keeps Unpublish wholesale on the card — the
    // Studio's way to take the product down (unpublish() hides with its own
    // error checks).
    if (!catalogError) {
      await admin
        .from("publish_targets")
        .update({ state: "ready", error: null })
        .eq("design_id", designId)
        .eq("portal", "wholesale")
        .in("state", ["live", "changes_pending"]);
    }
  } else {
    // Restore never puts the product back in the catalog, so the Wholesale
    // card must not say Live over hidden rows. A product retired before the
    // reset above existed still carries 'live' from then; it is corrected here,
    // and only when no size of it is in the buyer catalog (a size shown again
    // by hand in Manage Catalog keeps the target as it is). An unreadable
    // catalog changes nothing.
    const { data: shown, error: shownErr } = await admin
      .from("wholesale_products")
      .select("sku")
      .like("sku", `${design.base_sku}-%`)
      .eq("buyer_visible", true);
    const anyShown = (shown ?? []).some((v) => v.sku.toUpperCase().endsWith(`-${design.color.toUpperCase()}`));
    if (!shownErr && !anyShown) {
      await admin
        .from("publish_targets")
        .update({ state: "ready", error: null })
        .eq("design_id", designId)
        .eq("portal", "wholesale")
        .in("state", ["live", "changes_pending"]);
    }
  }

  await writeAuditEvent({
    eventType: "catalog_edit",
    staffUserId: staff.id,
    notes: discontinued
      ? `DISCONTINUED ${design.base_sku}·${design.color} by ${staff.email}${note?.trim() ? ` — ${note.trim()}` : ""}` +
        `${hiddenSkus ? ` (${hiddenSkus} variant(s) out of the catalog)` : ""}` +
        `${catalogError ? `, CATALOG NOT HIDDEN: ${catalogError}` : ""}` +
        `${shopifyArchived ? ", Shopify set to ARCHIVED" : ""}${shopifyError ? `, SHOPIFY NOT ARCHIVED: ${shopifyError}` : ""}`
      : `RESTORED ${design.base_sku}·${design.color} by ${staff.email}${shopifyUnarchived ? ", Shopify back to DRAFT" : ""}`,
  });

  revalidatePath("/admin/studio");
  revalidatePath(`/admin/studio/${designId}`);
  revalidatePath(`/admin/studio/master/${designId}`);
  return { ok: true, hiddenSkus, shopifyArchived, shopifyUnarchived, ...(shopifyError ? { shopifyError } : {}), ...(catalogError ? { catalogError } : {}) };
}

/**
 * Bulk discontinue / restore (Ansh, 23 Sep).
 *
 * Capped at 12, well under the per-design cap the other bulk routes use,
 * because discontinuing now makes a Shopify call for every design that is
 * live there — the board chunks a larger selection the same way it chunks
 * copy generation.
 *
 * Failures are counted and the FIRST is named. "3 failed" on its own sends the
 * operator hunting through twelve designs, and the failure that matters here
 * is specifically "not archived in Shopify", which needs a name to act on.
 */
export async function setDiscontinuedBatch(
  designIds: string[],
  discontinued: boolean,
): Promise<{
  ok: boolean; error?: string;
  done?: number; skipped?: number; failed?: number;
  shopifyArchived?: number; shopifyUnarchived?: number; shopifyStuck?: number; catalogStuck?: number; firstError?: string;
}> {
  try {
    await requireAdmin();
  } catch {
    return { ok: false, error: "Not authorized" };
  }
  if (designIds.length === 0) return { ok: false, error: "Nothing selected" };

  let done = 0, skipped = 0, failed = 0, shopifyArchived = 0, shopifyUnarchived = 0, shopifyStuck = 0, catalogStuck = 0;
  let firstError: string | undefined;
  for (const id of designIds.slice(0, 12)) {
    const res = await setDiscontinued(id, discontinued);
    if (res.ok) {
      done++;
      if (res.shopifyArchived) shopifyArchived++;
      if (res.shopifyUnarchived) shopifyUnarchived++;
      if (res.shopifyError) {
        shopifyStuck++;
        if (!firstError) firstError = res.shopifyError;
      }
      if (res.catalogError) catalogStuck++;
      continue;
    }
    // "Already discontinued" / "not discontinued" is a no-op, not a failure —
    // a selection spanning both states is ordinary when the board is showing
    // retired products alongside live ones.
    if (res.error === "Already discontinued" || res.error === "This product is not discontinued") {
      skipped++;
      continue;
    }
    failed++;
    if (!firstError) firstError = res.error;
  }

  revalidatePath("/admin/studio");
  return { ok: true, done, skipped, failed, shopifyArchived, shopifyUnarchived, shopifyStuck, catalogStuck, ...(firstError ? { firstError } : {}) };
}
