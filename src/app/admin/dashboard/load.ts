import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { fetchAll } from "@/lib/supabase/fetch-all";
import type { DashOrder, DashBuyer, DashProduct, VendorInfo } from "./DashboardView";

// Shared loader for the dashboard AND the Stock-space /admin/reorder route
// (Stage 2 gives the Reorder view its own address; same data, same view).
export async function loadDashboardData() {
  const admin = createAdminClient();

  const [{ data: orders }, { data: buyers }, { data: products }, { data: vendors }, { data: grReceipts }, grLines] = await Promise.all([
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
    fetchAll<{ receipt_id: string; sku: string; unit_cost: number }>(admin, "goods_receipt_lines", "receipt_id, sku, unit_cost"),
  ]);

  // Latest goods-receipt cost per SKU (Phase 1 §8.5): by receipt_date, then
  // created_at. Shown ALONGSIDE the sheet-synced Last Cost — never replacing it.
  const recById = new Map((grReceipts ?? []).map((r) => [r.id, r]));
  const grLatest = new Map<string, { cost: number; date: string; createdAt: string }>();
  for (const l of grLines) {
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

  return {
    orders: (orders ?? []) as DashOrder[],
    buyers: (buyers ?? []) as DashBuyer[],
    products: (products ?? []) as DashProduct[],
    vendors: (vendors ?? []) as VendorInfo[],
    grBySku,
  };
}
