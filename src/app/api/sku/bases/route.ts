import { NextResponse } from "next/server";
import { requireStaff } from "@/lib/staff";
import { createAdminClient } from "@/lib/supabase/admin";
import { CATEGORIES } from "@/lib/sku/vocab";
import { fetchAll } from "@/lib/supabase/fetch-all";

export const dynamic = "force-dynamic";

// Grouped base list for the variant picker and the print-tray registry picker.
export async function GET() {
  try {
    await requireStaff();
  } catch {
    return NextResponse.json({ error: "Not authorized" }, { status: 401 });
  }
  const admin = createAdminClient();
  let data;
  try {
    data = await fetchAll(admin, "sku_registry", "base_sku, variant_sku, category, sub_category, color, size, description, created_at", (q) => q.order("created_at", { ascending: false }));
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }

  interface BaseEntry {
    base: string; cat: string; sub: string; catName: string; subName: string;
    desc: string; variantCount: number; variants: { sku: string; size: string; color: string }[]; latestTs: string;
  }
  const byBase = new Map<string, BaseEntry>();
  for (const r of data ?? []) {
    const cats = CATEGORIES as Record<string, { name: string; subs: Record<string, string> }>;
    const e: BaseEntry = byBase.get(r.base_sku) ?? {
      base: r.base_sku,
      cat: r.category,
      sub: r.sub_category,
      catName: cats[r.category]?.name ?? r.category,
      subName: cats[r.category]?.subs?.[r.sub_category] ?? r.sub_category,
      desc: "",
      variantCount: 0,
      variants: [],
      latestTs: r.created_at,
    };
    e.variantCount += 1;
    e.variants.push({ sku: r.variant_sku, size: r.size, color: r.color });
    if (!e.desc && r.description) e.desc = r.description;
    if (r.created_at > e.latestTs) e.latestTs = r.created_at;
    byBase.set(r.base_sku, e);
  }
  const bases = Array.from(byBase.values()).sort((a, b) => (a.latestTs < b.latestTs ? 1 : -1));
  return NextResponse.json({ bases });
}
