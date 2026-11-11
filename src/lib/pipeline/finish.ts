import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { storeDesignImage } from "@/lib/design-image-store";
import { engineCost } from "@/lib/pipeline/engines";

// Shared tail of every generation: store the output, register the candidate,
// close the job. Used by /api/pipeline/run (sync engines) and
// /api/pipeline/poll (FASHN's split flow).

export async function finishGenerationJob(args: {
  admin: SupabaseClient;
  jobId: string;
  engine: string;
  design: { id: string; base_sku: string; color: string; drive_folder_id: string | null };
  angle: { id: string; angle: string };
  bytes: Buffer;
  createdBy: string;
}): Promise<{ ok: boolean; imageId?: string; error?: string }> {
  const { admin } = args;
  const stored = await storeDesignImage({
    designId: args.design.id,
    baseSku: args.design.base_sku,
    color: args.design.color,
    angle: args.angle.angle,
    kind: "gen",
    bytes: args.bytes,
    contentType: "image/png",
    driveFolderId: args.design.drive_folder_id,
  });
  if (stored.driveFolderId && !args.design.drive_folder_id) {
    await admin.from("designs").update({ drive_folder_id: stored.driveFolderId }).eq("id", args.design.id);
  }

  const { data: row, error } = await admin
    .from("design_images")
    .insert({
      design_id: args.design.id,
      angle_id: args.angle.id,
      role: "candidate",
      engine: args.engine,
      file_ref: stored.fileRef,
      file_name: stored.fileName,
      status: "active",
      cost_credits: engineCost(args.engine),
      created_by: args.createdBy,
    })
    .select("id")
    .single();
  if (error) return { ok: false, error: `Candidate insert failed: ${error.message}` };

  // Only an in-flight job closes as done. Cancel (cancelJobsForAngle) and the
  // stale-job sweep can finalise the row while the engine is still rendering;
  // without this guard the late return flipped a cancelled or timed-out job
  // back to 'done'. On the normal path the row is 'running' here (the run route
  // claims it so, the poll route requires it), so nothing changes there. The
  // candidate above still lands: its file is already stored and paid for —
  // whether to keep or drop a render that arrives after a cancel is a product
  // call, not this guard's.
  await admin
    .from("pipeline_jobs")
    .update({ status: "done", progress: 100, cost_credits: engineCost(args.engine), finished_at: new Date().toISOString() })
    .eq("id", args.jobId)
    .in("status", ["claimed", "running"]);
  return { ok: true, imageId: row.id };
}
