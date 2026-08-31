"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/staff";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAuditEvent } from "@/lib/audit";
import { defaultAnglePrompt } from "@/lib/studio/prompts";
import { engineConfigured } from "@/lib/pipeline/engines";
import { COPY_MODELS } from "@/lib/studio/copy-models";
import { DETAIL_ANGLES } from "@/lib/studio/state";

// Workbench actions (build guide §9). Every mutation is admin+, audit-logged
// where the guide requires, and enforces D1 (history, single approved),
// D3 (live → changes_pending on change), D4 (engine set), D5 (details raw-only).

type Res = { ok: boolean; error?: string };

function fail(error: string): Res {
  return { ok: false, error };
}

// D3: any change to a live design's approved set flips that portal to
// changes_pending with a visible Re-push (never a silent update).
async function flipLiveTargets(designId: string) {
  const admin = createAdminClient();
  await admin
    .from("publish_targets")
    .update({ state: "changes_pending" })
    .eq("design_id", designId)
    .eq("state", "live");
}

export async function approveCandidate(candidateId: string): Promise<Res> {
  let staff;
  try { staff = await requireAdmin(); } catch { return fail("Not authorized"); }
  const admin = createAdminClient();

  const { data: cand } = await admin
    .from("design_images")
    .select("id, angle_id, status")
    .eq("id", candidateId)
    .maybeSingle();
  if (!cand) return fail("Candidate not found");
  const { data: angle } = await admin
    .from("design_angles")
    .select("id, design_id, approved_image_id")
    .eq("id", cand.angle_id)
    .single();
  if (!angle) return fail("Angle not found");

  // D1: approving any candidate demotes the previously-approved one.
  if (angle.approved_image_id && angle.approved_image_id !== candidateId) {
    await admin.from("design_images").update({ status: "active" }).eq("id", angle.approved_image_id);
  }
  const { error: e1 } = await admin.from("design_images").update({ status: "active" }).eq("id", candidateId);
  if (e1) return fail(e1.message);
  const { error: e2 } = await admin
    .from("design_angles")
    .update({ approved_image_id: candidateId, updated_at: new Date().toISOString() })
    .eq("id", angle.id);
  if (e2) return fail(e2.message);

  await flipLiveTargets(angle.design_id);
  await writeAuditEvent({ eventType: "studio_candidate_approved", staffUserId: staff.id, notes: `candidate ${candidateId} on angle ${angle.id}` });
  revalidatePath(`/admin/studio/${angle.design_id}`);
  revalidatePath("/admin/studio");
  return { ok: true };
}

export async function rejectCandidate(candidateId: string): Promise<Res> {
  let staff;
  try { staff = await requireAdmin(); } catch { return fail("Not authorized"); }
  const admin = createAdminClient();
  const { data: cand } = await admin
    .from("design_images")
    .select("id, angle_id")
    .eq("id", candidateId)
    .maybeSingle();
  if (!cand) return fail("Candidate not found");
  const { data: angle } = await admin
    .from("design_angles")
    .select("id, design_id, approved_image_id")
    .eq("id", cand.angle_id)
    .single();
  if (!angle) return fail("Angle not found");

  const { error } = await admin.from("design_images").update({ status: "rejected" }).eq("id", candidateId);
  if (error) return fail(error.message);
  if (angle.approved_image_id === candidateId) {
    await admin.from("design_angles").update({ approved_image_id: null }).eq("id", angle.id);
    await flipLiveTargets(angle.design_id); // the live set just lost a photo
  }
  await writeAuditEvent({ eventType: "studio_candidate_rejected", staffUserId: staff.id, notes: `candidate ${candidateId} on angle ${angle.id}` });
  revalidatePath(`/admin/studio/${angle.design_id}`);
  revalidatePath("/admin/studio");
  return { ok: true };
}

// Detail/macro cards (and raw-engine angles): approve the SOURCE as-is —
// registers a raw candidate over source_ref and approves it (D5 fidelity).
export async function approveAsIs(angleId: string): Promise<Res> {
  let staff;
  try { staff = await requireAdmin(); } catch { return fail("Not authorized"); }
  const admin = createAdminClient();
  const { data: angle } = await admin
    .from("design_angles")
    .select("id, design_id, source_ref, source_image_id, approved_image_id")
    .eq("id", angleId)
    .maybeSingle();
  if (!angle) return fail("Angle not found");
  if (!angle.source_ref) return fail("No source image on this angle yet");

  // Post-0022 the source is already a design_images row — approve it in place
  // rather than minting a duplicate (§7.5).
  if (angle.source_image_id) {
    if (angle.approved_image_id && angle.approved_image_id !== angle.source_image_id) {
      await admin.from("design_images").update({ status: "archived" }).eq("id", angle.approved_image_id);
    }
    await admin.from("design_angles").update({ approved_image_id: angle.source_image_id, updated_at: new Date().toISOString() }).eq("id", angleId);
    await admin.from("publish_targets").update({ state: "changes_pending" }).eq("design_id", angle.design_id).eq("state", "live");
    await writeAuditEvent({ eventType: "studio_candidate_approved", staffUserId: staff.id, notes: `approve-as-is angle ${angleId}` });
    revalidatePath(`/admin/studio/${angle.design_id}`);
    revalidatePath("/admin/studio");
    return { ok: true };
  }

  const { data: cand, error } = await admin
    .from("design_images")
    .insert({ design_id: angle.design_id, angle_id: angleId, role: "source", engine: "raw", file_ref: angle.source_ref, status: "active", created_by: staff.email })
    .select("id")
    .single();
  if (error) return fail(error.message);
  if (angle.approved_image_id) {
    await admin.from("design_images").update({ status: "active" }).eq("id", angle.approved_image_id);
  }
  await admin.from("design_angles").update({ approved_image_id: cand.id, updated_at: new Date().toISOString() }).eq("id", angleId);
  await flipLiveTargets(angle.design_id);
  await writeAuditEvent({ eventType: "studio_candidate_approved", staffUserId: staff.id, notes: `approve-as-is on angle ${angleId}` });
  revalidatePath(`/admin/studio/${angle.design_id}`);
  return { ok: true };
}

export async function setAnglePrompt(angleId: string, prompt: string): Promise<Res> {
  try { await requireAdmin(); } catch { return fail("Not authorized"); }
  const admin = createAdminClient();
  const { error } = await admin
    .from("design_angles")
    .update({ prompt, prompt_edited_by_human: true, updated_at: new Date().toISOString() })
    .eq("id", angleId);
  return error ? fail(error.message) : { ok: true };
}

export async function setAngleEngine(angleId: string, engine: "fashn" | "seedream" | "openai_bg" | "raw"): Promise<Res> {
  try { await requireAdmin(); } catch { return fail("Not authorized"); }
  const admin = createAdminClient();
  const { data: angle } = await admin.from("design_angles").select("angle").eq("id", angleId).maybeSingle();
  if (!angle) return fail("Angle not found");
  if ((DETAIL_ANGLES as readonly string[]).includes(angle.angle) && engine !== "raw") {
    return fail("Detail angles are raw-only (D5)");
  }
  const { error } = await admin.from("design_angles").update({ engine, updated_at: new Date().toISOString() }).eq("id", angleId);
  return error ? fail(error.message) : { ok: true };
}

// Regen = one pipeline job for this angle's engine. Prompt respect (§8.2):
// a human-edited prompt is never regenerated over unless params.force.
export async function regenAngle(angleId: string): Promise<Res & { jobId?: string }> {
  let staff;
  try { staff = await requireAdmin(); } catch { return fail("Not authorized"); }
  const admin = createAdminClient();
  const { data: angle } = await admin
    .from("design_angles")
    .select("id, design_id, angle, engine, source_ref, prompt")
    .eq("id", angleId)
    .maybeSingle();
  if (!angle) return fail("Angle not found");
  if ((DETAIL_ANGLES as readonly string[]).includes(angle.angle)) return fail("Detail angles are raw-only (D5)");
  if (angle.engine === "raw") return fail("Raw angles use Approve as-is — nothing to generate");
  {
    // UX sprint — engines run in-process now; the only gate is a key.
    const conf = engineConfigured(angle.engine as "fashn" | "seedream" | "openai_bg");
    if (!conf.ok) return fail(`${angle.engine} needs ${conf.missing} in the environment`);
  }
  if (!angle.source_ref) return fail("No source image on this angle yet");

  const { data: dRow } = await admin
    .from("designs")
    .select("title, category, sub_category, color, fabric, handwork, brand_model")
    .eq("id", angle.design_id)
    .maybeSingle();
  const promptDesign = {
    title: dRow?.title, category: dRow?.category, subCategory: dRow?.sub_category,
    color: dRow?.color, fabric: dRow?.fabric, handwork: dRow?.handwork,
  };

  // A server death mid-generation would strand the job in running forever
  // and permanently hide the Generate button — sweep anything older than 15m.
  await admin
    .from("pipeline_jobs")
    .update({ status: "error", log: "Timed out — the in-process run never finished (server restarted?)", finished_at: new Date().toISOString() })
    .in("status", ["claimed", "running"])
    .lt("started_at", new Date(Date.now() - 15 * 60_000).toISOString());

  const dispatchConfigured = !!(process.env.GITHUB_PAT && process.env.GITHUB_RUNNER_REPO);
  const { data: job, error } = await admin
    .from("pipeline_jobs")
    .insert({
      type: angle.engine === "openai_bg" ? "openai_bg" : angle.engine === "seedream" ? "seedream" : "tryon",
      design_id: angle.design_id,
      angle_id: angle.id,
      // The runner needs the prompt the operator actually saw (§7.1).
      // prompt defaults to '' (0016) — trim-check, or the engines get an empty prompt.
      params: { prompt: angle.prompt?.trim() ? angle.prompt : defaultAnglePrompt(angle.angle, angle.engine, promptDesign), angle: angle.angle, engine: angle.engine, brandModel: dRow?.brand_model ?? null },
      requested_by: staff.email,
      log: "",
    })
    .select("id")
    .single();
  if (error) return fail(error.message);

  if (dispatchConfigured) {
    fetch(`https://api.github.com/repos/${process.env.GITHUB_RUNNER_REPO}/actions/workflows/pipeline-runner.yml/dispatches`, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.GITHUB_PAT}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
      body: JSON.stringify({ ref: process.env.GITHUB_RUNNER_REF ?? "dev", inputs: { job_id: job.id } }),
    }).catch(() => { /* job stays queued; ticker shows it */ });
  }
  revalidatePath(`/admin/studio/${angle.design_id}`);
  return { ok: true, jobId: job.id };
}

// ---- Stage 6: copy track (§10) -------------------------------------------

export async function generateCopy(designId: string): Promise<Res> {
  let staff;
  try { staff = await requireAdmin(); } catch { return fail("Not authorized"); }
  const { generateCopyForDesign } = await import("@/lib/studio/copy");
  const res = await generateCopyForDesign(designId, staff.email);
  if (!res.ok) return fail(res.error ?? "Generation failed");
  revalidatePath(`/admin/studio/${designId}`);
  revalidatePath("/admin/studio");
  return { ok: true };
}

// Inline edit saves an edited DRAFT; editing after approval reverts to draft
// and (D3) flips live portals to changes_pending.
export async function saveCopyEdit(
  designId: string,
  patch: { title: string; description: string; tags: Record<string, string> },
): Promise<Res> {
  let staff;
  try { staff = await requireAdmin(); } catch { return fail("Not authorized"); }
  const admin = createAdminClient();
  const { data: existing } = await admin.from("design_copy").select("status").eq("design_id", designId).maybeSingle();
  const wasApproved = existing?.status === "approved";
  const { error } = await admin.from("design_copy").upsert(
    {
      design_id: designId,
      title: patch.title.slice(0, 60),
      description: patch.description,
      tags: patch.tags,
      status: "draft",
      edited_by: staff.email,
      approved_by: null,
      approved_at: null,
    },
    { onConflict: "design_id" },
  );
  if (error) return fail(error.message);
  if (wasApproved) {
    await admin.from("publish_targets").update({ state: "changes_pending" }).eq("design_id", designId).eq("state", "live");
  }
  revalidatePath(`/admin/studio/${designId}`);
  revalidatePath("/admin/studio");
  return { ok: true };
}

// Approval changes READINESS only (D2 — no auto-push).
export async function approveCopy(designId: string): Promise<Res> {
  let staff;
  try { staff = await requireAdmin(); } catch { return fail("Not authorized"); }
  const admin = createAdminClient();
  const { data: row } = await admin.from("design_copy").select("status").eq("design_id", designId).maybeSingle();
  if (!row || row.status === "none") return fail("No copy draft to approve");
  const { error } = await admin
    .from("design_copy")
    .update({ status: "active", approved_by: staff.email, approved_at: new Date().toISOString() })
    .eq("design_id", designId);
  if (error) return fail(error.message);
  revalidatePath(`/admin/studio/${designId}`);
  revalidatePath("/admin/studio");
  return { ok: true };
}

// ---- Stage 7: publish (§11) -----------------------------------------------

export async function pushWholesale(designId: string): Promise<Res & { blockers?: string[] }> {
  let staff;
  try { staff = await requireAdmin(); } catch { return fail("Not authorized"); }
  const { publishWholesale } = await import("@/lib/studio/publish");
  const res = await publishWholesale(designId, staff.id, staff.email);
  if (!res.ok) return { ok: false, error: res.error, blockers: res.blockers };
  revalidatePath(`/admin/studio/${designId}`);
  revalidatePath("/admin/studio");
  revalidatePath("/catalog");
  return { ok: true };
}

export async function pushShopify(designId: string): Promise<Res & { blockers?: string[] }> {
  let staff;
  try { staff = await requireAdmin(); } catch { return fail("Not authorized"); }
  const { publishShopify } = await import("@/lib/shopify");
  const res = await publishShopify(designId, staff.id, staff.email);
  if (!res.ok) return { ok: false, error: res.error, blockers: res.blockers };
  revalidatePath(`/admin/studio/${designId}`);
  revalidatePath("/admin/studio");
  return { ok: true };
}

/** R6 §8 — persist the vision prompt for this design. Empty restores the spec-built default. */
export async function setCopyPrompt(designId: string, prompt: string): Promise<Res> {
  let staff;
  try { staff = await requireAdmin(); } catch { return fail("Not authorized"); }
  const admin = createAdminClient();
  const value = prompt.trim() ? prompt : null;
  const { error } = await admin
    .from("design_copy")
    .upsert({ design_id: designId, prompt: value, prompt_edited_by: value ? staff.email : null }, { onConflict: "design_id" });
  if (error) return fail(error.message);
  revalidatePath(`/admin/studio/${designId}`);
  return { ok: true };
}

/** R6 §8 — pick the copy model. Empty restores the tier default. */
export async function setCopyModel(designId: string, model: string): Promise<Res> {
  try { await requireAdmin(); } catch { return fail("Not authorized"); }
  if (model && !COPY_MODELS.some((m) => m.id === model)) return fail("Unknown model");
  const admin = createAdminClient();
  const { error } = await admin
    .from("design_copy")
    .upsert({ design_id: designId, model_override: model || null }, { onConflict: "design_id" });
  if (error) return fail(error.message);
  revalidatePath(`/admin/studio/${designId}`);
  return { ok: true };
}

/** Ansh's plan §3 — which brand model fronts this design's FASHN try-ons. */
export async function setBrandModel(designId: string, model: string): Promise<Res> {
  let staff;
  try { staff = await requireAdmin(); } catch { return fail("Not authorized"); }
  const admin = createAdminClient();
  const { error } = await admin.from("designs").update({ brand_model: model || null }).eq("id", designId);
  if (error) return fail(error.message);
  await writeAuditEvent({ eventType: "catalog_edit", staffUserId: staff.id, notes: `brand model → ${model || "(default)"} on design ${designId}` });
  revalidatePath(`/admin/studio/${designId}`);
  return { ok: true };
}
