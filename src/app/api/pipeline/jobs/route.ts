import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/staff";
import { createAdminClient } from "@/lib/supabase/admin";
import { DETAIL_ANGLES } from "@/lib/studio/state";

export const dynamic = "force-dynamic";

const TYPES = ["preprocess", "vision", "tryon", "openai_bg", "scan_drive", "copy"] as const;
const AI_ENGINE_TYPES = new Set(["tryon", "openai_bg"]);

// Create a pipeline job (build guide §8.3, admin+). Validates D5 (detail
// angles never receive AI engines) server-side, inserts the row, then fires
// the GitHub Actions dispatch when ANSH-04's PAT is configured — otherwise
// the job stays queued with a local-run hint in its log.
export async function POST(request: Request) {
  let staff;
  try {
    staff = await requireAdmin();
  } catch {
    return NextResponse.json({ error: "Not authorized" }, { status: 401 });
  }

  let body: { type?: string; designId?: string; angleId?: string; params?: Record<string, unknown> };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const type = (body.type ?? "") as (typeof TYPES)[number];
  if (!TYPES.includes(type)) return NextResponse.json({ error: `Unknown job type "${body.type}"` }, { status: 400 });

  const admin = createAdminClient();

  // D5: reject AI engines on detail/macro angles — embroidery fidelity rule.
  if (AI_ENGINE_TYPES.has(type) && body.angleId) {
    const { data: angle } = await admin.from("design_angles").select("angle").eq("id", body.angleId).maybeSingle();
    if (angle && (DETAIL_ANGLES as readonly string[]).includes(angle.angle)) {
      return NextResponse.json({ error: "Detail angles are raw-only — AI engines are not offered (D5)." }, { status: 400 });
    }
  }

  const dispatchConfigured = !!(process.env.GITHUB_PAT && process.env.GITHUB_RUNNER_REPO);
  const { data: job, error } = await admin
    .from("pipeline_jobs")
    .insert({
      type,
      design_id: body.designId ?? null,
      angle_id: body.angleId ?? null,
      params: body.params ?? {},
      requested_by: staff.email,
      log: dispatchConfigured ? "" : "No hosted runner yet (ANSH-04) — run locally: python3 -m pipeline.runner --job <this id>",
    })
    .select("*")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  if (dispatchConfigured) {
    try {
      const res = await fetch(
        `https://api.github.com/repos/${process.env.GITHUB_RUNNER_REPO}/actions/workflows/pipeline-runner.yml/dispatches`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${process.env.GITHUB_PAT}`,
            Accept: "application/vnd.github+json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ ref: process.env.GITHUB_RUNNER_REF ?? "dev", inputs: { job_id: job.id } }),
        },
      );
      if (!res.ok) {
        const detail = `GH dispatch failed (${res.status}) — job stays queued`;
        await admin.from("pipeline_jobs").update({ log: detail }).eq("id", job.id);
      }
    } catch (err) {
      await admin.from("pipeline_jobs").update({ log: `GH dispatch error: ${(err as Error).message}` }).eq("id", job.id);
    }
  }

  return NextResponse.json({ job });
}
