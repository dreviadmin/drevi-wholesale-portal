"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/staff";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAuditEvent } from "@/lib/audit";
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
    .from("image_candidates")
    .select("id, angle_id, status")
    .eq("id", candidateId)
    .maybeSingle();
  if (!cand) return fail("Candidate not found");
  const { data: angle } = await admin
    .from("design_angles")
    .select("id, design_id, approved_candidate_id")
    .eq("id", cand.angle_id)
    .single();
  if (!angle) return fail("Angle not found");

  // D1: approving any candidate demotes the previously-approved one.
  if (angle.approved_candidate_id && angle.approved_candidate_id !== candidateId) {
    await admin.from("image_candidates").update({ status: "generated" }).eq("id", angle.approved_candidate_id);
  }
  const { error: e1 } = await admin.from("image_candidates").update({ status: "approved" }).eq("id", candidateId);
  if (e1) return fail(e1.message);
  const { error: e2 } = await admin
    .from("design_angles")
    .update({ approved_candidate_id: candidateId, updated_at: new Date().toISOString() })
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
    .from("image_candidates")
    .select("id, angle_id")
    .eq("id", candidateId)
    .maybeSingle();
  if (!cand) return fail("Candidate not found");
  const { data: angle } = await admin
    .from("design_angles")
    .select("id, design_id, approved_candidate_id")
    .eq("id", cand.angle_id)
    .single();
  if (!angle) return fail("Angle not found");

  const { error } = await admin.from("image_candidates").update({ status: "rejected" }).eq("id", candidateId);
  if (error) return fail(error.message);
  if (angle.approved_candidate_id === candidateId) {
    await admin.from("design_angles").update({ approved_candidate_id: null }).eq("id", angle.id);
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
    .select("id, design_id, source_ref, approved_candidate_id")
    .eq("id", angleId)
    .maybeSingle();
  if (!angle) return fail("Angle not found");
  if (!angle.source_ref) return fail("No source image on this angle yet");

  const { data: cand, error } = await admin
    .from("image_candidates")
    .insert({ angle_id: angleId, engine: "raw", file_ref: angle.source_ref, status: "approved", created_by: staff.email })
    .select("id")
    .single();
  if (error) return fail(error.message);
  if (angle.approved_candidate_id) {
    await admin.from("image_candidates").update({ status: "generated" }).eq("id", angle.approved_candidate_id);
  }
  await admin.from("design_angles").update({ approved_candidate_id: cand.id, updated_at: new Date().toISOString() }).eq("id", angleId);
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

export async function setAngleEngine(angleId: string, engine: "fashn" | "openai_bg" | "raw"): Promise<Res> {
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
    .select("id, design_id, angle, engine, source_ref")
    .eq("id", angleId)
    .maybeSingle();
  if (!angle) return fail("Angle not found");
  if ((DETAIL_ANGLES as readonly string[]).includes(angle.angle)) return fail("Detail angles are raw-only (D5)");
  if (angle.engine === "raw") return fail("Raw angles use Approve as-is — nothing to generate");
  if (angle.engine === "seedream") return fail("Seedream is reserved (ANSH-10)");
  if (angle.engine === "openai_bg" && (process.env.OPENAI_BG_ENABLED ?? "").toLowerCase() !== "true") {
    return fail("Background engine is parked (ANSH-06)");
  }
  if (!angle.source_ref) return fail("No source image on this angle yet");

  const dispatchConfigured = !!(process.env.GITHUB_PAT && process.env.GITHUB_RUNNER_REPO);
  const { data: job, error } = await admin
    .from("pipeline_jobs")
    .insert({
      type: angle.engine === "openai_bg" ? "openai_bg" : "tryon",
      design_id: angle.design_id,
      angle_id: angle.id,
      params: {},
      requested_by: staff.email,
      log: dispatchConfigured ? "" : "No hosted runner yet (ANSH-04) — run locally: python3 pipeline/runner.py --job <this id>",
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
    .update({ status: "approved", approved_by: staff.email, approved_at: new Date().toISOString() })
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
