import { createAdminClient } from "@/lib/supabase/admin";
import { counterSkus, loadRetailPrices } from "@/lib/retail-price";
import { drivePhotosEnabled } from "@/lib/drive";
import { RetailCheckClient } from "./RetailCheckClient";
import type { WholesaleProduct } from "@/lib/types";

export const dynamic = "force-dynamic";

// Retail price lookup for the shop floor: exhibition tags carry wholesale
// prices, so the price section is cut off and staff scan the QR to quote the
// RETAIL price in real time — the Specs MRP, else the sheet's Final MRP
// (retail-price-core.ts: the same price the tag prints and the till bills). Open to every staff role.
// Wholesale prices are deliberately never rendered on this page — the screen
// faces retail customers.
export default async function RetailCheckPage() {
  const admin = createAdminClient();
  const [{ data: products }, prices] = await Promise.all([
    // No wholesale_visible filter: a garment hidden from the wholesale portal
    // still hangs in the shop and its tag must resolve.
    admin
      .from("wholesale_products")
      .select("sku, title, category, color, primary_fabric, min_order_qty, restockable, restock_days, current_qty, image_urls, description, wholesale_visible")
      .order("title", { nullsFirst: false }),
    // A failed price read leaves the page usable (every price "not set")
    // rather than blanking the counter screen.
    loadRetailPrices().catch((e) => { console.error("[retail-check] prices:", (e as Error).message); return null; }),
  ]);
  const known = prices ? await counterSkus(prices).catch(() => prices.sheetSkus) : [];

  return (
    <RetailCheckClient
      products={(products ?? []) as WholesaleProduct[]}
      retail={prices ? known.map((sku) => ({ sku, retail_price: prices.priceOf(sku) })) : []}
      pricesAsOf={prices?.sheetAsOf ?? null}
      drivePhotos={drivePhotosEnabled()}
    />
  );
}
