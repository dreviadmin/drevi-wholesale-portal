import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/staff";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchImageByRef, storeDesignImage } from "@/lib/design-image-store";
import { runEngine, seedFor, ENGINE_COST, type EngineKind } from "@/lib/pipeline/engines";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Generation is slow (FASHN polls up to ~4 min). Vercel clamps to the plan's
// ceiling; localhost runs unclamped.
export const maxDuration = 300;

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

    const prompt = String((claimed.params as Record<string, unknown>)?.prompt ?? "");
    const out = await runEngine({
      engine,
      source: Buffer.from(source.body),
      contentType: source.contentType,
      angle: angle.angle,
      prompt,
      seed: seedFor(`${design.base_sku}-${design.color}`),
    });
    await admin.from("pipeline_jobs").update({ progress: 80 }).eq("id", jobId);

    const stored = await storeDesignImage({
      designId: design.id,
      baseSku: design.base_sku,
      color: design.color,
      angle: angle.angle,
      kind: "gen",
      bytes: out,
      contentType: "image/png",
      driveFolderId: design.drive_folder_id,
    });
    if (stored.driveFolderId && !design.drive_folder_id) {
      await admin.from("designs").update({ drive_folder_id: stored.driveFolderId }).eq("id", design.id);
    }

    const { data: row, error } = await admin
      .from("design_images")
      .insert({
        design_id: design.id,
        angle_id: angle.id,
        role: "candidate",
        engine,
        file_ref: stored.fileRef,
        file_name: stored.fileName,
        status: "active",
        cost_credits: ENGINE_COST[engine] ?? 0,
        created_by: staff.email,
      })
      .select("id")
      .single();
    if (error) return await failJob(`Candidate insert failed: ${error.message}`);

    await admin
      .from("pipeline_jobs")
      .update({ status: "done", progress: 100, cost_credits: ENGINE_COST[engine] ?? 0, finished_at: new Date().toISOString() })
      .eq("id", jobId);
    return NextResponse.json({ ok: true, imageId: row.id });
  } catch (e) {
    return await failJob(e instanceof Error ? e.message : "Generation failed");
  }
}
