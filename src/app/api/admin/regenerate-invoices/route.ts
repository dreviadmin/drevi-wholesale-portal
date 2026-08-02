import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/staff";
import { createAdminClient } from "@/lib/supabase/admin";
import { finalizeOrder } from "@/lib/order-finalize";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Ansh (31 Jul) — re-render every stored invoice PDF from its order's CURRENT
// items (HSN backfill, catalog refreshes). notify:false always: this rewrites
// files, it never messages a buyer. Cancelled orders keep their old PDF.
export async function POST() {
  try {
    await requireAdmin();
  } catch {
    return NextResponse.json({ error: "Not authorized" }, { status: 401 });
  }
  const admin = createAdminClient();
  const { data: orders } = await admin
    .from("orders")
    .select("id, order_number")
    .not("pdf_url", "is", null)
    .neq("status", "cancelled")
    .limit(300);

  let done = 0;
  const failed: string[] = [];
  for (const o of orders ?? []) {
    try {
      await finalizeOrder(o.id, { notify: false });
      done++;
    } catch {
      failed.push(o.order_number);
    }
  }
  return NextResponse.json({ ok: true, regenerated: done, failed });
}
