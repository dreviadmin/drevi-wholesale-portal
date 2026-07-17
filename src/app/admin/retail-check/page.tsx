import { createAdminClient } from "@/lib/supabase/admin";
import { drivePhotosEnabled } from "@/lib/drive";
import { RetailCheckClient } from "./RetailCheckClient";
import type { WholesaleProduct } from "@/lib/types";

export const dynamic = "force-dynamic";

// Retail price lookup for the shop floor: exhibition tags carry wholesale
// prices, so the price section is cut off and staff scan the QR to quote the
// RETAIL price (sheet Final MRP) in real time. Open to every staff role.
// Wholesale prices are deliberately never rendered on this page — the screen
// faces retail customers.
export default async function RetailCheckPage() {
  const admin = createAdminClient();
  const [{ data: products }, { data: retail }] = await Promise.all([
    // No wholesale_visible filter: a garment hidden from the wholesale portal
    // still hangs in the shop and its tag must resolve.
    admin
      .from("wholesale_products")
      .select("sku, title, category, color, primary_fabric, min_order_qty, restockable, restock_days, current_qty, image_urls, description, wholesale_visible")
      .order("title", { nullsFirst: false }),
    admin.from("product_vendor_info").select("sku, retail_price, updated_at"),
  ]);

  const pricesAsOf = (retail ?? []).reduce<string | null>(
    (max, r) => (r.updated_at && (!max || r.updated_at > max) ? r.updated_at : max),
    null,
  );

  return (
    <RetailCheckClient
      products={(products ?? []) as WholesaleProduct[]}
      retail={(retail ?? []).map((r) => ({ sku: r.sku as string, retail_price: Number(r.retail_price) || 0 }))}
      pricesAsOf={pricesAsOf}
      drivePhotos={drivePhotosEnabled()}
    />
  );
}
