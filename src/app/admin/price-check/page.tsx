import { requireStaffOrRedirect } from "@/lib/staff";
import { createAdminClient } from "@/lib/supabase/admin";
import { PriceCheckClient } from "./PriceCheckClient";
import { drivePhotosEnabled } from "@/lib/drive";
import type { WholesaleProduct } from "@/lib/types";

export const dynamic = "force-dynamic";

// Instant price lookup for the shop floor: tags carry a QR (bare SKU) but no
// wholesale price, so staff scan — or type — and quote on the spot. Open to
// every staff role; buyers never reach /admin/*.
export default async function PriceCheckPage() {
  await requireStaffOrRedirect();
  const admin = createAdminClient();
  const [{ data: products }, { data: withdrawn }] = await Promise.all([
    admin
      .from("wholesale_products")
      .select("sku, title, category, color, primary_fabric, wholesale_price, min_order_qty, restockable, restock_days, current_qty, image_urls")
      .eq("wholesale_visible", true)
      .order("title", { nullsFirst: false }),
    // Withdrawn from billing (Manage Catalog): SKUs only, so a scan of one
    // says so instead of "Not on the portal yet". No prices leave here.
    admin.from("wholesale_products").select("sku").eq("wholesale_visible", false),
  ]);

  return (
    <PriceCheckClient
      products={(products ?? []) as WholesaleProduct[]}
      withdrawnSkus={(withdrawn ?? []).map((w) => w.sku as string)}
      drivePhotos={drivePhotosEnabled()}
    />
  );
}
