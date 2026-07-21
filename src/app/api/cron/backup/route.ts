import { NextResponse } from "next/server";
import { gzipSync } from "node:zlib";
import { exportAllTables, exportStorage } from "@/lib/backup";
import { getEnv } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Full-database export as gzipped JSON. Called daily by the GitHub Actions
// backup workflow (bearer CRON_SECRET), which stores the file OFF Supabase so
// the free tier still has an independent daily backup.
export async function GET(request: Request) {
  const auth = request.headers.get("authorization");
  if (auth !== `Bearer ${getEnv("CRON_SECRET")}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const payload = await exportAllTables();
    // Storage (visiting cards, custom-item photos, vendor bills) rides along
    // once daily — the 03:00 IST hourly run, or on demand via ?storage=1 —
    // keeping free-tier egress modest while tables stay hourly.
    const url = new URL(request.url);
    const istHour = Number(new Date().toLocaleString("en-GB", { hour: "2-digit", hour12: false, timeZone: "Asia/Kolkata" }));
    let storageMeta: Record<string, unknown> = {};
    if (url.searchParams.get("storage") === "1" || istHour === 3) {
      const storage = await exportStorage();
      storageMeta = { storage_files: storage.files, storage_warnings: storage.warnings };
    }
    const gz = gzipSync(JSON.stringify({ ...payload, ...storageMeta }));
    return new NextResponse(gz as unknown as BodyInit, {
      headers: {
        "Content-Type": "application/gzip",
        "Content-Disposition": `attachment; filename="drevi-backup-${payload.exported_at.slice(0, 10)}.json.gz"`,
        "X-Row-Count": String(payload.row_count),
      },
    });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
