import { requireAdminOrRedirect } from "@/lib/staff";
import { createAdminClient } from "@/lib/supabase/admin";
import { DashboardView, type DashOrder, type DashBuyer, type DashProduct, type VendorInfo } from "./DashboardView";

export const dynamic = "force-dynamic";

// Admin dashboard: the day's money at a glance, orders sliced by product /
// vendor / customer, and the reorder table (vendor name + vendor SKU + last
// cost from the wholesale sheet) Rakesh uses to phone vendors for restock.
export default async function DashboardPage() {
  await requireAdminOrRedirect();
  const admin = createAdminClient();

  const [{ data: orders }, { data: buyers }, { data: products }, { data: vendors }, { data: grReceipts }, { data: grLines }] = await Promise.all([
    admin
      .from("orders")
      .select("id, order_number, status, source, total_amount, advance_amount, submitted_at, buyer_id, items")
      .order("submitted_at", { ascending: false }),
    admin.from("buyers").select("id, business_name, owner_name, phone, city"),
    admin
      .from("wholesale_products")
      .select("sku, title, image_urls, current_qty, wholesale_price, category, restockable, wholesale_visible"),
    admin.from("product_vendor_info").select("sku, vendor_name, vendor_id, vendor_sku, last_cost, last_receipt_date"),
    admin.from("goods_receipts").select("id, receipt_date, created_at"),
    admin.from("goods_receipt_lines").select("receipt_id, sku, unit_cost"),
  ]);

  // Latest goods-receipt cost per SKU (Phase 1 §8.5): by receipt_date, then
  // created_at. Shown ALONGSIDE the sheet-synced Last Cost — never replacing it.
  const recById = new Map((grReceipts ?? []).map((r) => [r.id, r]));
  const grLatest = new Map<string, { cost: number; date: string; createdAt: string }>();
  for (const l of grLines ?? []) {
    const rec = recById.get(l.receipt_id);
    if (!rec) continue;
    const sku = (l.sku as string).toUpperCase();
    const cur = grLatest.get(sku);
    if (!cur || rec.receipt_date > cur.date || (rec.receipt_date === cur.date && rec.created_at > cur.createdAt)) {
      grLatest.set(sku, { cost: Number(l.unit_cost), date: rec.receipt_date, createdAt: rec.created_at });
    }
  }
  const grBySku: Record<string, { cost: number; date: string }> = {};
  for (const [sku, v] of grLatest) grBySku[sku] = { cost: v.cost, date: v.date };

  return (
    <DashboardView
      orders={(orders ?? []) as DashOrder[]}
      buyers={(buyers ?? []) as DashBuyer[]}
      products={(products ?? []) as DashProduct[]}
      vendors={(vendors ?? []) as VendorInfo[]}
      grBySku={grBySku}
    />
  );
}
