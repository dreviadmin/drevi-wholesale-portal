import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/staff";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchImageByRef } from "@/lib/design-image-store";
import { runEngine, submitFashn, seedFor, fashnEnabled, JOB_TYPE_ENGINE } from "@/lib/pipeline/engines";
import { finishGenerationJob } from "@/lib/pipeline/finish";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// FASHN submits and returns immediately (poll route finishes it); seedream,
// nano_banana, matte and openai all render synchronously inside this request.
// matte is the fast one by a wide margin: one ~5s birefnet call plus local
// sharp work, against 14s and 36s for the two generative engines. Hobby's
// Measured on the bench: Seedream v5 Pro ~36s, Nano Banana ~14s, both at fal's
// 1K default. 2K is NOT yet timed, and it is what this ships with — if it runs
// past the ceiling the symptom is a job stuck in 'running' until regenAngle's
// 15-minute sweep, not a wrong image. Worth one real 2K Generate to confirm.
export const maxDuration = 60;

// UX sprint (29 Jul) — run one queued pipeline job IN-PROCESS. The hosted
// runner (ANSH-04) stays parked; the Workbench queues a job via regenAngle and
// immediately POSTs it here. Job rows keep their role as the progress/history
// surface — this route just does the work the runner would have.
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
  } catch {
    /* fall through to the guard */
  }
  if (!jobId) return NextResponse.json({ error: "jobId required" }, { status: 400 });

  const admin = createAdminClient();

  // Claim atomically: only a queued job may start, so a double-POST is a no-op.
  const { data: claimed } = await admin
    .from("pipeline_jobs")
    .update({ status: "running", progress: 5, started_at: new Date().toISOString() })
    .eq("id", jobId)
    .eq("status", "queued")
    .select("id, type, design_id, angle_id, params")
    .maybeSingle();
  if (!claimed) return NextResponse.json({ error: "Job is not queued (already running, done, or unknown)" }, { status: 409 });

  const failJob = async (message: string) => {
    await admin
      .from("pipeline_jobs")
      .update({ status: "error", log: message.slice(0, 800), finished_at: new Date().toISOString() })
      .eq("id", jobId);
    return NextResponse.json({ error: message }, { status: 500 });
  };

  try {
    // The inverse of the table regenAngle queued this job with — one source,
    // so a new engine cannot be routable on one side and not the other.
    const engine = JOB_TYPE_ENGINE[claimed.type];
    if (!engine) return await failJob(`Job type ${claimed.type} has no in-process engine`);
    // A 'tryon' row queued before 19 Sep can still be sitting here. Fail it
    // with the reason rather than sending it to a parked provider.
    if (engine === "fashn" && !fashnEnabled()) {
      return await failJob("Model swap (fashn) is disabled — set FASHN_ENABLED=true to bring it back");
    }
    if (!claimed.angle_id) return await failJob("Job has no angle");

    const { data: angle } = await admin
      .from("design_angles")
      .select("id, angle, source_ref, source_image_id")
      .eq("id", claimed.angle_id)
      .maybeSingle();
    if (!angle) return await failJob("Angle not found");

    // Prefer the linked source row (post-0022 truth); fall back to the legacy ref.
    let sourceRef = angle.source_ref as string | null;
    if (angle.source_image_id) {
      const { data: srcRow } = await admin.from("design_images").select("file_ref").eq("id", angle.source_image_id).maybeSingle();
      if (srcRow?.file_ref) sourceRef = srcRow.file_ref;
    }
    if (!sourceRef) return await failJob("No source image on this angle");

    const { data: design } = await admin
      .from("designs")
      .select("id, base_sku, color, drive_folder_id")
      .eq("id", claimed.design_id)
      .maybeSingle();
    if (!design) return await failJob("Design not found");

    // Bounded-size fetch: for Drive refs this returns the JPEG thumbnail
    // pipeline, which transcodes whatever the phone shot (HEIC broke fal when
    // the raw bytes were mislabelled as JPEG). Storage refs ignore the size
    // and are already JPEG/PNG from capture.
    const source = await fetchImageByRef(sourceRef, 1600);
    if (!source) return await failJob("Could not fetch the source image");
    await admin.from("pipeline_jobs").update({ progress: 20 }).eq("id", jobId);

    const params = (claimed.params as Record<string, unknown>) ?? {};
    const prompt = String(params.prompt ?? "");
    const seed = seedFor(`${design.base_sku}-${design.color}`);
    // Coloured-background plate (19 Sep). regenAngle decided whether this
    // angle gets one — coloured mode AND not a detail close-up — and froze the
    // public URL into the job, so a background changed mid-flight cannot swap
    // the backdrop out from under a prompt that already says "the attached
    // background". Absent for minimal and grey, which are prompt-only.
    const plateUrl = typeof params.plateUrl === "string" ? params.plateUrl : null;
    const platePrompt = typeof params.platePrompt === "string" ? params.platePrompt : null;
    // The background MODE, frozen into the job the same way and for the same
    // reason. Only matte reads it — the generative engines carry their mode
    // inside the prompt — but it travels on every job so a row can be replayed
    // on a different engine without losing what background was chosen.
    const bgMode = typeof params.bgMode === "string" ? params.bgMode : null;

    // FASHN runs 2–4 min — beyond Vercel Hobby's 60s. Submit here, poll from
    // /api/pipeline/poll in short separate requests (Ansh's decision, 2 Aug).
    if (engine === "fashn") {
      const predictionId = await submitFashn({
        source: Buffer.from(source.body),
        contentType: source.contentType,
        angle: angle.angle,
        prompt,
        seed,
        brandModel: (params.brandModel as string | undefined) ?? null,
      });
      await admin
        .from("pipeline_jobs")
        .update({ progress: 30, params: { ...params, fashnId: predictionId } })
        .eq("id", jobId);
      return NextResponse.json({ ok: true, pending: true, jobId });
    }

    const out = await runEngine({
      engine,
      source: Buffer.from(source.body),
      contentType: source.contentType,
      angle: angle.angle,
      prompt,
      seed,
      plateUrl,
      platePrompt,
      bgMode,
    });
    await admin.from("pipeline_jobs").update({ progress: 80 }).eq("id", jobId);

    const fin = await finishGenerationJob({
      admin, jobId, engine,
      design: { id: design.id, base_sku: design.base_sku, color: design.color, drive_folder_id: design.drive_folder_id },
      angle: { id: angle.id, angle: angle.angle },
      bytes: out,
      createdBy: staff.email,
    });
    if (!fin.ok) return await failJob(fin.error ?? "Finish failed");
    return NextResponse.json({ ok: true, imageId: fin.imageId });
  } catch (e) {
    return await failJob(e instanceof Error ? e.message : "Generation failed");
  }
}
