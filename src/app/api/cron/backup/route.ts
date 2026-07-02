import { NextResponse } from "next/server";
import { gzipSync } from "node:zlib";
import { exportAllTables } from "@/lib/backup";
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
    const gz = gzipSync(JSON.stringify(payload));
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
