// When is an in-flight pipeline job dead? (Ansh, 20 Sep: "a job goes in flight
// and stays stuck — blocking the image from being processed by any other
// model.")
//
// PURE, and on its own, so the policy is testable: sweep.ts does the database
// half and imports server-only, which vitest cannot load.
//
// Two things made a stuck job permanent before this existed:
//
//   1. The old sweep in regenAngle matched `status in (claimed, running)` AND
//      `started_at < cutoff`. A job that never started has started_at = NULL,
//      so a QUEUED job was immortal — prod and dev between them were carrying
//      four, the oldest 49 days.
//   2. That sweep only ran inside regenAngle, and the Workbench hides Generate
//      while a job is in flight. The one thing that could clear the angle was
//      the one thing the stuck angle would not let you press. Generating some
//      OTHER angle cleared it, which is not a mechanism anybody could guess.
//
// So age is measured from started_at ?? created_at, and the sweep runs on the
// studio's read paths rather than only on the button.

export interface SweepableJob {
  id: string;
  type: string;
  status: string;
  created_at: string | null;
  started_at: string | null;
}

/** Statuses that occupy an angle and hide its Generate button. */
export const IN_FLIGHT_STATUSES = ["queued", "claimed", "running"] as const;

const MINUTE = 60_000;

/**
 * How long each job type is allowed to stay in flight.
 *
 * The in-process engines run inside ONE Vercel invocation capped at 60s
 * (maxDuration in /api/pipeline/run), so anything still in flight at 5 minutes
 * lost its request and is never coming back. fashn is the exception: it submits
 * and is polled separately over 2-4 minutes, with the client giving up at 6, so
 * it gets 15. scan_drive is handed to a runner rather than run in-process and
 * gets the longest leash.
 */
export const JOB_BUDGET_MS: Record<string, number> = {
  seedream: 5 * MINUTE,
  nano_banana: 5 * MINUTE,
  matte: 5 * MINUTE,
  openai_bg: 5 * MINUTE,
  preprocess: 5 * MINUTE,
  vision: 5 * MINUTE,
  copy: 5 * MINUTE,
  tryon: 15 * MINUTE,
  scan_drive: 30 * MINUTE,
};

/** Unknown types get the cautious number, not the aggressive one. */
export const DEFAULT_JOB_BUDGET_MS = 15 * MINUTE;

export function budgetFor(type: string): number {
  return JOB_BUDGET_MS[type] ?? DEFAULT_JOB_BUDGET_MS;
}

/** Age in ms, from when the job actually started — or, if it never did, when it was asked for. */
export function jobAgeMs(job: SweepableJob, nowMs: number): number | null {
  const stamp = job.started_at ?? job.created_at;
  if (!stamp) return null; // no clock to judge it by — leave it alone
  const t = Date.parse(stamp);
  if (Number.isNaN(t)) return null;
  return nowMs - t;
}

/** The in-flight jobs that have outlived their budget. */
export function staleJobs<T extends SweepableJob>(jobs: T[], nowMs: number): T[] {
  return jobs.filter((j) => {
    if (!(IN_FLIGHT_STATUSES as readonly string[]).includes(j.status)) return false;
    const age = jobAgeMs(j, nowMs);
    if (age === null) return false;
    return age > budgetFor(j.type);
  });
}

/** What the killed job says in the ticker, so the next operator knows why it ended. */
export function timeoutLog(job: SweepableJob, nowMs: number): string {
  const age = jobAgeMs(job, nowMs);
  const mins = age === null ? "?" : Math.round(age / MINUTE);
  const started = job.started_at ? "started" : "queued";
  return `Timed out — ${started} ${mins}m ago and never finished (budget ${Math.round(budgetFor(job.type) / MINUTE)}m). The angle is free again.`;
}
