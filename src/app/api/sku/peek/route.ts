import { NextResponse } from "next/server";
import { requireStaff } from "@/lib/staff";
import { createAdminClient } from "@/lib/supabase/admin";
import { isValidCatSub } from "@/lib/sku/vocab";
import { dualMode, sheetNumberFloor, knownSkuFloor } from "@/lib/sku/registry-sheet";

export const dynamic = "force-dynamic";

// Display-only "Next #" preview (includes the dual-mode sheet floor). The
// client shows its local estimate instantly and reconciles with this value.
export async function GET(request: Request) {
  try {
    await requireStaff();
  } catch {
    return NextResponse.json({ error: "Not authorized" }, { status: 401 });
  }
  const url = new URL(request.url);
  const cat = (url.searchParams.get("cat") ?? "").trim().toUpperCase();
  const sub = (url.searchParams.get("sub") ?? "").trim().toUpperCase();
  if (!isValidCatSub(cat, sub)) return NextResponse.json({ error: "Unknown category/sub-category" }, { status: 400 });

  const admin = createAdminClient();
  const { data } = await admin
    .from("sku_registry")
    .select("base_sku")
    .eq("category", cat)
    .eq("sub_category", sub);
  let max = 0;
  for (const r of data ?? []) {
    const m = r.base_sku.match(/(\d{3})$/);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  max = Math.max(max, await knownSkuFloor(cat, sub));
  if (dualMode()) {
    const f = await sheetNumberFloor(cat, sub);
    max = Math.max(max, f.floor);
  }
  return NextResponse.json({ next: max + 1 });
}
