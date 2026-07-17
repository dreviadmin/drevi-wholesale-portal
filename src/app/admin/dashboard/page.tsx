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

  const [{ data: orders }, { data: buyers }, { data: products }, { data: vendors }] = await Promise.all([
    admin
      .from("orders")
      .select("id, order_number, status, source, total_amount, advance_amount, submitted_at, buyer_id, items")
      .order("submitted_at", { ascending: false }),
    admin.from("buyers").select("id, business_name, owner_name, phone, city"),
    admin
      .from("wholesale_products")
      .select("sku, title, image_urls, current_qty, wholesale_price, category, restockable, wholesale_visible"),
    admin.from("product_vendor_info").select("sku, vendor_name, vendor_id, vendor_sku, last_cost, last_receipt_date"),
  ]);

  return (
    <DashboardView
      orders={(orders ?? []) as DashOrder[]}
      buyers={(buyers ?? []) as DashBuyer[]}
      products={(products ?? []) as DashProduct[]}
      vendors={(vendors ?? []) as VendorInfo[]}
    />
  );
}
