import { describe, it, expect } from "vitest";
import { staleJobs, jobAgeMs, budgetFor, timeoutLog, type SweepableJob } from "./job-timeout";

const NOW = Date.parse("2026-09-20T12:00:00.000Z");
const minsAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

const job = (over: Partial<SweepableJob>): SweepableJob => ({
  id: "j", type: "seedream", status: "running",
  created_at: minsAgo(1), started_at: minsAgo(1), ...over,
});

describe("budgetFor", () => {
  it("gives the in-process engines 5 minutes — their Vercel request dies at 60s", () => {
    for (const t of ["seedream", "nano_banana", "matte", "openai_bg"]) {
      expect(budgetFor(t)).toBe(5 * 60_000);
    }
  });
  it("gives fashn 15 — it is submitted and polled for 2-4 minutes", () => {
    expect(budgetFor("tryon")).toBe(15 * 60_000);
  });
  it("gives an unknown type the cautious default, not the aggressive one", () => {
    expect(budgetFor("something_new")).toBe(15 * 60_000);
  });
});

describe("jobAgeMs", () => {
  it("measures from started_at when the job actually started", () => {
    expect(jobAgeMs(job({ started_at: minsAgo(7), created_at: minsAgo(30) }), NOW)).toBe(7 * 60_000);
  });
  it("falls back to created_at — the whole reason queued jobs were immortal", () => {
    expect(jobAgeMs(job({ started_at: null, created_at: minsAgo(9) }), NOW)).toBe(9 * 60_000);
  });
  it("refuses to judge a job with no usable clock", () => {
    expect(jobAgeMs(job({ started_at: null, created_at: null }), NOW)).toBeNull();
    expect(jobAgeMs(job({ started_at: "not a date", created_at: null }), NOW)).toBeNull();
  });
});

describe("staleJobs", () => {
  it("kills a running engine job past 5 minutes, spares one inside it", () => {
    const dead = job({ id: "dead", started_at: minsAgo(6) });
    const alive = job({ id: "alive", started_at: minsAgo(4) });
    expect(staleJobs([dead, alive], NOW).map((j) => j.id)).toEqual(["dead"]);
  });

  it("kills a QUEUED job that never started — prod was carrying one 49 days old", () => {
    const orphan = job({ id: "orphan", status: "queued", started_at: null, created_at: minsAgo(70268), type: "scan_drive" });
    expect(staleJobs([orphan], NOW).map((j) => j.id)).toEqual(["orphan"]);
  });

  it("leaves a fresh queued job alone — regenAngle POSTs /run right after inserting it", () => {
    expect(staleJobs([job({ status: "queued", started_at: null, created_at: minsAgo(1) })], NOW)).toEqual([]);
  });

  it("never touches a job that already settled", () => {
    const old = { started_at: minsAgo(9999), created_at: minsAgo(9999) };
    for (const status of ["done", "error", "cancelled"]) {
      expect(staleJobs([job({ status, ...old })], NOW)).toEqual([]);
    }
  });

  it("holds fashn to its own longer budget", () => {
    expect(staleJobs([job({ type: "tryon", started_at: minsAgo(8) })], NOW)).toEqual([]);
    expect(staleJobs([job({ type: "tryon", started_at: minsAgo(16) })], NOW)).toHaveLength(1);
  });

  it("is exclusive at the boundary — exactly at budget is not yet stale", () => {
    expect(staleJobs([job({ started_at: minsAgo(5) })], NOW)).toEqual([]);
  });
});

describe("timeoutLog", () => {
  it("says whether it ever started, and how long it sat", () => {
    expect(timeoutLog(job({ started_at: null, created_at: minsAgo(42), type: "scan_drive" }), NOW))
      .toBe("Timed out — queued 42m ago and never finished (budget 30m). The angle is free again.");
    expect(timeoutLog(job({ started_at: minsAgo(6) }), NOW))
      .toBe("Timed out — started 6m ago and never finished (budget 5m). The angle is free again.");
  });
});
