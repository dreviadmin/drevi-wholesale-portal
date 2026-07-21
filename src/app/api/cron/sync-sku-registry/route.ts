import { NextResponse } from "next/server";
import { importRegistry, mirrorRegistry } from "@/lib/sku/registry-sheet";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Transition-safety cron (spec §4): pull rows minted via the old Apps Script
// tool into Supabase, then retry-mirror any portal rows the inline append
// missed. Runs on the same 10-minute GitHub Actions schedule as the product
// sync. The very first run performs the full historical backfill.
async function run(request: Request) {
  const auth = request.headers.get("authorization") ?? "";
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const imp = await importRegistry();
    const mir = await mirrorRegistry();
    return NextResponse.json({
      imported: imp.imported,
      qr_backfilled: imp.qrBackfilled,
      mirrored: mir.mirrored,
      warnings: [...imp.warnings, ...mir.warnings],
    });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

export async function POST(request: Request) { return run(request); }
// GET kept for parity with how the other cron endpoints are invoked.
export async function GET(request: Request) { return run(request); }
