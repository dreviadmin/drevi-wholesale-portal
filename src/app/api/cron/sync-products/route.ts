import { NextResponse } from "next/server";
import { syncProducts } from "@/lib/sync";
import { getEnv } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Vercel cron (*/10 * * * *) hits this with `Authorization: Bearer ${CRON_SECRET}`.
export async function GET(request: Request) {
  const auth = request.headers.get("authorization");
  const expected = `Bearer ${getEnv("CRON_SECRET")}`;
  if (auth !== expected) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await syncProducts();
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
