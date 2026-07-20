import { NextResponse } from "next/server";
import { requireStaff } from "@/lib/staff";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

// Generator page state: counters per CAT-SUB, recent history, totals, user.
export async function GET() {
  let staff;
  try {
    staff = await requireStaff();
  } catch {
    return NextResponse.json({ error: "Not authorized" }, { status: 401 });
  }
  const admin = createAdminClient();

  const [{ data: all, error: allErr }, { data: history, count }] = await Promise.all([
    admin.from("sku_registry").select("category, sub_category, base_sku"),
    admin
      .from("sku_registry")
      .select("variant_sku, base_sku, category, sub_category, color, size, description, created_by, created_at", { count: "exact" })
      .order("created_at", { ascending: false })
      .limit(50),
  ]);
  if (allErr) return NextResponse.json({ error: allErr.message }, { status: 500 });

  // counters: max design number per CAT-SUB.
  const counters: Record<string, number> = {};
  for (const r of all ?? []) {
    const m = r.base_sku.match(/(\d{3})$/);
    if (!m) continue;
    const key = `${r.category}-${r.sub_category}`;
    counters[key] = Math.max(counters[key] ?? 0, parseInt(m[1], 10));
  }

  return NextResponse.json({
    counters,
    history: history ?? [],
    totalSkus: count ?? 0,
    user: { email: staff.email, name: staff.name },
  });
}
