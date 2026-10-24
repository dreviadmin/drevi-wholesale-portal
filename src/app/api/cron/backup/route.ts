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
    // Storage is NOT exported automatically any more (24 Oct 2026). The
    // 03:00 IST run downloaded every object in the STORAGE_BUCKETS list
    // (about 170 MB, mostly visiting cards) through this one 60 s function
    // every night: about 5 GB of egress a month, the Free plan's whole
    // allowance on its own, for a backup that cannot fit in one response
    // anyway. With egress and storage over quota, Supabase restricted the
    // project on 23 Oct and the portal went down until the Pro upgrade.
    // Tables stay hourly; ?storage=1 still runs it by hand.
    // A real file backup belongs outside this route (an incremental copy from
    // a GitHub Action), not here.
    const url = new URL(request.url);
    let storageMeta: Record<string, unknown> = {};
    if (url.searchParams.get("storage") === "1") {
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
