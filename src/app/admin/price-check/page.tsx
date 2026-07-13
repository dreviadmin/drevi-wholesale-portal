import { createAdminClient } from "@/lib/supabase/admin";
import { PriceCheckClient } from "./PriceCheckClient";
import { drivePhotosEnabled } from "@/lib/drive";
import type { WholesaleProduct } from "@/lib/types";

export const dynamic = "force-dynamic";

// Instant price lookup for the shop floor: tags carry a QR (bare SKU) but no
// wholesale price, so staff scan — or type — and quote on the spot. Open to
// every staff role; buyers never reach /admin/*.
export default async function PriceCheckPage() {
  const admin = createAdminClient();
  const { data: products } = await admin
    .from("wholesale_products")
    .select("sku, title, category, color, primary_fabric, wholesale_price, min_order_qty, restockable, restock_days, current_qty, image_urls")
    .eq("wholesale_visible", true)
    .order("title", { nullsFirst: false });

  return <PriceCheckClient products={(products ?? []) as WholesaleProduct[]} drivePhotos={drivePhotosEnabled()} />;
}
