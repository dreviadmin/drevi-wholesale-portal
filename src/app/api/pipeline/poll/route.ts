import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/staff";
import { createAdminClient } from "@/lib/supabase/admin";
import { pollFashn } from "@/lib/pipeline/engines";
import { finishGenerationJob } from "@/lib/pipeline/finish";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// The second half of FASHN's split flow (2 Aug): one short status check per
// request. The Workbench calls this every few seconds until done/error, so no
// single function ever outlives Vercel Hobby's 60s ceiling. Downloading the
// finished 2k PNG and storing it happens on the completing call.
export async function POST(request: Request) {
  let staff;
  try {
    staff = await requireAdmin();
  } catch {
    return NextResponse.json({ error: "Not authorized" }, { status: 401 });
  }

  let jobId: string | undefined;
  try {
    ({ jobId } = await request.json());
  } catch { /* guard below */ }
  if (!jobId) return NextResponse.json({ error: "jobId required" }, { status: 400 });

  const admin = createAdminClient();
  const { data: job } = await admin
    .from("pipeline_jobs")
    .select("id, type, status, design_id, angle_id, params, progress")
    .eq("id", jobId)
    .maybeSingle();
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });
  if (job.status === "done") return NextResponse.json({ ok: true, done: true });
  if (job.status === "error") return NextResponse.json({ ok: false, error: "Job failed — see the job strip" }, { status: 500 });

  const fashnId = (job.params as Record<string, unknown>)?.fashnId as string | undefined;
  if (!fashnId) return NextResponse.json({ ok: true, running: true, progress: job.progress });

  const res = await pollFashn(fashnId);
  if (res.status === "running") {
    // Nudge progress so the strip visibly moves while FASHN renders.
    await admin.from("pipeline_jobs").update({ progress: Math.min(75, (job.progress ?? 30) + 5) }).eq("id", jobId);
    return NextResponse.json({ ok: true, running: true });
  }
  if (res.status === "failed") {
    await admin
      .from("pipeline_jobs")
      .update({ status: "error", log: (res.error ?? "FASHN failed").slice(0, 800), finished_at: new Date().toISOString() })
      .eq("id", jobId);
    return NextResponse.json({ ok: false, error: res.error ?? "FASHN failed" }, { status: 500 });
  }

  // Completed — claim the finish atomically so two overlapping polls can't
  // both store the candidate.
  const { data: claimed } = await admin
    .from("pipeline_jobs")
    .update({ progress: 85 })
    .eq("id", jobId)
    .eq("status", "running")
    .select("id")
    .maybeSingle();
  if (!claimed) return NextResponse.json({ ok: true, done: true });

  const [{ data: angle }, { data: design }] = await Promise.all([
    admin.from("design_angles").select("id, angle").eq("id", job.angle_id).maybeSingle(),
    admin.from("designs").select("id, base_sku, color, drive_folder_id").eq("id", job.design_id).maybeSingle(),
  ]);
  if (!angle || !design) {
    await admin.from("pipeline_jobs").update({ status: "error", log: "Angle or design vanished mid-run", finished_at: new Date().toISOString() }).eq("id", jobId);
    return NextResponse.json({ ok: false, error: "Angle or design vanished" }, { status: 500 });
  }

  const fin = await finishGenerationJob({
    admin,
    jobId,
    engine: "fashn",
    design,
    angle,
    bytes: res.bytes!,
    createdBy: staff.email,
  });
  if (!fin.ok) {
    await admin.from("pipeline_jobs").update({ status: "error", log: (fin.error ?? "finish failed").slice(0, 800), finished_at: new Date().toISOString() }).eq("id", jobId);
    return NextResponse.json({ ok: false, error: fin.error }, { status: 500 });
  }
  return NextResponse.json({ ok: true, done: true, imageId: fin.imageId });
}
