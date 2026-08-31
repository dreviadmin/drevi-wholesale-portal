import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/staff";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchImageByRef } from "@/lib/design-image-store";
import { runEngine, submitFashn, seedFor, type EngineKind } from "@/lib/pipeline/engines";
import { finishGenerationJob } from "@/lib/pipeline/finish";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// FASHN submits and returns immediately (poll route finishes it); seedream and
// openai fit comfortably. Hobby's 60s ceiling is fine for all of them.
export const maxDuration = 60;

const TYPE_TO_ENGINE: Record<string, EngineKind> = {
  tryon: "fashn",
  seedream: "seedream",
  openai_bg: "openai_bg",
};

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
    const engine = TYPE_TO_ENGINE[claimed.type];
    if (!engine) return await failJob(`Job type ${claimed.type} has no in-process engine`);
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
