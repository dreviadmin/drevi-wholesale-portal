import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { IN_FLIGHT_STATUSES, staleJobs, timeoutLog, type SweepableJob } from "./job-timeout";

// The database half of the auto-kill. Policy lives in job-timeout.ts, which is
// pure and tested; this only reads, decides with that, and writes.
//
// Deliberately cheap enough to call on a read path: it touches only jobs that
// are currently in flight, which in normal operation is zero to a handful. It
// never throws — a studio page must still render if this fails.

export async function sweepStaleJobs(
  admin: SupabaseClient,
  opts: { designId?: string; nowMs?: number } = {},
): Promise<{ killed: number; ids: string[] }> {
  const nowMs = opts.nowMs ?? Date.now();
  try {
    let q = admin
      .from("pipeline_jobs")
      .select("id, type, status, created_at, started_at")
      .in("status", IN_FLIGHT_STATUSES as unknown as string[]);
    // Scoped when the caller has a design in hand, global otherwise. Global is
    // what clears the orphans nobody is looking at.
    if (opts.designId) q = q.eq("design_id", opts.designId);
    const { data, error } = await q;
    if (error || !data?.length) return { killed: 0, ids: [] };

    const dead = staleJobs(data as SweepableJob[], nowMs);
    if (!dead.length) return { killed: 0, ids: [] };

    const finishedAt = new Date(nowMs).toISOString();
    // One update per job so each carries its own age in the log. A handful at
    // most, and a failure on one must not strand the others.
    for (const job of dead) {
      await admin
        .from("pipeline_jobs")
        .update({ status: "error", log: timeoutLog(job, nowMs).slice(0, 800), finished_at: finishedAt })
        .eq("id", job.id)
        // Only if it is STILL in flight: a job that finished between the read
        // and this write must not be overwritten with a timeout.
        .in("status", IN_FLIGHT_STATUSES as unknown as string[]);
    }
    return { killed: dead.length, ids: dead.map((j) => j.id) };
  } catch {
    return { killed: 0, ids: [] };
  }
}

/**
 * Manual kill — every in-flight job on one angle, marked cancelled rather than
 * errored so the ticker can tell "a person stopped this" from "this died".
 */
export async function cancelJobsForAngle(
  admin: SupabaseClient,
  angleId: string,
  who: string,
): Promise<{ cancelled: number }> {
  const { data, error } = await admin
    .from("pipeline_jobs")
    .update({ status: "cancelled", log: `Cancelled by ${who}`, finished_at: new Date().toISOString() })
    .eq("angle_id", angleId)
    .in("status", IN_FLIGHT_STATUSES as unknown as string[])
    .select("id");
  if (error) return { cancelled: 0 };
  return { cancelled: data?.length ?? 0 };
}
