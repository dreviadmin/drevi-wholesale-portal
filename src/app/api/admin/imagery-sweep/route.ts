import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/staff";
import { sweepDesignImagery } from "@/lib/imagery-sweep";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// This downloads and re-uploads image bytes per design, so it is far slower
// than the other admin jobs — 300s is the platform ceiling the stock and
// invoice jobs already use, and `limit` below is what keeps a large sweep
// inside it. A run that hits the cap mid-sweep loses only the unstarted
// designs: every repair is committed per design, so re-running resumes.
export const maxDuration = 300;

// Rakesh's imagery closure (17 Sep) — see src/lib/imagery-sweep.ts for the
// invariants. Admin-gated because it writes design imagery and can create Drive
// folders.
//
// dryRun DEFAULTS TO TRUE: the honest reading of a sweep nobody has run yet is
// "show me what you would do". Writing requires an explicit {"dryRun": false}.
//
//   curl -X POST .../api/admin/imagery-sweep -d '{"dryRun":true,"limit":50}'
export async function POST(req: Request) {
  try {
    await requireAdmin();
  } catch {
    return NextResponse.json({ error: "Not authorized" }, { status: 401 });
  }

  // An empty body is a valid dry run — don't 400 a caller for sending nothing.
  let body: { dryRun?: unknown; limit?: unknown } = {};
  try {
    body = (await req.json()) ?? {};
  } catch {
    body = {};
  }

  const dryRun = body.dryRun !== false;
  const rawLimit = Number(body.limit);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.floor(rawLimit) : undefined;

  try {
    const result = await sweepDesignImagery({ dryRun, limit });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    // Only a world-read failure reaches here — per-design errors are collected
    // into result.failures and never abort the sweep.
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "Sweep failed" }, { status: 500 });
  }
}
