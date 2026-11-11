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
  const { data: orders, error } = await admin
    .from("orders")
    .select("id, order_number")
    .not("pdf_url", "is", null)
    .neq("status", "cancelled")
    .limit(300);
  // An unreadable list is not "nothing to regenerate" (audit fix, 4 Oct).
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  let done = 0;
  const failed: string[] = [];
  for (const o of orders ?? []) {
    try {
      // finalizeOrder swallows its own failures and RETURNS the reason (a PDF
      // over the bucket cap, a render error) — counting every await as done
      // reported failed: [] for runs where uploads had failed (audit fix, 4 Oct).
      const r = await finalizeOrder(o.id, { notify: false });
      if (r.error) failed.push(o.order_number);
      else done++;
    } catch {
      failed.push(o.order_number);
    }
  }
  // The 300 cap stays (one batch has to fit inside maxDuration), but a run
  // that hit it says so instead of looking like it covered every order.
  return NextResponse.json({ ok: true, regenerated: done, failed, truncated: (orders?.length ?? 0) >= 300 });
}
