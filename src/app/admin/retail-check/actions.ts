"use server";

import { requireStaff } from "@/lib/staff";
import { syncRetailPrices } from "@/lib/sync";
import { counterSkus, loadRetailPrices } from "@/lib/retail-price";
import { findSkuImage } from "@/lib/drive";

// "Sync Prices" — pulls Final MRP for every sheet row (~2s), then returns the
// prices the counter actually quotes (Specs MRP first, the sheet's as the
// fallback — retail-price-core.ts) so the page updates in place.
// Open to every staff role: the person filling prices into the sheet on
// Saturday is the same person quoting them at the rack.
export async function refreshRetailPrices(): Promise<{
  ok: boolean;
  prices?: { sku: string; retail_price: number }[];
  asOf?: string;
  error?: string;
}> {
  try {
    await requireStaff();
  } catch {
    return { ok: false, error: "Not signed in." };
  }
  try {
    const res = await syncRetailPrices();
    const prices = await loadRetailPrices();
    const known = await counterSkus(prices);
    return { ok: true, prices: known.map((sku) => ({ sku, retail_price: prices.priceOf(sku) })), asOf: res.asOf };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

// Same Drive-photo fallback as the wholesale price check — identify the outfit
// even when it has no portal photo.
export async function lookupRetailSkuPhoto(sku: string): Promise<{ url: string | null }> {
  try {
    await requireStaff();
  } catch {
    return { url: null };
  }
  try {
    const hit = await findSkuImage(sku);
    return { url: hit ? `/api/drive-photo?id=${encodeURIComponent(hit.fileId)}` : null };
  } catch {
    return { url: null };
  }
}
