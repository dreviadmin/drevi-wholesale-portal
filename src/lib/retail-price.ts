import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { fetchAll } from "@/lib/supabase/fetch-all";
import { designKeyOf, effectiveRetailPrice, type DesignMrpRow } from "@/lib/retail-price-core";

// Loads what effectiveRetailPrice needs — the sheet's Final MRP per SKU and
// the Specs MRP per design — for the counter screens (retail bill, retail
// price check, scan sheet). The price tag route reads the same two sources
// itself and applies the same rule.

export interface RetailPrices {
  /** Specs MRP first, else the sheet's; 0 when neither has one. */
  priceOf(sku: string): number;
  /** SKUs the sheet has a row for (the price check's "known SKU" list). */
  sheetSkus: string[];
  /** Newest sheet price sync, for the price check's "as of" line. */
  sheetAsOf: string | null;
}

const IN_LIMIT = 300;

/**
 * Every SKU a tag can carry: the catalog, the sheet's rows, and sizes minted
 * in the registry but not yet received (Studio prints tags for those too, at
 * their design's Specs MRP — the price check must know them as well).
 */
export async function counterSkus(prices: RetailPrices): Promise<string[]> {
  const admin = createAdminClient();
  const [catalog, minted] = await Promise.all([
    fetchAll<{ sku: string }>(admin, "wholesale_products", "sku"),
    fetchAll<{ variant_sku: string }>(admin, "sku_registry", "variant_sku"),
  ]);
  return [...new Set([
    ...catalog.map((r) => r.sku.toUpperCase()),
    ...prices.sheetSkus,
    ...minted.map((r) => r.variant_sku.toUpperCase()),
  ])];
}

/**
 * skus: just these (a bill's lines); omitted: everything (a page that lists
 * the whole catalog). A long list reads whole tables instead of a giant IN().
 */
export async function loadRetailPrices(skus?: string[]): Promise<RetailPrices> {
  const admin = createAdminClient();
  const list = skus ? [...new Set(skus.map((s) => s.trim().toUpperCase()).filter(Boolean))] : null;
  const bases = list ? [...new Set(list.map((s) => designKeyOf(s)?.split("|")[0]).filter((b): b is string => !!b))] : null;
  const narrow = !!list && list.length <= IN_LIMIT && (bases?.length ?? 0) <= IN_LIMIT;

  type Pvi = { sku: string; retail_price: number | string | null; updated_at: string | null };
  type Design = DesignMrpRow & { base_sku: string; color: string };
  let pvi: Pvi[];
  let designs: Design[];
  if (narrow) {
    if (list!.length === 0) return { priceOf: () => 0, sheetSkus: [], sheetAsOf: null };
    const [p, d] = await Promise.all([
      admin.from("product_vendor_info").select("sku, retail_price, updated_at").in("sku", list!),
      bases!.length ? admin.from("designs").select("base_sku, color, mrp_override, auto_mrp").in("base_sku", bases!) : Promise.resolve({ data: [], error: null }),
    ]);
    if (p.error) throw new Error(`product_vendor_info read failed: ${p.error.message}`);
    if (d.error) throw new Error(`designs read failed: ${d.error.message}`);
    pvi = (p.data ?? []) as Pvi[];
    designs = (d.data ?? []) as Design[];
  } else {
    [pvi, designs] = await Promise.all([
      fetchAll<Pvi>(admin, "product_vendor_info", "sku, retail_price, updated_at"),
      fetchAll<Design>(admin, "designs", "base_sku, color, mrp_override, auto_mrp"),
    ]);
  }

  const sheetBySku = new Map(pvi.map((r) => [r.sku.toUpperCase(), r.retail_price]));
  const designByKey = new Map(designs.map((d) => [`${d.base_sku}|${d.color}`.toUpperCase(), d]));
  const sheetAsOf = pvi.reduce<string | null>((max, r) => (r.updated_at && (!max || r.updated_at > max) ? r.updated_at : max), null);

  return {
    priceOf(sku: string) {
      const s = sku.trim().toUpperCase();
      const key = designKeyOf(s);
      return effectiveRetailPrice(key ? designByKey.get(key) : null, sheetBySku.get(s)) ?? 0;
    },
    sheetSkus: [...sheetBySku.keys()],
    sheetAsOf,
  };
}
