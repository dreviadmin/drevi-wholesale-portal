import { NextResponse } from "next/server";
import { requireStaff } from "@/lib/staff";
import { createAdminClient } from "@/lib/supabase/admin";
import { validateCatSub } from "@/lib/sku/vocab-live";
import { numberFloor } from "@/lib/sku/registry-sheet";

export const dynamic = "force-dynamic";

// Display-only "Next #" preview: the registry max, raised to the same floor
// the mint uses (numberFloor — product tables, retail Master, dual-mode
// sheet), so the preview is the number the mint gives. The client shows its
// local estimate instantly and reconciles with this value.
export async function GET(request: Request) {
  try {
    await requireStaff();
  } catch {
    return NextResponse.json({ error: "Not authorized" }, { status: 401 });
  }
  const url = new URL(request.url);
  const cat = (url.searchParams.get("cat") ?? "").trim().toUpperCase();
  const sub = (url.searchParams.get("sub") ?? "").trim().toUpperCase();
  if (!(await validateCatSub(cat, sub))) return NextResponse.json({ error: "Unknown category/sub-category" }, { status: 400 });

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
  max = Math.max(max, (await numberFloor(cat, sub)).floor);
  return NextResponse.json({ next: max + 1 });
}
