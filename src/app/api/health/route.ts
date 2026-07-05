import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Public health check. Deliberately touches the database so that
 *  (a) an external uptime monitor pinging this proves the WHOLE stack works,
 *  (b) each ping counts as Supabase activity — an independent keepalive that
 *      doesn't rely on GitHub Actions.
 * Returns no data beyond a row count, so public exposure is harmless.
 */
export async function GET() {
  try {
    const admin = createAdminClient();
    const { count, error } = await admin
      .from("wholesale_products")
      .select("*", { count: "exact", head: true })
      .eq("wholesale_visible", true);
    if (error) throw new Error(error.message);
    return NextResponse.json({ ok: true, db: "up", visible_products: count ?? 0, at: new Date().toISOString() });
  } catch (err) {
    return NextResponse.json({ ok: false, db: "down", error: (err as Error).message }, { status: 503 });
  }
}
